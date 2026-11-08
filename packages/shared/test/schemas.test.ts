import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  BUILTIN_PROFILES,
  ROUTES,
  SCHEMAS,
  chapterId,
  chapterNo,
  countByBeat,
  countCjk,
  mergeLayers,
  schemaForPath,
  toJsonSchema,
  zBookConfig,
  zCard,
  zDelta,
  zProfile,
  zReceipt,
  zRoutingPreset,
  zSystemSettings,
} from '../src/index.js';

describe('ids', () => {
  it('round-trips chapter ids', () => {
    expect(chapterId(421)).toBe('c00421');
    expect(chapterNo('c00421')).toBe(421);
    expect(() => chapterNo('x1')).toThrow();
  });
});

describe('book.yaml', () => {
  it('fills defaults (D2 standard tier, D4 publish)', () => {
    const b = zBookConfig.parse({ slug: 'demo', title: '演示', genre: 'xianxia' });
    expect(b.tier).toBe('standard');
    expect(b.publish.mode).toBe('scheduled');
    expect(b.publish.min_lag).toBe(15);
    expect(b.publish.max_buffer).toBe(60);
    expect(b.publish.require_audited).toBe(true);
    expect(b.scale.target_cjk).toBe(3_000_000);
  });
});

describe('card (DESIGN §6.1 example)', () => {
  it('parses predicates and op patterns', () => {
    const card = zCard.parse({
      schema: 'nv.card/1',
      id: 'c00421',
      title: '雨夜渡口',
      volume: 'v03',
      arc: 'a0012',
      length: { min: 2600, target: 3000, max: 3800, count_mode: 'han' },
      pre: [{ has_cond: ['char.lin-feng', 'injury.arm.left.fracture'] }, { knows_not: ['char.lin-feng', 'fact.su-wan-spy'] }],
      post: [{ op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.su-wan-spy' }],
      must_not: [{ op: 'reader.reveal', fact: 'fact.lin-feng-heir' }],
      offscreen: [{ ent: 'char.zhao-heng', set: { loc: 'loc.capital' } }],
      beats: [
        { id: 'b1', mode: 'dramatize', cjk: 600, goal: '…' },
        { id: 'b2', mode: 'interior', cjk: 450, goal: '…' },
      ],
      callbacks: [{ query: '渡口 雨夜' }, { quote: '青铜铃响三声', from: 'c00087' }],
      notes: '本章笔记',
    });
    expect(card.pre).toHaveLength(2);
  });
});

describe('delta (DESIGN §4.2 example)', () => {
  it('parses ops', () => {
    const d = zDelta.parse({
      schema: 'nv.delta/1',
      chapter: 'c00421',
      summary: [{ s: '林枫夜渡黑水，伤臂换船。', anchors: ['op:2'] }],
      ops: [
        { op: 'entity.create', ent: 'tmp:old-boatman', kind: 'character', name: '老艄公', aliases: ['艄公'], declared: true, ev: '…' },
        { op: 'entity.update', ent: 'char.lin-feng', from: { loc: 'loc.qingyun' }, set: { loc: 'loc.black-ferry', 'cond+': ['injury.arm.left.fracture'] }, ev: '他左臂吊着绷带' },
        { op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.su-wan-spy', how: 'overheard', ev: '……原来是她' },
        { op: 'obligation.open', id: 'tmp:f1', kind: 'foreshadow', weight: 'major', due: ['c00460', 'c00540'], text: '老艄公认得铜牌', ev: '…' },
        { op: 'obligation.pay', id: 'F0057', ev: '…' },
        { op: 'time.advance', to: { year: 3, day: 412, hour: 23 }, flashback: false },
        { op: 'offscreen.update', ent: 'char.zhao-heng', set: { loc: 'loc.capital' }, declared_by_card: true },
      ],
    });
    expect(d.ops).toHaveLength(7);
  });
});

describe('presets', () => {
  it('builtin profiles and presets are valid and reference existing profiles', () => {
    const ids = new Set(BUILTIN_PROFILES.map((p) => zProfile.parse(p).id));
    for (const p of BUILTIN_PRESETS) {
      const preset = zRoutingPreset.parse(p);
      for (const route of Object.values(preset.roles)) {
        for (const id of [...(route?.chain ?? []), ...(route?.degrade_to ?? []), ...(route?.failover_chain ?? [])]) {
          expect(ids.has(id), `${preset.id} → ${id}`).toBe(true);
        }
      }
    }
  });
  it('default preset is agy-argon and non-dev presets never use dev profiles', () => {
    expect(zSystemSettings.parse({}).activePreset).toBe('agy-argon');
    const dev = new Set(BUILTIN_PROFILES.filter((p) => p.tags?.includes('dev')).map((p) => p.id));
    for (const p of BUILTIN_PRESETS.filter((x) => x.id !== 'dev-cheap' && x.id !== 'fake')) {
      for (const r of Object.values(p.roles)) for (const id of r?.chain ?? []) expect(dev.has(id)).toBe(false);
    }
  });
});

describe('json schema dialects', () => {
  it('strict dialect requires all props and forbids extras', () => {
    const js = toJsonSchema(zReceipt, 'strict') as { required: string[]; additionalProperties: boolean };
    expect(js.additionalProperties).toBe(false);
    expect(js.required).toContain('title_proposal');
    const lenient = toJsonSchema(zReceipt, 'lenient') as { required: string[] };
    expect(lenient.required).not.toContain('title_proposal');
  });
  it('every registered schema exports', () => {
    for (const [name, s] of Object.entries(SCHEMAS)) expect(() => toJsonSchema(s), name).not.toThrow();
  });
});

describe('text', () => {
  it('counts han and platform', () => {
    expect(countCjk('林枫说：“走！”abc 12')).toBe(4);
    expect(countCjk('林枫说：“走！”abc 12', 'platform')).toBe(4 + 4 + 2);
    expect(countByBeat('<!-- beat:b1 -->\n一二三\n<!-- beat:b2 -->\n四五')).toEqual({ _pre: 0, b1: 3, b2: 2 });
  });
  it('merges layers deeply, arrays replace', () => {
    expect(mergeLayers({ a: { x: 1, y: [1] } }, { a: { y: [2] } }, { a: { z: 3 } })).toEqual({ a: { x: 1, y: [2], z: 3 } });
  });
});

describe('registry', () => {
  it('maps paths to schemas', () => {
    expect(schemaForPath('plan/cards/c00001.yaml')).toBe('nv.card/1');
    expect(schemaForPath('state/ledger/c00001.json')).toBe('nv.delta/1');
    expect(schemaForPath('manuscript/c00001.md')).toBeNull();
  });
  it('route table has unique method+path', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
