/**
 * 旧书（P3）在管理端和读者端照常可读：书目、章节、正文、卷标题、导出、直接改正文、删到回收站；书目录不在时受控降级。
 * 旧书从不开写、不发布（P3 D13）。夹具 = book/testing-legacy.ts（约 130 本导入书的样子）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepo, TRASH_TOMBSTONE } from '../book/index.js';
import { createLegacyBook } from '../book/testing-legacy.js';
import { books, chapters, tasks } from '../db/schema.js';
import { createScheduler } from '../orchestrator/index.js';
import { reindexBook } from '../services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';

let t: TestApp;
let cookie: string;

const admin = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

const OLD_KEYS = [
  'routing:',
  '  roles:',
  '    writer: { chain: [cc-opus], degrade_to: [], sticky: book, on_quota: wait, failover_on: [], failover_chain: [], failover_requires_approval: true, constraint: none, distinct_vendors: false }',
  'gates:',
  '  overrides:',
  '    lexicon: { disable: true }',
  '',
].join('\n');

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  // 两卷、第 4 章起未发布；book.yaml 带旧键 tier / scale / approvals / routing.roles / gates
  await createLegacyBook(t.deps.db, t.deps.paths, 'old', {
    chapters: 5,
    published: 3,
    title: '旧书',
    volumes: [
      { id: 'v01', title: '第一卷 风起', from: 1, to: 2 },
      { id: 'v02', title: '第二卷 云涌', from: 3, to: 5 },
    ],
    bookYamlExtra: OLD_KEYS,
  });
  // book.yaml 过不了 zod 的旧书（slug 不合规则），第 1 章已发布
  await createLegacyBook(t.deps.db, t.deps.paths, 'badyaml', { chapters: 2, published: 1, bookYamlExtra: 'slug: NOT A SLUG\n' });
  // 开机迁移 / reindex 才回填卷标题：这里走 reindex
  await reindexBook(t.deps, 'old');
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('legacy book: reads', () => {
  it('admin list marks it legacy; the overview answers 200 with the old book.yaml and with one that fails zod (fallback config)', async () => {
    const list = (await admin('GET', '/api/admin/books?filter=legacy')).json() as { slug: string; legacy: boolean; flow: string; v3: unknown }[];
    expect(list.find((b) => b.slug === 'old')).toMatchObject({ legacy: true, flow: 'v2', v3: null });
    // 首页缺省只列在写的新流程书；旧书在“旧书”和“全部”里
    const slugsOf = async (q: string) => ((await admin('GET', `/api/admin/books${q}`)).json() as { slug: string }[]).map((b) => b.slug);
    expect(await slugsOf('')).not.toContain('old');
    expect(await slugsOf('?filter=active')).not.toContain('old');
    expect(await slugsOf('?filter=finished')).not.toContain('old');
    expect(await slugsOf('?filter=all')).toEqual(expect.arrayContaining(['old', 'badyaml']));
    expect((await admin('GET', '/api/admin/books?filter=bogus')).statusCode).toBe(400);
    const old = await admin('GET', '/api/admin/books/old');
    expect(old.statusCode).toBe(200);
    expect(old.json()).toMatchObject({ legacy: true, dirMissing: false, config: { genre: 'xianxia', flow: 'v2' }, writerOverride: null });
    // 书页只拿用得到的几节；旧流程的键（tier、gates、approvals……）不再出现
    expect(Object.keys(old.json().config).sort()).toEqual(['flow', 'genre', 'publish', 'routing', 'title', 'v3']);
    for (const k of ['tier', 'milestones', 'currentChapter', 'debts', 'formatVersion', 'writerProfile']) expect(old.json(), k).not.toHaveProperty(k);
    const bad = await admin('GET', '/api/admin/books/badyaml');
    expect(bad.statusCode).toBe(200);
    // book.yaml 读不出来：config 为 null，页面照样从数据库行打开
    expect(bad.json()).toMatchObject({ slug: 'badyaml', genre: 'xianxia', legacy: true, config: null });
  });

  it('chapter list carries volume titles; chapter detail has the text and no old-flow fields', async () => {
    const page = (await admin('GET', '/api/admin/books/old/chapters')).json() as { items: { no: number; volume: string; volumeTitle: string }[] };
    expect(page.items.map((c) => [c.no, c.volume, c.volumeTitle])).toEqual([
      [1, 'v01', '第一卷 风起'],
      [2, 'v01', '第一卷 风起'],
      [3, 'v02', '第二卷 云涌'],
      [4, 'v02', '第二卷 云涌'],
      [5, 'v02', '第二卷 云涌'],
    ]);
    const detail = await admin('GET', '/api/admin/books/old/chapters/4');
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ no: 4, volumeTitle: '第二卷 云涌', legacy: true, locked: false });
    for (const k of ['card', 'delta', 'review', 'gates', 'debtsList', 'draft', 'arc', 'verdict', 'audited']) expect(detail.json(), k).not.toHaveProperty(k);
    expect(detail.json().text).toContain('第4章的正文');
    expect((await admin('GET', '/api/admin/books/old/chapters/9')).statusCode).toBe(404);
  });

  it('reader: book detail grouped by volume with titles, chapter volumeTitle, unpublished chapters hidden', async () => {
    const detail = (await admin('GET', '/api/reader/books/old')).json() as { volumes: { id: string; title: string; chapters: { no: number }[] }[] };
    expect(detail.volumes.map((v) => [v.id, v.title, v.chapters.map((c) => c.no)])).toEqual([
      ['v01', '第一卷 风起', [1, 2]],
      ['v02', '第二卷 云涌', [3]],
    ]);
    const ch = (await admin('GET', '/api/reader/books/old/chapters/3')).json();
    expect(ch).toMatchObject({ no: 3, volumeTitle: '第二卷 云涌', prev: 2, next: null });
    expect(ch.text).toContain('第3章的正文');
    expect((await admin('GET', '/api/reader/books/old/chapters/4')).statusCode).toBe(404);
  });

  it('TXT / EPUB export with volume headings; a single volume', async () => {
    const txt = await admin('GET', '/api/reader/books/old/export.txt');
    expect(txt.statusCode).toBe(200);
    expect(txt.body).toContain('【第一卷 风起】');
    expect(txt.body).toContain('【第二卷 云涌】');
    expect(txt.body).not.toContain('第4章的正文');
    const epub = await admin('GET', '/api/reader/books/old/export.epub?scope=accepted');
    expect(epub.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(epub.rawPayload);
    expect(zip.file('OEBPS/c00005.xhtml')).toBeTruthy();
    const vol = await admin('GET', '/api/reader/books/old/export.txt?vol=v02');
    expect(vol.statusCode).toBe(200);
    expect(vol.body.split('\n')[0]).toBe('旧书 第二卷 云涌');
    expect(vol.body).not.toContain('第1章的正文');
  });
});

describe('legacy book: writes', () => {
  it('direct text edit commits as the owner and creates no task; on a published chapter of a book whose book.yaml fails zod: needs confirm, then 200 (never 500)', async () => {
    const repo = openRepo(path.join(t.deps.paths.books, 'old'));
    const blob = (await repo.blobShas(['manuscript/c00004.md'], await repo.head()))['manuscript/c00004.md'];
    const res = await admin('PUT', '/api/admin/books/old/chapters/4/text', { text: '主人改过的第四章，这里有中文。', baseSha: blob });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('主人改过');
    expect((await repo.log({ limit: 1 })).items[0]?.trailers['Novelist-Owner-Edit']).toBe('true');
    expect(await t.deps.db.select().from(tasks).where(eq(tasks.bookId, 'book-old'))).toEqual([]);

    const bad = openRepo(path.join(t.deps.paths.books, 'badyaml'));
    const b1 = (await bad.blobShas(['manuscript/c00001.md'], await bad.head()))['manuscript/c00001.md'];
    const first = await admin('PUT', '/api/admin/books/badyaml/chapters/1/text', { text: '改过的第一章。', baseSha: b1 });
    expect(first.statusCode).toBe(409);
    expect(first.json().needsConfirm).toBe(true);
    const confirmed = await admin('PUT', '/api/admin/books/badyaml/chapters/1/text', { text: '改过的第一章。', baseSha: b1, confirm: true });
    expect(confirmed.statusCode).toBe(200);
    expect(await bad.readFile('manuscript/c00001.md')).toBe('改过的第一章。');
  });

  it('notes/** stays writable; everything else but the chapter text is read-only (409 legacy_read_only)', async () => {
    const res = await admin('PUT', '/api/admin/books/old/file', { path: 'notes/owner.md', content: '接手前的备注\n', baseSha: null });
    expect(res.statusCode).toBe(200);
    const repo = openRepo(path.join(t.deps.paths.books, 'old'));
    const head = await repo.head();
    for (const p of ['bible/premise.md', 'book.yaml', 'instructions/AGENTS.md', 'plan/volumes/v01.yaml']) {
      const r = await admin('PUT', '/api/admin/books/old/file', { path: p, content: 'x\n', baseSha: null, confirm: true });
      expect(r.statusCode, p).toBe(409);
      expect(r.json().code, p).toBe('legacy_read_only');
    }
    expect(await repo.head()).toBe(head);
    const blob = (await repo.blobShas(['manuscript/c00005.md'], head))['manuscript/c00005.md'];
    expect((await admin('PUT', '/api/admin/books/old/file', { path: 'manuscript/c00005.md', content: '第五章，主人从文件编辑器改的。', baseSha: blob })).statusCode).toBe(200);
  });

  it('PATCH: the title can change, the status cannot (409 legacy_book)', async () => {
    const r = await admin('PATCH', '/api/admin/books/old', { title: '旧书（改名）' });
    expect(r.statusCode).toBe(200);
    expect(r.json().title).toBe('旧书（改名）');
    for (const status of ['active', 'paused', 'archived']) {
      const s = await admin('PATCH', '/api/admin/books/old', { status });
      expect(s.statusCode, status).toBe(409);
      expect(s.json().code).toBe('legacy_book');
    }
    expect((await t.deps.db.select().from(books).where(eq(books.slug, 'old')))[0]).toMatchObject({ status: 'paused', pausedReason: 'import' });
    expect((await admin('PATCH', '/api/admin/books/old', { title: '旧书' })).statusCode).toBe(200);
  });

  it('start / resume / publish now / chapter actions → 409 legacy_book; reindex still works', async () => {
    for (const action of ['start', 'resume']) {
      const r = await admin('POST', '/api/admin/books/old/actions', { action });
      expect(r.statusCode, action).toBe(409);
      expect(r.json().code).toBe('legacy_book');
    }
    const pub = await admin('POST', '/api/admin/books/old/publish/now', { through: 5 });
    expect(pub.statusCode).toBe(409);
    expect(pub.json().code).toBe('legacy_book');
    const act = await admin('POST', '/api/admin/books/old/chapters/4/actions', { action: 'publish_now' });
    expect(act.statusCode).toBe(409);
    expect((await admin('POST', '/api/admin/books/old/actions', { action: 'reindex' })).statusCode).toBe(200);
    const row = (await t.deps.db.select().from(books).where(eq(books.slug, 'old')))[0];
    expect(row).toMatchObject({ status: 'paused', pausedReason: 'import', publishedThrough: 3 });
  });

  it('scheduler tick proposes nothing for a legacy book left active, and the publisher skips it', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'old-active', { chapters: 4, published: 0, status: 'active', pausedReason: null });
    const sched = createScheduler({ db: t.deps.db, config: t.deps.config, paths: t.deps.paths, log: t.deps.log, bus: t.deps.bus, secrets: t.deps.secrets, owner: `${os.hostname()}:${process.pid}` });
    await sched.tick();
    await sched.stop();
    expect(await t.deps.db.select().from(tasks).where(eq(tasks.bookId, 'book-old-active'))).toEqual([]);
    expect((await t.deps.db.select().from(books).where(eq(books.slug, 'old-active')))[0]).toMatchObject({ status: 'active', pausedReason: null, publishedThrough: 0 });
  });

  it('delete moves the directory to $DATA/trash/books/<slug>-* with a tombstone; the row is gone', async () => {
    await createLegacyBook(t.deps.db, t.deps.paths, 'old-del');
    expect((await admin('DELETE', '/api/admin/books/old-del?confirm=old-del')).statusCode).toBe(200);
    const dirs = (await fs.readdir(path.join(t.deps.paths.root, 'trash', 'books'))).filter((d) => d.startsWith('old-del-'));
    expect(dirs).toHaveLength(1);
    const tomb = JSON.parse(await fs.readFile(path.join(t.deps.paths.root, 'trash', 'books', dirs[0] as string, TRASH_TOMBSTONE), 'utf8'));
    expect(tomb).toMatchObject({ kind: 'books', slug: 'old-del', id: 'book-old-del', meta: { v1: { id: 7 } }, acceptedThrough: 3 });
    expect(await fs.readFile(path.join(t.deps.paths.root, 'trash', 'books', dirs[0] as string, 'manuscript', 'c00001.md'), 'utf8')).toContain('第1章');
    expect(await t.deps.db.select().from(books).where(eq(books.slug, 'old-del'))).toEqual([]);
    expect(await t.deps.db.select().from(chapters).where(eq(chapters.bookId, 'book-old-del'))).toEqual([]);
  });
});

describe('legacy book whose directory is missing', () => {
  it('list, overview, chapters, chapter detail and reader book answer 200; reader text and export answer 404 book_dir_missing; delete answers 200 and moves nothing', async () => {
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'nodir', { chapters: 2, published: 2 });
    await fs.rename(b.dir, path.join(t.deps.paths.root, 'moved-away'));
    expect((await admin('GET', '/api/admin/books')).statusCode).toBe(200);
    const ov = await admin('GET', '/api/admin/books/nodir');
    expect(ov.statusCode).toBe(200);
    expect(ov.json()).toMatchObject({ dirMissing: true, recentCommits: [], config: null });
    expect((await admin('GET', '/api/admin/books/nodir/chapters')).json().items).toHaveLength(2);
    const detail = await admin('GET', '/api/admin/books/nodir/chapters/1');
    expect(detail.statusCode).toBe(200);
    expect(detail.json().text).toBeNull();
    const rb = await admin('GET', '/api/reader/books/nodir');
    expect(rb.statusCode).toBe(200);
    expect(rb.json().volumes[0].chapters).toHaveLength(2);
    for (const url of ['/api/reader/books/nodir/chapters/1', '/api/reader/books/nodir/export.txt', '/api/reader/books/nodir/export.epub']) {
      const r = await admin('GET', url);
      expect(r.statusCode, url).toBe(404);
      expect(r.json().code, url).toBe('book_dir_missing');
    }
    const trashBefore = await fs.readdir(path.join(t.deps.paths.root, 'trash', 'books')).catch(() => [] as string[]);
    expect((await admin('DELETE', '/api/admin/books/nodir?confirm=nodir')).statusCode).toBe(200);
    expect(await fs.readdir(path.join(t.deps.paths.root, 'trash', 'books')).catch(() => [] as string[])).toEqual(trashBefore);
    expect(await t.deps.db.select().from(books).where(eq(books.slug, 'nodir'))).toEqual([]);
  });
});
