import { describe, expect, it } from 'vitest';
import type { Outcome } from '@novelist/shared';
import { planFailure } from '../orchestrator/actions.js';
import { BOOK_LADDER_MS, EMPTY_LADDER_MS, classifyV3Run, type V3RunFacts } from './judge.js';

const now = new Date('2026-11-10T00:00:00.000Z');
const plus = (ms: number) => new Date(now.getTime() + ms).toISOString();
const facts = (p: Partial<V3RunFacts> = {}): V3RunFacts => ({
  outcome: { status: 'completed' },
  ownerCancelled: false,
  lost: false,
  accepted: 0,
  changed: 0,
  noChapterStreak: 0,
  emptyStreak: 0,
  accountStreak: 0,
  planFailure: null,
  now,
  ...p,
});
const fullOutcome = (o: Partial<Outcome>): Outcome => ({ status: 'failed', usage: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costSource: 'unknown' }, denials: [], exitCode: 1, signal: null, rateLimits: [], ...o });
const fp = (o: Partial<Outcome>) =>
  planFailure(o.errorClass ?? 'network', { taskId: 't', kind: 'book.write', bookId: 'b', outcome: fullOutcome(o), orch: {} as never, profile: 'p1', accountId: 'a1', vendor: 'google', refusalRetryOtherVendor: false, denialInOutDir: false, now }).result;

describe('classifyV3Run (§2.10 table)', () => {
  it('row 1: accepted > 0 → done, counters reset, infra side effects kept', () => {
    const v = classifyV3Run(facts({ accepted: 3, changed: 8, outcome: { status: 'failed', errorClass: 'quota' }, planFailure: { status: 'waiting', retryAfter: plus(3600_000) } }));
    expect(v).toMatchObject({ status: 'done', infraClass: 'quota', zeroDiff: false, bookEmpty: 'reset', pauseAccount: false, bookInbox: null });
    expect(v.retryAfter).toBeUndefined();
  });
  it('row 2: owner-cancelled → keep_cancelled, no counters', () => {
    expect(classifyV3Run(facts({ ownerCancelled: true, outcome: { status: 'cancelled' }, changed: 2 }))).toMatchObject({ status: 'keep_cancelled', zeroDiff: false, bookEmpty: 'keep', pauseAccount: false });
    expect(classifyV3Run(facts({ ownerCancelled: true, outcome: { status: 'cancelled' } }))).toMatchObject({ status: 'keep_cancelled', zeroDiff: false, bookEmpty: 'keep' });
  });
  it('row 3: killRun (cancelled outcome, task live) → waiting 10 min, no counters', () => {
    expect(classifyV3Run(facts({ outcome: { status: 'cancelled' }, changed: 3, noChapterStreak: 1 }))).toEqual({ status: 'waiting', retryAfter: plus(10 * 60_000), infraClass: null, zeroDiff: false, bookEmpty: 'keep', pauseAccount: false, bookInbox: null });
  });
  it('row 4: ladder 30m/2h/6h/24h by streak', () => {
    const at = (n: number) => classifyV3Run(facts({ changed: 2, noChapterStreak: n })).retryAfter;
    expect([1, 2, 3, 4, 7].map(at)).toEqual([plus(BOOK_LADDER_MS[0] as number), plus(2 * 3600_000), plus(6 * 3600_000), plus(24 * 3600_000), plus(24 * 3600_000)]);
    expect(classifyV3Run(facts({ changed: 2, noChapterStreak: 1 }))).toMatchObject({ status: 'waiting', zeroDiff: false, bookEmpty: 'reset', bookInbox: null });
    expect(classifyV3Run(facts({ changed: 2, noChapterStreak: 5 })).bookInbox).toBe('no_prose');
    expect(classifyV3Run(facts({ changed: 2, noChapterStreak: 6 })).bookInbox).toBeNull();
  });
  it('row 4: changes after quota exit → waiting with max(ladder, retryAfter)', () => {
    const far = plus(5 * 3600_000);
    expect(classifyV3Run(facts({ changed: 2, noChapterStreak: 1, outcome: { status: 'failed', errorClass: 'quota' }, planFailure: { status: 'waiting', retryAfter: far } }))).toMatchObject({ status: 'waiting', retryAfter: far, infraClass: 'quota' });
    const near = plus(60_000);
    expect(classifyV3Run(facts({ changed: 2, noChapterStreak: 1, outcome: { status: 'failed', errorClass: 'rate_limit' }, planFailure: { status: 'waiting', retryAfter: near } })).retryAfter).toBe(plus(30 * 60_000));
  });
  it('row 5: zero changes + infra → planFailure wait, no counters', () => {
    const r = fp({ errorClass: 'quota', retryAfter: plus(2 * 3600_000) });
    expect(classifyV3Run(facts({ outcome: { status: 'failed', errorClass: 'quota' }, planFailure: r, accountStreak: 1 }))).toEqual({ status: 'waiting', retryAfter: plus(2 * 3600_000), infraClass: 'quota', zeroDiff: false, bookEmpty: 'keep', pauseAccount: false, bookInbox: null });
  });
  it('row 5: model_unavailable / overloaded over cap: retry mapped to waiting, avoidProfile kept', () => {
    const mu = fp({ errorClass: 'model_unavailable' });
    expect(mu.status).toBe('retry');
    const v = classifyV3Run(facts({ outcome: { status: 'failed', errorClass: 'model_unavailable' }, planFailure: { status: mu.status, ...(mu.retryAfter ? { retryAfter: mu.retryAfter } : {}), ...(mu.avoidProfile ? { avoidProfile: mu.avoidProfile } : {}) } }));
    expect(v).toMatchObject({ status: 'waiting', avoidProfile: 'p1', infraClass: 'model_unavailable', zeroDiff: false });
    const over = classifyV3Run(facts({ outcome: { status: 'failed', errorClass: 'overloaded' }, planFailure: { status: 'retry' } }));
    expect(over).toMatchObject({ status: 'waiting', retryAfter: plus(10 * 60_000), zeroDiff: false, bookEmpty: 'keep' });
  });
  it('row 6: lost with zero changes → book empty +1, account untouched', () => {
    expect(classifyV3Run(facts({ lost: true, outcome: { status: 'failed', errorClass: 'harness_crash' } }))).toEqual({ status: 'waiting', retryAfter: plus(60_000), infraClass: null, zeroDiff: false, bookEmpty: 'inc', pauseAccount: false, bookInbox: null });
    expect(classifyV3Run(facts({ lost: true, emptyStreak: 2, accountStreak: 5 }))).toMatchObject({ retryAfter: plus(EMPTY_LADDER_MS[2] as number), zeroDiff: false, pauseAccount: false });
  });
  it('row 6b: clean exit with zero changes → book empty +1 on its ladder, account untouched', () => {
    expect(classifyV3Run(facts())).toEqual({ status: 'waiting', retryAfter: plus(10 * 60_000), infraClass: null, zeroDiff: false, bookEmpty: 'inc', pauseAccount: false, bookInbox: null });
    expect(classifyV3Run(facts({ accountStreak: 1 }))).toMatchObject({ zeroDiff: false, pauseAccount: false, bookEmpty: 'inc' });
    expect(classifyV3Run(facts({ accountStreak: 3, emptyStreak: 9 }))).toMatchObject({ zeroDiff: false, pauseAccount: false, retryAfter: plus(24 * 3600_000) });
    const at = (n: number) => classifyV3Run(facts({ emptyStreak: n })).retryAfter;
    expect([0, 1, 2, 3, 4, 8].map(at)).toEqual([plus(10 * 60_000), plus(30 * 60_000), plus(2 * 3600_000), plus(6 * 3600_000), plus(24 * 3600_000), plus(24 * 3600_000)]);
    expect(classifyV3Run(facts({ emptyStreak: 4, accountStreak: 1 }))).toMatchObject({ bookInbox: 'empty', pauseAccount: false, zeroDiff: false });
    expect(classifyV3Run(facts({ emptyStreak: 3 })).bookInbox).toBeNull();
    expect(classifyV3Run(facts({ emptyStreak: 5 })).bookInbox).toBeNull();
  });
  it('row 7: non-clean zero-diff → account and book +1; streak ≥2 → pauseAccount', () => {
    const crash = { status: 'failed', errorClass: 'harness_crash' } as const;
    expect(classifyV3Run(facts({ outcome: crash }))).toEqual({ status: 'waiting', retryAfter: plus(10 * 60_000), infraClass: null, zeroDiff: true, bookEmpty: 'inc', pauseAccount: false, bookInbox: null });
    expect(classifyV3Run(facts({ outcome: crash, accountStreak: 1 })).pauseAccount).toBe(true);
    expect(classifyV3Run(facts({ outcome: crash, accountStreak: 3, emptyStreak: 9 }))).toMatchObject({ pauseAccount: true, retryAfter: plus(24 * 3600_000) });
  });
  it('timeout with zero changes → zeroDiff', () => {
    for (const errorClass of ['timeout_wall', 'timeout_idle', 'harness_crash', 'refusal'] as const) {
      expect(classifyV3Run(facts({ outcome: { status: errorClass.startsWith('timeout') ? 'timeout' : 'failed', errorClass } }))).toMatchObject({ zeroDiff: true, bookEmpty: 'inc', status: 'waiting' });
    }
  });
  it('empty streak 5 → v3_empty inbox', () => {
    expect(classifyV3Run(facts({ emptyStreak: 4 })).bookInbox).toBe('empty');
    expect(classifyV3Run(facts({ emptyStreak: 4, outcome: { status: 'failed', errorClass: 'harness_crash' } })).bookInbox).toBe('empty');
    expect(classifyV3Run(facts({ emptyStreak: 4, lost: true })).bookInbox).toBe('empty');
    expect(classifyV3Run(facts({ emptyStreak: 5 })).bookInbox).toBeNull();
    expect(classifyV3Run(facts({ emptyStreak: 4, outcome: { status: 'failed', errorClass: 'quota' }, planFailure: { status: 'waiting' } })).bookInbox).toBeNull();
  });
  it('never returns blocked/retry', () => {
    const outcomes: V3RunFacts['outcome'][] = [{ status: 'completed' }, { status: 'cancelled' }, { status: 'timeout', errorClass: 'timeout_wall' }, ...(['auth', 'quota', 'rate_limit', 'overloaded', 'billing', 'model_unavailable', 'network', 'refusal', 'budget', 'config'] as const).map((errorClass) => ({ status: 'failed' as const, errorClass }))];
    for (const outcome of outcomes) {
      for (const changed of [0, 3]) {
        for (const lost of [false, true]) {
          const v = classifyV3Run(facts({ outcome, changed, lost, noChapterStreak: changed ? 1 : 0, planFailure: { status: 'blocked' } }));
          expect(['done', 'waiting', 'keep_cancelled']).toContain(v.status);
          if (v.status === 'waiting') expect(v.retryAfter).toBeTruthy();
        }
      }
    }
  });
});

describe('classifyV3Run: finale completed on an already-accepted chapter', () => {
  it('no new chapter but the harvest completed the book → done, not the book ladder', () => {
    expect(classifyV3Run(facts({ accepted: 0, completed: true, changed: 1, noChapterStreak: 0 }))).toMatchObject({ status: 'done', bookEmpty: 'reset', bookInbox: null });
    expect(classifyV3Run(facts({ accepted: 0, completed: false, changed: 1, noChapterStreak: 1 })).status).toBe('waiting');
  });
});
