import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as yamlStringify } from 'yaml';
import { dataPaths, type DataPaths } from '../config/index.js';
import { createGenre, genreExists, listGenres, loadGenre, seedBuiltinGenres } from './index.js';

let root: string;
let paths: DataPaths;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-genre-'));
  paths = dataPaths(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function makePack(id: string, ext: string[], extra: Record<string, string> = {}) {
  const dir = path.join(paths.genres, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'pack.yaml'), yamlStringify({ schema: 'nv.pack/1', id, name: id, extends: ext }));
  for (const [f, text] of Object.entries(extra)) await fs.writeFile(path.join(dir, f), text);
}

describe('seedBuiltinGenres', () => {
  it('拷贝全部内置包，git 初始化；已有的不覆盖', async () => {
    expect(await seedBuiltinGenres(paths)).toEqual(['generic', 'romance', 'scifi', 'urban', 'xianxia']);
    expect(await genreExists(paths, 'xianxia')).toBe(true);
    await fs.stat(path.join(paths.genres, '.git'));
    expect(execSync('git log --format=%s', { cwd: paths.genres, encoding: 'utf8' })).toContain('seed');
    await fs.writeFile(path.join(paths.genres, 'xianxia/AGENTS.md'), '用户改过');
    expect(await seedBuiltinGenres(paths)).toEqual([]);
    expect(await fs.readFile(path.join(paths.genres, 'xianxia/AGENTS.md'), 'utf8')).toBe('用户改过');
  });

  it('内置包全部可加载、从 generic 继承', async () => {
    await seedBuiltinGenres(paths);
    const packs = await listGenres(paths);
    expect(packs.map((p) => p.id)).toEqual(['generic', 'romance', 'scifi', 'urban', 'xianxia']);
    for (const p of packs) {
      const r = await loadGenre(paths, p.id);
      expect(r.chain.map((c) => c.id).at(-1)).toBe(p.id);
      expect(r.pacing.chapter_length.target).toBeGreaterThan(1000);
      expect(r.gates[0]?.genre).toBe('generic');
    }
    const x = await loadGenre(paths, 'xianxia');
    expect(x.chain.map((c) => c.id)).toEqual(['generic', 'xianxia']);
    expect(x.lexicon.ban).toContain('恐怖如斯');
    expect(x.lexicon.ban).toContain('嘴角勾起一抹');
    expect(x.eventFamilies.death).toEqual(expect.arrayContaining(['死', '陨落']));
    expect(x.pacing.arc_length).toEqual([12, 30]);
  });
});

describe('loadGenre', () => {
  it('extends 深度优先、去重；钻石继承只出现一次', async () => {
    await makePack('base', []);
    await makePack('left', ['base']);
    await makePack('right', ['base']);
    await makePack('bottom', ['left', 'right']);
    expect((await loadGenre(paths, 'bottom')).chain.map((c) => c.id)).toEqual(['base', 'left', 'right', 'bottom']);
  });

  it('检测环', async () => {
    await makePack('a', ['b']);
    await makePack('b', ['a']);
    await expect(loadGenre(paths, 'a')).rejects.toThrow(/成环/);
  });

  it('缺失的 extends 和 id 不一致都报错', async () => {
    await makePack('a', ['missing']);
    await expect(loadGenre(paths, 'a')).rejects.toThrow(/不存在/);
    await makePack('bad', []);
    await fs.writeFile(path.join(paths.genres, 'bad/pack.yaml'), yamlStringify({ schema: 'nv.pack/1', id: 'other', name: 'x', extends: [] }));
    await expect(loadGenre(paths, 'bad')).rejects.toThrow(/id/);
  });

  it('pacing 深合并（子包可只写一部分），无 pacing 时兜底', async () => {
    await makePack('base', [], { 'pacing.yaml': 'schema: nv.pacing/1\nchapter_length: { min: 100, target: 200, max: 300 }\narc_length: [5, 6]\n' });
    await makePack('kid', ['base'], { 'pacing.yaml': 'chapter_length: { target: 250 }\n' });
    const r = await loadGenre(paths, 'kid');
    expect(r.pacing.chapter_length).toMatchObject({ min: 100, target: 250, max: 300 });
    expect(r.pacing.arc_length).toEqual([5, 6]);
    await makePack('bare', []);
    expect((await loadGenre(paths, 'bare')).pacing.chapter_length.target).toBe(3000);
  });

  it('lexicon 追加合并去重；gates 按链序；event_families 并集', async () => {
    await makePack('base', [], {
      'lexicon.yaml': 'schema: nv.lexicon/1\nban: [甲, 乙]\npatterns:\n  - { id: p1, regex: a, weight: 1 }\n',
      'gates.yaml': 'schema: nv.gates/1\nrules:\n  lexicon: { level: soft }\n',
    });
    await fs.appendFile(path.join(paths.genres, 'base/pack.yaml'), 'event_families:\n  death: [死]\n');
    await makePack('kid', ['base'], {
      'lexicon.yaml': 'schema: nv.lexicon/1\nban: [乙, 丙]\nallow: [甲]\npatterns:\n  - { id: p1, regex: b, weight: 2 }\n',
      'gates.yaml': 'schema: nv.gates/1\nrules:\n  lexicon: { level: hard }\n',
    });
    await fs.appendFile(path.join(paths.genres, 'kid/pack.yaml'), 'event_families:\n  death: [陨落, 死]\n');
    const r = await loadGenre(paths, 'kid');
    expect(r.lexicon.ban).toEqual(['甲', '乙', '丙']);
    expect(r.lexicon.allow).toEqual(['甲']);
    expect(r.lexicon.patterns).toEqual([expect.objectContaining({ id: 'p1', regex: 'b', weight: 2 })]);
    expect(r.gates.map((g) => g.genre)).toEqual(['base', 'kid']);
    expect(r.eventFamilies.death).toEqual(['死', '陨落']);
  });
});

describe('listGenres / createGenre', () => {
  it('跳过不合法的目录；目录不存在时返回空', async () => {
    expect(await listGenres(paths)).toEqual([]);
    await makePack('good', []);
    await fs.mkdir(path.join(paths.genres, 'junk'), { recursive: true });
    expect((await listGenres(paths)).map((p) => p.id)).toEqual(['good']);
  });

  it('新建（空白）和复制；非 builtin；重复/非法 id/不存在的父包报错', async () => {
    await seedBuiltinGenres(paths);
    const blank = await createGenre(paths, { id: 'my-genre', name: '我的题材', extends: ['generic'] });
    expect(blank).toMatchObject({ id: 'my-genre', builtin: false, extends: ['generic'] });
    expect((await loadGenre(paths, 'my-genre')).chain.map((c) => c.id)).toEqual(['generic', 'my-genre']);

    const copy = await createGenre(paths, { id: 'my-xianxia', name: '我的仙侠', extends: ['generic'], copyFrom: 'xianxia' });
    expect(copy).toMatchObject({ id: 'my-xianxia', builtin: false });
    expect(copy.event_families.death).toBeDefined();
    expect(await fs.readFile(path.join(paths.genres, 'my-xianxia/AGENTS.md'), 'utf8')).toContain('仙侠');

    await expect(createGenre(paths, { id: 'my-genre', name: 'x', extends: [] })).rejects.toThrow(/已存在/);
    await expect(createGenre(paths, { id: '../evil', name: 'x', extends: [] })).rejects.toThrow();
    await expect(createGenre(paths, { id: 'orphan', name: 'x', extends: ['ghost'] })).rejects.toThrow(/不存在/);
    expect(execSync('git status --porcelain', { cwd: paths.genres, encoding: 'utf8' }).trim()).toBe('');
  });
});
