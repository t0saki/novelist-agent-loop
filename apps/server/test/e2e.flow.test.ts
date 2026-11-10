/**
 * v3 流程端到端（p1-plan §6 v3.e2e）：createTestApp（进程内、内存 PGlite、fake harness 目录模式），scheduler 跑到空闲。
 * 覆盖：短篇一次写完并可发布、中篇 开书 → 写作 → 结局、混沌序列（不丢已入库的正文、不打转）、
 * 服务器侧故障（finalize 抛错、收稿后崩溃、提交连续失败、丢失的 run）、主人取消 / 接管中取消、运行期间主人改文件、v2 书不受影响。
 *
 * 测试钩子：$DATA/tmp/fake-v3/<slug>.json 是场景队列（每次 run 取队首）；serverFault 只在 allowFakeHarness 下由服务端读取。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument, parse as yamlParse } from 'yaml';
import { V3_TITLE_PLACEHOLDER } from '@novelist/shared';
import { openRepo, P, TRAILER, type BookRepo } from '../src/book/index.js';
import { accountsState, books, chapters, inbox, runs, tasks } from '../src/db/schema.js';
import { readV3Meta } from '../src/flow/state.js';
import type { OrderSpec } from '../src/flow/types.js';
import { commitOwnerEdit, createScheduler, execEnv, reconcileRuns, type ExecutorDeps } from '../src/orchestrator/index.js';
import { createBook, reindexBook } from '../src/services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../src/testing.js';
import { createLegacyBook } from '../src/book/testing-legacy.js';

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

/** 与 t.deps.orchestrator 同一个 owner 的执行器依赖（另起的 scheduler 才能拿到 leader、认领本进程的 lease） */
const execDeps = (): ExecutorDeps => ({ db: t.deps.db, config: t.deps.config, paths: t.deps.paths, log: t.deps.log, bus: t.deps.bus, secrets: t.deps.secrets, owner: `${os.hostname()}:${process.pid}` });

const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

interface Bk {
  id: string;
  slug: string;
  dir: string;
  repo: BookRepo;
}

interface V3Opts {
  length?: 'short' | 'medium' | 'long' | 'epic';
  target?: number;
  batch?: number;
  min?: number;
  title?: string;
  /** book.yaml publish 覆盖（以主人身份在开工前提交） */
  publish?: Record<string, unknown>;
  start?: boolean;
}

async function v3Book(slug: string, o: V3Opts = {}): Promise<Bk> {
  const b = await createBook(t.deps, {
    title: o.title ?? `书${slug}`,
    slug,
    genre: 'xianxia',
    seed: '一个关于雨夜和旧信的故事。\n',
    flow: 'v3',
    v3: { length: o.length ?? 'medium', ...(o.target ? { target_cjk: o.target } : {}), ...(o.batch ? { batch: o.batch } : {}), ...(o.min ? { min_chapter_cjk: o.min } : {}) },
    start: false,
  });
  const dir = path.join(t.deps.paths.books, b.slug);
  const repo = openRepo(dir);
  const id = (await rowOf(b.slug)).id;
  if (o.publish) {
    const doc = parseDocument((await repo.readFile(P.bookYaml)) as string);
    for (const [k, v] of Object.entries(o.publish)) doc.setIn(['publish', k], v);
    await commitOwnerEdit(t.deps.db, repo, id, { files: [{ path: P.bookYaml, content: doc.toString() }], message: 'test: publish config', baseSha: null });
  }
  if (o.start !== false) await t.deps.orchestrator.startBook(id);
  return { id, slug: b.slug, dir, repo };
}

const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
const bookRow = async (b: Bk) => (await t.deps.db.select().from(books).where(eq(books.id, b.id)))[0]!;
const metaOf = async (b: Bk) => readV3Meta((await bookRow(b)).meta);
const flowTasks = async (b: Bk) => (await t.deps.db.select().from(tasks).where(eq(tasks.bookId, b.id))).filter((x) => x.kind === 'book.open' || x.kind === 'book.write').sort((x, y) => x.createdAt.localeCompare(y.createdAt));
const runsOf = async (b: Bk) => (await t.deps.db.select().from(runs).where(eq(runs.bookId, b.id))).sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
const inboxOf = async (prefix: string) => (await t.deps.db.select().from(inbox)).filter((i) => (i.dedupeKey ?? '').startsWith(prefix));
const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const chapterRows = async (b: Bk) => (await t.deps.db.select().from(chapters).where(eq(chapters.bookId, b.id))).sort((x, y) => x.no - y.no);

/** 写场景队列（每次 run 的 prepare 取队首） */
async function scenarios(b: Bk, list: unknown[]): Promise<void> {
  const dir = path.join(t.deps.paths.tmp, 'fake-v3');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${b.slug}.json`), JSON.stringify(list));
}
const queueLeft = async (b: Bk): Promise<unknown[]> => JSON.parse(await fs.readFile(path.join(t.deps.paths.tmp, 'fake-v3', `${b.slug}.json`), 'utf8').catch(() => '[]')) as unknown[];

/** 等待中的 v3 任务立即可执行（代替快进时钟） */
async function wake(b: Bk): Promise<void> {
  for (const x of await flowTasks(b)) if (x.state === 'waiting' || x.state === 'ready') await t.deps.db.update(tasks).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, x.id));
}

const orderOf = async (runDir: string): Promise<OrderSpec> => JSON.parse(await fs.readFile(path.join(runDir, 'in', 'order.json'), 'utf8')) as OrderSpec;
const chapterPath = (no: number) => P.manuscript(no);

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** pending 的快照里已经写出第 no 章（fake 在 sleepMs 之前写完正文） */
async function waitChapterInSnapshot(b: Bk, no: number): Promise<string> {
  let snap = '';
  await waitFor(`chapter ${no} in the run snapshot`, async () => {
    const p = (await metaOf(b)).pending;
    if (p) snap = p.snapshotDir;
    return snap !== '' && (await exists(path.join(snap, chapterPath(no))));
  });
  return snap;
}

const pidAlive = (pid: number | null | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('v3 e2e (fake harness, in-process)', () => {
  it('short v3 book completes in one run and is publishable', async () => {
    await boot();
    const b = await v3Book('short-a', { length: 'short', title: '' });
    expect((await bookRow(b)).title.startsWith(V3_TITLE_PLACEHOLDER)).toBe(true);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 50 });

    const row = await bookRow(b);
    const n = row.acceptedThrough;
    expect(n).toBe(4);
    expect(row.status).toBe('completed');
    // book.open 真的跑了（一次 run），没有别的 v3 任务
    expect((await runsOf(b)).map((r) => [r.taskKind, r.state])).toEqual([['book.open', 'finalized']]);
    expect((await flowTasks(b)).map((x) => [x.kind, x.state])).toEqual([['book.open', 'done']]);
    expect(await b.repo.tags('ch/*')).toEqual(['ch/00001', 'ch/00002', 'ch/00003', 'ch/00004']);
    // 书名、简介取自 bible.md（auto_title）
    const bible = (await b.repo.readFile('bible.md')) as string;
    const title = /^# 《(.+)》/.exec(bible)?.[1];
    expect(title).toBeTruthy();
    expect(row.title).toBe(title);
    expect((row.meta as { blurb?: string }).blurb).toBe(/^一句话：(.+)$/m.exec(bible)?.[1]);
    // 章节名取自正文首行的标题
    const rows = await chapterRows(b);
    for (const c of rows) {
      const text = (await b.repo.readFile(chapterPath(c.no))) as string;
      expect(text.split('\n')[0]).toBe(`# 第${c.no}章 ${c.title}`);
      expect(c.title).not.toBe('');
    }
    expect(((await b.repo.readFile(chapterPath(n))) as string).trimEnd().endsWith('（全书完）')).toBe(true);
    expect((await metaOf(b)).pending).toBeNull();

    // 还没发布：读者看不到
    expect((await inject('GET', `/api/reader/books/${b.slug}/chapters/1`)).statusCode).toBe(404);
    // 发布：改成 immediate，新 scheduler 的第一个 tick 就跑 publishTick
    const doc = parseDocument((await b.repo.readFile(P.bookYaml)) as string);
    doc.setIn(['publish', 'mode'], 'immediate');
    await commitOwnerEdit(t.deps.db, b.repo, b.id, { files: [{ path: P.bookYaml, content: doc.toString() }], message: 'test: publish immediately', baseSha: null });
    await createScheduler(execDeps()).runUntilIdle({ maxTicks: 20 });
    expect((await bookRow(b)).publishedThrough).toBe(n);
    for (let no = 1; no <= n; no += 1) {
      const res = await inject('GET', `/api/reader/books/${b.slug}/chapters/${no}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { text: string; title: string };
      expect(body.text).not.toMatch(/^# 第/m);
      expect(body.title).toBe(rows[no - 1]?.title);
    }
  }, 180_000);

  it('medium v3 book goes open → write → finale', async () => {
    await boot();
    const b = await v3Book('medium-a', { length: 'medium', batch: 5 });
    expect(yamlParse((await b.repo.readFile(P.bookYaml)) as string).v3.planned_chapters).toBe(15);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 100 });

    const row = await bookRow(b);
    expect(row.acceptedThrough).toBe(15);
    expect(row.status).toBe('completed');
    const rs = await runsOf(b);
    expect(rs).toHaveLength(3);
    const orders = await Promise.all(rs.map((r) => orderOf(r.runDir)));
    expect(orders.map((o) => [o.mode, o.from, o.count])).toEqual([
      ['open-long', 1, 5],
      ['write', 6, 5],
      ['finale', 11, 5],
    ]);
    // 每章一个提交（Novelist-Part），各带 ch/NNNNN
    const log = (await b.repo.log({ limit: 200 })).items;
    const parts = log.filter((c) => c.trailers[TRAILER.part]).map((c) => Number(c.trailers[TRAILER.part]?.replace(/^.*#/, '')));
    expect(parts.sort((x, y) => x - y)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(await b.repo.tags('ch/*')).toHaveLength(15);
    expect((await flowTasks(b)).every((x) => x.state === 'done')).toBe(true);
  }, 240_000);

  it('chaos never loses accepted prose and never loops', async () => {
    await boot();
    // 失控兜底保持默认的 2 倍（开着时不能低于 2）：这本书写不到 54 章，兜底在这里不会触发（兜底的 e2e 在 v3.p2.e2e）
    // 计划 27 章、每批 3 章；存稿上限调高，整本都不用发布
    const b = await v3Book('chaos', { length: 'medium', target: 27 * 4000, batch: 3, min: 500, publish: { max_buffer: 100, resume_buffer: 90 } });
    const blobs = new Map<number, string>();
    let steps = 0;

    /** 一步 = 场景队列放一个场景 → 叫醒等待中的任务 → 跑一个 tick（至多一次 run）→ 检查不变量 */
    async function step(scenario: Record<string, unknown>): Promise<{ run: typeof runs.$inferSelect; order: OrderSpec }> {
      steps += 1;
      await scenarios(b, [scenario]);
      await wake(b);
      const before = (await runsOf(b)).length;
      await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
      const rs = await runsOf(b);
      expect(rs.length, `step ${steps}: exactly one new run`).toBe(before + 1);
      expect(await queueLeft(b)).toEqual([]);
      const run = rs.at(-1) as typeof runs.$inferSelect;
      const order = await orderOf(run.runDir);
      // 不变量：已入库的正文不变（授权改写除外）；没有 blocked / failed；run 数有界
      const head = await b.repo.head();
      const nos = [...blobs.keys()];
      const now = await b.repo.blobShas(nos.map(chapterPath), head);
      for (const no of nos) {
        if (order.allowRewrite.includes(no)) continue;
        expect(now[chapterPath(no)], `step ${steps}: chapter ${no} unchanged`).toBe(blobs.get(no));
      }
      const accepted = (await bookRow(b)).acceptedThrough;
      const all = await b.repo.blobShas(Array.from({ length: accepted }, (_, i) => chapterPath(i + 1)), head);
      for (let no = 1; no <= accepted; no += 1) {
        expect(all[chapterPath(no)], `chapter ${no} in HEAD`).toBeTruthy();
        blobs.set(no, all[chapterPath(no)] as string);
      }
      expect((await flowTasks(b)).filter((x) => x.state === 'blocked' || x.state === 'failed')).toEqual([]);
      expect(rs.length).toBeLessThanOrEqual(steps);
      return { run, order };
    }
    const accepted = async () => (await bookRow(b)).acceptedThrough;
    const hints = async () => (await metaOf(b)).hints;

    // 1–2. 两次空跑（run 失败且什么都没写）：账号暂停、恰好一个待办，书不 blocked；“恢复账号”解除
    await step({ fail: 'harness_crash' });
    expect((await flowTasks(b)).at(-1)?.state).toBe('waiting');
    expect(await inboxOf('zero_diff:')).toHaveLength(0);
    await step({ fail: 'harness_crash' });
    expect((await flowTasks(b)).at(-1)?.state).toBe('waiting');
    expect((await bookRow(b)).status).toBe('planning');
    const zero = await inboxOf('zero_diff:');
    expect(zero).toHaveLength(1);
    const sleeping = (await t.deps.db.select().from(accountsState).where(eq(accountsState.accountId, 'fake')))[0];
    expect(Date.parse(sleeping?.sleepUntil ?? '')).toBeGreaterThan(Date.now());
    await t.deps.orchestrator.actInbox(zero[0]!.id, 'resume');
    expect((await t.deps.db.select().from(accountsState).where(eq(accountsState.accountId, 'fake')))[0]?.sleepUntil ?? null).toBeNull();

    // 3. 最后一章被截断：前缀入库，残稿进 drafts/，提示带到下一次任务单
    let r = await step({ v3: { truncateLast: true } });
    expect(r.order.mode).toBe('open-long');
    expect(await accepted()).toBe(2);
    expect(await b.repo.exists('drafts/c00003.md')).toBe(true);
    expect((await hints()).some((h) => h.kind === 'unfinished' && h.chapter === 3)).toBe(true);

    // 4. 写错目录：chapters/00k.md 归位、根 notes.md 照收；上一步的提示出现在这次的任务单里；第 3 章补上
    r = await step({ v3: { wrongDir: true } });
    expect(r.order).toMatchObject({ mode: 'write', from: 3 });
    expect(r.order.hintsShown.some((h) => h.kind === 'unfinished' && h.chapter === 3)).toBe(true);
    expect(await accepted()).toBe(5);
    expect(await b.repo.exists('chapters/003.md')).toBe(false);
    expect(await b.repo.exists('drafts/c00003.md')).toBe(false);
    expect(await b.repo.exists('notes.md')).toBe(true);
    expect((await hints()).map((h) => h.kind)).toEqual(expect.arrayContaining(['relocated', 'misplaced']));

    // 5. 另写一个旧章号：进 drafts/c00002.rewrite.md，第 2 章不动
    r = await step({ v3: { oldNumberElsewhere: 2 } });
    expect(r.order.from).toBe(6);
    expect(await accepted()).toBe(8);
    expect(await b.repo.exists('drafts/c00002.rewrite.md')).toBe(true);
    expect((await hints()).some((h) => h.kind === 'unauthorized_edit')).toBe(true);

    // 6. 不入库的目录：丢弃并提示
    r = await step({ v3: { ignoredDir: true } });
    expect(await accepted()).toBe(11);
    expect(await b.repo.exists('views/scratch.md')).toBe(false);
    expect((await hints()).some((h) => h.kind === 'ignored')).toBe(true);

    // 7. 越权改写已入库的第 4 章：正文不变，改写稿进 drafts/
    r = await step({ v3: { rewriteAccepted: 4 } });
    expect(r.order.allowRewrite).not.toContain(4);
    expect(await accepted()).toBe(14);
    expect(await b.repo.exists('drafts/c00004.rewrite.md')).toBe(true);

    // 8. 不写笔记：提示
    r = await step({ v3: { noNotes: true } });
    expect(await accepted()).toBe(17);
    expect((await hints()).some((h) => h.kind === 'notes_missing')).toBe(true);

    // 9. 一章写短：照收，提示一次（还剩 10 章 > 3 批：普通写作批）
    r = await step({ v3: { shortChapter: 1 } });
    expect(r.order).toMatchObject({ mode: 'write', phase: 'normal', effort: 'medium' });
    expect(await accepted()).toBe(20);
    expect((await hints()).filter((h) => h.kind === 'short').map((h) => h.chapter)).toEqual([18]);
    expect((await metaOf(b)).hintedShort).toContain(18);

    // 10. 写完 2 章后进程被杀：判 harness_crash，2 章照样提交；下一批从第 23 章开始。
    // 还剩 7 章 ≤ 3 批：收尾阶段（effort high），任务单要求先写结局章节清单（fake 在动笔前写进 outline.md）
    r = await step({ v3: { killAfter: 2 } });
    expect(r.order.from).toBe(21);
    expect(r.order).toMatchObject({ mode: 'write', phase: 'closing', effort: 'high', endingListExists: false, runawayWarn: false });
    expect(await b.repo.readFile('outline.md')).toMatch(/^## 结局章节清单$/m);
    expect(r.run.errorClass).toBe('harness_crash');
    expect(await accepted()).toBe(22);
    // 短章提示不重复
    expect((await hints()).filter((h) => h.kind === 'short')).toEqual([]);

    // 11. 写完后额度用完：章节照样提交，账号睡下
    r = await step({ fail: 'quota', failAfterWrite: true });
    expect(r.order.from).toBe(23);
    // 清单已在；还剩 5 章，多于一批半（4 章）：仍是收尾阶段的写作批；22 章没到提醒线 ceil(0.75 × 2 × 27)
    expect(r.order).toMatchObject({ mode: 'write', phase: 'closing', effort: 'high', endingListExists: true, runawayWarn: false, runawayBase: 27 });
    expect(r.run.errorClass).toBe('quota');
    expect(await accepted()).toBe(25);
    const slept = (await t.deps.db.select().from(accountsState).where(eq(accountsState.accountId, 'fake')))[0];
    expect(Date.parse(slept?.sleepUntil ?? '')).toBeGreaterThan(Date.now());
    await t.deps.db.update(accountsState).set({ sleepUntil: null, sleepReason: null }).where(eq(accountsState.accountId, 'fake'));

    // 12–14. 结局批不写“（全书完）”：两次没写也不按完结处理（no_marker_twice 已删除），只提示补标记；第三次写了标记 → 完结
    r = await step({ v3: { noMarker: true } });
    expect(r.order).toMatchObject({ mode: 'finale', from: 26, count: 2, forced: false });
    expect(await accepted()).toBe(27);
    expect((await bookRow(b)).status).not.toBe('completed');
    expect((await metaOf(b))).toMatchObject({ finaleNoMarker: 1, runawayBatches: 0 });
    expect((await hints()).find((h) => h.kind === 'finale_no_marker')?.chapter).toBe(27);
    r = await step({ v3: { noMarker: true } });
    expect(r.order).toMatchObject({ mode: 'finale', from: 28, forced: false });
    expect(r.order.hintsShown.some((h) => h.kind === 'finale_no_marker')).toBe(true);
    expect((await bookRow(b)).status).not.toBe('completed');
    expect((await metaOf(b))).toMatchObject({ finaleNoMarker: 2, runawayBatches: 0 });
    r = await step({});
    expect(r.order).toMatchObject({ mode: 'finale', from: 29, forced: false, effort: 'high' });
    expect(await accepted()).toBe(29);
    expect((await bookRow(b)).status).toBe('completed');
    expect((await metaOf(b)).completedReason).toBe('marker');
    expect(await inboxOf(`v3_end:${b.id}`)).toHaveLength(0);

    // 完结后不再开 run
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 5 });
    expect((await runsOf(b)).length).toBe(steps);
  }, 600_000);

  it('finalize throws once: no second harness run, pending consumed on the next execution', async () => {
    await boot();
    const b = await v3Book('finf', { length: 'short', min: 500 });
    await scenarios(b, [{ v3: { serverFault: 'finalize' } }]);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    const task = (await flowTasks(b))[0]!;
    expect(task.state).toBe('waiting');
    expect((await metaOf(b)).pending).toMatchObject({ stage: 'harvested', failures: 1 });
    expect((await bookRow(b)).acceptedThrough).toBe(0);
    await wake(b);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    const row = await bookRow(b);
    expect(row.acceptedThrough).toBe(4);
    expect(row.status).toBe('completed');
    expect((await metaOf(b)).pending).toBeNull();
    expect(await runsOf(b)).toHaveLength(1);
    expect(await b.repo.tags('ch/*')).toEqual(['ch/00001', 'ch/00002', 'ch/00003', 'ch/00004']);
    const parts = (await b.repo.log({ limit: 50 })).items.filter((c) => c.trailers[TRAILER.part]);
    expect(parts).toHaveLength(4);
  }, 180_000);

  it('crash after harvest, before commit: lease reaped, next execution consumes the pending without a harness run', async () => {
    await boot();
    const b = await v3Book('crash', { length: 'short', min: 500 });
    await scenarios(b, [{ v3: { serverFault: 'crashAfterHarvest' } }]);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    const task = (await flowTasks(b))[0]!;
    expect(['leased', 'running']).toContain(task.state);
    const pending = (await metaOf(b)).pending;
    expect(pending?.stage).toBe('harvested');
    // 快照在收稿之后就删了
    expect(await exists(pending?.snapshotDir as string)).toBe(false);
    await t.deps.db.update(tasks).set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, task.id));
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    expect((await bookRow(b)).acceptedThrough).toBe(4);
    expect((await metaOf(b)).pending).toBeNull();
    expect(await runsOf(b)).toHaveLength(1);
    expect(await b.repo.tags('ch/*')).toHaveLength(4);
  }, 180_000);

  it('promote fails three times: task blocked, pending.failures 3, no v3_pending inbox, no new run; POST v3/pending retry lands the batch', async () => {
    await boot();
    const b = await v3Book('pf', { length: 'short', min: 500 });
    await scenarios(b, [{ v3: { serverFault: 'promote', serverFaultTimes: 3 } }]);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    let task = (await flowTasks(b))[0]!;
    for (let i = 0; i < 2; i += 1) {
      expect(task.state).toBe('waiting');
      await wake(b);
      await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
      task = (await flowTasks(b))[0]!;
    }
    expect(task.state).toBe('blocked');
    expect((await metaOf(b)).pending?.failures).toBe(3);
    // 收稿失败不进待办（WP-3）：状态句和书页显示，主人在书页上重试 / 放弃
    expect(await inboxOf(`v3_pending:${b.id}`)).toHaveLength(0);
    // 状态句和书页（WP-4）：等主人处理
    const page = (await inject('GET', `/api/admin/books/${b.slug}/v3`)).json() as { status: { kind: string; sentence: string }; pending: { failures: number; blocked: boolean } | null };
    expect(page.status).toMatchObject({ kind: 'needs_owner', sentence: '收稿出错 3 次，等你处理（重试或放弃）' });
    expect(page.pending).toMatchObject({ failures: 3, blocked: true });
    // blocked 期间不开新 run
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 5 });
    expect(await runsOf(b)).toHaveLength(1);
    const res = await inject('POST', `/api/admin/books/${b.slug}/v3/pending`, { action: 'retry' });
    expect(res.statusCode).toBe(200);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    expect((await bookRow(b)).acceptedThrough).toBe(4);
    expect((await metaOf(b)).pending).toBeNull();
    expect(await runsOf(b)).toHaveLength(1);
  }, 180_000);

  it('resuming a zero-diff-paused account wakes the tasks parked on it by routing', async () => {
    await boot();
    const b = await v3Book('resume1', { length: 'medium', batch: 3, min: 500 });
    for (let i = 0; i < 2; i += 1) {
      await scenarios(b, [{ fail: 'harness_crash' }]);
      await wake(b);
      await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
    }
    const zero = await inboxOf('zero_diff:');
    expect(zero).toHaveLength(1);
    // 账号睡着时再执行一次：路由不到，任务按 sleepUntil 停到几天以后
    await wake(b);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
    const parked = (await flowTasks(b)).at(-1)!;
    expect(parked.state).toBe('waiting');
    expect(parked.waitReason ?? '').toMatch(/^路由等待/);
    expect(Date.parse(parked.notBefore as string)).toBeGreaterThan(Date.now() + 24 * 3600_000);
    expect(await runsOf(b)).toHaveLength(2);
    await t.deps.orchestrator.actInbox(zero[0]!.id, 'resume');
    const woken = (await t.deps.db.select().from(tasks).where(eq(tasks.id, parked.id)))[0]!;
    expect(Date.parse(woken.notBefore as string)).toBeLessThanOrEqual(Date.now());
    expect(woken.attempts).toBe(parked.attempts);
    await scenarios(b, [{}]);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
    expect(await runsOf(b)).toHaveLength(3);
    expect((await bookRow(b)).acceptedThrough).toBeGreaterThan(0);
  }, 180_000);

  it('infra side effects are applied once per run: consuming the pending after a failed promote does not put a fixed account back to sleep', async () => {
    await boot();
    const b = await v3Book('infra1', { length: 'short', min: 500 });
    await scenarios(b, [{ fail: 'quota', failAfterWrite: true, v3: { serverFault: 'promote' } }]);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    expect((await flowTasks(b))[0]?.state).toBe('waiting');
    expect((await metaOf(b)).pending).toMatchObject({ failures: 1, infraApplied: true });
    const slept = (await t.deps.db.select().from(accountsState).where(eq(accountsState.accountId, 'fake')))[0];
    expect(Date.parse(slept?.sleepUntil ?? '')).toBeGreaterThan(Date.now());
    // 主人处理好了账号（窗口重置）
    await t.deps.db.update(accountsState).set({ sleepUntil: null, sleepReason: null }).where(eq(accountsState.accountId, 'fake'));
    await wake(b);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    expect((await bookRow(b)).acceptedThrough).toBe(4);
    expect((await metaOf(b)).pending).toBeNull();
    expect(await runsOf(b)).toHaveLength(1);
    expect((await t.deps.db.select().from(accountsState).where(eq(accountsState.accountId, 'fake')))[0]?.sleepUntil ?? null).toBeNull();
  }, 180_000);

  it('lost run is harvested: markRunLost keeps the snapshot, the next execution harvests it', async () => {
    await boot();
    const b = await v3Book('lost', { length: 'short', min: 500 });
    await scenarios(b, [{ sleepMs: 1500 }]);
    const s1 = createScheduler(execDeps());
    await s1.tick();
    const snap = await waitChapterInSnapshot(b, 4);
    // 本进程“死掉”：detach（shim 继续跑），再把 shim 和 harness 都杀掉，run 无人接管
    await s1.stop();
    const run = (await runsOf(b))[0]!;
    for (const pid of [run.shimPid, run.harnessPid]) if (pidAlive(pid)) process.kill(pid as number, 'SIGKILL');
    await waitFor('run processes gone', async () => !pidAlive(run.shimPid) && !pidAlive(run.harnessPid));
    // lease 过期 → reconcileRuns → markRunLost：快照保留，pending 还在
    await t.deps.db.update(runs).set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(runs.id, run.id));
    const res = await reconcileRuns(execEnv(execDeps()), new Set());
    expect(res.lost).toEqual([run.id]);
    expect((await runsOf(b))[0]?.state).toBe('lost');
    expect(await exists(path.join(snap, chapterPath(1)))).toBe(true);
    expect((await metaOf(b)).pending).toMatchObject({ runId: run.id, stage: 'run' });
    // 下一次执行只收稿，不开新 run
    await wake(b);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    const row = await bookRow(b);
    expect(row.acceptedThrough).toBe(4);
    expect(row.status).toBe('completed');
    expect((await metaOf(b)).pending).toBeNull();
    expect(await runsOf(b)).toHaveLength(1);
    expect(await exists(snap)).toBe(false);
  }, 180_000);

  it('owner cancels mid-run: chapters so far committed, task stays cancelled, a delayed follow-up continues from k+1', async () => {
    await boot();
    const b = await v3Book('cancel', { length: 'medium', batch: 3, min: 500 });
    await scenarios(b, [{ sleepMs: 60_000 }]);
    const orch = t.deps.orchestrator;
    await orch.scheduler.tick();
    await waitChapterInSnapshot(b, 3);
    const task = (await flowTasks(b))[0]!;
    await orch.cancelTask(task.id);
    // 本进程还在收尾时重试同一个任务：拒绝（否则两份执行会收同一个快照）
    await expect(orch.retryTask(task.id)).rejects.toThrow('收尾');
    // 被取消的 run 收尾（收稿、提交）
    await orch.runUntilIdle({ maxTicks: 1 });
    const cancelled = (await t.deps.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
    expect(cancelled.state).toBe('cancelled');
    const row = await bookRow(b);
    expect(row.acceptedThrough).toBe(3);
    expect((await metaOf(b)).pending).toBeNull();
    expect(await b.repo.tags('ch/*')).toEqual(['ch/00001', 'ch/00002', 'ch/00003']);
    expect(await runsOf(b)).toHaveLength(1);
    // 取消后 10 分钟内不开新 run（给主人暂停的时间）：提议的后续任务都排在取消时刻 + 10 分钟之后
    await orch.runUntilIdle({ maxTicks: 3 });
    const gapUntil = Date.parse(cancelled.finishedAt as string) + 10 * 60_000;
    const next = (await flowTasks(b)).filter((x) => x.id !== task.id);
    // run 收尾期间不提议（否则会多出一个过时的 book.open）；收完之后只有一个从第 4 章写的任务
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ kind: 'book.write', target: 'batch-c00004', state: 'ready' });
    expect(next[0]?.params).toMatchObject({ mode: 'write', from: 4, count: 3 });
    expect(Date.parse(next[0]?.notBefore as string)).toBe(gapUntil);
    expect(await runsOf(b)).toHaveLength(1);
    // 10 分钟后：从第 4 章接着写
    await wake(b);
    await orch.runUntilIdle({ maxTicks: 1 });
    expect((await bookRow(b)).acceptedThrough).toBe(6);
    const rs = await runsOf(b);
    expect(rs).toHaveLength(2);
    expect(await orderOf(rs[1]!.runDir)).toMatchObject({ mode: 'write', from: 4 });
    expect((await t.deps.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.state).toBe('cancelled');
  }, 180_000);

  it('cancel while reattached: kill file + markRunLost on a cancelled task, the pending is consumed by the next task', async () => {
    await boot();
    const b = await v3Book('rcancel', { length: 'short', min: 500 });
    await scenarios(b, [{ sleepMs: 60_000 }]);
    const s1 = createScheduler(execDeps());
    await s1.tick();
    const snap = await waitChapterInSnapshot(b, 4);
    // 进程退出：run 交给 shim（不在本进程里）
    await s1.stop();
    const task = (await flowTasks(b))[0]!;
    const run = (await runsOf(b))[0]!;
    // 主人取消：进程内没有这个 run → 写 kill 文件，shim 终止 harness
    await t.deps.orchestrator.cancelTask(task.id);
    await waitFor('harness killed through the kill file', async () => !pidAlive(run.harnessPid), 30_000);
    // 接管：任务已取消 → 不复活，run 判 lost；pending 和快照都留着
    await t.deps.db.update(runs).set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(runs.id, run.id));
    const res = await reconcileRuns(execEnv(execDeps()), new Set());
    expect(res.lost).toEqual([run.id]);
    expect((await t.deps.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.state).toBe('cancelled');
    expect((await metaOf(b)).pending).toMatchObject({ runId: run.id, stage: 'run' });
    expect(await exists(path.join(snap, chapterPath(4)))).toBe(true);
    // 下一个任务（同一 HEAD → 实例 .1，10 分钟后）消化 pending，不开新 run
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 3 });
    const next = (await flowTasks(b)).filter((x) => x.id !== task.id);
    expect(next).toHaveLength(1);
    expect(String((next[0]!.params as { instance: string }).instance)).toMatch(/\.1$/);
    await wake(b);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    const row = await bookRow(b);
    expect(row.acceptedThrough).toBe(4);
    expect((await metaOf(b)).pending).toBeNull();
    expect(await runsOf(b)).toHaveLength(1);
    expect((await b.repo.log({ limit: 1 })).items[0]?.trailers[TRAILER.task]?.endsWith(`@${run.id}`)).toBe(true);
  }, 180_000);

  it('owner edit during run: batch commits, owner version kept', async () => {
    await boot();
    const b = await v3Book('oedit', { length: 'medium', batch: 3, min: 500 });
    await scenarios(b, [{ sleepMs: 4000 }]);
    const orch = t.deps.orchestrator;
    await orch.scheduler.tick();
    await waitChapterInSnapshot(b, 3);
    // 运行期间主人经 API 改 notes/progress.md（fake 在 sleep 之后才写笔记）
    const ownerText = '# 进度\n\n主人亲手写的进度。\n';
    const res = await inject('PUT', `/api/admin/books/${b.slug}/file`, { path: 'notes/progress.md', content: ownerText, baseSha: null, confirm: true });
    expect(res.statusCode).toBe(200);
    await orch.runUntilIdle({ maxTicks: 1 });
    expect((await bookRow(b)).acceptedThrough).toBe(3);
    expect(await b.repo.readFile('notes/progress.md')).toBe(ownerText);
    expect(await b.repo.exists('drafts/owner-conflicts/notes/progress.md')).toBe(true);
    const last = (await b.repo.log({ limit: 1 })).items[0];
    expect(last?.trailers[TRAILER.ownerWins]).toBe('notes/progress.md');
    expect((await metaOf(b)).hints.some((h) => h.kind === 'owner_edit')).toBe(true);
  }, 180_000);

  it('owner edits an accepted v3 chapter: 200, chapter locked, a later rewriteAccepted goes to drafts', async () => {
    await boot();
    const b = await v3Book('olock', { length: 'medium', batch: 3, min: 500 });
    await scenarios(b, [{}]);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
    expect((await bookRow(b)).acceptedThrough).toBe(3);
    const cur = (await inject('GET', `/api/admin/books/${b.slug}/file?path=${encodeURIComponent(chapterPath(2))}`)).json() as { sha: string; content: string };
    const edited = `${cur.content.trimEnd()}\n\n　　主人补的一段：灯下的人抬起头，望着门外的雨。\n`;
    const res = await inject('PUT', `/api/admin/books/${b.slug}/chapters/2/text`, { text: edited, baseSha: cur.sha });
    expect(res.statusCode).toBe(200);
    expect((await metaOf(b)).locked).toContain(2);
    const ownerBlob = (await b.repo.blobShas([chapterPath(2)]))[chapterPath(2)];
    // 没有因此排 reextract 之类的旧流程任务
    expect((await t.deps.db.select().from(tasks).where(eq(tasks.bookId, b.id))).map((x) => x.kind).filter((k) => k.startsWith('chapter.'))).toEqual([]);
    await scenarios(b, [{ v3: { rewriteAccepted: 2 } }]);
    await wake(b);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
    expect((await bookRow(b)).acceptedThrough).toBe(6);
    expect((await b.repo.blobShas([chapterPath(2)]))[chapterPath(2)]).toBe(ownerBlob);
    expect(await b.repo.exists('drafts/c00002.rewrite.md')).toBe(true);
  }, 180_000);

  it('start on a book with chapters does not enqueue book.open', async () => {
    await boot();
    const b = await v3Book('started', { length: 'medium', batch: 5, start: false });
    const text = (no: number) => `# 第${no}章 旧事${no}\n\n${'雨落在青石板上，他推开门走进屋里。'.repeat(200)}\n`;
    await commitOwnerEdit(t.deps.db, b.repo, b.id, { files: [1, 2].map((no) => ({ path: chapterPath(no), content: text(no) })), message: 'test: chapters', baseSha: null });
    await reindexBook(t.deps, b.slug);
    expect((await bookRow(b)).acceptedThrough).toBe(2);
    await t.deps.orchestrator.bookAction(b.id, { action: 'start' });
    const ts = await flowTasks(b);
    expect(ts.map((x) => x.kind)).toEqual(['book.write']);
    expect(ts[0]?.params).toMatchObject({ mode: 'write', from: 3, count: 5 });
  }, 120_000);

  it('legacy book unaffected (P3): no flow key; start is refused, the scheduler runs to idle without touching it', async () => {
    await boot();
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'v2-book', { chapters: 3, status: 'active', pausedReason: null });
    const repo = openRepo(b.dir);
    const head = await repo.head();
    const y = yamlParse((await repo.readFile(P.bookYaml)) as string) as Record<string, unknown>;
    expect(y.flow).toBeUndefined();
    expect(y.v3).toBeUndefined();
    await expect(t.deps.orchestrator.startBook(b.id)).rejects.toMatchObject({ code: 'legacy_book' });
    const sched = createScheduler(execDeps());
    await sched.runUntilIdle({ maxTicks: 20 });
    expect(await t.deps.db.select().from(tasks).where(and(eq(tasks.bookId, b.id)))).toEqual([]);
    expect((await rowOf('v2-book')).meta).not.toHaveProperty('v3');
    expect(await repo.head()).toBe(head);
  }, 120_000);
});
