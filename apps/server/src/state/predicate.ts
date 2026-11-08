/** nv.predicate/1 求值与卡片条件（DESIGN §6.1、§6.2）。Owner: lane B。 */
import type { Card, Delta, DeltaOp, OpPattern, Predicate, PredicateValue, Snapshot } from '@novelist/shared';
import { canonicalJson } from './canon.js';
import { applyDelta } from './fold.js';

const isTmp = (s: unknown) => typeof s === 'string' && s.startsWith('tmp:');

/** 卡片条件是 op 模式（有字符串 op 字段）还是谓词 */
export function isOpPattern(c: unknown): c is OpPattern {
  return !!c && typeof c === 'object' && !Array.isArray(c) && typeof (c as { op?: unknown }).op === 'string';
}

/** 读实体属性：alive / stage / name / kind / conds / retired / power.<体系> / 其余 attrs。实体不存在 → undefined */
export function entityAttr(s: Snapshot, ent: string, key: string): unknown {
  const e = s.entities[ent];
  if (!e) return undefined;
  switch (key) {
    case 'alive':
      return e.alive;
    case 'stage':
      return e.stage ?? null;
    case 'name':
      return e.name;
    case 'kind':
      return e.kind;
    case 'conds':
    case 'cond':
      return e.conds;
    case 'retired':
      return e.retired ?? null;
    default:
      if (key.startsWith('power.')) return e.power[key.slice(6)] ?? null;
      return key in e.attrs ? e.attrs[key] : null;
  }
}

const scalarEq = (a: unknown, b: unknown) => (a === b ? true : canonicalJson(a ?? null) === canonicalJson(b ?? null));

function and3(vals: PredicateValue[]): PredicateValue {
  if (vals.includes(false)) return false;
  if (vals.includes('unresolved')) return 'unresolved';
  if (vals.includes('manual')) return 'manual';
  return true;
}
function or3(vals: PredicateValue[]): PredicateValue {
  if (vals.includes(true)) return true;
  if (vals.includes('unresolved')) return 'unresolved';
  if (vals.includes('manual')) return 'manual';
  return false;
}
function not3(v: PredicateValue): PredicateValue {
  return v === true ? false : v === false ? true : v;
}

/**
 * 三值求值：false 优先于 unresolved 优先于 manual（and）；true 优先（or）。
 * 引用 tmp: 或不存在的实体/伏笔 → 'unresolved'。obligation status=open 同时匹配 advanced（都还没收束）。
 */
export function evaluatePredicate(p: Predicate, s: Snapshot): PredicateValue {
  const pp = p as Record<string, unknown>;
  if ('and' in pp) return and3((p as { and: Predicate[] }).and.map((x) => evaluatePredicate(x, s)));
  if ('or' in pp) return or3((p as { or: Predicate[] }).or.map((x) => evaluatePredicate(x, s)));
  if ('not' in pp) return not3(evaluatePredicate((p as { not: Predicate }).not, s));
  if ('manual' in pp) return 'manual';
  if ('eq' in pp || 'ne' in pp || 'in' in pp) {
    const [ref, v] = (pp.eq ?? pp.ne ?? pp.in) as [{ attr: [string, string] }, unknown];
    const [ent, key] = ref.attr;
    if (isTmp(ent) || !s.entities[ent]) return 'unresolved';
    const cur = entityAttr(s, ent, key);
    if ('eq' in pp) return scalarEq(cur, v);
    if ('ne' in pp) return !scalarEq(cur, v);
    return Array.isArray(v) && v.some((x) => scalarEq(cur, x));
  }
  if ('knows' in pp || 'knows_not' in pp) {
    const [who, fact] = (pp.knows ?? pp.knows_not) as [string, string];
    if (isTmp(who) || isTmp(fact) || !s.entities[who]) return 'unresolved';
    const k = (s.knowledge[who] ?? []).includes(fact);
    return 'knows' in pp ? k : !k;
  }
  if ('obligation' in pp) {
    const id = pp.obligation as string;
    const want = pp.status as string;
    if (isTmp(id)) return 'unresolved';
    const o = s.obligations[id];
    if (!o) return 'unresolved';
    if (want === 'open') return o.status === 'open' || o.status === 'advanced';
    return o.status === want;
  }
  if ('stage' in pp) {
    const [ent, stage] = pp.stage as [string, string];
    const e = s.entities[ent];
    if (isTmp(ent) || !e) return 'unresolved';
    return e.stage === stage || (!!e.stage && e.stage.startsWith(`${stage}-`));
  }
  if ('at_loc' in pp) {
    const [ent, loc] = pp.at_loc as [string, string];
    const e = s.entities[ent];
    if (isTmp(ent) || isTmp(loc) || !e) return 'unresolved';
    return e.attrs.loc === loc;
  }
  if ('alive' in pp) {
    const e = s.entities[pp.alive as string];
    if (!e) return 'unresolved';
    return e.alive;
  }
  if ('dead' in pp) {
    const e = s.entities[pp.dead as string];
    if (!e) return 'unresolved';
    return !e.alive;
  }
  if ('has_cond' in pp) {
    const [ent, cond] = pp.has_cond as [string, string];
    const e = s.entities[ent];
    if (isTmp(ent) || !e) return 'unresolved';
    return e.conds.includes(cond);
  }
  return 'unresolved';
}

function fieldMatches(want: unknown, have: unknown): boolean {
  if (want === undefined) return true;
  if (Array.isArray(have) && !Array.isArray(want)) return have.some((h) => scalarEq(h, want));
  if (Array.isArray(have) && Array.isArray(want)) return want.every((w) => have.some((h) => scalarEq(h, w)));
  if (want && typeof want === 'object' && have && typeof have === 'object' && !Array.isArray(want)) {
    return Object.entries(want as Record<string, unknown>).every(([k, v]) => fieldMatches(v, (have as Record<string, unknown>)[k]));
  }
  return scalarEq(want, have);
}

/** 单条 op 是否匹配模式 */
export function opMatches(pattern: OpPattern, op: DeltaOp): boolean {
  if (op.op !== pattern.op) return false;
  const rec = op as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(pattern)) {
    if (k === 'op') continue;
    if (!fieldMatches(v, rec[k])) return false;
  }
  return true;
}

/** op 模式匹配：pattern 的每个非 op 字段都等于 delta 中某条同类型 op 的字段（数组字段按包含判断，对象字段按子集判断） */
export function matchOpPattern(pattern: OpPattern, delta: Delta): boolean {
  return (delta.ops ?? []).some((op) => opMatches(pattern, op));
}

export interface ConditionReport {
  pre: { cond: unknown; value: PredicateValue }[];
  post: { cond: unknown; value: PredicateValue | 'unmet' | 'met' }[];
  mustNot: { cond: unknown; violated: boolean }[];
  ok: boolean;
}

/**
 * 写前（delta 省略）只算 pre；抽取后算 post 与 must_not。
 * - pre：谓词对 before 求值；op 模式在 pre 中无意义，记 'manual'。
 * - post：op 模式 → 'met'/'unmet'；谓词对 after（省略时 = applyDelta(before, delta)）求值。
 * - must_not：op 模式匹配到即违反；谓词在 after 上为 true 即违反。
 * - ok：pre 无 false/unresolved、post 无 unmet/false/unresolved、must_not 无违反（manual 不阻断）。
 */
export function evaluateCard(card: Card, before: Snapshot, delta?: Delta, after?: Snapshot): ConditionReport {
  const pre = (card.pre ?? []).map((cond) => ({ cond, value: isOpPattern(cond) ? ('manual' as const) : evaluatePredicate(cond as Predicate, before) }));
  const post: ConditionReport['post'] = [];
  const mustNot: ConditionReport['mustNot'] = [];
  if (delta) {
    const aft = after ?? applyDelta(before, delta);
    for (const cond of card.post ?? []) {
      if (isOpPattern(cond)) post.push({ cond, value: matchOpPattern(cond, delta) ? 'met' : 'unmet' });
      else post.push({ cond, value: evaluatePredicate(cond as Predicate, aft) });
    }
    for (const cond of card.must_not ?? []) {
      if (isOpPattern(cond)) mustNot.push({ cond, violated: matchOpPattern(cond, delta) });
      else mustNot.push({ cond, violated: evaluatePredicate(cond as Predicate, aft) === true });
    }
  }
  const ok =
    pre.every((p) => p.value !== false && p.value !== 'unresolved') &&
    post.every((p) => p.value !== 'unmet' && p.value !== false && p.value !== 'unresolved') &&
    mustNot.every((m) => !m.violated);
  return { pre, post, mustNot, ok };
}

/** 收集谓词/op 模式里引用的 id（实体、事实、伏笔），供 context pack 与 stale 判定使用 */
export function conditionRefs(c: unknown): { entities: string[]; facts: string[]; obligations: string[] } {
  const ents = new Set<string>();
  const facts = new Set<string>();
  const obls = new Set<string>();
  const visit = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const y of x) visit(y);
      return;
    }
    const o = x as Record<string, unknown>;
    if (isOpPattern(o)) {
      for (const [k, v] of Object.entries(o)) {
        if (k === 'op') continue;
        for (const s of Array.isArray(v) ? v : [v]) {
          if (typeof s !== 'string') continue;
          if (/^(char|loc|fac|item|concept)\./.test(s)) ents.add(s);
          else if (s.startsWith('fact.') || s.startsWith('ident:')) facts.add(s);
          else if (/^F\d{4,5}$/.test(s)) obls.add(s);
          else if (k === 'fact') facts.add(s);
          else if (k === 'id' && String(o.op).startsWith('obligation.')) obls.add(s);
        }
      }
      return;
    }
    if ('and' in o || 'or' in o || 'not' in o) {
      visit(o.and ?? o.or ?? o.not);
      return;
    }
    for (const key of ['eq', 'ne', 'in'] as const) {
      const v = o[key] as [{ attr: [string, string] }, unknown] | undefined;
      if (v) ents.add(v[0].attr[0]);
    }
    for (const key of ['knows', 'knows_not'] as const) {
      const v = o[key] as [string, string] | undefined;
      if (v) {
        ents.add(v[0]);
        facts.add(v[1]);
      }
    }
    if (typeof o.obligation === 'string') obls.add(o.obligation);
    for (const key of ['stage', 'has_cond'] as const) {
      const v = o[key] as [string, string] | undefined;
      if (Array.isArray(v)) ents.add(v[0]);
    }
    if (Array.isArray(o.at_loc)) {
      ents.add(o.at_loc[0] as string);
      ents.add(o.at_loc[1] as string);
    }
    if (typeof o.alive === 'string') ents.add(o.alive);
    if (typeof o.dead === 'string') ents.add(o.dead);
  };
  visit(c);
  return { entities: [...ents].sort(), facts: [...facts].sort(), obligations: [...obls].sort() };
}
