import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { zSystemSettings } from '@novelist/shared';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { deleteBook } from './books.js';
import { bookEvents, books } from '../db/schema.js';
import { convertV1Packs, createGenre, listGenres } from '../genres/index.js';
import { silentLogger } from '../log.js';
import { createTestApp, type TestApp } from '../testing.js';
import { bookDir } from '../api/helpers.js';
import { openRepo, P } from '../book/index.js';
import { AUTO_TITLE_PREFIX, autoScale, buildAutoSeed, diversityBrief, lengthClass, premiseDigest, extractAutoTitle, maybeStartBook, nameAutoBooks, pickGenre } from './auto-start.js';

const on = (over: Partial<ReturnType<typeof zSystemSettings.parse>['autoStart']> = {}) => zSystemSettings.parse({ autoStart: { enabled: true, maxActiveBooks: 9, maxPerDay: 0, ...over } });
const NOW = new Date('2026-11-10T00:00:00Z');

async function addPack(t: TestApp, id: string, auto: Record<string, unknown> | null, meta: Record<string, unknown> = {}) {
  await createGenre(t.deps.paths, { id, name: `包${id}`, extends: [] });
  const file = path.join(t.deps.paths.genres, id, 'pack.yaml');
  const pack = yamlParse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, yamlStringify({ ...pack, meta, ...(auto ? { auto } : {}) }), 'utf8');
}

describe('auto-start helpers', () => {
  it('pickGenre 按 书数/权重 轮转，同分取 id 小的', () => {
    const packs = [{ id: 'b', auto: { enabled: true, weight: 2, keywords: [], length_hint: '', min_chapters: null, adult_only: false } }, { id: 'a', auto: undefined }];
    expect(pickGenre(packs, new Map())).toBe('a');
    expect(pickGenre(packs, new Map([['a', 1], ['b', 1]]))).toBe('b');
    expect(pickGenre([], new Map())).toBeNull();
  });

  it('lengthClass 按 v1 规则分档，autoScale 换算规模', () => {
    expect(['超长篇', '长篇', '中篇', '短篇', ''].map(lengthClass)).toEqual(['epic', 'long', 'medium', 'short', 'short']);
    const d = zSystemSettings.parse({}).autoStart.lengths;
    expect(autoScale(d.short, 4, 3000)).toEqual({ target_cjk: 15000, hard_max_cjk: 22500, volumes: [1, 1], chapters_per_volume: [4, 8] });
    expect(autoScale(d.epic, 20, 3000).volumes).toEqual([2, 5]);
    expect(autoScale(d.short, 20, 3000)).toMatchObject({ target_cjk: 60000, chapters_per_volume: [20, 20] });
  });

  it('种子带关键词、撞题列表，adult_only 才带年龄声明', () => {
    const auto = { enabled: true, weight: 1, keywords: ['甲', '乙'], length_hint: '中篇', min_chapters: null, adult_only: false };
    const seed = buildAutoSeed({ name: 'X', auto }, ['旧书']);
    expect(seed).toContain('甲、乙');
    expect(seed).toContain('旧书');
    expect(seed).not.toContain('成年人');
    expect(buildAutoSeed({ name: 'X', auto: { ...auto, adult_only: true } }, [])).toContain('成年人');
  });

  it('diversityBrief 连续多本不重复同一组合，premiseDigest 取一句话卖点', () => {
    expect(new Set(Array.from({ length: 420 }, (_, i) => diversityBrief(i))).size).toBe(420);
    expect(premiseDigest('# 《X》\n\n## 一句话卖点\n\n> 老师傅替没人要的表上弦。\n')).toBe('老师傅替没人要的表上弦。');
    expect(premiseDigest('**一句话卖点**：她要在月底前还完所有的表\n')).toBe('她要在月底前还完所有的表');
    expect(premiseDigest('没有这一节')).toBeNull();
    const seed = buildAutoSeed({ name: 'X' }, [], { ordinal: 1, sameGenre: [{ title: '旧', digest: '旧卖点' }] });
    expect(seed).toContain('《旧》：旧卖点');
    expect(seed).toContain('贴身第三人称');
  });

  it('extractAutoTitle 只认规划师写的书名，不把种子当书名', () => {
    expect(extractAutoTitle('# 《雪夜》\n正文')).toBe('雪夜');
    expect(extractAutoTitle('\n## 书名：《春水》\n')).toBe('春水');
    expect(extractAutoTitle(buildAutoSeed({ name: 'X' }, []))).toBeNull();
    expect(extractAutoTitle('# 《书名》')).toBeNull();
  });
});

describe('auto-start against a real app', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('没有启用的题材包就不开书', async () => {
    expect(await maybeStartBook(t.deps, NOW, on())).toBeNull();
    expect(await t.deps.db.select().from(books)).toHaveLength(0);
  });

  it('开书：占位书名、min_chapters 抬高章数、记录事件；不碰未启用的包', async () => {
    await addPack(t, 'p-on', { enabled: true, min_chapters: 40 });
    await addPack(t, 'a-off', { enabled: false });
    const slug = await maybeStartBook(t.deps, NOW, on());
    const [b] = await t.deps.db.select().from(books).where(eq(books.slug, slug!));
    expect(b?.genre).toBe('p-on');
    expect(b?.title.startsWith(AUTO_TITLE_PREFIX)).toBe(true);
    expect(b?.status).toBe('planning');
    const yaml = yamlParse((await openRepo(bookDir(t.deps, slug!)).readFile(P.bookYaml))!);
    expect(yaml.scale.chapters_per_volume).toEqual([40, 40]);
    expect(yaml.scale.target_cjk).toBe(120000);
    expect(yaml.approvals.compass.required).toBe(false);
    expect(yaml.approvals.first_volume.required).toBe(false);
    expect(await t.deps.db.select().from(bookEvents).where(eq(bookEvents.kind, 'book.auto_created'))).toHaveLength(1);
  });

  it('长短跟着题材包的 length_hint 走', async () => {
    await addPack(t, 'p-long', { enabled: true, length_hint: '长篇' });
    const slug = (await maybeStartBook(t.deps, NOW, on()))!;
    const yaml = yamlParse((await openRepo(bookDir(t.deps, slug)).readFile(P.bookYaml))!);
    expect(yaml.scale.target_cjk).toBe(200000);
    expect(yaml.scale.chapters_per_volume).toEqual([30, 70]);
  });

  it('尊重在写上限和每日上限', async () => {
    await addPack(t, 'p-on', { enabled: true });
    expect(await maybeStartBook(t.deps, NOW, on({ maxActiveBooks: 1 }))).not.toBeNull();
    expect(await maybeStartBook(t.deps, NOW, on({ maxActiveBooks: 1 }))).toBeNull();
    expect(await maybeStartBook(t.deps, NOW, on({ maxPerDay: 1 }))).toBeNull();
    expect(await maybeStartBook(t.deps, new Date(NOW.getTime() + 25 * 3600_000), on({ maxPerDay: 1 }))).not.toBeNull();
  });

  it('删书不退回当天额度', async () => {
    await addPack(t, 'p-on', { enabled: true });
    const slug = (await maybeStartBook(t.deps, NOW, on({ maxPerDay: 1 })))!;
    await deleteBook(t.deps, slug);
    expect(await maybeStartBook(t.deps, NOW, on({ maxPerDay: 1 }))).toBeNull();
  });

  it('startBook 失败留下的 draft 不占名额，下一轮重试它而不是再造新书', async () => {
    await addPack(t, 'p-on', { enabled: true });
    const start = t.deps.orchestrator.startBook;
    t.deps.orchestrator.startBook = async () => {
      throw new Error('broken pack');
    };
    await expect(maybeStartBook(t.deps, NOW, on({ maxActiveBooks: 1 }))).rejects.toThrow('broken pack');
    await expect(maybeStartBook(t.deps, NOW, on({ maxActiveBooks: 1 }))).rejects.toThrow('broken pack');
    expect(await t.deps.db.select().from(books)).toHaveLength(1);
    t.deps.orchestrator.startBook = start;
    const slug = await maybeStartBook(t.deps, NOW, on({ maxActiveBooks: 1 }));
    expect((await t.deps.db.select().from(books).where(eq(books.slug, slug!)))[0]?.status).toBe('planning');
  });

  it('权重 0 的包不参与', async () => {
    await addPack(t, 'p-zero', { enabled: true, weight: 0 });
    expect(await maybeStartBook(t.deps, NOW, on())).toBeNull();
  });

  it('settings 的 genres 名单优先于 pack.auto.enabled', async () => {
    await addPack(t, 'p-off', { enabled: false });
    const slug = await maybeStartBook(t.deps, NOW, on({ genres: ['p-off'] }));
    expect((await t.deps.db.select().from(books).where(eq(books.slug, slug!)))[0]?.genre).toBe('p-off');
  });

  it('规划师写好 premise 后改名，用户改过的名字不动', async () => {
    await addPack(t, 'p-on', { enabled: true });
    const slug = (await maybeStartBook(t.deps, NOW, on()))!;
    const repo = openRepo(bookDir(t.deps, slug));
    await nameAutoBooks(t.deps);
    expect((await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]?.title.startsWith(AUTO_TITLE_PREFIX)).toBe(true);
    const row = (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
    const { commitOwnerEdit } = await import('../orchestrator/index.js');
    await commitOwnerEdit(t.deps.db, repo, row.id, { files: [{ path: P.premise, content: '# 《雪夜》\n' }], message: 'test', baseSha: null });
    await nameAutoBooks(t.deps);
    expect((await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]?.title).toBe('雪夜');
    expect(yamlParse((await repo.readFile(P.bookYaml))!).title).toBe('雪夜');
  });

  it('convertV1Packs：meta.v1 转成 auto + extends generic，幂等，保留 meta', async () => {
    await addPack(t, 'v1-pack', null, { v1: { id: 7, keywords: ['k'], length_hint: null, min_chapters: 20, weight: 3, nsfw: true, enabled: true } });
    await addPack(t, 'plain', null);
    await convertV1Packs(t.deps.paths, silentLogger);
    await convertV1Packs(t.deps.paths, silentLogger);
    const packs = await listGenres(t.deps.paths);
    const v = packs.find((p) => p.id === 'v1-pack')!;
    expect(v.auto).toEqual({ enabled: true, weight: 3, keywords: ['k'], length_hint: '', min_chapters: 20, adult_only: true });
    expect(v.extends).toEqual(['generic']);
    expect((v.meta.v1 as { id: number }).id).toBe(7);
    expect(packs.find((p) => p.id === 'plain')!.auto).toBeUndefined();
  });
});
