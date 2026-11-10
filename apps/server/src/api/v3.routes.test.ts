/** /api/admin/books/:slug/v3/* 与 v3 书的章节操作（p2-plan §2.8、§6 api/v3.routes.test）。 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepo, P } from '../book/index.js';
import { books } from '../db/schema.js';
import { readV3Meta } from '../flow/state.js';
import { chapterText } from '../flow/testing.js';
import { commitOwnerEdit } from '../orchestrator/index.js';
import { createBook, reindexBook } from '../services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';
import { createLegacyBook } from '../book/testing-legacy.js';
import { bookDir } from './helpers.js';

let t: TestApp;
let cookie: string;

const admin = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const anon = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;

async function v3Book(slug: string, n: number, files: Record<string, string> = {}): Promise<void> {
  await createBook(t.deps, { title: slug, slug, genre: 'xianxia', flow: 'v3', start: false });
  const row = await rowOf(slug);
  const all = [...Array.from({ length: n }, (_, i) => ({ path: P.manuscript(i + 1), content: chapterText(i + 1, 1500) })), ...Object.entries(files).map(([path, content]) => ({ path, content }))];
  await commitOwnerEdit(t.deps.db, openRepo(bookDir(t.deps, slug)), row.id, { files: all, message: 'test: fixture', baseSha: null });
  await reindexBook(t.deps, slug);
  await t.deps.db.update(books).set({ status: 'active' }).where(eq(books.id, row.id));
}

const ROUTES: [method: 'PUT' | 'POST', url: string, body: unknown][] = [
  ['PUT', 'v3/message', { text: '多写对话。' }],
  ['POST', 'v3/drafts/adopt', { path: 'drafts/c00002.rewrite.md' }],
  ['POST', 'v3/drafts/discard', { path: 'drafts/scratch.md' }],
  ['POST', 'v3/pending', { action: 'discard' }],
  ['POST', 'v3/rewind', { to: 0, note: '从头来' }],
];

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  await v3Book('rt', 3, { 'drafts/c00002.rewrite.md': `# 第2章 新\n\n${chapterText(2, 1600, '', 77).replace(/^# [^\n]*\n+/, '')}`, 'drafts/scratch.md': '随手记\n' });
  await createLegacyBook(t.deps.db, t.deps.paths, 'rt-v2', { title: '旧流程' });
  // 收稿失败待处理（重试）
  const row = await rowOf('rt');
  const pending = { taskId: 'x', runId: 'run-p', attempt: 1, stage: 'harvested', runDir: '/r', inDir: '/r/in', snapshotDir: '/r/b', baseCommit: '', manifestFile: null, trailerKey: 'x@run-p', route: { profile: 'p', account: null, harness: 'fake', model: null, isolation: 'none', stackHash: 'h' }, failures: 3, createdAt: '2026-11-10T00:00:00.000Z' };
  await t.deps.db.update(books).set({ meta: { ...(row.meta as object), v3: { ...readV3Meta(row.meta), pending } } }).where(eq(books.id, row.id));
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('v3 routes', () => {
  it('admin guard: 401 without a session', async () => {
    for (const [method, url, body] of ROUTES) expect((await anon(method, `/api/admin/books/rt/${url}`, body)).statusCode, url).toBe(401);
  });

  it('409 not_v3 for a legacy book', async () => {
    for (const [method, url, body] of ROUTES) {
      const res = await admin(method, `/api/admin/books/rt-v2/${url}`, body);
      expect(res.statusCode, url).toBe(409);
      expect(res.json().code, url).toBe('not_v3');
    }
  });

  it('200 for a v3 book, each with a detail sentence', async () => {
    const retry = await admin('POST', '/api/admin/books/rt/v3/pending', { action: 'retry' });
    expect(retry.json()).toEqual({ ok: true, detail: '已重试收稿' });
    expect(readV3Meta((await rowOf('rt')).meta).pending?.failures).toBe(0);
    for (const [method, url, body] of ROUTES) {
      const res = await admin(method, `/api/admin/books/rt/${url}`, body);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, detail: expect.any(String) });
    }
    const row = await rowOf('rt');
    const m = readV3Meta(row.meta);
    expect(row.acceptedThrough).toBe(0);
    expect(m.pending).toBeNull();
    expect((await admin('POST', '/api/admin/books/rt/v3/pending', { action: 'retry' })).json().code).toBe('nothing_pending');
    expect(m.hints.map((h) => h.text)).toContain('主人的意见：从头来');
  });

  it('validation: bad bodies → 400', async () => {
    expect((await admin('POST', '/api/admin/books/rt/v3/rewind', { to: -1 })).statusCode).toBe(400);
    expect((await admin('POST', '/api/admin/books/rt/v3/pending', { action: 'nope' })).statusCode).toBe(400);
    expect((await admin('PUT', '/api/admin/books/rt/v3/message', { text: 'x'.repeat(4001) })).statusCode).toBe(400);
  });
});

describe('v3 chapter actions', () => {
  it('rewrite without a note → 400; with a note → 200; on a completed book → 409 v3_finished; removed actions (repair …) → 400; rewrite_from on a legacy book → 409 legacy_book', async () => {
    await v3Book('ca', 4);
    const url = '/api/admin/books/ca/chapters/2/actions';
    expect((await admin('POST', url, { action: 'rewrite' })).statusCode).toBe(400);
    expect((await admin('POST', url, { action: 'rewrite', note: '  ' })).statusCode).toBe(400);
    expect((await admin('POST', url, { action: 'rewrite', note: '再紧一点' })).statusCode).toBe(200);
    // 旧流程的章节操作已从接口删除（P3 WP-3）
    for (const action of ['repair', 'reextract', 'approve', 'hold', 'unhold']) expect((await admin('POST', url, { action, note: 'x' })).statusCode, action).toBe(400);
    await t.deps.db.update(books).set({ status: 'completed' }).where(eq(books.slug, 'ca'));
    const done = await admin('POST', url, { action: 'rewrite', note: '再紧一点' });
    expect(done.statusCode).toBe(409);
    expect(done.json().code).toBe('v3_finished');
    expect((await admin('PUT', '/api/admin/books/ca/v3/message', { text: '再写一章' })).json().code).toBe('v3_finished');
    await createLegacyBook(t.deps.db, t.deps.paths, 'ca-v2', { title: '旧' });
    const legacy = await admin('POST', '/api/admin/books/ca-v2/chapters/1/actions', { action: 'rewrite_from' });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json().code).toBe('legacy_book');
  });

  it('rewrite_from on a published chapter → 409; on an unpublished one → rewind to N−1', async () => {
    await v3Book('rf', 5);
    await t.deps.db.update(books).set({ publishedThrough: 2 }).where(eq(books.slug, 'rf'));
    const pub = await admin('POST', '/api/admin/books/rf/chapters/2/actions', { action: 'rewrite_from' });
    expect(pub.statusCode).toBe(409);
    expect(pub.json().code).toBe('published');
    expect((await admin('POST', '/api/admin/books/rf/chapters/4/actions', { action: 'rewrite_from', note: '换个结局' })).statusCode).toBe(200);
    const row = await rowOf('rf');
    expect(row.acceptedThrough).toBe(3);
    expect(readV3Meta(row.meta).hints.at(-1)?.text).toBe('主人的意见：换个结局');
  });
});
