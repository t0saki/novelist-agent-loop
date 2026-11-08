/**
 * delta.check（DESIGN §6.6）：确定性账本完整性检查，不随档位降级。Owner: lane D。
 * 依赖 lane B 的 applyDelta / evaluateCard / AliasIndex（只 import 类型与纯函数）。
 *
 * 归因约定：hard 发现中，引用/格式错误（未知实体、重复 create 等）归 extractor；
 * 与账本矛盾且 ev 已被草稿证实的（死人行动、持有冲突、time 倒退等）归 writer。
 */
import type { Card, ContinuityFlag, Delta, DeltaOp, Entity, EntityState, Finding, Override, Predicate, Secret, Snapshot, StoryTime, WorldRules } from '@novelist/shared';
import { KEY_OP_TYPES, normalizeForMatch, stripBeatMarkers } from '@novelist/shared';
import type { AliasIndex } from '../context/alias.js';
import { applyDelta, applySet, canonicalJson, conditionRefs, evaluateCard, evaluatePredicate, isOpPattern, opMatches } from '../state/index.js';
import { type EvidenceMatcher, createEvidenceMatcher } from './evidence.js';
import { compileRegex, finding } from './util.js';

export interface DeltaCheckInput {
  delta: Delta;
  /** 草稿（含 beat 标记亦可；匹配前剥离） */
  draft: string;
  card: Card;
  before: Snapshot;
  world: WorldRules | null;
  secrets: Secret[];
  overrides: Override[];
  eventFamilies: Record<string, string[]>;
  aliases: AliasIndex;
  /** 本卷 power_range（超出判 soft） */
  powerRange?: [string, string];
  /** lite 档 chapter.check 的 continuity_flags：逐字校验 + 规则复核 */
  continuityFlags?: ContinuityFlag[];
  unplannedInvention: 'soft' | 'strict';
  /** 实体定义（identity.reveal 解析 known_by_fact；缺省时按合成事实） */
  entities?: Entity[];
  /** expand 修订后的 diff 抽取：新增 event/fact.assert/entity.create/obligation.open 由状态引擎拒收（§6.5） */
  expandOnly?: boolean;
}

export interface DeltaCheckReport {
  ok: boolean;
  /** ev 自动替换/丢弃次要 op 之后的 delta */
  delta: Delta;
  hard: Finding[];
  soft: Finding[];
  dropped: { index: number; op: string; reason: string }[];
  /** 关键 op ev 缺失 → 定向补抽 */
  reextract: { index: number; op: string; reason: string }[];
  /** 召回探针：提到但无 op 的实体 + 事件词族命中 → extract_incomplete */
  recallMisses: { entity: string; family: string; quote: string }[];
  /** post / must_happen 未满足（先确定性找候选句；仍不确定 → confirm.query） */
  unmetPost: { cond: unknown; candidates: string[] }[];
  mustNotHits: { cond: unknown; quote?: string }[];
  leaks: { secret: string; signature: string; quote: string }[];
  /** 经引文证实的 continuity_flag（触发 chapter.revise(canon)） */
  confirmedFlags: ContinuityFlag[];
  /** 归因：每条 hard 发现属于 extractor 还是 writer */
  attribution: Record<string, 'extractor' | 'writer'>;
  /** ev 模糊匹配后被程序替换的记录（extractor 质量统计用） */
  evRepaired: { index: number; op: string; from: string; to: string }[];
}

/** entity.update.from 只比较这些 id/枚举字段（§6.6） */
const FROM_KEYS = new Set(['loc', 'owner', 'status', 'title', 'realm']);
const COND_KEYS = new Set(['cond', 'conds']);
const EXPAND_FORBIDDEN = new Set(['event', 'fact.assert', 'entity.create', 'obligation.open']);
const RECALL_LIMIT = 20;
const CANDIDATE_LIMIT = 5;

const OP_FAMILY: Record<string, string> = {
  'knowledge.learn': 'reveal',
  'reader.reveal': 'reveal',
  'identity.reveal': 'reveal',
  'entity.retire': 'death',
  'item.transfer': 'transfer',
  'power.change': 'breakthrough',
};
const PREDICATE_FAMILY: Record<string, string> = { knows: 'reveal', knows_not: 'reveal', dead: 'death' };

const isTmp = (s: string): boolean => s.startsWith('tmp:');
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const opEv = (op: DeltaOp): string | undefined => (typeof (op as { ev?: unknown }).ev === 'string' ? (op as { ev: string }).ev : undefined);

function splitSentences(text: string): string[] {
  return (text.match(/[^。！？!?\n]+[。！？!?…”」』]*/gu) ?? []).map((s) => s.trim()).filter(Boolean);
}

const SENTENCE_BREAK = new Set(['。', '！', '？', '!', '?', '\n']);

/** 包含 [start,end) 的整句 */
function sentenceAround(text: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && !SENTENCE_BREAK.has(text[from - 1] as string)) from--;
  let to = end;
  while (to < text.length && !SENTENCE_BREAK.has(text[to] as string)) to++;
  return text.slice(from, Math.min(text.length, to + 1)).trim();
}

function timeCompare(a: StoryTime, b: StoryTime): number {
  if (a.calendar && b.calendar && a.calendar !== b.calendar) return 0;
  for (const k of ['year', 'day', 'hour'] as const) {
    const x = a[k];
    const y = b[k];
    if (x === undefined || y === undefined) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

class Findings {
  readonly hard: Finding[] = [];
  readonly soft: Finding[] = [];
  readonly attribution: Record<string, 'extractor' | 'writer'> = {};
  private counters = new Map<string, number>();

  add(severity: 'hard' | 'soft', category: string, message: string, who: 'extractor' | 'writer', quote?: string): void {
    const n = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, n);
    const id = `${category}#${n}`;
    const f = finding(id, severity, category, message, { quote });
    if (severity === 'hard') {
      this.hard.push(f);
      this.attribution[id] = who;
    } else this.soft.push(f);
  }
}

/** 在系统的 ranks 里定位境界（取最长匹配的 rank 文本，兼容“练气九层”） */
function rankIndex(world: WorldRules | null, system: string, value: string | undefined): number | null {
  if (!value) return null;
  const sys = world?.systems.find((s) => s.id === system || s.name === system);
  if (!sys) return null;
  let best = -1;
  let bestLen = 0;
  sys.ranks.forEach((rank, i) => {
    if (rank.length > bestLen && value.includes(rank)) {
      best = i;
      bestLen = rank.length;
    }
  });
  return best >= 0 ? best : null;
}

function evidencePass(delta: Delta, matcher: EvidenceMatcher, f: Findings) {
  const dropped: DeltaCheckReport['dropped'] = [];
  const reextract: DeltaCheckReport['reextract'] = [];
  const evRepaired: DeltaCheckReport['evRepaired'] = [];
  const remap: (number | null)[] = [];
  const kept: DeltaOp[] = [];
  delta.ops.forEach((op, index) => {
    if (op.op === 'contract.amend') {
      remap.push(null);
      dropped.push({ index, op: op.op, reason: 'contract.amend 只能由 planner 提议' });
      f.add('soft', 'op.contract_amend', 'extractor 输出了 contract.amend，已丢弃', 'extractor');
      return;
    }
    const ev = opEv(op);
    if (ev !== undefined) {
      const m = matcher.match(ev);
      if (m.kind === 'none') {
        const reason = `ev 不在草稿中：${ev.slice(0, 40)}`;
        if (KEY_OP_TYPES.includes(op.op)) {
          reextract.push({ index, op: op.op, reason });
        } else {
          remap.push(null);
          dropped.push({ index, op: op.op, reason });
          return;
        }
      } else if (m.kind === 'fuzzy' && m.replacement) {
        evRepaired.push({ index, op: op.op, from: ev, to: m.replacement });
        (op as { ev?: string }).ev = m.replacement;
      }
    }
    remap.push(kept.length);
    kept.push(op);
  });
  delta.ops = kept;
  const origIndex: number[] = [];
  remap.forEach((to, from) => {
    if (to !== null) origIndex[to] = from;
  });

  delta.uses_knowledge = delta.uses_knowledge.flatMap((u) => {
    const m = matcher.match(u.ev);
    if (m.kind === 'none') {
      f.add('soft', 'ev.uses_knowledge', `uses_knowledge 引文不在草稿中，已丢弃：${u.ev.slice(0, 40)}`, 'extractor');
      return [];
    }
    return [m.kind === 'fuzzy' && m.replacement ? { ...u, ev: m.replacement } : u];
  });
  delta.beats_realized = delta.beats_realized.flatMap((b) => {
    const m = matcher.match(b.ev);
    if (m.kind === 'none') return [];
    return [m.kind === 'fuzzy' && m.replacement ? { ...b, ev: m.replacement } : b];
  });

  delta.summary = delta.summary.map((sentence) => ({
    ...sentence,
    anchors: sentence.anchors.flatMap((a) => {
      const opRef = /^op:(\d+)$/.exec(a);
      if (opRef) {
        const to = remap[Number(opRef[1])];
        return to === null || to === undefined ? [] : [`op:${to}`];
      }
      if (a.startsWith('ev:')) {
        const m = matcher.match(a.slice(3));
        if (m.kind === 'none') return [];
        return [m.kind === 'fuzzy' && m.replacement ? `ev:${m.replacement}` : a];
      }
      return [a];
    }),
  }));
  return { dropped, reextract, evRepaired, origIndex };
}

interface OpState {
  ents: Map<string, EntityState>;
  created: Set<string>;
  holders: Map<string, string | null>;
  obligations: Map<string, 'open' | 'advanced' | 'paid' | 'abandoned'>;
  time: StoryTime | undefined;
}

function checkOps(input: DeltaCheckInput, delta: Delta, f: Findings, reextract: DeltaCheckReport['reextract'], origIndex: number[]): void {
  const { before, card, world, overrides } = input;
  const chapter = delta.chapter;
  const flashback = delta.ops.some((o) => o.op === 'time.advance' && o.flashback);
  const timeMoved = delta.ops.some((o) => o.op === 'time.advance' && !o.flashback);
  const offscreenEnts = new Set(delta.ops.flatMap((o) => (o.op === 'offscreen.update' ? [o.ent] : [])));
  const vocab = world && world.vocab.conditions.length > 0 ? new Set([...world.vocab.conditions, ...world.vocab.proposals].map((c) => c.id)) : null;
  const knownIds = new Set(input.aliases.names().values());
  const st: OpState = {
    ents: new Map(),
    created: new Set(),
    holders: new Map(),
    obligations: new Map(),
    time: before.time ? { ...before.time } : undefined,
  };
  const covered = (ent: string, field: string): boolean =>
    overrides.some((o) => o.target.kind === 'entity' && o.target.ent === ent && o.target.field === field && o.effective_from <= chapter);
  const overriddenFact = (fact: string): boolean =>
    !!before.facts[fact]?.overridden || overrides.some((o) => o.target.kind === 'fact' && o.target.fact === fact && o.effective_from <= chapter);
  const ent = (id: string): EntityState | undefined => {
    let e = st.ents.get(id);
    if (!e && before.entities[id]) {
      e = structuredClone(before.entities[id]);
      st.ents.set(id, e);
    }
    return e;
  };
  const known = (id: string): boolean => st.created.has(id) || (!isTmp(id) && (!!before.entities[id] || knownIds.has(id)));
  const requireKnown = (id: string, where: string): boolean => {
    if (known(id)) return true;
    f.add('hard', 'ref.unknown_entity', `${where} 引用了不存在的实体 ${id}`, 'extractor');
    return false;
  };
  const obligationStatus = (id: string) => st.obligations.get(id) ?? before.obligations[id]?.status;
  const assertPresent = (id: string, where: string, quote?: string): void => {
    const e = ent(id);
    if (!e) return;
    if (!e.alive) {
      if (!covered(id, 'alive')) f.add(flashback ? 'soft' : 'hard', 'dead.acts', `${e.name} 已死亡，却在 ${where} 中行动`, 'writer', quote);
    } else if (e.retired && !card.entities_present.includes(id)) {
      f.add('soft', 'retired.returns', `${e.name} 已退场（${e.retired}），却在 ${where} 中出现`, 'writer', quote);
    }
  };
  const checkVocab = (id: string, conds: string[], opIndex: number): void => {
    if (!vocab) return;
    for (const c of conds) {
      if (vocab.has(c)) continue;
      f.add('soft', 'vocab.unknown', `${id} 的条件 ${c} 不在受控词表中`, 'extractor');
      reextract.push({ index: origIndex[opIndex] ?? opIndex, op: 'entity.update', reason: `条件 ${c} 不在受控词表（world.vocab）中` });
    }
  };
  const unplanned = (category: string, message: string, hardAllowed: boolean, quote?: string): void => {
    f.add(input.unplannedInvention === 'strict' && hardAllowed ? 'hard' : 'soft', category, message, 'writer', quote);
  };

  delta.ops.forEach((op, index) => {
    const quote = opEv(op);
    if (input.expandOnly && EXPAND_FORBIDDEN.has(op.op)) f.add('hard', 'expand.new_op', `expand 不得新增 ${op.op}`, 'writer', quote);
    switch (op.op) {
      case 'entity.create': {
        if (before.entities[op.ent]) f.add('hard', 'entity.duplicate', `实体 ${op.ent} 已存在，不能再次 create`, 'extractor', quote);
        else if (input.aliases.names().has(op.name)) f.add('soft', 'entity.duplicate_name', `新实体 ${op.name} 与已有实体同名`, 'extractor', quote);
        st.created.add(op.ent);
        const planned =
          card.entities_present.includes(op.ent) ||
          card.post.some((c) => isOpPattern(c) && c.op === 'entity.create' && (c.ent === op.ent || (typeof c.name === 'string' && c.name === op.name)));
        if (!planned) unplanned('invention.entity', `卡片没有计划的新实体：${op.name}`, op.tier !== 'extra', quote);
        const fresh: EntityState = { id: op.ent, kind: op.kind, name: op.name, alive: true, attrs: {}, conds: [], power: {} };
        if (op.set) {
          checkVocab(op.ent, [...asStrings(op.set['cond+']), ...asStrings(op.set.conds), ...asStrings(op.set.cond)], index);
          applySet(fresh, op.set);
        }
        st.ents.set(op.ent, fresh);
        return;
      }
      case 'entity.update': {
        if (!requireKnown(op.ent, 'entity.update')) return;
        const e = ent(op.ent);
        if (e && op.from) {
          for (const [key, want] of Object.entries(op.from)) {
            if (FROM_KEYS.has(key)) {
              const have = e.attrs[key] ?? null;
              if (have !== null && !sameJson(have, want) && !covered(op.ent, key)) {
                f.add('hard', 'entity.from', `${e.name}.${key} 账本为 ${String(have)}，草稿写成 ${String(want)}`, 'writer', quote);
              }
            } else if (COND_KEYS.has(key)) {
              const wantConds = [...new Set(asStrings(want))].sort();
              const haveConds = [...new Set(e.conds)].sort();
              if (!sameJson(wantConds, haveConds) && !covered(op.ent, 'conds')) {
                f.add('hard', 'entity.from', `${e.name} 的条件账本为 [${haveConds.join(', ')}]，from 写成 [${wantConds.join(', ')}]`, 'writer', quote);
              }
            }
          }
        }
        checkVocab(op.ent, [...asStrings(op.set['cond+']), ...asStrings(op.set['cond-']), ...asStrings(op.set.conds), ...asStrings(op.set.cond)], index);
        if (e) {
          for (const c of asStrings(op.set['cond-'])) {
            if (!e.conds.includes(c)) f.add('soft', 'cond.remove_absent', `${e.name} 没有条件 ${c}`, 'extractor', quote);
          }
          if (op.set.alive === true && !e.alive && !covered(op.ent, 'alive')) f.add('hard', 'dead.resurrected', `${e.name} 已死亡，不能复活`, 'writer', quote);
          applySet(e, op.set);
        }
        return;
      }
      case 'entity.retire': {
        if (!requireKnown(op.ent, 'entity.retire')) return;
        const e = ent(op.ent);
        if (!e) return;
        if (e.retired) f.add('hard', 'retire.duplicate', `${e.name} 已退场，不能再次 retire`, 'extractor', quote);
        e.retired = op.how;
        if (op.how === 'death' || op.how === 'destroyed') e.alive = false;
        return;
      }
      case 'event': {
        for (const w of op.who) {
          if (!requireKnown(w, 'event.who')) continue;
          assertPresent(w, `事件「${op.what}」`, quote);
          if (op.loc) {
            const cur = ent(w)?.attrs.loc;
            if (typeof cur === 'string' && cur !== op.loc && !cur.startsWith(`${op.loc}-`) && !op.loc.startsWith(`${cur}-`) && !timeMoved && !offscreenEnts.has(w)) {
              f.add('soft', 'location.jump', `${w} 账本位置 ${cur}，事件发生在 ${op.loc}，且本章无时间推进或 offscreen.update`, 'writer', quote);
            }
          }
        }
        return;
      }
      case 'fact.assert': {
        if (overriddenFact(op.fact)) f.add('soft', 'fact.overridden', `引用了已被 override 的事实 ${op.fact}`, 'writer', quote);
        return;
      }
      case 'knowledge.learn': {
        if (!requireKnown(op.who, 'knowledge.learn')) return;
        assertPresent(op.who, 'knowledge.learn', quote);
        if (overriddenFact(op.fact)) f.add('soft', 'fact.overridden', `引用了已被 override 的事实 ${op.fact}`, 'writer', quote);
        if (before.knowledge[op.who]?.includes(op.fact)) f.add('soft', 'knowledge.already', `${op.who} 已经知道 ${op.fact}`, 'extractor', quote);
        const asserted = delta.ops.some((o) => o.op === 'fact.assert' && o.fact === op.fact);
        if (!before.facts[op.fact] && !asserted && !isTmp(op.fact) && !input.secrets.some((s) => s.fact === op.fact)) {
          f.add('soft', 'fact.unknown', `事实 ${op.fact} 不在账本或秘密中`, 'extractor', quote);
        }
        return;
      }
      case 'reader.reveal': {
        if (overriddenFact(op.fact)) f.add('soft', 'fact.overridden', `引用了已被 override 的事实 ${op.fact}`, 'writer', quote);
        return;
      }
      case 'identity.reveal': {
        requireKnown(op.ent, 'identity.reveal');
        if (op.to !== 'reader') requireKnown(op.to, 'identity.reveal.to');
        return;
      }
      case 'obligation.open': {
        const status = obligationStatus(op.id);
        if (status !== undefined) f.add('hard', 'obligation.duplicate_open', `伏笔 ${op.id} 已存在（${status}），不能再次 open`, 'extractor', quote);
        st.obligations.set(op.id, 'open');
        const name = isTmp(op.id) ? op.id.slice(4) : op.id;
        const planned =
          card.may_open.some((m) => m === '*' || m === op.id || m === name || m === op.kind || m === op.weight) ||
          card.post.some((c) => isOpPattern(c) && c.op === 'obligation.open' && c.id === op.id);
        if (!planned) unplanned('obligation.unplanned_open', `卡片 may_open 之外的新伏笔：${op.text}`, true, quote);
        return;
      }
      case 'obligation.advance':
      case 'obligation.pay':
      case 'obligation.abandon': {
        const status = obligationStatus(op.id);
        if (status === undefined) {
          f.add('hard', 'obligation.unknown', `伏笔 ${op.id} 不存在`, 'extractor', quote);
          return;
        }
        if (status === 'paid' || status === 'abandoned') {
          f.add('hard', 'obligation.closed', `伏笔 ${op.id} 已收束（${status}），不能 ${op.op}`, 'writer', quote);
          return;
        }
        const plan = before.obligations[op.id];
        if (op.op === 'obligation.pay') {
          st.obligations.set(op.id, 'paid');
          if (plan?.due && chapter < plan.due[0]) f.add('soft', 'obligation.early_pay', `伏笔 ${op.id} 早于窗口 ${plan.due[0]} 回收`, 'writer', quote);
          const planned = card.pays.includes(op.id) || card.post.some((c) => isOpPattern(c) && c.op === 'obligation.pay' && c.id === op.id);
          if (!planned) f.add('soft', 'obligation.unplanned_pay', `卡片没有计划回收伏笔 ${op.id}`, 'writer', quote);
        } else if (op.op === 'obligation.abandon') {
          st.obligations.set(op.id, 'abandoned');
          if (plan?.weight === 'main') f.add('hard', 'obligation.abandon_main', `main 级伏笔 ${op.id} 的 abandon 需要 owner 批准`, 'writer', quote);
        } else st.obligations.set(op.id, 'advanced');
        return;
      }
      case 'arc.stage': {
        if (requireKnown(op.who, 'arc.stage')) assertPresent(op.who, 'arc.stage', quote);
        return;
      }
      case 'arc.resolve': {
        if (op.arc !== card.arc) f.add('soft', 'arc.foreign_resolve', `本章属于 ${card.arc}，却收束了 ${op.arc}`, 'writer', quote);
        return;
      }
      case 'offscreen.update': {
        if (!requireKnown(op.ent, 'offscreen.update')) return;
        const declared = op.declared_by_card && card.offscreen.some((o) => o.ent === op.ent);
        if (!declared) unplanned('offscreen.undeclared', `卡片没有声明 ${op.ent} 的 offscreen 变化`, false);
        const e = ent(op.ent);
        if (e) applySet(e, op.set);
        return;
      }
      case 'time.advance': {
        if (op.flashback) return;
        if (st.time && timeCompare(op.to, st.time) < 0) f.add('hard', 'time.regress', '故事时间倒退（非闪回）', 'writer', quote);
        st.time = { ...(st.time ?? {}), ...op.to };
        return;
      }
      case 'power.change': {
        if (!requireKnown(op.who, 'power.change')) return;
        assertPresent(op.who, 'power.change', quote);
        const e = ent(op.who);
        if (!e) return;
        const cur = e.power[op.system];
        if (op.from !== undefined && cur !== undefined && op.from !== cur && !covered(op.who, `power.${op.system}`)) {
          f.add('hard', 'power.from', `${e.name} 的 ${op.system} 账本为 ${cur}，from 写成 ${op.from}`, 'writer', quote);
        }
        const prev = rankIndex(world, op.system, cur ?? op.from);
        const next = rankIndex(world, op.system, op.to);
        const plannedDrop = card.post.some((c) => isOpPattern(c) && c.op === 'power.change' && c.who === op.who);
        if (prev !== null && next !== null && next < prev && !plannedDrop && !covered(op.who, `power.${op.system}`)) {
          f.add('hard', 'power.regress', `${e.name} 的 ${op.system} 从 ${cur ?? op.from} 倒退到 ${op.to}`, 'writer', quote);
        }
        if (input.powerRange && next !== null) {
          const low = rankIndex(world, op.system, input.powerRange[0]);
          const high = rankIndex(world, op.system, input.powerRange[1]);
          if ((low !== null && next < low) || (high !== null && next > high)) {
            f.add('soft', 'power.range', `${e.name} 的 ${op.to} 超出本卷 power_range`, 'writer', quote);
          }
        }
        e.power[op.system] = op.to;
        return;
      }
      case 'item.transfer': {
        if (!requireKnown(op.item, 'item.transfer')) return;
        const holder = st.holders.has(op.item) ? st.holders.get(op.item) : before.items[op.item]?.holder;
        if (op.from !== undefined && holder !== undefined && holder !== null && op.from !== holder) {
          f.add('hard', 'item.holder', `${op.item} 的持有者账本为 ${holder}，from 写成 ${String(op.from)}`, 'writer', quote);
        }
        if (op.to && op.to === holder) f.add('soft', 'item.same_holder', `${op.item} 已在 ${op.to} 手中`, 'extractor', quote);
        const item = ent(op.item);
        if (item && (item.retired === 'destroyed' || !item.alive)) f.add('hard', 'item.destroyed', `${item.name} 已损毁，不能转移`, 'writer', quote);
        if (op.to) {
          requireKnown(op.to, 'item.transfer.to');
          assertPresent(op.to, 'item.transfer', quote);
        }
        st.holders.set(op.item, op.to ?? null);
        return;
      }
      case 'relation.set': {
        requireKnown(op.a, 'relation.set');
        requireKnown(op.b, 'relation.set');
        return;
      }
      case 'contract.amend':
        return;
    }
  });

  for (const id of delta.entities_present) {
    const e = before.entities[id];
    const retiredHere = delta.ops.some((o) => o.op === 'entity.retire' && o.ent === id);
    if (e && !e.alive && !retiredHere && !covered(id, 'alive')) {
      f.add(flashback ? 'soft' : 'hard', 'dead.present', `${e.name} 已死亡，却出现在 entities_present`, 'writer');
    }
  }
  for (const u of delta.uses_knowledge) {
    if (overriddenFact(u.fact)) f.add('soft', 'fact.overridden', `uses_knowledge 引用了已被 override 的事实 ${u.fact}`, 'writer', u.ev);
    const learned = delta.ops.some((o) => (o.op === 'knowledge.learn' && o.who === u.who && o.fact === u.fact) || (o.op === 'identity.reveal' && o.to === u.who));
    if (!isTmp(u.fact) && !before.knowledge[u.who]?.includes(u.fact) && !learned) {
      f.add('hard', 'knowledge.unearned', `${u.who} 使用了尚未得知的事实 ${u.fact}`, 'writer', u.ev);
    }
  }
}

function candidateSentences(cond: unknown, sentences: string[], input: DeltaCheckInput): string[] {
  const refs = conditionRefs(cond);
  const names = refs.entities.flatMap((id) => input.aliases.aliasesOf?.(id) ?? []);
  const key = isOpPattern(cond) ? OP_FAMILY[cond.op] : Object.keys(cond as object).map((k) => PREDICATE_FAMILY[k]).find(Boolean);
  const words = key ? (input.eventFamilies[key] ?? []) : [];
  if (names.length === 0 && words.length === 0) return [];
  const hits = sentences.filter((s) => (names.length === 0 || names.some((n) => s.includes(n))) && (words.length === 0 || words.some((w) => s.includes(w))));
  return hits.slice(0, CANDIDATE_LIMIT);
}

function checkCard(input: DeltaCheckInput, delta: Delta, sentences: string[], f: Findings) {
  const { before, card } = input;
  const applyOpts = input.entities ? { entities: input.entities } : {};
  const after = applyDelta(before, delta, applyOpts);
  const report = evaluateCard(card, before, delta, after);
  const unmetPost: DeltaCheckReport['unmetPost'] = [];
  const mustNotHits: DeltaCheckReport['mustNotHits'] = [];
  const seenPost = new Set<string>();

  for (const p of report.pre) {
    if (p.value === false) f.add('hard', 'card.pre', `卡片 pre 不成立：${canonicalJson(p.cond)}`, 'writer');
    else if (p.value === 'unresolved') f.add('soft', 'card.pre_unresolved', `卡片 pre 无法解析：${canonicalJson(p.cond)}`, 'extractor');
  }
  const pushUnmet = (cond: unknown): void => {
    const key = canonicalJson(cond);
    if (seenPost.has(key)) return;
    seenPost.add(key);
    unmetPost.push({ cond, candidates: candidateSentences(cond, sentences, input) });
  };
  const hasTmp = (cond: unknown): boolean => {
    const r = conditionRefs(cond);
    return [...r.entities, ...r.facts, ...r.obligations].some(isTmp);
  };
  // diff 抽取只含变化部分，不能用它证明 post 缺失（§6.5 expand 的 diff）
  if (delta.mode !== 'diff') {
    for (const p of report.post) {
      if (p.value === 'manual') f.add('soft', 'card.post_manual', `卡片 post 需要人工核对：${canonicalJson(p.cond)}`, 'writer');
      else if (p.value === 'unresolved') {
        if (!hasTmp(p.cond)) pushUnmet(p.cond);
      } else if (p.value === false || p.value === 'unmet') pushUnmet(p.cond);
    }
    for (const id of card.pays) {
      const cond = { op: 'obligation.pay', id };
      if (!delta.ops.some((o) => opMatches(cond, o)) && after.obligations[id]?.status !== 'paid') pushUnmet(cond);
    }
    for (const id of card.advances) {
      const cond = { op: 'obligation.advance', id };
      if (!delta.ops.some((o) => opMatches(cond, o))) pushUnmet(cond);
    }
  }
  for (const m of report.mustNot) {
    if (!m.violated) continue;
    const cond = m.cond;
    if (isOpPattern(cond)) {
      const op = delta.ops.find((o) => opMatches(cond, o));
      const quote = op ? opEv(op) : undefined;
      mustNotHits.push(quote === undefined ? { cond } : { cond, quote });
      f.add('hard', 'must_not', `违反 must_not：${canonicalJson(cond)}`, 'writer', quote);
    } else if (evaluatePredicate(cond as Predicate, before) === true) {
      f.add('soft', 'must_not.preexisting', `must_not 在写前已经成立（卡片已过期）：${canonicalJson(cond)}`, 'writer');
    } else {
      mustNotHits.push({ cond });
      f.add('hard', 'must_not', `违反 must_not：${canonicalJson(cond)}`, 'writer');
    }
  }
  return { unmetPost, mustNotHits };
}

function checkLeaks(input: DeltaCheckInput, body: string, f: Findings): DeltaCheckReport['leaks'] {
  const leaks: DeltaCheckReport['leaks'] = [];
  const { before, card } = input;
  for (const secret of input.secrets) {
    if (secret.fact && before.reader_knows.includes(secret.fact)) continue;
    if (secret.reveal_plan.some((p) => p.to === 'reader' && p.at !== undefined && p.at <= card.id)) continue;
    for (const signature of secret.leak_signatures) {
      const re = compileRegex(signature, 'u');
      if (!re) {
        f.add('soft', 'secret.bad_signature', `秘密 ${secret.id} 的泄漏签名不是合法正则：${signature}`, 'extractor');
        continue;
      }
      const m = re.exec(body);
      if (m) {
        leaks.push({ secret: secret.id, signature, quote: m[0] });
        f.add('hard', 'leak', `命中秘密 ${secret.id} 的泄漏签名`, 'writer', m[0]);
      }
    }
  }
  return leaks;
}

function recallProbe(input: DeltaCheckInput, delta: Delta, body: string): DeltaCheckReport['recallMisses'] {
  const { aliases, card, eventFamilies } = input;
  const mentions = aliases.resolve(aliases.scan(body), body, card.entities_present, card.pov ? { pov: card.pov } : {});
  const present = new Set(delta.entities_present);
  const touched = new Set<string>();
  for (const op of delta.ops) {
    const rec = op as unknown as Record<string, unknown>;
    for (const k of ['ent', 'who', 'item', 'from', 'to', 'a', 'b', 'loc']) {
      for (const v of asStrings(rec[k])) touched.add(v);
    }
  }
  const misses: DeltaCheckReport['recallMisses'] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    if (present.has(m.entity) || touched.has(m.entity)) continue;
    const sentence = sentenceAround(body, m.start, m.end);
    for (const [family, words] of Object.entries(eventFamilies)) {
      if (!words.some((w) => sentence.includes(w))) continue;
      const key = `${m.entity}:${family}`;
      if (seen.has(key)) continue;
      seen.add(key);
      misses.push({ entity: m.entity, family, quote: sentence });
      if (misses.length >= RECALL_LIMIT) return misses;
    }
  }
  return misses;
}

function verifyFlags(input: DeltaCheckInput, matcher: EvidenceMatcher): ContinuityFlag[] {
  const { before } = input;
  return (input.continuityFlags ?? []).filter((flag) => {
    if (matcher.match(flag.quote).kind === 'none') return false;
    switch (flag.kind) {
      case 'dead_reappears':
        return flag.ents.some((id) => before.entities[id] && !before.entities[id]?.alive);
      case 'item_conflict':
        return flag.ents.some((id) => id in before.items);
      default:
        return true;
    }
  });
}

export function deltaCheck(input: DeltaCheckInput): DeltaCheckReport {
  const delta: Delta = structuredClone(input.delta);
  const matcher = createEvidenceMatcher(input.draft);
  const f = new Findings();
  const { dropped, reextract, evRepaired, origIndex } = evidencePass(delta, matcher, f);
  checkOps(input, delta, f, reextract, origIndex);
  const body = stripBeatMarkers(input.draft);
  const sentences = splitSentences(body);
  const { unmetPost, mustNotHits } = checkCard(input, delta, sentences, f);
  const leaks = checkLeaks(input, body, f);
  const recallMisses = delta.mode === 'diff' ? [] : recallProbe(input, delta, body);
  const confirmedFlags = verifyFlags(input, matcher);
  const anchors = checkSummaryAnchors(delta);
  if (!anchors.ok) f.add('soft', 'summary.unanchored', `摘要无锚点句子占比 ${anchors.ratio.toFixed(2)}`, 'extractor');
  return {
    ok: f.hard.length === 0 && reextract.length === 0 && unmetPost.length === 0 && recallMisses.length === 0 && confirmedFlags.length === 0,
    delta,
    hard: f.hard,
    soft: f.soft,
    dropped,
    reextract,
    recallMisses,
    unmetPost,
    mustNotHits,
    leaks,
    confirmedFlags,
    attribution: f.attribution,
    evRepaired,
  };
}

const validAnchor = (a: string, ops: number): boolean => {
  const m = /^op:(\d+)$/.exec(a);
  if (m) return Number(m[1]) < ops;
  return a.startsWith('ev:') && a.length > 3;
};

/** 摘要锚点校验：无锚点句子占比 >30% 拒收（§6.3） */
export function checkSummaryAnchors(delta: Delta, maxUnanchored = 0.3): { ok: boolean; ratio: number } {
  if (delta.summary.length === 0) return { ok: true, ratio: 0 };
  const unanchored = delta.summary.filter((s) => !s.anchors.some((a) => validAnchor(a, delta.ops.length))).length;
  const ratio = unanchored / delta.summary.length;
  return { ok: ratio <= maxUnanchored, ratio };
}

function originalOps(original: unknown): unknown[] {
  if (typeof original === 'string') {
    try {
      return originalOps(JSON.parse(original));
    } catch {
      return [];
    }
  }
  if (Array.isArray(original)) return original;
  if (original && typeof original === 'object') {
    const o = original as Record<string, unknown>;
    if (Array.isArray(o.ops)) return o.ops;
    if (o.delta) return originalOps(o.delta);
  }
  return [];
}

const stringLeaves = (v: unknown): string[] => {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringLeaves);
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringLeaves);
  return [];
};

/** format.repair 的确定性验证：修复后 op 集合 ⊆ 原输出（或等价改写），ev 逐字出现在草稿 */
export function verifyFormatRepair(original: unknown, repaired: Delta, draft: string): { ok: boolean; reason?: string } {
  const rawText = typeof original === 'string' ? original : JSON.stringify(original ?? null);
  const parsedOps = originalOps(original);
  const opCount = parsedOps.length > 0 ? parsedOps.length : (rawText.match(/"op"\s*:/g)?.length ?? 0);
  if (repaired.ops.length > opCount) return { ok: false, reason: `修复后 op 数 ${repaired.ops.length} 超过原输出 ${opCount}` };
  const haystack = normalizeForMatch(rawText);
  const matcher = createEvidenceMatcher(draft);
  for (let i = 0; i < repaired.ops.length; i++) {
    const op = repaired.ops[i] as DeltaOp;
    const { ev, ...rest } = op as DeltaOp & { ev?: string };
    if (ev !== undefined && matcher.match(ev, { fuzzyThreshold: 1.01 }).kind !== 'exact') {
      return { ok: false, reason: `op#${i} 的 ev 未逐字出现在草稿中` };
    }
    for (const leaf of stringLeaves(rest)) {
      if (leaf && !haystack.includes(normalizeForMatch(leaf))) {
        return { ok: false, reason: `op#${i} 含原输出没有的内容：${leaf.slice(0, 40)}` };
      }
    }
  }
  return { ok: true };
}
