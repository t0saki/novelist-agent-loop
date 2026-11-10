/**
 * 接手旧书（P3 WP-3，D16；services/takeover.ts）：只改 book.yaml、可重入、从不自动接手、回退不能退到接手之前。
 * 夹具 = book/testing-legacy.ts（导入书的样子）。
 */
import os from 'node:os';
import path from 'node:path';
import { and, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { takeoverPlanned, type V3BookView } from '@novelist/shared';
import { isV3Meta, openRepo, P } from '../book/index.js';
import { createLegacyBook } from '../book/testing-legacy.js';
import { WRITER_OVERRIDE_TRAILER, runBootMigrations, runPostRecoveryMigrations } from '../boot/migrate-p3.js';
import { books, chapters, tasks } from '../db/schema.js';
import { CLOSING_BATCHES, endingPhase } from '../flow/decide.js';
import { saveSlots } from '../orchestrator/routing.js';
import { saveChapterText, saveRepoFile } from './repo-files.js';
import { readV3Meta } from '../flow/state.js';
import { createScheduler } from '../orchestrator/index.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';
import { createBook } from './books.js';
import { takeOverBook } from './takeover.js';

let t: TestApp;
let cookie: string;

const admin = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
const repoOf = (slug: string) => openRepo(path.join(t.deps.paths.books, slug));
const yamlOf = async (slug: string) => yamlParse((await repoOf(slug).readFile(P.bookYaml)) as string) as Record<string, unknown>;
const TAKEOVER_SUBJECT = 'owner: take over legacy book (flow v3)';
const takeoverCommits = async (slug: string) => (await repoOf(slug).log({ limit: 100 })).items.filter((c) => c.subject === TAKEOVER_SUBJECT).length;
const body = { length: 'medium' as const, target_cjk: 80_000, batch: 5, min_chapter_cjk: 3000 };

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('takeover', () => {
  it('1. an archived legacy book: one owner commit that only touches book.yaml (old keys and comments kept); meta.v3 with a pending takeover and an adopt entry; status planning', async () => {
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'tk-archived', { chapters: 6, published: 6, status: 'archived', pausedReason: null, bookYamlExtra: '# 主人的注释：这本书要慢慢写\npublish:\n  require_audited: true\n  lag: auto\n' });
    const repo = repoOf('tk-archived');
    const before = await repo.head();
    const oldText = (await repo.readFile(P.bookYaml)) as string;
    const oldDoc = yamlParse(oldText) as Record<string, unknown>;
    const res = await admin('POST', '/api/admin/books/tk-archived/takeover', { ...body, start: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ slug: 'tk-archived', legacy: false, flow: 'v3', status: 'planning' });

    // git：只多了一个提交，只改了 book.yaml
    expect((await repo.log({ limit: 2 })).items[1]?.sha).toBe(before);
    expect(await repo.changedPaths(before, await repo.head())).toEqual(['book.yaml']);
    const text = (await repo.readFile(P.bookYaml)) as string;
    expect(text).toContain('# 主人的注释：这本书要慢慢写');
    const doc = yamlParse(text) as Record<string, unknown>;
    for (const [k, v] of Object.entries(oldDoc)) if (k !== 'publish') expect(doc[k], k).toEqual(v);
    expect(Object.keys(doc).filter((k) => !(k in oldDoc)).sort()).toEqual(['flow', 'v3']);
    expect(doc.flow).toBe('v3');
    // 计划章数：按这本书的每章字数（不低于下限 3000）折算 80000 字 = 27 章，但至少还要留 CLOSING_BATCHES + 2 = 5 批（6 + 25 = 31）
    expect(doc.v3).toMatchObject({ length: 'medium', target_cjk: 80_000, planned_chapters: 31, planned_chapters_initial: 31, batch: 5, min_chapter_cjk: 3000, auto_title: false, effort: { open: 'medium', write: 'medium', closing: 'high', finale: 'high', retro: 'medium' } });
    // 旧的 require_audited / lag 会卡住新流程的发布：换成新流程的值
    expect(doc.publish).toMatchObject({ mode: 'scheduled', cadence: '0 8 * * *', per_slot: 2, max_buffer: 15, resume_buffer: 10, require_audited: false, lag: 0, min_lag: 0 });
    expect((await repo.log({ limit: 1 })).items[0]?.trailers['Novelist-Owner-Edit']).toBe('true');

    const row = await rowOf('tk-archived');
    expect(row).toMatchObject({ status: 'planning', pausedReason: null, archivedAt: null, acceptedThrough: 6, publishedThrough: 6 });
    expect('takeoverIntent' in (row.meta as object)).toBe(false);
    expect((row.meta as { v1?: unknown }).v1).toBeDefined();
    const meta = readV3Meta(row.meta);
    expect(meta.takeover).toMatchObject({ from: 7, status: 'pending' });
    expect(meta.batchLog).toEqual([{ kind: 'adopt', runId: null, from: 1, to: 6, baseCommit: await repo.head(), finalCommit: await repo.head(), at: expect.any(String) }]);
    expect(meta.retro.afterBatches).toBe(1);
    expect(meta.plannedFloor).toBe(31);
    // 开写：第一个任务是从第 7 章起的写作批
    const ts = await t.deps.db.select().from(tasks).where(eq(tasks.bookId, row.id));
    expect(ts.map((x) => [x.kind, (x.params as { from?: number }).from])).toEqual([['book.write', 7]]);
    await t.deps.orchestrator.cancelTask(ts[0]!.id);
  });

  it('2. a v3 book → 409 not_legacy (defaults too)', async () => {
    await createBook(t.deps, { title: '新书', slug: 'tk-v3', genre: 'xianxia', length: 'medium', start: false });
    for (const r of [await admin('POST', '/api/admin/books/tk-v3/takeover', body), await admin('GET', '/api/admin/books/tk-v3/takeover')]) {
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe('not_legacy');
    }
  });

  it('3. AGENTS.md over 16 KB → 409 instructions_too_large with layer sizes, nothing written; the old v2 book template renders fine', async () => {
    const big = `${'本书要求：多写对白。\n'.repeat(1800)}`;
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'tk-big', { files: { 'instructions/AGENTS.md': big } });
    const head = await repoOf('tk-big').head();
    const res = await admin('POST', '/api/admin/books/tk-big/takeover', body);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('instructions_too_large');
    expect((res.json().errors as { path: string }[]).map((e) => e.path)).toContain('L3');
    expect(await repoOf('tk-big').head()).toBe(head);
    const row = await rowOf('tk-big');
    expect(isV3Meta(row.meta)).toBe(false);
    expect('takeoverIntent' in (row.meta as object)).toBe(false);
    expect(b.id).toBe(row.id);
    // 默认值里也报出来
    expect((await admin('GET', '/api/admin/books/tk-big/takeover')).json()).toMatchObject({ agentsOver: true });
  });

  it('4. the genre pack is missing → 409 unknown_genre, nothing written', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-nogenre', { genre: 'gone-pack' });
    const head = await repoOf('tk-nogenre').head();
    const res = await admin('POST', '/api/admin/books/tk-nogenre/takeover', body);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('unknown_genre');
    expect(await repoOf('tk-nogenre').head()).toBe(head);
    expect(isV3Meta((await rowOf('tk-nogenre')).meta)).toBe(false);
  });

  it('5. an imported paused book: start → planning (pausedReason cleared); start false → paused by the owner', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-start', { chapters: 4, published: 2 });
    const a = await admin('POST', '/api/admin/books/tk-start/takeover', { ...body, start: true });
    expect(a.statusCode, a.body).toBe(200);
    expect(await rowOf('tk-start')).toMatchObject({ status: 'planning', pausedReason: null });
    for (const x of await t.deps.db.select().from(tasks).where(eq(tasks.bookId, 'book-tk-start'))) await t.deps.orchestrator.cancelTask(x.id);
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-nostart', { chapters: 4, published: 2 });
    const b = await admin('POST', '/api/admin/books/tk-nostart/takeover', { ...body, start: false });
    expect(b.statusCode).toBe(200);
    expect(await rowOf('tk-nostart')).toMatchObject({ status: 'paused', pausedReason: 'owner' });
    expect(await t.deps.db.select().from(tasks).where(eq(tasks.bookId, 'book-tk-nostart'))).toEqual([]);
  });

  it('busy: a book with a live task → 409 busy', async () => {
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'tk-busy');
    await t.deps.db.insert(tasks).values({ id: 'tk-busy-task', bookId: b.id, kind: 'chapter.extract', target: 'c00001', lane: 'side', state: 'blocked' });
    const res = await admin('POST', '/api/admin/books/tk-busy/takeover', body);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('busy');
  });

  it('6. failure injection: after the intent → a retry completes; after book.yaml → the boot migration leaves it alone and a retry completes without a second commit; a hand-edited flow: v3 file is still taken over', async () => {
    // 意图写下后崩溃
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-f1', { chapters: 3 });
    await expect(takeOverBook(t.deps, await rowOf('tk-f1'), { ...body, start: false }, { failAfter: 'intent' })).rejects.toThrow(/after intent/);
    let row = await rowOf('tk-f1');
    expect(isV3Meta(row.meta)).toBe(false);
    expect((row.meta as { takeoverIntent?: { from: number } }).takeoverIntent).toMatchObject({ from: 4 });
    expect(await takeoverCommits('tk-f1')).toBe(0);
    expect((await admin('POST', '/api/admin/books/tk-f1/takeover', { ...body, start: false })).statusCode).toBe(200);
    row = await rowOf('tk-f1');
    expect(readV3Meta(row.meta).takeover).toMatchObject({ from: 4, status: 'pending' });
    expect('takeoverIntent' in (row.meta as object)).toBe(false);
    expect(await takeoverCommits('tk-f1')).toBe(1);

    // book.yaml 提交后崩溃：开机迁移不动它（不补 meta.v3，仍是旧书），再 POST 一次做完，不再提交 book.yaml
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-f2', { chapters: 3 });
    await expect(takeOverBook(t.deps, await rowOf('tk-f2'), { ...body, start: false }, { failAfter: 'file' })).rejects.toThrow(/after book.yaml/);
    expect((await yamlOf('tk-f2')).flow).toBe('v3');
    expect(await takeoverCommits('tk-f2')).toBe(1);
    const report = await runBootMigrations(t.deps);
    expect(report.books.interruptedTakeover).toContain('tk-f2');
    row = await rowOf('tk-f2');
    expect(isV3Meta(row.meta)).toBe(false);
    expect((row.meta as { takeoverIntent?: unknown }).takeoverIntent).toBeDefined();
    expect((await admin('POST', '/api/admin/books/tk-f2/takeover', { ...body, start: false })).statusCode).toBe(200);
    expect(await takeoverCommits('tk-f2')).toBe(1);
    expect(readV3Meta((await rowOf('tk-f2')).meta).takeover?.status).toBe('pending');

    // book.yaml 被手改成 flow: v3、有章节、没有意图：仍是旧书，可以接手
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-hand', { chapters: 3, bookYamlExtra: 'flow: v3\n' });
    expect((await admin('POST', '/api/admin/books/tk-hand/takeover', { ...body, start: false })).statusCode).toBe(200);
    expect(isV3Meta((await rowOf('tk-hand')).meta)).toBe(true);
  });

  it('7. two concurrent POSTs → exactly one book.yaml commit and one meta write; the other gets 200 or 409 not_legacy', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-race', { chapters: 4 });
    const [a, b] = await Promise.all([admin('POST', '/api/admin/books/tk-race/takeover', { ...body, start: false }), admin('POST', '/api/admin/books/tk-race/takeover', { ...body, start: false })]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([200, 409]).toContain(codes[1]);
    for (const r of [a, b]) if (r.statusCode === 409) expect(r.json().code).toBe('not_legacy');
    expect(await takeoverCommits('tk-race')).toBe(1);
    expect(readV3Meta((await rowOf('tk-race')).meta).batchLog).toHaveLength(1);
  });

  it('8. after takeover: the book page keeps the adopt entry (no backfill from the legacy history); no rewind point before the takeover; rewind / rewrite_from below it → 409 before_takeover', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-rw', { chapters: 6, published: 0 });
    expect((await admin('POST', '/api/admin/books/tk-rw/takeover', { ...body, start: false })).statusCode).toBe(200);
    const v = (await admin('GET', '/api/admin/books/tk-rw/v3')).json() as V3BookView;
    expect(v.batches.map((x) => [x.kind, x.from, x.to])).toEqual([['adopt', 1, 6]]);
    expect(v.rewindPoints.every((p) => p.to >= 6)).toBe(true);
    expect(v.rewindPoints.some((p) => p.to === 0)).toBe(false);
    const rw = await admin('POST', '/api/admin/books/tk-rw/actions', { action: 'rewind', to: 3 });
    expect(rw.statusCode).toBe(409);
    expect(rw.json().code).toBe('before_takeover');
    const rf = await admin('POST', '/api/admin/books/tk-rw/chapters/4/actions', { action: 'rewrite_from' });
    expect(rf.statusCode).toBe(409);
    expect(rf.json().code).toBe('before_takeover');
    const v3rw = await admin('POST', '/api/admin/books/tk-rw/v3/rewind', { to: 0 });
    expect(v3rw.statusCode).toBe(409);
    expect((await rowOf('tk-rw')).acceptedThrough).toBe(6);
    // 带意见重写旧章照样可以（并入下一批）
    expect((await admin('POST', '/api/admin/books/tk-rw/chapters/4/actions', { action: 'rewrite', note: '这一章的对话太硬' })).statusCode).toBe(200);
  });

  it('9. nothing takes a legacy book over on its own: boot migration and scheduler ticks leave it legacy', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-auto', { chapters: 5, status: 'active', pausedReason: null, bookYamlExtra: 'flow: v3\n' });
    const report = await runBootMigrations(t.deps);
    expect(report.books.flowMismatch).toContain('tk-auto');
    const sched = createScheduler({ db: t.deps.db, config: t.deps.config, paths: t.deps.paths, log: t.deps.log, bus: t.deps.bus, secrets: t.deps.secrets, owner: `${os.hostname()}:${process.pid}` });
    await sched.tick();
    await sched.tick();
    await sched.stop();
    const row = await rowOf('tk-auto');
    expect(isV3Meta(row.meta)).toBe(false);
    expect(await t.deps.db.select().from(tasks).where(eq(tasks.bookId, row.id))).toEqual([]);
  });

  it('10. GET defaults: chapters and characters so far, a length suggestion, the AGENTS.md size', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-defaults', { chapters: 8 });
    const row = await rowOf('tk-defaults');
    const d = (await admin('GET', '/api/admin/books/tk-defaults/takeover')).json();
    expect(d).toMatchObject({ accepted: 8, totalCjk: row.totalCjk, batch: 5, min_chapter_cjk: 3000, agentsOver: false });
    // 已写的字数很少：短篇就够（目标 15000 > 已写）
    expect(d.length).toBe('short');
    expect(d.target_cjk).toBeGreaterThanOrEqual(15_000);
    expect(d.agentsBytes).toBeGreaterThan(0);
    expect(d).toMatchObject({ closingBatches: CLOSING_BATCHES, gap: null, planned: takeoverPlanned({ accepted: 8, totalCjk: row.totalCjk, target_cjk: d.target_cjk, batch: 5, min_chapter_cjk: 3000, length: d.length }, CLOSING_BATCHES) });
  });

  it('11. default values never put the first batch into the closing phase (200 chapters / 600k characters): the first two batches are normal', async () => {
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'tk-big-book', { chapters: 3 });
    // 统计上是 200 章、60 万字的书（正文文件只放了 3 章：只看数字）
    await t.deps.db.update(books).set({ acceptedThrough: 200, totalCjk: 600_000 }).where(eq(books.id, b.id));
    const d = (await admin('GET', '/api/admin/books/tk-big-book/takeover')).json();
    expect(d.length).toBe('epic');
    const planned = takeoverPlanned({ accepted: 200, totalCjk: 600_000, target_cjk: d.target_cjk, batch: d.batch, min_chapter_cjk: d.min_chapter_cjk, length: d.length }, CLOSING_BATCHES);
    expect(d.planned).toBe(planned);
    for (const accepted of [200, 200 + d.batch]) {
      const e = endingPhase({ length: d.length, accepted, planned, runawayBase: planned, batch: d.batch, factor: 0, runawayBatches: 0 });
      expect(e, String(accepted)).toMatchObject({ mode: 'write', phase: 'normal' });
    }
    // 主人手动填的目标比已写的还少：计划章数仍然至少多出 CLOSING_BATCHES + 2 批
    const low = takeoverPlanned({ accepted: 200, totalCjk: 600_000, target_cjk: 610_000, batch: 5, min_chapter_cjk: 3000, length: 'epic' }, CLOSING_BATCHES);
    expect(low).toBe(225);
    expect(endingPhase({ length: 'epic', accepted: 200, planned: low, runawayBase: low, batch: 5, factor: 0, runawayBatches: 0 })).toMatchObject({ mode: 'write', phase: 'normal' });
  });

  it('12. the takeover clears the stale v2 sticky writer (books.writer_profile): the post-recovery migration never pins it into book.yaml', async () => {
    await saveSlots(t.deps.db, { writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-flash-check', fallback: null } });
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'tk-sticky', { chapters: 3 });
    await t.deps.db.update(books).set({ writerProfile: 'cc-opus' }).where(eq(books.id, b.id));
    await runPostRecoveryMigrations(t.deps);
    expect((await admin('POST', '/api/admin/books/tk-sticky/takeover', { ...body, start: false })).statusCode).toBe(200);
    expect((await rowOf('tk-sticky')).writerProfile).toBeNull();
    const head = await repoOf('tk-sticky').head();
    await runPostRecoveryMigrations(t.deps);
    expect(await repoOf('tk-sticky').head()).toBe(head);
    expect((await yamlOf('tk-sticky')).routing).toBeUndefined();
    expect((await repoOf('tk-sticky').log({ limit: 20 })).items.some((c) => c.trailers['Novelist-Migration'] === WRITER_OVERRIDE_TRAILER)).toBe(false);
  });

  it('13. an interrupted takeover (book.yaml already flow: v3, no meta.v3): editing a chapter or notes/from-owner.md keeps it legacy; a retry still completes with the takeover marker and the adopt entry', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-edit', { chapters: 4 });
    await expect(takeOverBook(t.deps, await rowOf('tk-edit'), { ...body, start: false }, { failAfter: 'file' })).rejects.toThrow(/after book.yaml/);
    expect((await yamlOf('tk-edit')).flow).toBe('v3');
    await saveChapterText(t.deps, await rowOf('tk-edit'), 2, '第2章 旧事\n\n主人改过的正文。\n', null, true);
    const notes = await saveRepoFile(t.deps, await rowOf('tk-edit'), { path: 'notes/from-owner.md', content: '慢慢写。\n', baseSha: null, confirm: true });
    expect(notes.kind).toBe('saved');
    let row = await rowOf('tk-edit');
    expect(isV3Meta(row.meta)).toBe(false);
    expect((row.meta as { takeoverIntent?: unknown }).takeoverIntent).toBeDefined();
    const res = await admin('POST', '/api/admin/books/tk-edit/takeover', { ...body, start: false });
    expect(res.statusCode, res.body).toBe(200);
    row = await rowOf('tk-edit');
    const meta = readV3Meta(row.meta);
    expect(meta.takeover).toMatchObject({ from: 5, status: 'pending' });
    expect(meta.batchLog.map((e) => [e.kind, e.from, e.to])).toEqual([['adopt', 1, 4]]);
    expect(meta.plannedFloor).toBeGreaterThan(4);
    expect(meta.locked).toEqual([]);
    // 接手之后再改正文：照常锁章
    await saveChapterText(t.deps, row, 2, '第2章 旧事\n\n接手后又改了一次。\n', null, true);
    expect(readV3Meta((await rowOf('tk-edit')).meta).locked).toEqual([2]);
  });

  it('14. a v1 import with a gap (chapter 3 missing, 4–5 accepted and published) → 409 chapter_gap, nothing written; the defaults report the gap', async () => {
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'tk-gap', { chapters: 5 });
    const repo = repoOf('tk-gap');
    await repo.writeFiles([{ path: 'manuscript/c00003.md', content: null }]);
    await repo.commit({ message: 'gap', trailers: {} });
    await t.deps.db.delete(chapters).where(and(eq(chapters.bookId, b.id), eq(chapters.no, 3)));
    await t.deps.db.update(books).set({ acceptedThrough: 2, headCommit: await repo.head() }).where(eq(books.id, b.id));
    const head = await repo.head();
    const res = await admin('POST', '/api/admin/books/tk-gap/takeover', body);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('chapter_gap');
    expect(await repo.head()).toBe(head);
    const row = await rowOf('tk-gap');
    expect(isV3Meta(row.meta)).toBe(false);
    expect('takeoverIntent' in (row.meta as object)).toBe(false);
    expect((await admin('GET', '/api/admin/books/tk-gap/takeover')).json().gap).toEqual({ missing: [3], extra: [4, 5] });
    // 把后面的章移走（这里直接删掉），就能接手
    await repo.writeFiles([4, 5].map((n) => ({ path: `manuscript/c0000${n}.md`, content: null })));
    await repo.commit({ message: 'move away', trailers: {} });
    await t.deps.db.delete(chapters).where(and(eq(chapters.bookId, b.id), gt(chapters.no, 2)));
    expect((await admin('POST', '/api/admin/books/tk-gap/takeover', { ...body, start: false })).statusCode).toBe(200);
  });

  it('15. a legacy book with no chapters: the takeover marker is pending (the first order is the takeover order, see takeover.flow.test)', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'tk-zero', { chapters: 0 });
    expect((await admin('POST', '/api/admin/books/tk-zero/takeover', { ...body, start: false })).statusCode).toBe(200);
    const meta = readV3Meta((await rowOf('tk-zero')).meta);
    expect(meta.takeover).toMatchObject({ from: 1, status: 'pending' });
    expect(meta.batchLog).toEqual([]);
  });
});
