import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Arc, ArcFingerprint, Card, Compass, Snapshot, Volume } from '@novelist/shared';
import { zArc, zCard, zCompass, zVolume } from '@novelist/shared';
import { describe, expect, it } from 'vitest';
import { createFixtureBook } from '../book/index.js';
import { emptyFoldSnapshot } from '../state/index.js';
import { REBASE_VALIDATORS, type PlanValidationInput, arcFingerprintFeatures, validatePlan } from './plan.js';

const card = (no: number, o: Record<string, unknown> = {}): Card =>
  zCard.parse({
    schema: 'nv.card/1',
    id: `c${String(no).padStart(5, '0')}`,
    title: `第${no}章`,
    volume: 'v01',
    arc: 'a0001',
    beats: [{ id: 'b1', cjk: 3000, goal: 'g' }],
    ...o,
  });
const arc = (id: string, a: string, b: string, o: Record<string, unknown> = {}): Arc => zArc.parse({ schema: 'nv.arc/1', id, volume: 'v01', title: 't', question: 'q', resolve_by: b, chapters: [a, b], ...o });
const vol: Volume = zVolume.parse({ schema: 'nv.volume/1', id: 'v01', title: '第一卷', milestones_due: ['m1'] });
const compass = (milestones: { id: string; at: number }[]): Compass =>
  zCompass.parse({
    schema: 'nv.compass/1',
    logline: 'l',
    genre: 'xianxia',
    protagonist_arc: { lie: 'a', want: 'b', need: 'c', truth: 'd', stages: ['s1'] },
    scale: { target_cjk: 1_000_000, hard_max_cjk: 1_200_000, volumes: [1, 2], chapters_per_volume: [10, 20] },
    ending: { direction: 'd' },
    main_threads: [{ id: 't', desc: 'd', milestones }],
  });
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({ ...emptyFoldSnapshot(), ...o });

function run(o: Partial<PlanValidationInput>) {
  return validatePlan({ compass: null, volumes: [vol], arcs: [arc('a0001', 'c00001', 'c00003')], cards: [card(1), card(2), card(3)], snapshot: snap(), fingerprints: [], changed: [], ...o });
}
const cats = (fs: { category: string }[]) => fs.map((x) => x.category);

describe('validatePlan', () => {
  it('accepts a coherent plan', () => {
    expect(run({})).toMatchObject({ ok: true, hard: [] });
  });

  it('requires titles, consecutive numbering and unique beats', () => {
    expect(cats(run({ cards: [card(1), card(3)] }).hard)).toEqual(['card.numbering']);
    expect(cats(run({ cards: [{ ...card(1), title: '  ' }] }).hard)).toContain('card.title');
    expect(cats(run({ cards: [card(1, { beats: [{ id: 'b1', cjk: 10, goal: 'g' }, { id: 'b1', cjk: 10, goal: 'g' }] })] }).hard)).toContain('card.beats');
  });

  it('checks condition syntax and op names', () => {
    expect(cats(run({ cards: [card(1, { post: [{ op: 'no.such.op' }] })] }).hard)).toContain('predicate.op');
    expect(cats(run({ cards: [{ ...card(1), pre: [{ bogus: 1 }] as unknown as Card['pre'] }] }).hard)).toContain('predicate.syntax');
  });

  it('checks structure: arc ranges, references, overlap and gaps', () => {
    expect(cats(run({ arcs: [arc('a0001', 'c00001', 'c00003'), arc('a0002', 'c00005', 'c00008')] }).hard)).toContain('arc.gap');
    expect(cats(run({ arcs: [arc('a0001', 'c00001', 'c00003'), arc('a0002', 'c00003', 'c00008')] }).hard)).toContain('arc.overlap');
    expect(cats(run({ cards: [card(1, { arc: 'a0009' })] }).hard)).toContain('card.arc');
    expect(cats(run({ cards: [card(9)], arcs: [arc('a0001', 'c00001', 'c00003')] }).hard)).toContain('card.arc_range');
    expect(cats(run({ arcs: [arc('a0001', 'c00001', 'c00003', { resolve_by: 'c00009' })] }).hard)).toContain('arc.resolve_by');
  });

  it('checks foreshadow windows', () => {
    const o = { id: 'F0001', kind: 'mystery', weight: 'major' as const, text: 't', status: 'open' as const, opened: 'c00001', due: ['c00005', 'c00009'] as [string, string], advances: [] };
    expect(cats(run({ cards: [card(1, { pays: ['F0009'] })] }).hard)).toEqual(['obligation.pay_unknown']);
    const r = run({ cards: [card(1, { pays: ['F0001'] })], snapshot: snap({ obligations: { F0001: o } }) });
    expect(r.ok).toBe(true);
    expect(cats(r.soft)).toContain('obligation.window');
    expect(cats(run({ cards: [card(1, { pays: ['F0001'] })], snapshot: snap({ obligations: { F0001: { ...o, status: 'paid' } } }) }).hard)).toEqual(['obligation.pay_closed']);
    expect(run({ cards: [card(1, { may_open: ['tmp:x'] }), card(2, { pays: ['tmp:x'] })] }).ok).toBe(true);
  });

  it('rejects arcs too similar to history, only for changed arcs', () => {
    const cards = [card(1, { strands: ['s'] })];
    const features = arcFingerprintFeatures(arc('a0002', 'c00001', 'c00003', { strands: ['x', 'y', 'z'], character_stages: [{ who: 'char.a', to: 's2' }] }), []);
    const history: ArcFingerprint[] = [
      { schema: 'nv.arcfp/1', arc: 'a0001', ts: 't', features, vector: [] },
      { schema: 'nv.arcfp/1', arc: 'a0002', ts: 't', features, vector: [] },
    ];
    const arcs = [arc('a0002', 'c00001', 'c00003', { strands: ['x', 'y', 'z'] })];
    expect(cats(run({ arcs, cards, fingerprints: history, changed: ['plan/arcs/a0002.yaml'] }).hard)).toContain('arc.fingerprint');
    expect(cats(run({ arcs, cards, fingerprints: history, changed: [] }).hard)).not.toContain('arc.fingerprint');
  });

  it('prefers vectors when both have them', () => {
    const fp = (arcId: string, vector: number[]): ArcFingerprint => ({ schema: 'nv.arcfp/1', arc: arcId, ts: 't', features: {}, vector });
    const r = run({ fingerprints: [fp('a0001', [1, 0, 1]), fp('a0002', [1, 0, 1])], changed: ['a0001'] });
    expect(cats(r.hard)).toContain('arc.fingerprint');
  });

  it('flags milestone lag softly', () => {
    const c = compass([
      { id: 'm1', at: 0.1 },
      { id: 'm2', at: 0.2 },
    ]);
    expect(cats(run({ compass: c, snapshot: snap({ total_cjk: 300_000 }) }).soft)).toContain('milestone.lag');
    const done = run({ compass: c, snapshot: snap({ total_cjk: 300_000, arcs_resolved: ['a0001'], events: [{ id: 'm2', ch: 'c00001', what: 'x', who: [] }] }) });
    expect(cats(done.soft)).not.toContain('milestone.lag');
  });

  it('flags overdue arc resolution', () => {
    expect(cats(run({ compass: compass([{ id: 'm', at: 0.9 }]), snapshot: snap({ through: 'c00005' }) }).soft)).toContain('arc.overdue');
  });
});

describe('REBASE_VALIDATORS', () => {
  it('runs against a real book directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-rebase-'));
    try {
      await createFixtureBook(dir, { accepted: 1, cards: 4 });
      for (const name of ['plan.numbering', 'card.obligation_window', 'card.projected_pre']) {
        const r = await REBASE_VALIDATORS[name]?.(dir, 'c00004');
        expect(r, name).toMatchObject({ ok: true });
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
