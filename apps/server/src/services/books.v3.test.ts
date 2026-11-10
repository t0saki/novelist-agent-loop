/** v3 书的开书 / 索引 / 手改正文 / 回退拦截（p1-plan §3 WP-C、§6 books.v3）。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V3_TITLE_PLACEHOLDER } from '@novelist/shared';
import { parse as yamlParse } from 'yaml';
import { git } from '../book/git.js';
import { gitBlobSha, openRepo, P } from '../book/index.js';
import { bookEvents, books, chapters, tasks } from '../db/schema.js';
import { bookDir } from '../api/helpers.js';
import { commitOwnerEdit } from '../orchestrator/index.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';
import { nameAutoBooks } from './auto-start.js';
import { collectManuscripts, createBook, reindexBook } from './books.js';
import { estimateImpact, saveRepoFile } from './repo-files.js';

let t: TestApp;
let cookie: string;

const admin = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
const yamlOf = async (slug: string) => yamlParse((await openRepo(bookDir(t.deps, slug)).readFile(P.bookYaml))!);
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

/** 以主人身份往书库提交正文，再 reindex（acceptedThrough、章节行） */
async function addChapters(slug: string, texts: Record<number, string>): Promise<void> {
  const row = await rowOf(slug);
  const files = Object.entries(texts).map(([no, content]) => ({ path: P.manuscript(Number(no)), content }));
  await commitOwnerEdit(t.deps.db, openRepo(bookDir(t.deps, slug)), row.id, { files, message: 'test: chapters', baseSha: null });
  await reindexBook(t.deps, slug);
}

const PROSE = '雨落在青石板上，他推开门走进屋里。'.repeat(20);

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('createBook flow v3', () => {
  it('writes flow/v3/publish defaults, seed.md, .gitignore with AGENTS.md/CLAUDE.md/ORDER.md, no root AGENTS.md', async () => {
    const b = await createBook(t.deps, { title: '雨夜', slug: 'v3-a', genre: 'xianxia', seed: '一个关于雨夜的故事。\n', flow: 'v3', start: false });
    expect(b.title).toBe('雨夜');
    const dir = bookDir(t.deps, 'v3-a');
    const y = await yamlOf('v3-a');
    expect(y.flow).toBe('v3');
    expect(y.v3).toEqual({ length: 'medium', target_cjk: 60_000, planned_chapters: 15, planned_chapters_initial: 15, batch: 5, min_chapter_cjk: 3000, auto_title: false });
    expect(y.publish).toMatchObject({ mode: 'scheduled', cadence: '0 8 * * *', timezone: 'Asia/Shanghai', per_slot: 2, lag: 0, min_lag: 0, require_audited: false, max_buffer: 15, resume_buffer: 10 });
    expect(await fs.readFile(path.join(dir, 'seed.md'), 'utf8')).toBe('一个关于雨夜的故事。\n');
    const ignore = (await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).split('\n');
    for (const f of ['/AGENTS.md', '/CLAUDE.md', '/ORDER.md', 'work/']) expect(ignore).toContain(f);
    // 根目录的 AGENTS.md 不入库，instructions/AGENTS.md 照常入库
    const tracked = (await git(dir, ['ls-files'])).split('\n').filter(Boolean).sort();
    expect(tracked).toEqual(['.gitignore', 'book.yaml', 'instructions/AGENTS.md', 'seed.md']);
    for (const p of ['AGENTS.md', '.claude', '.agents', 'state/overrides.jsonl', 'bible/premise.md']) expect(await exists(path.join(dir, p)), p).toBe(false);
    for (const d of ['manuscript', 'notes', 'drafts']) expect((await fs.stat(path.join(dir, d))).isDirectory()).toBe(true);
    const log = await openRepo(dir).log({ limit: 1 });
    expect(log.items[0]?.trailers['Novelist-Task']).toBe('book.init');
    const row = await rowOf('v3-a');
    expect(row.tier).toBe('lite');
    expect(row.status).toBe('draft');
    expect((row.meta as { v3: unknown }).v3).toEqual({ hints: [], noChapterStreak: 0, emptyStreak: 0, finaleNoMarker: 0, lastBatchFrom: null, lastBatchAt: null, hintedShort: [], locked: [], pending: null });
    const ev = await t.deps.db.select().from(bookEvents).where(and(eq(bookEvents.bookId, row.id), eq(bookEvents.kind, 'book.created')));
    expect((ev[0]?.body as { flow?: string }).flow).toBe('v3');
  });

  it('length / batch / target from the request; buffer = max(15, 2×batch)', async () => {
    await createBook(t.deps, { title: '短篇', slug: 'v3-short', genre: 'xianxia', flow: 'v3', v3: { length: 'short', batch: 8, min_chapter_cjk: 2500 }, start: false });
    const y = await yamlOf('v3-short');
    expect(y.v3).toMatchObject({ length: 'short', target_cjk: 15_000, planned_chapters: 4, batch: 8, min_chapter_cjk: 2500 });
    expect(y.publish).toMatchObject({ max_buffer: 16, resume_buffer: 11 });
    await createBook(t.deps, { title: '长', slug: 'v3-target', genre: 'xianxia', flow: 'v3', v3: { length: 'long', target_cjk: 41_000 }, start: false });
    expect((await yamlOf('v3-target')).v3).toMatchObject({ length: 'long', target_cjk: 41_000, planned_chapters: 11, planned_chapters_initial: 11 });
  });

  it("empty title → '未命名·' placeholder + auto_title", async () => {
    const b = await createBook(t.deps, { title: '  ', genre: 'xianxia', flow: 'v3', start: false });
    expect(b.title.startsWith(V3_TITLE_PLACEHOLDER)).toBe(true);
    expect(b.title.length).toBe(V3_TITLE_PLACEHOLDER.length + 6);
    expect(b.slug).toMatch(/^book-[a-z0-9]{8}$/);
    const y = await yamlOf(b.slug);
    expect(y.title).toBe(b.title);
    expect(y.v3.auto_title).toBe(true);
  });

  it('nameAutoBooks ignores v3 placeholder books', async () => {
    const b = await createBook(t.deps, { title: '', genre: 'xianxia', flow: 'v3', start: false });
    const row = await rowOf(b.slug);
    // 即使书库里有一个看起来像书名的 premise，nameAutoBooks 也不碰 v3 的占位书名
    await commitOwnerEdit(t.deps.db, openRepo(bookDir(t.deps, b.slug)), row.id, { files: [{ path: P.premise, content: '# 《雪夜》\n' }], message: 'test', baseSha: null });
    await nameAutoBooks(t.deps);
    expect((await rowOf(b.slug)).title).toBe(b.title);
  });

  it('empty title rejected for v2', async () => {
    const res = await admin('POST', '/api/admin/books', { title: '', genre: 'xianxia', start: false });
    expect(res.statusCode).toBe(400);
    await expect(createBook(t.deps, { title: '', genre: 'xianxia', start: false })).rejects.toThrow('书名不能为空');
    // 旧流程和原来一样只要求非空串：空白书名照收（slug 走原来的 slugifyName，不是 v3 的随机 slug）
    const blank = await createBook(t.deps, { title: ' ', genre: 'xianxia', start: false });
    expect(blank.slug.startsWith('book-')).toBe(false);
    // 不带 flow 的书：book.yaml 没有 flow 键（= v2）
    await createBook(t.deps, { title: '旧流程', slug: 'v2-a', genre: 'xianxia', start: false });
    const y = await yamlOf('v2-a');
    expect(y.flow).toBeUndefined();
    expect(y.v3).toBeUndefined();
    expect(await exists(path.join(bookDir(t.deps, 'v2-a'), 'AGENTS.md'))).toBe(true);
  });

  it('start enqueues book.open', async () => {
    const b = await createBook(t.deps, { title: '开', slug: 'v3-start', genre: 'xianxia', flow: 'v3', start: true });
    const row = await rowOf(b.slug);
    expect(row.status).toBe('planning');
    const ts = await t.deps.db.select().from(tasks).where(eq(tasks.bookId, row.id));
    expect(ts.map((x) => x.kind)).toEqual(['book.open']);
  });
});

describe('v3 index and manuscripts', () => {
  it('reindex v3 takes titles from headings, never fabricates', async () => {
    await createBook(t.deps, { title: '索引', slug: 'v3-idx', genre: 'xianxia', flow: 'v3', start: false });
    const row = await rowOf('v3-idx');
    // 第 3 章已有库里的标题；正文没有标题行时保留它
    await t.deps.db.insert(chapters).values({ bookId: row.id, no: 3, chapterId: 'c00003', title: '旧名', state: 'accepted' });
    await addChapters('v3-idx', { 1: `# 第一章 雨夜\n\n${PROSE}\n`, 2: `${PROSE}\n`, 3: `\n${PROSE}\n`, 4: `# 第4章：归途\n\n${PROSE}\n` });
    const rows = await t.deps.db.select().from(chapters).where(eq(chapters.bookId, row.id)).orderBy(chapters.no);
    expect(rows.map((r) => r.title)).toEqual(['雨夜', '', '旧名', '归途']);
    expect(rows.every((r) => r.volume === '' && r.arc === '' && r.state === 'accepted')).toBe(true);
    expect((await rowOf('v3-idx')).acceptedThrough).toBe(4);
  });

  it('collectManuscripts stripTitle', async () => {
    const repo = openRepo(bookDir(t.deps, 'v3-idx'));
    const plain = await collectManuscripts(repo, [1, 2]);
    expect(plain.get(1)?.startsWith('# 第一章 雨夜\n')).toBe(true);
    const stripped = await collectManuscripts(repo, [1, 2], { stripTitle: true });
    expect(stripped.get(1)).toBe(`${PROSE}\n`);
    // 没有标题行的章节原样返回
    expect(stripped.get(2)).toBe(`${PROSE}\n`);
  });

  it('saveChapterText on an accepted v3 chapter → 200, no reextract task, chapter in meta.v3.locked', async () => {
    const repo = openRepo(bookDir(t.deps, 'v3-idx'));
    const before = (await repo.readFile(P.manuscript(1)))!;
    const res = await admin('PUT', '/api/admin/books/v3-idx/chapters/1/text', { text: `# 第一章 雨夜\n\n${PROSE}主人加了一句。\n`, baseSha: gitBlobSha(before) });
    expect(res.statusCode).toBe(200);
    expect(await repo.readFile(P.manuscript(1))).toContain('主人加了一句');
    const row = await rowOf('v3-idx');
    expect((row.meta as { v3: { locked: number[] } }).v3.locked).toEqual([1]);
    const ts = await t.deps.db.select().from(tasks).where(eq(tasks.bookId, row.id));
    expect(ts.filter((x) => x.kind === 'chapter.reextract')).toHaveLength(0);
    // 再改一次：不重复加锁
    const again = await admin('PUT', '/api/admin/books/v3-idx/chapters/1/text', { text: `# 第一章 雨夜\n\n${PROSE}\n`, baseSha: gitBlobSha((await repo.readFile(P.manuscript(1)))!) });
    expect(again.statusCode).toBe(200);
    // 走通用的文件保存（saveRepoFile）改已验收章节也加锁
    await saveRepoFile(t.deps, await rowOf('v3-idx'), { path: P.manuscript(2), content: `${PROSE}改。\n`, baseSha: null, confirm: false });
    expect(((await rowOf('v3-idx')).meta as { v3: { locked: number[] } }).v3.locked).toEqual([1, 2]);
  });

  it('owner edit of a v3 chapter heading updates the chapter title the reader shows', async () => {
    const repo = openRepo(bookDir(t.deps, 'v3-idx'));
    const cur = (await repo.readFile(P.manuscript(1)))!;
    const res = await admin('PUT', '/api/admin/books/v3-idx/chapters/1/text', { text: `# 第1章 夜雨归人\n\n${PROSE}\n`, baseSha: gitBlobSha(cur) });
    expect(res.statusCode).toBe(200);
    const row = await rowOf('v3-idx');
    const ch = (await t.deps.db.select().from(chapters).where(and(eq(chapters.bookId, row.id), eq(chapters.no, 1))))[0];
    expect(ch?.title).toBe('夜雨归人');
  });

  it('v3 publish settings: max_buffer below 2 × batch is rejected on both save paths; v2 books unchanged', async () => {
    await createBook(t.deps, { title: '存稿', slug: 'v3-buf', genre: 'xianxia', flow: 'v3', v3: { batch: 5 }, start: false });
    const low = await admin('PUT', '/api/admin/books/v3-buf/publish', { max_buffer: 9, resume_buffer: 4 });
    expect(low.statusCode).toBe(400);
    expect(low.json().code).toBe('invalid_publish');
    expect((await admin('PUT', '/api/admin/books/v3-buf/publish', { max_buffer: 10, resume_buffer: 5 })).statusCode).toBe(200);
    // 直接改 book.yaml 把每批章数调大
    const doc = await admin('GET', '/api/admin/books/v3-buf/config');
    const raw = (doc.json() as { raw: string; sha: string }).raw.replace(/batch: 5/, 'batch: 8');
    const put = await admin('PUT', '/api/admin/books/v3-buf/config', { raw, baseSha: (doc.json() as { sha: string }).sha });
    expect(put.statusCode).toBe(400);
    expect(put.json().code).toBe('invalid_publish');
    // 旧流程的书：同样的存稿上限照收
    await createBook(t.deps, { title: '旧存稿', slug: 'v2-buf', genre: 'xianxia', start: false });
    const v2 = await admin('PUT', '/api/admin/books/v2-buf/publish', { max_buffer: 4, resume_buffer: 2, mode: 'immediate' });
    expect(v2.statusCode).toBe(200);
  });

  it('estimateImpact for v3 has no ledger cascade note', async () => {
    const impact = await estimateImpact(t.deps, await rowOf('v3-idx'), openRepo(bookDir(t.deps, 'v3-idx')), P.manuscript(2));
    expect(impact.affectedChapters).toBeNull();
    expect(impact.affectedDeltas).toBe(0);
    expect(impact.estimatedRuns).toBe(0);
    expect(impact.needsConfirm).toBe(false);
    expect(impact.notes.some((n) => n.includes('账本'))).toBe(false);
    // v2 书仍然有级联说明
    await addChapters('v2-a', { 1: `# 第一章\n\n${PROSE}\n` });
    const v2 = await estimateImpact(t.deps, await rowOf('v2-a'), openRepo(bookDir(t.deps, 'v2-a')), P.manuscript(1));
    expect(v2.affectedChapters).toEqual([1, 1]);
    expect(v2.notes.some((n) => n.includes('账本'))).toBe(true);
  });

  it('rewind / chapter rewrite on v3 → 409 v3_unsupported', async () => {
    const rewind = await admin('POST', '/api/admin/books/v3-idx/actions', { action: 'rewind', to: 0, confirm: true });
    expect(rewind.statusCode).toBe(409);
    expect(rewind.json().code).toBe('v3_unsupported');
    for (const action of ['rewrite', 'repair', 'reextract']) {
      const res = await admin('POST', '/api/admin/books/v3-idx/chapters/1/actions', { action, confirm: true });
      expect(res.statusCode, action).toBe(409);
      expect(res.json().code, action).toBe('v3_unsupported');
    }
  });
});
