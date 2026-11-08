/**
 * 生效 gate 清单（DESIGN §6.5）：书层 gates.overrides > 书 gates.yaml > 题材链（后者覆盖前者）> 全局 > 内置默认。
 * I/O 契约 gate 固定在最前，不可关闭（override 对它无效）。Owner: lane D。
 */
import type { EffectiveGate, GateOverride, GateRule, GatesFile } from '@novelist/shared';
import { CONTRACT_RULE_IDS, CRAFT_RULE_IDS } from '@novelist/shared';

export interface GateLayers {
  builtin: GatesFile;
  global: GatesFile | null;
  /** 题材链，base 在前 */
  genre: { genre: string; file: GatesFile }[];
  bookFile: GatesFile | null;
  bookOverrides: Record<string, GateOverride>;
}

const rule = (level: GateRule['level'], params: Record<string, unknown> = {}): GateRule => ({ level, params, allow: [] });

/** 内置默认（与 genres/builtin/*\/gates.yaml 一致；P3+ 的软指标在此默认 soft，书层可逐条关闭） */
export const BUILTIN_GATES: GatesFile = {
  schema: 'nv.gates/1',
  rules: {
    'length.total': rule('hard'),
    'length.beat': rule('soft', { tolerance: 0.4 }),
    'beat.markers': rule('hard'),
    'end.markers': rule('hard'),
    placeholder: rule('hard', { soft_brackets: true }),
    'meta.text': rule('hard'),
    'repeat.intra': rule('hard', { min_chars: 50 }),
    'repeat.cross': rule('soft', { window: 30, ngram: 8 }),
    lexicon: rule('soft'),
    dramatize: rule('soft'),
    single_sentence_paragraph: rule('soft'),
    dialogue_ratio: rule('soft'),
    opening_cliche: rule('soft'),
  },
};

type Source = EffectiveGate['source'];

const CONTRACT_SET = new Set<string>(CONTRACT_RULE_IDS);

interface Acc extends EffectiveGate {
  /** 最近一个非 off 的级别（disable:false 时恢复用） */
  on: 'hard' | 'soft';
}

function applyLayer(acc: Map<string, Acc>, rules: Record<string, GateRule | GateOverride> | undefined, source: Source): void {
  for (const [id, raw] of Object.entries(rules ?? {})) {
    if (CONTRACT_SET.has(id)) continue;
    const o = raw as GateOverride;
    const touched = o.disable !== undefined || o.level !== undefined || Object.keys(o.params ?? {}).length > 0 || (o.allow ?? []).length > 0;
    const prev = acc.get(id);
    if (!prev && !touched && !('level' in raw)) continue;
    const cur: Acc = prev ?? { rule: id, family: 'craft', level: 'soft', params: {}, allow: [], source, on: 'soft' };
    if (o.level) {
      cur.level = o.level;
      if (o.level !== 'off') cur.on = o.level;
    }
    if (o.disable === true) cur.level = 'off';
    else if (o.disable === false && cur.level === 'off') cur.level = cur.on;
    if (o.params) cur.params = { ...cur.params, ...o.params };
    if (o.allow?.length) cur.allow = [...new Set([...cur.allow, ...o.allow])];
    if (touched || !prev) cur.source = source;
    acc.set(id, cur);
  }
}

export function resolveEffectiveGates(layers: GateLayers): EffectiveGate[] {
  const acc = new Map<string, Acc>();
  applyLayer(acc, layers.builtin.rules, 'builtin');
  applyLayer(acc, layers.global?.rules, 'global');
  for (const g of layers.genre) applyLayer(acc, g.file.rules, 'genre');
  applyLayer(acc, layers.bookFile?.rules, 'book');
  applyLayer(acc, layers.bookOverrides, 'book');

  const contract: EffectiveGate[] = CONTRACT_RULE_IDS.map((id) => ({ rule: id, family: 'contract', level: 'hard', params: {}, allow: [], source: 'novelist' }));
  const known = new Set<string>(CRAFT_RULE_IDS);
  const ordered = [...CRAFT_RULE_IDS.filter((id) => acc.has(id)), ...[...acc.keys()].filter((id) => !known.has(id)).sort()];
  const craft = ordered.map((id) => {
    const { on: _on, ...gate } = acc.get(id) as Acc;
    return gate;
  });
  return [...contract, ...craft];
}
