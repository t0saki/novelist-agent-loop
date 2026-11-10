/** 题材包删除 / 停用（p1-plan C9、§6 genres.delete）：删除是移进回收站 + 墓碑，不做不可恢复的删除。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zSystemSettings } from '@novelist/shared';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { openRepo } from '../book/index.js';
import { books } from '../db/schema.js';
import { REMOVED_BUILTIN_FILE, createGenre, genreTrashDir, listGenres, loadGenre, seedBuiltinGenres } from '../genres/index.js';
import { maybeStartBook } from '../services/auto-start.js';
import { createBook } from '../services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';

let t: TestApp;
let cookie: string;

const admin = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const summary = async (id: string) => ((await admin('GET', '/api/admin/genres')).json() as { id: string; hidden: boolean; books: number }[]).find((g) => g.id === id);
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('genre pack delete / hide', () => {
  it('builtin pack deletable when unused, tombstoned, not re-seeded on next boot', async () => {
    const genres = t.deps.paths.genres;
    expect(await exists(path.join(genres, 'romance', 'pack.yaml'))).toBe(true);
    const res = await admin('DELETE', '/api/admin/genres/romance');
    expect(res.statusCode).toBe(200);
    expect(await exists(path.join(genres, 'romance'))).toBe(false);
    // 目录在回收站里，文件完整
    const trashed = (await fs.readdir(genreTrashDir(t.deps.paths))).filter((n) => n.startsWith('romance-'));
    expect(trashed).toHaveLength(1);
    expect(yamlParse(await fs.readFile(path.join(genreTrashDir(t.deps.paths), trashed[0]!, 'pack.yaml'), 'utf8')).id).toBe('romance');
    // 墓碑随删除一起提交
    expect((await fs.readFile(path.join(genres, REMOVED_BUILTIN_FILE), 'utf8')).split('\n')).toContain('romance');
    const repo = openRepo(genres);
    expect(await repo.isClean()).toBe(true);
    const head = (await repo.log({ limit: 1 })).items[0];
    expect(head?.subject).toBe('genres: delete romance');
    expect(head?.trailers['Novelist-Owner-Edit']).toBe('true');
    // 下次启动不再拷回
    expect(await seedBuiltinGenres(t.deps.paths)).not.toContain('romance');
    expect(await exists(path.join(genres, 'romance'))).toBe(false);
    expect(await summary('romance')).toBeUndefined();
    // 其他被删的内置包照常补种（墓碑只挡记下的 id）
    await fs.rename(path.join(genres, 'urban'), path.join(t.deps.paths.tmp, 'urban-moved'));
    expect(await seedBuiltinGenres(t.deps.paths)).toEqual(['urban']);
  });

  it('in-use pack → 409 genre_in_use', async () => {
    await createBook(t.deps, { title: '科幻书', slug: 'g-scifi', genre: 'scifi', start: false });
    const res = await admin('DELETE', '/api/admin/genres/scifi');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('genre_in_use');
    expect(res.json().title).toBe('还有 1 本书使用这个题材包，可以停用');
    expect(await exists(path.join(t.deps.paths.genres, 'scifi', 'pack.yaml'))).toBe(true);
  });

  it('non-canonical ids (./scifi, scifi/, ../genres/scifi) are 404 and do not bypass the in-use check', async () => {
    for (const raw of ['.%2Fscifi', 'scifi%2F', '..%2Fgenres%2Fscifi']) {
      const del = await admin('DELETE', `/api/admin/genres/${raw}`);
      expect(del.statusCode, raw).toBe(404);
      const vis = await admin('POST', `/api/admin/genres/${raw}/visibility`, { hidden: true });
      expect(vis.statusCode, raw).toBe(404);
    }
    expect(await exists(path.join(t.deps.paths.genres, 'scifi', 'pack.yaml'))).toBe(true);
    expect(yamlParse(await fs.readFile(path.join(t.deps.paths.genres, 'scifi', 'pack.yaml'), 'utf8')).hidden).toBeUndefined();
  });

  it('extended pack → 409 genre_extended', async () => {
    const res = await admin('DELETE', '/api/admin/genres/generic');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('genre_extended');
    expect(await exists(path.join(t.deps.paths.genres, 'generic', 'pack.yaml'))).toBe(true);
    // 非内置包也一样
    await createGenre(t.deps.paths, { id: 'base-x', name: '基', extends: [] });
    await createGenre(t.deps.paths, { id: 'child-x', name: '子', extends: ['base-x'] });
    expect((await admin('DELETE', '/api/admin/genres/base-x')).json().code).toBe('genre_extended');
    expect((await admin('DELETE', '/api/admin/genres/child-x')).statusCode).toBe(200);
    expect((await admin('DELETE', '/api/admin/genres/base-x')).statusCode).toBe(200);
    // 非内置包不记墓碑
    expect((await fs.readFile(path.join(t.deps.paths.genres, REMOVED_BUILTIN_FILE), 'utf8')).split('\n')).not.toContain('base-x');
    expect((await admin('DELETE', '/api/admin/genres/nope')).statusCode).toBe(404);
  });

  it('hide/unhide in-use pack; hidden pack still resolves for existing books', async () => {
    const file = path.join(t.deps.paths.genres, 'scifi', 'pack.yaml');
    const hide = await admin('POST', '/api/admin/genres/scifi/visibility', { hidden: true });
    expect(hide.statusCode).toBe(200);
    expect(hide.json()).toMatchObject({ id: 'scifi', hidden: true, books: 1 });
    const text = await fs.readFile(file, 'utf8');
    expect(yamlParse(text).hidden).toBe(true);
    // 注释保留，提交带 owner trailer
    expect(text.startsWith('#')).toBe(true);
    const head = (await openRepo(t.deps.paths.genres).log({ limit: 1 })).items[0];
    expect(head?.subject).toBe('genres: hide scifi');
    expect(head?.trailers['Novelist-Owner-Edit']).toBe('true');
    expect((await summary('scifi'))?.hidden).toBe(true);
    // 已有的书照常解析题材链、打开概览
    expect((await loadGenre(t.deps.paths, 'scifi')).chain.map((g) => g.id)).toEqual(['generic', 'scifi']);
    expect((await admin('GET', '/api/admin/books/g-scifi')).statusCode).toBe(200);
    // 停用后仍然不能删
    expect((await admin('DELETE', '/api/admin/genres/scifi')).statusCode).toBe(409);
    const unhide = await admin('POST', '/api/admin/genres/scifi/visibility', { hidden: false });
    expect(unhide.json().hidden).toBe(false);
    expect(yamlParse(await fs.readFile(file, 'utf8')).hidden).toBeUndefined();
    expect((await admin('POST', '/api/admin/genres/nope/visibility', { hidden: true })).statusCode).toBe(404);
    expect((await admin('POST', '/api/admin/genres/scifi/visibility', {})).statusCode).toBe(400);
  });

  it('hidden flag survives seedBuiltinGenres', async () => {
    expect((await admin('POST', '/api/admin/genres/xianxia/visibility', { hidden: true })).statusCode).toBe(200);
    expect(await seedBuiltinGenres(t.deps.paths)).toEqual([]);
    expect((await listGenres(t.deps.paths)).find((p) => p.id === 'xianxia')?.hidden).toBe(true);
    expect((await admin('POST', '/api/admin/genres/xianxia/visibility', { hidden: false })).statusCode).toBe(200);
  });

  it('auto-start pack filter skips hidden packs', async () => {
    await createGenre(t.deps.paths, { id: 'p-auto', name: '自动', extends: [] });
    const file = path.join(t.deps.paths.genres, 'p-auto', 'pack.yaml');
    await fs.writeFile(file, yamlStringify({ ...yamlParse(await fs.readFile(file, 'utf8')), auto: { enabled: true } }), 'utf8');
    // 只在内存里打开自动开书，不写 settings
    const on = zSystemSettings.parse({ autoStart: { enabled: true, maxActiveBooks: 9, maxPerDay: 0 } });
    const now = new Date('2026-11-10T00:00:00Z');
    expect((await admin('POST', '/api/admin/genres/p-auto/visibility', { hidden: true })).statusCode).toBe(200);
    expect(await maybeStartBook(t.deps, now, on)).toBeNull();
    // settings 里显式列出也不用停用的包
    expect(await maybeStartBook(t.deps, now, zSystemSettings.parse({ autoStart: { enabled: true, maxActiveBooks: 9, maxPerDay: 0, genres: ['p-auto'] } }))).toBeNull();
    expect((await admin('POST', '/api/admin/genres/p-auto/visibility', { hidden: false })).statusCode).toBe(200);
    const slug = await maybeStartBook(t.deps, now, on);
    expect(slug).not.toBeNull();
    expect((await t.deps.db.select().from(books).where(eq(books.slug, slug!)))[0]?.genre).toBe('p-auto');
  });
});
