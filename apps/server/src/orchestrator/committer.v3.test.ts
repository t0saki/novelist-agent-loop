import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chapterId, countCjk, tags } from '@novelist/shared';
import { books, chapters, tasks } from '../db/schema.js';
import type { BookRepo } from '../book/repo.js';
import { git } from '../book/git.js';
import { TRAILER } from '../book/trailers.js';
import type { PromotePlan, TaskRow } from '../pipeline/types.js';
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

function plan(s: Setup, o: { parts?: V3CommitPart[]; tail?: V3CommitPlan['tail']; bookYaml?: V3CommitPlan['bookYaml']; key?: string; runId?: string; completed?: V3BatchEffectArgs['completed']; completedOn?: number; hints?: V3Hint[]; baseCommit?: string } = {}): PromotePlan & { v3: V3CommitPlan } {
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

  it('HEAD missing c(from-1) → batch still lands, v3_gap inbox', async () => {
    const s = await setup();
    await commitOwnerEdit(t.db, s.repo, s.id, { files: [{ path: 'manuscript/c00005.md', content: null }], message: 'owner: rm c5', baseSha: null });
    const out = await promoteV3(t.db, s.repo, s.task, plan(s), meta);
    expect(out.landed).toEqual([6, 7, 8]);
    expect(out.notices.map((n) => n.dedupeKey)).toEqual([`v3_gap:${s.id}`]);
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
});
