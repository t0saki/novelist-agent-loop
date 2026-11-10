import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths } from '../config/index.js';
import { BUILTIN_GENRES_DIR, loadGenre, seedBuiltinGenres } from '../genres/index.js';
import { BUILTIN_INSTRUCTIONS_DIR, expandIncludes, resolveStack } from './layers.js';
import type { InstructionStack, ResolveStackInput } from './types.js';

let root: string;
let globalDir: string;
let bookDir: string;
let genreA: string;
let genreB: string;

const write = async (abs: string, text: string) => {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-instr-'));
  globalDir = path.join(root, 'global');
  bookDir = path.join(root, 'book');
  genreA = path.join(root, 'genres/base');
  genreB = path.join(root, 'genres/self');
  await fs.mkdir(globalDir, { recursive: true });
  await fs.mkdir(path.join(bookDir, 'instructions'), { recursive: true });
  await fs.mkdir(genreA, { recursive: true });
  await fs.mkdir(genreB, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function input(over: Partial<ResolveStackInput> = {}): ResolveStackInput {
  return { globalDir, genreDirs: [{ id: 'base', dir: genreA }, { id: 'self', dir: genreB }], bookDir, role: 'writer', taskKind: null, ownerNotes: [], v3: { length: 'medium' }, ...over };
}

const ids = (s: InstructionStack) => s.layers.map((l) => l.id);

// 旧流程的层（S0 文件机制、内置角色、任务文件、owner 笔记）随 P3 删除；只剩 v3 的层
describe('resolveStack（v3）：层顺序', () => {
  it('内置约定 → 篇幅要领 → 全局 → 题材（base→self）→ 本书；不读任务文件和 owner 笔记', async () => {
    await write(path.join(globalDir, 'AGENTS.md'), 'g');
    await write(path.join(globalDir, 'roles/writer.md'), '@extends\ngr');
    await write(path.join(globalDir, 'tasks/chapter.write.md'), 'gt');
    await write(path.join(genreA, 'AGENTS.md'), 'a');
    await write(path.join(genreB, 'AGENTS.md'), 'b');
    await write(path.join(bookDir, 'instructions/AGENTS.md'), 'book');
    const s = await resolveStack(input({ taskKind: 'book.write', ownerNotes: [{ source: 'x', text: '笔记' }] }));
    expect(ids(s)).toEqual(['S0', 'S1', 'L1', 'L1.role', 'L2:base', 'L2:self', 'L3']);
    expect(s.layers[0]?.source).toBe(path.join(BUILTIN_INSTRUCTIONS_DIR, 'v3', 'contract.md'));
    expect(s.layers[1]?.source).toBe(path.join(BUILTIN_INSTRUCTIONS_DIR, 'v3', 'length-medium.md'));
  });

  it('书层 AGENTS.md 不存在时仍占位 L3', async () => {
    const s = await resolveStack(input({ genreDirs: [] }));
    expect(s.layers.find((l) => l.id === 'L3')?.content).toBe('');
  });

  it('drafts 优先于磁盘', async () => {
    await write(path.join(bookDir, 'instructions/AGENTS.md'), '旧');
    const s = await resolveStack(input({ drafts: { [path.join(bookDir, 'instructions/AGENTS.md')]: '新草稿' } }));
    expect(s.layers.find((l) => l.id === 'L3')!.content).toBe('新草稿');
  });
});

describe('expandIncludes', () => {
  const read = async (p: string) => {
    throw Object.assign(new Error(p), { code: 'ENOENT' });
  };

  it('展开独占一行的 include（相对所在文件）并支持嵌套', async () => {
    await write(path.join(root, 'inc/a.md'), 'A\n<!-- nv:include sub/b.md -->\n');
    await write(path.join(root, 'inc/sub/b.md'), 'B\n');
    const out = await expandIncludes('前\n<!-- nv:include inc/a.md -->\n后', root, (p) => fs.readFile(p, 'utf8'));
    expect(out).toBe('前\nA\nB\n后');
  });

  it('行内 include 不展开；literal 块和行内 literal 原样', async () => {
    const t = '文字 <!-- nv:include x.md --> 继续\n<!-- nv:literal -->\n<!-- nv:include y.md -->\n<!-- /nv:literal -->\n<!-- nv:literal --><!-- nv:include z.md --><!-- /nv:literal -->';
    expect(await expandIncludes(t, root, read)).toBe('文字 <!-- nv:include x.md --> 继续\n<!-- nv:include y.md -->\n<!-- nv:include z.md -->');
  });

  it('越界、绝对路径、缺失文件、循环引用都报错，不静默', async () => {
    await expect(expandIncludes('<!-- nv:include ../secret.md -->', root, read)).rejects.toThrow(/越界/);
    await expect(expandIncludes('<!-- nv:include /etc/passwd -->', root, read)).rejects.toThrow(/越界/);
    await expect(expandIncludes('<!-- nv:include nope.md -->', root, read)).rejects.toThrow(/不存在/);
    await write(path.join(root, 'loop.md'), '<!-- nv:include loop.md -->');
    await expect(expandIncludes('<!-- nv:include loop.md -->', root, (p) => fs.readFile(p, 'utf8'))).rejects.toThrow(/循环/);
  });
});

describe('内置内容', () => {
  const genres = ['generic', 'xianxia', 'urban', 'romance', 'scifi'];

  it('v3 的内置约定和四档篇幅要领都在、不为空（旧流程的 contract.md 与内置角色已删除，只留 writer.md）', async () => {
    for (const f of ['contract.md', 'length-short.md', 'length-medium.md', 'length-long.md', 'length-epic.md']) {
      expect((await fs.readFile(path.join(BUILTIN_INSTRUCTIONS_DIR, 'v3', f), 'utf8')).trim().length, f).toBeGreaterThan(0);
    }
    expect(await fs.readdir(path.join(BUILTIN_INSTRUCTIONS_DIR, 'roles'))).toEqual(['writer.md']);
    expect(await fs.stat(path.join(BUILTIN_INSTRUCTIONS_DIR, 'contract.md')).then(() => true, () => false)).toBe(false);
  });

  it('题材包文件不含 dsh 模板花括号，且 extends 链从 generic 起', async () => {
    const paths = dataPaths(root);
    await seedBuiltinGenres(paths);
    for (const g of genres) {
      const agents = await fs.readFile(path.join(BUILTIN_GENRES_DIR, g, 'AGENTS.md'), 'utf8');
      expect(agents, g).not.toContain('{{');
      const r = await loadGenre(paths, g);
      expect(r.chain[0]!.id).toBe('generic');
    }
  });
});
