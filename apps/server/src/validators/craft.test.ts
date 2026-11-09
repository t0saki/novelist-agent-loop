import type { Card, EffectiveGate, GatesFile, Lexicon } from '@novelist/shared';
import { describe, expect, it } from 'vitest';
import { fixtureCard } from '../book/index.js';
import { gateVerdict, runCraftGates } from './craft.js';
import { BUILTIN_GATES, resolveEffectiveGates } from './gates-config.js';
import { mergeLexiconLayers } from './lexicon.js';

const card: Card = { ...fixtureCard(3), beats: [{ id: 'b1', mode: 'dramatize', cjk: 20, goal: 'g' }, { id: 'b2', mode: 'dialogue', cjk: 20, goal: 'g' }] };
const lex = (o: Partial<Lexicon> = {}): Lexicon => ({ schema: 'nv.lexicon/1', ban: [], watch: [], allow: [], patterns: [], ...o });
const length = { min: 30, target: 40, max: 50, count_mode: 'han' as const };

function run(draft: string, opts: { overrides?: Record<string, object>; lexicon?: Lexicon; isFinal?: boolean; recent?: { id: string; text: string }[]; terms?: string[] } = {}) {
  const gates = resolveEffectiveGates({ builtin: BUILTIN_GATES, global: null, genre: [], bookFile: null, bookOverrides: opts.overrides ?? {} });
  return runCraftGates({
    draft,
    card,
    length,
    gates,
    lexicon: opts.lexicon ?? lex(),
    isFinal: !!opts.isFinal,
    ...(opts.recent ? { recent: opts.recent } : {}),
    ...(opts.terms ? { protectedTerms: opts.terms } : {}),
  });
}
const one = (rs: ReturnType<typeof run>, rule: string) => rs.find((r) => r.rule === rule);

const good = `<!-- beat:b1 -->\n林枫站在山门前看着远方的云海，久久没有说话。\n\n<!-- beat:b2 -->\n“你要走吗？”苏婉轻声问道，手指绞着衣角。\n`;

describe('resolveEffectiveGates', () => {
  const genre: GatesFile = { schema: 'nv.gates/1', rules: { 'length.beat': { level: 'hard', params: { tolerance: 0.2 }, allow: [] }, 'meta.text': { allow: ['作为AI'] } } };
  const layers = {
    builtin: BUILTIN_GATES,
    global: { schema: 'nv.gates/1' as const, rules: { lexicon: { level: 'off' as const, params: {}, allow: [] } } },
    genre: [{ genre: 'xianxia', file: genre }],
    bookFile: null,
    bookOverrides: { 'length.beat': { params: { tolerance: 0.5 } }, placeholder: { disable: true }, 'contract.schema': { disable: true } },
  };

  it('puts fixed contract gates first and ignores overrides on them', () => {
    const g = resolveEffectiveGates(layers);
    expect(g[0]?.family).toBe('contract');
    const schema = g.find((x) => x.rule === 'contract.schema') as EffectiveGate;
    expect(schema.level).toBe('hard');
    expect(schema.source).toBe('novelist');
  });

  it('merges precedence builtin < global < genre < book and records origin layer', () => {
    const g = resolveEffectiveGates(layers);
    const beat = g.find((x) => x.rule === 'length.beat') as EffectiveGate;
    expect(beat).toMatchObject({ level: 'hard', source: 'book', params: { tolerance: 0.5 } });
    expect(g.find((x) => x.rule === 'lexicon')).toMatchObject({ level: 'off', source: 'global' });
    expect(g.find((x) => x.rule === 'placeholder')).toMatchObject({ level: 'off', source: 'book' });
    expect(g.find((x) => x.rule === 'meta.text')).toMatchObject({ level: 'hard', source: 'genre', allow: ['作为AI'] });
    expect(g.find((x) => x.rule === 'length.total')).toMatchObject({ level: 'hard', source: 'builtin' });
  });

  it('disable:false restores the last enabled level', () => {
    const g = resolveEffectiveGates({
      ...layers,
      genre: [{ genre: 'a', file: { schema: 'nv.gates/1', rules: { placeholder: { disable: true } } } }],
      bookOverrides: { placeholder: { disable: false } },
    });
    expect(g.find((x) => x.rule === 'placeholder')).toMatchObject({ level: 'hard', source: 'book' });
  });
});

describe('runCraftGates', () => {
  it('passes a clean draft', () => {
    const rs = run(good, { overrides: { 'length.total': { params: { min: 20, max: 60 } } } });
    expect(rs.filter((r) => !r.ok && r.level === 'hard')).toEqual([]);
    expect(one(rs, 'beat.markers')?.measured?.missing).toBe(0);
    expect(one(rs, 'length.total')?.source).toBe('book');
  });

  it('length.total is hard and carries measurements; length.beat is soft', () => {
    const short = '<!-- beat:b1 -->\n短。\n\n<!-- beat:b2 -->\n短。\n';
    const rs = run(short);
    expect(one(rs, 'length.total')).toMatchObject({ ok: false, level: 'hard' });
    expect(one(rs, 'length.beat')).toMatchObject({ ok: false, level: 'soft' });
    const v = gateVerdict(rs);
    expect(v).toMatchObject({ ok: false, lengthOnly: true, suggestion: 'expand' });
  });

  it('suggests compress only within 25% overrun', () => {
    const body = (n: number) => `<!-- beat:b1 -->\n${'字'.repeat(n / 2)}。\n\n<!-- beat:b2 -->\n${'词'.repeat(n / 2)}。\n`;
    const capped = { overrides: { 'length.total': { params: { max: 50 } } } };
    expect(gateVerdict(run(body(60), capped)).suggestion).toBe('compress');
    expect(gateVerdict(run(body(100), capped)).suggestion).toBe('revise');
    // 默认没有上限：写多了直接通过
    expect(one(run(body(1000)), 'length.total')?.ok).toBe(true);
  });

  it('reports missing beat markers with the missing ids', () => {
    expect(one(run('<!-- beat:b1 -->\n内容。\n'), 'beat.markers')).toMatchObject({ ok: false, level: 'hard', detail: expect.stringContaining('b2') });
  });

  it('end.markers only allowed on final chapters and via allow', () => {
    const d = `${good}（本章完）\n`;
    expect(one(run(d), 'end.markers')?.ok).toBe(false);
    expect(one(run(d, { isFinal: true }), 'end.markers')?.ok).toBe(true);
    expect(one(run(d, { overrides: { 'end.markers': { allow: ['（本章完）'] } } }), 'end.markers')?.ok).toBe(true);
    expect(one(run(`${good}他吃完了。\n`), 'end.markers')?.ok).toBe(true);
  });

  it('placeholder and meta.text are hard; brackets are soft and separable', () => {
    const d = `${good}TODO 这里再写。\n【系统提示】\n`;
    const rs = run(d);
    expect(one(rs, 'placeholder')?.ok).toBe(false);
    expect(one(rs, 'placeholder.brackets')).toMatchObject({ ok: false, level: 'soft' });
    expect(one(run(d, { overrides: { placeholder: { params: { soft_brackets: false } } } }), 'placeholder.brackets')).toBeUndefined();
    expect(one(run(`以下是第三章的内容：\n${good}`), 'meta.text')?.ok).toBe(false);
    expect(one(run(`${good}作为AI，我不便多说。\n`, { overrides: { 'meta.text': { allow: ['作为AI'] } } }), 'meta.text')?.ok).toBe(true);
  });

  it('repeat.intra catches verbatim 50+ char repetition with offsets', () => {
    const para = '青云山的雪落了一夜又一夜，远处的钟声隐隐约约传来，像是有人在极远的地方轻轻叩门。山门前的石阶早已被积雪掩埋，只留下几行浅浅的脚印。';
    const d = `<!-- beat:b1 -->\n${para}\n\n<!-- beat:b2 -->\n他想了想，${para}\n`;
    const r = one(run(d), 'repeat.intra');
    expect(r?.ok).toBe(false);
    const span = r?.spans[0];
    expect(span && d.slice(span.start, span.end)).toBe(para);
    expect(one(run(d, { overrides: { 'repeat.intra': { disable: true } } }), 'repeat.intra')?.level).toBe('off');
  });

  it('repeat.cross flags similar chapters softly and verbatim copies hard', () => {
    const copied = '青云山的雪落了一夜又一夜，远处的钟声隐隐约约传来，像是有人在极远的地方轻轻叩门。山门前的石阶早已被积雪掩埋，只留下几行浅浅的脚印。';
    const d = `<!-- beat:b1 -->\n${copied}\n\n<!-- beat:b2 -->\n后来的事。\n`;
    const rs = run(d, { recent: [{ id: 'c00001', text: copied }] });
    expect(one(rs, 'repeat.cross')).toMatchObject({ ok: false, level: 'soft' });
    expect(one(rs, 'repeat.cross.verbatim')).toMatchObject({ ok: false, level: 'hard' });
    expect(one(run(d), 'repeat.cross')).toMatchObject({ ok: true });
  });

  it('lexicon ban/watch/allow: ban hits soft by default, allow suppresses', () => {
    const lexicon = lex({ ban: ['绞着衣角'], watch: ['轻声'] });
    const rs = one(run(good, { lexicon }), 'lexicon');
    expect(rs).toMatchObject({ ok: false, level: 'soft', measured: { ban: 1, watch: 1 } });
    expect(one(run(good, { lexicon: lex({ ban: ['绞着衣角'], allow: ['衣角'] }) }), 'lexicon')?.ok).toBe(true);
    expect(one(run(good, { lexicon: lex({ ban: ['绞着衣角'] }), overrides: { lexicon: { allow: ['绞着衣角'] } } }), 'lexicon')?.ok).toBe(true);
  });

  it('survives invalid user regexes', () => {
    const rs = run(good, { lexicon: lex({ ban: [{ pattern: '(', regex: true, weight: 1 }], patterns: [{ id: 'x', regex: '(', weight: 1, where: 'any' }] }) });
    expect(one(rs, 'lexicon')?.ok).toBe(true);
    expect(one(rs, 'opening_cliche')?.ok).toBe(true);
  });

  it('marks off and unknown rules without running them', () => {
    const gates = resolveEffectiveGates({ builtin: BUILTIN_GATES, global: null, genre: [], bookFile: null, bookOverrides: { 'no.such': { level: 'soft' }, lexicon: { disable: true } } });
    const rs = runCraftGates({ draft: good, card, length, gates, lexicon: lex(), isFinal: false });
    expect(one(rs, 'no.such')).toMatchObject({ ok: true, detail: '未知规则，未执行' });
    expect(one(rs, 'lexicon')).toMatchObject({ ok: true, level: 'off' });
  });
});

describe('gateVerdict', () => {
  it('none when nothing hard failed', () => {
    expect(gateVerdict([{ rule: 'x', family: 'craft', level: 'soft', ok: false, source: 'builtin', spans: [] }])).toMatchObject({ ok: true, suggestion: 'none', lengthOnly: false });
  });
  it('mixed hard failures → revise, not lengthOnly', () => {
    const v = gateVerdict([
      { rule: 'length.total', family: 'craft', level: 'hard', ok: false, source: 'builtin', spans: [], measured: { total: 1, min: 10, max: 20 } },
      { rule: 'placeholder', family: 'craft', level: 'hard', ok: false, source: 'builtin', spans: [] },
    ]);
    expect(v).toMatchObject({ ok: false, lengthOnly: false, suggestion: 'revise' });
  });
});

describe('mergeLexiconLayers', () => {
  it('book allow beats lower bans; book ban takes back a lower allow', () => {
    const merged = mergeLexiconLayers([lex({ ban: ['甲', '乙'], allow: ['丙'] }), lex({ ban: ['丙'], allow: ['甲'] })]);
    expect(merged.ban).toEqual(['乙', '丙']);
    expect(merged.allow).toEqual(['甲']);
  });
  it('same-layer allow wins over ban; later pattern with same id replaces', () => {
    const merged = mergeLexiconLayers([
      lex({ ban: ['甲'], allow: ['甲'], patterns: [{ id: 'p', regex: 'a', weight: 1, where: 'any' }] }),
      lex({ patterns: [{ id: 'p', regex: 'b', weight: 2, where: 'open' }] }),
    ]);
    expect(merged.ban).toEqual([]);
    expect(merged.patterns).toEqual([{ id: 'p', regex: 'b', weight: 2, where: 'open' }]);
  });
});
