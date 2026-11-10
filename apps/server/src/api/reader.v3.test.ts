/** 读者端正文：v3 书去掉首行的“# 第N章 标题”，v2 书保持原样（p1-plan §3 WP-C、§6 reader.v3）。 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepo, P } from '../book/index.js';
import { books, chapters } from '../db/schema.js';
import { commitOwnerEdit } from '../orchestrator/index.js';
import { createBook, reindexBook } from '../services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';
import { bookDir } from './helpers.js';

let t: TestApp;
let cookie: string;

const PROSE = '灯下的人抬起头，望着门外的雨。'.repeat(20);

/** 建书 → 提交第 1 章 → reindex → 标记已发布 */
async function publishedBook(slug: string, flow: 'v3' | undefined, text: string): Promise<void> {
  await createBook(t.deps, { title: `书${slug}`, slug, genre: 'xianxia', start: false, ...(flow ? { flow } : {}) });
  const row = (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
  await commitOwnerEdit(t.deps.db, openRepo(bookDir(t.deps, slug)), row.id, { files: [{ path: P.manuscript(1), content: text }], message: 'test: chapter', baseSha: null });
  await reindexBook(t.deps, slug);
  const nowIso = new Date().toISOString();
  await t.deps.db.update(chapters).set({ publishedAt: nowIso }).where(and(eq(chapters.bookId, row.id), eq(chapters.no, 1)));
  await t.deps.db.update(books).set({ publishedThrough: 1, status: 'active' }).where(eq(books.id, row.id));
}

const chapter = (slug: string) => t.app.inject({ method: 'GET', url: `/api/reader/books/${slug}/chapters/1`, headers: { cookie } });

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('reader chapter text', () => {
  it('v3 chapter text has no first heading line', async () => {
    await publishedBook('rv3', 'v3', `# 第1章 雨夜\n\n${PROSE}\n`);
    const res = await chapter('rv3');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.text).toBe(`${PROSE}\n`);
    expect(body.text).not.toContain('# 第');
    expect(body.title).toBe('雨夜');
  });

  it('v2 chapter text keeps its first "#" line (regression)', async () => {
    await publishedBook('rv2', undefined, `# 第一章 旧事\n\n${PROSE}\n`);
    const res = await chapter('rv2');
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe(`# 第一章 旧事\n\n${PROSE}\n`);
  });
});
