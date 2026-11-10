import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from '@novelist/shared';
import { openRepo, TRASH_TOMBSTONE } from '../book/index.js';
import { createLegacyBook } from '../book/testing-legacy.js';
import { books, chapters, profiles, secrets, settings, tasks } from '../db/schema.js';
import { reindexBook } from '../services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';

let t: TestApp;
let adminCookie: string;

async function loginAs(password: string): Promise<{ status: number; cookie: string; body: Record<string, unknown> }> {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  return { status: res.statusCode, cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '', body: res.json() };
}

const admin = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { cookie: adminCookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  t = await createTestApp();
  const r = await loginAs(TEST_ADMIN_PASSWORD);
  expect(r.status).toBe(200);
  adminCookie = r.cookie;
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('route table', () => {
  it('registers every route in ROUTES', () => {
    for (const r of ROUTES) expect(t.app.hasRoute({ method: r.method, url: r.path }), `${r.method} ${r.path}`).toBe(true);
  });

  it('enforces auth on reader and admin routes', async () => {
    for (const r of ROUTES.filter((x) => x.auth !== 'public')) {
      const url = r.path.replace(':slug', 'x').replace(':no', '1').replace(':id', 'x').replace(':sid', 'x').replace(':name', 'X');
      const res = await t.app.inject({ method: r.method, url, ...(['GET'].includes(r.method) ? {} : { payload: {} }) });
      expect(res.statusCode, `${r.method} ${r.path}`).toBe(401);
    }
  });

  it('problem+json for unknown api path and 404 for missing book', async () => {
    const res = await admin('GET', '/api/admin/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const b = await admin('GET', '/api/admin/books/nope');
    expect(b.statusCode).toBe(404);
    expect(b.json().code).toBe('not_found');
  });
});

describe('partial updates', () => {
  it('PATCH 只改传入的字段，不把其余字段重置成默认值', async () => {
    const created = await admin('POST', '/api/admin/accounts', { id: 'partial', harness: 'fake', label: 'L', authMode: 'none', concurrency: 3, reservePct: 55 });
    expect(created.statusCode).toBeLessThan(300);
    const patched = await admin('PATCH', '/api/admin/accounts/partial', { label: 'L2' });
    expect(patched.statusCode).toBe(200);
    const view = JSON.parse(patched.body);
    expect(view.label).toBe('L2');
    expect(view.concurrency).toBe(3);
    expect(view.reservePct).toBe(55);

    const put = await admin('PUT', '/api/admin/settings', { maxConcurrentRuns: 7 });
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body).maxConcurrentRuns).toBe(7);
    const put2 = await admin('PUT', '/api/admin/settings', { schedulerEnabled: true });
    expect(JSON.parse(put2.body).maxConcurrentRuns).toBe(7);
  });
});

describe('auth', () => {
  it('health is public, me reflects session', async () => {
    expect((await t.app.inject({ url: '/api/health' })).json().ok).toBe(true);
    expect((await t.app.inject({ url: '/api/auth/me' })).json().role).toBeNull();
    expect((await admin('GET', '/api/auth/me')).json().role).toBe('admin');
  });

  it('rejects wrong password and tampered cookie', async () => {
    expect((await loginAs('wrong')).status).toBe(401);
    const tampered = adminCookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    expect((await t.app.inject({ url: '/api/admin/books', headers: { cookie: tampered } })).statusCode).toBe(401);
  });

  it('rejects cross-origin writes', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: adminCookie, origin: 'https://evil.example', host: 'novel.example' } });
    expect(res.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'GET', url: '/api/admin/books', headers: { cookie: adminCookie, origin: 'https://evil.example', host: 'novel.example' } });
    expect(ok.statusCode).toBe(200);
  });

  it('PAT grants admin; revocation works', async () => {
    const created = await admin('POST', '/api/admin/pats', { label: 'cli' });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();
    expect(token).toMatch(/^nvpat_/);
    expect((await t.app.inject({ url: '/api/admin/books', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    await admin('DELETE', `/api/admin/pats/${id}`);
    expect((await t.app.inject({ url: '/api/admin/books', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    const list = (await admin('GET', '/api/admin/pats')).json();
    expect(list.every((p: Record<string, unknown>) => !('token' in p) && !('hash' in p))).toBe(true);
  });

  it('changing admin password invalidates other sessions, keeps current', async () => {
    const other = await loginAs(TEST_ADMIN_PASSWORD);
    const r = await admin('PUT', '/api/admin/settings/admin-password', { current: TEST_ADMIN_PASSWORD, next: 'new-admin-password' });
    expect(r.statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/admin/books', headers: { cookie: other.cookie } })).statusCode).toBe(401);
    expect((await admin('GET', '/api/admin/books')).statusCode).toBe(200);
    await admin('PUT', '/api/admin/settings/admin-password', { current: 'new-admin-password', next: TEST_ADMIN_PASSWORD });
  });
});

describe('books and files', () => {
  it('refuses a book without an existing genre', async () => {
    const res = await admin('POST', '/api/admin/books', { title: '无题材', genre: 'no-such-genre', start: false });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unknown_genre');
  });

  it('creates (always a v3 book), reads and edits a book through git', async () => {
    // 旧请求里的 tier / flow 不再起作用：新书一律是 v3
    const res = await admin('POST', '/api/admin/books', { title: '测试之书', slug: 'book-a', genre: 'xianxia', seed: '一个种子', tier: 'standard', start: false });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'draft', flow: 'v3', legacy: false });

    const overview = await admin('GET', '/api/admin/books/book-a');
    expect(overview.statusCode).toBe(200);
    expect(overview.json().config.title).toBe('测试之书');
    expect(overview.json().config.flow).toBe('v3');
    expect(overview.json().dirMissing).toBe(false);

    const premise = (await admin('GET', '/api/admin/books/book-a/file?path=seed.md')).json();
    expect(premise.content).toBe('一个种子');

    const saved = await admin('PUT', '/api/admin/books/book-a/file', { path: 'seed.md', content: '新种子', baseSha: premise.sha });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().content).toBe('新种子');
    expect(saved.json().sha).not.toBe(premise.sha);

    const stale = await admin('PUT', '/api/admin/books/book-a/file', { path: 'seed.md', content: 'x', baseSha: premise.sha });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('stale_base');

    const log = (await admin('GET', '/api/admin/books/book-a/git/log?limit=5')).json();
    expect(log.items[0].trailers['Novelist-Owner-Edit']).toBe('true');
  });

  it('rejects path traversal and generated files', async () => {
    expect((await admin('GET', '/api/admin/books/book-a/file?path=../../etc/passwd')).statusCode).toBe(400);
    expect((await admin('GET', '/api/admin/books/book-a/file?path=.git/config')).statusCode).toBe(400);
    const r = await admin('PUT', '/api/admin/books/book-a/file', { path: 'AGENTS.md', content: 'x', baseSha: null });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('generated_path');
  });

  it('validates book.yaml edits (through the file editor) and refuses slug changes', async () => {
    const doc = (await admin('GET', '/api/admin/books/book-a/file?path=book.yaml')).json();
    const bad = await admin('PUT', '/api/admin/books/book-a/file', { path: 'book.yaml', content: 'title: 123\n', baseSha: doc.sha });
    expect(bad.statusCode).toBe(422);
    const renamed = await admin('PUT', '/api/admin/books/book-a/file', { path: 'book.yaml', content: doc.content.replace('slug: book-a', 'slug: other'), baseSha: doc.sha });
    expect(renamed.statusCode).toBe(400);
    const ok = await admin('PUT', '/api/admin/books/book-a/file', { path: 'book.yaml', content: doc.content.replace('测试之书', '改名之书'), baseSha: doc.sha });
    expect(ok.statusCode).toBe(200);
    expect((await admin('GET', '/api/admin/books?filter=all')).json().find((b: { slug: string }) => b.slug === 'book-a').title).toBe('改名之书');
  });

  it('the raw book.yaml editor, the old publish page routes and the schedule page are gone (P3 WP-3)', async () => {
    expect((await admin('GET', '/api/admin/books/book-a/config')).statusCode).toBe(404);
    expect((await admin('PUT', '/api/admin/books/book-a/config', { raw: 'x', baseSha: 'y' })).statusCode).toBe(404);
    expect((await admin('GET', '/api/admin/books/book-a/publish')).statusCode).toBe(404);
    expect((await admin('PUT', '/api/admin/books/book-a/publish', { max_buffer: 80 })).statusCode).toBe(404);
    expect((await admin('GET', '/api/admin/schedule')).statusCode).toBe(404);
    // 立即发布还在（v3 书的章节页用它）
    expect((await admin('POST', '/api/admin/books/book-a/publish/now', {})).statusCode).toBe(409);
  });

  it('book file tree; the old plan / state / quality / reviews / audits / debts views are gone', async () => {
    const tree = (await admin('GET', '/api/admin/books/book-a/tree')).json();
    expect(tree.some((e: { path: string; type: string }) => e.path === 'manuscript' && e.type === 'dir')).toBe(true);
    for (const p of ['plan', 'state', 'quality', 'reviews', 'audits', 'debts']) expect((await admin('GET', `/api/admin/books/book-a/${p}`)).statusCode, p).toBe(404);
  });

  it('delete requires confirm and moves the repo to the trash (with a tombstone)', async () => {
    await admin('POST', '/api/admin/books', { title: '待删', slug: 'book-del', genre: 'xianxia', start: false });
    expect((await admin('DELETE', '/api/admin/books/book-del')).statusCode).toBe(400);
    expect((await admin('DELETE', '/api/admin/books/book-del?confirm=book-del')).statusCode).toBe(200);
    expect(await fs.stat(path.join(t.dataDir, 'books/book-del')).then(() => true, () => false)).toBe(false);
    const trashed = (await fs.readdir(path.join(t.dataDir, 'trash/books'))).filter((n) => n.startsWith('book-del-'));
    expect(trashed).toHaveLength(1);
    const tomb = JSON.parse(await fs.readFile(path.join(t.dataDir, 'trash/books', trashed[0] as string, TRASH_TOMBSTONE), 'utf8'));
    expect(tomb).toMatchObject({ kind: 'books', name: 'book-del', slug: 'book-del', title: '待删' });
    expect(await fs.readFile(path.join(t.dataDir, 'trash/books', trashed[0] as string, 'book.yaml'), 'utf8')).toContain('slug: book-del');
    expect((await t.deps.db.select().from(books).where(eq(books.slug, 'book-del')))).toEqual([]);
  });
});

describe('reader flow', () => {
  let readerCookie: string;
  let bookId: string;

  beforeAll(async () => {
    // 读者端和导出跑在旧书上（约 130 本导入书的样子）：卷标题在 reindex 时从 plan/volumes 回填
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'pub-book', { chapters: 3, published: 2, title: '已发布之书', volumes: [{ id: 'v01', title: '第一卷 风起', from: 1, to: 3 }] });
    bookId = b.id;
    await reindexBook(t.deps, 'pub-book');
    const r = await admin('POST', '/api/admin/readers', { label: '小明', password: 'reader-pass' });
    expect(r.statusCode).toBe(201);
    readerCookie = (await loginAs('reader-pass')).cookie;
  });

  const reader = (method: 'GET' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie: readerCookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

  it('reindex rebuilt the chapter index from git', async () => {
    const page = (await admin('GET', '/api/admin/books/pub-book/chapters')).json();
    expect(page.items.map((c: { no: number }) => c.no)).toEqual([1, 2, 3]);
    expect((await admin('GET', '/api/admin/books/pub-book')).json().frontiers.accepted).toBe(3);
  });

  it('readers only see published chapters', async () => {
    const list = (await reader('GET', '/api/reader/books')).json();
    expect(list).toHaveLength(1);
    expect(list[0].publishedChapters).toBe(2);
    expect((await reader('GET', '/api/reader/books/pub-book/chapters/1')).statusCode).toBe(200);
    expect((await reader('GET', '/api/reader/books/pub-book/chapters/3')).statusCode).toBe(404);
    const ch = (await reader('GET', '/api/reader/books/pub-book/chapters/2')).json();
    expect(ch.prev).toBe(1);
    expect(ch.next).toBeNull();
    expect(ch.text).not.toContain('<!-- beat:');
    expect(ch.volumeTitle).toBe('第一卷 风起');
    const detail = (await reader('GET', '/api/reader/books/pub-book')).json();
    expect(detail.volumes).toHaveLength(1);
    expect(detail.volumes[0]).toMatchObject({ id: 'v01', title: '第一卷 风起' });
    expect(detail.volumes[0].chapters).toHaveLength(2);
  });

  it('reader cannot reach admin routes', async () => {
    expect((await t.app.inject({ url: '/api/admin/books', headers: { cookie: readerCookie } })).statusCode).toBe(403);
  });

  it('keeps reading progress per reader', async () => {
    expect((await reader('GET', '/api/reader/books/pub-book/progress')).json()).toBeNull();
    await reader('PUT', '/api/reader/books/pub-book/progress', { ch: 2, scroll: 0.4 });
    expect((await reader('GET', '/api/reader/books/pub-book/progress')).json()).toEqual({ ch: 2, scroll: 0.4 });
    expect((await admin('GET', '/api/reader/books/pub-book/progress')).json()).toBeNull();
  });

  it('allow_books restricts visibility', async () => {
    await admin('POST', '/api/admin/readers', { label: '限制', password: 'limited-pass', allowBooks: ['other'] });
    const cookie = (await loginAs('limited-pass')).cookie;
    expect((await t.app.inject({ url: '/api/reader/books', headers: { cookie } })).json()).toEqual([]);
    expect((await t.app.inject({ url: '/api/reader/books/pub-book', headers: { cookie } })).statusCode).toBe(404);
  });

  it('rejects duplicate reader passwords', async () => {
    const r = await admin('POST', '/api/admin/readers', { label: '重复', password: 'reader-pass' });
    expect(r.statusCode).toBe(409);
    const adminDup = await admin('POST', '/api/admin/readers', { label: '撞管理员', password: TEST_ADMIN_PASSWORD });
    expect(adminDup.statusCode).toBe(409);
  });

  it('exports EPUB and TXT with published chapters only; admin can export accepted', async () => {
    const epub = await reader('GET', '/api/reader/books/pub-book/export.epub');
    expect(epub.statusCode).toBe(200);
    expect(epub.headers['content-type']).toBe('application/epub+zip');
    const zip = await JSZip.loadAsync(epub.rawPayload);
    expect(await zip.file('mimetype')?.async('string')).toBe('application/epub+zip');
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    expect(zip.file('OEBPS/c00001.xhtml')).toBeTruthy();
    expect(zip.file('OEBPS/c00003.xhtml')).toBeNull();
    const txt = await reader('GET', '/api/reader/books/pub-book/export.txt');
    expect(txt.statusCode).toBe(200);
    expect(txt.body).toContain('已发布之书');
    expect((await reader('GET', '/api/reader/books/pub-book/export.txt?scope=accepted')).statusCode).toBe(403);
    expect((await admin('GET', '/api/reader/books/pub-book/export.txt?scope=accepted')).statusCode).toBe(200);
  });

  it('per-volume export filters chapters', async () => {
    const res = await reader('GET', '/api/reader/books/pub-book/export.epub?vol=v99');
    expect(res.statusCode).toBe(404);
  });

  it('manual text edit on a legacy book commits as the owner, updates the index and creates no task', async () => {
    const detail = (await admin('GET', '/api/admin/books/pub-book/chapters/2')).json();
    expect(detail.text).toBeTruthy();
    const repo = openRepo(path.join(t.dataDir, 'books/pub-book'));
    const blob = (await repo.blobShas(['manuscript/c00002.md'], await repo.head()))['manuscript/c00002.md'];
    const res = await admin('PUT', '/api/admin/books/pub-book/chapters/2/text', { text: '手改之后的正文，这里有中文。', baseSha: blob, confirm: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('手改之后');
    const rows = await t.deps.db.select().from(chapters).where(eq(chapters.bookId, bookId));
    expect(rows.find((r) => r.no === 2)?.revisedAt).toBeTruthy();
    expect((await repo.log({ limit: 1 })).items[0]?.trailers['Novelist-Owner-Edit']).toBe('true');
    expect(await t.deps.db.select().from(tasks).where(eq(tasks.bookId, bookId))).toEqual([]);
  });
});

describe('accounts', () => {
  it('stores secrets encrypted and never returns them', async () => {
    const res = await admin('POST', '/api/admin/accounts', {
      id: 'cc-gw',
      harness: 'claude-code',
      authMode: 'custom_api',
      env: [
        { name: 'ANTHROPIC_BASE_URL', value: 'https://gw.example/v1', secret: false },
        { name: 'ANTHROPIC_API_KEY', value: 'sk-super-secret', secret: true },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('sk-super-secret');
    const view = res.json();
    expect(view.env.find((e: { name: string }) => e.name === 'ANTHROPIC_API_KEY')).toEqual({ name: 'ANTHROPIC_API_KEY', secret: true, set: true });
    expect(view.env.find((e: { name: string }) => e.name === 'ANTHROPIC_BASE_URL').value).toBe('https://gw.example/v1');
    expect(view.riskNotes.map((r: { id: string }) => r.id)).toContain('api_key_billing');
    const rows = await t.deps.db.select().from(secrets).where(eq(secrets.ownerId, 'cc-gw'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ciphertext).not.toContain('sk-super-secret');
    expect(await t.deps.secrets.getString(rows[0]?.id as string)).toBe('sk-super-secret');
  });

  it('env update and delete', async () => {
    await admin('PUT', '/api/admin/accounts/cc-gw/env/ANTHROPIC_MODEL', { value: 'm1', secret: false });
    const put = await admin('PUT', '/api/admin/accounts/cc-gw/env/ANTHROPIC_API_KEY', { value: 'sk-2', secret: true });
    expect(put.json().env.filter((e: { name: string }) => e.name === 'ANTHROPIC_API_KEY')).toHaveLength(1);
    expect((await t.deps.db.select().from(secrets).where(eq(secrets.ownerId, 'cc-gw')))).toHaveLength(1);
    const del = await admin('DELETE', '/api/admin/accounts/cc-gw/env/ANTHROPIC_API_KEY');
    expect(del.json().env.some((e: { name: string }) => e.name === 'ANTHROPIC_API_KEY')).toBe(false);
    expect(await t.deps.db.select().from(secrets).where(eq(secrets.ownerId, 'cc-gw'))).toHaveLength(0);
  });

  it('uploads credential files via multipart', async () => {
    const boundary = '----nvtest';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="relPath"\r\n\r\n.codex/auth.json\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="part"\r\n\r\nstate\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="auth.json"\r\nContent-Type: application/json\r\n\r\n{"token":"abc"}\r\n--${boundary}--\r\n`;
    await admin('POST', '/api/admin/accounts', { id: 'cx', harness: 'codex', authMode: 'credential_file' });
    const res = await t.app.inject({ method: 'POST', url: '/api/admin/accounts/cx/files', headers: { cookie: adminCookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('abc');
    const view = res.json();
    expect(view.files[0].relPath).toBe('.codex/auth.json');
    expect(view.files[0].bytes).toBe(15);
    const del = await admin('DELETE', '/api/admin/accounts/cx/files?relPath=.codex/auth.json');
    expect(del.json().files).toEqual([]);
  });

  it('rejects duplicate account ids, deletes cascade', async () => {
    expect((await admin('POST', '/api/admin/accounts', { id: 'cx', harness: 'codex', authMode: 'api_key' })).statusCode).toBe(409);
    expect((await admin('DELETE', '/api/admin/accounts/cx')).statusCode).toBe(200);
    expect((await admin('GET', '/api/admin/accounts/cx')).statusCode).toBe(404);
  });

  it('verify reports status for a harness (fake is always installed)', async () => {
    const res = await admin('POST', '/api/admin/accounts/fake/verify');
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.find((c: { id: string }) => c.id === 'installed').ok).toBe(true);
  });

  it('interactive login runs fake harness and registers the credential file', async () => {
    await admin('POST', '/api/admin/accounts', { id: 'fake-login', harness: 'fake', authMode: 'subscription_login' });
    const start = await admin('POST', '/api/admin/accounts/fake-login/login');
    expect(start.statusCode).toBe(200);
    const sid = start.json().id as string;
    for (let i = 0; i < 100 && !(await admin('GET', `/api/admin/login-sessions/${sid}`)).json().output?.length; i += 1) await new Promise((r) => setTimeout(r, 50));
    await admin('POST', `/api/admin/login-sessions/${sid}/input`, { text: 'good-code' });
    let state = 'starting';
    for (let i = 0; i < 200 && !['succeeded', 'failed', 'expired', 'cancelled'].includes(state); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      state = (await admin('GET', `/api/admin/login-sessions/${sid}`)).json().state;
    }
    expect(state).toBe('succeeded');
    await expect.poll(async () => (await admin('GET', '/api/admin/accounts/fake-login')).json().files.length, { timeout: 5000 }).toBe(1);
  }, 30_000);
});

describe('routing and settings', () => {
  it('routing slots: view, PUT validation, a slot left on a deleted profile does not block saving the other, profile in a slot cannot be deleted, canary', async () => {
    const view = (await admin('GET', '/api/admin/routing/slots')).json();
    expect(view.slots).toMatchObject({ schema: 'nv.slots/1', writer: { primary: 'fake', fallback: null }, utility: { primary: 'fake', fallback: null } });
    expect(view.forced).toBe(false);
    expect(view.status.writer).toMatchObject({ slot: 'writer', profile: 'fake', harness: 'fake', usedFallback: false, waitUntil: null, reason: null });
    expect(view.profiles.some((p: { id: string }) => p.id === 'agy-argon')).toBe(true);
    const keep = { writer: { primary: 'fake', fallback: null }, utility: { primary: 'fake', fallback: null } };
    const bad = await admin('PUT', '/api/admin/routing/slots', { ...keep, writer: { primary: 'nope', fallback: null } });
    expect([bad.statusCode, bad.json().code]).toEqual([400, 'unknown_profile']);
    const same = await admin('PUT', '/api/admin/routing/slots', { ...keep, writer: { primary: 'fake', fallback: 'fake' } });
    expect([same.statusCode, same.json().code]).toEqual([400, 'same_profile']);
    expect((await admin('POST', '/api/admin/profiles', { id: 'tmp-fake', harness: 'fake', model: 'fake-model' })).statusCode).toBe(201);
    const withFb = await admin('PUT', '/api/admin/routing/slots', { ...keep, writer: { primary: 'fake', fallback: 'tmp-fake' } });
    expect(withFb.statusCode).toBe(200);
    expect(withFb.json().slots.writer).toEqual({ primary: 'fake', fallback: 'tmp-fake' });
    const inUse = await admin('DELETE', '/api/admin/profiles/tmp-fake');
    expect([inUse.statusCode, inUse.json().code]).toEqual([409, 'profile_in_use']);
    // 绕过 API 删掉它（例如旧库里早就没了）：写作位置还指着它，照样能保存杂活位置
    await t.deps.db.delete(profiles).where(eq(profiles.id, 'tmp-fake'));
    const other = await admin('PUT', '/api/admin/routing/slots', { writer: { primary: 'fake', fallback: 'tmp-fake' }, utility: { primary: 'agy-flash-check', fallback: null } });
    expect(other.statusCode).toBe(200);
    expect((await admin('PUT', '/api/admin/routing/slots', keep)).statusCode).toBe(200);
    // 试跑：用这个位置当前的 profile 跑一次目录探测
    const canary = await admin('POST', '/api/admin/routing/slots/writer/canary');
    expect(canary.statusCode).toBe(200);
    expect(canary.json().status).toMatchObject({ slot: 'writer', profile: 'fake' });
    expect(canary.json().result).toMatchObject({ ok: true, wroteFile: true, honouredAgents: true });
    expect(canary.json().caps.workspaceDocLoaded).toBe(true);
    expect((await admin('POST', '/api/admin/routing/slots/nope/canary')).statusCode).toBe(404);
  });

  it('settings PUT no longer mirrors activePreset into routing.active (that row is only for the previous image)', async () => {
    const before = await t.deps.db.select().from(settings).where(eq(settings.key, 'routing.active'));
    expect((await admin('PUT', '/api/admin/settings', { activePreset: 'cc-only' })).statusCode).toBe(200);
    expect(await t.deps.db.select().from(settings).where(eq(settings.key, 'routing.active'))).toEqual(before);
    // activePreset 已从 schema 删掉：存进去的设置里也没有它
    expect((await admin('GET', '/api/admin/settings')).json()).not.toHaveProperty('activePreset');
    expect((await admin('GET', '/api/admin/routing/slots')).json().slots.writer.primary).toBe('fake');
  });

  it('profiles: create, patch, builtin protected', async () => {
    const created = await admin('POST', '/api/admin/profiles', { id: 'my-cc', harness: 'claude-code', model: 'my-model' });
    expect(created.statusCode).toBe(201);
    expect((await admin('PATCH', '/api/admin/profiles/my-cc', { model: 'm2' })).json().model).toBe('m2');
    expect((await admin('DELETE', '/api/admin/profiles/agy-argon')).statusCode).toBe(403);
    expect((await admin('DELETE', '/api/admin/profiles/my-cc')).statusCode).toBe(200);
  });

  it('settings validate and persist; quota, usage and doctor answer', async () => {
    expect((await admin('PUT', '/api/admin/settings', { maxConcurrentRuns: 0 })).statusCode).toBe(400);
    expect((await admin('PUT', '/api/admin/settings', { maxConcurrentRuns: 7 })).json().maxConcurrentRuns).toBe(7);
    expect((await admin('GET', '/api/admin/quota')).statusCode).toBe(200);
    expect((await admin('GET', '/api/admin/usage?groupBy=profile')).json().groupBy).toBe('profile');
    const doctor = await admin('GET', '/api/admin/doctor');
    expect(doctor.statusCode).toBe(200);
    expect(doctor.json().db.ok).toBe(true);
    expect((await admin('GET', '/api/admin/system')).json().settings.maxConcurrentRuns).toBe(7);
  });

  it('autoStart (WP-3): defaults keep it off with maxUnfinishedBooks 3 and the 40/35/20/5 mix; a lengthMix that does not sum to 100 → 400, nothing stored', async () => {
    const cur = (await admin('GET', '/api/admin/settings')).json();
    expect(cur.autoStart).toMatchObject({ enabled: false, maxUnfinishedBooks: 3, genreWeights: {}, lengthMix: { short: 40, medium: 35, long: 20, epic: 5 } });
    const bad = await admin('PUT', '/api/admin/settings', { autoStart: { ...cur.autoStart, lengthMix: { short: 50, medium: 35, long: 20, epic: 5 } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_length_mix');
    expect((await admin('GET', '/api/admin/settings')).json().autoStart.lengthMix.short).toBe(40);
    const ok = await admin('PUT', '/api/admin/settings', { autoStart: { ...cur.autoStart, lengthMix: { short: 25, medium: 25, long: 25, epic: 25 }, genreWeights: { xianxia: 2 } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().autoStart).toMatchObject({ enabled: false, lengthMix: { short: 25, medium: 25, long: 25, epic: 25 }, genreWeights: { xianxia: 2 } });
  });

  it('v3.runawayFactor: 0 (off) or ≥ 2; 0.5–1.5 → 400 invalid_runaway_factor; an old stored 1.5 reads back as 2', async () => {
    for (const bad of [0.5, 1, 1.5]) {
      const r = await admin('PUT', '/api/admin/settings', { v3: { runawayFactor: bad } });
      expect(r.statusCode, String(bad)).toBe(400);
      expect(r.json().code).toBe('invalid_runaway_factor');
    }
    expect((await admin('PUT', '/api/admin/settings', { v3: { runawayFactor: 0 } })).json().v3.runawayFactor).toBe(0);
    expect((await admin('PUT', '/api/admin/settings', { v3: { runawayFactor: 2.5 } })).json().v3.runawayFactor).toBe(2.5);
    const { zSystemSettings } = await import('@novelist/shared');
    expect(zSystemSettings.parse({ v3: { runawayFactor: 1.5 } }).v3.runawayFactor).toBe(2);
    expect(zSystemSettings.parse({}).v3.runawayFactor).toBe(2);
    await admin('PUT', '/api/admin/settings', { v3: { runawayFactor: 2 } });
  });

  it('instruction files: layers, writes commit to git, builtin read-only', async () => {
    const builtin = (await admin('GET', '/api/admin/instructions/files?scope=builtin')).json();
    // 内置层只剩 v3 的约定、篇幅要领和 writer.md（旧流程的 contract.md 与角色随 P3 删除）
    expect(builtin.some((f: { path: string; layer: string }) => f.path === 'v3/contract.md' && f.layer === 'S0')).toBe(true);
    expect(builtin.some((f: { path: string }) => f.path === 'contract.md')).toBe(false);
    expect((await admin('PUT', '/api/admin/instructions/file', { scope: 'builtin', path: 'v3/contract.md', content: 'x', baseSha: null })).statusCode).toBe(403);
    const w = await admin('PUT', '/api/admin/instructions/file', { scope: 'global', path: 'AGENTS.md', content: '全局指令', baseSha: null });
    expect(w.statusCode).toBe(200);
    expect(w.json().commit).toMatch(/^[0-9a-f]{40}$/);
    const r = (await admin('GET', '/api/admin/instructions/file?scope=global&path=AGENTS.md')).json();
    expect(r.content).toBe('全局指令');
    // v3 预览：按题材包 + 篇幅渲染根 AGENTS.md，全局层的字节数就是刚写的内容
    const preview = await admin('POST', '/api/admin/instructions/preview', { genre: 'xianxia', length: 'short' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().text).toContain('全局指令');
    expect(preview.json().layers.find((l: { id: string }) => l.id === 'L1')?.bytes).toBe(Buffer.byteLength('全局指令'));
    expect((await admin('DELETE', '/api/admin/instructions/file?scope=global&path=AGENTS.md')).statusCode).toBe(200);
  });

  it('genres list, in-use builtin cannot be deleted but can be hidden', async () => {
    const list = (await admin('GET', '/api/admin/genres')).json();
    expect(list.some((g: { id: string; builtin: boolean; hidden: boolean }) => g.id === 'xianxia' && g.builtin && !g.hidden)).toBe(true);
    const del = await admin('DELETE', '/api/admin/genres/xianxia');
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe('genre_in_use');
    const hide = await admin('POST', '/api/admin/genres/xianxia/visibility', { hidden: true });
    expect(hide.statusCode).toBe(200);
    expect(hide.json().hidden).toBe(true);
    expect((await admin('GET', '/api/admin/genres')).json().find((g: { id: string }) => g.id === 'xianxia').hidden).toBe(true);
    const unhide = await admin('POST', '/api/admin/genres/xianxia/visibility', { hidden: false });
    expect(unhide.statusCode).toBe(200);
    expect((await admin('GET', '/api/admin/genres')).json().find((g: { id: string }) => g.id === 'xianxia').hidden).toBe(false);
    const created = await admin('POST', '/api/admin/genres', { id: 'custom-a', name: '自定义', extends: [] });
    expect(created.statusCode).toBe(201);
    expect((await admin('POST', '/api/admin/genres', { id: 'custom-a', name: '自定义', extends: [] })).statusCode).toBe(409);
    expect((await admin('DELETE', '/api/admin/genres/custom-a')).statusCode).toBe(200);
  });

  it('harness status and probe; the old feasibility routes are gone', async () => {
    const harness = (await admin('GET', '/api/admin/harness')).json();
    expect(harness.find((h: { id: string }) => h.id === 'fake').installed).toBe(true);
    expect((await admin('POST', '/api/admin/routing/check')).statusCode).toBe(404);
    expect((await admin('GET', '/api/admin/routing/presets')).statusCode).toBe(404);
    expect((await admin('GET', '/api/admin/routing/active')).statusCode).toBe(404);
    expect((await admin('GET', '/api/admin/harness/fake/models')).statusCode).toBe(200);
    const probe = await admin('POST', '/api/admin/harness/fake/probe');
    expect(probe.statusCode).toBe(200);
    expect(probe.json().structuredOutput).toBe('native');
    expect((await admin('GET', '/api/admin/harness')).json().find((h: { id: string }) => h.id === 'fake').capabilities).toBeTruthy();
  });
});
