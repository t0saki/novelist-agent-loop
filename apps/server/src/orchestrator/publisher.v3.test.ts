import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V3_PUBLISH_DEFAULTS, zPublishConfig, type PublishConfig } from '@novelist/shared';
import { books, chapters, tasks } from '../db/schema.js';
import { emptyV3Meta } from '../flow/state.js';
import { v3PublishCap } from '../flow/publish.js';
import { addV3Book } from '../flow/testing-book.js';
import type { V3Hint } from '../flow/types.js';
import { publish } from '../pipeline/handlers/system.js';
import { eligibleThrough, publishTick, type PublishIo } from './publisher.js';
import { createScheduler } from './scheduler.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv({ pipeline: { handlers: { publish } } });
});
afterEach(async () => {
  await t.close();
});

const NOW = new Date('2026-11-10T12:00:00.000Z');
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const v3cfg = (p: Partial<PublishConfig> = {}): PublishConfig => zPublishConfig.parse({ ...V3_PUBLISH_DEFAULTS, ...p });

/** v3 书：accepted 章，第 k 章的入库时间 acceptedAt(k) */
async function book(o: { accepted: number; published?: number; status?: string; lastBatchFrom?: number | null; acceptedAt?: (no: number) => string; hints?: V3Hint[]; meta?: Record<string, unknown> }): Promise<string> {
  const id = 'b';
  await t.db.insert(books).values({
    id,
    slug: id,
    title: 't',
    genre: 'g',
    status: o.status ?? 'active',
    acceptedThrough: o.accepted,
    publishedThrough: o.published ?? 0,
    auditedThrough: 0,
    meta: { ...(o.meta ?? {}), v3: { ...emptyV3Meta(), lastBatchFrom: o.lastBatchFrom ?? null, hints: o.hints ?? [] } },
  });
  for (let no = 1; no <= o.accepted; no += 1) await t.db.insert(chapters).values({ bookId: id, no, chapterId: `c${String(no).padStart(5, '0')}`, state: 'accepted', acceptedAt: o.acceptedAt?.(no) ?? NOW.toISOString() });
  return id;
}

function io(cfg: PublishConfig, extra: Partial<PublishIo> = {}): PublishIo & { enqueued: number[] } {
  const enqueued: number[] = [];
  return {
    enqueued,
    loadConfig: async (bookId) => ({ cfg, arcLength: 0, v3Cap: await v3PublishCap(t.db, bookId, NOW, 24) }),
    enqueue: async ({ through }) => {
      enqueued.push(through);
      return true;
    },
    ...extra,
  };
}

describe('v3 publishing', () => {
  it('chapters of an earlier batch publishable once a later batch landed', async () => {
    const id = await book({ accepted: 10, lastBatchFrom: 6 });
    expect(await v3PublishCap(t.db, id, NOW, 24)).toBe(5);
    const x = io(v3cfg({ mode: 'immediate' }));
    await publishTick(t.db, NOW, x);
    expect(x.enqueued).toEqual([5]);
  });

  it('last batch publishable after 24h', async () => {
    const id = await book({ accepted: 10, lastBatchFrom: 6, acceptedAt: (no) => (no <= 8 ? ago(25) : ago(2)) });
    expect(await v3PublishCap(t.db, id, NOW, 24)).toBe(8);
    await t.db.update(chapters).set({ acceptedAt: ago(30) }).where(eq(chapters.bookId, id));
    expect(await v3PublishCap(t.db, id, NOW, 24)).toBe(10);
  });

  it('completed book → all accepted publishable, paced by per_slot', async () => {
    const id = await book({ accepted: 10, status: 'completed', lastBatchFrom: 6, meta: { publish: { lastSlot: ago(48) } } });
    expect(await v3PublishCap(t.db, id, NOW, 24)).toBe(10);
    const x = io(v3cfg({ per_slot: 2 }));
    await publishTick(t.db, NOW, x);
    expect(x.enqueued).toEqual([2]);
  });

  it('require_audited and min_lag ignored', () => {
    const cfg = v3cfg({ require_audited: true, min_lag: 5, lag: 5, per_slot: 3 });
    expect(eligibleThrough({ accepted: 10, audited: 0, published: 0, lag: 5 }, cfg, false, 9)).toBe(3);
    expect(eligibleThrough({ accepted: 10, audited: 0, published: 0, lag: 5 }, { ...cfg, mode: 'immediate' }, false, 9)).toBe(9);
    // 没有 v3Cap：旧规则（审计前沿卡住）
    expect(eligibleThrough({ accepted: 10, audited: 0, published: 0, lag: 5 }, cfg)).toBe(0);
  });

  it('immediate mode publishes cap', async () => {
    await book({ accepted: 12, lastBatchFrom: 11, acceptedAt: (no) => (no <= 10 ? ago(1) : ago(1)) });
    const x = io(v3cfg({ mode: 'immediate', require_audited: true }));
    await publishTick(t.db, NOW, x);
    expect(x.enqueued).toEqual([10]);
  });

  it('early_end hold keeps chapter k unpublished, released by next harvest or after 72h', async () => {
    const hint = (at: string): V3Hint => ({ kind: 'early_end', text: '第 3 章写成了结局', chapter: 3, rewrite: 3, at });
    const id = await book({ accepted: 10, lastBatchFrom: 6, hints: [hint(ago(1))] });
    expect(await v3PublishCap(t.db, id, NOW, 24)).toBe(2);
    // 72 小时后自动解除
    await t.db.update(books).set({ meta: { v3: { ...emptyV3Meta(), lastBatchFrom: 6, hints: [hint(ago(73))] } } }).where(eq(books.id, id));
    expect(await v3PublishCap(t.db, id, NOW, 24)).toBe(5);
    // 下一次有改动的收稿替换了提示
    await t.db.update(books).set({ meta: { v3: { ...emptyV3Meta(), lastBatchFrom: 6, hints: [hint(ago(1))] } } }).where(eq(books.id, id));
    await t.db.update(books).set({ meta: { v3: { ...emptyV3Meta(), lastBatchFrom: 6, hints: [] } } }).where(eq(books.id, id));
    expect(await v3PublishCap(t.db, id, NOW, 24)).toBe(5);
  });

  it('low-buffer and buffer-blocked inbox suppressed for v3', async () => {
    // 存稿 30 > max_buffer 15，但新一批刚入库、没有可发布的章节；已发布 1 章，每天 2 章 → 存稿天数很多？用 low_buffer_days_alert 拉高
    await book({ accepted: 31, published: 1, lastBatchFrom: 2 });
    let blocked = 0;
    let low = 0;
    const cfg = v3cfg({ low_buffer_days_alert: 1000 });
    await publishTick(t.db, NOW, io(cfg, { bufferBlocked: async () => void (blocked += 1), lowBuffer: async () => void (low += 1) }));
    expect(blocked).toBe(0);
    expect(low).toBe(0);
    expect((await t.db.select().from(books).where(eq(books.id, 'b')))[0]?.pausedReason).toBeNull();
    // 同样的书走旧规则（没有 v3Cap）：两类待办都会发
    await publishTick(t.db, NOW, { loadConfig: async () => ({ cfg: { ...cfg, require_audited: true }, arcLength: 0 }), bufferBlocked: async () => void (blocked += 1), lowBuffer: async () => void (low += 1) });
    expect(blocked).toBe(1);
    expect(low).toBe(1);
  });

  it('scheduler loads the v3 cap for flow: v3 books and enqueues publish', async () => {
    const b = await addV3Book(t, 'v3pub', { chapters: 6, publish: { mode: 'immediate' }, meta: { lastBatchFrom: 4 } });
    const s = createScheduler(t.deps);
    await s.tick();
    await s.stop({ drain: true });
    const pubs = (await t.db.select().from(tasks).where(eq(tasks.bookId, b.id))).filter((x) => x.kind === 'publish');
    expect(pubs.map((p) => p.target)).toEqual(['through-3']);
  });
});
