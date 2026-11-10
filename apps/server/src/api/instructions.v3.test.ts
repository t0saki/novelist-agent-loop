/** v3 书保存书层指令时检查根 AGENTS.md 的大小（p1-plan §3 WP-C、§6 instructions.v3）。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { openRepo, P } from '../book/index.js';
import { createGenre } from '../genres/index.js';
import { V3_AGENTS_SOFT_LIMIT } from '../instructions/v3.js';
import { createBook } from '../services/books.js';
import { createLegacyBook } from '../book/testing-legacy.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';
import { bookDir } from './helpers.js';

let t: TestApp;
let cookie: string;

const put = (slug: string, path: string, content: string) =>
  t.app.inject({ method: 'PUT', url: '/api/admin/instructions/file', headers: { cookie }, payload: { scope: `book:${slug}`, path, content, baseSha: null } });

const BIG = `${'本书的写法要求：多写对白，少写旁白。\n'.repeat(Math.ceil(V3_AGENTS_SOFT_LIMIT / 40))}`;

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  await createBook(t.deps, { title: '新', slug: 'iv3', genre: 'xianxia', flow: 'v3', start: false });
  // 旧书（P3）：不做 v3 的指令体积检查
  await createLegacyBook(t.deps.db, t.deps.paths, 'iv2', { title: '旧' });
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('v3 instruction size check', () => {
  it('saving book layer that makes AGENTS.md > 16KB for a v3 book → 400 with layer sizes', async () => {
    expect(Buffer.byteLength(BIG, 'utf8')).toBeGreaterThan(V3_AGENTS_SOFT_LIMIT);
    const before = await openRepo(bookDir(t.deps, 'iv3')).readFile(P.instructionsAgents);
    const res = await put('iv3', P.instructionsAgents, BIG);
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('instructions_too_large');
    const layers = (body.errors as { path: string; message: string }[]).map((e) => e.path);
    expect(layers).toContain('S0');
    expect(layers).toContain('L3');
    expect(body.detail).toContain('字节');
    // 书库没被改
    expect(await openRepo(bookDir(t.deps, 'iv3')).readFile(P.instructionsAgents)).toBe(before);
    // 角色文件也算在内
    expect((await put('iv3', 'instructions/roles/writer.md', BIG)).statusCode).toBe(400);
    // 正常大小照常保存
    const ok = await put('iv3', P.instructionsAgents, '多写对白。\n');
    expect(ok.statusCode).toBe(200);
    expect(await openRepo(bookDir(t.deps, 'iv3')).readFile(P.instructionsAgents)).toBe('多写对白。\n');
  });

  it('nv:include of a file elsewhere in the book renders against the real book; included style files are measured; a missing include is a 400', async () => {
    expect((await put('iv3', 'style/voice.md', '语气克制。\n')).statusCode).toBe(200);
    const withInclude = '多写对白。\n<!-- nv:include ../style/voice.md -->\n';
    const ok = await put('iv3', P.instructionsAgents, withInclude);
    expect(ok.statusCode).toBe(200);
    // 其它指令文件照常能存
    expect((await put('iv3', 'instructions/roles/writer.md', '写作者要点。\n')).statusCode).toBe(200);
    // 被引用的 style 文件变大：同样拒收
    const big = await put('iv3', 'style/voice.md', BIG);
    expect(big.statusCode).toBe(400);
    expect(big.json().code).toBe('instructions_too_large');
    const missing = await put('iv3', P.instructionsAgents, '<!-- nv:include ../style/nope.md -->\n');
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('instruction_include');
    expect(await openRepo(bookDir(t.deps, 'iv3')).readFile(P.instructionsAgents)).toBe(withInclude);
  });

  it('v2 book unaffected', async () => {
    const res = await put('iv2', P.instructionsAgents, BIG);
    expect(res.statusCode).toBe(200);
    expect(await openRepo(bookDir(t.deps, 'iv2')).readFile(P.instructionsAgents)).toBe(BIG);
  });
});

describe('v3 size check on global and genre saves (WP-3)', () => {
  const putScope = (scope: string, p: string, content: string) => t.app.inject({ method: 'PUT', url: '/api/admin/instructions/file', headers: { cookie }, payload: { scope, path: p, content, baseSha: null } });
  const globalFile = () => fs.readFile(path.join(t.deps.paths.instructionsGlobal, 'AGENTS.md'), 'utf8').catch(() => null);
  const genreFile = (id: string) => fs.readFile(path.join(t.deps.paths.genres, id, 'AGENTS.md'), 'utf8').catch(() => null);
  const setAuto = async (id: string, auto: Record<string, unknown> | null) => {
    const file = path.join(t.deps.paths.genres, id, 'pack.yaml');
    const { auto: _old, ...pack } = yamlParse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(file, yamlStringify({ ...pack, ...(auto ? { auto } : {}) }), 'utf8');
  };

  it('a global save that pushes a v3 book over 16 KB → 400 with the book and the layer sizes; nothing written, nothing truncated', async () => {
    const before = await globalFile();
    const res = await putScope('global', 'AGENTS.md', BIG);
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('instructions_too_large');
    expect(body.message ?? body.title ?? JSON.stringify(body)).toContain('《新》');
    expect((body.errors as { path: string }[]).map((e) => e.path)).toContain('L1');
    expect(await globalFile()).toBe(before);
    // 一个小改动照常保存，原样写入
    const ok = await putScope('global', 'AGENTS.md', '全局：多写对白。\n');
    expect(ok.statusCode).toBe(200);
    expect(await globalFile()).toBe('全局：多写对白。\n');
  });

  it('a genre save is checked against the books of that genre and a new book of every length for an auto-start pack', async () => {
    // 题材 xianxia：《新》在用
    const used = await putScope('genre:xianxia', 'AGENTS.md', BIG);
    expect(used.statusCode).toBe(400);
    expect(JSON.stringify(used.json())).toContain('《新》');
    // 没有书在用、但自动开书能选到的题材包：按“新书”检查
    await createGenre(t.deps.paths, { id: 'p-auto', name: '自动包', extends: [] });
    await setAuto('p-auto', { enabled: true });
    const tpl = await genreFile('p-auto');
    const auto = await putScope('genre:p-auto', 'AGENTS.md', BIG);
    expect(auto.statusCode).toBe(400);
    expect(auto.json().code).toBe('instructions_too_large');
    expect(JSON.stringify(auto.json())).toMatch(/题材「自动包」的新书（(短篇|中篇|长篇|超长)）/);
    expect(await genreFile('p-auto')).toBe(tpl);
    // 权重 0 = 自动开书选不到：不再检查
    await setAuto('p-auto', { enabled: true, weight: 0 });
    const zero = await putScope('genre:p-auto', 'AGENTS.md', BIG);
    expect(zero.statusCode).toBe(200);
    expect(await genreFile('p-auto')).toBe(BIG);
  });

  it('a large pack that no v3 book uses and auto-start cannot pick does not block a global save; a genre save affecting nothing passes', async () => {
    await createGenre(t.deps.paths, { id: 'p-big', name: '大包', extends: [] });
    const big = await putScope('genre:p-big', 'AGENTS.md', BIG);
    expect(big.statusCode).toBe(200);
    expect(await genreFile('p-big')).toBe(BIG);
    const g = await putScope('global', 'AGENTS.md', '全局：少写旁白。\n');
    expect(g.statusCode).toBe(200);
    // 非 .md 文件不量
    expect((await putScope('global', 'notes.txt', BIG)).statusCode).toBe(200);
  });
});

describe('v2-only install: global saves are not size-checked (WP-3)', () => {
  it('a big global AGENTS.md saves when there is no v3 book and no auto-start pack', async () => {
    const t2 = await createTestApp();
    try {
      const r = await t2.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
      const c2 = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
      await createLegacyBook(t2.deps.db, t2.deps.paths, 'only-v2', { title: '旧' });
      const res = await t2.app.inject({ method: 'PUT', url: '/api/admin/instructions/file', headers: { cookie: c2 }, payload: { scope: 'global', path: 'AGENTS.md', content: BIG, baseSha: null } });
      expect(res.statusCode).toBe(200);
      expect(await fs.readFile(path.join(t2.deps.paths.instructionsGlobal, 'AGENTS.md'), 'utf8')).toBe(BIG);
    } finally {
      await t2.close();
    }
  }, 60_000);
});

describe('global / genre / book saves only reject what the save itself breaks (before/after)', () => {
  it('a target already over 16 KB or already failing to render does not lock the global layer; growing it is still rejected; a book layer can be shrunk in steps', async () => {
    const t3 = await createTestApp();
    try {
      const r = await t3.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
      const c3 = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
      const putAs = (scope: string, p: string, content: string) => t3.app.inject({ method: 'PUT', url: '/api/admin/instructions/file', headers: { cookie: c3 }, payload: { scope, path: p, content, baseSha: null } });
      await createBook(t3.deps, { title: '超', slug: 'over', genre: 'xianxia', flow: 'v3', start: false });
      await createBook(t3.deps, { title: '坏', slug: 'broken', genre: 'xianxia', flow: 'v3', start: false });
      // 绕过 API 写进书目录：一本已超标，一本的 include 已经坏了
      const overFile = path.join(bookDir(t3.deps, 'over'), P.instructionsAgents);
      await fs.writeFile(overFile, BIG + BIG.slice(0, 2000), 'utf8');
      await fs.writeFile(path.join(bookDir(t3.deps, 'broken'), P.instructionsAgents), '<!-- nv:include ../style/nope.md -->\n', 'utf8');
      await fs.mkdir(t3.deps.paths.instructionsGlobal, { recursive: true });
      await fs.writeFile(path.join(t3.deps.paths.instructionsGlobal, 'AGENTS.md'), '全局：一句话。还有第二句。\n', 'utf8');
      // 和这两本书无关的小改动（全局层不变大）：照收
      const small = await putAs('global', 'AGENTS.md', '全局：一句话。\n');
      expect(small.statusCode, JSON.stringify(small.json())).toBe(200);
      // 让全局层变大：《超》更大了 → 拒收，消息带保存前的字节数
      const grow = await putAs('global', 'AGENTS.md', `全局：一句话。\n${'再多写一点。\n'.repeat(50)}`);
      expect(grow.statusCode).toBe(400);
      expect(grow.json().code).toBe('instructions_too_large');
      expect(JSON.stringify(grow.json())).toMatch(/《超》.*保存前 \d+ 字节/);
      // 书层：一步步缩短，仍超标也照收；再变大拒收
      expect((await putAs('book:over', P.instructionsAgents, BIG)).statusCode).toBe(200);
      expect((await putAs('book:over', P.instructionsAgents, `${BIG}再多一行。\n`)).statusCode).toBe(400);
    } finally {
      await t3.close();
    }
  }, 60_000);
});

describe('instruction preview (v3, P3 WP-3)', () => {
  const preview = (payload: unknown) => t.app.inject({ method: 'POST', url: '/api/admin/instructions/preview', headers: { cookie }, payload: payload as object });

  it('by book: the same AGENTS.md the run gets (genre chain, length, book layer), with layer sizes; drafts override the disk', async () => {
    const res = await preview({ book: 'iv3' });
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json() as { text: string; bytes: number; limit: number; over: boolean; layers: { id: string; bytes: number }[] };
    expect(p.limit).toBe(V3_AGENTS_SOFT_LIMIT);
    expect(p.over).toBe(false);
    expect(p.bytes).toBe(Buffer.byteLength(p.text, 'utf8'));
    expect(p.layers.map((l) => l.id)).toEqual(expect.arrayContaining(['S0', 'S1', 'L3']));
    expect(p.text).toContain('篇幅要领');
    const drafted = (await preview({ book: 'iv3', drafts: { 'book:iv3:instructions/AGENTS.md': '本书草稿：多写海边的雾。' } })).json();
    expect(drafted.text).toContain('本书草稿：多写海边的雾。');
    expect(drafted.layers.find((l: { id: string }) => l.id === 'L3')?.bytes).toBe(Buffer.byteLength('本书草稿：多写海边的雾。'));
    // 草稿只是预览：书库没变
    expect(await openRepo(bookDir(t.deps, 'iv3')).readFile(P.instructionsAgents)).not.toContain('海边的雾');
    const big = (await preview({ book: 'iv3', drafts: { 'book:iv3:instructions/AGENTS.md': BIG } })).json();
    expect(big.over).toBe(true);
  });

  it('by genre + length (an empty book directory); a genre draft shows up; legacy book → 409; neither book nor genre → 400', async () => {
    const p = (await preview({ genre: 'xianxia', length: 'epic', drafts: { 'genre:xianxia:AGENTS.md': '题材草稿：修炼体系要自洽。' } })).json();
    expect(p.text).toContain('超长');
    expect(p.text).toContain('题材草稿：修炼体系要自洽。');
    expect(p.layers.map((l: { id: string }) => l.id)).toContain('L2:xianxia');
    const legacy = await preview({ book: 'iv2' });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json().code).toBe('legacy_book');
    expect((await preview({})).statusCode).toBe(400);
    expect((await preview({ genre: 'no-such' })).statusCode).toBe(404);
  });

  it('the builtin scope is the read-only viewer of the length layer', async () => {
    const files = (await t.app.inject({ method: 'GET', url: '/api/admin/instructions/files?scope=builtin', headers: { cookie } })).json() as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(['v3/contract.md', 'v3/length-short.md', 'v3/length-medium.md', 'v3/length-long.md', 'v3/length-epic.md', 'roles/writer.md']));
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/instructions/file?scope=builtin&path=v3/length-long.md', headers: { cookie } })).statusCode).toBe(200);
    const w = await t.app.inject({ method: 'PUT', url: '/api/admin/instructions/file', headers: { cookie }, payload: { scope: 'builtin', path: 'v3/length-long.md', content: 'x', baseSha: null } });
    expect(w.statusCode).toBe(403);
  });
});

describe('overLimit', () => {
  it('after > 16 KB and (before ≤ 16 KB, unknown, or after > before)', async () => {
    const { overLimit } = await import('./routes/admin/instructions.js');
    const L = V3_AGENTS_SOFT_LIMIT;
    expect(overLimit(L - 10, L + 1)).toBe(true);
    expect(overLimit(null, L + 1)).toBe(true);
    expect(overLimit(L + 100, L + 50)).toBe(false);
    expect(overLimit(L + 100, L + 100)).toBe(false);
    expect(overLimit(L + 100, L + 101)).toBe(true);
    expect(overLimit(L + 100, L - 1)).toBe(false);
  });
});
