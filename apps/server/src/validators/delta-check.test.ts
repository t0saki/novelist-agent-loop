import type { Card, Delta, DeltaOp, Entity, Override, Secret, Snapshot, WorldRules } from '@novelist/shared';
import { zCard, zDelta, zEntity, zSecret } from '@novelist/shared';
import { describe, expect, it } from 'vitest';
import { buildAliasIndex } from '../context/alias.js';
import { fold } from '../state/index.js';
import { type DeltaCheckInput, checkSummaryAnchors, deltaCheck, verifyFormatRepair } from './delta-check.js';

const entities: Entity[] = [
  zEntity.parse({ id: 'char.lin-feng', kind: 'character', name: '林枫', initial: { loc: 'loc.qingyun', 'power.cultivation': '筑基', status: 'free' } }),
  zEntity.parse({ id: 'char.su-wan', kind: 'character', name: '苏婉' }),
  zEntity.parse({ id: 'char.ghost', kind: 'character', name: '老鬼' }),
  zEntity.parse({ id: 'char.bystander', kind: 'character', name: '路人甲' }),
  zEntity.parse({ id: 'loc.qingyun', kind: 'location', name: '青云宗' }),
  zEntity.parse({ id: 'loc.ferry', kind: 'location', name: '渡口' }),
  zEntity.parse({ id: 'item.token', kind: 'item', name: '铜牌' }),
];
const world: WorldRules = {
  schema: 'nv.world/1',
  systems: [{ id: 'cultivation', name: '修为', ranks: ['练气', '筑基', '金丹'], rules: [] }],
  vocab: { conditions: [{ id: 'injury.arm', label: '臂伤' }], proposals: [] },
  rules: [],
};
const chapter1 = zDelta.parse({
  schema: 'nv.delta/1',
  chapter: 'c00001',
  ops: [
    { op: 'entity.retire', ent: 'char.ghost', how: 'death', ev: 'x' },
    { op: 'item.transfer', item: 'item.token', to: 'char.lin-feng', ev: 'x' },
    { op: 'fact.assert', fact: 'fact.spy', text: '苏婉是卧底', ev: 'x' },
    { op: 'obligation.open', id: 'F0001', kind: 'mystery', weight: 'major', due: ['c00003', 'c00009'], text: '铜牌来历', ev: 'x' },
    { op: 'obligation.open', id: 'F0002', kind: 'promise', weight: 'main', text: '主线', ev: 'x' },
    { op: 'obligation.open', id: 'F0003', kind: 'setup', weight: 'minor', text: '已收束', ev: 'x' },
    { op: 'obligation.pay', id: 'F0003', ev: 'x' },
    { op: 'time.advance', to: { year: 3, day: 100 }, flashback: false },
  ],
});
const before: Snapshot = fold({ entities, world, ledger: [chapter1], overrides: [] });
const aliases = buildAliasIndex(entities);

const card = (o: Partial<Record<string, unknown>> = {}): Card =>
  zCard.parse({
    schema: 'nv.card/1',
    id: 'c00002',
    title: '测试',
    volume: 'v01',
    arc: 'a0001',
    entities_present: ['char.lin-feng', 'char.su-wan'],
    beats: [{ id: 'b1', cjk: 100, goal: 'g' }],
    ...o,
  });
const draft = `<!-- beat:b1 -->\n林枫把铜牌收进袖中，抬头看了看灰白的天色。\n\n苏婉低声说话，林枫听见了她的秘密。\n\n“师兄，你要走吗？”苏婉笑道。\n\n老鬼拍了拍林枫的肩膀，转身走了。\n`;

function makeDelta(ops: unknown[], extra: Record<string, unknown> = {}): Delta {
  return zDelta.parse({ schema: 'nv.delta/1', chapter: 'c00002', ops, entities_present: ['char.lin-feng', 'char.su-wan'], ...extra });
}
function check(delta: Delta, o: Partial<DeltaCheckInput> = {}) {
  return deltaCheck({ delta, draft, card: card(), before, world, secrets: [], overrides: [], eventFamilies: {}, aliases, unplannedInvention: 'soft', ...o });
}
const cats = (fs: { category: string }[]) => fs.map((x) => x.category);

describe('evidence pass', () => {
  it('keeps exact ev, replaces fuzzy ev, drops minor ops, re-extracts key ops', () => {
    const r = check(
      makeDelta([
        { op: 'event', id: 'e1', who: ['char.lin-feng'], what: '收铜牌', ev: '林枫把铜牌收进袖中' },
        { op: 'event', id: 'e2', who: ['char.su-wan'], what: '说话', ev: '苏婉低声说话，林枫听见了她的秘密吧' },
        { op: 'event', id: 'e3', who: ['char.su-wan'], what: '幻觉', ev: '根本没有这句话的内容' },
        { op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.spy', ev: '也没有这一句内容的话' },
      ]),
    );
    expect(r.dropped.map((d) => d.index)).toEqual([2]);
    expect(r.reextract.map((d) => d.index)).toEqual([3]);
    expect(r.evRepaired).toHaveLength(1);
    expect(draft).toContain((r.delta.ops[1] as { ev: string }).ev);
    expect(r.delta.ops).toHaveLength(3);
    expect(r.ok).toBe(false);
  });

  it('remaps summary op anchors after dropping and validates ev anchors', () => {
    const r = check(
      makeDelta(
        [
          { op: 'event', id: 'e1', who: [], what: '丢', ev: '根本没有这句话的内容' },
          { op: 'event', id: 'e2', who: ['char.lin-feng'], what: '留', ev: '林枫把铜牌收进袖中' },
        ],
        { summary: [{ s: 'a', anchors: ['op:0'] }, { s: 'b', anchors: ['op:1', 'ev:抬头看了看灰白的天色', 'ev:没有的引文内容在此'] }] },
      ),
    );
    expect(r.delta.summary[0]?.anchors).toEqual([]);
    expect(r.delta.summary[1]?.anchors).toEqual(['op:0', 'ev:抬头看了看灰白的天色']);
  });

  it('drops contract.amend from extractor output', () => {
    const r = check(makeDelta([{ op: 'contract.amend', who: 'char.lin-feng', stage: 's2', contract: {}, reason: 'x' }]));
    expect(r.delta.ops).toHaveLength(0);
    expect(cats(r.soft)).toContain('op.contract_amend');
  });

  it('does not mutate the input delta', () => {
    const delta = makeDelta([{ op: 'event', id: 'e', who: [], what: '丢', ev: '根本没有这句话的内容' }]);
    check(delta);
    expect(delta.ops).toHaveLength(1);
  });
});

describe('ledger rules', () => {
  const ev = '林枫把铜牌收进袖中';

  it('passes a clean delta', () => {
    const r = check(makeDelta([{ op: 'event', id: 'e1', who: ['char.lin-feng'], what: '收', ev }]));
    expect(r).toMatchObject({ ok: true, hard: [], reextract: [] });
  });

  it('flags entity.update.from mismatches as writer contradictions unless overridden', () => {
    const d = makeDelta([{ op: 'entity.update', ent: 'char.lin-feng', from: { loc: 'loc.ferry' }, set: { loc: 'loc.ferry' }, ev }]);
    const r = check(d);
    expect(cats(r.hard)).toEqual(['entity.from']);
    expect(Object.values(r.attribution)).toEqual(['writer']);
    const o: Override = { schema: 'nv.override/1', id: 'o1', ts: 't', effective_from: 'c00001', target: { kind: 'entity', ent: 'char.lin-feng', field: 'loc' }, action: 'set', value: 'loc.ferry', note: 'n', author: 'owner' };
    expect(cats(check(d, { overrides: [o] }).hard)).toEqual([]);
  });

  it('sequential ops see earlier changes in the same chapter', () => {
    const r = check(
      makeDelta([
        { op: 'entity.update', ent: 'char.lin-feng', from: { loc: 'loc.qingyun' }, set: { loc: 'loc.ferry' }, ev },
        { op: 'entity.update', ent: 'char.lin-feng', from: { loc: 'loc.ferry' }, set: { loc: 'loc.qingyun' }, ev },
      ]),
    );
    expect(r.hard).toEqual([]);
  });

  it('compares condition sets and checks the controlled vocabulary', () => {
    const r1 = check(makeDelta([{ op: 'entity.update', ent: 'char.lin-feng', from: { conds: ['injury.arm'] }, set: { 'cond+': ['injury.arm'] }, ev }]));
    expect(cats(r1.hard)).toEqual(['entity.from']);
    const r2 = check(makeDelta([{ op: 'entity.update', ent: 'char.lin-feng', set: { 'cond+': ['左臂骨折'] }, ev }]));
    expect(cats(r2.soft)).toContain('vocab.unknown');
    expect(r2.reextract[0]?.reason).toContain('左臂骨折');
    expect(check(makeDelta([{ op: 'entity.update', ent: 'char.lin-feng', set: { 'cond+': ['injury.arm'] }, ev }])).ok).toBe(true);
  });

  it('dead characters cannot act, appear or resurrect; flashback softens', () => {
    const acts = check(makeDelta([{ op: 'event', id: 'e', who: ['char.ghost'], what: '拍肩', ev: '老鬼拍了拍林枫的肩膀' }]));
    expect(cats(acts.hard)).toContain('dead.acts');
    const present = check(makeDelta([], { entities_present: ['char.ghost'] }));
    expect(cats(present.hard)).toContain('dead.present');
    const res = check(makeDelta([{ op: 'entity.update', ent: 'char.ghost', set: { alive: true }, ev: '老鬼拍了拍林枫的肩膀' }]));
    expect(cats(res.hard)).toContain('dead.resurrected');
    const fb = check(
      makeDelta([
        { op: 'time.advance', to: { year: 1 }, flashback: true },
        { op: 'event', id: 'e', who: ['char.ghost'], what: '拍肩', ev: '老鬼拍了拍林枫的肩膀' },
      ]),
    );
    expect(cats(fb.hard)).toEqual([]);
    expect(cats(fb.soft)).toContain('dead.acts');
  });

  it('item uniqueness: from must match holder', () => {
    const r = check(makeDelta([{ op: 'item.transfer', item: 'item.token', from: 'char.su-wan', to: 'char.lin-feng', ev }]));
    expect(cats(r.hard)).toEqual(['item.holder']);
    expect(cats(check(makeDelta([{ op: 'item.transfer', item: 'item.token', from: 'char.lin-feng', to: 'char.su-wan', ev }])).hard)).toEqual([]);
  });

  it('power: from mismatch, regression (ranks), range soft', () => {
    expect(cats(check(makeDelta([{ op: 'power.change', who: 'char.lin-feng', system: 'cultivation', from: '金丹', to: '金丹', ev }])).hard)).toEqual(['power.from']);
    expect(cats(check(makeDelta([{ op: 'power.change', who: 'char.lin-feng', system: 'cultivation', to: '练气三层', ev }])).hard)).toEqual(['power.regress']);
    const ranged = check(makeDelta([{ op: 'power.change', who: 'char.lin-feng', system: 'cultivation', to: '金丹', ev }]), { powerRange: ['练气', '筑基'] });
    expect(cats(ranged.soft)).toContain('power.range');
    expect(ranged.hard).toEqual([]);
  });

  it('time must be monotonic except flashbacks', () => {
    expect(cats(check(makeDelta([{ op: 'time.advance', to: { year: 2, day: 1 }, flashback: false }])).hard)).toEqual(['time.regress']);
    expect(check(makeDelta([{ op: 'time.advance', to: { year: 2, day: 1 }, flashback: true }])).hard).toEqual([]);
    expect(check(makeDelta([{ op: 'time.advance', to: { year: 3, day: 101 }, flashback: false }])).hard).toEqual([]);
  });

  it('location jump is soft and suppressed by elapsed time or offscreen.update', () => {
    const move = { op: 'event', id: 'e', who: ['char.lin-feng'], what: '到渡口', loc: 'loc.ferry', ev };
    expect(cats(check(makeDelta([move])).soft)).toContain('location.jump');
    expect(cats(check(makeDelta([{ op: 'time.advance', to: { year: 3, day: 110 }, flashback: false }, move])).soft)).not.toContain('location.jump');
    expect(cats(check(makeDelta([{ op: 'offscreen.update', ent: 'char.lin-feng', set: { loc: 'loc.ferry' }, declared_by_card: false }, move])).soft)).not.toContain('location.jump');
  });

  it('obligation lifecycle', () => {
    expect(cats(check(makeDelta([{ op: 'obligation.pay', id: 'F0003', ev }])).hard)).toEqual(['obligation.closed']);
    expect(cats(check(makeDelta([{ op: 'obligation.advance', id: 'F0099', ev }])).hard)).toEqual(['obligation.unknown']);
    expect(cats(check(makeDelta([{ op: 'obligation.open', id: 'F0001', kind: 'mystery', weight: 'minor', text: 'x', ev }])).hard)).toEqual(['obligation.duplicate_open']);
    expect(cats(check(makeDelta([{ op: 'obligation.abandon', id: 'F0002', reason: '不写了', ev }])).hard)).toEqual(['obligation.abandon_main']);
    const early = check(makeDelta([{ op: 'obligation.pay', id: 'F0001', ev }]));
    expect(cats(early.soft)).toEqual(expect.arrayContaining(['obligation.early_pay', 'obligation.unplanned_pay']));
  });

  it('may_open and unplanned invention follow policy strictness', () => {
    const open = { op: 'obligation.open', id: 'tmp:new', kind: 'setup', weight: 'minor', text: '新伏笔', ev };
    expect(cats(check(makeDelta([open])).soft)).toContain('obligation.unplanned_open');
    expect(cats(check(makeDelta([open]), { unplannedInvention: 'strict' }).hard)).toContain('obligation.unplanned_open');
    expect(cats(check(makeDelta([open]), { card: card({ may_open: ['new'] }) }).soft)).not.toContain('obligation.unplanned_open');
    const create = { op: 'entity.create', ent: 'tmp:zhang', kind: 'character', name: '张三', ev };
    expect(cats(check(makeDelta([create]), { unplannedInvention: 'strict' }).hard)).toContain('invention.entity');
    const extra = { ...create, tier: 'extra' };
    expect(cats(check(makeDelta([extra]), { unplannedInvention: 'strict' }).hard)).not.toContain('invention.entity');
    expect(cats(check(makeDelta([create]), { card: card({ entities_present: ['tmp:zhang'] }) }).soft)).not.toContain('invention.entity');
  });

  it('references must resolve; tmp ids need a create in the same delta', () => {
    const r = check(makeDelta([{ op: 'entity.update', ent: 'char.nobody', set: { loc: 'loc.ferry' }, ev }]));
    expect(cats(r.hard)).toEqual(['ref.unknown_entity']);
    expect(Object.values(r.attribution)).toEqual(['extractor']);
    const ok = check(
      makeDelta([
        { op: 'entity.create', ent: 'tmp:zhang', kind: 'character', name: '张三', ev },
        { op: 'entity.update', ent: 'tmp:zhang', set: { loc: 'loc.ferry' }, ev },
      ]),
    );
    expect(cats(ok.hard)).toEqual([]);
  });

  it('reports original op indices for vocabulary re-extraction after drops', () => {
    const r = check(
      makeDelta([
        { op: 'event', id: 'e', who: [], what: '丢', ev: '根本没有这句话的内容' },
        { op: 'entity.update', ent: 'char.lin-feng', set: { 'cond+': ['左臂骨折'] }, ev },
      ]),
    );
    expect(r.reextract.map((x) => x.index)).toEqual([1]);
  });

  it('diff deltas cannot prove post or recall gaps', () => {
    const r = check(makeDelta([], { mode: 'diff' }), { card: card({ post: [{ op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.spy' }], pays: ['F0001'] }), eventFamilies: { x: ['拍了拍'] } });
    expect(r.unmetPost).toEqual([]);
    expect(r.recallMisses).toEqual([]);
  });

  it('expand diff refuses new story content', () => {
    const r = check(makeDelta([{ op: 'event', id: 'e', who: ['char.lin-feng'], what: '新事件', ev }], { mode: 'diff' }), { expandOnly: true });
    expect(cats(r.hard)).toEqual(['expand.new_op']);
  });

  it('uses_knowledge requires prior or same-chapter learning; overridden facts are soft', () => {
    const d = makeDelta([], { uses_knowledge: [{ who: 'char.lin-feng', fact: 'fact.spy', ev }] });
    expect(cats(check(d).hard)).toEqual(['knowledge.unearned']);
    const learned = makeDelta([{ op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.spy', ev }], { uses_knowledge: [{ who: 'char.lin-feng', fact: 'fact.spy', ev }] });
    expect(check(learned).hard).toEqual([]);
    const o: Override = { schema: 'nv.override/1', id: 'o2', ts: 't', effective_from: 'c00001', target: { kind: 'fact', fact: 'fact.spy' }, action: 'set', value: 'x', note: 'n', author: 'owner' };
    expect(cats(check(learned, { overrides: [o] }).soft)).toContain('fact.overridden');
  });
});

describe('card predicates', () => {
  const ev = '苏婉低声说话，林枫听见了她的秘密';

  it('post met by op pattern and predicate; unmet reports candidate sentences', () => {
    const c = card({ post: [{ op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.spy' }] });
    const met = check(makeDelta([{ op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.spy', ev }]), { card: c });
    expect(met.unmetPost).toEqual([]);
    const unmet = check(makeDelta([]), { card: c, eventFamilies: { reveal: ['秘密'] } });
    expect(unmet.unmetPost).toHaveLength(1);
    expect(unmet.unmetPost[0]?.candidates[0]).toContain('秘密');
    expect(unmet.ok).toBe(false);
  });

  it('predicate post evaluates on the projected state after the delta', () => {
    const c = card({ post: [{ knows: ['char.lin-feng', 'fact.spy'] }] });
    expect(check(makeDelta([{ op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.spy', ev }]), { card: c }).unmetPost).toEqual([]);
    expect(check(makeDelta([]), { card: c }).unmetPost).toHaveLength(1);
  });

  it('must_not hits are hard with a quote; pre-existing predicate is soft', () => {
    const r = check(makeDelta([{ op: 'reader.reveal', fact: 'fact.spy', ev }]), { card: card({ must_not: [{ op: 'reader.reveal', fact: 'fact.spy' }] }) });
    expect(r.mustNotHits[0]?.quote).toBe(ev);
    expect(cats(r.hard)).toEqual(['must_not']);
    const pre = check(makeDelta([]), { card: card({ must_not: [{ dead: 'char.ghost' }] }) });
    expect(pre.hard).toEqual([]);
    expect(cats(pre.soft)).toContain('must_not.preexisting');
  });

  it('false pre is hard; card.pays/advances become unmet obligations', () => {
    expect(cats(check(makeDelta([]), { card: card({ pre: [{ alive: 'char.ghost' }] }) }).hard)).toEqual(['card.pre']);
    const r = check(makeDelta([]), { card: card({ pays: ['F0001'], advances: ['F0002'] }) });
    expect(r.unmetPost.map((u) => u.cond)).toEqual([
      { op: 'obligation.pay', id: 'F0001' },
      { op: 'obligation.advance', id: 'F0002' },
    ]);
  });
});

describe('recall, leaks, flags', () => {
  const secret = (o: Record<string, unknown> = {}): Secret => zSecret.parse({ schema: 'nv.secret/1', id: 's', truth: 't', leak_signatures: ['苏婉.{0,14}秘密'], ...o });

  it('leak signatures hit as must_not regardless of ops, but not once the reader knows', () => {
    const r = check(makeDelta([]), { secrets: [secret({ fact: 'fact.spy' })] });
    expect(r.leaks[0]).toMatchObject({ secret: 's' });
    expect(cats(r.hard)).toContain('leak');
    const known = check(makeDelta([{ op: 'reader.reveal', fact: 'fact.spy', ev: '林枫把铜牌收进袖中' }]), {
      before: { ...before, reader_knows: ['fact.spy'] },
      secrets: [secret({ fact: 'fact.spy' })],
    });
    expect(known.leaks).toEqual([]);
    const planned = check(makeDelta([]), { secrets: [secret({ reveal_plan: [{ at: 'c00002', to: 'reader' }] })] });
    expect(planned.leaks).toEqual([]);
  });

  it('survives invalid leak signatures', () => {
    const r = check(makeDelta([]), { secrets: [secret({ leak_signatures: ['('] })] });
    expect(cats(r.soft)).toContain('secret.bad_signature');
  });

  it('recall probe flags mentioned entities with event words but no ops', () => {
    const r = deltaCheck({
      delta: makeDelta([]),
      draft: `${draft}路人甲当场死了。\n`,
      card: card(),
      before,
      world,
      secrets: [],
      overrides: [],
      eventFamilies: { death: ['死了'] },
      aliases,
      unplannedInvention: 'soft',
    });
    expect(r.recallMisses).toEqual([{ entity: 'char.bystander', family: 'death', quote: '路人甲当场死了。' }]);
    expect(r.ok).toBe(false);
    const covered = deltaCheck({
      delta: makeDelta([{ op: 'entity.retire', ent: 'char.bystander', how: 'death', ev: '路人甲当场死了' }]),
      draft: `${draft}路人甲当场死了。\n`,
      card: card(),
      before,
      world,
      secrets: [],
      overrides: [],
      eventFamilies: { death: ['死了'] },
      aliases,
      unplannedInvention: 'soft',
    });
    expect(covered.recallMisses).toEqual([]);
  });

  it('confirms continuity flags only when the quote verifies and the rule agrees', () => {
    const r = check(makeDelta([]), {
      continuityFlags: [
        { kind: 'dead_reappears', quote: '老鬼拍了拍林枫的肩膀', message: 'm', ents: ['char.ghost'] },
        { kind: 'dead_reappears', quote: '老鬼拍了拍林枫的肩膀', message: 'm', ents: ['char.su-wan'] },
        { kind: 'other', quote: '并不存在的引文内容', message: 'm', ents: [] },
      ],
    });
    expect(r.confirmedFlags).toHaveLength(1);
    expect(r.ok).toBe(false);
  });
});

describe('checkSummaryAnchors', () => {
  const d = (anchors: string[][]) => makeDelta([{ op: 'event', id: 'e', who: [], what: 'x', ev: 'x' }], { summary: anchors.map((a, i) => ({ s: `s${i}`, anchors: a })) });
  it('rejects above the limit', () => {
    expect(checkSummaryAnchors(d([[], [], ['op:0']]))).toMatchObject({ ok: false });
    expect(checkSummaryAnchors(d([['op:0'], ['ev:引文'], ['op:0'], []]))).toEqual({ ok: true, ratio: 0.25 });
  });
  it('treats out-of-range and malformed anchors as missing', () => {
    expect(checkSummaryAnchors(d([['op:9'], ['foo']])).ratio).toBe(1);
    expect(checkSummaryAnchors(makeDelta([]))).toEqual({ ok: true, ratio: 0 });
  });
});

describe('verifyFormatRepair', () => {
  const ev = '林枫把铜牌收进袖中';
  const original = { schema: 'nv.delta/1', chapter: 'c00002', ops: [{ op: 'event', id: 'e1', who: ['char.lin-feng'], what: '收铜牌', ev, extra: 'junk' }] };
  const repaired = (ops: DeltaOp[] | unknown[]) => zDelta.parse({ schema: 'nv.delta/1', chapter: 'c00002', ops });

  it('accepts a subset of the original with verbatim ev (also from raw text)', () => {
    const fixed = repaired([{ op: 'event', id: 'e1', who: ['char.lin-feng'], what: '收铜牌', ev }]);
    expect(verifyFormatRepair(original, fixed, draft)).toEqual({ ok: true });
    expect(verifyFormatRepair(`${JSON.stringify(original)} trailing`, fixed, draft)).toEqual({ ok: true });
  });
  it('rejects added ops, new content, and non-verbatim ev', () => {
    const base = { op: 'event', id: 'e1', who: ['char.lin-feng'], what: '收铜牌', ev };
    expect(verifyFormatRepair(original, repaired([base, base]), draft).ok).toBe(false);
    expect(verifyFormatRepair(original, repaired([{ ...base, what: '杀了所有人' }]), draft).ok).toBe(false);
    expect(verifyFormatRepair(original, repaired([{ ...base, ev: '林枫把铜牌收进袖里' }]), draft).ok).toBe(false);
  });
});
