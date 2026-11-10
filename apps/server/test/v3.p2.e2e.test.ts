/**
 * v3 第二阶段端到端（p2-plan §6 WP-4 test/v3.e2e）：createTestApp（进程内、内存 PGlite、fake harness 目录模式）。
 * 覆盖：长篇的收尾阶段与复盘、失控兜底（开 / 关）、长篇结局偏短的一次延长、主人的操作（留言、改写请求、从这里起重写、回退、采用残稿）、
 * 自动开书走 v3（书库摘要、必用关键词）、待办卫生（空跑、没写出正文）、首页状态句。
 * 场景队列：$DATA/tmp/fake-v3/<slug>.json（每次 run 取队首）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { zSystemSettings, type BookSummary, type V3BookView } from '@novelist/shared';
import { openRepo, P, type BookRepo } from '../src/book/index.js';
import { books, inbox, runs, tasks } from '../src/db/schema.js';
import { resumeZeroDiffAccount } from '../src/flow/accounts.js';
import { reconcileV3Inbox } from '../src/flow/inbox-v3.js';
import { readV3Meta } from '../src/flow/state.js';
import { chapterText } from '../src/flow/testing.js';
import type { OrderSpec } from '../src/flow/types.js';
import { createGenre } from '../src/genres/index.js';
import { createScheduler, execEnv, type ExecutorDeps } from '../src/orchestrator/index.js';
import { maybeStartBook } from '../src/services/auto-start.js';
import { createBook } from '../src/services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../src/testing.js';

let t: TestApp;
let cookie = '';

afterEach(async () => {
  await t?.close();
});

async function boot(): Promise<void> {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}

const execDeps = (): ExecutorDeps => ({ db: t.deps.db, config: t.deps.config, paths: t.deps.paths, log: t.deps.log, bus: t.deps.bus, secrets: t.deps.secrets, owner: `${os.hostname()}:${process.pid}` });
const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const ok = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const res = await inject(method, url, payload);
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(200);
  return res.json() as Record<string, unknown>;
};

interface Bk {
  id: string;
  slug: string;
  repo: BookRepo;
}

async function v3Book(slug: string, o: { length: 'short' | 'medium' | 'long' | 'epic'; target?: number; batch?: number; min?: number; genre?: string }): Promise<Bk> {
  const b = await createBook(t.deps, {
    title: `书${slug}`,
    slug,
    genre: o.genre ?? 'xianxia',
    seed: '一个关于雨夜和旧信的故事。\n',
    flow: 'v3',
    v3: { length: o.length, ...(o.target ? { target_cjk: o.target } : {}), ...(o.batch ? { batch: o.batch } : {}), ...(o.min ? { min_chapter_cjk: o.min } : {}) },
    start: false,
  });
  const id = (await t.deps.db.select().from(books).where(eq(books.slug, b.slug)))[0]!.id;
  await t.deps.orchestrator.startBook(id, { interview: false });
  return { id, slug: b.slug, repo: openRepo(path.join(t.deps.paths.books, b.slug)) };
}

const bookRow = async (b: Bk) => (await t.deps.db.select().from(books).where(eq(books.id, b.id)))[0]!;
const metaOf = async (b: Bk) => readV3Meta((await bookRow(b)).meta);
const accepted = async (b: Bk) => (await bookRow(b)).acceptedThrough;
const flowTasks = async (b: Bk) => (await t.deps.db.select().from(tasks).where(eq(tasks.bookId, b.id))).filter((x) => ['book.open', 'book.write', 'book.retro'].includes(x.kind)).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
/** 真的启动过 harness 的 run（prepare 就跳过的任务也会留一行 run，但从没启动） */
const runsOf = async (b: Bk) => (await t.deps.db.select().from(runs).where(eq(runs.bookId, b.id))).filter((x) => x.startedAt !== null).sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
const inboxOf = async (prefix: string, state?: string) => (await t.deps.db.select().from(inbox)).filter((i) => (i.dedupeKey ?? '').startsWith(prefix) && (state === undefined || i.state === state));
const orderOf = async (runDir: string): Promise<OrderSpec> => JSON.parse(await fs.readFile(path.join(runDir, 'in', 'order.json'), 'utf8')) as OrderSpec;
const view = async (b: Bk) => (await ok('GET', `/api/admin/books/${b.slug}/v3`)) as unknown as V3BookView;
const yamlOf = async (b: Bk) => yamlParse((await b.repo.readFile(P.bookYaml)) as string) as { v3: Record<string, unknown> };
const allBlobs = async (b: Bk) => {
  const n = await accepted(b);
  return b.repo.blobShas(Array.from({ length: n }, (_, i) => P.manuscript(i + 1)), await b.repo.head());
};

async function scenarios(b: Pick<Bk, 'slug'>, list: unknown[]): Promise<void> {
  const dir = path.join(t.deps.paths.tmp, 'fake-v3');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${b.slug}.json`), JSON.stringify(list));
}

async function wake(b: Pick<Bk, 'id'>): Promise<void> {
  for (const x of await t.deps.db.select().from(tasks).where(eq(tasks.bookId, b.id))) {
    if (x.state === 'waiting' || x.state === 'ready') await t.deps.db.update(tasks).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, x.id));
  }
}

/** 一次 run：场景放进队列 → 叫醒 → 跑一个 tick；返回这次 run 的任务单 */
async function step(b: Bk, scenario: Record<string, unknown> = {}): Promise<{ run: typeof runs.$inferSelect; order: OrderSpec }> {
  await scenarios(b, [scenario]);
  await wake(b);
  const before = (await runsOf(b)).length;
  await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
  const rs = await runsOf(b);
  expect(rs.length, 'exactly one new run').toBe(before + 1);
  const run = rs.at(-1)!;
  return { run, order: await orderOf(run.runDir) };
}

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 正在跑的 run（fake 的 sleepMs）的快照目录：等 ORDER.md 和第 no 章都写出来 */
async function runningSnapshot(b: Bk, no: number): Promise<string> {
  let snap = '';
  await waitFor(`chapter ${no} in the run snapshot`, async () => {
    const p = (await metaOf(b)).pending;
    if (p) snap = p.snapshotDir;
    return snap !== '' && (await fs.stat(path.join(snap, P.manuscript(no))).then(() => true, () => false));
  });
  return snap;
}

describe('v3 phase 2 e2e (fake harness, in-process)', () => {
  it('long book with retro and closing: open → writes → closing (effort high) → retro after the fifth batch → closing → merged finale → completed', async () => {
    await boot();
    // 长篇、目标 5.6 万字（计划 14 章）、每批 2 章；每章约 3000 字，结局时总字数过六成，不触发延长
    const b = await v3Book('longr', { length: 'long', target: 56_000, batch: 2, min: 2500 });
    let r = await step(b);
    expect(r.order).toMatchObject({ mode: 'open-long', from: 1, count: 2, effort: 'medium' });
    for (const from of [3, 5, 7]) {
      r = await step(b);
      expect(r.order, String(from)).toMatchObject({ mode: 'write', from, phase: 'normal', effort: 'medium' });
    }
    // 第四批入库后复盘到期，但存稿没满：先写下一批；还剩 6 章 ≤ 3 批：收尾阶段（effort high），先写结局章节清单
    expect((await metaOf(b)).batchLog).toHaveLength(4);
    r = await step(b);
    expect(r.order).toMatchObject({ kind: 'book.write', mode: 'write', from: 9, phase: 'closing', effort: 'high', endingListExists: false });
    expect(await accepted(b)).toBe(10);
    // 第五批入库后：还剩 4 章（多于一批半，不是结局批），复盘第 1–10 章（effort medium），只改笔记，不动正文
    const before = await allBlobs(b);
    r = await step(b);
    expect(r.order).toMatchObject({ kind: 'book.retro', mode: 'retro', retro: { from: 1, to: 10 }, effort: 'medium' });
    expect(await b.repo.readFile('notes/retro.md')).toMatch(/复盘意见/);
    expect(await allBlobs(b)).toEqual(before);
    expect((await metaOf(b)).retro).toMatchObject({ afterBatches: 5, lastStatus: 'done' });
    r = await step(b);
    expect(r.order).toMatchObject({ kind: 'book.write', mode: 'write', from: 11, phase: 'closing', effort: 'high', endingListExists: true });
    // 还剩 2 章：结局批第 13–14 章，带“（全书完）”，完结
    r = await step(b);
    expect(r.order).toMatchObject({ kind: 'book.write', mode: 'finale', from: 13, count: 2, effort: 'high' });
    const row = await bookRow(b);
    expect(row.status).toBe('completed');
    expect(row.acceptedThrough).toBe(14);
    expect((await metaOf(b)).completedReason).toBe('marker');
    expect((await metaOf(b)).completedNote).toBeUndefined();
    // 恰好一次复盘
    expect((await runsOf(b)).filter((x) => x.taskKind === 'book.retro')).toHaveLength(1);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 5 });
    expect(await runsOf(b)).toHaveLength(8);
    const page = await view(b);
    expect(page.status.kind).toBe('completed');
    expect(page.retro).toMatchObject({ enabled: true, batchesSince: 2, every: 4 });
    expect(page.runs.map((x) => x.taskKind)).toEqual(['book.write', 'book.write', 'book.retro', 'book.write', 'book.write', 'book.write', 'book.write', 'book.open']);
  }, 600_000);

  it('runaway backstop (default factor 2): forced finale after two landed batches at ≥ 2 × base, completed backstop, one v3_end item', async () => {
    await boot();
    // 开着时倍数不能低于 2
    expect((await inject('PUT', '/api/admin/settings', { v3: { runawayFactor: 1 } })).statusCode).toBe(400);
    // 中篇、计划 3 章（基准 3）、每批 2 章；结局批一直不写“（全书完）”：兜底线 2 × 3 = 6 章
    const b = await v3Book('runaway', { length: 'medium', target: 12_000, batch: 2, min: 500 });
    let r = await step(b, { v3: { noMarker: true } });
    expect(r.order.mode).toBe('open-long');
    // 第 3–8 章：每次一章的结局批；开写时已写到 6 章起才计失控批数
    const expectBatches: Record<number, number> = { 3: 0, 4: 0, 5: 0, 6: 0, 7: 1, 8: 2 };
    for (let from = 3; from <= 8; from += 1) {
      r = await step(b, { v3: { noMarker: true } });
      expect(r.order, String(from)).toMatchObject({ mode: 'finale', from, forced: false });
      expect((await metaOf(b)).runawayBatches, String(from)).toBe(expectBatches[from]);
      expect((await bookRow(b)).status).not.toBe('completed');
    }
    r = await step(b, { v3: { noMarker: true } });
    expect(r.order).toMatchObject({ mode: 'finale', from: 9, count: 1, forced: true, effort: 'high' });
    expect((await bookRow(b)).status).toBe('completed');
    expect((await metaOf(b)).completedReason).toBe('backstop');
    expect(await inboxOf(`v3_end:${b.id}`)).toHaveLength(1);
    expect((await view(b)).status.sentence).toMatch(/^已完结，共 9 章 .*（写到上限后强制收尾）/);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 5 });
    expect(await runsOf(b)).toHaveLength(8);
  }, 600_000);

  it('backstop off (factor 0): after two marker-less finales one v3_end item, book still active, no second item', async () => {
    await boot();
    await ok('PUT', '/api/admin/settings', { v3: { runawayFactor: 0 } });
    const b = await v3Book('nostop', { length: 'medium', target: 12_000, batch: 2, min: 500 });
    await step(b, { v3: { noMarker: true } });
    let r = await step(b, { v3: { noMarker: true } });
    expect(r.order).toMatchObject({ mode: 'finale', forced: false });
    expect(await inboxOf(`v3_end:${b.id}`)).toHaveLength(0);
    r = await step(b, { v3: { noMarker: true } });
    expect(r.order).toMatchObject({ mode: 'finale', forced: false });
    expect(await inboxOf(`v3_end:${b.id}`)).toHaveLength(1);
    r = await step(b, { v3: { noMarker: true } });
    expect(r.order).toMatchObject({ mode: 'finale', forced: false });
    expect(await inboxOf(`v3_end:${b.id}`)).toHaveLength(1);
    expect(['active', 'planning']).toContain((await bookRow(b)).status);
    expect((await metaOf(b)).finaleNoMarker).toBe(3);
  }, 600_000);

  it('long book ends too short: completes only after the one extension; planned raised', async () => {
    await boot();
    // 长篇、目标 4 万字（计划 10 章）、每批 5 章、每章约 1800 字：第一次结局时只有约 1.8 万字（不到六成）
    const b = await v3Book('lshort', { length: 'long', target: 40_000, batch: 5, min: 1500 });
    const pub = parseDocumentSet(await b.repo.readFile(P.bookYaml), ['publish', 'max_buffer'], 100);
    await ok('PUT', `/api/admin/books/${b.slug}/config`, { raw: pub, baseSha: (await ok('GET', `/api/admin/books/${b.slug}/config`)).sha });
    await step(b);
    let r = await step(b);
    expect(r.order).toMatchObject({ mode: 'finale', from: 6 });
    expect(await accepted(b)).toBe(10);
    let row = await bookRow(b);
    expect(row.status).not.toBe('completed');
    const meta = await metaOf(b);
    expect(meta.shortEndUsed).toBe(true);
    expect(meta.hints.some((h) => h.kind === 'end_too_short' && h.rewrite === 10)).toBe(true);
    const planned = (await yamlOf(b)).v3.planned_chapters as number;
    expect(planned).toBeGreaterThan(10);
    expect(meta.plannedFloor).toBe(planned);
    expect(((await b.repo.readFile(P.manuscript(10))) as string).includes('（全书完）')).toBe(false);
    // 延长之后接着写，直到写满新的计划章数再收尾
    for (let i = 0; i < 12 && (await bookRow(b)).status !== 'completed'; i += 1) {
      r = await step(b);
      expect(r.order.allowRewrite.filter((k) => k !== 10)).toEqual([]);
    }
    row = await bookRow(b);
    expect(row.status).toBe('completed');
    expect(row.acceptedThrough).toBe(planned);
    expect((await metaOf(b)).completedReason).toBe('marker');
    expect((await metaOf(b)).completedNote).toBeUndefined();
    expect((await runsOf(b)).filter((x) => x.taskKind !== 'book.retro').map((x) => x.taskKind).filter((k) => k === 'book.write').length).toBeGreaterThan(1);
  }, 600_000);

  it('owner steering: message receipt, rewrite request (held back from publishing), rewrite_from, rewind to a batch boundary, adopt an unfinished draft', async () => {
    await boot();
    const b = await v3Book('steer', { length: 'medium', batch: 3, min: 500 });
    await step(b);
    expect(await accepted(b)).toBe(3);

    // 给作者的话：等下一次运行读取；读到后显示“已在写第 4–6 章时读取”
    await ok('PUT', `/api/admin/books/${b.slug}/v3/message`, { text: '多写对话，少写景。' });
    expect((await view(b)).ownerMessage).toMatchObject({ text: '多写对话，少写景。', readIn: null });
    await step(b);
    let page = await view(b);
    expect(page.ownerMessage).toBeNull();
    expect(page.ownerHistory[0]).toMatchObject({ text: '多写对话，少写景。', readIn: { kind: 'write', from: 4, to: 6 } });
    expect(await b.repo.readFile('notes/from-owner.md')).toBe('');

    // 带意见重写第 2 章：立即发布模式下，本来能发到第 3 章（最后一批之前），现在只发到第 1 章
    await ok('POST', `/api/admin/books/${b.slug}/chapters/2/actions`, { action: 'rewrite', note: '这一章写得更紧张些' });
    expect((await view(b)).ownerRequests).toMatchObject([{ chapter: 2, status: 'waiting' }]);
    await ok('PUT', `/api/admin/books/${b.slug}/publish`, { mode: 'immediate' });
    for (const x of await flowTasks(b)) if (['ready', 'waiting'].includes(x.state)) await t.deps.db.update(tasks).set({ state: 'waiting', notBefore: new Date(Date.now() + 3600_000).toISOString() }).where(eq(tasks.id, x.id));
    await createScheduler(execDeps()).runUntilIdle({ maxTicks: 5 });
    expect((await bookRow(b)).publishedThrough).toBe(1);
    await ok('PUT', `/api/admin/books/${b.slug}/publish`, { mode: 'manual' });
    const ch2 = (await b.repo.blobShas([P.manuscript(2)]))[P.manuscript(2)];
    let r = await step(b, { v3: { rewriteAllowed: 'append' } });
    expect(r.order.allowRewrite).toContain(2);
    expect(r.order.hintsShown[0]).toMatchObject({ kind: 'owner_rewrite', chapter: 2 });
    expect((await b.repo.blobShas([P.manuscript(2)]))[P.manuscript(2)]).not.toBe(ch2);
    expect((await view(b)).ownerRequests).toMatchObject([{ chapter: 2, status: 'done' }]);
    expect((await b.repo.list('drafts/replaced', { recursive: true })).some((p) => p.endsWith('c00002.md'))).toBe(true);
    expect(await accepted(b)).toBe(9);

    // 从第 8 章起重写：回退到第 7 章，下一批从第 8 章写
    await ok('POST', `/api/admin/books/${b.slug}/chapters/8/actions`, { action: 'rewrite_from', note: '从第 8 章起换个写法' });
    expect(await accepted(b)).toBe(7);
    expect((await b.repo.list('drafts')).some((d) => d.startsWith('drafts/rewound-'))).toBe(true);
    r = await step(b);
    expect(r.order.from).toBe(8);
    expect(r.order.hintsShown.some((h) => h.text.includes('从第 8 章起换个写法'))).toBe(true);
    expect(await accepted(b)).toBe(10);

    // 回退到批次边界（第 6 章：第 4–6 章那一批写完时）
    page = await view(b);
    expect(page.rewindPoints.map((p) => p.to)).toContain(6);
    const oldHead = await b.repo.head();
    await ok('POST', `/api/admin/books/${b.slug}/v3/rewind`, { to: 6 });
    expect(await accepted(b)).toBe(6);
    expect((await b.repo.tags('trash/rewind-*')).length).toBeGreaterThan(0);
    expect(await b.repo.exists(P.manuscript(7))).toBe(false);
    expect(await b.repo.readFile(P.manuscript(6))).not.toBeNull();
    expect(oldHead).not.toBe(await b.repo.head());

    // 最后一章写断：残稿进 drafts/；主人补好残稿后采用为新章
    r = await step(b, { v3: { truncateLast: true } });
    expect(r.order.from).toBe(7);
    expect(await accepted(b)).toBe(8);
    expect(await b.repo.exists('drafts/c00009.md')).toBe(true);
    const draft = (await view(b)).drafts.find((d) => d.path === 'drafts/c00009.md');
    expect(draft).toMatchObject({ kind: 'unfinished', chapter: 9 });
    const fixed = chapterText(9, 900, '补好的一章', 909);
    const cur = (await ok('GET', `/api/admin/books/${b.slug}/file?path=${encodeURIComponent('drafts/c00009.md')}`)) as { sha: string };
    await ok('PUT', `/api/admin/books/${b.slug}/file`, { path: 'drafts/c00009.md', content: fixed, baseSha: cur.sha, confirm: true });
    await ok('POST', `/api/admin/books/${b.slug}/v3/drafts/adopt`, { path: 'drafts/c00009.md' });
    expect(await accepted(b)).toBe(9);
    expect(await b.repo.tags('ch/00009')).toEqual(['ch/00009']);
    expect((await metaOf(b)).hints.some((h) => h.kind === 'unfinished' && h.chapter === 9)).toBe(false);
    expect((await metaOf(b)).locked).toContain(9);
    // 采用之前排好的第 9 章那一批过时了：不开 run，下一批从第 10 章接着写
    await wake(b);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
    expect((await flowTasks(b)).find((x) => x.target === 'batch-c00009' && x.state !== 'stale' && x.state !== 'done')).toBeUndefined();
    r = await step(b);
    expect(r.order.from).toBe(10);
    // 过时的那一次不算运行：花费里没有它
    const page2 = await view(b);
    expect(page2.runs.every((x) => x.startedAt !== null)).toBe(true);
    expect(page2.cost.runs).toBe((await runsOf(b)).length);
  }, 600_000);

  it('auto-start v3 (maybeStartBook with enabled: false settings): the open ORDER has the library digest, seed.md the must-use keyword', async () => {
    await boot();
    await createGenre(t.deps.paths, { id: 'p-auto', name: '包auto', extends: [] });
    const file = path.join(t.deps.paths.genres, 'p-auto', 'pack.yaml');
    const pack = yamlParse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(file, yamlStringify({ ...pack, auto: { enabled: true, weight: 1, keywords: ['钟表'], adult_only: false } }), 'utf8');
    // 书库里已有一本同题材的完结短篇（书名、简介取自 bible.md）
    const lib = await v3Book('libbook', { length: 'short', min: 500, genre: 'p-auto' });
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 20 });
    const libRow = await bookRow(lib);
    expect(libRow.status).toBe('completed');

    const settings = zSystemSettings.parse({ autoStart: { enabled: false, maxUnfinishedBooks: 3, maxPerDay: 0, genres: ['p-auto'] } });
    expect(settings.autoStart.enabled).toBe(false);
    const slug = await maybeStartBook(t.deps, new Date(), settings, { rng: () => 0 });
    expect(slug).toBeTruthy();
    const auto: Bk = { id: (await t.deps.db.select().from(books).where(eq(books.slug, slug!)))[0]!.id, slug: slug!, repo: openRepo(path.join(t.deps.paths.books, slug!)) };
    expect(yamlParse((await auto.repo.readFile(P.bookYaml)) as string)).toMatchObject({ flow: 'v3', genre: 'p-auto' });
    expect(await auto.repo.readFile('seed.md')).toContain('必须用上的关键词：钟表');
    // 开书运行：在跑的时候读一下快照里的 ORDER.md
    await scenarios(auto, [{ sleepMs: 2000 }]);
    await t.deps.orchestrator.scheduler.tick();
    const snap = await runningSnapshot(auto, 1);
    const order = await fs.readFile(path.join(snap, 'ORDER.md'), 'utf8');
    expect(order).toContain('书库摘要');
    expect(order).toContain(`《${libRow.title}》`);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 20 });
    expect((await bookRow(auto)).acceptedThrough).toBeGreaterThan(0);
  }, 600_000);

  it('inbox hygiene: zero output ×2 → one zero_diff item, auto-closed by the sweep after resume; five no-prose runs → one v3_no_prose item, closed after a landed batch', async () => {
    await boot();
    const b = await v3Book('hyg', { length: 'medium', batch: 3, min: 500 });
    const env = execEnv(execDeps());
    await step(b, { fail: 'harness_crash' });
    await step(b, { fail: 'harness_crash' });
    expect(await inboxOf('zero_diff:', 'open')).toHaveLength(1);
    await reconcileV3Inbox(env, new Date());
    expect(await inboxOf('zero_diff:', 'open')).toHaveLength(1);
    // 主人在账号页恢复了账号（不经待办）：下一次清扫自动关闭
    await resumeZeroDiffAccount(t.deps.db, 'fake');
    await reconcileV3Inbox(env, new Date());
    expect(await inboxOf('zero_diff:', 'open')).toHaveLength(0);

    await step(b);
    expect(await accepted(b)).toBe(3);
    // 五次有改动但没有合格的新章（唯一的一章写断了）
    for (let i = 0; i < 5; i += 1) {
      await step(b, { v3: { chapters: 1, truncateLast: true } });
      expect(await accepted(b)).toBe(3);
    }
    expect((await metaOf(b)).noChapterStreak).toBe(5);
    expect(await inboxOf(`v3_no_prose:${b.id}`, 'open')).toHaveLength(1);
    await reconcileV3Inbox(env, new Date());
    expect(await inboxOf(`v3_no_prose:${b.id}`, 'open')).toHaveLength(1);
    await step(b);
    expect(await accepted(b)).toBeGreaterThan(3);
    await reconcileV3Inbox(env, new Date());
    expect(await inboxOf(`v3_no_prose:${b.id}`, 'open')).toHaveLength(0);
    expect(await inboxOf(`v3_no_prose:${b.id}`)).toHaveLength(1);
  }, 600_000);

  it('dashboard: GET /api/admin/books shows the status sentence while a run sleeps', async () => {
    await boot();
    const b = await v3Book('dash', { length: 'medium', batch: 3, min: 500 });
    await step(b);
    await scenarios(b, [{ sleepMs: 3000 }]);
    await wake(b);
    await t.deps.orchestrator.scheduler.tick();
    await runningSnapshot(b, 4);
    const list = (await ok('GET', '/api/admin/books')) as unknown as BookSummary[];
    const row = list.find((x) => x.slug === b.slug)!;
    expect(row.flow).toBe('v3');
    expect(row.v3?.status.kind).toBe('writing');
    expect(row.v3?.status.sentence).toMatch(/^正在写第 4–6 章，已 \d+ 分钟$/);
    expect(row.v3?.cost.runs).toBe(1);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
    expect(await accepted(b)).toBe(6);
    const after = ((await ok('GET', '/api/admin/books')) as unknown as BookSummary[]).find((x) => x.slug === b.slug)!;
    expect(['queued', 'idle']).toContain(after.v3?.status.kind);
    expect(after.v3?.cost.runs).toBe(2);
  }, 600_000);
});

/** book.yaml 原文里设一个键（保留其余） */
function parseDocumentSet(raw: string | null, keyPath: string[], value: unknown): string {
  const y = yamlParse(raw ?? '') as Record<string, unknown>;
  let cur = y;
  for (const k of keyPath.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[keyPath.at(-1)!] = value;
  return yamlStringify(y);
}
