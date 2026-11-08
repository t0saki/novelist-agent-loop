import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { bookEvents, books, chapters, readers, readingProgress, v1ImportMap } from '../db/schema.js';
import { createTestApp, type TestApp } from '../testing.js';
import { buildEpub, buildTxt } from './export.js';
import { hashPassword, passwordLookupId, verifyPassword } from './passwords.js';
import { decrypt, encrypt, loadMasterKey, parseMasterKey } from './secrets.js';
import { previewV1, startV1Import, type V1Connect } from './v1-import.js';
import { createBackup, restoreBackup } from './backup.js';
import { createBook } from './books.js';

describe('passwords', () => {
  it('argon2id round trip', async () => {
    const h = await hashPassword('secret');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword('secret', h)).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword('nope', h)).ok).toBe(false);
  });

  it('verifies v1 pbkdf2 hashes and asks for rehash', async () => {
    // hashlib.pbkdf2_hmac('sha256', b'hunter2', bytes.fromhex('00112233445566778899aabbccddeeff'), 1000).hex()
    const { pbkdf2Sync } = await import('node:crypto');
    const salt = '00112233445566778899aabbccddeeff';
    const dk = pbkdf2Sync('hunter2', Buffer.from(salt, 'hex'), 1000, 32, 'sha256').toString('hex');
    expect(await verifyPassword('hunter2', `pbkdf2$1000$${salt}$${dk}`)).toEqual({ ok: true, needsRehash: true });
    expect((await verifyPassword('wrong', `pbkdf2$1000$${salt}$${dk}`)).ok).toBe(false);
    expect((await verifyPassword('x', 'garbage')).ok).toBe(false);
  });

  it('lookup id is a stable HMAC prefix', () => {
    expect(passwordLookupId('k', 'pw')).toBe(passwordLookupId('k', 'pw'));
    expect(passwordLookupId('k', 'pw')).not.toBe(passwordLookupId('k2', 'pw'));
    expect(passwordLookupId('k', 'pw')).toHaveLength(16);
  });
});

describe('secrets crypto', () => {
  it('encrypt/decrypt with AAD binding', () => {
    const key = randomBytes(32);
    const blob = encrypt(key, Buffer.from('hello'), 'aad-1');
    expect(decrypt(key, blob, 'aad-1').toString()).toBe('hello');
    expect(() => decrypt(key, blob, 'aad-2')).toThrow();
    expect(() => decrypt(randomBytes(32), blob, 'aad-1')).toThrow();
  });

  it('master key loading: hex, base64, generated file (0600)', async () => {
    const hex = randomBytes(32).toString('hex');
    expect(parseMasterKey(hex)).toHaveLength(32);
    expect(() => parseMasterKey('short')).toThrow();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-mk-'));
    const keyFile = path.join(dir, '.master_key');
    const g = await loadMasterKey({ envValue: null, keyFile });
    expect(g.source).toBe('generated');
    expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
    const again = await loadMasterKey({ envValue: null, keyFile });
    expect(again.source).toBe('file');
    expect(again.key.equals(g.key)).toBe(true);
    await fs.rm(dir, { recursive: true });
  });
});

describe('exports', () => {
  const book = { slug: 's', title: '书<名>', author: 'A', blurb: 'b', chapters: [{ no: 1, title: '第一章', volumeTitle: '卷一', text: '段落一\n\n# 标题行\n段落二 & <x>' }] };
  it('epub escapes xml and is well-formed', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await buildEpub(book));
    const opf = (await zip.file('OEBPS/content.opf')?.async('string')) as string;
    expect(opf).toContain('书&lt;名&gt;');
    const ch = (await zip.file('OEBPS/c00001.xhtml')?.async('string')) as string;
    expect(ch).toContain('段落二 &amp; &lt;x&gt;');
    expect(ch).not.toContain('标题行');
  });
  it('txt groups by volume', () => {
    const txt = buildTxt(book);
    expect(txt).toContain('【卷一】');
    expect(txt).toContain('第一章');
    expect(txt).toContain('　　段落一');
  });
});

describe('v1 import', () => {
  let t: TestApp;
  let v1: PGlite;
  const connect: V1Connect = async () => ({ query: (async (text: string, params?: unknown[]) => v1.query(text, params as never[])) as never, end: async () => {} });

  beforeAll(async () => {
    t = await createTestApp();
    v1 = new PGlite();
    await v1.exec(`
      create table themes (id int primary key, name text, keywords json, style_prompt text, length_hint text, min_chapters int, weight real, nsfw boolean, enabled boolean);
      create table novels (id int primary key, slug text, title text, status text, theme_id int, theme_name text, language text, nsfw boolean, premise text, synopsis text, tone text, target_audience text, planned_chapters int, target_chapter_words int, volumes json, bible json, outline json, rolling_summary text, quality_debt json, word_count int, cover_path text, updated_at timestamp, completed_at timestamp);
      create table chapters (id serial primary key, novel_id int, index int, title text, content text, word_count int, summary text, status text, updated_at timestamp);
      create table reader_passwords (id int primary key, label text, password_hash text, enabled boolean);
      create table reading_progress (reader_id text, novel_id int, chapter_index int, scroll real, updated_at timestamp);
      insert into themes values (1, '仙侠', '["修仙"]', '写得飘逸一点', '', null, 1, false, true);
      insert into novels values
        (1, 'sword-song', '剑歌', 'writing', 1, '仙侠', 'zh', false, '一个少年', '少年的故事', '热血', '大众', 3, 3000, '[{"title":"第一卷","chapter_count":2},{"title":"第二卷","chapter_count":1}]', '{"chars":[]}', '{"arc":1}', '滚动摘要', '[]', 300, null, now(), null),
        (2, 'done-book', '完结书', 'completed', null, '', 'zh', false, '', '', '', '', 1, 3000, '[]', '{}', '{}', '', '[]', 100, null, now(), now());
      insert into chapters (novel_id, index, title, content, word_count, summary, status, updated_at) values
        (1, 1, '开端', '第一章正文，少年出发。', 10, 'sum1', 'done', now()),
        (1, 2, '继续', '第二章正文，少年修炼。', 10, 'sum2', 'done', now()),
        (1, 3, '未完', '第三章半成品', 5, '', 'writing', now()),
        (2, 1, '终章', '完结书第一章。', 5, '', 'done', now());
    `);
    const { pbkdf2Sync } = await import('node:crypto');
    const dk = pbkdf2Sync('v1-reader-pw', Buffer.from('aabb', 'hex'), 1000, 32, 'sha256').toString('hex');
    await v1.query(`insert into reader_passwords values (7, '老读者', $1, true)`, [`pbkdf2$1000$aabb$${dk}`]);
    await v1.exec(`insert into reading_progress values ('reader:7', 1, 2, 0.5, now()), ('reader:99', 1, 1, 0, now())`);
  }, 60_000);

  afterAll(async () => {
    await v1.close();
    await t.close();
  });

  it('preview lists novels', async () => {
    const p = await previewV1('postgresql://x/novelist', { connect });
    expect(p.ok).toBe(true);
    expect(p.novels).toHaveLength(2);
    expect(p.novels[0]).toMatchObject({ slug: 'sword-song', chapters: 3, doneChapters: 2 });
    expect(p.readers).toBe(1);
    expect(p.progressRows).toBe(2);
    expect(p.source).not.toContain('@');
  });

  it('imports readers, books, progress and is idempotent', async () => {
    const job = await startV1Import(t.deps, { databaseUrl: 'postgresql://u:p@h/novelist', novels: 'all', readers: true, themes: true, includeDrafts: false, bootstrapExtract: false }, { connect, wait: true });
    const { getV1Job } = await import('./v1-import.js');
    const done = await getV1Job(t.deps, job.id);
    expect(done.state).toBe('done');
    expect(done.report?.books).toHaveLength(2);
    expect(done.report?.books.find((b) => b.slug === 'sword-song')).toEqual({ slug: 'sword-song', chapters: 2, dropped: 1 });

    const row = (await t.deps.db.select().from(books).where(eq(books.slug, 'sword-song')))[0];
    expect(row?.status).toBe('paused');
    expect(row?.acceptedThrough).toBe(2);
    expect(row?.publishedThrough).toBe(2);
    const archived = (await t.deps.db.select().from(books).where(eq(books.slug, 'done-book')))[0];
    expect(archived?.status).toBe('archived');
    expect(archived?.genre).toBe('v1-imported');

    const repoFile = await fs.readFile(path.join(t.dataDir, 'books/sword-song/manuscript/c00001.md'), 'utf8');
    expect(repoFile).toContain('少年出发');
    expect(await fs.readFile(path.join(t.dataDir, 'books/sword-song/plan/volumes/v02.yaml'), 'utf8')).toContain('第二卷');
    const chs = await t.deps.db.select().from(chapters).where(and(eq(chapters.bookId, row?.id as string), eq(chapters.no, 1)));
    expect(chs[0]?.volume).toBe('v01');
    expect(chs[0]?.publishedAt).toBeTruthy();

    const reader = (await t.deps.db.select().from(readers).where(eq(readers.v1Id, 7)))[0];
    expect(reader?.legacy).toBe(true);
    expect(reader?.lookupId).toBeNull();
    const progress = await t.deps.db.select().from(readingProgress).where(eq(readingProgress.readerId, reader?.id as string));
    expect(progress[0]?.no).toBe(2);

    // 第二次导入：什么都不变
    const before = (await t.deps.db.select().from(v1ImportMap)).length;
    const again = await startV1Import(t.deps, { databaseUrl: 'postgresql://u:p@h/novelist', novels: 'all', readers: true, themes: true, includeDrafts: false, bootstrapExtract: false }, { connect, wait: true });
    const r2 = await getV1Job(t.deps, again.id);
    expect(r2.state).toBe('done');
    expect(r2.report?.books).toHaveLength(0);
    expect((await t.deps.db.select().from(v1ImportMap)).length).toBe(before);
  });

  it('legacy reader logs in with the v1 password once, then is upgraded to argon2id', async () => {
    const app = t.app;
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'v1-reader-pw' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('reader');
    const reader = (await t.deps.db.select().from(readers).where(eq(readers.v1Id, 7)))[0];
    expect(reader?.legacy).toBe(false);
    expect(reader?.pwHash.startsWith('$argon2id$')).toBe(true);
    expect(reader?.lookupId).toBeTruthy();
    const again = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'v1-reader-pw' } });
    expect(again.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'bad' } })).statusCode).toBe(401);
  });
});

describe('backup / restore', () => {
  it('逻辑导出后恢复，书与账号数据还原', async () => {
    const app = await createTestApp();
    try {
      const { deps } = app;
      const book = await createBook(deps, { title: '备份测试', genre: 'xianxia', seed: '种子', start: false });
      const out = path.join(deps.paths.tmp, 'backup.tar.gz');
      const backup = await createBackup(deps, out);
      expect(backup.tables.books).toBe(1);
      await deps.db.delete(books);
      await fs.rm(path.join(deps.paths.books, book.slug), { recursive: true, force: true });
      // 模拟恢复到新库：序列从头开始
      await deps.db.execute(sql.raw(`select setval(pg_get_serial_sequence('book_events', 'id'), 1, false)`));
      const restored = await restoreBackup(deps, out);
      expect(restored.tables.books).toBe(1);
      await deps.db.insert(bookEvents).values({ bookId: 'restored', kind: 'after.restore', body: {} });
      expect(await deps.db.select().from(books)).toHaveLength(1);
      await expect(fs.stat(path.join(deps.paths.books, book.slug, 'book.yaml'))).resolves.toBeTruthy();
    } finally {
      await app.close();
    }
  }, 60_000);
});
