import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { books, inbox, runs, settings, tasks } from '../db/schema.js';
import { createOrchestrator } from '../orchestrator/index.js';
import { collectRunChanges } from '../book/harvest.js';
import { createRunSnapshot } from '../book/worktree.js';
import { TRAILER } from '../book/trailers.js';
import type { BookHandle, HarvestedRun, PipelineContext, RunContext, TaskRow, TaskSpec } from '../runtime/types.js';
import { promoteV3 } from '../orchestrator/committer.js';
import { enqueueSpec, execEnv, finishTask, markRunLost, type ExecEnv } from '../orchestrator/executor.js';
import { createScheduler } from '../orchestrator/scheduler.js';
import { createOrchTestEnv, type OrchTestEnv } from '../orchestrator/testing.js';
import { bookOpen, bookRetro, bookWrite, finalizeV3, nextTasksV3, prepareV3 } from './handlers.js';
import { readV3Meta, setOwnerMessageMeta } from './state.js';
import { gitBlobSha } from '../book/repo.js';
import { commitOwnerEdit } from '../orchestrator/committer.js';
import { chapterText } from './testing.js';
import { v3Summaries } from '../services/v3-view.js';
import { addV3Book, type V3BookOpts } from './testing-book.js';
import type { OrderSpec, V3BatchLogEntry, V3CommitPlan } from './types.js';

let t: OrchTestEnv;
let env: ExecEnv;
beforeEach(async () => {
  t = await createOrchTestEnv({
    pipeline: {
      handlers: { 'book.open': bookOpen, 'book.write': bookWrite, 'book.retro': bookRetro },
      next: async (ctx) => {
        const book = ctx.book as BookHandle;
        const row = (await ctx.deps.db.select().from(books).where(eq(books.id, book.id)))[0];
        return row ? nextTasksV3(ctx, book, row) : [];
      },
    },
  });
  env = execEnv(t.deps);
});
afterEach(async () => {
  await t.close();
});

async function bookCtx(slug: string, o: V3BookOpts): Promise<{ id: string; dir: string; head: string; ctx: PipelineContext; book: BookHandle }> {
  const b = await addV3Book(t, slug, o);
  const book = await env.pipe.openBook(env.pdeps, b.id);
  return { ...b, book, ctx: { deps: env.pdeps, book } };
}

async function taskFor(ctx: PipelineContext, spec: TaskSpec): Promise<TaskRow> {
  const { id } = await enqueueSpec(env, ctx, spec);
  return (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0] as TaskRow;
}

async function runCtx(snapshotDir: string, head: string, runId = 'run-0001'): Promise<RunContext> {
  const runDir = path.join(t.paths.runs, 'test', runId);
  const inDir = path.join(runDir, 'in');
  await fs.mkdir(inDir, { recursive: true });
  return { runId, attempt: 1, runDir, snapshotDir, outDir: path.join(runDir, 'out'), inDir, baseCommit: head, profileId: 'fake-writer', accountId: null, harness: 'fake', model: 'fake', role: 'writer', degraded: [] };
}

const writeSpec = (bookId: string, from: number, count: number, mode = 'write'): TaskSpec => ({ kind: 'book.write', bookId, target: `batch-c${String(from).padStart(5, '0')}`, lane: 'write', params: { mode, from, count, instance: 'x' } });

describe('prepareV3 skip rules', () => {
  it('book.open with accepted=0 runs (no from param, not stale)', async () => {
    const b = await bookCtx('open0', { chapters: 0, status: 'planning' });
    const task = await taskFor(b.ctx, { kind: 'book.open', bookId: b.id, target: 'book', lane: 'write', params: { mode: 'open-long', count: 5, instance: 'x' } });
    const run = await runCtx(b.dir, b.head);
    const r = await prepareV3(b.ctx, task, run);
    expect(r.kind).toBe('run');
    if (r.kind !== 'run') return;
    expect(Object.keys(r.plan).sort()).toEqual(['effort', 'limits', 'v3']);
    expect(r.plan.effort).toBe('medium');
    expect(r.plan.v3?.orderMd).toMatch(/^任务：开书，并写第 1–5 章/m);
    expect(r.plan.v3?.claudeMd).toBe('@AGENTS.md\n');
    expect(r.plan.v3?.agentsBytes).toBeGreaterThan(0);
    const order = JSON.parse(await fs.readFile(path.join(run.inDir, 'order.json'), 'utf8'));
    expect(order).toMatchObject({ v: 1, mode: 'open-long', kind: 'book.open', from: 1, count: 5, accepted: 0 });
  });

  it('book.open with accepted>0 → skip done', async () => {
    const b = await bookCtx('open5', { chapters: 5 });
    const task = await taskFor(b.ctx, { kind: 'book.open', bookId: b.id, target: 'book', lane: 'write', params: { mode: 'open-long', count: 5, instance: 'x' } });
    const r = await prepareV3(b.ctx, task, await runCtx(b.dir, b.head));
    expect(r).toEqual({ kind: 'skip', result: { status: 'done', summary: { stale: 'opened' } } });
  });

  it('book.write from≠accepted+1 → skip done', async () => {
    const b = await bookCtx('moved', { chapters: 5 });
    const task = await taskFor(b.ctx, writeSpec(b.id, 4, 5));
    const r = await prepareV3(b.ctx, task, await runCtx(b.dir, b.head));
    expect(r).toEqual({ kind: 'skip', result: { status: 'done', summary: { stale: 'moved' } } });
  });

  it('buffer full → skip waiting (not done)', async () => {
    const b = await bookCtx('full', { chapters: 15, planned: 30 });
    const task = await taskFor(b.ctx, writeSpec(b.id, 16, 5));
    const r = await prepareV3(b.ctx, task, await runCtx(b.dir, b.head));
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.result.status).toBe('waiting');
    expect(Date.parse(r.result.retryAfter as string)).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it('completed → skip done', async () => {
    const b = await bookCtx('done', { chapters: 5, status: 'completed' });
    const task = await taskFor(b.ctx, writeSpec(b.id, 6, 5));
    const r = await prepareV3(b.ctx, task, await runCtx(b.dir, b.head));
    expect(r).toEqual({ kind: 'skip', result: { status: 'done', summary: { stale: 'completed' } } });
  });

  it('finale limits use max(count, batch)', async () => {
    const b = await bookCtx('fin', { chapters: 12, planned: 15, batch: 5 });
    const finale = await prepareV3(b.ctx, await taskFor(b.ctx, writeSpec(b.id, 13, 3, 'finale')), await runCtx(b.dir, b.head, 'run-f'));
    expect(finale.kind).toBe('run');
    if (finale.kind !== 'run') return;
    expect(finale.plan.limits?.maxTurns).toBe(30 + 12 * 5);
    expect(finale.plan.effort).toBe('high');
    expect(finale.plan.limits?.wallMs).toBeGreaterThanOrEqual(45 * 60_000);
    // 任务参数里的 mode 只是提示：结局控制按 DB 重算（这本书剩 3 章，照样是结局批）
    const hinted = await prepareV3(b.ctx, await taskFor(b.ctx, { ...writeSpec(b.id, 13, 3, 'write'), params: { mode: 'write', from: 13, count: 3, instance: 'y' } }), await runCtx(b.dir, b.head, 'run-w'));
    expect(hinted.kind === 'run' && hinted.plan.limits?.maxTurns).toBe(30 + 12 * 5);
    const w = await bookCtx('finw', { chapters: 5, planned: 30, batch: 3 });
    const normal = await prepareV3(w.ctx, await taskFor(w.ctx, writeSpec(w.id, 6, 3, 'write')), await runCtx(w.dir, w.head, 'run-w2'));
    expect(normal.kind === 'run' && normal.plan.limits?.maxTurns).toBe(30 + 12 * 3);
    expect(normal.kind === 'run' && normal.plan.effort).toBe('medium');
  });
});

describe('nextTasksV3', () => {
  it('new medium book → book.open with count=batch; short → count=planned', async () => {
    const m = await bookCtx('m', { chapters: 0, status: 'planning' });
    const row = (await t.db.select().from(books).where(eq(books.id, m.id)))[0]!;
    expect(await nextTasksV3(m.ctx, m.book, row)).toEqual([{ kind: 'book.open', bookId: m.id, target: 'book', lane: 'write', params: { mode: 'open-long', count: 5, instance: m.head.slice(0, 10) } }]);
    const s = await bookCtx('s', { chapters: 0, status: 'planning', length: 'short', planned: 4 });
    const srow = (await t.db.select().from(books).where(eq(books.id, s.id)))[0]!;
    expect((await nextTasksV3(s.ctx, s.book, srow))[0]?.params).toMatchObject({ mode: 'open-short', count: 4 });
  });

  it("cancelled task with same head → new instance '.1' with notBefore +10 min", async () => {
    const b = await bookCtx('cx', { chapters: 5 });
    const head10 = b.head.slice(0, 10);
    const finishedAt = new Date(Date.now() - 60_000).toISOString();
    await t.db.insert(tasks).values({ id: 'c1', bookId: b.id, kind: 'book.write', target: 'batch-c00006', lane: 'write', state: 'cancelled', params: { mode: 'write', from: 6, count: 5, instance: head10 }, finishedAt });
    const row = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    const [spec] = await nextTasksV3(b.ctx, b.book, row);
    expect(spec?.params).toEqual({ mode: 'write', from: 6, count: 5, phase: 'closing', forced: false, instance: `${head10}.1` });
    expect(spec?.notBefore).toBe(new Date(Date.parse(finishedAt) + 10 * 60_000).toISOString());
    // 再取消一次 → .2
    await t.db.insert(tasks).values({ id: 'c2', bookId: b.id, kind: 'book.write', target: 'batch-c00006', lane: 'write', state: 'cancelled', params: { instance: `${head10}.1` }, finishedAt });
    expect((await nextTasksV3(b.ctx, b.book, row))[0]?.params?.instance).toBe(`${head10}.2`);
  });

  it('writes meta.v3.sched (buffer days, full) before deciding, only when it changed', async () => {
    // 章节都已入库两天（满 publish_after_hours）：全部可发布
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    const b = await bookCtx('sc', { chapters: 6, published: 2, batch: 2, publish: { max_buffer: 5, resume_buffer: 3 }, acceptedAt: () => old });
    const rowNow = async () => (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    const sched = async () => readV3Meta((await rowNow()).meta).sched;
    // 每天 08:00 发 2 章：存稿 4 章 = 2 天
    await nextTasksV3(b.ctx, b.book, await rowNow());
    const first = await sched();
    expect(first).toMatchObject({ bufferDays: 2, bufferFull: false });
    await new Promise((r) => setTimeout(r, 5));
    await nextTasksV3(b.ctx, b.book, await rowNow());
    expect((await sched())?.at).toBe(first?.at);
    // 差不到 0.1 天：不写
    await t.db.update(books).set({ meta: { v3: { ...readV3Meta((await rowNow()).meta), sched: { bufferDays: 2.05, bufferFull: false, at: 'x' } } } }).where(eq(books.id, b.id));
    await nextTasksV3(b.ctx, b.book, await rowNow());
    expect(await sched()).toEqual({ bufferDays: 2.05, bufferFull: false, at: 'x' });
    // 存稿满了（5 ≥ max_buffer）：写，哪怕书这一步什么都不排
    await t.db.update(books).set({ publishedThrough: 1 }).where(eq(books.id, b.id));
    expect(await nextTasksV3(b.ctx, b.book, await rowNow())).toEqual([]);
    expect(await sched()).toMatchObject({ bufferDays: 2.5, bufferFull: true });
    // 发布了一章：天数变了 0.5
    await t.db.update(books).set({ publishedThrough: 2 }).where(eq(books.id, b.id));
    await nextTasksV3(b.ctx, b.book, await rowNow());
    expect(await sched()).toMatchObject({ bufferDays: 2, bufferFull: false });
    // 第 4 章有主人的改写请求在等：发布扣在第 3 章，能发的存稿只剩 1 章（半天），哪怕已入库未发布还有 4 章
    const meta = readV3Meta((await rowNow()).meta);
    await t.db.update(books).set({ meta: { v3: { ...meta, ownerRequests: [{ id: 'q', kind: 'rewrite', chapter: 4, note: '', at: old, status: 'waiting' }] } } }).where(eq(books.id, b.id));
    await nextTasksV3(b.ctx, b.book, await rowNow());
    expect(await sched()).toMatchObject({ bufferDays: 0.5, bufferFull: false });
  });

  it('failed task id not re-proposed', async () => {
    const b = await bookCtx('fl', { chapters: 5 });
    const row = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    const [spec] = await nextTasksV3(b.ctx, b.book, row);
    const first = await enqueueSpec(env, b.ctx, spec as TaskSpec);
    expect(first.created).toBe(true);
    // 活着的任务在：不再提议
    expect(await nextTasksV3(b.ctx, b.book, row)).toEqual([]);
    await t.db.update(tasks).set({ state: 'failed' }).where(eq(tasks.id, first.id));
    const [again] = await nextTasksV3(b.ctx, b.book, row);
    expect(again).toEqual(spec);
    const second = await enqueueSpec(env, b.ctx, again as TaskSpec);
    expect(second).toEqual({ id: first.id, created: false });
    expect((await t.db.select().from(tasks).where(eq(tasks.id, first.id)))[0]?.state).toBe('failed');
  });
});

describe('finalizeV3', () => {
  it('harvested snapshot → per-chapter promote plan keyed by the pending trailer key', async () => {
    const b = await bookCtx('fz', { chapters: 5 });
    const task = await taskFor(b.ctx, writeSpec(b.id, 6, 2));
    const snap = path.join(t.paths.runs, 'test', 'run-fz', 'book');
    await createRunSnapshot(b.dir, b.head, snap);
    const run = await runCtx(snap, b.head, 'run-fz');
    expect((await prepareV3(b.ctx, task, run)).kind).toBe('run');
    for (const no of [6, 7]) await fs.writeFile(path.join(snap, `manuscript/c0000${no}.md`), chapterText(no, 3300, `新${no}`, no + 50));
    await fs.appendFile(path.join(snap, 'notes/chapters.md'), '第6章：新。\n第7章：新。\n');
    await fs.writeFile(path.join(snap, 'notes/progress.md'), '写到第 7 章。\n');
    const ch = await collectRunChanges({ snapshotDir: snap, baseCommit: b.head, liveBookDir: b.dir, taskId: task.id, runId: run.runId });
    const h = { run, outcome: { status: 'completed' }, stagedOutDir: '', files: [], artifacts: [], nonce: { layers: [], tainted: false, missingTail: [], ok: true }, audit: { ok: true, extraFiles: [], tamperedConfig: [] }, v3: { manifestFile: ch.manifestFile, lost: false, stderrTail: '', trailerKey: `${task.id}@run-fz`, ownerCancelled: false } } as unknown as HarvestedRun;
    const res = await finalizeV3(b.ctx, task, h);
    expect(res.status).toBe('done');
    expect(res.summary?.v3).toMatchObject({ accepted: 2, changed: 4, zeroDiff: false, noChapterStreak: 0 });
    const v3 = res.promote?.v3 as V3CommitPlan;
    expect(v3.key).toBe(`${task.id}@run-fz`);
    expect(v3.parts.map((p) => [p.no, p.tag])).toEqual([
      [6, 'ch/00006'],
      [7, 'ch/00007'],
    ]);
    expect(v3.parts[0]?.content.startsWith('# 第6章 新6\n\n')).toBe(true);
    const out = await promoteV3(t.db, b.book.repo, task, res.promote as never, {});
    expect(out.landed).toEqual([6, 7]);
    expect((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.acceptedThrough).toBe(7);
  });

  it('takeover order (P3): new chapters land → v3.batch args carry takeoverDone and meta.v3.takeover becomes done; notes only → stays pending', async () => {
    const b = await bookCtx('ftk', { chapters: 5, meta: { takeover: { at: '2026-11-10T00:00:00.000Z', from: 6, status: 'pending' } } });
    // 只补了笔记、没有新章：接手还没做完，下一张任务单还是接手任务单
    const t1 = await taskFor(b.ctx, writeSpec(b.id, 6, 2));
    const snap1 = path.join(t.paths.runs, 'test', 'run-ftk1', 'book');
    await createRunSnapshot(b.dir, b.head, snap1);
    const run1 = await runCtx(snap1, b.head, 'run-ftk1');
    expect((await prepareV3(b.ctx, t1, run1)).kind).toBe('run');
    const order1 = JSON.parse(await fs.readFile(path.join(run1.inDir, 'order.json'), 'utf8')) as OrderSpec;
    expect(order1.takeover?.lastChapters).toEqual([3, 4, 5]);
    await fs.writeFile(path.join(snap1, 'notes/cast.md'), '人物：甲。\n');
    const ch1 = await collectRunChanges({ snapshotDir: snap1, baseCommit: b.head, liveBookDir: b.dir, taskId: t1.id, runId: run1.runId });
    const r1 = await finalizeV3(b.ctx, t1, { run: run1, outcome: { status: 'completed' }, v3: { manifestFile: ch1.manifestFile, lost: false, stderrTail: '', trailerKey: `${t1.id}@run-ftk1`, ownerCancelled: false } } as unknown as HarvestedRun);
    expect((r1.promote?.effect?.args as { takeoverDone?: boolean } | undefined)?.takeoverDone).toBeUndefined();
    await promoteV3(t.db, b.book.repo, t1, r1.promote as never, {});
    expect(readV3Meta((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.meta).takeover?.status).toBe('pending');

    // 新章入库：接手做完
    const book2 = await env.pipe.openBook(env.pdeps, b.id);
    const ctx2 = { deps: env.pdeps, book: book2 };
    const t2 = await taskFor(ctx2, { ...writeSpec(b.id, 6, 2), params: { mode: 'write', from: 6, count: 2, instance: 'y' } });
    const snap2 = path.join(t.paths.runs, 'test', 'run-ftk2', 'book');
    await createRunSnapshot(b.dir, book2.headCommit, snap2);
    const run2 = await runCtx(snap2, book2.headCommit, 'run-ftk2');
    expect((await prepareV3(ctx2, t2, run2)).kind).toBe('run');
    for (const no of [6, 7]) await fs.writeFile(path.join(snap2, `manuscript/c0000${no}.md`), chapterText(no, 3300, `新${no}`, no + 70));
    await fs.appendFile(path.join(snap2, 'notes/chapters.md'), '第6章：新。\n第7章：新。\n');
    await fs.writeFile(path.join(snap2, 'notes/progress.md'), '写到第 7 章。\n');
    const ch2 = await collectRunChanges({ snapshotDir: snap2, baseCommit: book2.headCommit, liveBookDir: b.dir, taskId: t2.id, runId: run2.runId });
    const r2 = await finalizeV3(ctx2, t2, { run: run2, outcome: { status: 'completed' }, v3: { manifestFile: ch2.manifestFile, lost: false, stderrTail: '', trailerKey: `${t2.id}@run-ftk2`, ownerCancelled: false } } as unknown as HarvestedRun);
    expect((r2.promote?.effect?.args as { takeoverDone?: boolean }).takeoverDone).toBe(true);
    await promoteV3(t.db, book2.repo, t2, r2.promote as never, {});
    const row = (await t.db.select().from(books).where(eq(books.id, b.id)))[0];
    expect(row?.acceptedThrough).toBe(7);
    expect(readV3Meta(row?.meta).takeover).toEqual({ at: '2026-11-10T00:00:00.000Z', from: 6, status: 'done' });
  });

  it('empty change set → waiting, no promote', async () => {
    const b = await bookCtx('fe', { chapters: 5 });
    const task = await taskFor(b.ctx, writeSpec(b.id, 6, 2));
    const run = await runCtx(b.dir, b.head, 'run-fe');
    await prepareV3(b.ctx, task, run);
    const h = { run, outcome: { status: 'completed' }, v3: { manifestFile: null, lost: false, stderrTail: '', trailerKey: 'k', ownerCancelled: false } } as unknown as HarvestedRun;
    const res = await finalizeV3(b.ctx, task, h);
    expect(res.status).toBe('waiting');
    expect(res.promote).toBeUndefined();
    expect(res.summary?.v3).toMatchObject({ accepted: 0, changed: 0, zeroDiff: true });
  });
});

describe('v3 run lifecycle through the scheduler (fake harness)', () => {
  it('short book: one book.open run writes the whole book, per-chapter commits, pending cleared, snapshot removed', async () => {
    const b = await bookCtx('short', { chapters: 0, status: 'planning', length: 'short', planned: 3, minChars: 400 });
    const sched = createScheduler(t.deps, { maxConcurrent: 2 });
    await sched.runUntilIdle({ maxTicks: 50 });
    const row = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    expect(row.status).toBe('completed');
    expect(row.acceptedThrough).toBe(3);
    expect(readV3Meta(row.meta).pending).toBeNull();
    expect(await b.book.repo.tags('ch/*')).toEqual(['ch/00001', 'ch/00002', 'ch/00003']);
    const log = (await b.book.repo.log({ limit: 3 })).items;
    expect(log.map((c) => c.trailers[TRAILER.part]?.replace(/^.*#/, ''))).toEqual(['3', '2', '1']);
    expect(log[0]?.trailers[TRAILER.chapters]).toBe('1,2,3');
    expect((await b.book.repo.readFile('manuscript/c00003.md'))?.trimEnd().endsWith('（全书完）')).toBe(true);
    const allRuns = await t.db.select().from(runs);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]?.state).toBe('finalized');
    expect(await fs.readdir(path.join(b.dir, '.git', 'worktrees')).catch(() => [])).toEqual([]);
    const flowTasks = (await t.db.select().from(tasks).where(eq(tasks.bookId, b.id))).filter((x) => x.kind.startsWith('book.'));
    expect(flowTasks.map((x) => [x.kind, x.state])).toEqual([['book.open', 'done']]);
  }, 120_000);

  it('medium book: open → finale, two runs, completed', async () => {
    const b = await bookCtx('med', { chapters: 0, status: 'planning', length: 'medium', planned: 4, batch: 2, minChars: 400 });
    const sched = createScheduler(t.deps, { maxConcurrent: 2 });
    await sched.runUntilIdle({ maxTicks: 80 });
    const row = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    expect(row.acceptedThrough).toBe(4);
    expect(row.status).toBe('completed');
    expect(await t.db.select().from(runs)).toHaveLength(2);
    expect(await b.book.repo.tags('ch/*')).toHaveLength(4);
  }, 120_000);
});

describe('v3 no-prose-loss paths (fake harness)', () => {
  async function scenarios(slug: string, list: unknown[]): Promise<void> {
    const dir = path.join(t.paths.tmp, 'fake-v3');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(list));
  }
  const flowTask = async (bookId: string) => (await t.db.select().from(tasks).where(eq(tasks.bookId, bookId))).find((x) => x.kind.startsWith('book.')) as TaskRow;
  const meta = async (bookId: string) => readV3Meta((await t.db.select().from(books).where(eq(books.id, bookId)))[0]?.meta);
  /** 等待中的任务立即可执行（代替快进时钟） */
  const wake = async (id: string) => t.db.update(tasks).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, id));

  it('quota after write: harvest happens before error classification, chapters committed, task done', async () => {
    const b = await bookCtx('quota', { chapters: 0, status: 'planning', length: 'short', planned: 2, minChars: 400 });
    await scenarios('quota', [{ fail: 'quota', failAfterWrite: true }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 30 });
    const row = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    expect(row.acceptedThrough).toBe(2);
    expect((await flowTask(b.id)).state).toBe('done');
    expect((await t.db.select().from(runs))[0]?.errorClass).toBe('quota');
  }, 120_000);

  it('finalize throws once: pending kept (harvested, snapshot gone), next execution commits without a second run', async () => {
    const b = await bookCtx('finf', { chapters: 0, status: 'planning', length: 'short', planned: 2, minChars: 400 });
    await scenarios('finf', [{ v3: { serverFault: 'finalize' } }]);
    const sched = createScheduler(t.deps);
    await sched.runUntilIdle({ maxTicks: 30 });
    const task = await flowTask(b.id);
    expect(task.state).toBe('waiting');
    const m = await meta(b.id);
    expect(m.pending).toMatchObject({ stage: 'harvested', failures: 1 });
    expect(m.pending?.lastError).toContain('serverFault');
    expect(await fs.stat(m.pending?.snapshotDir as string).then(() => true, () => false)).toBe(false);
    expect((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.acceptedThrough).toBe(0);
    await wake(task.id);
    await sched.runUntilIdle({ maxTicks: 30 });
    expect((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.acceptedThrough).toBe(2);
    expect((await meta(b.id)).pending).toBeNull();
    expect(await t.db.select().from(runs)).toHaveLength(1);
    expect(await b.book.repo.tags('ch/*')).toEqual(['ch/00001', 'ch/00002']);
  }, 120_000);

  it('crash after harvest, before commit: lease reaped, next execution consumes the pending without a harness run', async () => {
    const b = await bookCtx('crash', { chapters: 0, status: 'planning', length: 'short', planned: 2, minChars: 400 });
    await scenarios('crash', [{ v3: { serverFault: 'crashAfterHarvest' } }]);
    const sched = createScheduler(t.deps);
    await sched.runUntilIdle({ maxTicks: 30 });
    const task = await flowTask(b.id);
    expect(['leased', 'running']).toContain(task.state);
    expect((await meta(b.id)).pending?.stage).toBe('harvested');
    // lease 过期 → reapExpiredLeases 放回 ready
    await t.db.update(tasks).set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, task.id));
    await sched.runUntilIdle({ maxTicks: 30 });
    expect((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.acceptedThrough).toBe(2);
    expect((await meta(b.id)).pending).toBeNull();
    expect(await t.db.select().from(runs)).toHaveLength(1);
  }, 120_000);

  it('promote fails three times: task blocked, pending.failures 3, no v3_pending inbox item, no new run; retry through the v3/pending action lands the batch', async () => {
    const b = await bookCtx('pf', { chapters: 0, status: 'planning', length: 'short', planned: 2, minChars: 400 });
    await scenarios('pf', [{ v3: { serverFault: 'promote', serverFaultTimes: 3 } }]);
    const sched = createScheduler(t.deps);
    await sched.runUntilIdle({ maxTicks: 30 });
    let task = await flowTask(b.id);
    for (let i = 0; i < 2; i += 1) {
      expect(task.state).toBe('waiting');
      await wake(task.id);
      await sched.runUntilIdle({ maxTicks: 30 });
      task = await flowTask(b.id);
    }
    expect(task.state).toBe('blocked');
    expect((await meta(b.id)).pending?.failures).toBe(3);
    // 收稿失败不进待办（WP-3）：书页和状态句显示，重试 / 放弃走 v3/pending
    expect((await t.db.select().from(inbox)).filter((i) => (i.dedupeKey ?? '').startsWith('v3_pending:'))).toEqual([]);
    // 状态句（WP-4）：等主人处理
    const bookRow = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    expect((await v3Summaries({ db: t.db, paths: t.paths } as never, [bookRow], new Date())).get(b.id)?.status).toMatchObject({ kind: 'needs_owner', sentence: '收稿出错 3 次，等你处理（重试或放弃）' });
    expect(await t.db.select().from(runs)).toHaveLength(1);
    const orch = createOrchestrator(t.deps);
    await orch.v3PendingAction(b.id, 'retry');
    expect((await meta(b.id)).pending?.failures).toBe(0);
    expect((await flowTask(b.id)).state).toBe('ready');
    // 重试已经把任务放回 ready（马上会重放 promote）：这时放弃 → 409，什么都不撤回
    await expect(orch.v3PendingAction(b.id, 'discard')).rejects.toMatchObject({ status: 409, code: 'v3_busy' });
    expect((await meta(b.id)).pending?.runId).toBeDefined();
    await sched.runUntilIdle({ maxTicks: 30 });
    expect((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.acceptedThrough).toBe(2);
    expect((await meta(b.id)).pending).toBeNull();
    expect(await t.db.select().from(runs)).toHaveLength(1);
  }, 120_000);

  it('lost run is harvested: markRunLost keeps the snapshot, next execution harvests it', async () => {
    const b = await bookCtx('lost', { chapters: 0, status: 'planning', length: 'short', planned: 2, minChars: 400 });
    // 先让一次 run 正常写完但在收稿前“丢失”：用 crashAfterHarvest 之前的状态模拟——直接造一个 stage 'run' 的 pending
    const snap = path.join(t.paths.runs, 'test', 'run-lost', 'book');
    await createRunSnapshot(b.dir, b.head, snap);
    await fs.mkdir(path.join(snap, 'manuscript'), { recursive: true });
    for (const no of [1, 2]) await fs.writeFile(path.join(snap, `manuscript/c0000${no}.md`), chapterText(no, 600, `丢${no}`, no + 70) + (no === 2 ? '\n（全书完）\n' : ''));
    await fs.writeFile(path.join(snap, 'notes/progress.md'), '写完了。\n');
    const runDir = path.dirname(snap);
    await fs.mkdir(path.join(runDir, 'in'), { recursive: true });
    await t.db.insert(runs).values({ id: 'run-lost', taskId: 'gone', bookId: b.id, taskKind: 'book.open', attempt: 1, role: 'writer', profileId: 'fake-writer', harness: 'fake', isolation: 'none', state: 'lost', runDir, baseCommit: b.head });
    const { setPending } = await import('./state.js');
    await setPending(t.db, b.id, { taskId: 'gone', runId: 'run-lost', attempt: 1, stage: 'run', runDir, inDir: path.join(runDir, 'in'), snapshotDir: snap, baseCommit: b.head, manifestFile: null, trailerKey: 'gone@run-lost', route: { profile: 'fake-writer', account: null, harness: 'fake', model: 'fake', isolation: 'none', stackHash: 'h' }, failures: 0, createdAt: new Date().toISOString() });
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 30 });
    const row = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    expect(row.acceptedThrough).toBe(2);
    expect(row.status).toBe('completed');
    expect(readV3Meta(row.meta).pending).toBeNull();
    // 没有开新 run；快照收完才删
    expect(await t.db.select().from(runs)).toHaveLength(1);
    expect(await fs.stat(snap).then(() => true, () => false)).toBe(false);
    expect((await b.book.repo.log({ limit: 1 })).items[0]?.trailers[TRAILER.task]).toBe('gone@run-lost');
  }, 120_000);

  it('zero output twice (failed run): book not blocked, account key paused with exactly one inbox item', async () => {
    const b = await bookCtx('zero', { chapters: 0, status: 'planning', length: 'short', planned: 2, minChars: 400 });
    await scenarios('zero', [{ fail: 'harness_crash' }, { fail: 'harness_crash' }]);
    const sched = createScheduler(t.deps);
    await sched.runUntilIdle({ maxTicks: 30 });
    let task = await flowTask(b.id);
    expect(task.state).toBe('waiting');
    expect((await meta(b.id)).emptyStreak).toBe(1);
    expect((await meta(b.id)).pending).toBeNull();
    await wake(task.id);
    await sched.runUntilIdle({ maxTicks: 30 });
    task = await flowTask(b.id);
    expect(task.state).toBe('waiting');
    const zero = (await t.db.select().from(inbox)).filter((i) => (i.dedupeKey ?? '').startsWith('zero_diff:'));
    expect(zero).toHaveLength(1);
    expect((await meta(b.id)).emptyStreak).toBe(2);
    expect(await t.db.select().from(runs)).toHaveLength(2);
  }, 120_000);

  it('zero output twice (clean exit): only the book waits on its ladder, account not paused, no account inbox item', async () => {
    const b = await bookCtx('zeroclean', { chapters: 0, status: 'planning', length: 'short', planned: 2, minChars: 400 });
    await scenarios('zeroclean', [{ v3: { zeroOutput: true } }, { v3: { zeroOutput: true } }]);
    const sched = createScheduler(t.deps);
    await sched.runUntilIdle({ maxTicks: 30 });
    let task = await flowTask(b.id);
    expect(task.state).toBe('waiting');
    expect((await meta(b.id)).emptyStreak).toBe(1);
    expect((await meta(b.id)).pending).toBeNull();
    const first = Date.parse(task.notBefore as string) - Date.now();
    expect(first).toBeGreaterThan(5 * 60_000);
    expect(first).toBeLessThanOrEqual(10 * 60_000);
    await wake(task.id);
    await sched.runUntilIdle({ maxTicks: 30 });
    task = await flowTask(b.id);
    expect(task.state).toBe('waiting');
    expect((await t.db.select().from(inbox)).filter((i) => (i.dedupeKey ?? '').startsWith('zero_diff:'))).toHaveLength(0);
    const streaks = (await t.db.select().from(settings)).filter((s) => s.key.startsWith('flow.v3.zeroDiff:')).map((s) => (s.value as { streak: number }).streak);
    expect(streaks.filter((n) => n > 0)).toEqual([]);
    expect((await meta(b.id)).emptyStreak).toBe(2);
    const second = Date.parse(task.notBefore as string) - Date.now();
    expect(second).toBeGreaterThan(25 * 60_000);
    expect(second).toBeLessThanOrEqual(30 * 60_000);
    expect((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.status).toBe('planning');
    expect(await t.db.select().from(runs)).toHaveLength(2);
  }, 120_000);

  it('owner cancels mid-run: chapters written so far are committed, task stays cancelled', async () => {
    const b = await bookCtx('cancel', { chapters: 0, status: 'planning', length: 'short', planned: 2, minChars: 400 });
    await scenarios('cancel', [{ sleepMs: 30_000 }]);
    const orch = createOrchestrator(t.deps);
    await orch.scheduler.tick();
    const deadline = Date.now() + 60_000;
    let snap = '';
    for (;;) {
      const pend = (await meta(b.id)).pending;
      if (pend) snap = pend.snapshotDir;
      if (snap && (await fs.stat(path.join(snap, 'manuscript', 'c00002.md')).then(() => true, () => false))) break;
      if (Date.now() > deadline) throw new Error('fake harness did not write chapters');
      await new Promise((r) => setTimeout(r, 100));
    }
    const task = await flowTask(b.id);
    await orch.cancelTask(task.id);
    await orch.scheduler.stop({ drain: true });
    expect((await flowTask(b.id)).state).toBe('cancelled');
    const row = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    expect(row.acceptedThrough).toBe(2);
    expect(readV3Meta(row.meta).pending).toBeNull();
    expect(await b.book.repo.tags('ch/*')).toEqual(['ch/00001', 'ch/00002']);
  }, 120_000);

  it('markRunLost on a v3 session keeps the snapshot (the pending points at it)', async () => {
    const b = await bookCtx('mlost', { chapters: 1 });
    const runDir = path.join(t.paths.runs, 'test', 'run-ml');
    const snap = path.join(runDir, 'book');
    await createRunSnapshot(b.dir, b.head, snap);
    await fs.mkdir(path.join(runDir, 'in'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'in', 'session.json'), JSON.stringify({ schema: 'nv.session/1', spec: { bookDir: snap }, runCtx: { baseCommit: b.head }, reservationIds: [], contract: 'v3', trailerKey: 'k' }));
    await t.db.insert(runs).values({ id: 'run-ml', taskId: 'tk', bookId: b.id, taskKind: 'book.write', attempt: 1, role: 'writer', profileId: 'p', harness: 'fake', isolation: 'none', state: 'running', runDir, baseCommit: b.head });
    const row = (await t.db.select().from(runs).where(eq(runs.id, 'run-ml')))[0]!;
    await markRunLost(env, row);
    expect((await t.db.select().from(runs).where(eq(runs.id, 'run-ml')))[0]?.state).toBe('lost');
    expect(await fs.stat(path.join(snap, 'manuscript', 'c00001.md')).then(() => true, () => false)).toBe(true);
  });
});

describe('phase 2: retro, closing, step count, feedback (scheduler + fake)', () => {
  async function scenarios(slug: string, list: unknown[]): Promise<void> {
    const dir = path.join(t.paths.tmp, 'fake-v3');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(list));
  }
  const at = new Date().toISOString();
  /** n 个已入库的批（每批 2 章），第一批是开书 */
  const batches = (n: number, per = 2): V3BatchLogEntry[] => Array.from({ length: n }, (_, i) => ({ runId: `r${i}`, kind: i === 0 ? 'open' : 'write', from: per * i + 1, to: per * i + per, baseCommit: 'x', finalCommit: 'y', at }));
  const rowOf = async (id: string) => (await t.db.select().from(books).where(eq(books.id, id)))[0]!;
  const meta = async (id: string) => readV3Meta((await rowOf(id)).meta);
  const flowTasks = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.bookId, id))).filter((x) => x.kind.startsWith('book.')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const runsOf = async (id: string) => (await t.db.select().from(runs).where(eq(runs.bookId, id))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const orderOf = async (runDir: string) => JSON.parse(await fs.readFile(path.join(runDir, 'in', 'order.json'), 'utf8')) as OrderSpec;
  const manuscriptShas = async (b: { book: BookHandle }, n: number, rev: string) => b.book.repo.blobShas(Array.from({ length: n }, (_, i) => `manuscript/c${String(i + 1).padStart(5, '0')}.md`), rev);
  /** 下一步的任务单（prepareV3 在 HEAD 上渲染） */
  async function nextOrder(slug: string, id: string): Promise<{ md: string; effort: string | undefined }> {
    const book = await env.pipe.openBook(env.pdeps, id);
    const ctx: PipelineContext = { deps: env.pdeps, book };
    // 调度器可能已经把下一步入了队（onTaskDone）：用它；否则按 nextTasksV3 入队
    const queued = (await flowTasks(id)).find((x) => ['pending', 'ready', 'waiting'].includes(x.state)) as TaskRow | undefined;
    const [spec] = queued ? [] : await nextTasksV3(ctx, book, await rowOf(id));
    if (!queued && !spec) throw new Error(`${slug}: no next step`);
    const task = queued ?? (await taskFor(ctx, spec as TaskSpec));
    const r = await prepareV3(ctx, task, await runCtx(book.dir, book.headCommit, `run-next-${slug}-${Date.now()}`));
    if (r.kind !== 'run') throw new Error(`${slug}: next step skipped`);
    return { md: r.plan.v3?.orderMd ?? '', effort: r.plan.effort };
  }

  it('long book: a retro falls due after 4 landed batches and runs after the next write lands; notes only, the next write ORDER lists notes/retro.md', async () => {
    const b = await bookCtx('lr', { chapters: 8, planned: 30, batch: 2, length: 'long', minChars: 400, meta: { batchLog: batches(4) }, files: { 'notes/threads.md': '# 线索\n\n- 旧信：第1章埋。\n' } });
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 2 });
    const ft = await flowTasks(b.id);
    expect(ft.slice(0, 2).map((x) => [x.kind, x.state])).toEqual([
      ['book.write', 'done'],
      ['book.retro', 'done'],
    ]);
    expect(ft.slice(2).every((x) => x.kind === 'book.write' && x.state !== 'done')).toBe(true);
    const rs = await runsOf(b.id);
    expect(rs).toHaveLength(2);
    const retroOrder = await orderOf(rs[1]!.runDir);
    expect(retroOrder).toMatchObject({ mode: 'retro', kind: 'book.retro', retro: { from: 1, to: 10 }, effort: 'medium' });
    const m = await meta(b.id);
    expect(m.batchLog).toHaveLength(5);
    expect(m.retro).toMatchObject({ afterBatches: 5, lastRunId: rs[1]!.id, lastStatus: 'done' });
    const head = await b.book.repo.head();
    expect(await b.book.repo.readFile('notes/retro.md', head)).toMatch(/^1\. /m);
    expect(await b.book.repo.readFile('notes/threads.md', head)).toContain('计划第 13 章前后收');
    // 复盘没改任何正文
    expect(await manuscriptShas(b, 10, head)).toEqual(await manuscriptShas(b, 10, rs[1]!.baseCommit as string));
    expect((await rowOf(b.id)).acceptedThrough).toBe(10);
    // 下一次写作的任务单把 notes/retro.md 列进必读
    const next = await nextOrder('lr', b.id);
    expect(next.md).toContain('notes/threads.md、notes/retro.md；');
    expect(next.md).toMatch(/^任务：新写第 11–12 章/m);
  }, 120_000);

  it('retro failure (fake fail) not retried: next write proposed, retro.afterBatches reset, lastStatus failed', async () => {
    const b = await bookCtx('lrf', { chapters: 10, planned: 30, batch: 2, length: 'long', minChars: 400, meta: { batchLog: batches(5) } });
    await scenarios('lrf', [{ fail: 'harness_crash' }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 2 });
    const ft = await flowTasks(b.id);
    expect(ft.slice(0, 2).map((x) => [x.kind, x.state])).toEqual([
      ['book.retro', 'done'],
      ['book.write', 'done'],
    ]);
    expect((await runsOf(b.id)).filter((r) => r.taskKind === 'book.retro')).toHaveLength(1);
    const m = await meta(b.id);
    expect(m.retro.afterBatches).toBe(5);
    expect(m.retro.lastStatus).toBe('failed');
    expect(m.emptyStreak).toBe(0);
    expect((await rowOf(b.id)).acceptedThrough).toBe(12);
    expect((await t.db.select().from(inbox)).filter((i) => (i.bookId === b.id && /^(failed:|v3_)/.test(i.dedupeKey ?? '')) || (i.dedupeKey ?? '').startsWith('zero_diff:'))).toEqual([]);
    expect((await t.db.select().from(settings)).filter((s) => s.key.startsWith('flow.v3.zeroDiff:') && (s.value as { streak: number }).streak > 0)).toEqual([]);
  }, 120_000);

  it('retro that fails before the run (harness missing / startRun throws / budget not_allowed / routeFailure) → task failed, no inbox, markRetro, next step write', async () => {
    const results = [
      { status: 'retry' as const, errorClass: 'config' as const, message: 'harness fake 未安装' },
      { status: 'retry' as const, errorClass: 'config' as const, message: 'spawn failed' },
      { status: 'retry' as const, errorClass: 'budget' as const, message: '超限', retryAfter: new Date().toISOString(), avoidProfile: 'fake-writer' },
      { status: 'blocked' as const, errorClass: 'config' as const, message: 'no route' },
    ];
    for (const [i, result] of results.entries()) {
      const slug = `pre${i}`;
      const b = await bookCtx(slug, { chapters: 10, planned: 30, batch: 2, length: 'long', meta: { batchLog: batches(5) } });
      const [spec] = await nextTasksV3(b.ctx, b.book, await rowOf(b.id));
      expect(spec).toMatchObject({ kind: 'book.retro', target: 'retro-c00010', params: { mode: 'retro', from: 1, to: 10 } });
      const task = await taskFor(b.ctx, spec as TaskSpec);
      await t.db.update(tasks).set({ state: 'running' }).where(eq(tasks.id, task.id));
      await finishTask(t.deps, { ...task, state: 'running' }, result);
      expect((await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.state, slug).toBe('failed');
      expect((await t.db.select().from(inbox)).filter((x) => x.bookId === b.id && (x.dedupeKey ?? '').startsWith('failed:')), slug).toEqual([]);
      expect((await meta(b.id)).retro, slug).toMatchObject({ afterBatches: 5, lastRunId: task.id, lastStatus: 'failed' });
      const [after] = await nextTasksV3(b.ctx, b.book, await rowOf(b.id));
      expect(after, slug).toMatchObject({ kind: 'book.write', params: { from: 11 } });
    }
  });

  it('safety net: a dead retro row with the same target+instance and no markRetro → nextTasksV3 marks it and proposes the write (blocked → stale)', async () => {
    for (const state of ['failed', 'blocked']) {
      const b = await bookCtx(`net-${state}`, { chapters: 10, planned: 30, batch: 2, length: 'long', meta: { batchLog: batches(5) } });
      await t.db.insert(tasks).values({ id: `dead-${state}`, bookId: b.id, kind: 'book.retro', target: 'retro-c00010', lane: 'write', state, params: { mode: 'retro', from: 1, to: 10, instance: b.head.slice(0, 10) } });
      const [spec] = await nextTasksV3(b.ctx, b.book, await rowOf(b.id));
      expect(spec, state).toMatchObject({ kind: 'book.write', params: { from: 11 } });
      expect((await meta(b.id)).retro, state).toMatchObject({ afterBatches: 5, lastStatus: 'failed' });
      const row = (await t.db.select().from(tasks).where(eq(tasks.id, `dead-${state}`)))[0];
      if (state === 'blocked') expect(row).toMatchObject({ state: 'stale', waitReason: 'retro_skipped' });
      else expect(row?.state).toBe('failed');
    }
  });

  it('retroEditChapter → drafts/c…retro.md, chapter blob unchanged', async () => {
    const b = await bookCtx('lre', { chapters: 10, planned: 30, batch: 2, length: 'long', minChars: 400, meta: { batchLog: batches(5) } });
    await scenarios('lre', [{ v3: { retroEditChapter: 3 } }]);
    const before = await manuscriptShas(b, 10, b.head);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    const head = await b.book.repo.head();
    expect(await manuscriptShas(b, 10, head)).toEqual(before);
    expect(await b.book.repo.readFile('drafts/c00003.retro.md', head)).toContain('# 第3章');
    expect((await rowOf(b.id)).acceptedThrough).toBe(10);
  }, 120_000);

  it('retro not due for a medium book even after many batches', async () => {
    const b = await bookCtx('mnr', { chapters: 10, planned: 30, batch: 2, length: 'medium', meta: { batchLog: batches(5) } });
    const [spec] = await nextTasksV3(b.ctx, b.book, await rowOf(b.id));
    expect(spec).toMatchObject({ kind: 'book.write', params: { from: 11, phase: 'normal', forced: false } });
  });

  it('closing write runs with spec.effort high and ORDER has "## 收尾阶段"; the next one points at the ending list', async () => {
    const b = await bookCtx('cl', { chapters: 5, planned: 15, batch: 5, minChars: 400 });
    const first = await nextOrder('cl', b.id);
    expect(first.effort).toBe('high');
    expect(first.md).toContain('\n## 收尾阶段\n全书计划共 15 章，还剩约 10 章。动笔前先在 outline.md 里加一节"## 结局章节清单"');
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    const rs = await runsOf(b.id);
    expect(rs).toHaveLength(1);
    expect(await orderOf(rs[0]!.runDir)).toMatchObject({ mode: 'write', phase: 'closing', effort: 'high', endingListExists: false });
    expect(await b.book.repo.readFile('outline.md')).toMatch(/^## 结局章节清单$/m);
    const second = await nextOrder('cl', b.id);
    expect(second.md).toMatch(/^任务：结局批，从第 11 章写到全书结束/m);
    expect(second.md).toContain('1. 照 outline.md 的"结局章节清单"写；');
  }, 120_000);

  it('extraSteps 210 → book.yaml v3.batch reduced by 1, meta.v3.batchNote set, runs.outcome.toolSteps recorded; at batch 1 no reduction', async () => {
    const b = await bookCtx('steps', { chapters: 5, planned: 30, batch: 3, minChars: 400 });
    await scenarios('steps', [{ v3: { extraSteps: 210 } }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    const rs = await runsOf(b.id);
    const steps = (rs[0]?.outcome as { toolSteps?: number }).toolSteps as number;
    expect(steps).toBeGreaterThan(210);
    const m = await meta(b.id);
    expect(m.batchNote).toMatchObject({ from: 3, to: 2, steps, runId: rs[0]!.id });
    expect((await rowOf(b.id)).acceptedThrough).toBe(8);
    expect((await b.book.repo.readFile('book.yaml')) as string).toMatch(/\bbatch: 2\b/);
    expect(m.batchLog.at(-1)).toMatchObject({ from: 6, to: 8, toolSteps: steps });

    const one = await bookCtx('steps1', { chapters: 5, planned: 30, batch: 1, minChars: 400 });
    await scenarios('steps1', [{ v3: { extraSteps: 210 } }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    expect((await meta(one.id)).batchNote).toBeNull();
    expect((await one.book.repo.readFile('book.yaml')) as string).toMatch(/\bbatch: 1\b/);
    expect(((await runsOf(one.id))[0]?.outcome as { toolSteps?: number }).toolSteps).toBeGreaterThan(210);
  }, 120_000);

  it('step limit does not reduce the batch for runs whose size is not the batch: short open-short, a finale', async () => {
    const sh = await bookCtx('steps-short', { chapters: 0, status: 'planning', length: 'short', planned: 3, batch: 3, minChars: 400 });
    await scenarios('steps-short', [{ v3: { extraSteps: 210 } }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    expect(((await runsOf(sh.id))[0]?.outcome as { toolSteps?: number }).toolSteps).toBeGreaterThan(210);
    expect((await meta(sh.id)).batchNote).toBeNull();
    expect((await sh.book.repo.readFile('book.yaml')) as string).toMatch(/\bbatch: 3\b/);
    const fin = await bookCtx('steps-fin', { chapters: 12, planned: 14, batch: 3, minChars: 400 });
    await scenarios('steps-fin', [{ v3: { extraSteps: 210 } }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    const rs = await runsOf(fin.id);
    expect((await orderOf(rs[0]!.runDir)).mode).toBe('finale');
    expect((await meta(fin.id)).batchNote).toBeNull();
    expect((await fin.book.repo.readFile('book.yaml')) as string).toMatch(/\bbatch: 3\b/);
  }, 120_000);

  it('owner adopts are not counted as write batches for the retro (3 writes + 1 adopt with a full buffer → no retro; 4 writes + adopt → retro over all of them)', async () => {
    const adopt = (no: number): V3BatchLogEntry => ({ runId: null, kind: 'adopt', from: no, to: no, baseCommit: 'x', finalCommit: 'y', at });
    const three = await bookCtx('radopt3', { chapters: 7, planned: 40, batch: 2, length: 'long', publish: { max_buffer: 5, resume_buffer: 3 }, meta: { batchLog: [...batches(3), adopt(7)] } });
    expect(await nextTasksV3(three.ctx, three.book, await rowOf(three.id))).toEqual([]);
    const four = await bookCtx('radopt4', { chapters: 9, planned: 40, batch: 2, length: 'long', publish: { max_buffer: 5, resume_buffer: 3 }, meta: { batchLog: [...batches(4), adopt(9)] } });
    const [spec] = await nextTasksV3(four.ctx, four.book, await rowOf(four.id));
    expect(spec).toMatchObject({ kind: 'book.retro', params: { from: 1, to: 9 } });
  });

  it('a normal run records toolSteps and no batchNote', async () => {
    const b = await bookCtx('steps0', { chapters: 5, planned: 30, batch: 3, minChars: 400 });
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    const steps = ((await runsOf(b.id))[0]?.outcome as { toolSteps?: number }).toolSteps;
    expect(steps).toBeGreaterThan(3);
    expect(steps).toBeLessThan(50);
    expect((await meta(b.id)).batchNote).toBeNull();
  }, 120_000);

  it('repeatPhrase → meta.v3.feedback, and the next ORDER has the feedback block with the phrase', async () => {
    const b = await bookCtx('rep', { chapters: 5, planned: 30, batch: 3, minChars: 400 });
    await scenarios('rep', [{ v3: { repeatPhrase: '月光洒在青石板上' } }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    const m = await meta(b.id);
    expect(m.feedback?.from).toBe(6);
    expect(m.feedback?.to).toBe(8);
    expect(m.feedback?.phrases[0]).toBe('月光洒在青石板上');
    const next = await nextOrder('rep', b.id);
    expect(next.md).toContain('## 上一批的统计（服务器数的，仅供参考）\n- 上一批（第 6–8 章）里重复较多的说法：「月光洒在青石板上」');
  }, 120_000);
});

describe('WP-2: owner message, owner rewrite requests, rewrite_from (scheduler + fake)', () => {
  async function scenarios(slug: string, list: unknown[]): Promise<void> {
    const dir = path.join(t.paths.tmp, 'fake-v3');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(list));
  }
  const at = new Date().toISOString();
  const rowOf = async (id: string) => (await t.db.select().from(books).where(eq(books.id, id)))[0]!;
  const meta = async (id: string) => readV3Meta((await rowOf(id)).meta);
  const runsOf = async (id: string) => (await t.db.select().from(runs).where(eq(runs.bookId, id))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const orderOf = async (runDir: string) => JSON.parse(await fs.readFile(path.join(runDir, 'in', 'order.json'), 'utf8')) as OrderSpec;
  const req = (id: string, chapter: number, note = '这一章节奏太慢') => ({ id, kind: 'rewrite' as const, chapter, note, at, status: 'waiting' as const });
  /** 主人留言（与 services/v3-book.ts setOwnerMessage 相同的两步：提交文件、记 meta） */
  async function leaveMessage(b: { id: string; book: BookHandle }, text: string): Promise<string> {
    const content = `${text}\n`;
    await commitOwnerEdit(t.db, b.book.repo, b.id, { files: [{ path: 'notes/from-owner.md', content }], message: 'owner: message', baseSha: null });
    const sha = gitBlobSha(content);
    await setOwnerMessageMeta(t.db, b.id, { id: `m-${sha.slice(0, 6)}`, text, sha, setAt: '2026-11-10T08:30:00.000Z', readIn: null, archivedPath: null, status: 'waiting' }, null);
    return sha;
  }
  async function nextOrderMd(id: string): Promise<string> {
    const book = await env.pipe.openBook(env.pdeps, id);
    const ctx: PipelineContext = { deps: env.pdeps, book };
    const [spec] = await nextTasksV3(ctx, book, await rowOf(id));
    if (!spec) throw new Error('no next step');
    const r = await prepareV3(ctx, await taskFor(ctx, spec), await runCtx(book.dir, book.headCommit, `run-peek-${Date.now()}`));
    if (r.kind !== 'run') throw new Error('skipped');
    return r.plan.v3?.orderMd ?? '';
  }

  it('owner message consumed by the next write: archived under notes/archive/from-owner/, notes/from-owner.md emptied, receipt readIn {from,to}', async () => {
    const b = await bookCtx('om', { chapters: 5, planned: 30, batch: 3, minChars: 400 });
    const sha = await leaveMessage(b, '多写对话，少写景。');
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    const rs = await runsOf(b.id);
    expect((await orderOf(rs[0]!.runDir)).ownerMessageSha).toBe(sha);
    const head = await b.book.repo.head();
    expect(await b.book.repo.readFile('notes/from-owner.md', head)).toBe('');
    expect(await b.book.repo.readFile('notes/archive/from-owner/20261110-0830.md', head)).toBe('多写对话，少写景。\n');
    const m = await meta(b.id);
    expect(m.ownerMessage).toBeNull();
    expect(m.ownerMessages[0]).toMatchObject({ status: 'read', archivedPath: 'notes/archive/from-owner/20261110-0830.md', readIn: { kind: 'write', from: 6, to: 8, runId: rs[0]!.id } });
    // 下一张任务单不再提留言
    expect(await nextOrderMd(b.id)).not.toContain('from-owner');
  }, 120_000);

  it('a message waiting while a retro runs is not consumed by the retro; the next write reads it', async () => {
    const batchLog = Array.from({ length: 5 }, (_, i) => ({ runId: `r${i}`, kind: (i === 0 ? 'open' : 'write') as 'open' | 'write', from: 2 * i + 1, to: 2 * i + 2, baseCommit: 'x', finalCommit: 'y', at }));
    const b = await bookCtx('omr', { chapters: 10, planned: 30, batch: 2, length: 'long', minChars: 400, meta: { batchLog } });
    await leaveMessage(b, '下一批让师姐出场。');
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 2 });
    const rs = await runsOf(b.id);
    expect(rs.map((r) => r.taskKind)).toEqual(['book.retro', 'book.write']);
    expect((await orderOf(rs[0]!.runDir)).ownerMessageSha).toBeNull();
    expect(await fs.readFile(path.join(rs[0]!.runDir, 'in', 'order.json'), 'utf8')).not.toContain('from-owner');
    const m = await meta(b.id);
    expect(m.ownerMessages[0]).toMatchObject({ status: 'read', readIn: { kind: 'write', from: 11, to: 12, runId: rs[1]!.id } });
  }, 120_000);

  it('a zero-diff run does not consume the message', async () => {
    const b = await bookCtx('omz', { chapters: 5, planned: 30, batch: 3, minChars: 400 });
    await leaveMessage(b, '慢一点。');
    await scenarios('omz', [{ v3: { zeroOutput: true } }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    expect(await runsOf(b.id)).toHaveLength(1);
    expect(await b.book.repo.readFile('notes/from-owner.md')).toBe('慢一点。\n');
    expect((await meta(b.id)).ownerMessage).toMatchObject({ text: '慢一点。', status: 'waiting' });
  }, 120_000);

  it('a timed-out run that only touched notes neither consumes the message nor uses up the rewrite request; the next order still carries both', async () => {
    const b = await bookCtx('omt', { chapters: 5, meta: { ownerRequests: [req('q1', 3)] } });
    await leaveMessage(b, '从第 6 章起换成女主视角。');
    const base = await b.book.repo.head();
    const task = await taskFor(b.ctx, writeSpec(b.id, 6, 2));
    const snap = path.join(t.paths.runs, 'test', 'run-omt', 'book');
    await createRunSnapshot(b.dir, base, snap);
    const run = await runCtx(snap, base, 'run-omt');
    const book = await env.pipe.openBook(env.pdeps, b.id);
    const ctx: PipelineContext = { deps: env.pdeps, book };
    expect((await prepareV3(ctx, task, run)).kind).toBe('run');
    await fs.writeFile(path.join(snap, 'notes/progress.md'), '想了想，先换视角。\n');
    const ch = await collectRunChanges({ snapshotDir: snap, baseCommit: base, liveBookDir: b.dir, taskId: task.id, runId: run.runId });
    const h = { run, outcome: { status: 'timeout', errorClass: 'timeout_wall' }, v3: { manifestFile: ch.manifestFile, lost: false, stderrTail: '', trailerKey: `${task.id}@run-omt`, ownerCancelled: false } } as unknown as HarvestedRun;
    const res = await finalizeV3(ctx, task, h);
    expect(res.status).toBe('waiting');
    expect(res.promote?.v3?.serverTail).toBeUndefined();
    await promoteV3(t.db, b.book.repo, task, res.promote as never, {});
    await t.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, task.id));
    expect(await b.book.repo.readFile('notes/from-owner.md')).toBe('从第 6 章起换成女主视角。\n');
    const m = await meta(b.id);
    expect(m.ownerMessage).toMatchObject({ status: 'waiting', readIn: null });
    expect(m.ownerRequests.map((r) => [r.id, r.status])).toEqual([['q1', 'waiting']]);
    const next = await nextOrderMd(b.id);
    expect(next).toContain('主人给你留了话：notes/from-owner.md');
    expect(next).toContain('主人要求改写第 3 章');
  });

  it('owner replaces the message mid-run → the new message is kept, not archived, still waiting', async () => {
    const b = await bookCtx('omx', { chapters: 5 });
    await leaveMessage(b, '旧的话。');
    const base = await b.book.repo.head();
    const task = await taskFor(b.ctx, writeSpec(b.id, 6, 2));
    const snap = path.join(t.paths.runs, 'test', 'run-omx', 'book');
    await createRunSnapshot(b.dir, base, snap);
    const run = await runCtx(snap, base, 'run-omx');
    const book = await env.pipe.openBook(env.pdeps, b.id);
    const ctx: PipelineContext = { deps: env.pdeps, book };
    expect((await prepareV3(ctx, task, run)).kind).toBe('run');
    for (const no of [6, 7]) await fs.writeFile(path.join(snap, `manuscript/c0000${no}.md`), chapterText(no, 3300, `新${no}`, no + 70));
    await fs.appendFile(path.join(snap, 'notes/chapters.md'), '第6章：新。\n第7章：新。\n');
    await fs.writeFile(path.join(snap, 'notes/progress.md'), '写到第 7 章。\n');
    // 运行期间主人换了留言
    const newSha = await leaveMessage(b, '新的话。');
    const ch = await collectRunChanges({ snapshotDir: snap, baseCommit: base, liveBookDir: b.dir, taskId: task.id, runId: run.runId });
    const h = { run, outcome: { status: 'completed' }, v3: { manifestFile: ch.manifestFile, lost: false, stderrTail: '', trailerKey: `${task.id}@run-omx`, ownerCancelled: false } } as unknown as HarvestedRun;
    const res = await finalizeV3(ctx, task, h);
    expect(res.promote?.v3?.serverTail?.map((s) => s.path)).toEqual(['notes/from-owner.md', 'notes/archive/from-owner/20261110-0830.md']);
    const out = await promoteV3(t.db, b.book.repo, task, res.promote as never, {});
    expect(out.landed).toEqual([6, 7]);
    expect(await b.book.repo.readFile('notes/from-owner.md')).toBe('新的话。\n');
    expect(await b.book.repo.exists('notes/archive/from-owner/20261110-0830.md')).toBe(false);
    expect((await meta(b.id)).ownerMessage).toMatchObject({ sha: newSha, text: '新的话。', status: 'waiting' });
  });

  it("owner rewrite request (fake rewriteAllowed 'append') → request done, chapter rewritten, old text in drafts/replaced/", async () => {
    const b = await bookCtx('orq', { chapters: 5, planned: 30, batch: 3, minChars: 400, meta: { ownerRequests: [req('q1', 3)] } });
    await scenarios('orq', [{ v3: { rewriteAllowed: 'append' } }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    const rs = await runsOf(b.id);
    const order = await orderOf(rs[0]!.runDir);
    expect(order.ownerRequests).toEqual([{ id: 'q1', chapter: 3, note: '这一章节奏太慢' }]);
    expect(order.hintsShown[0]).toMatchObject({ kind: 'owner_rewrite', chapter: 3, rewrite: 3 });
    expect(order.allowRewrite).toContain(3);
    const m = await meta(b.id);
    expect(m.ownerRequests).toMatchObject([{ id: 'q1', status: 'done', runId: rs[0]!.id }]);
    const head = await b.book.repo.head();
    expect((await b.book.repo.readFile('manuscript/c00003.md', head))?.length).toBeGreaterThan(chapterText(3).length);
    const replaced = (await b.book.repo.list('drafts/replaced', { rev: head, recursive: true })).filter((p) => p.endsWith('/c00003.md'));
    expect(replaced).toHaveLength(1);
    expect(await b.book.repo.readFile(replaced[0]!, head)).toBe(chapterText(3));
    expect((await rowOf(b.id)).acceptedThrough).toBe(8);
  }, 120_000);

  it("rewriteAllowed 'shorten' (60 %) → accepted; 'shorten-hard' (20 %) → old text kept, request not_done", async () => {
    for (const [mode, status] of [
      ['shorten', 'done'],
      ['shorten-hard', 'not_done'],
    ] as const) {
      const slug = `ors-${mode}`;
      const b = await bookCtx(slug, { chapters: 5, planned: 30, batch: 1, meta: { ownerRequests: [req('q1', 4)] } });
      await scenarios(slug, [{ v3: { rewriteAllowed: mode } }]);
      await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
      const m = await meta(b.id);
      expect(m.ownerRequests[0]?.status, mode).toBe(status);
      const now = (await b.book.repo.readFile('manuscript/c00004.md')) as string;
      if (status === 'done') expect(now.length, mode).toBeLessThan(chapterText(4).length);
      else {
        expect(now, mode).toBe(chapterText(4));
        expect(await b.book.repo.exists('drafts/c00004.rewrite.md'), mode).toBe(true);
      }
    }
  }, 180_000);

  it('a request the author ignored → not_done, not asked again', async () => {
    const b = await bookCtx('ori', { chapters: 5, planned: 30, batch: 3, minChars: 400, meta: { ownerRequests: [req('q1', 2)] } });
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    expect((await meta(b.id)).ownerRequests).toMatchObject([{ id: 'q1', status: 'not_done' }]);
    const next = await nextOrderMd(b.id);
    expect(next).not.toContain('主人要求');
    expect(next).toContain('不改写旧章');
  }, 120_000);

  it('buffer full and the publisher set max_buffer + a waiting request → the bypass batch is claimed and runs', async () => {
    const b = await bookCtx('orf', { chapters: 15, planned: 30, batch: 3, minChars: 400, meta: { ownerRequests: [req('q1', 12)] } });
    await t.db.update(books).set({ pausedReason: 'max_buffer' }).where(eq(books.id, b.id));
    await scenarios('orf', [{ v3: { rewriteAllowed: 'append' } }]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    expect((await rowOf(b.id)).acceptedThrough).toBe(18);
    expect((await meta(b.id)).ownerRequests[0]?.status).toBe('done');
    // 请求处理完：存稿满，不再写
    const book = await env.pipe.openBook(env.pdeps, b.id);
    expect(await nextTasksV3({ deps: env.pdeps, book }, book, await rowOf(b.id))).toEqual([]);
  }, 120_000);

  it('chapterAction rewrite_from N → rewind to N−1 with the note as a hint; the next write starts at N', async () => {
    const b = await bookCtx('orw', { chapters: 5, planned: 30, batch: 3, minChars: 400 });
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 1 });
    expect((await rowOf(b.id)).acceptedThrough).toBe(8);
    const orch = createOrchestrator(t.deps);
    await orch.chapterAction(b.id, 7, { action: 'rewrite_from', note: '第 7 章起换个方向' });
    const row = await rowOf(b.id);
    expect(row.acceptedThrough).toBe(6);
    const m = readV3Meta(row.meta);
    expect(m.hints.map((h) => h.kind)).toEqual(['rewound', 'rewound']);
    expect(m.hints[0]?.text).toContain('笔记退回到了第 6 章之前的版本：先读第 6 章，');
    expect(m.hints[1]?.text).toBe('主人的意见：第 7 章起换个方向');
    const md = await nextOrderMd(b.id);
    expect(md).toMatch(/^任务：新写第 7–9 章/m);
    expect(md).toContain('主人的意见：第 7 章起换个方向');
    await expect(orch.chapterAction(b.id, 6, { action: 'rewrite' })).rejects.toMatchObject({ status: 400 });
  }, 120_000);
});
