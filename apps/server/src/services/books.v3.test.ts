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
    // effort 来自全站默认值（settings.v3.effortDefaults，初始值与以前的 book.yaml 缺省一样，closing = finale = high）
    expect(y.v3).toEqual({ length: 'medium', target_cjk: 60_000, planned_chapters: 15, planned_chapters_initial: 15, batch: 5, min_chapter_cjk: 3000, auto_title: false, effort: { open: 'medium', write: 'medium', closing: 'high', finale: 'high', retro: 'medium' } });
    // 档位已删除：book.yaml 不再写 tier（P3 D5）
    expect(y.tier).toBeUndefined();
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


  it('every new book is v3: a request without flow, with flow v2 or with a tier still makes a v3 book; an empty title is fine', async () => {
    const res = await admin('POST', '/api/admin/books', { title: '', genre: 'xianxia', start: false });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ flow: 'v3', legacy: false });
    expect(res.json().title.startsWith(V3_TITLE_PLACEHOLDER)).toBe(true);
    // 空白书名：和 v3 的空书名一样走随机 slug
    const blank = await createBook(t.deps, { title: ' ', genre: 'xianxia', start: false });
    expect(blank.slug.startsWith('book-')).toBe(true);
    // 不带 flow 的请求：book.yaml 也是 v3，仓库是 v3 布局（根 AGENTS.md 不入库）
    await createBook(t.deps, { title: '旧请求', slug: 'v2-a', genre: 'xianxia', start: false });
    const y = await yamlOf('v2-a');
    expect(y.flow).toBe('v3');
    expect(y.v3).toBeDefined();
    expect((await rowOf('v2-a')).meta).toMatchObject({ v3: expect.any(Object) });
    expect(await exists(path.join(bookDir(t.deps, 'v2-a'), 'AGENTS.md'))).toBe(false);
    // 旧客户端发 flow: 'v2' 和 tier：照样是 v3，tier 不写；P2 形状的缺省值（中篇、种子为空）保留
    const old = await admin('POST', '/api/admin/books', { title: '旧客户端', slug: 'v2-old-client', genre: 'xianxia', flow: 'v2', tier: 'standard', interview: true, start: false });
    expect(old.statusCode).toBe(201);
    const yo = await yamlOf('v2-old-client');
    expect(yo).toMatchObject({ flow: 'v3', v3: { length: 'medium' } });
    expect(yo.tier).toBeUndefined();
    expect(await fs.readFile(path.join(bookDir(t.deps, 'v2-old-client'), 'seed.md'), 'utf8')).toBe('');
    // P2 的嵌套 v3 形状再收一个版本
    const nested = await admin('POST', '/api/admin/books', { title: '嵌套', slug: 'v3-nested', genre: 'xianxia', flow: 'v3', v3: { length: 'long', batch: 4 }, start: false });
    expect(nested.statusCode).toBe(201);
    expect((await yamlOf('v3-nested')).v3).toMatchObject({ length: 'long', batch: 4 });
  });

  it('the new form: genre, length, a one-line idea; the server builds the seed from the pack plus the idea', async () => {
    const res = await admin('POST', '/api/admin/books', { genre: 'xianxia', length: 'long', idea: '一个灯塔看守人发现海底有一座城', target_cjk: 90_000, batch: 4, min_chapter_cjk: 2800, start: false });
    expect(res.statusCode, res.body).toBe(201);
    const slug = res.json().slug as string;
    expect((await yamlOf(slug)).v3).toMatchObject({ length: 'long', target_cjk: 90_000, batch: 4, min_chapter_cjk: 2800, auto_title: true });
    const seed = await fs.readFile(path.join(bookDir(t.deps, slug), 'seed.md'), 'utf8');
    expect(seed).toContain('题材：');
    expect(seed).toContain('主人的想法：一个灯塔看守人发现海底有一座城');
    // 给了完整的种子就原样用
    const own = await admin('POST', '/api/admin/books', { genre: 'xianxia', length: 'short', seed: '我自己的完整种子。', idea: '不会用到', start: false });
    expect(await fs.readFile(path.join(bookDir(t.deps, own.json().slug), 'seed.md'), 'utf8')).toBe('我自己的完整种子。');
    // 想法最多 300 字；题材不存在 → 400
    expect((await admin('POST', '/api/admin/books', { genre: 'xianxia', idea: '长'.repeat(301), start: false })).statusCode).toBe(400);
    const unknown = await admin('POST', '/api/admin/books', { genre: 'no-such', start: false });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe('unknown_genre');
  });

  it('genre random picks a visible pack; length random follows the length mix', async () => {
    const packs = (await admin('GET', '/api/admin/genres')).json() as { id: string }[];
    // 只留一个可见的包：随机一定选它
    for (const p of packs) if (p.id !== 'urban') await admin('POST', `/api/admin/genres/${p.id}/visibility`, { hidden: true });
    try {
      const res = await admin('POST', '/api/admin/books', { genre: 'random', length: 'random', start: false });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().genre).toBe('urban');
      // 没有自动开过的书时，分布里占比最大的一档（短篇 40%）缺口最大
      expect((await yamlOf(res.json().slug)).v3.length).toBe('short');
    } finally {
      for (const p of packs) await admin('POST', `/api/admin/genres/${p.id}/visibility`, { hidden: false });
    }
  });

  it('new books take the effort table and the publish defaults from the system settings', async () => {
    const cur = (await admin('GET', '/api/admin/settings')).json();
    const put = await admin('PUT', '/api/admin/settings', { baseUpdatedAt: cur.updatedAt, v3: { effortDefaults: { write: 'high', closing: 'medium' }, publishDefaults: { per_slot: 3, cadence: '0 9 * * *', max_buffer: 20 } } });
    expect(put.statusCode, put.body).toBe(200);
    try {
      await createBook(t.deps, { title: '默认值', slug: 'v3-defaults', genre: 'xianxia', length: 'medium', start: false });
      const y = await yamlOf('v3-defaults');
      expect(y.v3.effort).toEqual({ open: 'medium', write: 'high', closing: 'medium', finale: 'high', retro: 'medium' });
      expect(y.publish).toMatchObject({ mode: 'scheduled', cadence: '0 9 * * *', per_slot: 3, max_buffer: 20, resume_buffer: 15, lag: 0, require_audited: false });
    } finally {
      await admin('PUT', '/api/admin/settings', { v3: { effortDefaults: { write: 'medium', closing: 'high' }, publishDefaults: { per_slot: 2, cadence: '0 8 * * *', max_buffer: 15 } } });
    }
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

  it('v3 publish settings: max_buffer below 2 × batch is rejected on both save paths (book page settings, raw book.yaml)', async () => {
    await createBook(t.deps, { title: '存稿', slug: 'v3-buf', genre: 'xianxia', length: 'medium', batch: 5, start: false });
    const s = (await admin('GET', '/api/admin/books/v3-buf/v3')).json().settings;
    const low = await admin('PUT', '/api/admin/books/v3-buf/v3/settings', { ...s, publish: { ...s.publish, max_buffer: 9 } });
    expect(low.statusCode).toBe(400);
    expect(low.json().code).toBe('invalid_publish');
    expect((await admin('PUT', '/api/admin/books/v3-buf/v3/settings', { ...s, publish: { ...s.publish, max_buffer: 10 } })).statusCode).toBe(200);
    // 直接改 book.yaml 把每批章数调大
    const doc = (await admin('GET', '/api/admin/books/v3-buf/file?path=book.yaml')).json() as { content: string; sha: string };
    const put = await admin('PUT', '/api/admin/books/v3-buf/file', { path: 'book.yaml', content: doc.content.replace(/batch: 5/, 'batch: 8'), baseSha: doc.sha });
    expect(put.statusCode).toBe(400);
    expect(put.json().code).toBe('invalid_publish');
  });

  it('estimateImpact has no ledger cascade note (v3 and every other book)', async () => {
    const impact = await estimateImpact(t.deps, await rowOf('v3-idx'), openRepo(bookDir(t.deps, 'v3-idx')), P.manuscript(2));
    expect(impact.affectedChapters).toBeNull();
    expect(impact.affectedDeltas).toBe(0);
    expect(impact.estimatedRuns).toBe(0);
    expect(impact.needsConfirm).toBe(false);
    expect(impact.notes.some((n) => n.includes('账本'))).toBe(false);
    // 账本已删除：哪本书都没有级联说明
    await addChapters('v2-a', { 1: `# 第一章\n\n${PROSE}\n` });
    const other = await estimateImpact(t.deps, await rowOf('v2-a'), openRepo(bookDir(t.deps, 'v2-a')), P.manuscript(1));
    expect(other.affectedChapters).toBeNull();
    expect(other.notes.some((n) => n.includes('账本'))).toBe(false);
  });

  it('v3 chapter actions: rewrite needs a note and records a waiting request; repair/reextract are gone (400); rewind to 0 succeeds', async () => {
    const bare = await admin('POST', '/api/admin/books/v3-idx/chapters/1/actions', { action: 'rewrite', confirm: true });
    expect(bare.statusCode).toBe(400);
    const withNote = await admin('POST', '/api/admin/books/v3-idx/chapters/1/actions', { action: 'rewrite', note: '开头太慢' });
    expect(withNote.statusCode).toBe(200);
    const m = (await rowOf('v3-idx')).meta as { v3: { ownerRequests: { chapter: number; note: string; status: string }[]; locked: number[] } };
    expect(m.v3.ownerRequests).toMatchObject([{ chapter: 1, note: '开头太慢', status: 'waiting' }]);
    // 主人要求改写的章解锁
    expect(m.v3.locked).not.toContain(1);
    for (const action of ['repair', 'reextract']) {
      const res = await admin('POST', '/api/admin/books/v3-idx/chapters/1/actions', { action });
      expect(res.statusCode, action).toBe(400);
    }
    const rewind = await admin('POST', '/api/admin/books/v3-idx/actions', { action: 'rewind', to: 0, confirm: true });
    expect(rewind.statusCode).toBe(200);
    const row = await rowOf('v3-idx');
    expect(row.acceptedThrough).toBe(0);
    const repo = openRepo(bookDir(t.deps, 'v3-idx'));
    expect(await repo.exists(P.manuscript(1))).toBe(false);
    expect((await repo.list('drafts', { recursive: true })).filter((p) => /^drafts\/rewound-[^/]+\/c00001\.md$/.test(p))).toHaveLength(1);
    // 被回退掉的章的请求作废
    expect((row.meta as { v3: { ownerRequests: { status: string }[] } }).v3.ownerRequests[0]?.status).toBe('dropped');
  });
});
