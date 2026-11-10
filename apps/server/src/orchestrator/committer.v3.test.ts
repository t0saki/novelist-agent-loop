import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chapterId, countCjk, tags } from '@novelist/shared';
import { books, chapters, tasks } from '../db/schema.js';
import type { BookRepo } from '../book/repo.js';
import { git } from '../book/git.js';
import { TRAILER } from '../book/trailers.js';
import type { PromotePlan, TaskRow } from '../runtime/types.js';
import { lockChapter, readV3Meta } from '../flow/state.js';
import { chapterText } from '../flow/testing.js';
import { addV3Book } from '../flow/testing-book.js';
import type { V3BatchEffectArgs, V3CommitPart, V3CommitPlan, V3Hint } from '../flow/types.js';
import { commitOwnerEdit, promoteV3, revertPartialV3 } from './committer.js';
import { enqueue } from './queue.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv();
});
afterEach(async () => {
  await t.close();
});

const NOW = '2026-11-10T00:00:00.000Z';
const KEY = 'tk1@run-a';
const meta = { harness: 'fake', model: 'fake-1', isolation: 'none', instructionsHash: 'h1' };

interface Setup {
  id: string;
  repo: BookRepo;
  head: string;
  task: TaskRow;
}

async function setup(o: Parameters<typeof addV3Book>[2] = { chapters: 5 }): Promise<Setup> {
  const b = await addV3Book(t, 'v3b', o);
  await enqueue(t.db, { id: 'tk1', baseCommit: b.head, manifest: { hard: {}, soft: {}, rebaseValidators: [], configHash: '' }, spec: { kind: 'book.write', bookId: b.id, target: 'batch-c00006', lane: 'write' } });
  const task = (await t.db.select().from(tasks).where(eq(tasks.id, 'tk1')))[0] as TaskRow;
  return { id: b.id, repo: b.repo, head: b.head, task };
}

function part(no: number, o: { rewrite?: boolean; title?: string; seed?: number; chars?: number } = {}): V3CommitPart {
  const title = o.title ?? `新章${no}`;
  return {
    no,
    path: `manuscript/${chapterId(no)}.md`,
    content: chapterText(no, o.chars ?? 3200, title, o.seed ?? no + 100),
    message: `chapter: ${o.rewrite ? 'rewrite ' : ''}${chapterId(no)}「${title}」`,
    tag: o.rewrite ? null : tags.chapter(no),
    rewrite: o.rewrite === true,
    extra: [],
  };
}

function plan(
  s: Setup,
  o: { parts?: V3CommitPart[]; tail?: V3CommitPlan['tail']; bookYaml?: V3CommitPlan['bookYaml']; key?: string; runId?: string; completed?: V3BatchEffectArgs['completed']; completedOn?: number; hints?: V3Hint[]; baseCommit?: string; args?: Partial<V3BatchEffectArgs> } = {},
): PromotePlan & { v3: V3CommitPlan } {
  const parts = o.parts ?? [part(6), part(7), part(8)];
  const runId = o.runId ?? 'run-a';
  const fresh = parts.filter((p) => !p.rewrite);
  const args: V3BatchEffectArgs = {
    bookId: s.id,
    runId,
    nowIso: NOW,
    chapters: parts.map((p) => ({ no: p.no, cid: chapterId(p.no), title: `新章${p.no}`, cjk: countCjk(p.content), rewrite: p.rewrite, path: p.path })),
    batchFrom: fresh[0]?.no ?? null,
    completed: o.completed ?? false,
    ...(o.completedOn !== undefined ? { completedOn: o.completedOn } : {}),
    hints: o.hints ?? [{ kind: 'short', text: '补一补', chapter: 6, at: NOW }],
    noChapterStreak: 0,
    finaleNoMarker: 0,
    hintedShort: [],
    orderKind: 'book.write',
    baseCommit: o.baseCommit ?? s.head,
    runawayBatches: 0,
    shortEndUsed: false,
    plannedFloor: null,
    ...(o.args ?? {}),
  };
  const base = o.baseCommit ?? s.head;
  const tailMessage = `notes: book.write 6–8 run ${runId.slice(0, 8)}`;
  return {
    bookId: s.id,
    taskId: 'tk1',
    runId,
    baseCommit: base,
    files: [],
    resolveTmpIds: false,
    message: tailMessage,
    trailers: {},
    tags: [],
    effect: { name: 'v3.batch', args: args as unknown as Record<string, unknown> },
    v3: { key: o.key ?? KEY, parts, tail: o.tail ?? [{ path: 'notes/progress.md', content: '写到第 8 章。\n' }], bookYaml: o.bookYaml ?? [], baseCommit: base, tailMessage },
  };
}

async function commitsSince(repo: BookRepo, from: string): Promise<{ sha: string; subject: string; trailers: Record<string, string>; tags: string[] }[]> {
  const out = (await git(repo.dir, ['rev-list', '--reverse', `${from}..HEAD`])).split('\n').filter(Boolean);
  const log = (await repo.log({ limit: 100 })).items;
  return out.map((sha) => log.find((c) => c.sha === sha) as (typeof log)[number]);
}

const filesOf = async (repo: BookRepo, sha: string): Promise<string[]> => (await git(repo.dir, ['show', '--name-only', '--format=', sha])).split('\n').filter(Boolean).sort();
const bookRow = async (id: string) => (await t.db.select().from(books).where(eq(books.id, id)))[0] as typeof books.$inferSelect;

describe('promoteV3', () => {
  it('one commit per chapter, tags ch/NNNNN on each, tail in last commit', async () => {
    const s = await setup();
    const out = await promoteV3(t.db, s.repo, s.task, plan(s), meta);
    expect(out.status).toBe('committed');
    expect(out.landed).toEqual([6, 7, 8]);
    const cs = await commitsSince(s.repo, s.head);
    expect(cs.map((c) => c.trailers[TRAILER.part])).toEqual([`${KEY}#6`, `${KEY}#7`, `${KEY}#8`]);
    expect(cs.map((c) => c.tags)).toEqual([['ch/00006'], ['ch/00007'], ['ch/00008']]);
    expect(await filesOf(s.repo, cs[0]!.sha)).toEqual(['manuscript/c00006.md']);
    expect(await filesOf(s.repo, cs[2]!.sha)).toEqual(['manuscript/c00008.md', 'notes/progress.md']);
    expect(cs[2]!.trailers[TRAILER.task]).toBe(KEY);
    expect(cs[2]!.trailers[TRAILER.chapters]).toBe('6,7,8');
    expect(cs[0]!.trailers[TRAILER.task]).toBeUndefined();
    expect(cs[0]!.trailers[TRAILER.harness]).toBe('fake');
    expect(out.commit).toBe(cs[2]!.sha);
    expect(await s.repo.isClean()).toBe(true);
  });

  it('rewrite commit untagged and before new chapters', async () => {
    const s = await setup();
    await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [part(4, { rewrite: true, chars: 4000 }), part(6)] }), meta);
    const cs = await commitsSince(s.repo, s.head);
    expect(cs.map((c) => c.subject)).toEqual(['chapter: rewrite c00004「新章4」', 'chapter: c00006「新章6」']);
    expect(cs[0]!.tags).toEqual([]);
    expect(cs[1]!.tags).toEqual(['ch/00006']);
    expect(await s.repo.readFile('manuscript/c00004.md')).toBe(part(4, { rewrite: true, chars: 4000 }).content);
  });

  it('notes-only commit when no chapter', async () => {
    const s = await setup();
    const out = await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [] }), meta);
    const cs = await commitsSince(s.repo, s.head);
    expect(cs).toHaveLength(1);
    expect(await filesOf(s.repo, cs[0]!.sha)).toEqual(['notes/progress.md']);
    expect(cs[0]!.trailers[TRAILER.task]).toBe(KEY);
    expect(cs[0]!.trailers[TRAILER.chapters]).toBeUndefined();
    expect(out.landed).toEqual([]);
    expect((await bookRow(s.id)).acceptedThrough).toBe(5);
  });

  it('same key twice → no duplicate commits (replay)', async () => {
    const s = await setup();
    const p = plan(s);
    await promoteV3(t.db, s.repo, s.task, p, meta);
    const before = await s.repo.head();
    const total = (await bookRow(s.id)).totalCjk;
    // tag 被挪走后重入：补回
    await s.repo.tag('ch/00007', s.head);
    const again = await promoteV3(t.db, s.repo, s.task, p, meta);
    expect(again.replay).toBe(true);
    expect(again.landed).toEqual([6, 7, 8]);
    expect(await s.repo.head()).toBe(before);
    expect(await commitsSince(s.repo, s.head)).toHaveLength(3);
    expect((await git(s.repo.dir, ['rev-list', '-n', '1', 'ch/00007'])).trim()).toBe((await commitsSince(s.repo, s.head))[1]!.sha);
    expect((await bookRow(s.id)).totalCjk).toBe(total);
  });

  it('crash after 2 of 3 parts → resume completes, parts not duplicated', async () => {
    const s = await setup();
    let calls = 0;
    const flaky = new Proxy(s.repo, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== 'commit') return typeof v === 'function' ? v.bind(target) : v;
        return async (input: Parameters<BookRepo['commit']>[0]) => {
          calls += 1;
          if (calls === 3) throw new Error('disk full');
          return target.commit(input);
        };
      },
    });
    await expect(promoteV3(t.db, flaky, s.task, plan(s), meta)).rejects.toThrow('disk full');
    expect(await commitsSince(s.repo, s.head)).toHaveLength(2);
    expect(await s.repo.isClean()).toBe(true);
    expect((await bookRow(s.id)).acceptedThrough).toBe(5);

    const out = await promoteV3(t.db, s.repo, s.task, plan(s), meta);
    expect(out.landed).toEqual([6, 7, 8]);
    const cs = await commitsSince(s.repo, s.head);
    expect(cs.map((c) => c.trailers[TRAILER.part])).toEqual([`${KEY}#6`, `${KEY}#7`, `${KEY}#8`]);
    expect(cs[2]!.trailers[TRAILER.task]).toBe(KEY);
    expect(await s.repo.tags('ch/*')).toEqual(['ch/00006', 'ch/00007', 'ch/00008']);
    expect((await bookRow(s.id)).acceptedThrough).toBe(8);
  });

  it('owner edited notes/progress.md during run → owner version kept, run copy in drafts/owner-conflicts, Novelist-Owner-Wins trailer, owner_edit hint in meta', async () => {
    const s = await setup();
    await commitOwnerEdit(t.db, s.repo, s.id, { files: [{ path: 'notes/progress.md', content: '主人写的进度。\n' }], message: 'owner: progress', baseSha: null });
    const out = await promoteV3(t.db, s.repo, s.task, plan(s), meta);
    expect(out.dropped).toEqual(['notes/progress.md']);
    expect(out.landed).toEqual([6, 7, 8]);
    expect(await s.repo.readFile('notes/progress.md')).toBe('主人写的进度。\n');
    expect(await s.repo.readFile('drafts/owner-conflicts/notes/progress.md')).toBe('写到第 8 章。\n');
    const last = (await s.repo.log({ limit: 1 })).items[0]!;
    expect(last.trailers[TRAILER.ownerWins]).toBe('notes/progress.md');
    const hints = readV3Meta((await bookRow(s.id)).meta).hints;
    expect(hints.map((h) => h.kind)).toEqual(['short', 'owner_edit']);
    expect(hints[1]!.text).toContain('notes/progress.md');
  });

  it('owner edit of unrelated file → nothing dropped', async () => {
    const s = await setup();
    await commitOwnerEdit(t.db, s.repo, s.id, { files: [{ path: 'notes/cast.md', content: '主人加的人物。\n' }], message: 'owner: cast', baseSha: null });
    const out = await promoteV3(t.db, s.repo, s.task, plan(s), meta);
    expect(out.dropped).toEqual([]);
    expect(await s.repo.readFile('notes/progress.md')).toBe('写到第 8 章。\n');
    expect(await s.repo.readFile('notes/cast.md')).toBe('主人加的人物。\n');
  });

  it('owner edited a new chapter path → that chapter and later ones go to drafts (contiguity)', async () => {
    const s = await setup();
    await commitOwnerEdit(t.db, s.repo, s.id, { files: [{ path: 'manuscript/c00007.md', content: '# 第7章 主人的\n\n主人写的。\n' }], message: 'owner: c7', baseSha: null });
    const out = await promoteV3(t.db, s.repo, s.task, plan(s), meta);
    expect(out.landed).toEqual([6]);
    expect(out.dropped).toEqual(['manuscript/c00007.md']);
    expect(await s.repo.readFile('manuscript/c00007.md')).toBe('# 第7章 主人的\n\n主人写的。\n');
    expect(await s.repo.readFile('drafts/owner-conflicts/manuscript/c00007.md')).toBe(part(7).content);
    expect(await s.repo.readFile('drafts/c00008.md')).toBe(part(8).content);
    expect(await s.repo.exists('manuscript/c00008.md')).toBe(false);
    expect((await bookRow(s.id)).acceptedThrough).toBe(6);
    expect(await s.repo.tags('ch/*')).toEqual(['ch/00006']);
  });

  it('owner locked a rewrite target during the run → rewrite to drafts', async () => {
    const s = await setup();
    await lockChapter(t.db, s.id, 4);
    const rw = part(4, { rewrite: true, chars: 4000 });
    const out = await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [rw, part(6)] }), meta);
    expect(out.landed).toEqual([6]);
    expect(await s.repo.readFile('manuscript/c00004.md')).toBe(chapterText(4));
    expect(await s.repo.readFile('drafts/c00004.rewrite.md')).toBe(rw.content);
    const row4 = (await t.db.select().from(chapters).where(eq(chapters.bookId, s.id))).find((c) => c.no === 4)!;
    expect(row4.cjk).toBe(countCjk(chapterText(4)));
  });

  it('HEAD missing c(from-1) → batch still lands, no notice', async () => {
    const s = await setup();
    await commitOwnerEdit(t.db, s.repo, s.id, { files: [{ path: 'manuscript/c00005.md', content: null }], message: 'owner: rm c5', baseSha: null });
    const out = await promoteV3(t.db, s.repo, s.task, plan(s), meta);
    expect(out.landed).toEqual([6, 7, 8]);
    expect(out.notices).toEqual([]);
    expect(await s.repo.exists('manuscript/c00008.md')).toBe(true);
  });

  it('ignored tail path dropped, commit succeeds', async () => {
    const s = await setup();
    const out = await promoteV3(t.db, s.repo, s.task, plan(s, { tail: [{ path: 'notes/progress.md', content: '写到第 8 章。\n' }, { path: 'views/scratch.md', content: '草稿\n' }] }), meta);
    expect(out.landed).toEqual([6, 7, 8]);
    const cs = await commitsSince(s.repo, s.head);
    expect(await filesOf(s.repo, cs[2]!.sha)).toEqual(['manuscript/c00008.md', 'notes/progress.md']);
  });

  it("book.yaml patch applied on HEAD content (owner's concurrent publish edit preserved)", async () => {
    const s = await setup();
    const yaml = (await s.repo.readFile('book.yaml')) as string;
    await commitOwnerEdit(t.db, s.repo, s.id, { files: [{ path: 'book.yaml', content: yaml.replace(/per_slot: 2/, 'per_slot: 3') }], message: 'owner: publish', baseSha: null });
    await promoteV3(t.db, s.repo, s.task, plan(s, { bookYaml: [{ path: ['v3', 'planned_chapters'], value: 18 }, { path: ['title'], value: '新书名' }] }), meta);
    const now = (await s.repo.readFile('book.yaml')) as string;
    expect(now).toContain('per_slot: 3');
    expect(now).toMatch(/planned_chapters: 18/);
    expect(now).toMatch(/title: 新书名/);
  });

  it('v3.batch effect: a finale that only marked the last accepted chapter (completedOn) completes the book; without completedOn it does not', async () => {
    const s = await setup();
    await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [part(5, { rewrite: true, chars: 4000 })], key: 'tk1@run-x', runId: 'run-x', completed: 'marker' }), meta);
    expect((await bookRow(s.id)).status).not.toBe('completed');
    const s2base = await s.repo.head();
    await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [part(5, { rewrite: true, chars: 4000, seed: 555 })], key: 'tk1@run-y', runId: 'run-y', completed: 'marker', completedOn: 5, baseCommit: s2base }), meta);
    const b = await bookRow(s.id);
    expect(b.status).toBe('completed');
    expect(b.acceptedThrough).toBe(5);
    expect(readV3Meta(b.meta).completedReason).toBe('marker');
  });

  it('v3.batch effect: chapter rows, acceptedThrough, totalCjk, status planning→active→completed, meta.v3.hints replaced, landed filter, pending cleared only for its own runId, locked untouched', async () => {
    const pending = (runId: string) => ({ taskId: 'tk1', runId, attempt: 1, stage: 'harvested', runDir: '/r', inDir: '/r/in', snapshotDir: '/r/book', baseCommit: 'x', manifestFile: null, trailerKey: `tk1@${runId}`, route: { profile: 'p', account: null, harness: 'fake', model: null, isolation: 'none', stackHash: 'h' }, failures: 0, createdAt: NOW });
    const s = await setup({ chapters: 5, status: 'planning', meta: { locked: [2], pending: pending('run-a') as never, hints: [{ kind: 'unfinished', text: '旧提示', at: NOW }], emptyStreak: 3 } });
    const before = await bookRow(s.id);
    const p1 = plan(s, { parts: [part(6), part(7)] });
    await promoteV3(t.db, s.repo, s.task, p1, meta);
    let b = await bookRow(s.id);
    let m = readV3Meta(b.meta);
    expect(b.status).toBe('active');
    expect(b.acceptedThrough).toBe(7);
    expect(b.cursor).toBe(8);
    expect(b.totalCjk).toBe(before.totalCjk + countCjk(part(6).content) + countCjk(part(7).content));
    expect(b.headCommit).toBe(await s.repo.head());
    expect(m.hints.map((h) => h.text)).toEqual(['补一补']);
    expect(m.pending).toBeNull();
    expect(m.locked).toEqual([2]);
    expect(m.emptyStreak).toBe(0);
    expect(m.lastBatchFrom).toBe(6);
    const rows = await t.db.select().from(chapters).where(eq(chapters.bookId, s.id));
    const r7 = rows.find((r) => r.no === 7)!;
    expect(r7).toMatchObject({ state: 'accepted', title: '新章7', cjk: countCjk(part(7).content), acceptedCommit: await s.repo.head(), volume: '', arc: '' });
    expect(Date.parse(r7.acceptedAt as string)).toBe(Date.parse(NOW));
    expect(r7.workflow).toEqual({ v3: true });

    // 别的 run 的 pending 不动；结束全书的章被主人顶掉 → 不算完结，也不入库
    await t.db.update(books).set({ meta: { ...(b.meta as object), v3: { ...m, pending: pending('run-other') } } }).where(eq(books.id, s.id));
    await enqueue(t.db, { id: 'tk1', baseCommit: null, manifest: { hard: {}, soft: {}, rebaseValidators: [], configHash: '' }, spec: { kind: 'book.write', bookId: s.id, target: 'batch-c00008', lane: 'write' } });
    const base2 = await s.repo.head();
    await commitOwnerEdit(t.db, s.repo, s.id, { files: [{ path: 'manuscript/c00009.md', content: '# 第9章\n\n主人。\n' }], message: 'owner: c9', baseSha: null });
    await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [part(8), part(9)], key: 'tk1@run-b', runId: 'run-b', completed: 'marker', baseCommit: base2 }), meta);
    b = await bookRow(s.id);
    m = readV3Meta(b.meta);
    expect(b.acceptedThrough).toBe(8);
    expect(b.status).toBe('active');
    expect(m.completedAt).toBeUndefined();
    expect(m.pending?.runId).toBe('run-other');
    expect((await t.db.select().from(chapters).where(eq(chapters.bookId, s.id))).some((r) => r.no === 9)).toBe(false);
    expect(m.hints.map((h) => h.kind)).toEqual(['short', 'owner_edit']);

    // 完结批：status → completed
    const base3 = await s.repo.head();
    await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [part(9, { seed: 999 })], key: 'tk1@run-c', runId: 'run-c', completed: 'marker', baseCommit: base3 }), meta);
    b = await bookRow(s.id);
    m = readV3Meta(b.meta);
    expect(b.status).toBe('completed');
    expect(b.acceptedThrough).toBe(9);
    expect(m.completedReason).toBe('marker');
    expect(m.locked).toEqual([2]);
  });
});

describe('revertPartialV3 (discarding a pending after a partial promote)', () => {
  it('chapters committed by the failed promote go back to base, their text to drafts/*.discarded.md, new-chapter tags removed', async () => {
    const s = await setup();
    const c4base = await s.repo.readFile('manuscript/c00004.md');
    // promote 在第 7 章之前失败：第 4 章改写、第 6 章新章已经各自提交
    for (const p of [part(4, { rewrite: true, chars: 4000 }), part(6)]) {
      await s.repo.writeFiles([{ path: p.path, content: p.content }]);
      await s.repo.commit({ message: p.message, trailers: { [TRAILER.part]: `${KEY}#${p.no}` }, paths: [p.path], ...(p.tag ? { tags: [p.tag] } : {}) });
    }
    expect(await s.repo.tags('ch/*')).toContain('ch/00006');
    const landed6 = await s.repo.readFile('manuscript/c00006.md');
    const out = await revertPartialV3(t.db, s.repo, s.id, { trailerKey: KEY, baseCommit: s.head });
    expect(out).toEqual([4, 6]);
    expect(await s.repo.readFile('manuscript/c00006.md')).toBeNull();
    expect(await s.repo.readFile('manuscript/c00004.md')).toBe(c4base);
    expect(await s.repo.readFile('drafts/c00006.discarded.md')).toBe(landed6);
    expect(await s.repo.readFile('drafts/c00004.discarded.md')).toContain('# 第4章');
    expect(await s.repo.tags('ch/*')).not.toContain('ch/00006');
    expect(await s.repo.isClean()).toBe(true);
    // 没有分章提交时什么都不做
    expect(await revertPartialV3(t.db, s.repo, s.id, { trailerKey: 'tk1@other', baseCommit: s.head })).toEqual([]);
  });

  it('with runId: refused under the lock when the pending is no longer this run or the batch has its final commit (replayed); otherwise clears the pending', async () => {
    const pending = { taskId: 'tk1', runId: 'run-a', attempt: 1, stage: 'harvested', runDir: '/x', inDir: '/x/in', snapshotDir: '/x/book', baseCommit: '', manifestFile: null, trailerKey: KEY, route: { profile: 'p', account: null, harness: 'fake', model: null, isolation: 'none', stackHash: 'h' }, failures: 3, createdAt: NOW };
    const s = await setup({ chapters: 5, meta: { pending: pending as never } });
    // 重试抢先把整批提交了（最终提交带 Novelist-Task: KEY）
    await promoteV3(t.db, s.repo, s.task, plan(s), meta);
    await t.db.update(books).set({ meta: { v3: { ...readV3Meta((await bookRow(s.id)).meta), pending: { ...pending, baseCommit: s.head } } } }).where(eq(books.id, s.id));
    await expect(revertPartialV3(t.db, s.repo, s.id, { trailerKey: KEY, baseCommit: s.head, runId: 'run-a' })).rejects.toMatchObject({ code: 'landed' });
    expect(await s.repo.readFile('manuscript/c00006.md')).not.toBeNull();
    // pending 已经不是这一次的
    await expect(revertPartialV3(t.db, s.repo, s.id, { trailerKey: KEY, baseCommit: s.head, runId: 'run-x' })).rejects.toMatchObject({ code: 'gone' });
    // 另一次没提交过的运行：撤回（没有分章）并清掉 pending
    await t.db.update(books).set({ meta: { v3: { ...readV3Meta((await bookRow(s.id)).meta), pending: { ...pending, runId: 'run-b', trailerKey: 'tk1@run-b' } } } }).where(eq(books.id, s.id));
    expect(await revertPartialV3(t.db, s.repo, s.id, { trailerKey: 'tk1@run-b', baseCommit: s.head, runId: 'run-b' })).toEqual([]);
    expect(readV3Meta((await bookRow(s.id)).meta).pending).toBeNull();
  });
});

describe('v3.batch effect (phase 2 fields)', () => {
  it('appends batchLog with baseCommit/finalCommit (only when new chapters land)', async () => {
    const s = await setup();
    await promoteV3(t.db, s.repo, s.task, plan(s, { args: { toolSteps: 42 } }), meta);
    let m = readV3Meta((await bookRow(s.id)).meta);
    const head1 = await s.repo.head();
    expect(m.batchLog).toEqual([{ runId: 'run-a', kind: 'write', from: 6, to: 8, baseCommit: s.head, finalCommit: head1, at: NOW, toolSteps: 42 }]);
    // notes-only commit: no entry
    await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [], key: 'tk1@run-n', runId: 'run-n', baseCommit: head1 }), meta);
    m = readV3Meta((await bookRow(s.id)).meta);
    expect(m.batchLog).toHaveLength(1);
    // the open batch and a completing batch get their own kinds
    const head2 = await s.repo.head();
    await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [part(9)], key: 'tk1@run-f', runId: 'run-f', baseCommit: head2, completed: 'marker' }), meta);
    m = readV3Meta((await bookRow(s.id)).meta);
    expect(m.batchLog.map((e) => [e.kind, e.from, e.to, e.baseCommit])).toEqual([
      ['write', 6, 8, s.head],
      ['finale', 9, 9, head2],
    ]);
  });
  it('retro effect keeps streaks and hints, sets retro.afterBatches', async () => {
    const hints: V3Hint[] = [{ kind: 'short', text: '旧提示', chapter: 4, rewrite: 4, at: NOW }];
    const batchLog = [1, 2, 3, 4].map((i) => ({ runId: `r${i}`, kind: 'write' as const, from: i, to: i, baseCommit: 'b', finalCommit: 'f', at: NOW }));
    const s = await setup({ chapters: 5, meta: { hints, noChapterStreak: 2, emptyStreak: 1, finaleNoMarker: 1, hintedShort: [4], batchLog } });
    await promoteV3(
      t.db,
      s.repo,
      s.task,
      plan(s, { parts: [], tail: [{ path: 'notes/retro.md', content: '1. 少写景。\n' }], key: 'tk1@run-r', runId: 'run-r', hints: [], args: { orderKind: 'book.retro', noChapterStreak: 0, finaleNoMarker: 0, hintedShort: [] } }),
      meta,
    );
    const b = await bookRow(s.id);
    const m = readV3Meta(b.meta);
    expect(m.hints).toEqual(hints);
    expect(m).toMatchObject({ noChapterStreak: 2, emptyStreak: 1, finaleNoMarker: 1, hintedShort: [4] });
    expect(m.retro).toEqual({ afterBatches: 4, lastAt: NOW, lastRunId: 'run-r', lastStatus: 'done' });
    expect(m.batchLog).toHaveLength(4);
    expect(b.acceptedThrough).toBe(5);
    expect(await s.repo.readFile('notes/retro.md')).toBe('1. 少写景。\n');
  });
  it('completed backstop stored; completedNote short stored', async () => {
    const s = await setup();
    await promoteV3(t.db, s.repo, s.task, plan(s, { completed: 'backstop', args: { completedNote: 'short' } }), meta);
    const b = await bookRow(s.id);
    expect(b.status).toBe('completed');
    expect(readV3Meta(b.meta)).toMatchObject({ completedReason: 'backstop', completedNote: 'short' });
  });
  it('runawayBatches, shortEndUsed, plannedFloor and feedback written', async () => {
    const s = await setup();
    await promoteV3(t.db, s.repo, s.task, plan(s, { args: { runawayBatches: 2, shortEndUsed: true, plannedFloor: 33, feedback: { from: 6, to: 8, phrases: ['甲乙丙丁'] } } }), meta);
    expect(readV3Meta((await bookRow(s.id)).meta)).toMatchObject({ runawayBatches: 2, shortEndUsed: true, plannedFloor: 33, feedback: { from: 6, to: 8, phrases: ['甲乙丙丁'] } });
  });
  it('batchNote + book.yaml batch patch applied', async () => {
    const s = await setup({ chapters: 5, batch: 5 });
    const note = { from: 5, to: 4, steps: 230, runId: 'run-a', at: NOW };
    await promoteV3(t.db, s.repo, s.task, plan(s, { bookYaml: [{ path: ['v3', 'batch'], value: 4 }], args: { batchNote: note } }), meta);
    expect(readV3Meta((await bookRow(s.id)).meta).batchNote).toEqual(note);
    expect((await s.repo.readFile('book.yaml')) as string).toMatch(/\bbatch: 4\b/);
  });
  it('finaleNoMarkerAlerted set by the alert, cleared when finaleNoMarker is 0', async () => {
    const s = await setup();
    await promoteV3(t.db, s.repo, s.task, plan(s, { args: { finaleNoMarker: 2, finaleNoMarkerAlert: true } }), meta);
    expect(readV3Meta((await bookRow(s.id)).meta).finaleNoMarkerAlerted).toBe(true);
    const h1 = await s.repo.head();
    await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [part(9)], key: 'tk1@run-b', runId: 'run-b', baseCommit: h1, args: { finaleNoMarker: 3 } }), meta);
    expect(readV3Meta((await bookRow(s.id)).meta)).toMatchObject({ finaleNoMarker: 3, finaleNoMarkerAlerted: true });
    const h2 = await s.repo.head();
    await promoteV3(t.db, s.repo, s.task, plan(s, { parts: [part(10)], key: 'tk1@run-c', runId: 'run-c', baseCommit: h2, args: { finaleNoMarker: 0 } }), meta);
    expect(readV3Meta((await bookRow(s.id)).meta)).toMatchObject({ finaleNoMarker: 0, finaleNoMarkerAlerted: false });
  });
});

describe('WP-2: serverTail, owner message receipt, owner request results', () => {
  const msg = (sha: string) => ({ id: 'm1', text: '多写对话。', sha, setAt: NOW, readIn: null, archivedPath: null, status: 'waiting' as const });
  it('serverTail lands in the final commit when HEAD still has the expected blob; the effect records the receipt', async () => {
    const s0 = await setup();
    await commitOwnerEdit(t.db, s0.repo, s0.id, { files: [{ path: 'notes/from-owner.md', content: '多写对话。\n' }], message: 'owner: msg', baseSha: null });
    const sha = (await s0.repo.blobShas(['notes/from-owner.md']))['notes/from-owner.md']!;
    await t.db.update(books).set({ meta: { v3: { ...readV3Meta((await bookRow(s0.id)).meta), ownerMessage: msg(sha) } } }).where(eq(books.id, s0.id));
    const base = await s0.repo.head();
    const p = plan(s0, { baseCommit: base, args: { ownerMessageRead: { sha, kind: 'write', from: 6, to: 8, at: NOW, runId: 'run-a', archivedPath: 'notes/archive/from-owner/20261110-0000.md' } } });
    p.v3.serverTail = [
      { path: 'notes/from-owner.md', content: '', expectSha: sha },
      { path: 'notes/archive/from-owner/20261110-0000.md', content: '多写对话。\n', expectSha: null },
    ];
    await promoteV3(t.db, s0.repo, s0.task, p, meta);
    expect(await s0.repo.readFile('notes/from-owner.md')).toBe('');
    expect(await s0.repo.readFile('notes/archive/from-owner/20261110-0000.md')).toBe('多写对话。\n');
    const last = (await commitsSince(s0.repo, base)).at(-1)!;
    expect(await filesOf(s0.repo, last.sha)).toContain('notes/from-owner.md');
    const m = readV3Meta((await bookRow(s0.id)).meta);
    expect(m.ownerMessage).toBeNull();
    expect(m.ownerMessages[0]).toMatchObject({ id: 'm1', status: 'read', archivedPath: 'notes/archive/from-owner/20261110-0000.md', readIn: { kind: 'write', from: 6, to: 8, runId: 'run-a' } });
  });

  it('owner replaced the message during the run → serverTail skipped as a group, new message kept and still waiting', async () => {
    const s0 = await setup();
    await commitOwnerEdit(t.db, s0.repo, s0.id, { files: [{ path: 'notes/from-owner.md', content: '旧话。\n' }], message: 'owner: msg', baseSha: null });
    const oldSha = (await s0.repo.blobShas(['notes/from-owner.md']))['notes/from-owner.md']!;
    const base = await s0.repo.head();
    await commitOwnerEdit(t.db, s0.repo, s0.id, { files: [{ path: 'notes/from-owner.md', content: '新话。\n' }], message: 'owner: msg2', baseSha: null });
    const newSha = (await s0.repo.blobShas(['notes/from-owner.md']))['notes/from-owner.md']!;
    await t.db.update(books).set({ meta: { v3: { ...readV3Meta((await bookRow(s0.id)).meta), ownerMessage: msg(newSha) } } }).where(eq(books.id, s0.id));
    const p = plan(s0, { baseCommit: base, args: { ownerMessageRead: { sha: oldSha, kind: 'write', from: 6, to: 8, at: NOW, runId: 'run-a', archivedPath: 'notes/archive/from-owner/x.md' } } });
    p.v3.serverTail = [
      { path: 'notes/from-owner.md', content: '', expectSha: oldSha },
      { path: 'notes/archive/from-owner/x.md', content: '旧话。\n', expectSha: null },
    ];
    const out = await promoteV3(t.db, s0.repo, s0.task, p, meta);
    expect(out.landed).toEqual([6, 7, 8]);
    expect(await s0.repo.readFile('notes/from-owner.md')).toBe('新话。\n');
    expect(await s0.repo.exists('notes/archive/from-owner/x.md')).toBe(false);
    expect(await s0.repo.exists('drafts/owner-conflicts/notes/from-owner.md')).toBe(false);
    expect(readV3Meta((await bookRow(s0.id)).meta).ownerMessage).toMatchObject({ sha: newSha, status: 'waiting' });
  });

  it('owner request results: landed rewrite → done, otherwise not_done; replaced text extra committed with the rewrite', async () => {
    const reqs = [
      { id: 'q4', kind: 'rewrite' as const, chapter: 4, note: '改', at: NOW, status: 'waiting' as const },
      { id: 'q3', kind: 'rewrite' as const, chapter: 3, note: '也改', at: NOW, status: 'waiting' as const },
    ];
    const s0 = await setup({ chapters: 5, meta: { ownerRequests: reqs } });
    const rw = { ...part(4, { rewrite: true, chars: 2000 }), extra: [{ path: 'drafts/replaced/20261110T000000/c00004.md', content: chapterText(4) }] };
    await promoteV3(t.db, s0.repo, s0.task, plan(s0, { parts: [rw, part(6)], args: { ownerRequestResults: [{ id: 'q4', chapter: 4 }, { id: 'q3', chapter: 3 }] } }), meta);
    const m = readV3Meta((await bookRow(s0.id)).meta);
    expect(m.ownerRequests.map((r) => [r.id, r.status, r.runId])).toEqual([
      ['q4', 'done', 'run-a'],
      ['q3', 'not_done', 'run-a'],
    ]);
    expect(await s0.repo.readFile('drafts/replaced/20261110T000000/c00004.md')).toBe(chapterText(4));
  });

  it('owner request results when the run was not final (crash / timeout / nothing landed): a landed rewrite is still done, the rest stays waiting', async () => {
    const reqs = [
      { id: 'q4', kind: 'rewrite' as const, chapter: 4, note: '改', at: NOW, status: 'waiting' as const },
      { id: 'q3', kind: 'rewrite' as const, chapter: 3, note: '也改', at: NOW, status: 'waiting' as const },
    ];
    const s0 = await setup({ chapters: 5, meta: { ownerRequests: reqs } });
    const rw = part(4, { rewrite: true, chars: 2000 });
    await promoteV3(t.db, s0.repo, s0.task, plan(s0, { parts: [rw], args: { ownerRequestResults: [{ id: 'q4', chapter: 4, final: false }, { id: 'q3', chapter: 3, final: false }] } }), meta);
    const m = readV3Meta((await bookRow(s0.id)).meta);
    expect(m.ownerRequests.map((r) => [r.id, r.status])).toEqual([
      ['q4', 'done'],
      ['q3', 'waiting'],
    ]);
    expect(m.ownerRequests[1]?.runId).toBeUndefined();
  });

  it('every planned chapter pushed out by owner edits → serverTail not applied, message stays waiting (no false receipt)', async () => {
    const s0 = await setup();
    await commitOwnerEdit(t.db, s0.repo, s0.id, { files: [{ path: 'notes/from-owner.md', content: '多写对话。\n' }], message: 'owner: msg', baseSha: null });
    const sha = (await s0.repo.blobShas(['notes/from-owner.md']))['notes/from-owner.md']!;
    await t.db.update(books).set({ meta: { v3: { ...readV3Meta((await bookRow(s0.id)).meta), ownerMessage: msg(sha) } } }).where(eq(books.id, s0.id));
    const base = await s0.repo.head();
    // 运行期间主人自己写了第 6 章：本批唯一的新章被顶掉
    await commitOwnerEdit(t.db, s0.repo, s0.id, { files: [{ path: 'manuscript/c00006.md', content: chapterText(6) }], message: 'owner: c6', baseSha: null });
    const p = plan(s0, { parts: [part(6)], baseCommit: base, args: { ownerMessageRead: { sha, kind: 'write', from: 6, to: 6, at: NOW, runId: 'run-a', archivedPath: 'notes/archive/from-owner/y.md' } } });
    p.v3.serverTail = [
      { path: 'notes/from-owner.md', content: '', expectSha: sha },
      { path: 'notes/archive/from-owner/y.md', content: '多写对话。\n', expectSha: null },
    ];
    const out = await promoteV3(t.db, s0.repo, s0.task, p, meta);
    expect(out.landed).toEqual([]);
    expect(await s0.repo.readFile('notes/from-owner.md')).toBe('多写对话。\n');
    expect(await s0.repo.exists('notes/archive/from-owner/y.md')).toBe(false);
    expect(readV3Meta((await bookRow(s0.id)).meta).ownerMessage).toMatchObject({ sha, status: 'waiting' });
  });

  it('receipt range is recomputed from what actually landed', async () => {
    const s0 = await setup();
    await commitOwnerEdit(t.db, s0.repo, s0.id, { files: [{ path: 'notes/from-owner.md', content: '多写对话。\n' }], message: 'owner: msg', baseSha: null });
    const sha = (await s0.repo.blobShas(['notes/from-owner.md']))['notes/from-owner.md']!;
    await t.db.update(books).set({ meta: { v3: { ...readV3Meta((await bookRow(s0.id)).meta), ownerMessage: msg(sha) } } }).where(eq(books.id, s0.id));
    const base = await s0.repo.head();
    // 主人写了第 8 章：6、7 落地
    await commitOwnerEdit(t.db, s0.repo, s0.id, { files: [{ path: 'manuscript/c00008.md', content: chapterText(8) }], message: 'owner: c8', baseSha: null });
    const p = plan(s0, { baseCommit: base, args: { ownerMessageRead: { sha, kind: 'write', from: 6, to: 8, at: NOW, runId: 'run-a', archivedPath: 'notes/archive/from-owner/z.md' } } });
    p.v3.serverTail = [
      { path: 'notes/from-owner.md', content: '', expectSha: sha },
      { path: 'notes/archive/from-owner/z.md', content: '多写对话。\n', expectSha: null },
    ];
    expect((await promoteV3(t.db, s0.repo, s0.task, p, meta)).landed).toEqual([6, 7]);
    expect(readV3Meta((await bookRow(s0.id)).meta).ownerMessages[0]?.readIn).toMatchObject({ from: 6, to: 7 });
  });
});
