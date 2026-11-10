import { describe, expect, it } from 'vitest';
import { zV3BookConfig } from '@novelist/shared';
import { decideNext, effortFor, type FlowState } from './decide.js';

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
  ...p,
});

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
  it('paused/draft/archived → none(inactive)', () => {
    for (const status of ['paused', 'draft', 'archived']) expect(decideNext(st({ status }))).toEqual({ kind: 'none', reason: 'inactive' });
  });
  it('completed → none(completed)', () => {
    expect(decideNext(st({ status: 'completed' }))).toEqual({ kind: 'none', reason: 'completed' });
  });
  it('buffer full (accepted-published ≥ max_buffer) → none', () => {
    expect(decideNext(st({ accepted: 20, published: 5, maxBuffer: 15, planned: 40 }))).toEqual({ kind: 'none', reason: 'buffer_full' });
    expect(decideNext(st({ accepted: 19, published: 5, maxBuffer: 15, planned: 40 }))).toMatchObject({ kind: 'write', from: 20 });
  });
  it('productionPaused → none', () => {
    expect(decideNext(st({ productionPaused: true }))).toEqual({ kind: 'none', reason: 'buffer_full' });
  });
  it('buffer full but pending → step still proposed', () => {
    expect(decideNext(st({ accepted: 20, published: 5, planned: 40, pending: true }))).toEqual({ kind: 'write', mode: 'write', from: 21, count: 5 });
    expect(decideNext(st({ productionPaused: true, pending: true }))).toMatchObject({ kind: 'write' });
  });
  it('remaining > batch → write from accepted+1', () => {
    expect(decideNext(st({ accepted: 5, planned: 15 }))).toEqual({ kind: 'write', mode: 'write', from: 6, count: 5 });
  });
  it('remaining ≤ batch → finale', () => {
    expect(decideNext(st({ accepted: 10, planned: 15 }))).toEqual({ kind: 'write', mode: 'finale', from: 11, count: 5 });
    expect(decideNext(st({ accepted: 12, planned: 15 }))).toEqual({ kind: 'write', mode: 'finale', from: 13, count: 3 });
  });
  it('short book after open, not completed → finale', () => {
    expect(decideNext(st({ length: 'short', accepted: 2, planned: 4 }))).toEqual({ kind: 'write', mode: 'finale', from: 3, count: 2 });
  });
  it('accepted ≥ planned, not completed → finale count 1', () => {
    expect(decideNext(st({ accepted: 15, published: 10, planned: 15 }))).toEqual({ kind: 'write', mode: 'finale', from: 16, count: 1 });
    expect(decideNext(st({ accepted: 18, published: 10, planned: 15 }))).toEqual({ kind: 'write', mode: 'finale', from: 19, count: 1 });
    expect(decideNext(st({ length: 'short', accepted: 5, planned: 4 }))).toEqual({ kind: 'write', mode: 'finale', from: 6, count: 1 });
  });
  it('accepted > 0 never yields open', () => {
    for (const length of ['short', 'medium', 'long', 'epic'] as const) {
      for (const accepted of [1, 3, 10, 60]) expect(decideNext(st({ length, accepted, planned: 50, maxBuffer: 100 })).kind).not.toBe('open');
    }
  });
  it('effortFor open/write/finale uses book.yaml v3.effort', () => {
    const cfg = zV3BookConfig.parse({ effort: { open: 'low', write: 'medium', finale: 'high' } });
    expect(effortFor({ kind: 'open', mode: 'open-short', count: 4 }, cfg)).toBe('low');
    expect(effortFor({ kind: 'open', mode: 'open-long', count: 5 }, cfg)).toBe('low');
    expect(effortFor({ kind: 'write', mode: 'write', from: 6, count: 5 }, cfg)).toBe('medium');
    expect(effortFor({ kind: 'write', mode: 'finale', from: 11, count: 5 }, cfg)).toBe('high');
    const defaults = zV3BookConfig.parse({});
    expect(effortFor({ kind: 'open', mode: 'open-short', count: 4 }, defaults)).toBe('medium');
    expect(effortFor({ kind: 'write', mode: 'finale', from: 3, count: 2 }, defaults)).toBe('high');
  });
});
