/** v3 书保存书层指令时检查根 AGENTS.md 的大小（p1-plan §3 WP-C、§6 instructions.v3）。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepo, P } from '../book/index.js';
import { V3_AGENTS_SOFT_LIMIT } from '../instructions/v3.js';
import { createBook } from '../services/books.js';
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
  await createBook(t.deps, { title: '旧', slug: 'iv2', genre: 'xianxia', start: false });
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
