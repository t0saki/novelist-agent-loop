/** GET /api/admin/books/:slug/v3、PUT …/v3/settings、GET /api/admin/books 的 v3 摘要（p2-plan §2.7、§3.4、§6 api/v3.api.test）。 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';
import type { BookSummary, V3BookView, V3Settings } from '@novelist/shared';
import { openRepo, P } from '../book/index.js';
import { books, runs, tasks } from '../db/schema.js';
import { readV3Meta } from '../flow/state.js';
import { createBook } from '../services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';
import { createLegacyBook } from '../book/testing-legacy.js';
import { bookDir } from './helpers.js';

let t: TestApp;
let cookie: string;

const admin = (method: 'GET' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
const yamlOf = async (slug: string) => yamlParse((await openRepo(bookDir(t.deps, slug)).readFile(P.bookYaml)) as string) as { v3: Record<string, unknown>; publish: Record<string, unknown>; routing?: Record<string, unknown>; budgets?: Record<string, unknown> };
const view = async (slug: string): Promise<V3BookView> => {
  const res = await admin('GET', `/api/admin/books/${slug}/v3`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as V3BookView;
};

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  await createBook(t.deps, { title: '新书', slug: 'fresh', genre: 'xianxia', flow: 'v3', v3: { length: 'medium' }, start: false });
  await createLegacyBook(t.deps.db, t.deps.paths, 'old-v2', { title: '旧流程' });
  // 跑两批（开书 1–5、写作 6–10）的中篇
  await createBook(t.deps, { title: '两批', slug: 'two', genre: 'xianxia', flow: 'v3', v3: { length: 'medium', batch: 5, min_chapter_cjk: 500 }, start: false });
  await t.deps.orchestrator.startBook((await rowOf('two')).id);
  for (let i = 0; i < 2; i += 1) {
    for (const task of await t.deps.db.select().from(tasks)) {
      if (task.state === 'waiting') await t.deps.db.update(tasks).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, task.id));
    }
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
  }
}, 180_000);

afterAll(async () => {
  await t.close();
});

describe('GET /api/admin/books/:slug/v3', () => {
  it('admin guard and 409 not_v3', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/books/fresh/v3' })).statusCode).toBe(401);
    const res = await admin('GET', '/api/admin/books/old-v2/v3');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('not_v3');
  });

  it('view fields for a fresh v3 book', async () => {
    const v = await view('fresh');
    expect(v).toMatchObject({
      slug: 'fresh',
      length: 'medium',
      planned: 15,
      accepted: 0,
      published: 0,
      totalCjk: 0,
      status: { kind: 'draft', sentence: '还没开始' },
      ownerMessage: null,
      ownerHistory: [],
      ownerRequests: [],
      batches: [],
      drafts: [],
      runs: [],
      cost: { runs: 0, hours: 0, outputTokens: 0, tokensPer1kChars: null },
      retro: { enabled: false, batchesSince: 0, every: 4, lastAt: null },
      hints: [],
      pending: null,
      rewindPoints: [],
      locked: [],
      agentsSize: null,
    });
    const y = await yamlOf('fresh');
    expect(v.settings).toEqual({
      target_cjk: y.v3.target_cjk,
      min_chapter_cjk: 3000,
      batch: 5,
      effort: { open: 'medium', write: 'medium', closing: 'high', finale: 'high', retro: 'medium' },
      publish: { mode: y.publish.mode, cadence: y.publish.cadence, timezone: y.publish.timezone, per_slot: y.publish.per_slot, max_buffer: y.publish.max_buffer },
      writer_profile: null,
      budgets: { priority: 0, monthly_usd_cap: null, max_window_util_pct: null },
    });
    for (const f of v.story) expect(f).toMatchObject({ path: expect.any(String), size: expect.any(Number), over: false });
  });

  it('a phase-1 book (no batchLog) is backfilled from git trailers and offers rewind points', async () => {
    const row = await rowOf('two');
    expect(row.acceptedThrough).toBe(10);
    // 模拟 phase 1 写的书：没有 batchLog
    await t.deps.db.update(books).set({ meta: { ...(row.meta as object), v3: { ...readV3Meta(row.meta), batchLog: [], retro: { afterBatches: 0, lastAt: null, lastRunId: null, lastStatus: null } } } }).where(eq(books.id, row.id));
    const v = await view('two');
    expect(v.batches.map((b) => [b.kind, b.from, b.to])).toEqual([
      ['write', 6, 10],
      ['open', 1, 5],
    ]);
    expect(v.rewindPoints.map((p) => p.to)).toEqual([5, 0]);
    const meta = readV3Meta((await rowOf('two')).meta);
    expect(meta.batchLog).toHaveLength(2);
    expect(meta.retro.afterBatches).toBe(2);
    expect(v.story.map((f) => f.path)).toEqual(expect.arrayContaining(['bible.md', 'outline.md', 'notes/progress.md']));
    expect(v.story.find((f) => f.path === 'notes/progress.md')?.budget).toBe(1500);
  });

  it('run cost rows: minutes, output tokens, model, toolSteps', async () => {
    const v = await view('two');
    const dbRuns = (await t.deps.db.select().from(runs).where(eq(runs.bookId, (await rowOf('two')).id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(v.runs.map((r) => r.runId)).toEqual(dbRuns.map((r) => r.id));
    expect(v.runs.map((r) => [r.taskKind, r.mode, r.chapters])).toEqual([
      ['book.write', 'write', [6, 10]],
      ['book.open', 'open-long', [1, 5]],
    ]);
    for (const [i, r] of v.runs.entries()) {
      const d = dbRuns[i]!;
      const usage = d.usage as { output: number; input: number };
      expect(r.outputTokens).toBe(usage.output);
      expect(r.outputTokens).toBeGreaterThan(0);
      expect(r.inputTokens).toBe(usage.input);
      expect(r.model).toBe(d.modelReported ?? d.model);
      expect(r.toolSteps).toBe((d.outcome as { toolSteps: number }).toolSteps);
      expect(typeof r.toolSteps).toBe('number');
      expect(r.minutes).toBe(Math.round((Date.parse(d.endedAt!) - Date.parse(d.startedAt!)) / 6000) / 10);
      expect(r.state).toBe('finalized');
    }
    expect(v.cost.runs).toBe(2);
    expect(v.cost.outputTokens).toBe(v.runs.reduce((s, r) => s + r.outputTokens, 0));
    expect(v.cost.tokensPer1kChars).toBe(Math.round(v.cost.outputTokens / (v.totalCjk / 1000)));
  });
});

describe('GET /api/admin/books', () => {
  it('BookSummary.flow and v3 (sentence, cost); legacy book: flow v2, v3 null, legacy true', async () => {
    const list = (await admin('GET', '/api/admin/books?filter=all')).json() as BookSummary[];
    const two = list.find((b) => b.slug === 'two')!;
    expect(two.flow).toBe('v3');
    expect(two.v3).toMatchObject({ length: 'medium', targetCjk: 60_000, plannedChapters: 15, status: { kind: expect.any(String), sentence: expect.any(String) }, cost: { runs: 2 } });
    expect(two.v3!.cost.outputTokens).toBeGreaterThan(0);
    expect(list.find((b) => b.slug === 'fresh')).toMatchObject({ flow: 'v3', v3: { status: { kind: 'draft', sentence: '还没开始' } } });
    expect(list.find((b) => b.slug === 'old-v2')).toMatchObject({ flow: 'v2', v3: null, legacy: true });
    expect(two.legacy).toBe(false);
  });
});

describe('PUT /api/admin/books/:slug/v3/settings', () => {
  const base = async (slug: string): Promise<V3Settings> => (await view(slug)).settings;

  it('writes book.yaml and returns the view', async () => {
    const s = await base('fresh');
    const next: V3Settings = { ...s, min_chapter_cjk: 3500, batch: 4, effort: { ...s.effort, write: 'high', retro: 'low' }, publish: { ...s.publish, per_slot: 3, max_buffer: 12, cadence: '0 9 * * *' } };
    const res = await admin('PUT', '/api/admin/books/fresh/v3/settings', next);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as V3BookView).settings).toEqual(next);
    const y = await yamlOf('fresh');
    expect(y.v3).toMatchObject({ min_chapter_cjk: 3500, batch: 4, effort: { open: 'medium', write: 'high', finale: 'high', retro: 'low' } });
    expect(y.publish).toMatchObject({ per_slot: 3, max_buffer: 12, resume_buffer: 7, cadence: '0 9 * * *' });
  });

  it('rejects max_buffer < 2 × batch (400 invalid_publish), nothing written', async () => {
    const s = await base('fresh');
    const before = await yamlOf('fresh');
    const res = await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, batch: 8, publish: { ...s.publish, max_buffer: 15 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_publish');
    expect(await yamlOf('fresh')).toEqual(before);
    expect((await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, batch: 9 })).statusCode).toBe(400);
  });

  it('closing effort: shown as finale when book.yaml has none; written once it differs', async () => {
    const s = await base('fresh');
    expect(s.effort.closing).toBe(s.effort.finale);
    let res = await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, effort: { ...s.effort, closing: 'medium' } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as V3BookView).settings.effort.closing).toBe('medium');
    expect((await yamlOf('fresh')).v3).toMatchObject({ effort: { closing: 'medium', finale: 'high' } });
    res = await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, effort: { ...s.effort, closing: 'high' } });
    expect((res.json() as V3BookView).settings.effort.closing).toBe('high');
  });

  it('writer override: an existing profile is written to routing.writer_profile, an unknown one → 400, null deletes the key', async () => {
    const s = await base('fresh');
    const profiles = (await admin('GET', '/api/admin/profiles')).json() as { id: string }[];
    const pick = profiles[0]!.id;
    let res = await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, writer_profile: pick });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as V3BookView).settings.writer_profile).toBe(pick);
    expect((await yamlOf('fresh')).routing).toMatchObject({ writer_profile: pick });
    res = await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, writer_profile: 'no-such-profile' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unknown_profile');
    expect((await yamlOf('fresh')).routing).toMatchObject({ writer_profile: pick });
    res = await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, writer_profile: null });
    expect(res.statusCode).toBe(200);
    expect((await yamlOf('fresh')).routing?.writer_profile).toBeUndefined();
    expect((res.json() as V3BookView).settings.writer_profile).toBeNull();
  });

  it('book budgets round trip: priority mirrors to books.priority, null deletes the cap keys', async () => {
    const s = await base('fresh');
    let res = await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, budgets: { priority: 7, monthly_usd_cap: 12.5, max_window_util_pct: 40 } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as V3BookView).settings.budgets).toEqual({ priority: 7, monthly_usd_cap: 12.5, max_window_util_pct: 40 });
    expect((await yamlOf('fresh')).budgets).toMatchObject({ priority: 7, monthly_usd_cap: 12.5, max_window_util_pct: 40 });
    expect((await rowOf('fresh')).priority).toBe(7);
    res = await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, budgets: { priority: 0, monthly_usd_cap: null, max_window_util_pct: null } });
    expect(res.statusCode).toBe(200);
    const b = (await yamlOf('fresh')).budgets ?? {};
    expect('monthly_usd_cap' in b).toBe(false);
    expect('max_window_util_pct' in b).toBe(false);
    expect((await rowOf('fresh')).priority).toBe(0);
    expect((await admin('PUT', '/api/admin/books/fresh/v3/settings', { ...s, budgets: { priority: 0, monthly_usd_cap: -1, max_window_util_pct: null } })).statusCode).toBe(400);
  });

  it('a target change recomputes the planned chapters and resets runawayBatches', async () => {
    const row = await rowOf('two');
    await t.deps.db.update(books).set({ meta: { ...(row.meta as object), v3: { ...readV3Meta(row.meta), runawayBatches: 2 } } }).where(eq(books.id, row.id));
    const s = await base('two');
    // 降低目标：N0' = 5，计划章数夹到 [3, 10]
    let res = await admin('PUT', '/api/admin/books/two/v3/settings', { ...s, target_cjk: 20_000 });
    expect(res.statusCode, res.body).toBe(200);
    expect((await yamlOf('two')).v3).toMatchObject({ target_cjk: 20_000, planned_chapters_initial: 5, planned_chapters: 10 });
    expect((res.json() as V3BookView).planned).toBe(10);
    expect(readV3Meta((await rowOf('two')).meta).runawayBatches).toBe(0);
    // 提高目标：N0' = 25，计划章数至少到 N0'（不是 ⌈N0'/2⌉，否则立刻进收尾），plannedFloor 抬到 25（收稿时 outline.md 的旧计划夹不回去），六成保护重新给一次
    await t.deps.db.update(books).set({ meta: { ...((await rowOf('two')).meta as object), v3: { ...readV3Meta((await rowOf('two')).meta), shortEndUsed: true } } }).where(eq(books.id, row.id));
    res = await admin('PUT', '/api/admin/books/two/v3/settings', { ...s, target_cjk: 100_000 });
    expect((await yamlOf('two')).v3).toMatchObject({ target_cjk: 100_000, planned_chapters_initial: 25, planned_chapters: 25 });
    expect(readV3Meta((await rowOf('two')).meta)).toMatchObject({ plannedFloor: 25, shortEndUsed: false });
    // 目标不变：不碰计划章数和失控计数
    await t.deps.db.update(books).set({ meta: { ...((await rowOf('two')).meta as object), v3: { ...readV3Meta((await rowOf('two')).meta), runawayBatches: 1 } } }).where(eq(books.id, row.id));
    res = await admin('PUT', '/api/admin/books/two/v3/settings', { ...s, target_cjk: 100_000, min_chapter_cjk: 900 });
    expect(res.statusCode).toBe(200);
    expect((await yamlOf('two')).v3).toMatchObject({ planned_chapters: 25, min_chapter_cjk: 900 });
    expect(readV3Meta((await rowOf('two')).meta).runawayBatches).toBe(1);
    // 再降低目标：plannedFloor 降到不超过新的 N0'
    res = await admin('PUT', '/api/admin/books/two/v3/settings', { ...s, target_cjk: 40_000, min_chapter_cjk: 900 });
    expect(res.statusCode).toBe(200);
    expect(readV3Meta((await rowOf('two')).meta).plannedFloor).toBe(10);
    expect((await yamlOf('two')).v3).toMatchObject({ planned_chapters_initial: 10, planned_chapters: 20 });
  });
});
