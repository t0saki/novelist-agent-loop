import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zPublishConfig, type Outcome } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { accounts, accountsState, books, inbox as inboxTable, tasks } from '../db/schema.js';
import type { TaskRow, TaskSpec } from '../runtime/types.js';
import { actOnInbox, createEventBus, createInboxItem, type EventBus } from './index.js';
import { MODEL_DOWN_MS, planFailure } from './actions.js';
import { backoffMs, advancePending, claimNext, completeTask, enqueue, reapExpiredLeases, retryTaskRow } from './queue.js';
import { bufferState, eligibleThrough, nextSlots, publishTick } from './publisher.js';
import { checkBookBudget, recordRateLimit, settle } from './quota.js';
import { loadSlots, seedProfiles } from './routing.js';
import type { BookHandle } from '../runtime/types.js';
import { zBookConfig } from '@novelist/shared';
import { profiles, settings, usageLedger } from '../db/schema.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';
import { addV3Book } from '../flow/testing-book.js';
import { createLegacyBook } from '../book/testing-legacy.js';

const manifest = { hard: {}, soft: {}, rebaseValidators: [], configHash: 'c' };
/** v3 书的 meta（claimNext 只认 meta.v3 是对象的书） */
const V3 = { v3: {} };

/** kind 可以是已删除的旧种类（字符串照样入库，用来测过滤） */
async function addTask(db: Db, id: string, spec: Partial<Omit<TaskSpec, 'kind'>> & { kind?: string } = {}, extra?: { deps?: string[] }): Promise<void> {
  await enqueue(db, { id, baseCommit: null, manifest, spec: { kind: 'book.write', bookId: null, target: id, lane: 'side', ...spec, ...(extra?.deps ? { deps: extra.deps } : {}) } as TaskSpec });
}

const outcome = (o: Partial<Outcome> = {}): Outcome => ({ status: 'failed', usage: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costSource: 'unknown' }, denials: [], exitCode: 1, signal: null, rateLimits: [], ...o });

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv();
});
afterEach(async () => {
  await t.close();
});

describe('queue', () => {
  it('enqueue is idempotent by id; claim order: priority then age', async () => {
    await addTask(t.db, 'a', { priority: 0 });
    await addTask(t.db, 'b', { priority: 5 });
    expect((await enqueue(t.db, { id: 'a', baseCommit: null, manifest, spec: { kind: 'book.write', bookId: null, target: 'a', lane: 'side' } })).created).toBe(false);
    const first = await claimNext(t.db, { owner: 'o', leaseMs: 1000 });
    expect(first?.id).toBe('b');
    expect(first?.state).toBe('leased');
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('a');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
  });

  it('allows at most one active write-lane task per book', async () => {
    await t.db.insert(books).values([{ id: 'x', slug: 'x', title: 'x', genre: 'g', status: 'active', meta: V3 }, { id: 'y', slug: 'y', title: 'y', genre: 'g', status: 'active', meta: V3 }]);
    await addTask(t.db, 'w1', { bookId: 'x', lane: 'write' });
    await addTask(t.db, 'w2', { bookId: 'x', lane: 'write' });
    await addTask(t.db, 'w3', { bookId: 'y', lane: 'write' });
    const a = await claimNext(t.db, { owner: 'o', leaseMs: 60000, excludeBooksWithActiveWrite: true });
    const b = await claimNext(t.db, { owner: 'o', leaseMs: 60000, excludeBooksWithActiveWrite: true });
    const c = await claimNext(t.db, { owner: 'o', leaseMs: 60000, excludeBooksWithActiveWrite: true });
    expect([a?.id, b?.id].sort()).toEqual(['w1', 'w3']);
    expect(c).toBeNull();
    await completeTask(t.db, 'w1', { status: 'done' });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 60000, excludeBooksWithActiveWrite: true }))?.id).toBe('w2');
  });

  it('skips paused books but still claims publish tasks', async () => {
    await t.db.insert(books).values({ id: 'p', slug: 'p', title: 'p', genre: 'g', status: 'paused', pausedReason: 'owner', meta: V3 });
    await addTask(t.db, 'w', { bookId: 'p', lane: 'write' });
    await addTask(t.db, 'pub', { bookId: 'p', lane: 'system', kind: 'publish' });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('pub');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
  });

  it('max_buffer pause blocks only new book.write tasks', async () => {
    await t.db.insert(books).values({ id: 'mb', slug: 'mb', title: 'mb', genre: 'g', status: 'active', pausedReason: 'max_buffer', meta: V3 });
    await addTask(t.db, 'w', { bookId: 'mb', lane: 'write' });
    await addTask(t.db, 's', { bookId: 'mb', kind: 'publish', lane: 'system' });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('s');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
  });

  it('claimNext never claims a task of a legacy book or an unknown kind', async () => {
    const legacy = await createLegacyBook(t.db, t.paths, 'old', { status: 'active', pausedReason: null });
    await t.db.insert(books).values({ id: 'v', slug: 'v', title: 'v', genre: 'g', status: 'active', meta: V3 });
    await addTask(t.db, 'legacy-write', { bookId: legacy.id, lane: 'write' });
    await addTask(t.db, 'legacy-pub', { bookId: legacy.id, lane: 'system', kind: 'publish' });
    await t.db.insert(tasks).values([
      { id: 'old-kind', bookId: 'v', kind: 'chapter.extract', target: 'c00001', lane: 'side', state: 'ready' },
      { id: 'old-bookless', bookId: null, kind: 'harness.canary', target: 'fake@1:container', lane: 'system', state: 'ready' },
    ]);
    await addTask(t.db, 'ok', { bookId: 'v', lane: 'write' });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('ok');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
    const states = await t.db.select({ id: tasks.id, state: tasks.state }).from(tasks).where(inArray(tasks.id, ['legacy-write', 'legacy-pub', 'old-kind', 'old-bookless']));
    expect(states.every((s) => s.state === 'ready')).toBe(true);
  });

  it('deps gate readiness; failed dep blocks dependent; retry revives', async () => {
    await addTask(t.db, 'dep');
    await addTask(t.db, 'child', {}, { deps: ['dep'] });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('dep');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
    await completeTask(t.db, 'dep', { status: 'failed', message: 'x' });
    await advancePending(t.db);
    let child = (await t.db.select().from(tasks).where(eq(tasks.id, 'child')))[0] as TaskRow;
    expect(child.state).toBe('blocked');
    expect(await retryTaskRow(t.db, 'dep')).toBe(true);
    child = (await t.db.select().from(tasks).where(eq(tasks.id, 'child')))[0] as TaskRow;
    expect(child.state).toBe('pending');
    expect(((await t.db.select().from(tasks).where(eq(tasks.id, 'dep')))[0] as TaskRow).state).toBe('ready');
    await completeTask(t.db, 'dep', { status: 'done' });
    await advancePending(t.db);
    expect(((await t.db.select().from(tasks).where(eq(tasks.id, 'child')))[0] as TaskRow).state).toBe('ready');
  });

  it('retry charges attempts with backoff and fails at max; waiting is free and reclaims after not_before', async () => {
    await addTask(t.db, 'r', { maxAttempts: 2 });
    const now = new Date('2026-01-01T00:00:00Z');
    await claimNext(t.db, { owner: 'o', leaseMs: 1000, now });
    expect(await completeTask(t.db, 'r', { status: 'waiting', retryAfter: '2026-01-01T01:00:00.000Z', message: 'quota' }, { now })).toBe('waiting');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000, now })).toBeNull();
    const later = new Date('2026-01-01T01:00:01Z');
    const again = await claimNext(t.db, { owner: 'o', leaseMs: 1000, now: later });
    expect(again?.id).toBe('r');
    expect(again?.attempts).toBe(0);
    expect(await completeTask(t.db, 'r', { status: 'retry', errorClass: 'unknown' }, { now: later, backoffBaseMs: 1 })).toBe('ready');
    await claimNext(t.db, { owner: 'o', leaseMs: 1000, now: new Date(later.getTime() + 60000) });
    expect(await completeTask(t.db, 'r', { status: 'retry', errorClass: 'unknown' })).toBe('failed');
  });

  it('reaps expired leases without charging attempts', async () => {
    await addTask(t.db, 'l');
    const now = new Date('2026-02-01T00:00:00Z');
    await claimNext(t.db, { owner: 'o', leaseMs: 60_000, now });
    expect(await reapExpiredLeases(t.db, new Date(now.getTime() + 30_000))).toEqual([]);
    expect(await reapExpiredLeases(t.db, new Date(now.getTime() + 90_000))).toEqual(['l']);
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'l')))[0] as TaskRow;
    expect(row.state).toBe('ready');
    expect(row.attempts).toBe(0);
  });

  it('backoff grows exponentially and is capped', () => {
    expect(backoffMs(0, 1000, () => 0.5)).toBe(1000);
    expect(backoffMs(3, 1000, () => 0.5)).toBe(8000);
    expect(backoffMs(30, 1000, () => 0.5)).toBe(1_800_000);
  });
});

describe('profiles seed', () => {
  it('seedProfiles is idempotent, writes the builtin profiles and the system row, and neither presets nor routing.active', async () => {
    const fresh = await createOrchTestEnv({ slots: null });
    try {
      await seedProfiles(fresh.db);
      await seedProfiles(fresh.db);
      const ids = (await fresh.db.select({ id: profiles.id }).from(profiles)).map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining(['agy-argon', 'agy-flash-check', 'fake']));
      const keys = (await fresh.db.select({ key: settings.key }).from(settings)).map((r) => r.key).sort();
      expect(keys).toEqual(['system']);
      const { routingPresets } = await import('../db/schema.js');
      expect(await fresh.db.select().from(routingPresets)).toEqual([]);
      // 没有 routing.slots 行：DEFAULT_SLOTS
      expect(await loadSlots(fresh.db)).toMatchObject({ writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-flash-check', fallback: null } });
    } finally {
      await fresh.close();
    }
  });
});

describe('quota', () => {
  async function account(id: string, body: Record<string, unknown> = {}): Promise<void> {
    await t.db.insert(accounts).values({ id, harness: 'claude-code', authMode: 'subscription_login', body });
  }

  it('settle writes the ledger with util_delta (no reservations); a rejected window sleeps the account', async () => {
    await account('a1');
    await recordRateLimit(t.db, 'a1', { window: '5h', utilization: 10, status: 'allowed' });
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    await settle(t.db, {
      runId: 'r',
      accountId: 'a1',
      profileId: 'cc-opus',
      harness: 'claude-code',
      model: 'm',
      kind: 'book.write',
      bookId: null,
      outcome: outcome({ status: 'completed', rateLimits: [{ window: '5h', utilization: 0.13, resetsAt, status: 'rejected' }] }),
      utilBefore: { '5h': 10 },
    });
    const st = (await t.db.select().from(accountsState).where(eq(accountsState.accountId, 'a1')))[0];
    expect(new Date(st?.sleepUntil ?? 0).toISOString()).toBe(resetsAt);
    const ledger = await t.db.select().from(usageLedger);
    expect(ledger[0]?.utilDelta['5h']).toBeCloseTo(3, 3);
    expect(ledger[0]?.tier).toBeNull();
    const { quotaReservations } = await import('../db/schema.js');
    expect(await t.db.select().from(quotaReservations)).toEqual([]);
  });

  describe('checkBookBudget (book budgets stay enforced for v3)', () => {
    const handle = (budgets: Record<string, unknown>): BookHandle => ({ id: 'bb', slug: 'bb', dir: '/x', repo: null as never, config: zBookConfig.parse({ schema: 'nv.book/1', slug: 'bb', title: 'b', genre: 'g', budgets }), genre: null as never, headCommit: '' });
    const now = new Date('2026-03-15T00:00:00Z');
    it('monthly USD cap → wait until next month', async () => {
      await t.db.insert(usageLedger).values({ profileId: 'p', harness: 'h', taskKind: 'book.write', bookId: 'bb', usd: 3, ts: '2026-03-02T00:00:00.000Z' });
      expect(await checkBookBudget(t.db, handle({ monthly_usd_cap: 5 }), now)).toEqual({ ok: true, waitUntil: null, reason: null });
      expect(await checkBookBudget(t.db, handle({ monthly_usd_cap: 3 }), now)).toEqual({ ok: false, waitUntil: '2026-04-01T00:00:00.000Z', reason: '已达月度 USD 上限 3' });
    });
    it('window util cap', async () => {
      await t.db.insert(usageLedger).values({ profileId: 'p', harness: 'h', taskKind: 'book.write', bookId: 'bb', utilDelta: { '5h': 4 }, ts: '2026-03-14T23:00:00.000Z' });
      const v = await checkBookBudget(t.db, handle({ max_window_util_pct: 4 }), now);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('书在窗口 5h 的占用已达 4%');
      expect((await checkBookBudget(t.db, handle({ max_window_util_pct: 5 }), now)).ok).toBe(true);
    });
    it('chapters_per_day_cap is an old-flow key: ignored', async () => {
      expect((await checkBookBudget(t.db, handle({ chapters_per_day_cap: 0 }), now)).ok).toBe(true);
    });
  });
});

describe('error class table (infra classes only)', () => {
  const ctx = (o: Partial<Parameters<typeof planFailure>[1]> = {}) => ({ taskId: 't', bookId: 'b', outcome: outcome(), orch: {}, profile: 'cc-opus', accountId: 'acc', now: new Date('2026-01-01T00:00:00Z'), ...o }) as Parameters<typeof planFailure>[1];

  it('quota: waiting + sleep until retryAfter, no attempt charged', () => {
    const until = '2026-01-01T05:00:00.000Z';
    const p = planFailure('quota', ctx({ outcome: outcome({ retryAfter: until }) }));
    expect(p.result.status).toBe('waiting');
    expect(p.result.retryAfter).toBe(until);
    expect(p.sleep).toMatchObject({ accountId: 'acc', until });
    expect(p.inbox).toEqual([]);
  });

  it('weekly quota raises inbox; auth marks account bad', () => {
    const until = '2026-01-05T00:00:00.000Z';
    const q = planFailure('quota', ctx({ outcome: outcome({ retryAfter: until }) }));
    expect(q.inbox?.[0]?.kind).toBe('quota');
    const a = planFailure('auth', ctx());
    expect(a.authBad?.accountId).toBe('acc');
    expect(a.inbox?.[0]?.dedupeKey).toBe('auth:acc');
    expect(a.result.status).toBe('waiting');
  });

  it('billing sleeps the account and raises one billing item; rate_limit sleeps until retryAfter', () => {
    const b = planFailure('billing', ctx());
    expect(b.result.status).toBe('waiting');
    expect(b.sleep?.accountId).toBe('acc');
    expect(b.inbox?.[0]?.dedupeKey).toBe('billing:acc');
    const r = planFailure('rate_limit', ctx({ outcome: outcome({ retryAfter: '2026-01-01T00:05:00.000Z' }) }));
    expect(r).toMatchObject({ result: { status: 'waiting', retryAfter: '2026-01-01T00:05:00.000Z' }, sleep: { accountId: 'acc' } });
  });

  it('transient errors wait with growing delay without charging attempts', () => {
    const a = planFailure('overloaded', ctx());
    expect(a.result.status).toBe('waiting');
    expect(a.orchPatch.transient).toBe(1);
    const late = planFailure('network', ctx({ orch: { transient: 12 } }));
    expect(late.result.status).toBe('retry');
  });

  it('model_unavailable: waiting 30 min and the profile cools down (profileDown), no avoid list', () => {
    const p = planFailure('model_unavailable', ctx({ outcome: outcome({ message: 'model gone' }) }));
    const until = new Date(Date.parse('2026-01-01T00:00:00Z') + MODEL_DOWN_MS).toISOString();
    expect(p.result).toEqual({ status: 'waiting', retryAfter: until, errorClass: 'model_unavailable', message: 'model gone' });
    expect(p.profileDown).toEqual({ profileId: 'cc-opus', until, reason: 'model gone' });
    expect(p.orchPatch).toEqual({ classCounts: { model_unavailable: 1 } });
  });

  it('non-infra classes (never passed by v3) → plain retry, no side effects', () => {
    for (const cls of ['refusal', 'output_contract', 'config', 'harness_crash', 'max_turns'] as const) {
      const p = planFailure(cls, ctx());
      expect(p.result.status, cls).toBe('retry');
      expect(p.inbox, cls).toBeUndefined();
      expect(p.sleep, cls).toBeUndefined();
    }
  });
});

describe('publisher', () => {
  const cfg = zPublishConfig.parse({});

  it('eligibleThrough: v3 cap and per_slot only (lag / audit gone)', () => {
    expect(eligibleThrough({ accepted: 30, published: 10 }, cfg, 30)).toBe(11);
    expect(eligibleThrough({ accepted: 30, published: 10 }, { ...cfg, per_slot: 3 }, 30)).toBe(13);
    expect(eligibleThrough({ accepted: 30, published: 10 }, { ...cfg, per_slot: 3 }, 12)).toBe(12);
    expect(eligibleThrough({ accepted: 30, published: 10 }, { ...cfg, mode: 'immediate' }, 25)).toBe(25);
    expect(eligibleThrough({ accepted: 30, published: 10 }, { ...cfg, mode: 'immediate' }, 30)).toBe(30);
    // 没有上限（拿不到 v3 规则）：什么都不发
    expect(eligibleThrough({ accepted: 30, published: 10 }, cfg, undefined)).toBe(10);
    expect(eligibleThrough({ accepted: 30, published: 10 }, { ...cfg, mode: 'immediate' }, undefined)).toBe(10);
  });

  it('nextSlots follows cadence in timezone', () => {
    const slots = nextSlots({ ...cfg, cadence: '0 8,20 * * *', timezone: 'Asia/Shanghai' }, new Date('2026-01-01T00:00:00Z'), 2);
    expect(slots).toEqual(['2026-01-01T12:00:00.000Z', '2026-01-02T00:00:00.000Z']);
  });

  it('bufferState computes buffer and buffer days', async () => {
    await t.db.insert(books).values({ id: 'b', slug: 'b', title: 't', genre: 'g', status: 'active', acceptedThrough: 40, publishedThrough: 10, auditedThrough: 30 });
    const s = await bufferState(t.db, 'b', cfg, new Date('2026-01-01T00:00:00Z'));
    expect(s.buffer).toBe(30);
    expect(Object.keys(s).sort()).toEqual(['accepted', 'buffer', 'bufferDays', 'productionPaused', 'published']);
    expect(s.bufferDays).toBeGreaterThan(14);
    expect(s.bufferDays).toBeLessThan(17);
  });

  it('max_buffer pauses production and resumes below resume_buffer', async () => {
    await t.db.insert(books).values({ id: 'b', slug: 'b', title: 't', genre: 'g', status: 'active', acceptedThrough: 61, publishedThrough: 0, auditedThrough: 61 });
    const now = new Date('2026-01-01T00:00:00Z');
    await publishTick(t.db, now);
    expect((await t.db.select().from(books).where(eq(books.id, 'b')))[0]?.pausedReason).toBe('max_buffer');
    await t.db.update(books).set({ publishedThrough: 10 }).where(eq(books.id, 'b'));
    await publishTick(t.db, now);
    expect((await t.db.select().from(books).where(eq(books.id, 'b')))[0]?.pausedReason).toBe('max_buffer');
    await t.db.update(books).set({ publishedThrough: 17 }).where(eq(books.id, 'b'));
    await publishTick(t.db, now);
    expect((await t.db.select().from(books).where(eq(books.id, 'b')))[0]?.pausedReason).toBeNull();
  });

  it('publishes one slot at a time when due (per_slot), no catch-up', async () => {
    await t.db.insert(books).values({ id: 'b', slug: 'b', title: 't', genre: 'g', status: 'active', acceptedThrough: 30, auditedThrough: 30 });
    const enqueued: { through: number; slot: string | null }[] = [];
    const io = { enqueue: async (x: { bookId: string; through: number; slot: string | null }) => void enqueued.push(x) };
    const t0 = new Date('2026-01-01T00:00:00Z');
    expect(await publishTick(t.db, t0, io)).toEqual([]); // 首次只立水位
    const later = new Date('2026-01-03T12:30:00Z');
    expect(await publishTick(t.db, later, io)).toEqual([{ bookId: 'b', through: 1 }]);
    expect(enqueued).toHaveLength(1);
    // 同一时刻再 tick：水位已前进，不重复发布
    expect(await publishTick(t.db, later, io)).toEqual([]);
    expect(await publishTick(t.db, new Date('2026-01-03T12:40:00Z'), io)).toEqual([]);
  });

});

describe('inbox', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = createEventBus();
  });

  it('dedupes open items and publishes inbox_new once', async () => {
    const seen: string[] = [];
    bus.subscribe((e) => {
      if (e.type === 'inbox_new') seen.push(e.item.id);
    });
    const a = await createInboxItem(t.db, bus, { kind: 'auth', bookId: null, title: 'x', body: {}, actions: [{ id: 'dismiss', label: 'x' }], dedupeKey: 'k' });
    const b = await createInboxItem(t.db, bus, { kind: 'auth', bookId: null, title: 'x', body: {}, actions: [{ id: 'dismiss', label: 'x' }], dedupeKey: 'k' });
    expect(a.id).toBe(b.id);
    expect(seen).toHaveLength(1);
    await actOnInbox(t.db, bus, a.id, 'dismiss');
    const c = await createInboxItem(t.db, bus, { kind: 'auth', bookId: null, title: 'x', body: {}, actions: [{ id: 'dismiss', label: 'x' }], dedupeKey: 'k' });
    expect(c.id).not.toBe(a.id);
  });

  it('rewrite_with_note requeues the task with a new generation (owner notes are no longer appended to the task)', async () => {
    await addTask(t.db, 'gate');
    await completeTask(t.db, 'gate', { status: 'blocked', message: 'x' });
    const item = await createInboxItem(t.db, bus, { kind: 'hold', bookId: null, title: 'hold', body: {}, actions: [{ id: 'rewrite_with_note', label: '重写' }], relatedTaskId: 'gate' });
    await actOnInbox(t.db, bus, item.id, 'rewrite_with_note', '笔记内容');
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'gate')))[0] as TaskRow;
    expect(row.state).toBe('ready');
    const orch = row.params._orch as { generation: number; ownerNotes?: unknown };
    expect(orch.generation).toBe(2);
    expect(orch.ownerNotes).toBeUndefined();
  });

});

describe('claimNext: max_buffer exemption for v3 owner rewrite requests (WP-2)', () => {
  it('max_buffer-paused book with a waiting owner request: book.write is claimed; without request it is not; a removed kind is never claimed', async () => {
    const waiting = { v3: { ownerRequests: [{ id: 'q', kind: 'rewrite', chapter: 3, note: '改', at: '2026-11-10T00:00:00.000Z', status: 'waiting' }] } };
    await t.db.insert(books).values([
      { id: 'rq', slug: 'rq', title: 'rq', genre: 'g', status: 'active', pausedReason: 'max_buffer', meta: waiting },
      { id: 'nr', slug: 'nr', title: 'nr', genre: 'g', status: 'active', pausedReason: 'max_buffer', meta: { v3: { ownerRequests: [{ ...waiting.v3.ownerRequests[0], status: 'done' }] } } },
    ]);
    await addTask(t.db, 'bw-nr', { bookId: 'nr', lane: 'write', kind: 'book.write' });
    await addTask(t.db, 'cw-rq', { bookId: 'rq', lane: 'side', kind: 'chapter.write' });
    await addTask(t.db, 'bw-rq', { bookId: 'rq', lane: 'write', kind: 'book.write' });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('bw-rq');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
  });
});

describe('claimNext: v3 book choice (WP-3, DESIGN §8.2)', () => {
  const sched = (bufferDays: number | null, lastBatchAt: string | null) => ({ v3: { sched: { bufferDays, bufferFull: false, at: '2026-11-10T00:00:00.000Z' }, lastBatchAt } });
  it('fewer buffer days first; tie → older lastBatchAt first; a due retro of a book with fewer buffer days beats another book\'s write', async () => {
    await t.db.insert(books).values([
      { id: 'ba', slug: 'ba', title: 'a', genre: 'g', status: 'active', meta: sched(2, '2026-11-09T00:00:00.000Z') },
      { id: 'bb', slug: 'bb', title: 'b', genre: 'g', status: 'active', meta: sched(0.5, '2026-11-08T00:00:00.000Z') },
      { id: 'bc', slug: 'bc', title: 'c', genre: 'g', status: 'active', meta: sched(0.5, '2026-11-01T00:00:00.000Z') },
      { id: 'bd', slug: 'bd', title: 'd', genre: 'g', status: 'active', meta: sched(null, null) },
    ]);
    await addTask(t.db, 'wd', { bookId: 'bd', lane: 'write', kind: 'book.write' });
    await addTask(t.db, 'wa', { bookId: 'ba', lane: 'write', kind: 'book.write' });
    await addTask(t.db, 'wb', { bookId: 'bb', lane: 'write', kind: 'book.write' });
    await addTask(t.db, 'rc', { bookId: 'bc', lane: 'write', kind: 'book.retro' });
    const order: (string | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) order.push((await claimNext(t.db, { owner: 'o', leaseMs: 60_000 }))?.id);
    expect(order).toEqual(['rc', 'wb', 'wa', 'wd']);
  });

  it('publish tasks (the else arm of the ordering): fewer buffered chapters first, then age', async () => {
    await t.db.insert(books).values([
      { id: 'x', slug: 'x', title: 'x', genre: 'g', status: 'active', acceptedThrough: 10, publishedThrough: 2, meta: V3 },
      { id: 'y', slug: 'y', title: 'y', genre: 'g', status: 'active', acceptedThrough: 5, publishedThrough: 2, meta: V3 },
    ]);
    await addTask(t.db, 'cx', { bookId: 'x', lane: 'system', kind: 'publish' });
    await addTask(t.db, 'cy', { bookId: 'y', lane: 'system', kind: 'publish' });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('cy');
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('cx');
  });

  it('a run end wakes every v3 task parked on 路由等待 at once, so the claim order decides (old-kind rows untouched); repeat with swapped buffers', async () => {
    const { wakeRouteWaiters } = await import('./executor.js');
    for (const [round, daysB, daysC] of [[1, 0.5, 3], [2, 3, 0.5]] as const) {
      const ids = { b: `b${round}`, c: `c${round}`, v2: `v${round}` };
      await t.db.insert(books).values([
        { id: ids.b, slug: ids.b, title: 'b', genre: 'g', status: 'active', meta: sched(daysB, null) },
        { id: ids.c, slug: ids.c, title: 'c', genre: 'g', status: 'active', meta: sched(daysC, null) },
        { id: ids.v2, slug: ids.v2, title: 'v2', genre: 'g', status: 'active' },
      ]);
      const later = new Date(Date.now() + 15_000).toISOString();
      for (const [id, bookId, kind] of [[`wb${round}`, ids.b, 'book.write'], [`wc${round}`, ids.c, 'book.write'], [`cw${round}`, ids.v2, 'chapter.write']] as const) {
        await addTask(t.db, id, { bookId, lane: 'write', kind });
        await t.db.update(tasks).set({ state: 'waiting', waitReason: '路由等待：账号 acct-a 并发已满', notBefore: later }).where(eq(tasks.id, id));
      }
      // 还没到点：谁都认领不到
      expect(await claimNext(t.db, { owner: 'o', leaseMs: 60_000 })).toBeNull();
      const now = new Date();
      expect(await wakeRouteWaiters({ db: t.db, nowFn: () => now })).toBe(2);
      const first = await claimNext(t.db, { owner: 'o', leaseMs: 60_000, now: new Date(now.getTime() + 1) });
      expect(first?.id).toBe(daysB < daysC ? `wb${round}` : `wc${round}`);
      // 旧流程的任务保留自己的计时器
      expect(Date.parse((await t.db.select().from(tasks).where(eq(tasks.id, `cw${round}`)))[0]?.notBefore ?? '')).toBe(Date.parse(later));
      await t.db.update(tasks).set({ state: 'done' }).where(inArray(tasks.id, [`wb${round}`, `wc${round}`, `cw${round}`]));
    }
  });
});
