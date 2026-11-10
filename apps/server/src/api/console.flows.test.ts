/**
 * 控制台的各个页面在接口层面的流程（P3 WP-3）：每个页面发的就是它自己那一节（按节合并 + baseUpdatedAt，D30），
 * 自动开书默认关、只有开关那一个请求能改它；题材包的参与与权重只在 pack.yaml（D31）。
 * 成人题材的测试种子明确写出所有角色都是成年人（均已满 22 岁，D28）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';
import type { V3BookView } from '@novelist/shared';
import { createLegacyBook } from '../book/testing-legacy.js';
import { runBootMigrations } from '../boot/migrate-p3.js';
import { books, inbox, settings, tasks } from '../db/schema.js';
import { loadSystemSettings } from '../orchestrator/index.js';
import { maybeStartBook } from '../services/auto-start.js';
import { createBook } from '../services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';

let t: TestApp;
let cookie: string;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const admin = (method: Method, url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const getSettings = async () => (await admin('GET', '/api/admin/settings')).json();
/** 页面的保存：带上刚读到的 baseUpdatedAt，只发自己那一节 */
const save = async (section: Record<string, unknown>) => admin('PUT', '/api/admin/settings', { baseUpdatedAt: (await getSettings()).updatedAt, ...section });
const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
const packFile = (id: string) => path.join(t.deps.paths.genres, id, 'pack.yaml');
const seqRng = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] as number;
};

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('automatic start: off by default, only the toggle changes it, section-wise saves', () => {
  it('a fresh install (after the boot migration) reads enabled: false; the panel save carries no enabled key and keeps it; the toggle sends only enabled', async () => {
    await runBootMigrations(t.deps);
    const cur = await getSettings();
    expect(cur.autoStart.enabled).toBe(false);
    expect(cur.updatedAt === null || typeof cur.updatedAt === 'string').toBe(true);
    const panel = await save({ autoStart: { maxUnfinishedBooks: 4, maxPerDay: 3, lengthMix: { short: 30, medium: 40, long: 25, epic: 5 }, lengths: { medium: { targetCjk: 80_000 } } } });
    expect(panel.statusCode, panel.body).toBe(200);
    const after = panel.json();
    expect(after.autoStart).toMatchObject({ enabled: false, maxUnfinishedBooks: 4, maxPerDay: 3, lengthMix: { short: 30, medium: 40, long: 25, epic: 5 } });
    expect(after.autoStart.lengths.medium).toEqual({ targetCjk: 80_000, chaptersMin: cur.autoStart.lengths.medium.chaptersMin, chaptersMax: cur.autoStart.lengths.medium.chaptersMax });
    expect(after.autoStart.lengths.long).toEqual(cur.autoStart.lengths.long);
    expect(typeof after.updatedAt).toBe('string');
    // 开关：只有它带 enabled
    expect((await save({ autoStart: { enabled: true } })).json().autoStart).toMatchObject({ enabled: true, maxUnfinishedBooks: 4 });
    expect((await save({ autoStart: { enabled: false } })).json().autoStart.enabled).toBe(false);
  });

  it('a stale full-object save (old baseUpdatedAt, enabled: true) → 409 stale_settings, nothing changes', async () => {
    const old = await getSettings();
    expect((await save({ maxConcurrentRuns: 5 })).statusCode).toBe(200);
    const { updatedAt, ...full } = old;
    const stale = await admin('PUT', '/api/admin/settings', { ...full, baseUpdatedAt: updatedAt, autoStart: { ...old.autoStart, enabled: true } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('stale_settings');
    const now = await getSettings();
    expect(now.autoStart.enabled).toBe(false);
    expect(now.maxConcurrentRuns).toBe(5);
    // 存进库里的也是 false
    expect(((await t.deps.db.select().from(settings).where(eq(settings.key, 'system')))[0]?.value as { autoStart: { enabled: boolean } }).autoStart.enabled).toBe(false);
  });

  it('each page sends only its own section: effort table, publish defaults, runaway factor, readers, time limits, concurrency', async () => {
    const base = await getSettings();
    // 模型页：effort 表
    const effort = await save({ v3: { effortDefaults: { open: 'low', write: 'medium', closing: 'high', finale: 'high', retro: 'low' } } });
    expect(effort.statusCode, effort.body).toBe(200);
    expect(effort.json().v3).toEqual({ runawayFactor: base.v3.runawayFactor, publishDefaults: base.v3.publishDefaults, effortDefaults: { open: 'low', write: 'medium', closing: 'high', finale: 'high', retro: 'low' } });
    // 系统页：默认发布节奏与存稿上限
    const pub = await save({ v3: { publishDefaults: { cadence: '0 7,19 * * *', per_slot: 1, max_buffer: 20 } } });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().v3.effortDefaults).toMatchObject({ open: 'low', retro: 'low' });
    expect(pub.json().v3.publishDefaults).toEqual({ ...base.v3.publishDefaults, cadence: '0 7,19 * * *', per_slot: 1, max_buffer: 20 });
    expect(pub.json().v3.runawayFactor).toBe(base.v3.runawayFactor);
    // 不合法的节奏 → 400，什么都没存
    const bad = await save({ v3: { publishDefaults: { cadence: 'not a cron' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_publish');
    // 失控兜底倍数：两张表都不动
    const rf = await save({ v3: { runawayFactor: 3 } });
    expect(rf.json().v3).toMatchObject({ runawayFactor: 3, effortDefaults: { open: 'low' }, publishDefaults: { cadence: '0 7,19 * * *' } });
    // 新读者的默认可见范围、时限、并发
    expect((await save({ readers: { defaultVisibility: 'none' } })).json().readers.defaultVisibility).toBe('none');
    const limits = await save({ wallTimeoutMs: 5_400_000, idleTimeouts: { writerMs: 1_800_000 } });
    expect(limits.json()).toMatchObject({ wallTimeoutMs: 5_400_000, idleTimeouts: { writerMs: 1_800_000, otherMs: base.idleTimeouts.otherMs, dshMs: base.idleTimeouts.dshMs } });
    expect((await save({ maxConcurrentRuns: 2 })).json()).toMatchObject({ maxConcurrentRuns: 2, readers: { defaultVisibility: 'none' }, wallTimeoutMs: 5_400_000 });
    expect((await save({ maxConcurrentRuns: 0 })).statusCode).toBe(400);
    // 还原
    expect((await save({ v3: { runawayFactor: 2, effortDefaults: base.v3.effortDefaults, publishDefaults: base.v3.publishDefaults }, readers: base.readers, wallTimeoutMs: base.wallTimeoutMs, idleTimeouts: base.idleTimeouts, maxConcurrentRuns: base.maxConcurrentRuns })).statusCode).toBe(200);
    expect((await getSettings()).autoStart.enabled).toBe(false);
  });
});

describe('genres: participation and weight live in pack.yaml', () => {
  it('PATCH /genres/:id/auto writes pack.yaml (comments kept) and auto-start follows it; an invalid weight → 400 invalid_pack, pack.yaml unchanged', async () => {
    const raw = await fs.readFile(packFile('urban'), 'utf8');
    await fs.writeFile(packFile('urban'), `# 主人的注释：都市题材\n${raw}`);
    const res = await admin('PATCH', '/api/admin/genres/urban/auto', { enabled: true, weight: 5, keywords: ['旧城', '夜班'], length_hint: '中篇' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().auto).toEqual({ enabled: true, weight: 5, keywords: 2, lengthHint: '中篇', keywordList: ['旧城', '夜班'], adultOnly: false, minChapters: null });
    const text = await fs.readFile(packFile('urban'), 'utf8');
    expect(text).toContain('# 主人的注释：都市题材');
    expect((yamlParse(text) as { auto: unknown }).auto).toMatchObject({ enabled: true, weight: 5, keywords: ['旧城', '夜班'], length_hint: '中篇' });
    for (const body of [{ weight: -1 }, { weight: 1000 }, { keywords: [''] }]) {
      const r = await admin('PATCH', '/api/admin/genres/urban/auto', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().code).toBe('invalid_pack');
    }
    expect(await fs.readFile(packFile('urban'), 'utf8')).toBe(text);
    expect((await admin('PATCH', '/api/admin/genres/no-such/auto', { enabled: true })).statusCode).toBe(404);

    // 自动开书只从 auto.enabled 的包里挑：现在只有 urban
    const now = new Date();
    const slug = await maybeStartBook(t.deps, now, await loadSystemSettings(t.deps.db), { rng: seqRng([0.9]) });
    expect(slug).not.toBeNull();
    const auto = await rowOf(slug as string);
    expect(auto.genre).toBe('urban');
    const seed = await fs.readFile(path.join(t.deps.paths.books, slug as string, 'seed.md'), 'utf8');
    expect(seed).toMatch(/必须用上的关键词：(旧城|夜班)/);
    // 关掉它，免得占着写手
    for (const x of await t.deps.db.select().from(tasks).where(eq(tasks.bookId, auto.id))) await t.deps.orchestrator.cancelTask(x.id);
    await admin('PATCH', `/api/admin/books/${slug}`, { status: 'archived' });
    expect((await admin('PATCH', '/api/admin/genres/urban/auto', { enabled: false })).json().auto.enabled).toBe(false);
  });

  it('an old settings override shows up as override on the pack and can be cleared from settings', async () => {
    expect((await save({ autoStart: { genreWeights: { xianxia: 3 }, genres: ['xianxia'] } })).statusCode).toBe(200);
    let list = (await admin('GET', '/api/admin/genres')).json() as { id: string; override: { listed: boolean | null; weight: number | null } }[];
    expect(list.find((g) => g.id === 'xianxia')?.override).toEqual({ listed: true, weight: 3 });
    expect(list.find((g) => g.id === 'urban')?.override).toEqual({ listed: false, weight: null });
    // “清除覆盖”
    expect((await save({ autoStart: { genres: null, genreWeights: {} } })).statusCode).toBe(200);
    list = (await admin('GET', '/api/admin/genres')).json();
    expect(list.find((g) => g.id === 'xianxia')?.override).toEqual({ listed: null, weight: null });
  });

  it('hide / unhide, create, delete to the trash; global AGENTS.md save is size-checked; the built-in length files are read-only', async () => {
    expect((await admin('POST', '/api/admin/genres/romance/visibility', { hidden: true })).json().hidden).toBe(true);
    expect((await admin('POST', '/api/admin/genres/romance/visibility', { hidden: false })).json().hidden).toBe(false);
    expect((await admin('POST', '/api/admin/genres', { id: 'flow-tmp', name: '临时', extends: [] })).statusCode).toBe(201);
    expect((await admin('DELETE', '/api/admin/genres/flow-tmp')).statusCode).toBe(200);
    expect(await fs.stat(path.join(t.deps.paths.genres, 'flow-tmp')).then(() => true, () => false)).toBe(false);
    await createBook(t.deps, { title: '指令', slug: 'cf-inst', genre: 'xianxia', length: 'medium', start: false });
    const big = '全局的要求：多写对白。\n'.repeat(2000);
    const g = await admin('PUT', '/api/admin/instructions/file', { scope: 'global', path: 'AGENTS.md', content: big, baseSha: null });
    expect(g.statusCode).toBe(400);
    expect(g.json().code).toBe('instructions_too_large');
    expect((await admin('GET', '/api/admin/instructions/file?scope=builtin&path=v3/length-medium.md')).statusCode).toBe(200);
    expect((await admin('PUT', '/api/admin/instructions/file', { scope: 'builtin', path: 'v3/length-medium.md', content: 'x', baseSha: null })).statusCode).toBe(403);
  });
});

describe('new book form', () => {
  it("genre 'random', length 'random', a one-line idea (seeded rng) → a v3 book with book.open queued", async () => {
    const created = await createBook(t.deps, { genre: 'random', length: 'random', idea: '一个关于旧城夜班公交司机的故事' }, { rng: seqRng([0.1, 0.7]) });
    expect(created).toMatchObject({ flow: 'v3', legacy: false, status: 'planning' });
    const row = await rowOf(created.slug);
    expect((await t.deps.db.select().from(tasks).where(eq(tasks.bookId, row.id))).map((x) => x.kind)).toEqual(['book.open']);
    const seed = await fs.readFile(path.join(t.deps.paths.books, created.slug, 'seed.md'), 'utf8');
    expect(seed).toContain('主人的想法：一个关于旧城夜班公交司机的故事');
    for (const x of await t.deps.db.select().from(tasks).where(eq(tasks.bookId, row.id))) await t.deps.orchestrator.cancelTask(x.id);
  });

  it('an adult-only pack keeps the adult declaration in the seed, also for a hand-made book', async () => {
    expect((await admin('POST', '/api/admin/genres', { id: 'adult-a', name: '成人向都市', extends: [] })).statusCode).toBe(201);
    const raw = await fs.readFile(packFile('adult-a'), 'utf8');
    // 成人标记只在 pack.yaml 里（页面上只读）；没有参与自动开书
    await fs.writeFile(packFile('adult-a'), `${raw.replace(/\n*$/, '\n')}auto:\n  enabled: false\n  adult_only: true\n`);
    const res = await admin('POST', '/api/admin/books', { genre: 'adult-a', length: 'short', idea: '两位主角都是成年人（均已满22岁）：大学毕业多年后在旧城重逢的同学。', start: false });
    expect(res.statusCode, res.body).toBe(201);
    const seed = await fs.readFile(path.join(t.deps.paths.books, res.json().slug, 'seed.md'), 'utf8');
    expect(seed).toContain('所有角色都是年满 18 岁的成年人');
    expect(seed).toContain('均已满22岁');
  });
});

describe('home, book page, chapter page', () => {
  it('home: filters active / finished / legacy / all; open inbox items listed and dismissed', async () => {
    await createBook(t.deps, { title: '在写', slug: 'cf-active', genre: 'xianxia', length: 'medium', start: false });
    await createBook(t.deps, { title: '写完', slug: 'cf-done', genre: 'xianxia', length: 'short', start: false });
    await t.deps.db.update(books).set({ status: 'completed' }).where(eq(books.slug, 'cf-done'));
    await createLegacyBook(t.deps.db, t.deps.paths, 'cf-legacy');
    const slugs = async (f: string) => ((await admin('GET', `/api/admin/books?filter=${f}`)).json() as { slug: string }[]).map((b) => b.slug);
    expect(await slugs('active')).toEqual(expect.arrayContaining(['cf-active']));
    expect(await slugs('active')).not.toContain('cf-done');
    expect(await slugs('active')).not.toContain('cf-legacy');
    // 已完结 / 归档的新流程书（前面归档的自动开书那本也在这里）
    expect(await slugs('finished')).toContain('cf-done');
    expect(await slugs('finished')).not.toContain('cf-active');
    expect(await slugs('finished')).not.toContain('cf-legacy');
    expect(await slugs('legacy')).toEqual(['cf-legacy']);
    expect(await slugs('all')).toEqual(expect.arrayContaining(['cf-active', 'cf-done', 'cf-legacy']));
    // 待办：一条通知，处理掉
    await t.deps.db.insert(inbox).values({ id: 'cf-notice', bookId: (await rowOf('cf-active')).id, kind: 'notice', title: '测试待办', actions: [{ id: 'dismiss', label: '知道了' }], dedupeKey: 'v3_test:cf' });
    const open = (await admin('GET', '/api/admin/inbox?state=open')).json() as { items: { id: string }[] };
    expect(open.items.map((i) => i.id)).toContain('cf-notice');
    const acted = await admin('POST', '/api/admin/inbox/cf-notice/act', { action: 'dismiss' });
    expect(acted.statusCode, acted.body).toBe(200);
    expect(((await admin('GET', '/api/admin/inbox?state=open')).json() as { items: { id: string }[] }).items.map((i) => i.id)).not.toContain('cf-notice');
  });

  it('book page: view, owner message, settings with writer override and budgets, pause / resume', async () => {
    const v = (await admin('GET', '/api/admin/books/cf-active/v3')).json() as V3BookView;
    expect(v.settings).toMatchObject({ writer_profile: null, budgets: { priority: 0, monthly_usd_cap: null, max_window_util_pct: null } });
    expect((await admin('PUT', '/api/admin/books/cf-active/v3/message', { text: '多写对话，少写旁白。' })).statusCode).toBe(200);
    const s = await admin('PUT', '/api/admin/books/cf-active/v3/settings', { ...v.settings, writer_profile: 'fake', budgets: { priority: 3, monthly_usd_cap: 20, max_window_util_pct: null } });
    expect(s.statusCode, s.body).toBe(200);
    expect((s.json() as V3BookView).settings).toMatchObject({ writer_profile: 'fake', budgets: { priority: 3, monthly_usd_cap: 20, max_window_util_pct: null } });
    expect((await rowOf('cf-active')).priority).toBe(3);
    expect((await admin('POST', '/api/admin/books/cf-active/actions', { action: 'pause' })).statusCode).toBe(200);
    expect((await rowOf('cf-active')).status).toBe('paused');
    expect((await admin('POST', '/api/admin/books/cf-active/actions', { action: 'resume' })).statusCode).toBe(200);
    // 旧的动作不在了
    for (const action of ['drain', 'migrate']) expect((await admin('POST', '/api/admin/books/cf-active/actions', { action })).statusCode, action).toBe(400);
  });

  it('chapter page: rewrite with a note, rewrite_from, publish now; on a legacy book → 409', async () => {
    const { addV3Book } = await import('../flow/testing-book.js');
    const b = await addV3Book({ db: t.deps.db, paths: t.deps.paths } as never, 'cf-ch', { chapters: 5, status: 'paused' });
    expect((await admin('POST', '/api/admin/books/cf-ch/chapters/4/actions', { action: 'rewrite', note: '节奏太慢' })).statusCode).toBe(200);
    expect(((await rowOf('cf-ch')).meta as { v3: { ownerRequests: { chapter: number }[] } }).v3.ownerRequests.map((r) => r.chapter)).toEqual([4]);
    const rf = await admin('POST', '/api/admin/books/cf-ch/chapters/5/actions', { action: 'rewrite_from', note: '换个结尾' });
    expect(rf.statusCode, rf.body).toBe(200);
    expect((await rowOf('cf-ch')).acceptedThrough).toBe(4);
    expect((await admin('POST', '/api/admin/books/cf-ch/chapters/2/actions', { action: 'publish_now' })).statusCode).toBe(200);
    expect((await t.deps.db.select().from(tasks).where(eq(tasks.bookId, b.id))).some((x) => x.kind === 'publish')).toBe(true);
    for (const action of ['rewrite', 'rewrite_from', 'publish_now']) {
      const r = await admin('POST', '/api/admin/books/cf-legacy/chapters/1/actions', { action, note: 'x' });
      expect(r.statusCode, action).toBe(409);
      expect(r.json().code).toBe('legacy_book');
    }
  });
});

describe('models & accounts, system', () => {
  it('slots GET / PUT, slot canary with the fake harness, profiles CRUD, usage and quota answer', async () => {
    const view = (await admin('GET', '/api/admin/routing/slots')).json();
    expect(view.slots.writer.primary).toBe('fake');
    expect((await admin('POST', '/api/admin/profiles', { id: 'cf-fake2', harness: 'fake', model: 'fake-model' })).statusCode).toBe(201);
    const put = await admin('PUT', '/api/admin/routing/slots', { writer: { primary: 'fake', fallback: 'cf-fake2' }, utility: { primary: 'fake', fallback: null } });
    expect(put.json().slots.writer).toEqual({ primary: 'fake', fallback: 'cf-fake2' });
    const canary = await admin('POST', '/api/admin/routing/slots/utility/canary');
    expect(canary.statusCode).toBe(200);
    expect(canary.json().result).toMatchObject({ ok: true, wroteFile: true });
    expect((await admin('PATCH', '/api/admin/profiles/cf-fake2', { model: 'fake-2' })).json().model).toBe('fake-2');
    expect((await admin('PUT', '/api/admin/routing/slots', { writer: { primary: 'fake', fallback: null }, utility: { primary: 'fake', fallback: null } })).statusCode).toBe(200);
    expect((await admin('DELETE', '/api/admin/profiles/cf-fake2')).statusCode).toBe(200);
    expect((await admin('GET', '/api/admin/usage?groupBy=book')).statusCode).toBe(200);
    expect((await admin('GET', '/api/admin/quota')).statusCode).toBe(200);
  });

  it('system: readers CRUD, PAT create / revoke, admin password change, v1 import preview without a database → 400', async () => {
    const reader = await admin('POST', '/api/admin/readers', { label: '读者甲', password: 'reader-pass-1' });
    expect(reader.statusCode).toBe(201);
    const rid = reader.json().id as string;
    expect((await admin('PATCH', `/api/admin/readers/${rid}`, { enabled: false })).json().enabled).toBe(false);
    expect((await admin('DELETE', `/api/admin/readers/${rid}`)).statusCode).toBe(200);
    const pat = await admin('POST', '/api/admin/pats', { label: 'cli' });
    expect(pat.statusCode).toBe(201);
    expect((await admin('DELETE', `/api/admin/pats/${pat.json().id}`)).statusCode).toBe(200);
    expect((await admin('PUT', '/api/admin/settings/admin-password', { current: TEST_ADMIN_PASSWORD, next: 'another-admin-pass' })).statusCode).toBe(200);
    expect((await admin('PUT', '/api/admin/settings/admin-password', { current: 'another-admin-pass', next: TEST_ADMIN_PASSWORD })).statusCode).toBe(200);
    const pre = await admin('POST', '/api/admin/import-v1/preview', {});
    expect(pre.statusCode).toBe(400);
    expect(pre.json().code).toBeDefined();
    // 整套流程下来，自动开书仍然是关的
    expect((await getSettings()).autoStart.enabled).toBe(false);
  });
});
