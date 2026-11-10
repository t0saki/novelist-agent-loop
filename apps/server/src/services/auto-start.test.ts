import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { AUTO_LENGTH_MIX_DEFAULT, zSystemSettings, type LengthMix } from '@novelist/shared';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { deleteBook } from './books.js';
import { accountsState, bookEvents, books, profiles, runs, settings, tasks } from '../db/schema.js';
import { convertV1Packs, createGenre, listGenres } from '../genres/index.js';
import { silentLogger } from '../log.js';
import { enqueue } from '../orchestrator/queue.js';
import { markProfileDown, resolveSlot } from '../orchestrator/routing.js';
import { createTestApp, type TestApp } from '../testing.js';
import { bookDir } from '../api/helpers.js';
import { openRepo, P } from '../book/index.js';
import {
  autoStartsToday,
  buildAutoSeedV3,
  createAutoStarter,
  diversityBrief,
  lengthClass,
  maybeStartBook,
  pickGenre,
  pickKeywords,
  pickLength,
  unfinishedOwnBooks,
  writerIdle,
} from './auto-start.js';

/** maybeStartBook 从不读开关（开关只在 createAutoStarter 里）：fixture 一律 enabled: false（p2-plan 约束 4） */
const cfg = (over: Partial<ReturnType<typeof zSystemSettings.parse>['autoStart']> = {}) => zSystemSettings.parse({ autoStart: { enabled: false, maxUnfinishedBooks: 9, maxPerDay: 0, ...over } });
// book_events.ts 由数据库按真实时钟写入，NOW 必须与之同一时钟，否则每日额度窗口会随日历日期漂移
const NOW = new Date();

async function addPack(t: TestApp, id: string, auto: Record<string, unknown> | null, meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  await createGenre(t.deps.paths, { id, name: `包${id}`, extends: [] });
  const file = path.join(t.deps.paths.genres, id, 'pack.yaml');
  const pack = yamlParse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, yamlStringify({ ...pack, ...extra, meta, ...(auto ? { auto } : {}) }), 'utf8');
}

describe('auto-start helpers', () => {
  it('pickGenre 按 书数/权重 轮转，同分取 id 小的', () => {
    const packs = [{ id: 'b', auto: { enabled: true, weight: 2, keywords: [], length_hint: '', min_chapters: null, adult_only: false } }, { id: 'a', auto: undefined }];
    expect(pickGenre(packs, new Map())).toBe('a');
    expect(pickGenre(packs, new Map([['a', 1], ['b', 1]]))).toBe('b');
    expect(pickGenre([], new Map())).toBeNull();
  });

  it('lengthClass 按 v1 规则分档', () => {
    expect(['超长篇', '长篇', '中篇', '短篇', ''].map(lengthClass)).toEqual(['epic', 'long', 'medium', 'short', 'short']);
  });

  it('diversityBrief 连续多本不重复同一组合', () => {
    expect(new Set(Array.from({ length: 420 }, (_, i) => diversityBrief(i))).size).toBe(420);
    expect(diversityBrief(1)).toContain('贴身第三人称');
  });
});

describe('v3 auto-start helpers', () => {
  const mix = AUTO_LENGTH_MIX_DEFAULT as LengthMix;
  it('pickLength: empty history follows the mix (short first)', () => {
    expect(pickLength([], mix, null)).toBe('short');
  });
  it('pickLength: the deficit picks the most under-represented class', () => {
    expect(pickLength(Array(10).fill('short'), mix, null)).toBe('medium');
    expect(pickLength(['short', 'short', 'medium', 'medium', 'short', 'medium', 'short', 'medium'], mix, null)).toBe('long');
    // 只看最近 20 本
    expect(pickLength([...Array(20).fill('long'), ...Array(30).fill('short')], mix, null)).toBe('short');
  });
  it('pickLength: the pack hint adds half a book', () => {
    expect(pickLength([], mix, 'medium')).toBe('medium');
    expect(pickLength([], mix, 'epic')).toBe('epic');
    expect(pickLength(Array(10).fill('short'), mix, 'epic')).toBe('medium');
  });
  it('pickLength: a class set to 0 % is never picked, the hint bonus does not lift it', () => {
    const noEpic = { short: 40, medium: 35, long: 25, epic: 0 };
    expect(pickLength([], noEpic, 'epic')).toBe('short');
    for (let n = 0; n < 40; n += 1) expect(pickLength(Array(n).fill('short'), noEpic, 'epic')).not.toBe('epic');
  });
  it('pickLength: ties → larger share, then short, medium, long, epic', () => {
    expect(pickLength(['short'], { short: 70, medium: 20, long: 10, epic: 0 }, null)).toBe('short');
    expect(pickLength([], { short: 25, medium: 25, long: 25, epic: 25 }, null)).toBe('short');
    expect(pickLength(['short'], { short: 50, medium: 25, long: 25, epic: 0 }, null)).toBe('medium');
  });

  it('pickGenre: weight override wins over pack.yaml', () => {
    const packs = [{ id: 'a', auto: { enabled: true, weight: 1, keywords: [], length_hint: '', min_chapters: null, adult_only: false } }, { id: 'b', auto: { enabled: true, weight: 1, keywords: [], length_hint: '', min_chapters: null, adult_only: false } }];
    expect(pickGenre(packs, new Map([['a', 2], ['b', 3]]))).toBe('a');
    expect(pickGenre(packs, new Map([['a', 2], ['b', 3]]), new Map([['a', 1], ['b', 4]]))).toBe('b');
  });

  it('pickKeywords: 0 → [], 1 → [k], several → 1 or 2 distinct', () => {
    const seq = (xs: number[]) => {
      let i = 0;
      return () => xs[i++ % xs.length] as number;
    };
    expect(pickKeywords([], seq([0]))).toEqual([]);
    expect(pickKeywords(['甲'], seq([0]))).toEqual(['甲']);
    expect(pickKeywords(['甲', '乙', '丙'], seq([0.9, 0.5]))).toEqual(['乙']);
    expect(pickKeywords(['甲', '乙', '丙'], seq([0.1, 0, 0]))).toEqual(['甲', '乙']);
    expect(pickKeywords(['甲', '乙', '丙'], seq([0.1, 0.99, 0.99]))).toEqual(['丙', '乙']);
    for (let i = 0; i < 50; i += 1) {
      const got = pickKeywords(['甲', '乙', '丙', '丁'], Math.random);
      expect(got.length === 1 || got.length === 2).toBe(true);
      expect(new Set(got).size).toBe(got.length);
    }
  });

  it('buildAutoSeedV3 (golden), adult line verbatim, no keyword line without keywords', () => {
    const auto = { enabled: true, weight: 1, keywords: ['钟表', '暴雨'], length_hint: '', min_chapters: null, adult_only: true };
    expect(buildAutoSeedV3({ name: '都市悬疑', auto }, { ordinal: 1, keywords: ['钟表', '暴雨'] })).toBe(
      [
        '（自动开书）这本书由系统自动开出，没有主人的具体设想。书名请在 bible.md 第一行自拟。',
        '',
        '题材：都市悬疑',
        '必须用上的关键词：钟表、暴雨（写进主线或主角设定）',
        `本书写法（与题材要求冲突时以题材为准）：${diversityBrief(1)}。`,
        '人物年龄：所有角色都是年满 18 岁的成年人，并在人物设定里写明年龄。',
        '请据此原创一个完整的故事设想，不要沿用书库摘要里已有作品的人物和情节。',
      ].join('\n'),
    );
    const plain = buildAutoSeedV3({ name: 'X', auto: { ...auto, adult_only: false } }, { ordinal: 0, keywords: [] });
    expect(plain).not.toContain('必须用上的关键词');
    expect(plain).not.toContain('成年人');
  });
});

describe('v3 auto-start against a real app', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const bookRow = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0];
  /** 让一本书存稿已满、开书任务已跑完（写手才算闲着：排着队的写作任务也是活） */
  const fill = async (slug: string) => {
    const r = await bookRow(slug);
    await t.deps.db.update(books).set({ status: 'active', meta: { ...(r?.meta ?? {}), v3: { ...((r?.meta as { v3?: object }).v3 ?? {}), sched: { bufferDays: 9, bufferFull: true, at: NOW.toISOString() } } } }).where(eq(books.slug, slug));
    if (r) await t.deps.db.update(tasks).set({ state: 'done' }).where(and(eq(tasks.bookId, r.id), inArray(tasks.state, ['pending', 'ready', 'waiting'])));
  };
  const addBook = (id: string, o: Partial<typeof books.$inferInsert> = {}) => t.deps.db.insert(books).values({ id, slug: id, title: id, genre: 'g', status: 'active', meta: { v3: { sched: { bufferDays: 9, bufferFull: true, at: NOW.toISOString() } } }, ...o });

  it('没有启用的题材包就不开书', async () => {
    expect(await maybeStartBook(t.deps, NOW, cfg())).toBeNull();
    expect(await t.deps.db.select().from(books)).toHaveLength(0);
  });

  it('creates a v3 book: flow v3, the chosen length and its target, started, keywords in seed.md, event body', async () => {
    await addPack(t, 'p-on', { enabled: true, keywords: ['钟表'], adult_only: true });
    await addPack(t, 'a-off', { enabled: false });
    const slug = (await maybeStartBook(t.deps, NOW, cfg(), { rng: () => 0 }))!;
    expect(slug.startsWith('auto-')).toBe(true);
    const b = await bookRow(slug);
    expect(b?.genre).toBe('p-on');
    expect(b?.status).toBe('planning');
    expect(b?.title.startsWith('未命名·')).toBe(true);
    const repo = openRepo(bookDir(t.deps, slug));
    const yaml = yamlParse((await repo.readFile(P.bookYaml))!);
    expect(yaml.flow).toBe('v3');
    expect(yaml.v3).toMatchObject({ length: 'short', target_cjk: 15000, auto_title: true });
    const seed = (await repo.readFile('seed.md'))!;
    expect(seed).toContain('必须用上的关键词：钟表（写进主线或主角设定）');
    expect(seed).toContain('所有角色都是年满 18 岁的成年人');
    const ev = await t.deps.db.select().from(bookEvents).where(eq(bookEvents.kind, 'book.auto_created'));
    expect(ev.map((e) => e.body)).toEqual([{ genre: 'p-on', flow: 'v3', length: 'short', keywords: ['钟表'] }]);
    const open = await t.deps.db.select().from(tasks).where(eq(tasks.bookId, b!.id));
    expect(open.map((x) => x.kind)).toEqual(['book.open']);
  });

  it('length follows the mix over the last auto books; pack length_hint only weighs in', async () => {
    await addPack(t, 'p-long', { enabled: true, length_hint: '长篇' });
    // 已有 1 本短篇：短篇 0.4×2−1 = −0.2，中篇 0.7，长篇 0.4 + 0.5 = 0.9
    await t.deps.db.insert(bookEvents).values({ bookId: 'gone-1', kind: 'book.auto_created', body: { genre: 'p-long', flow: 'v3', length: 'short' } });
    const slug = (await maybeStartBook(t.deps, NOW, cfg()))!;
    expect(yamlParse((await openRepo(bookDir(t.deps, slug)).readFile(P.bookYaml))!).v3).toMatchObject({ length: 'long', target_cjk: 200000 });
  });

  it('pickGenre counts only auto-started books (imported ignored), the settings weight overrides, hidden packs are skipped', async () => {
    await addPack(t, 'p-a', { enabled: true });
    await addPack(t, 'p-b', { enabled: true });
    await addPack(t, 'p-c', { enabled: true }, {}, { hidden: true });
    for (let i = 0; i < 5; i += 1) await addBook(`imp${i}`, { genre: 'p-a', status: 'completed', meta: { v1: { id: i } } });
    await t.deps.db.insert(bookEvents).values({ bookId: 'gone-b', kind: 'book.auto_created', body: { genre: 'p-b' } });
    const first = (await maybeStartBook(t.deps, NOW, cfg()))!;
    expect((await bookRow(first))?.genre).toBe('p-a');
    await fill(first);
    // p-a 1 本、p-b 1 本：同分按 id → p-a；p-b 权重 3 → p-b
    const second = (await maybeStartBook(t.deps, NOW, cfg({ genreWeights: { 'p-b': 3 } })))!;
    expect((await bookRow(second))?.genre).toBe('p-b');
    await fill(second);
    // 权重 0 = 不参与
    const third = (await maybeStartBook(t.deps, NOW, cfg({ genreWeights: { 'p-a': 0, 'p-b': 0 } })))!;
    expect(third).toBeNull();
  });

  /** 库里旧存的键（P3 已从 schema 删掉）：不起作用 */
  const STORED_OLD_KEY = { maxActiveBooks: 1 };
  it('cap maxUnfinishedBooks counts planning/active/paused own books, not imported or completed; a stored maxActiveBooks: 1 is ignored', async () => {
    await addPack(t, 'p-on', { enabled: true });
    await addBook('own-a');
    await addBook('own-p', { status: 'paused' });
    await addBook('own-done', { status: 'completed' });
    await addBook('imp-a', { meta: { v1: { id: 1 } } });
    await addBook('imp-p', { status: 'paused', meta: { v1: { id: 2 } } });
    // 旧书（没有 meta.v3）也不算
    await addBook('legacy-own', { meta: {} });
    expect(await unfinishedOwnBooks(t.deps.db)).toBe(2);
    expect(await maybeStartBook(t.deps, NOW, cfg({ maxUnfinishedBooks: 2, ...STORED_OLD_KEY }))).toBeNull();
    const slug = await maybeStartBook(t.deps, NOW, cfg({ maxUnfinishedBooks: 3, ...STORED_OLD_KEY }));
    expect(slug).not.toBeNull();
    await fill(slug!);
    expect((await writerIdle(t.deps.db, NOW, { allowFakeHarness: true })).idle).toBe(true);
    expect(await maybeStartBook(t.deps, NOW, cfg({ maxUnfinishedBooks: 3 }))).toBeNull();
    expect(await maybeStartBook(t.deps, NOW, cfg({ maxUnfinishedBooks: 4 }))).not.toBeNull();
  });

  it('writer not idle → null: active write task / account sleeping / auth bad / a book not buffer-full / writer profile cooling down / no route', async () => {
    await addPack(t, 'p-on', { enabled: true });
    const idle = async () => (await writerIdle(t.deps.db, NOW, { allowFakeHarness: true })).idle;
    expect(await idle()).toBe(true);
    const check = async (setup: () => Promise<unknown>, undo: () => Promise<unknown>, reason: RegExp) => {
      await setup();
      const w = await writerIdle(t.deps.db, NOW, { allowFakeHarness: true });
      expect(w.idle).toBe(false);
      expect(w.reason).toMatch(reason);
      expect(await maybeStartBook(t.deps, NOW, cfg())).toBeNull();
      await undo();
      expect(await idle()).toBe(true);
    };
    const manifest = { hard: {}, soft: {}, rebaseValidators: [], configHash: 'c' };
    await enqueue(t.deps.db, { id: 'busy', baseCommit: null, manifest, spec: { kind: 'book.write', bookId: null, target: 'x', lane: 'write' } });
    await check(
      () => t.deps.db.update(tasks).set({ state: 'running' }).where(eq(tasks.id, 'busy')),
      () => t.deps.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, 'busy')),
      /^write_active/,
    );
    await t.deps.db.insert(accountsState).values({ accountId: 'fake' }).onConflictDoNothing();
    await check(
      () => t.deps.db.update(accountsState).set({ sleepUntil: new Date(NOW.getTime() + 3600_000).toISOString(), sleepReason: 'quota' }).where(eq(accountsState.accountId, 'fake')),
      () => t.deps.db.update(accountsState).set({ sleepUntil: null, sleepReason: null }).where(eq(accountsState.accountId, 'fake')),
      /^account_sleeping:fake/,
    );
    await check(
      () => t.deps.db.update(accountsState).set({ lastAuthCheck: { ok: false } }).where(eq(accountsState.accountId, 'fake')),
      () => t.deps.db.update(accountsState).set({ lastAuthCheck: { ok: true } }).where(eq(accountsState.accountId, 'fake')),
      /^account_auth:fake/,
    );
    await check(
      () => addBook('room', { meta: { v3: { sched: { bufferDays: 2, bufferFull: false, at: NOW.toISOString() } } } }),
      () => t.deps.db.update(books).set({ status: 'paused' }).where(eq(books.id, 'room')),
      /^buffer_room:room/,
    );
    // 旧书（meta.v3 不是对象）从不开写，不占着写手（P3 D24）
    await addBook('v2room', { meta: {} });
    expect(await idle()).toBe(true);
    const route = await resolveSlot(t.deps.db, { slot: 'writer', book: null, ignoreConcurrency: true, now: NOW, allowFakeHarness: true });
    expect(route.profile).toBe('fake');
    // model_unavailable 之后的冷却（没有备用）：写手不闲
    await check(
      () => markProfileDown(t.deps.db, route.profile!, new Date(NOW.getTime() + 3600_000).toISOString(), 'model gone'),
      () => t.deps.db.delete(settings).where(eq(settings.key, `routing.down:${route.profile}`)),
      /^no_route:down/,
    );
    await check(
      () => t.deps.db.update(profiles).set({ enabled: false }).where(eq(profiles.id, route.profile!)),
      () => t.deps.db.update(profiles).set({ enabled: true }).where(eq(profiles.id, route.profile!)),
      /^no_route:/,
    );
    expect(await maybeStartBook(t.deps, NOW, cfg())).not.toBeNull();
  });

  it('writer not idle while writer work is queued (a retro or an owner rewrite batch on a full-buffer book, a cancel gap); only claimable tasks count', async () => {
    await addPack(t, 'p-on', { enabled: true });
    await addBook('full');
    const w = async () => writerIdle(t.deps.db, NOW, { allowFakeHarness: true });
    expect((await w()).idle).toBe(true);
    const manifest = { hard: {}, soft: {}, rebaseValidators: [], configHash: 'c' };
    await enqueue(t.deps.db, { id: 'retro-q', baseCommit: null, manifest, spec: { kind: 'book.retro', bookId: 'full', target: 'retro-c00020', lane: 'write' } });
    expect(await w()).toEqual({ idle: false, reason: 'write_pending' });
    expect(await maybeStartBook(t.deps, NOW, cfg())).toBeNull();
    // 取消后的 10 分钟间隔：waiting 带 not_before
    await t.deps.db.update(tasks).set({ state: 'waiting', notBefore: new Date(NOW.getTime() + 600_000).toISOString() }).where(eq(tasks.id, 'retro-q'));
    expect((await w()).reason).toBe('write_pending');
    // 等外部事件（not_before 为空）的不算
    await t.deps.db.update(tasks).set({ notBefore: null }).where(eq(tasks.id, 'retro-q'));
    expect((await w()).idle).toBe(true);
    // 存稿上限暂停拦着的写作批不算，结局批算
    await t.deps.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, 'retro-q'));
    await t.deps.db.update(books).set({ pausedReason: 'max_buffer' }).where(eq(books.id, 'full'));
    await enqueue(t.deps.db, { id: 'write-q', baseCommit: null, manifest, spec: { kind: 'book.write', bookId: 'full', target: 'batch-c00021', lane: 'write', params: { mode: 'write' } } });
    expect((await w()).idle).toBe(true);
    await t.deps.db.update(tasks).set({ params: { mode: 'finale' } }).where(eq(tasks.id, 'write-q'));
    expect((await w()).reason).toBe('write_pending');
  });

  it('per-day cap: an open not yet run counts, an open that failed only for infra reasons does not, a deleted auto book still counts', async () => {
    await addPack(t, 'p-on', { enabled: true });
    const first = (await maybeStartBook(t.deps, NOW, cfg({ maxPerDay: 1 })))!;
    await fill(first);
    expect(await autoStartsToday(t.deps.db, NOW)).toBe(1);
    expect(await maybeStartBook(t.deps, NOW, cfg({ maxPerDay: 1 }))).toBeNull();
    const id = (await bookRow(first))!.id;
    const run = (rid: string, errorClass: string | null) => ({ id: rid, taskId: 'x', bookId: id, taskKind: 'book.open', attempt: 1, role: 'writer', profileId: 'fake', harness: 'fake', isolation: 'none', state: 'finalized', runDir: '/x', endedAt: NOW.toISOString(), errorClass });
    await t.deps.db.insert(runs).values(run('r1', 'quota'));
    await t.deps.db.insert(runs).values(run('r2', 'network'));
    expect(await autoStartsToday(t.deps.db, NOW)).toBe(0);
    await t.deps.db.insert(runs).values(run('r3', 'output_contract'));
    expect(await autoStartsToday(t.deps.db, NOW)).toBe(1);
    await t.deps.db.delete(runs).where(eq(runs.id, 'r3'));
    const second = (await maybeStartBook(t.deps, NOW, cfg({ maxPerDay: 2 })))!;
    expect(second).not.toBeNull();
    expect(await autoStartsToday(t.deps.db, NOW)).toBe(1);
    await deleteBook(t.deps, second);
    expect(await autoStartsToday(t.deps.db, NOW)).toBe(1);
    expect(await maybeStartBook(t.deps, NOW, cfg({ maxPerDay: 1 }))).toBeNull();
    expect(await maybeStartBook(t.deps, new Date(NOW.getTime() + 25 * 3600_000), cfg({ maxPerDay: 1 }))).not.toBeNull();
  });

  it('an orphan v3 draft left by a failed startBook is retried instead of creating another book', async () => {
    await addPack(t, 'p-on', { enabled: true });
    const start = t.deps.orchestrator.startBook;
    t.deps.orchestrator.startBook = async () => {
      throw new Error('broken pack');
    };
    await expect(maybeStartBook(t.deps, NOW, cfg())).rejects.toThrow('broken pack');
    await expect(maybeStartBook(t.deps, NOW, cfg())).rejects.toThrow('broken pack');
    const all = await t.deps.db.select().from(books);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('draft');
    expect(all[0]?.title.startsWith('未命名·')).toBe(true);
    t.deps.orchestrator.startBook = start;
    const slug = await maybeStartBook(t.deps, NOW, cfg());
    expect(slug).toBe(all[0]?.slug);
    expect((await bookRow(slug!))?.status).toBe('planning');
  });

  it('createAutoStarter with default settings never creates a book', async () => {
    await addPack(t, 'p-on', { enabled: true });
    const hook = createAutoStarter(t.deps);
    await hook(NOW, zSystemSettings.parse({}));
    await hook(new Date(NOW.getTime() + 60_000), zSystemSettings.parse({ autoStart: {} }));
    expect(await t.deps.db.select().from(books)).toHaveLength(0);
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
