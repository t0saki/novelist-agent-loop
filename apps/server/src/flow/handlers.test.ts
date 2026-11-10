import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { books, inbox, runs, settings, tasks } from '../db/schema.js';
import { createOrchestrator } from '../orchestrator/index.js';
import { collectRunChanges } from '../book/harvest.js';
import { createRunSnapshot } from '../book/worktree.js';
import { TRAILER } from '../book/trailers.js';
import type { BookHandle, HarvestedRun, PipelineContext, RunContext, TaskRow, TaskSpec } from '../pipeline/types.js';
import { promoteV3 } from '../orchestrator/committer.js';
import { enqueueSpec, execEnv, markRunLost, type ExecEnv } from '../orchestrator/executor.js';
import { createScheduler } from '../orchestrator/scheduler.js';
import { createOrchTestEnv, type OrchTestEnv } from '../orchestrator/testing.js';
import { bookOpen, bookWrite, finalizeV3, nextTasksV3, prepareV3 } from './handlers.js';
import { readV3Meta } from './state.js';
import { chapterText } from './testing.js';
import { addV3Book, type V3BookOpts } from './testing-book.js';
import type { V3CommitPlan } from './types.js';

let t: OrchTestEnv;
let env: ExecEnv;
beforeEach(async () => {
  t = await createOrchTestEnv({
    pipeline: {
      handlers: { 'book.open': bookOpen, 'book.write': bookWrite },
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
    expect(r.plan.contract).toBe('v3');
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
    const normal = await prepareV3(b.ctx, await taskFor(b.ctx, { ...writeSpec(b.id, 13, 3, 'write'), params: { mode: 'write', from: 13, count: 3, instance: 'y' } }), await runCtx(b.dir, b.head, 'run-w'));
    expect(normal.kind === 'run' && normal.plan.limits?.maxTurns).toBe(30 + 12 * 3);
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
    expect(spec?.params).toEqual({ mode: 'write', from: 6, count: 5, instance: `${head10}.1` });
    expect(spec?.notBefore).toBe(new Date(Date.parse(finishedAt) + 10 * 60_000).toISOString());
    // 再取消一次 → .2
    await t.db.insert(tasks).values({ id: 'c2', bookId: b.id, kind: 'book.write', target: 'batch-c00006', lane: 'write', state: 'cancelled', params: { instance: `${head10}.1` }, finishedAt });
    expect((await nextTasksV3(b.ctx, b.book, row))[0]?.params?.instance).toBe(`${head10}.2`);
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

  it('promote fails three times: task blocked, v3_pending inbox with retry/discard, no new run; retry lands the batch', async () => {
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
    const items = await t.db.select().from(inbox);
    const item = items.find((i) => i.dedupeKey === `v3_pending:${b.id}`)!;
    expect((item.actions as { id: string }[]).map((a) => a.id)).toEqual(['retry', 'discard']);
    expect(await t.db.select().from(runs)).toHaveLength(1);
    const orch = createOrchestrator(t.deps);
    await orch.actInbox(item.id, 'retry');
    expect((await meta(b.id)).pending?.failures).toBe(0);
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
