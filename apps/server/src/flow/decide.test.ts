import { describe, expect, it } from 'vitest';
import { zV3BookConfig } from '@novelist/shared';
import { CLOSING_BATCHES, RETRO_EVERY, RUNAWAY_WARN_RATIO, decideNext, effortFor, endingPhase, finaleCount, plannedUpper, type FlowState } from './decide.js';

const st = (p: Partial<FlowState> = {}): FlowState => ({
  status: 'active',
  accepted: 5,
  published: 0,
  planned: 15,
  batch: 5,
  length: 'medium',
  maxBuffer: 15,
  productionPaused: false,
  activeFlowTask: false,
  pending: false,
  factor: 2,
  runawayBatches: 0,
  retroDue: false,
  retroRange: null,
  ownerRequestWaiting: false,
  runawayBase: 15,
  sinceRetro: 0,
  rewinding: false,
  ...p,
});
const w = (mode: 'write' | 'finale', from: number, count: number, phase: 'normal' | 'closing' = 'normal', forced = false) => ({ kind: 'write', mode, phase, forced, from, count });

describe('decideNext', () => {
  it('new short book → open-short with count=planned', () => {
    expect(decideNext(st({ status: 'planning', accepted: 0, length: 'short', planned: 4 }))).toEqual({ kind: 'open', mode: 'open-short', count: 4 });
  });
  it('new medium book → open-long with count=batch', () => {
    expect(decideNext(st({ status: 'planning', accepted: 0, batch: 5 }))).toEqual({ kind: 'open', mode: 'open-long', count: 5 });
  });
  it('active flow task → none(busy)', () => {
    expect(decideNext(st({ activeFlowTask: true }))).toEqual({ kind: 'none', reason: 'busy' });
    expect(decideNext(st({ activeFlowTask: true, accepted: 0 }))).toEqual({ kind: 'none', reason: 'busy' });
  });
  it('rewinding → none', () => {
    expect(decideNext(st({ rewinding: true }))).toEqual({ kind: 'none', reason: 'rewinding' });
    expect(decideNext(st({ rewinding: true, accepted: 0 }))).toEqual({ kind: 'none', reason: 'rewinding' });
  });
  it('paused/draft/archived → none(inactive)', () => {
    for (const status of ['paused', 'draft', 'archived']) expect(decideNext(st({ status }))).toEqual({ kind: 'none', reason: 'inactive' });
  });
  it('completed → none(completed)', () => {
    expect(decideNext(st({ status: 'completed' }))).toEqual({ kind: 'none', reason: 'completed' });
  });
  it('buffer full (accepted-published ≥ max_buffer) → none', () => {
    expect(decideNext(st({ accepted: 20, published: 5, maxBuffer: 15, planned: 40, runawayBase: 40 }))).toEqual({ kind: 'none', reason: 'buffer_full' });
    expect(decideNext(st({ accepted: 19, published: 5, maxBuffer: 15, planned: 40, runawayBase: 40 }))).toMatchObject({ kind: 'write', from: 20 });
  });
  it('productionPaused → none', () => {
    expect(decideNext(st({ productionPaused: true }))).toEqual({ kind: 'none', reason: 'buffer_full' });
  });
  it('buffer full but pending → step still proposed', () => {
    expect(decideNext(st({ accepted: 20, published: 5, planned: 40, runawayBase: 40, pending: true }))).toEqual(w('write', 21, 5));
    expect(decideNext(st({ productionPaused: true, pending: true }))).toMatchObject({ kind: 'write' });
  });
  it('buffer full but a waiting owner request → write proposed', () => {
    expect(decideNext(st({ accepted: 20, published: 5, planned: 40, runawayBase: 40, ownerRequestWaiting: true }))).toEqual(w('write', 21, 5));
  });
  it('remaining > 3 batches → normal write from accepted+1', () => {
    expect(decideNext(st({ accepted: 5, planned: 30, runawayBase: 30 }))).toEqual(w('write', 6, 5));
  });
  it('medium: remaining ≤ 3 batches → write phase closing, effort high', () => {
    const step = decideNext(st({ accepted: 5, planned: 15 }));
    expect(step).toEqual(w('write', 6, 5, 'closing'));
    expect(effortFor(step, zV3BookConfig.parse({}))).toBe('high');
    expect(decideNext(st({ accepted: 14, planned: 30, runawayBase: 30 }))).toEqual(w('write', 15, 5));
    expect(decideNext(st({ accepted: 15, planned: 30, runawayBase: 30, maxBuffer: 100 }))).toEqual(w('write', 16, 5, 'closing'));
    expect(decideNext(st({ accepted: 15, planned: 30, runawayBase: 30, batch: 4, maxBuffer: 100 }))).toEqual(w('write', 16, 4, 'normal'));
  });
  it('remaining ≤ batch → finale', () => {
    expect(decideNext(st({ accepted: 10, planned: 15 }))).toEqual(w('finale', 11, 5));
    expect(decideNext(st({ accepted: 12, planned: 15 }))).toEqual(w('finale', 13, 3));
  });
  it('remaining ≤ 1.5 batches → one merged finale (no 1-chapter finale run); one more → closing write', () => {
    expect(decideNext(st({ accepted: 10, planned: 16, runawayBase: 16 }))).toEqual(w('finale', 11, 6));
    expect(decideNext(st({ accepted: 10, planned: 17, runawayBase: 17 }))).toEqual(w('finale', 11, 7));
    expect(decideNext(st({ accepted: 10, planned: 18, runawayBase: 18 }))).toEqual(w('write', 11, 5, 'closing'));
    // batch 1：⌊1.5⌋ = 1，和以前一样
    expect(decideNext(st({ accepted: 10, planned: 12, runawayBase: 12, batch: 1 }))).toEqual(w('write', 11, 1, 'closing'));
    expect(decideNext(st({ accepted: 10, planned: 11, runawayBase: 11, batch: 1 }))).toEqual(w('finale', 11, 1));
  });
  it('the finale is not held by the buffer cap or a max_buffer pause; a retro does not pre-empt it', () => {
    // 中篇 planned 16、batch 5、已写 15、已发 1：存稿 14 ≥ max_buffer 10
    const base = { accepted: 15, published: 1, planned: 16, runawayBase: 16, maxBuffer: 10 };
    expect(decideNext(st(base))).toEqual(w('finale', 16, 1));
    expect(decideNext(st({ ...base, productionPaused: true }))).toEqual(w('finale', 16, 1));
    expect(decideNext(st({ ...base, length: 'long', retroDue: true, retroRange: { from: 1, to: 15 }, sinceRetro: RETRO_EVERY }))).toEqual(w('finale', 16, 1));
    // 上一个结局批没写（全书完）：照常受存稿上限约束
    expect(decideNext(st({ ...base, finaleNoMarker: 1 }))).toEqual({ kind: 'none', reason: 'buffer_full' });
    // 写作批照旧停
    expect(decideNext(st({ ...base, planned: 30, runawayBase: 30 }))).toEqual({ kind: 'none', reason: 'buffer_full' });
  });
  it('finaleCount: short books unlimited, others capped at ⌊1.5·batch⌋', () => {
    expect(finaleCount('short', 39, 2)).toBe(39);
    expect(finaleCount('long', 39, 2)).toBe(3);
    expect(finaleCount('medium', 0, 5)).toBe(1);
  });
  it('short book stays finale (never closing)', () => {
    expect(decideNext(st({ length: 'short', accepted: 2, planned: 4, runawayBase: 4 }))).toEqual(w('finale', 3, 2));
    expect(decideNext(st({ length: 'short', accepted: 1, planned: 40, runawayBase: 40, batch: 2 }))).toEqual(w('finale', 2, 39));
  });
  it('accepted ≥ planned, not completed → finale count 1', () => {
    expect(decideNext(st({ accepted: 15, published: 10, planned: 15 }))).toEqual(w('finale', 16, 1));
    expect(decideNext(st({ accepted: 18, published: 10, planned: 15 }))).toEqual(w('finale', 19, 1));
    expect(decideNext(st({ length: 'short', accepted: 5, planned: 4, runawayBase: 4 }))).toEqual(w('finale', 6, 1));
  });
  it('accepted > 0 never yields open', () => {
    for (const length of ['short', 'medium', 'long', 'epic'] as const) {
      for (const accepted of [1, 3, 10, 60]) expect(decideNext(st({ length, accepted, planned: 50, runawayBase: 50, maxBuffer: 100 })).kind).not.toBe('open');
    }
  });

  describe('retro', () => {
    const long = (p: Partial<FlowState> = {}) => st({ length: 'long', accepted: 20, planned: 50, runawayBase: 50, maxBuffer: 15, retroDue: true, retroRange: { from: 1, to: 20 }, sinceRetro: RETRO_EVERY, ...p });
    it('retro due (sinceRetro 4), buffer not full → write first', () => {
      expect(decideNext(long({ published: 10 }))).toEqual(w('write', 21, 5));
    });
    it('retro due, buffer full → retro step with range', () => {
      expect(decideNext(long({ published: 5 }))).toEqual({ kind: 'retro', from: 1, to: 20 });
      expect(decideNext(long({ published: 15, productionPaused: true }))).toEqual({ kind: 'retro', from: 1, to: 20 });
    });
    it('sinceRetro 5 → retro even with buffer room (range covers all 5 batches)', () => {
      expect(decideNext(long({ published: 20, accepted: 25, sinceRetro: 5, retroRange: { from: 1, to: 25 } }))).toEqual({ kind: 'retro', from: 1, to: 25 });
    });
    it('retroDue but pending → write (pending consumed first)', () => {
      expect(decideNext(long({ published: 5, pending: true }))).toEqual(w('write', 21, 5));
      expect(decideNext(long({ published: 5, sinceRetro: 5, ownerRequestWaiting: true }))).toEqual(w('write', 21, 5));
    });
    it('retroDue without a range (book moved) → no retro', () => {
      expect(decideNext(long({ published: 5, retroRange: null }))).toEqual({ kind: 'none', reason: 'buffer_full' });
    });
    it('retroDue ignored for medium (nextTasksV3 never sets it; decide also needs the flag)', () => {
      expect(decideNext(st({ accepted: 5, planned: 30, runawayBase: 30, sinceRetro: 9 }))).toEqual(w('write', 6, 5));
    });
    it('busy → no retro', () => {
      expect(decideNext(long({ published: 5, activeFlowTask: true }))).toEqual({ kind: 'none', reason: 'busy' });
    });
  });

  describe('runaway', () => {
    it('runawayWarn only in write mode, at ceil(0.75·factor·runawayBase), with planned raised above base', () => {
      // base 10, factor 2 → warn at 15; the author raised planned to 30
      const e = (accepted: number) => endingPhase({ length: 'long', accepted, planned: 30, runawayBase: 10, batch: 2, factor: 2, runawayBatches: 0 });
      expect(e(14).runawayWarn).toBe(false);
      expect(e(15)).toMatchObject({ mode: 'write', runawayWarn: true, forced: false });
      expect(endingPhase({ length: 'long', accepted: 15, planned: 30, runawayBase: 10, batch: 2, factor: 1.5, runawayBatches: 0 }).runawayWarn).toBe(true);
      expect(endingPhase({ length: 'long', accepted: 11, planned: 30, runawayBase: 10, batch: 2, factor: 1.5, runawayBatches: 0 }).runawayWarn).toBe(false);
      expect(endingPhase({ length: 'long', accepted: 12, planned: 30, runawayBase: 10, batch: 2, factor: 1.5, runawayBatches: 0 }).runawayWarn).toBe(true);
    });
    it('no runawayWarn in a finale order', () => {
      expect(endingPhase({ length: 'long', accepted: 28, planned: 30, runawayBase: 10, batch: 2, factor: 2, runawayBatches: 0 })).toMatchObject({ mode: 'finale', runawayWarn: false });
    });
    it('forced finale when runawayBatches ≥ 2 and accepted ≥ factor·max(base, ⌈planned/2⌉)', () => {
      expect(decideNext(st({ length: 'long', accepted: 20, planned: 20, runawayBase: 10, batch: 2, factor: 2, runawayBatches: 2, maxBuffer: 100 }))).toEqual(w('finale', 21, 1, 'normal', true));
      expect(decideNext(st({ length: 'long', accepted: 20, planned: 20, runawayBase: 10, batch: 2, factor: 2, runawayBatches: 1, maxBuffer: 100 }))).toEqual(w('finale', 21, 1));
      // 计划 40 是基准 10 的四倍（旧数据）：线在 2 × 20 = 40，写到 20 不算失控
      expect(decideNext(st({ length: 'long', accepted: 20, planned: 40, runawayBase: 10, batch: 2, factor: 2, runawayBatches: 2, maxBuffer: 100 }))).toEqual(w('write', 21, 2));
    });
    it('a forced finale never asks for more than 1.5 batches (factor below 2 from old settings)', () => {
      // factor 1.5：线 = 1.5 × max(10, 20) = 30；还剩 10 章，结局批只给 ⌊1.5 × 2⌋ = 3 章
      expect(decideNext(st({ length: 'long', accepted: 30, planned: 40, runawayBase: 10, batch: 2, factor: 1.5, runawayBatches: 2, maxBuffer: 100 }))).toEqual(w('finale', 31, 3, 'normal', true));
    });
    it('plannedUpper: 2·N0, with the backstop on at most warn line + three batches; never below plannedFloor', () => {
      expect(plannedUpper(50, null, 2, 5)).toBe(90);
      expect(plannedUpper(15, null, 2, 5)).toBe(30);
      expect(plannedUpper(50, null, 0, 5)).toBe(100);
      expect(plannedUpper(50, 120, 2, 5)).toBe(120);
      // 提醒线时计划里剩下的不超过三批
      const warnAt = Math.ceil(RUNAWAY_WARN_RATIO * 2 * 50);
      expect(plannedUpper(50, null, 2, 5) - warnAt).toBeLessThanOrEqual(CLOSING_BATCHES * 5);
    });
    it('runawayBatches ≥ 2 but owner raised the target (accepted < factor·base) → not forced', () => {
      expect(decideNext(st({ length: 'long', accepted: 20, planned: 40, runawayBase: 30, batch: 2, factor: 2, runawayBatches: 3, maxBuffer: 100 }))).toEqual(w('write', 21, 2));
    });
    it('factor 0 → no warn, no force', () => {
      const e = endingPhase({ length: 'long', accepted: 100, planned: 200, runawayBase: 10, batch: 2, factor: 0, runawayBatches: 9 });
      expect(e).toMatchObject({ mode: 'write', forced: false, runawayWarn: false });
    });
  });

  it('effortFor open/write/finale/closing/retro uses book.yaml v3.effort', () => {
    const cfg = zV3BookConfig.parse({ effort: { open: 'low', write: 'medium', finale: 'high', retro: 'low' } });
    expect(effortFor({ kind: 'open', mode: 'open-short', count: 4 }, cfg)).toBe('low');
    expect(effortFor({ kind: 'open', mode: 'open-long', count: 5 }, cfg)).toBe('low');
    expect(effortFor(w('write', 6, 5) as never, cfg)).toBe('medium');
    expect(effortFor(w('write', 6, 5, 'closing') as never, cfg)).toBe('high');
    expect(effortFor(w('finale', 11, 5) as never, cfg)).toBe('high');
    expect(effortFor({ kind: 'retro', from: 1, to: 20 }, cfg)).toBe('low');
    const defaults = zV3BookConfig.parse({});
    expect(defaults.effort).toEqual({ open: 'medium', write: 'medium', finale: 'high', retro: 'medium' });
    expect(effortFor({ kind: 'open', mode: 'open-short', count: 4 }, defaults)).toBe('medium');
    expect(effortFor(w('finale', 3, 2) as never, defaults)).toBe('high');
    expect(effortFor({ kind: 'retro', from: 1, to: 20 }, defaults)).toBe('medium');
  });

  it('closing effort (P3): the closing phase uses effort.closing when set, else finale (books written before P3); the finale batch always uses finale', () => {
    const withClosing = zV3BookConfig.parse({ effort: { open: 'low', write: 'low', closing: 'medium', finale: 'high', retro: 'low' } });
    expect(effortFor(w('write', 6, 5, 'closing') as never, withClosing)).toBe('medium');
    expect(effortFor(w('write', 6, 5) as never, withClosing)).toBe('low');
    expect(effortFor(w('finale', 11, 5) as never, withClosing)).toBe('high');
    const without = zV3BookConfig.parse({ effort: { write: 'low', finale: 'medium' } });
    expect(without.effort.closing).toBeUndefined();
    expect(effortFor(w('write', 6, 5, 'closing') as never, without)).toBe('medium');
  });
});
