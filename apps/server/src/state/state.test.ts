import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Card, Delta, Entity, Override, Snapshot } from '@novelist/shared';
import { chapterId, zCard, zDelta, zEntity, zOverride } from '@novelist/shared';
import { bookFiles, createFixtureBook, fixtureCard, fixtureDelta, openRepo, P } from '../book/index.js';
import {
  VIEW_FILES,
  applyDelta,
  buildViews,
  cardsTouchedBy,
  cascadeReplay,
  createFolder,
  evaluateCard,
  evaluatePredicate,
  fold,
  incrementalFoldUpTo,
  ledgerHash,
  loadBookState,
  matchOpPattern,
  projectBuffer,
  renderViews,
  resolveTmpIds,
  slugifyName,
} from './index.js';

const fixtureCardLike = (o: Record<string, unknown>): Card => zCard.parse(o);

let tmp: string;
let fxDir: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-state-'));
  fxDir = path.join(tmp, 'fx');
  await createFixtureBook(fxDir, { accepted: 3, cards: 6 });
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// 随机账本（属性测试）
// ---------------------------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ENTS: Entity[] = ['a', 'b', 'c', 'd'].map((x, i) =>
  zEntity.parse({
    id: `char.${x}`,
    kind: 'character',
    name: `角色${x}`,
    initial: { loc: 'loc.l0' },
    relations: i === 0 ? [{ to: 'char.b', type: '同门' }] : [],
  }),
);

function randomLedger(seed: number, n: number): Delta[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const ents = ['char.a', 'char.b', 'char.c', 'char.d', 'char.e'];
  const out: Delta[] = [];
  for (let i = 1; i <= n; i++) {
    const ops: unknown[] = [];
    const k = 1 + Math.floor(r() * 6);
    for (let j = 0; j < k; j++) {
      const t = Math.floor(r() * 9);
      const ev = `引文${i}-${j}`;
      if (t === 0) ops.push({ op: 'entity.update', ent: pick(ents), set: { loc: `loc.l${Math.floor(r() * 4)}`, 'cond+': [`c${Math.floor(r() * 3)}`] }, ev });
      if (t === 1) ops.push({ op: 'knowledge.learn', who: pick(ents), fact: `fact.f${Math.floor(r() * 6)}`, ev });
      if (t === 2) ops.push({ op: 'fact.assert', fact: `fact.f${Math.floor(r() * 6)}`, text: `事实${i}`, ev });
      if (t === 3) ops.push({ op: 'obligation.open', id: `F${String(i).padStart(4, '0')}`, kind: 'foreshadow', weight: 'minor', text: `伏笔${i}`, ev });
      if (t === 4 && i > 2) ops.push({ op: 'obligation.pay', id: `F${String(1 + Math.floor(r() * (i - 1))).padStart(4, '0')}`, ev });
      if (t === 5) ops.push({ op: 'event', id: `ev.${i}.${j}`, who: [pick(ents), pick(ents)], what: `事件${i}`, ev });
      if (t === 6) ops.push({ op: 'relation.set', a: pick(ents), b: pick(ents), type: pick(['敌', '友', '师徒']), ev });
      if (t === 7) ops.push({ op: 'power.change', who: pick(ents), system: 'cultivation', to: `第${i}层`, ev });
      if (t === 8) ops.push({ op: 'time.advance', to: { day: i }, flashback: r() < 0.2 });
    }
    out.push(zDelta.parse({ schema: 'nv.delta/1', chapter: chapterId(i), ops, entities_present: [pick(ents)] }));
  }
  return out;
}

function randomOverrides(seed: number, n: number): Override[] {
  const r = rng(seed);
  const out: Override[] = [];
  for (let i = 0; i < 6; i++) {
    const t = Math.floor(r() * 4);
    const eff = chapterId(1 + Math.floor(r() * (n + 2)));
    const base = { schema: 'nv.override/1', id: `o${i}`, ts: `2026-01-0${1 + (i % 9)}T00:00:00Z`, effective_from: eff, note: `更正${i}`, author: 'owner' };
    if (t === 0) out.push(zOverride.parse({ ...base, target: { kind: 'op', chapter: chapterId(1 + Math.floor(r() * n)), op_index: 0 }, action: 'drop' }));
    if (t === 1) out.push(zOverride.parse({ ...base, target: { kind: 'entity', ent: 'char.a', field: 'title' }, action: 'set', value: `称号${i}` }));
    if (t === 2) out.push(zOverride.parse({ ...base, target: { kind: 'fact', fact: `fact.f${i % 6}` }, action: 'set', value: `正确事实${i}` }));
    if (t === 3) out.push(zOverride.parse({ ...base, target: { kind: 'obligation', id: 'F0003' }, action: 'set', value: { status: 'abandoned' } }));
  }
  return out;
}

const stripHashes = (s: Snapshot) => ({ ...s, hash: '', ledger_hash: '' });

describe('fold (property)', () => {
  it('is deterministic and independent of override order', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const ledger = randomLedger(seed, 30);
      const ov = randomOverrides(seed * 7, 30);
      const a = fold({ entities: ENTS, world: null, ledger, overrides: ov });
      const b = fold({ entities: [...ENTS].reverse(), world: null, ledger: JSON.parse(JSON.stringify(ledger)), overrides: [...ov].reverse() });
      expect(b).toEqual(a);
      expect(a.ledger_hash).toBe(ledgerHash(ledger, ov));
      expect(a.through).toBe('c00030');
    }
  });

  it('equals stepwise applyDelta when there are no overrides', () => {
    for (let seed = 100; seed < 115; seed++) {
      const ledger = randomLedger(seed, 20);
      const full = fold({ entities: ENTS, world: null, ledger, overrides: [] });
      let s = fold({ entities: ENTS, world: null, ledger: [], overrides: [] });
      for (const d of ledger) s = applyDelta(s, d, { entities: ENTS });
      expect(stripHashes(s)).toEqual(stripHashes(full));
    }
  });

  it('incremental folder equals full fold at every step', () => {
    const ledger = randomLedger(7, 25);
    const ov = randomOverrides(9, 25);
    const folder = createFolder({ entities: ENTS, world: null, ledger, overrides: ov });
    for (const n of [0, 3, 10, 24]) {
      const inc = folder.advanceTo(n);
      const ref = createFolder({ entities: ENTS, world: null, ledger: ledger.slice(0, n), overrides: ov }).advanceTo(n);
      expect(stripHashes(inc)).toEqual(stripHashes(ref));
    }
  });

  it('projectBuffer resolves identity.reveal through entity definitions when given', () => {
    const ent = zEntity.parse({ id: 'char.x', kind: 'character', name: '黑衣人', identities: [{ id: 'ident.boss', alias: '阁主', known_by_fact: 'fact.x-is-boss' }] });
    const reader = zEntity.parse({ id: 'char.a', kind: 'character', name: '甲' });
    const s = fold({ entities: [ent, reader], world: null, ledger: [], overrides: [] });
    const base = { schema: 'nv.card/1', volume: 'v01', arc: 'a0001', beats: [{ id: 'b1', goal: 'g', cjk: 1000 }] };
    const c1 = fixtureCardLike({ ...base, id: 'c00001', title: '一', post: [{ op: 'identity.reveal', ent: 'char.x', identity: 'ident.boss', to: 'char.a' }] });
    const c2 = fixtureCardLike({ ...base, id: 'c00002', title: '二', pre: [{ knows: ['char.a', 'fact.x-is-boss'] }] });
    expect(projectBuffer(s, [c1, c2], { entities: [ent, reader] }).stale).toEqual([]);
    expect(projectBuffer(s, [c1, c2]).stale.map((x) => x.card)).toEqual(['c00002']);
  });

  it('applyDelta does not mutate its input', () => {
    const ledger = randomLedger(3, 5);
    const s = fold({ entities: ENTS, world: null, ledger: ledger.slice(0, 4), overrides: [] });
    const copy = JSON.parse(JSON.stringify(s));
    applyDelta(s, ledger[4] as Delta);
    expect(s).toEqual(copy);
  });
});

describe('fold semantics', () => {
  const d = (ch: number, ops: unknown[], extra: Record<string, unknown> = {}) => zDelta.parse({ schema: 'nv.delta/1', chapter: chapterId(ch), ops, ...extra });
  it('applies ops, retire, items, relations, identities, time', () => {
    const ents = [
      ...ENTS,
      zEntity.parse({ id: 'item.sword', kind: 'item', name: '青锋剑', initial: { owner: 'char.a' } }),
      zEntity.parse({ id: 'char.x', kind: 'character', name: '黑衣人', identities: [{ id: 'ident.boss', alias: '阁主', known_by_fact: 'fact.x-is-boss' }] }),
    ];
    const s = fold({
      entities: ents,
      world: null,
      overrides: [],
      ledger: [
        d(1, [
          { op: 'entity.update', ent: 'char.a', set: { 'cond+': ['injury.arm'], loc: 'loc.l1', 'power.cultivation': '筑基' }, ev: 'e' },
          { op: 'item.transfer', item: 'item.sword', from: 'char.a', to: 'char.b', ev: 'e' },
          { op: 'identity.reveal', ent: 'char.x', identity: 'ident.boss', to: 'char.a', ev: 'e' },
          { op: 'time.advance', to: { year: 3, day: 10 }, flashback: false },
        ]),
        d(2, [
          { op: 'entity.update', ent: 'char.a', set: { 'cond-': ['injury.arm'] }, ev: 'e' },
          { op: 'entity.retire', ent: 'char.c', how: 'death', ev: 'e' },
          { op: 'relation.set', a: 'char.b', b: 'char.a', type: '敌对', ev: 'e' },
          { op: 'time.advance', to: { year: 1 }, flashback: true },
          { op: 'arc.resolve', arc: 'a0001', ev: 'e' },
          { op: 'entity.create', ent: 'char.new', kind: 'character', name: '新人', ev: 'e' },
        ]),
      ],
      chapterCjk: { c00001: 100, c00002: 50 },
    });
    expect(s.entities['char.a']?.conds).toEqual([]);
    expect(s.entities['char.a']?.attrs.loc).toBe('loc.l1');
    expect(s.entities['char.a']?.power.cultivation).toBe('筑基');
    expect(s.items['item.sword']).toEqual({ holder: 'char.b' });
    expect(s.knowledge['char.a']).toEqual(['fact.x-is-boss']);
    expect(s.entities['char.c']?.alive).toBe(false);
    expect(s.relations).toEqual([{ a: 'char.b', b: 'char.a', type: '敌对', since: 'c00002' }]);
    expect(s.time).toEqual({ year: 3, day: 10 });
    expect(s.arcs_resolved).toEqual(['a0001']);
    expect(s.entities['char.new']?.first_seen).toBe('c00002');
    expect(s.total_cjk).toBe(150);
  });

  it('overrides: op drop/replace, sticky fact, deferred obligation/entity, effective_from', () => {
    const ledger = [
      d(1, [
        { op: 'fact.assert', fact: 'fact.k', text: '原文', ev: 'e' },
        { op: 'knowledge.learn', who: 'char.a', fact: 'fact.k', ev: 'e' },
      ]),
      d(2, [{ op: 'entity.update', ent: 'char.b', set: { loc: 'loc.wrong' }, ev: 'e' }]),
      d(3, [
        { op: 'obligation.open', id: 'F0001', kind: 'mystery', weight: 'major', text: 't', ev: 'e' },
        { op: 'fact.assert', fact: 'fact.k', text: '又写回原文', ev: 'e' },
      ]),
      d(4, [{ op: 'entity.create', ent: 'char.late', kind: 'character', name: '迟到者', ev: 'e' }]),
    ];
    const base = { schema: 'nv.override/1', ts: '2026-01-01T00:00:00Z', note: 'n', author: 'owner' } as const;
    const ov: Override[] = [
      zOverride.parse({
        ...base,
        id: 'o1',
        effective_from: 'c00002',
        target: { kind: 'op', chapter: 'c00002', op_index: 0 },
        action: 'replace',
        value: { op: 'entity.update', ent: 'char.b', set: { loc: 'loc.right' }, ev: 'e' },
      }),
      zOverride.parse({ ...base, id: 'o2', effective_from: 'c00002', target: { kind: 'fact', fact: 'fact.k' }, action: 'set', value: '正确' }),
      zOverride.parse({
        ...base,
        id: 'o3',
        effective_from: 'c00001',
        target: { kind: 'obligation', id: 'F0001' },
        action: 'set',
        value: { status: 'abandoned' },
      }),
      zOverride.parse({
        ...base,
        id: 'o4',
        effective_from: 'c00002',
        target: { kind: 'entity', ent: 'char.late', field: 'title' },
        action: 'set',
        value: '长老',
      }),
      zOverride.parse({ ...base, id: 'o5', effective_from: 'c00009', target: { kind: 'entity', ent: 'char.a', field: 'title' }, action: 'set', value: '宗主' }),
    ];
    const s = fold({ entities: ENTS, world: null, ledger, overrides: ov });
    expect(s.entities['char.b']?.attrs.loc).toBe('loc.right');
    expect(s.facts['fact.k']).toEqual({ text: '正确', since: 'c00001', overridden: true });
    expect(s.obligations.F0001?.status).toBe('abandoned');
    expect(s.entities['char.late']?.attrs.title).toBe('长老');
    expect(s.entities['char.a']?.attrs.title).toBe('宗主'); // 超出账本的 override 在末尾生效
    // advanceTo(n) 包含 effective_from = n+1 的 override
    const f = createFolder({ entities: ENTS, world: null, ledger, overrides: ov });
    expect(f.advanceTo(0).facts['fact.k']).toBeUndefined();
    expect(f.advanceTo(1).facts['fact.k']?.text).toBe('正确');
  });
});

describe('predicates & cards', () => {
  it('evaluates three-valued predicates', async () => {
    const st = await loadBookState(fxDir, { through: 2 });
    const s = st.snapshot;
    expect(evaluatePredicate({ has_cond: ['char.lin-feng', 'injury.arm.left.fracture'] }, s)).toBe(true);
    expect(evaluatePredicate({ knows_not: ['char.lin-feng', 'fact.su-wan-spy'] }, s)).toBe(true);
    expect(evaluatePredicate({ at_loc: ['char.lin-feng', 'loc.qingyun'] }, s)).toBe(true);
    expect(evaluatePredicate({ eq: [{ attr: ['char.lin-feng', 'power.cultivation'] }, '练气九层'] }, s)).toBe(true);
    expect(evaluatePredicate({ stage: ['char.lin-feng', 's1'] }, s)).toBe(true);
    expect(evaluatePredicate({ obligation: 'F0001', status: 'open' }, s)).toBe(true);
    expect(evaluatePredicate({ alive: 'char.ghost' }, s)).toBe('unresolved');
    expect(evaluatePredicate({ alive: 'tmp:x' }, s)).toBe('unresolved');
    expect(evaluatePredicate({ manual: '读者满意' }, s)).toBe('manual');
    expect(evaluatePredicate({ and: [{ alive: 'char.su-wan' }, { manual: 'x' }] }, s)).toBe('manual');
    expect(evaluatePredicate({ and: [{ alive: 'char.ghost' }, { dead: 'char.su-wan' }] }, s)).toBe(false);
    expect(evaluatePredicate({ or: [{ dead: 'char.su-wan' }, { alive: 'char.su-wan' }] }, s)).toBe(true);
    expect(evaluatePredicate({ not: { manual: 'x' } }, s)).toBe('manual');
    expect(evaluatePredicate({ in: [{ attr: ['char.su-wan', 'loc'] }, ['loc.x', 'loc.qingyun']] }, s)).toBe(true);
  });

  it('matches op patterns and evaluates the fixture card 3', async () => {
    const st = await loadBookState(fxDir, { through: 2 });
    const card = fixtureCard(3);
    const delta = fixtureDelta(3);
    expect(matchOpPattern({ op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.su-wan-spy' }, delta)).toBe(true);
    expect(matchOpPattern({ op: 'event', who: 'char.su-wan' }, delta)).toBe(true);
    expect(matchOpPattern({ op: 'knowledge.learn', who: 'char.su-wan' }, delta)).toBe(false);
    const pre = evaluateCard(card, st.snapshot);
    expect(pre.ok).toBe(true);
    expect(pre.post).toEqual([]);
    const full = evaluateCard(card, st.snapshot, delta);
    expect(full.ok).toBe(true);
    expect(full.post[0]?.value).toBe('met');
    const bad = evaluateCard(card, st.snapshot, { ...delta, ops: [...delta.ops, { op: 'reader.reveal', fact: 'fact.lin-feng-is-black-robe', ev: 'x' }] });
    expect(bad.ok).toBe(false);
    expect(bad.mustNot[0]?.violated).toBe(true);
    const st1 = await loadBookState(fxDir, { through: 1 });
    expect(evaluateCard(card, st1.snapshot).ok).toBe(false);
  });
});

describe('projection', () => {
  it('projects the buffer and flags stale cards', async () => {
    const files = bookFiles(openRepo(fxDir));
    const cards = await files.cards(1, 6);
    const s0 = (await loadBookState(fxDir, { through: 0 })).snapshot;
    // 从零开始：卡 1–6 依次投影都成立（卡 2 的 post 使卡 3 的 pre 成立）
    const r = projectBuffer(s0, cards);
    expect(r.stale).toEqual([]);
    expect(r.before.map((b) => b.card)).toEqual(['c00001', 'c00002', 'c00003', 'c00004', 'c00005', 'c00006']);
    expect(evaluatePredicate({ knows: ['char.lin-feng', 'fact.su-wan-spy'] }, r.before[3]?.snapshot as Snapshot)).toBe(true);
    // 实际第 3 章写完后再投影 4–6：卡 6 回收 F0001 仍可行
    const s3 = (await loadBookState(fxDir, { through: 3 })).snapshot;
    expect(projectBuffer(s3, cards.slice(3)).stale).toEqual([]);
    // 伏笔被提前回收 → 卡 4（推进）与卡 6（回收）都 stale
    const paid = applyDelta(s3, zDelta.parse({ schema: 'nv.delta/1', chapter: 'c00004', ops: [{ op: 'obligation.pay', id: 'F0001', ev: 'x' }] }));
    const stale = projectBuffer(paid, cards.slice(4));
    expect(stale.stale.map((x) => x.card)).toEqual(['c00006']);
    // 卡 3 的 pre：没受伤时不成立
    const s1 = (await loadBookState(fxDir, { through: 1 })).snapshot;
    expect(projectBuffer(s1, [cards[2] as Card]).stale[0]?.reasons[0]).toMatch(/pre 不成立/);
  });

  it('cardsTouchedBy intersects state keys of unplanned ops with future card dependencies', async () => {
    const cards = await bookFiles(openRepo(fxDir)).cards(4, 6);
    const d = zDelta.parse({
      schema: 'nv.delta/1',
      chapter: 'c00004',
      ops: [
        { op: 'obligation.pay', id: 'F0001', ev: 'x' },
        { op: 'entity.update', ent: 'char.lin-feng', set: { loc: 'loc.x' }, ev: 'x' },
      ],
    });
    expect(cardsTouchedBy(d, cards)).toEqual(['c00004', 'c00006']);
    const d2 = zDelta.parse({
      schema: 'nv.delta/1',
      chapter: 'c00004',
      ops: [{ op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.su-wan-spy', ev: 'x' }],
    });
    expect(cardsTouchedBy(d2, cards)).toEqual(['c00004']);
    const d3 = zDelta.parse({ schema: 'nv.delta/1', chapter: 'c00004', ops: [{ op: 'entity.retire', ent: 'char.su-wan', how: 'death', ev: 'x' }] });
    expect(cardsTouchedBy(d3, cards)).toEqual(['c00005']);
  });
});

describe('tmp ids', () => {
  it('slugifies names deterministically with collision suffixes', () => {
    expect(slugifyName('Old Boatman', new Set())).toBe('old-boatman');
    expect(slugifyName('Old Boatman', new Set(['old-boatman']))).toBe('old-boatman-2');
    expect(slugifyName('Old Boatman', new Set(['old-boatman', 'old-boatman-2']))).toBe('old-boatman-3');
    const s = slugifyName('林枫', new Set());
    expect(s).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(slugifyName('林枫', new Set([s]))).toBe(`${s}-2`);
  });

  it('resolves tmp ids across delta, card and entity files', () => {
    const delta = {
      schema: 'nv.delta/1',
      chapter: 'c00421',
      ops: [
        { op: 'entity.create', ent: 'tmp:old-boatman', kind: 'character', name: '老艄公', ev: 'x' },
        { op: 'obligation.open', id: 'tmp:f1', kind: 'foreshadow', weight: 'major', text: '铜牌', ev: 'x' },
        { op: 'event', id: 'tmp:e1', who: ['tmp:old-boatman', 'char.lin-feng'], what: 'w', ev: 'x' },
        { op: 'fact.assert', fact: 'tmp:boatman-knows', text: '艄公认得铜牌', ev: 'x' },
        { op: 'knowledge.learn', who: 'tmp:old-boatman', fact: 'tmp:boatman-knows', ev: 'x' },
      ],
    };
    const card = 'schema: nv.card/1\nid: c00430\npays: [tmp:f1]\npre:\n  - { alive: tmp:old-boatman }\nnotes: 记得 tmp:old-boatman.\n';
    const ent = '---\nid: tmp:ferry\nkind: location\nname: Black Ferry\n---\n\n渡口。\n';
    const ctx = {
      existing: new Set(['char.lin-feng', 'char.old-boatman', 'F0001', 'F0002']),
      names: new Map([['老艄公', 'char.someone']]),
      nextObligationNo: 1,
    };
    const r = resolveTmpIds(
      [
        { path: 'state/ledger/c00421.json', content: JSON.stringify(delta) },
        { path: 'plan/cards/c00430.yaml', content: card },
        { path: 'bible/entities/locations/tmp-ferry.md', content: ent },
        { path: 'image.png', content: Buffer.from([1, 2, 3]) },
      ],
      ctx,
    );
    expect(r.mapping['tmp:f1']).toBe('F0003');
    expect(r.mapping['tmp:e1']).toBe('ev.c00421.e1');
    expect(r.mapping['tmp:old-boatman']).toMatch(/^char\./);
    expect(r.mapping['tmp:old-boatman']).not.toBe('char.old-boatman');
    expect(r.mapping['tmp:boatman-knows']).toBe('fact.boatman-knows');
    expect(r.mapping['tmp:ferry']).toBe('loc.black-ferry');
    expect(r.warnings?.[0]).toMatch(/同名/);
    const out = new Map(r.files.map((f) => [f.path, f.content]));
    const ledger = JSON.parse(out.get('state/ledger/c00421.json') as string);
    expect(JSON.stringify(ledger)).not.toContain('tmp:');
    expect(out.get('plan/cards/c00430.yaml')).toContain('pays: [F0003]');
    expect(out.get('plan/cards/c00430.yaml')).toContain(`记得 ${r.mapping['tmp:old-boatman']}.`);
    expect(out.get('bible/entities/locations/black-ferry.md')).toContain('id: loc.black-ferry');
    expect(out.has('bible/entities/locations/tmp-ferry.md')).toBe(true);
    expect(out.get('bible/entities/locations/tmp-ferry.md')).toBeNull();
    expect(ctx.nextObligationNo).toBe(4);
    expect(ctx.existing.has('F0003')).toBe(true);
  });
});

describe('cascade', () => {
  const checker = (d: Delta, before: Snapshot) => {
    const reasons: string[] = [];
    for (const op of d.ops) if (op.op === 'entity.update' && before.entities[op.ent]?.alive === false) reasons.push(`${op.ent} 已死`);
    return { ok: reasons.length === 0, reasons };
  };
  const mk = (ch: number, ops: unknown[]) => zDelta.parse({ schema: 'nv.delta/1', chapter: chapterId(ch), ops });
  const ledger = [
    mk(1, [{ op: 'event', id: 'e', who: ['char.a'], what: 'w', ev: '原句' }]),
    mk(2, [{ op: 'entity.update', ent: 'char.b', set: { loc: 'loc.x' }, ev: 'b 去了 x' }]),
    mk(3, [{ op: 'entity.update', ent: 'char.b', set: { loc: 'loc.y' }, ev: 'b 去了 y' }]),
  ];
  const foldUpTo = incrementalFoldUpTo({ entities: ENTS, world: null, overrides: [] });
  it('text-only change is a noop', () => {
    const r = cascadeReplay({
      replaceAt: 1,
      newDelta: mk(1, [{ op: 'event', id: 'e', who: ['char.a'], what: 'w', ev: '改过的句子' }]),
      ledger,
      check: checker,
      foldUpTo,
    });
    expect(r).toEqual({ conflicts: [], noop: true, affected: null });
  });
  it('replays downstream deltas and reports conflicts', () => {
    const r = cascadeReplay({
      replaceAt: 1,
      newDelta: mk(1, [{ op: 'entity.retire', ent: 'char.b', how: 'death', ev: 'b 死了' }]),
      ledger,
      check: checker,
      foldUpTo,
    });
    expect(r.noop).toBe(false);
    expect(r.affected).toEqual([2, 3]);
    expect(r.conflicts.map((c) => c.no)).toEqual([2, 3]);
  });
});

describe('views', () => {
  it('builds deterministic views (golden)', async () => {
    const { snapshot, written } = await buildViews(fxDir);
    expect(snapshot.through).toBe('c00003');
    expect(written).toEqual(VIEW_FILES.map((f) => `views/${f}`));
    for (const f of VIEW_FILES) {
      const text = await fs.readFile(path.join(fxDir, 'views', f), 'utf8');
      await expect(text).toMatchFileSnapshot(`./__golden__/fixture/${f}.golden`);
    }
    const st = await loadBookState(fxDir, { noCache: true });
    const again = await renderViews(st);
    for (const f of VIEW_FILES) expect(again[f]).toBe(await fs.readFile(path.join(fxDir, 'views', f), 'utf8'));
    expect(again['cast.md']).toContain('代表台词');
    expect(again['cast.md']).toContain('左臂骨折');
    expect(JSON.parse(again['aliases.json']).texts.小林).toEqual(['char.lin-feng']);
  });

  it('snapshot.json equals fold(ledger, overrides) and the commit trailer hash', async () => {
    const files = bookFiles(openRepo(fxDir));
    const ledger = await files.ledger();
    const s = fold({ entities: (await files.entities()).map((e) => e.entity), world: await files.world(), ledger, overrides: await files.overrides() });
    const view = JSON.parse(await fs.readFile(path.join(fxDir, P.view('snapshot.json')), 'utf8'));
    expect(view.hash).toBe(s.hash.length ? (await loadBookState(fxDir)).snapshot.hash : '');
    const head = (await openRepo(fxDir).log({ limit: 1 })).items[0];
    expect(head?.trailers['Novelist-Snapshot-Hash']).toBe(ledgerHash(ledger, []));
  });
});
