/** v3 回退（p2-plan §2.6、§3.2、§6 rewind-v3.test）。批次用 promoteV3 落地，所以 batchLog、Novelist-Part trailer 和 ch/ 标签都是真的。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chapterId, countCjk, tags } from '@novelist/shared';
import { git } from '../book/git.js';
import type { BookRepo } from '../book/repo.js';
import { books, chapters, inbox, tasks } from '../db/schema.js';
import { bookOpen, bookRetro, bookWrite, nextTasksV3, prepareV3 } from '../flow/handlers.js';
import { readV3Meta } from '../flow/state.js';
import { chapterText } from '../flow/testing.js';
import { addV3Book } from '../flow/testing-book.js';
import type { V3BatchEffectArgs, V3CommitPart } from '../flow/types.js';
import { publish } from '../pipeline/handlers/system.js';
import type { BookHandle, PipelineContext, PromotePlan, TaskRow } from '../pipeline/types.js';
import { promoteV3 } from './committer.js';
import { execEnv, type ExecEnv } from './executor.js';
import { enqueue } from './queue.js';
import { applyRewindDb, backfillBatchLog, batchBaseFor, recoverRewinds, rewindHooks, rewindPoints, rewindV3 } from './rewind-v3.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';

let t: OrchTestEnv;
let env: ExecEnv;
beforeEach(async () => {
  t = await createOrchTestEnv({ pipeline: { handlers: { 'book.open': bookOpen, 'book.write': bookWrite, 'book.retro': bookRetro, publish } } });
  env = execEnv(t.deps);
});
afterEach(async () => {
  rewindHooks.afterCommit = null;
  await t.close();
});

const NOW = '2026-11-10T00:00:00.000Z';
const meta = { harness: 'fake', model: 'fake-1', isolation: 'none', instructionsHash: 'h1' };
const rowOf = async (id: string) => (await t.db.select().from(books).where(eq(books.id, id)))[0]!;
const notesLines = (to: number) => `${Array.from({ length: to }, (_, i) => `第${i + 1}章：发生了事。`).join('\n')}\n`;

interface Book {
  id: string;
  repo: BookRepo;
  task: TaskRow;
  /** HEAD after each landed batch, index 0 = fixture */
  heads: string[];
}

function part(no: number): V3CommitPart {
  return { no, path: `manuscript/${chapterId(no)}.md`, content: chapterText(no, 1200, `新章${no}`, no + 300), message: `chapter: ${chapterId(no)}「新章${no}」`, tag: tags.chapter(no), rewrite: false, extra: [] };
}

/** 一批 from..to，笔记跟着更新（progress / chapters / cast） */
async function land(b: Book, from: number, to: number, kind: 'book.open' | 'book.write' = 'book.write'): Promise<void> {
  const base = await b.repo.head();
  const parts = Array.from({ length: to - from + 1 }, (_, i) => part(from + i));
  const key = `${b.task.id}@run-${from}`;
  const args: V3BatchEffectArgs = {
    bookId: b.id,
    runId: `run-${from}`,
    nowIso: NOW,
    chapters: parts.map((p) => ({ no: p.no, cid: chapterId(p.no), title: `新章${p.no}`, cjk: countCjk(p.content), rewrite: false, path: p.path })),
    batchFrom: from,
    completed: false,
    hints: [],
    noChapterStreak: 0,
    finaleNoMarker: 0,
    hintedShort: [],
    orderKind: kind,
    baseCommit: base,
    runawayBatches: 0,
    shortEndUsed: false,
    plannedFloor: null,
  };
  const tail = [
    { path: 'notes/progress.md', content: `写到第 ${to} 章。\n` },
    { path: 'notes/chapters.md', content: notesLines(to) },
    { path: 'notes/cast.md', content: `# 人物（第 ${to} 章）\n` },
    ...(from === 1 ? [{ path: 'notes/threads.md', content: '# 线索\n- 旧信：第1章埋。\n' }] : []),
  ];
  const tailMessage = `notes: ${kind} ${from}–${to} run run-${from}`;
  const plan: PromotePlan & { v3: NonNullable<PromotePlan['v3']> } = {
    bookId: b.id,
    taskId: b.task.id,
    runId: `run-${from}`,
    baseCommit: base,
    files: [],
    resolveTmpIds: false,
    message: tailMessage,
    trailers: {},
    tags: [],
    effect: { name: 'v3.batch', args: args as unknown as Record<string, unknown> },
    v3: { key, parts, tail, bookYaml: [], baseCommit: base, tailMessage },
  };
  await promoteV3(t.db, b.repo, b.task, plan, meta);
  b.heads.push(await b.repo.head());
}

/** 三批：1–3（开书）、4–6、7–9 */
async function threeBatches(slug: string, o: Parameters<typeof addV3Book>[2] = {}): Promise<Book> {
  const fx = await addV3Book(t, slug, { chapters: 0, status: 'active', planned: 30, batch: 3, ...o });
  await enqueue(t.db, { id: `tk-${slug}`, baseCommit: fx.head, manifest: { hard: {}, soft: {}, rebaseValidators: [], configHash: '' }, spec: { kind: 'book.write', bookId: fx.id, target: 'x', lane: 'write' } });
  const task = (await t.db.select().from(tasks).where(eq(tasks.id, `tk-${slug}`)))[0] as TaskRow;
  await t.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, task.id));
  const b: Book = { id: fx.id, repo: fx.repo, task, heads: [fx.head] };
  await land(b, 1, 3, 'book.open');
  await land(b, 4, 6);
  await land(b, 7, 9);
  return b;
}

const code = async (p: Promise<unknown>): Promise<[number, string]> =>
  p.then(
    () => [200, 'ok'],
    (e: { status?: number; code?: string }) => [e.status ?? 0, e.code ?? ''],
  );

async function rewoundDir(repo: BookRepo): Promise<string> {
  const d = (await repo.list('drafts')).find((x) => x.startsWith('drafts/rewound-'));
  return (d ?? '').replace(/\/$/, '');
}

describe('rewindV3', () => {
  it('rewind to a batch boundary: chapters > to moved to drafts/rewound-<ts>/, notes equal the base of the next batch, trash tags for old HEAD and moved ch/ tags', async () => {
    const b = await threeBatches('rb');
    const oldHead = await b.repo.head();
    const r = await rewindV3(env, b.id, 6, { reason: 'rewind' });
    expect(r).toMatchObject({ to: 6, notesFrom: null });
    const dir = await rewoundDir(b.repo);
    expect(r.movedDir).toBe(dir);
    const ts = dir.slice('drafts/rewound-'.length);
    for (const k of [7, 8, 9]) {
      expect(await b.repo.exists(`manuscript/${chapterId(k)}.md`)).toBe(false);
      expect(await b.repo.readFile(`${dir}/${chapterId(k)}.md`)).toBe(part(k).content);
    }
    for (const k of [1, 6]) expect(await b.repo.exists(`manuscript/${chapterId(k)}.md`)).toBe(true);
    // 笔记 = 第 7–9 章那一批开始前的版本；被替换的版本在 notes/archive/rewound-<ts>/
    for (const p of ['notes/progress.md', 'notes/chapters.md', 'notes/cast.md']) expect(await b.repo.readFile(p), p).toBe(await b.repo.readFile(p, b.heads[2]));
    expect(await b.repo.readFile(`notes/archive/rewound-${ts}/notes/progress.md`)).toBe('写到第 9 章。\n');
    // 标签：旧 HEAD 和挪走的 ch/ 都在 trash/ 下（两种名字共存），ch/00007.. 不在了
    expect((await git(b.repo.dir, ['rev-parse', `trash/rewind-${ts}/head^{commit}`])).trim()).toBe(oldHead);
    expect(await b.repo.tags(`trash/rewind-${ts}/*`)).toEqual([`trash/rewind-${ts}/ch/00007`, `trash/rewind-${ts}/ch/00008`, `trash/rewind-${ts}/ch/00009`, `trash/rewind-${ts}/head`]);
    expect(await b.repo.tags('ch/*')).toEqual(['ch/00001', 'ch/00002', 'ch/00003', 'ch/00004', 'ch/00005', 'ch/00006']);
    const last = (await b.repo.log({ limit: 1 })).items[0]!;
    expect(last.subject).toBe('owner: rewind to c00006');
    expect(last.trailers).toMatchObject({ 'Novelist-Owner-Edit': 'true', 'Novelist-Rewind': '6', 'Novelist-Rewind-Ts': ts });
    expect(await b.repo.isClean()).toBe(true);
    const m = readV3Meta((await rowOf(b.id)).meta);
    expect(m.hints).toHaveLength(1);
    expect(m.hints[0]).toMatchObject({ kind: 'rewound', text: `主人把书退回到了第 6 章。第 7 章起的旧稿移到了 ${dir}/，只作参考，不要照抄；按 outline.md 从第 7 章重新写。笔记已是第 6 章写完时的版本。` });
  });

  it('mid-batch rewind: notes at the batch base, the rewound hint asks to re-record a–to; owner note appended as a second hint', async () => {
    const b = await threeBatches('rm');
    const r = await rewindV3(env, b.id, 5, { reason: 'rewrite_from', note: '主角别那么快原谅他' });
    expect(r.notesFrom).toBe(4);
    for (const p of ['notes/progress.md', 'notes/chapters.md']) expect(await b.repo.readFile(p), p).toBe(await b.repo.readFile(p, b.heads[1]));
    expect(await b.repo.exists('manuscript/c00006.md')).toBe(false);
    expect(await b.repo.exists('manuscript/c00005.md')).toBe(true);
    const m = readV3Meta((await rowOf(b.id)).meta);
    expect(m.hints.map((h) => h.text)).toEqual([
      `主人把书退回到了第 5 章。第 6 章起的旧稿移到了 ${r.movedDir}/，只作参考，不要照抄。笔记退回到了第 4 章之前的版本：先读第 4–5 章，把这几章补记进 notes/chapters.md（每章一行），再顺手更新 notes/cast.md、notes/threads.md、notes/progress.md，然后从第 6 章接着写。`,
      '主人的意见：主角别那么快原谅他',
    ]);
    expect(m.batchLog.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['open', 1, 3],
      ['write', 4, 5],
    ]);
    expect(m.lastBatchFrom).toBe(4);
  });

  it('rewind to 0 keeps bible/outline, notes back to the fixture; next step is book.open with the resume text', async () => {
    const b = await threeBatches('r0');
    const bible = await b.repo.readFile('bible.md');
    const outline = await b.repo.readFile('outline.md');
    await rewindV3(env, b.id, 0, { reason: 'rewind' });
    expect(await b.repo.readFile('bible.md')).toBe(bible);
    expect(await b.repo.readFile('outline.md')).toBe(outline);
    expect(await b.repo.readFile('notes/progress.md')).toBe('写到第 0 章。\n');
    expect(await b.repo.exists('notes/threads.md')).toBe(false);
    expect(await b.repo.tags('ch/*')).toEqual([]);
    const row = await rowOf(b.id);
    expect(row).toMatchObject({ acceptedThrough: 0, cursor: 1, totalCjk: 0 });
    const m = readV3Meta(row.meta);
    expect(m.batchLog).toEqual([]);
    expect(m.hints[0]?.text).toMatch(/^主人把书退回到了开头。旧稿移到了 drafts\/rewound-[^/]+\/，只作参考，不要照抄；设定和大纲保留，从第 1 章重新写。$/);
    const book = await env.pipe.openBook(env.pdeps, b.id);
    const ctx: PipelineContext = { deps: env.pdeps, book };
    const [spec] = await nextTasksV3(ctx, book as BookHandle, row);
    expect(spec).toMatchObject({ kind: 'book.open', target: 'book' });
    await enqueue(t.db, { id: 'open-after', baseCommit: book.headCommit, manifest: { hard: {}, soft: {}, rebaseValidators: [], configHash: '' }, spec: spec! });
    const task = (await t.db.select().from(tasks).where(eq(tasks.id, 'open-after')))[0] as TaskRow;
    const runDir = path.join(t.paths.runs, 'test', 'r0');
    await fs.mkdir(path.join(runDir, 'in'), { recursive: true });
    const prep = await prepareV3(ctx, task, { runId: 'r0', attempt: 1, runDir, snapshotDir: book.dir, outDir: path.join(runDir, 'out'), inDir: path.join(runDir, 'in'), baseCommit: book.headCommit, profileId: 'fake-writer', accountId: null, harness: 'fake', model: 'fake', role: 'writer', degraded: [] });
    expect(prep.kind).toBe('run');
    if (prep.kind === 'run') {
      expect(prep.plan.v3?.orderMd).toContain('设定已定（bible.md、outline.md 已在目录里），不要重新构思，直接从第 1 章写起');
      expect(prep.plan.v3?.orderMd).toContain('主人把书退回到了开头。');
    }
  });

  it('rewind below published → 400; to ≥ accepted → 400; nothing moved', async () => {
    const b = await threeBatches('rp');
    await t.db.update(books).set({ publishedThrough: 4 }).where(eq(books.id, b.id));
    const head = await b.repo.head();
    expect(await code(rewindV3(env, b.id, 3, { reason: 'rewind' }))).toEqual([400, 'bad_request']);
    expect(await code(rewindV3(env, b.id, 9, { reason: 'rewind' }))).toEqual([400, 'bad_request']);
    expect(await b.repo.head()).toBe(head);
    expect(readV3Meta((await rowOf(b.id)).meta).rewinding).toBeNull();
    expect(await b.repo.tags('trash/*')).toEqual([]);
  });

  it('publish advanced just before the claim → 400, nothing moved', async () => {
    const b = await threeBatches('rpa');
    const head = await b.repo.head();
    // 发布在回退认领之前提交（publishV3 持同一把行锁）
    const book = await env.pipe.openBook(env.pdeps, b.id);
    await publish.execute!({ deps: env.pdeps, book }, { id: 'p', target: 'through-7', params: { manual: true } } as never);
    expect(await code(rewindV3(env, b.id, 6, { reason: 'rewind' }))).toEqual([400, 'bad_request']);
    expect(await b.repo.head()).toBe(head);
    expect((await rowOf(b.id)).acceptedThrough).toBe(9);
  });

  it('rewind while pending / an active v3 task / another rewind → 409 v3_busy', async () => {
    const b = await threeBatches('rbusy');
    const m = readV3Meta((await rowOf(b.id)).meta);
    const setMeta = (v3: object) => t.db.update(books).set({ meta: { v3: { ...m, ...v3 } } }).where(eq(books.id, b.id));
    await setMeta({ pending: { taskId: 'x', runId: 'y' } });
    expect(await code(rewindV3(env, b.id, 6, { reason: 'rewind' }))).toEqual([409, 'v3_busy']);
    await setMeta({ rewinding: { to: 3, ts: '20261110T000000', at: NOW } });
    expect(await code(rewindV3(env, b.id, 6, { reason: 'rewind' }))).toEqual([409, 'v3_busy']);
    await setMeta({});
    await t.db.update(tasks).set({ state: 'running' }).where(eq(tasks.id, b.task.id));
    expect(await code(rewindV3(env, b.id, 6, { reason: 'rewind' }))).toEqual([409, 'v3_busy']);
    expect((await rowOf(b.id)).acceptedThrough).toBe(9);
  });

  it('a publish task during the rewind caps at to', async () => {
    const b = await threeBatches('rpub');
    let published: unknown = null;
    rewindHooks.afterCommit = async () => {
      const book = await env.pipe.openBook(env.pdeps, b.id);
      published = (await publish.execute!({ deps: env.pdeps, book }, { id: 'p', target: 'through-9', params: { manual: true } } as never)).summary;
    };
    await rewindV3(env, b.id, 6, { reason: 'rewind' });
    expect(published).toMatchObject({ published: 6, through: 6 });
    expect((await rowOf(b.id)).publishedThrough).toBe(6);
  });

  it('a write task claimed while the rewind is in progress is skipped by prepare (stale rewinding), nothing run', async () => {
    const b = await threeBatches('rprep');
    await t.db.insert(tasks).values({ id: 'late', bookId: b.id, kind: 'book.write', target: 'batch-c00010', lane: 'write', state: 'ready', params: { mode: 'write', from: 10, count: 3 } });
    let prep: unknown = null;
    // 回退检查时这个任务还没在跑；认领之后（rewinding 已设）它才被拿走，prepare 就停下
    rewindHooks.afterCommit = async () => {
      await t.db.update(tasks).set({ state: 'leased' }).where(eq(tasks.id, 'late'));
      const book = await env.pipe.openBook(env.pdeps, b.id);
      const ctx: PipelineContext = { deps: env.pdeps, book };
      const task = (await t.db.select().from(tasks).where(eq(tasks.id, 'late')))[0] as TaskRow;
      const runDir = path.join(t.paths.runs, 'test', 'rprep');
      prep = await prepareV3(ctx, task, { runId: 'rprep', attempt: 1, runDir, snapshotDir: book.dir, outDir: path.join(runDir, 'out'), inDir: path.join(runDir, 'in'), baseCommit: book.headCommit, profileId: 'fake-writer', accountId: null, harness: 'fake', model: 'fake', role: 'writer', degraded: [] });
    };
    await rewindV3(env, b.id, 6, { reason: 'rewind' });
    expect(prep).toEqual({ kind: 'skip', result: { status: 'done', summary: { stale: 'rewinding' } } });
    expect((await rowOf(b.id)).acceptedThrough).toBe(6);
  });

  it('completed book rewound → active, completedAt/completedReason cleared, v3_end dismissed', async () => {
    const b = await threeBatches('rc');
    const m = readV3Meta((await rowOf(b.id)).meta);
    await t.db.update(books).set({ status: 'completed', meta: { v3: { ...m, completedAt: NOW, completedReason: 'backstop', completedNote: 'short' } } }).where(eq(books.id, b.id));
    await t.db.insert(inbox).values({ id: 'end1', bookId: b.id, kind: 'notice', title: '可能没收好尾', dedupeKey: `v3_end:${b.id}` });
    await rewindV3(env, b.id, 6, { reason: 'rewind' });
    const row = await rowOf(b.id);
    expect(row.status).toBe('active');
    const after = readV3Meta(row.meta);
    expect(after.completedAt).toBeUndefined();
    expect(after.completedReason).toBeUndefined();
    expect(after.completedNote).toBeUndefined();
    expect((await t.db.select().from(inbox).where(eq(inbox.id, 'end1')))[0]?.state).toBe('dismissed');
  });

  it('DB: rows > to deleted, totalCjk recomputed, batchLog cut, ownerRequests > to dropped, queued tasks stale, rewinding cleared', async () => {
    const b = await threeBatches('rdb');
    const m = readV3Meta((await rowOf(b.id)).meta);
    const reqs = [
      { id: 'q5', kind: 'rewrite', chapter: 5, note: '', at: NOW, status: 'waiting' },
      { id: 'q8', kind: 'rewrite', chapter: 8, note: '', at: NOW, status: 'waiting' },
    ];
    await t.db.update(books).set({ meta: { v3: { ...m, ownerRequests: reqs, locked: [2, 8], hintedShort: [3, 9], retro: { ...m.retro, afterBatches: 3 } } } }).where(eq(books.id, b.id));
    await t.db.insert(tasks).values({ id: 'queued', bookId: b.id, kind: 'book.write', target: 'batch-c00010', lane: 'write', state: 'ready', params: {} });
    await rewindV3(env, b.id, 6, { reason: 'rewind' });
    const row = await rowOf(b.id);
    const rows = await t.db.select().from(chapters).where(eq(chapters.bookId, b.id));
    expect(rows.map((r) => r.no).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(row.totalCjk).toBe(rows.reduce((s, r) => s + (r.cjk ?? 0), 0));
    expect(row).toMatchObject({ acceptedThrough: 6, cursor: 7, headCommit: await b.repo.head() });
    const after = readV3Meta(row.meta);
    expect(after.batchLog.map((e) => [e.from, e.to])).toEqual([
      [1, 3],
      [4, 6],
    ]);
    expect(after.ownerRequests.map((q) => [q.id, q.status])).toEqual([
      ['q5', 'waiting'],
      ['q8', 'dropped'],
    ]);
    expect(after).toMatchObject({ locked: [2], hintedShort: [3], rewinding: null, runawayBatches: 0, finaleNoMarker: 0, feedback: null });
    expect(after.retro.afterBatches).toBe(2);
    expect((await t.db.select().from(tasks).where(eq(tasks.id, 'queued')))[0]).toMatchObject({ state: 'stale', waitReason: 'rewind' });
  });

  it('DB step fails after the commit → rewinding stays set, no write proposed; recoverRewinds re-applies it idempotently', async () => {
    const b = await threeBatches('rfail');
    rewindHooks.afterCommit = async () => {
      throw new Error('db down');
    };
    await expect(rewindV3(env, b.id, 6, { reason: 'rewind', note: '慢一点' })).rejects.toThrow('db down');
    rewindHooks.afterCommit = null;
    let row = await rowOf(b.id);
    expect(readV3Meta(row.meta).rewinding).toMatchObject({ to: 6, note: '慢一点' });
    expect(row.acceptedThrough).toBe(9);
    expect(await b.repo.exists('manuscript/c00007.md')).toBe(false);
    const book = await env.pipe.openBook(env.pdeps, b.id);
    expect(await nextTasksV3({ deps: env.pdeps, book }, book, row)).toEqual([]);
    expect(await recoverRewinds(env)).toBe(1);
    row = await rowOf(b.id);
    const once = { accepted: row.acceptedThrough, total: row.totalCjk, head: row.headCommit, meta: readV3Meta(row.meta) };
    expect(once.accepted).toBe(6);
    expect(once.meta.rewinding).toBeNull();
    expect(once.meta.hints.map((h) => h.text)[1]).toBe('主人的意见：慢一点');
    // 回退提交记着笔记退回了批次起点（Novelist-Rewind-Notes: reverted）：恢复路径照样说笔记已是第 6 章写完时的版本
    expect(once.meta.hints[0]?.text).toContain('笔记已是第 6 章写完时的版本');
    // 再做一次 DB 那一步：结果一样
    const dir = await rewoundDir(b.repo);
    await applyRewindDb(env, b.id, { to: 6, ts: dir.slice('drafts/rewound-'.length), commit: once.head as string, note: '慢一点', movedDir: dir, notesFrom: null });
    row = await rowOf(b.id);
    const twice = readV3Meta(row.meta);
    expect({ accepted: row.acceptedThrough, total: row.totalCjk, head: row.headCommit }).toEqual({ accepted: once.accepted, total: once.total, head: once.head });
    expect({ ...twice, hints: twice.hints.map((h) => h.text) }).toEqual({ ...once.meta, hints: once.meta.hints.map((h) => h.text) });
    expect(await recoverRewinds(env)).toBe(0);
  });

  it('archived book → 409 v3_finished (the moved chapters could not be adopted back), nothing moved', async () => {
    const b = await threeBatches('rarch');
    await t.db.update(books).set({ status: 'archived' }).where(eq(books.id, b.id));
    const head = await b.repo.head();
    expect(await code(rewindV3(env, b.id, 6, { reason: 'rewind' }))).toEqual([409, 'v3_finished']);
    expect(await code(rewindV3(env, b.id, 6, { reason: 'rewrite_from' }))).toEqual([409, 'v3_finished']);
    expect(await b.repo.head()).toBe(head);
    expect(readV3Meta((await rowOf(b.id)).meta).rewinding).toBeNull();
  });

  it('batch base unknown (no batchLog, no trailers): recovery after a crash does not claim the notes were reverted; manuscript files above the claim on HEAD are moved too', async () => {
    // 9 章都来自一次主人提交（没有 Novelist-Part、没有 ch/ 标签），HEAD 上还多一个没入库的 c00010
    const fx = await addV3Book(t, 'rnull', { chapters: 9, files: { 'manuscript/c00010.md': chapterText(10) } });
    rewindHooks.afterCommit = async () => {
      throw new Error('db down');
    };
    await expect(rewindV3(env, fx.id, 6, { reason: 'rewind' })).rejects.toThrow('db down');
    rewindHooks.afterCommit = null;
    for (const no of [7, 8, 9, 10]) expect(await fx.repo.exists(`manuscript/${chapterId(no)}.md`), String(no)).toBe(false);
    expect(await recoverRewinds(env)).toBe(1);
    const hint = readV3Meta((await rowOf(fx.id)).meta).hints[0]?.text ?? '';
    expect(hint).toContain('主人把书退回到了第 6 章');
    expect(hint).not.toContain('笔记已是');
  });

  it('crash before the commit → recoverRewinds clears the flag, repo unchanged', async () => {
    const b = await threeBatches('rcrash');
    const head = await b.repo.head();
    const m = readV3Meta((await rowOf(b.id)).meta);
    await t.db.update(books).set({ meta: { v3: { ...m, rewinding: { to: 6, ts: '20261109T000000', at: '2026-11-09T00:00:00.000Z' } } } }).where(eq(books.id, b.id));
    expect(await recoverRewinds(env)).toBe(1);
    expect(readV3Meta((await rowOf(b.id)).meta).rewinding).toBeNull();
    expect(await b.repo.head()).toBe(head);
    expect((await rowOf(b.id)).acceptedThrough).toBe(9);
  });
});

describe('phase-1 books: batch boundaries from git trailers', () => {
  it('batchBaseFor falls back to the Novelist-Part trailers when batchLog is empty', async () => {
    const b = await threeBatches('pf');
    expect(await batchBaseFor(b.repo, { batchLog: [] }, 8)).toEqual({ base: b.heads[2], from: 7 });
    expect(await batchBaseFor(b.repo, { batchLog: [] }, 1)).toEqual({ base: b.heads[0], from: 1 });
    expect(await batchBaseFor(b.repo, { batchLog: [] }, 12)).toBeNull();
  });

  it('backfillBatchLog rebuilds the batches; rewindPoints then offers their boundaries', async () => {
    const b = await threeBatches('pb');
    const log = await backfillBatchLog(b.repo, 9);
    expect(log.map((e) => [e.kind, e.from, e.to, e.baseCommit, e.finalCommit, e.runId])).toEqual([
      ['open', 1, 3, b.heads[0], b.heads[1], 'run-1'],
      ['write', 4, 6, b.heads[1], b.heads[2], 'run-4'],
      ['write', 7, 9, b.heads[2], b.heads[3], 'run-7'],
    ]);
    expect(rewindPoints({ batchLog: log }, 0, 9).map((p) => p.to)).toEqual([6, 3, 0]);
    expect(rewindPoints({ batchLog: log }, 4, 9).map((p) => p.to)).toEqual([6]);
    // 回退之后再回填：回退点之后的旧批次不算
    await t.db.update(books).set({ meta: { v3: { ...readV3Meta((await rowOf(b.id)).meta), batchLog: [] } } }).where(eq(books.id, b.id));
    await rewindV3(env, b.id, 3, { reason: 'rewind' });
    expect((await backfillBatchLog(b.repo, 3)).map((e) => [e.from, e.to])).toEqual([[1, 3]]);
    expect(readV3Meta((await rowOf(b.id)).meta).batchLog.map((e) => [e.from, e.to])).toEqual([[1, 3]]);
  });
});
