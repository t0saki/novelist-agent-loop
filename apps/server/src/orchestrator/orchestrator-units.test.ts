import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zPublishConfig, type Outcome } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { accounts, accountsState, books, inbox as inboxTable, tasks } from '../db/schema.js';
import type { TaskRow, TaskSpec } from '../pipeline/types.js';
import { actOnInbox, createEventBus, createInboxItem, expireInboxTimeouts, type EventBus } from './index.js';
import { advanceCircuits, applyCanaryResult, circuitState, evaluateCircuit, MIN_SAMPLES, recordRun } from './circuit.js';
import { planFailure } from './actions.js';
import { backoffMs, advancePending, claimNext, completeTask, enqueue, reapExpiredLeases, retryTaskRow } from './queue.js';
import { bufferState, eligibleThrough, nextSlots, publishTick } from './publisher.js';
import { expireReservations, recordRateLimit, reserve, settle, sleepAccount } from './quota.js';
import { checkFeasibility, effectiveRouting, resolveRoute, seedRouting } from './routing.js';
import { addFixtureBook, createOrchTestEnv, type OrchTestEnv } from './testing.js';

const manifest = { hard: {}, soft: {}, rebaseValidators: [], configHash: 'c' };

async function addTask(db: Db, id: string, spec: Partial<TaskSpec> = {}, extra?: { deps?: string[] }): Promise<void> {
  await enqueue(db, { id, baseCommit: null, manifest, spec: { kind: 'chapter.write', bookId: null, target: id, lane: 'side', ...spec, ...(extra?.deps ? { deps: extra.deps } : {}) } });
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
    expect((await enqueue(t.db, { id: 'a', baseCommit: null, manifest, spec: { kind: 'chapter.write', bookId: null, target: 'a', lane: 'side' } })).created).toBe(false);
    const first = await claimNext(t.db, { owner: 'o', leaseMs: 1000 });
    expect(first?.id).toBe('b');
    expect(first?.state).toBe('leased');
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('a');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
  });

  it('allows at most one active write-lane task per book', async () => {
    await t.db.insert(books).values([{ id: 'x', slug: 'x', title: 'x', genre: 'g', status: 'active' }, { id: 'y', slug: 'y', title: 'y', genre: 'g', status: 'active' }]);
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
    await t.db.insert(books).values({ id: 'p', slug: 'p', title: 'p', genre: 'g', status: 'paused', pausedReason: 'owner' });
    await addTask(t.db, 'w', { bookId: 'p', lane: 'write' });
    await addTask(t.db, 'pub', { bookId: 'p', lane: 'system', kind: 'publish' });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('pub');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
  });

  it('max_buffer pause blocks only new chapter.write tasks', async () => {
    await t.db.insert(books).values({ id: 'mb', slug: 'mb', title: 'mb', genre: 'g', status: 'active', pausedReason: 'max_buffer' });
    await addTask(t.db, 'w', { bookId: 'mb', lane: 'write' });
    await addTask(t.db, 's', { bookId: 'mb', kind: 'summary.arc' });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('s');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
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

describe('routing', () => {
  async function addAccount(id: string, harness: string, body: Record<string, unknown> = {}): Promise<void> {
    await t.db.insert(accounts).values({ id, harness, authMode: 'api_key', body });
  }

  it('seedRouting is idempotent and defaults to agy-argon', async () => {
    await seedRouting(t.db);
    const fresh = await createOrchTestEnv({ preset: 'agy-argon' });
    await seedRouting(fresh.db);
    const preset = await effectiveRouting(fresh.db, null);
    expect(preset.id).toBe('agy-argon');
    expect(preset.roles.writer?.chain).toEqual(['agy-argon']);
    await fresh.close();
  });

  it('fake profile only routed with allowFakeHarness', async () => {
    const r = await resolveRoute(t.db, { role: 'writer', book: null, tier: 'standard', now: new Date() });
    expect(r.profile).toBeNull();
    const ok = await resolveRoute(t.db, { role: 'writer', book: null, tier: 'standard', now: new Date(), allowFakeHarness: true });
    expect(ok.profile).toBe('fake');
    expect(ok.harness).toBe('fake');
  });

  it('walks the chain, respects sleeping accounts and on_quota=wait', async () => {
    const { settings } = await import('../db/schema.js');
    await t.db.update(settings).set({ value: { presetId: 'mixed', overrides: {} } }).where(eq(settings.key, 'routing.active'));
    await addAccount('cc1', 'claude-code');
    await addAccount('cx1', 'codex');
    const now = new Date();
    const first = await resolveRoute(t.db, { role: 'writer', book: null, tier: 'standard', now });
    expect(first.profile).toBe('cc-opus');
    await sleepAccount(t.db, 'cc1', new Date(now.getTime() + 3600_000).toISOString(), '5h 窗口耗尽');
    const waiting = await resolveRoute(t.db, { role: 'writer', book: null, tier: 'standard', now });
    expect(waiting.profile).toBeNull();
    expect(waiting.waitUntil).toBeTruthy();
    expect(waiting.cause).toBe('quota');
    // checker 的主链 cx-terra 可用
    const checker = await resolveRoute(t.db, { role: 'checker', book: null, tier: 'standard', now });
    expect(checker.profile).toBe('cx-terra');
  });

  it('degrades and relaxes vendor constraint, marking same-vendor', async () => {
    const { settings } = await import('../db/schema.js');
    await t.db.update(settings).set({ value: { presetId: 'mixed', overrides: { reviewer: { chain: ['cx-sol'], degrade_to: ['agy-argon'], constraint: 'vendor_ne_writer' } } } }).where(eq(settings.key, 'routing.active'));
    await addAccount('cx1', 'codex');
    const now = new Date();
    const r = await resolveRoute(t.db, { role: 'reviewer', book: null, tier: 'standard', now, writerVendor: 'openai' });
    expect(r.profile).toBe('cx-sol');
    expect(r.degraded.length).toBeGreaterThan(0);
    expect(r.sameVendorAsWriter).toBe(true);
  });

  it('account concurrency full → waiting (short retry)', async () => {
    const { settings } = await import('../db/schema.js');
    await t.db.update(settings).set({ value: { presetId: 'cc-only', overrides: {} } }).where(eq(settings.key, 'routing.active'));
    await addAccount('cc1', 'claude-code');
    const { runs } = await import('../db/schema.js');
    await t.db.insert(runs).values({ id: 'r1', taskId: 't', taskKind: 'chapter.write', attempt: 1, role: 'writer', profileId: 'cc-opus', accountId: 'cc1', harness: 'claude-code', isolation: 'container', state: 'running', runDir: '/x' });
    const r = await resolveRoute(t.db, { role: 'writer', book: null, tier: 'standard', now: new Date() });
    expect(r.profile).toBeNull();
    expect(r.cause).toBe('concurrency');
    expect(r.waitUntil).toBeTruthy();
  });

  it('requires_ack is enforced per account', async () => {
    const { profiles, settings } = await import('../db/schema.js');
    await t.db.update(profiles).set({ body: { id: 'agy-argon', harness: 'agy', model: 'gemini-4-argon', requires_ack: ['agy_consumer_wrap'] } }).where(eq(profiles.id, 'agy-argon'));
    await t.db.update(settings).set({ value: { presetId: 'agy-argon', overrides: {} } }).where(eq(settings.key, 'routing.active'));
    await addAccount('ag1', 'agy');
    let r = await resolveRoute(t.db, { role: 'writer', book: null, tier: 'standard', now: new Date() });
    expect(r.profile).toBeNull();
    expect(r.cause).toBe('ack');
    await t.db.update(accounts).set({ body: { riskAck: ['agy_consumer_wrap'] } }).where(eq(accounts.id, 'ag1'));
    r = await resolveRoute(t.db, { role: 'writer', book: null, tier: 'standard', now: new Date() });
    expect(r.profile).toBe('agy-argon');
  });

  it('feasibility reports errors with no accounts and passes with fake', async () => {
    const report = await checkFeasibility(t.db, null);
    expect(report.problems.some((p) => p.severity === 'error')).toBe(true);
    const ok = await checkFeasibility(t.db, null, { allowFakeHarness: true });
    expect(ok.problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(ok.roles.find((r) => r.role === 'writer')?.profile).toBe('fake');
  });

  it('book preset and role overrides win over global', async () => {
    const book = await addFixtureBook(t, 'b1');
    const handle = await t.pipeline.openBook(t.deps as never, book.id);
    handle.config = { ...handle.config, routing: { preset: 'cc-only', roles: { writer: { chain: ['fake'], degrade_to: [], sticky: 'none', on_quota: 'degrade', failover_on: [], failover_chain: [], failover_requires_approval: true, constraint: 'none', distinct_vendors: false } } } } as never;
    const preset = await effectiveRouting(t.db, handle);
    expect(preset.id).toBe('cc-only');
    expect(preset.roles.writer?.chain).toEqual(['fake']);
    expect(preset.roles.planner?.chain).toEqual(['cc-opus']);
  });
});

describe('quota', () => {
  async function account(id: string, body: Record<string, unknown> = {}): Promise<void> {
    await t.db.insert(accounts).values({ id, harness: 'claude-code', authMode: 'subscription_login', body });
  }

  it('reserves within limit (100 - reservePct) and refuses beyond it', async () => {
    await account('a1', { reservePct: 30 });
    await recordRateLimit(t.db, 'a1', { window: '7d', utilization: 0.69, resetsAt: new Date(Date.now() + 86400_000).toISOString(), status: 'allowed' });
    const first = await reserve(t.db, { taskId: 't1', bookId: null, costs: [{ accountId: 'a1', window: '7d', amount: 0.5 }] });
    expect(first.ok).toBe(true);
    const second = await reserve(t.db, { taskId: 't2', bookId: null, costs: [{ accountId: 'a1', window: '7d', amount: 2 }] });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.waitUntil).toBeTruthy();
  });

  it('honours maxWeeklyUtilPct; unknown utilization admits', async () => {
    await account('a1', { reservePct: 10, maxWeeklyUtilPct: 50 });
    await recordRateLimit(t.db, 'a1', { window: '7d', utilization: 49, status: 'allowed' });
    expect((await reserve(t.db, { taskId: 't', bookId: null, costs: [{ accountId: 'a1', window: '7d', amount: 2 }] })).ok).toBe(false);
    await account('a2', {});
    expect((await reserve(t.db, { taskId: 't', bookId: null, costs: [{ accountId: 'a2', window: 'daily', amount: 2 }] })).ok).toBe(true);
  });

  it('settles: writes ledger with util_delta, releases reservations; rejected window sleeps the account', async () => {
    await account('a1');
    await recordRateLimit(t.db, 'a1', { window: '5h', utilization: 10, status: 'allowed' });
    const res = await reserve(t.db, { taskId: 't1', bookId: null, costs: [{ accountId: 'a1', window: '5h', amount: 5 }] });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unexpected');
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    await settle(t.db, {
      reservationIds: res.ids,
      runId: 'r',
      accountId: 'a1',
      profileId: 'cc-opus',
      harness: 'claude-code',
      model: 'm',
      kind: 'chapter.write',
      tier: 'standard',
      bookId: null,
      outcome: outcome({ status: 'completed', rateLimits: [{ window: '5h', utilization: 0.13, resetsAt, status: 'rejected' }] }),
      utilBefore: { '5h': 10 },
    });
    const st = (await t.db.select().from(accountsState).where(eq(accountsState.accountId, 'a1')))[0];
    expect(new Date(st?.sleepUntil ?? 0).toISOString()).toBe(resetsAt);
    const { usageLedger, quotaReservations } = await import('../db/schema.js');
    const ledger = await t.db.select().from(usageLedger);
    expect(ledger[0]?.utilDelta['5h']).toBeCloseTo(3, 3);
    const open = (await t.db.select().from(quotaReservations)).filter((r) => r.settledAt === null);
    expect(open).toEqual([]);
  });

  it('expires stale reservations', async () => {
    await account('a1');
    const r = await reserve(t.db, { taskId: 't', bookId: null, costs: [{ accountId: 'a1', window: '7d', amount: 1 }], ttlMs: 1000, now: new Date('2026-01-01T00:00:00Z') });
    expect(r.ok).toBe(true);
    expect(await expireReservations(t.db, new Date('2026-01-02T00:00:00Z'))).toBe(1);
  });
});

describe('circuit', () => {
  const key = { harness: 'codex', version: '1', isolation: 'container' };
  const record = (cls: Parameters<typeof recordRun>[1]['errorClass'], extra: Partial<Parameters<typeof recordRun>[1]> = {}) => recordRun(t.db, { ...key, errorClass: cls, unknownEventRatio: 0, tailNonceMissing: false, contractViolations: 0, ...extra });

  it('does not trip below min samples', async () => {
    for (let i = 0; i < MIN_SAMPLES - 1; i += 1) expect(await record('drift')).toBe('closed');
  });

  it('trips after min samples, canary failure opens (non-writer), pass closes', async () => {
    for (let i = 0; i < MIN_SAMPLES - 2; i += 1) await record(null);
    await record('config');
    expect(await record('config')).toBe('pending_open');
    expect(await applyCanaryResult(t.db, { ...key, ok: false, writerHarness: false })).toMatchObject({ state: 'open', needsInbox: false });
    expect(await circuitState(t.db, key.harness, key.version, key.isolation)).toBe('open');
    expect(await applyCanaryResult(t.db, { ...key, ok: true, writerHarness: false })).toMatchObject({ state: 'closed' });
    expect(await circuitState(t.db, key.harness, key.version, key.isolation)).toBe('closed');
  });

  it('writer harness: canary failure → 30 min pending with inbox, then open', async () => {
    for (let i = 0; i < MIN_SAMPLES; i += 1) await record(i < 2 ? 'config' : null);
    const now = new Date('2026-03-01T00:00:00Z');
    const r = await applyCanaryResult(t.db, { ...key, ok: false, writerHarness: true, now });
    expect(r.state).toBe('pending_open');
    expect(r.needsInbox).toBe(true);
    const early = await advanceCircuits(t.db, new Date(now.getTime() + 10 * 60_000));
    expect(early.opened).toEqual([]);
    const late = await advanceCircuits(t.db, new Date(now.getTime() + 31 * 60_000));
    expect(late.opened).toHaveLength(1);
    expect(await circuitState(t.db, key.harness, key.version, key.isolation)).toBe('open');
  });

  it('output_contract threshold needs 2x baseline', () => {
    const s = (cls: string | null, count: number) => Array.from({ length: count }, (_, i) => ({ ts: new Date().toISOString(), cls, unk: 0, tail: false, contract: 0, i }));
    expect(evaluateCircuit([...s('output_contract', 6), ...s(null, 44)], 0.1)).toBeNull();
    expect(evaluateCircuit([...s('output_contract', 6), ...s(null, 44)], 0.02)).toMatch(/output_contract/);
    expect(evaluateCircuit([...s('output_contract', 12), ...s(null, 38)], null)).toMatch(/output_contract/);
  });
});

describe('error class table', () => {
  const ctx = (o: Partial<Parameters<typeof planFailure>[1]> = {}) => ({ taskId: 't', kind: 'chapter.write', bookId: 'b', outcome: outcome(), orch: {}, profile: 'cc-opus', accountId: 'acc', vendor: 'anthropic', refusalRetryOtherVendor: true, denialInOutDir: false, now: new Date('2026-01-01T00:00:00Z'), ...o }) as Parameters<typeof planFailure>[1];

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

  it('output_contract avoids the profile after 2 failures on the same profile', () => {
    const one = planFailure('output_contract', ctx());
    expect(one.result.status).toBe('retry');
    expect(one.result.avoidProfile).toBeUndefined();
    const two = planFailure('output_contract', ctx({ orch: { contractFailures: { 'cc-opus': 1 } } }));
    expect(two.result.avoidProfile).toBe('cc-opus');
  });

  it('refusal avoids vendor when allowed, blocks otherwise', () => {
    const a = planFailure('refusal', ctx());
    expect(a.result.status).toBe('retry');
    expect(a.orchPatch.avoidVendors).toEqual(['anthropic']);
    const b = planFailure('refusal', ctx({ refusalRetryOtherVendor: false }));
    expect(b.result.status).toBe('blocked');
    expect(b.inbox?.[0]?.kind).toBe('block');
  });

  it('transient errors wait with growing delay without charging attempts', () => {
    const a = planFailure('overloaded', ctx());
    expect(a.result.status).toBe('waiting');
    expect(a.orchPatch.transient).toBe(1);
    const late = planFailure('network', ctx({ orch: { transient: 12 } }));
    expect(late.result.status).toBe('retry');
  });

  it('config-like errors avoid the profile', () => {
    for (const cls of ['permission_denied', 'sandbox', 'config', 'drift', 'model_unavailable'] as const) {
      expect(planFailure(cls, ctx()).result.avoidProfile).toBe('cc-opus');
    }
  });

  it('harness_crash retries twice before avoiding the profile', () => {
    expect(planFailure('harness_crash', ctx({ orch: { classCounts: { harness_crash: 1 } } })).result.avoidProfile).toBeUndefined();
    expect(planFailure('harness_crash', ctx({ orch: { classCounts: { harness_crash: 2 } } })).result.avoidProfile).toBe('cc-opus');
  });
});

describe('canary 落熔断器', () => {
  it('failed/blocked 的 canary 也设 outbox（否则 pending_open 永远不生效）', async () => {
    await t.db.insert(tasks).values({ id: 'c1', bookId: null, kind: 'harness.canary', target: 'codex@1:container', lane: 'system', state: 'running' });
    await completeTask(t.db, 'c1', { status: 'failed', errorClass: 'harness_crash', message: 'boom' });
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'c1')))[0];
    expect(row?.state).toBe('failed');
    expect((row?.params._orch as { outbox?: boolean }).outbox).toBe(true);
  });
});

describe('publisher', () => {
  const cfg = zPublishConfig.parse({});

  it('eligibleThrough honours lag, audit and per_slot', () => {
    expect(eligibleThrough({ accepted: 30, audited: 30, published: 10, lag: 15 }, cfg)).toBe(11);
    expect(eligibleThrough({ accepted: 20, audited: 30, published: 10, lag: 15 }, cfg)).toBe(6);
    expect(eligibleThrough({ accepted: 30, audited: 5, published: 10, lag: 15 }, cfg)).toBe(5);
    expect(eligibleThrough({ accepted: 30, audited: 5, published: 10, lag: 15 }, { ...cfg, require_audited: false })).toBe(11);
    expect(eligibleThrough({ accepted: 30, audited: 30, published: 10, lag: 15 }, { ...cfg, per_slot: 3 })).toBe(13);
  });

  it('nextSlots follows cadence in timezone', () => {
    const slots = nextSlots({ ...cfg, cadence: '0 8,20 * * *', timezone: 'Asia/Shanghai' }, new Date('2026-01-01T00:00:00Z'), 2);
    expect(slots).toEqual(['2026-01-01T12:00:00.000Z', '2026-01-02T00:00:00.000Z']);
  });

  it('bufferState computes lag and buffer days', async () => {
    await t.db.insert(books).values({ id: 'b', slug: 'b', title: 't', genre: 'g', status: 'active', acceptedThrough: 40, publishedThrough: 10, auditedThrough: 30 });
    const s = await bufferState(t.db, 'b', cfg, 24, new Date('2026-01-01T00:00:00Z'));
    expect(s.buffer).toBe(30);
    expect(s.lag).toBe(24);
    expect(s.bufferDays).toBeGreaterThan(14);
    expect(s.bufferDays).toBeLessThan(17);
  });

  it('存稿超上限但没有可发布章节（审计/lag 卡住）时不暂停生产，提醒 owner，避免互等死锁', async () => {
    await t.db.insert(books).values({ id: 'b', slug: 'b', title: 't', genre: 'g', status: 'active', acceptedThrough: 61, publishedThrough: 0, auditedThrough: 0 });
    const now = new Date('2026-01-01T00:00:00Z');
    let notified = 0;
    await publishTick(t.db, now, { bufferBlocked: async () => { notified += 1; } });
    expect((await t.db.select().from(books).where(eq(books.id, 'b')))[0]?.pausedReason).toBeNull();
    expect(notified).toBe(1);
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

  it('publishes one slot at a time when due, no catch-up, and respects lag', async () => {
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

  it('does not publish when buffer below lag', async () => {
    await t.db.insert(books).values({ id: 'b', slug: 'b', title: 't', genre: 'g', status: 'active', acceptedThrough: 14, auditedThrough: 14 });
    const out: unknown[] = [];
    await publishTick(t.db, new Date('2026-01-01T00:00:00Z'));
    expect(await publishTick(t.db, new Date('2026-01-02T12:30:00Z'), { enqueue: async (x) => void out.push(x) })).toEqual([]);
    expect(out).toEqual([]);
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

  it('approve completes the related blocked task and flags outbox for onTaskDone', async () => {
    await addTask(t.db, 'gate');
    await completeTask(t.db, 'gate', { status: 'hold', message: 'approval' });
    const item = await createInboxItem(t.db, bus, { kind: 'approval', bookId: null, title: 'approve compass', body: {}, actions: [{ id: 'approve', label: '批准' }, { id: 'rewrite_with_note', label: '附笔记重写', needsNote: true }], relatedTaskId: 'gate' });
    await actOnInbox(t.db, bus, item.id, 'approve', 'ok');
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'gate')))[0] as TaskRow;
    expect(row.state).toBe('done');
    expect((row.params._orch as { outbox?: boolean }).outbox).toBe(true);
    const updated = (await t.db.select().from(inboxTable).where(eq(inboxTable.id, item.id)))[0];
    expect(updated?.state).toBe('resolved');
  });

  it('rewrite_with_note requeues task and appends owner note with a new generation', async () => {
    await addTask(t.db, 'gate');
    await completeTask(t.db, 'gate', { status: 'blocked', message: 'x' });
    const item = await createInboxItem(t.db, bus, { kind: 'hold', bookId: null, title: 'hold', body: {}, actions: [{ id: 'rewrite_with_note', label: '重写' }], relatedTaskId: 'gate' });
    await actOnInbox(t.db, bus, item.id, 'rewrite_with_note', '笔记内容');
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'gate')))[0] as TaskRow;
    expect(row.state).toBe('ready');
    const orch = row.params._orch as { generation: number; ownerNotes: { text: string }[] };
    expect(orch.generation).toBe(2);
    expect(orch.ownerNotes[0]?.text).toBe('笔记内容');
  });

  it('on_timeout auto_approve fires; wait does not', async () => {
    await addTask(t.db, 'a');
    await addTask(t.db, 'b');
    await completeTask(t.db, 'a', { status: 'hold' });
    await completeTask(t.db, 'b', { status: 'hold' });
    const now = new Date('2026-01-01T00:00:00Z');
    await createInboxItem(t.db, bus, { kind: 'approval', bookId: null, title: 'a', body: {}, actions: [{ id: 'approve', label: '批准' }], relatedTaskId: 'a', timeoutAt: '2025-12-31T00:00:00.000Z', onTimeout: 'auto_approve' });
    await createInboxItem(t.db, bus, { kind: 'approval', bookId: null, title: 'b', body: {}, actions: [{ id: 'approve', label: '批准' }], relatedTaskId: 'b', timeoutAt: '2025-12-31T00:00:00.000Z', onTimeout: 'wait' });
    expect(await expireInboxTimeouts(t.db, bus, now)).toBe(1);
    expect(((await t.db.select().from(tasks).where(eq(tasks.id, 'a')))[0] as TaskRow).state).toBe('done');
    expect(((await t.db.select().from(tasks).where(eq(tasks.id, 'b')))[0] as TaskRow).state).toBe('blocked');
  });

  it('body.on overrides the default effect (data-driven)', async () => {
    await addTask(t.db, 'g');
    await completeTask(t.db, 'g', { status: 'hold' });
    await t.db.insert(books).values({ id: 'bk', slug: 'bk', title: 't', genre: 'g', status: 'active' });
    const item = await createInboxItem(t.db, bus, {
      kind: 'hold',
      bookId: 'bk',
      title: 'x',
      body: { on: { accept_with_debt: { task: 'done', book: { pausedReason: 'block' } } } },
      actions: [{ id: 'accept_with_debt', label: '接受' }],
      relatedTaskId: 'g',
    });
    await actOnInbox(t.db, bus, item.id, 'accept_with_debt');
    expect((await t.db.select().from(books).where(eq(books.id, 'bk')))[0]?.pausedReason).toBe('block');
  });

  it('failover approve switches the book writer profile', async () => {
    await t.db.insert(books).values({ id: 'bk', slug: 'bk', title: 't', genre: 'g', status: 'active', writerProfile: 'cc-opus' });
    const item = await createInboxItem(t.db, bus, { kind: 'approval', bookId: 'bk', title: 'x', body: { failover: { to: 'cx-sol' } }, actions: [{ id: 'approve', label: 'y' }] });
    await actOnInbox(t.db, bus, item.id, 'approve');
    expect((await t.db.select().from(books).where(and(eq(books.id, 'bk'))))[0]?.writerProfile).toBe('cx-sol');
  });
});

describe('claimNext: max_buffer exemption for v3 owner rewrite requests (WP-2)', () => {
  it('max_buffer-paused book with a waiting owner request: book.write is claimed; without request it is not; chapter.write unaffected', async () => {
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

  it('v2 ordering unchanged: fewer buffered chapters first, then age', async () => {
    await t.db.insert(books).values([
      { id: 'x', slug: 'x', title: 'x', genre: 'g', status: 'active', acceptedThrough: 10, publishedThrough: 2 },
      { id: 'y', slug: 'y', title: 'y', genre: 'g', status: 'active', acceptedThrough: 5, publishedThrough: 2 },
    ]);
    await addTask(t.db, 'cx', { bookId: 'x', lane: 'side' });
    await addTask(t.db, 'cy', { bookId: 'y', lane: 'side' });
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('cy');
    expect((await claimNext(t.db, { owner: 'o', leaseMs: 1000 }))?.id).toBe('cx');
  });

  it('a run end wakes every v3 task parked on 路由等待 at once, so the claim order decides (v2 timers untouched); repeat with swapped buffers', async () => {
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
