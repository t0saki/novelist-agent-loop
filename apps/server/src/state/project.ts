/** 投影 snapshot（DESIGN §6.2）：snapshot + 缓冲卡 post 依次叠加；每章验收后校验全部缓冲卡 pre/must_not。Owner: lane B。 */
import type { Card, Delta, DeltaOp, OpPattern, Predicate, Snapshot } from '@novelist/shared';
import { cloneJson } from './canon.js';
import { type ApplyOptions, applyDelta, applySet, rehashSnapshot } from './fold.js';
import { evaluatePredicate, isOpPattern, opMatches } from './predicate.js';

export interface ProjectionResult {
  /** 每张缓冲卡写前的投影状态 */
  before: { card: string; snapshot: Snapshot }[];
  /** pre 不成立或 must_not 冲突的卡 → card.repair */
  stale: { card: string; reasons: string[] }[];
}

const PROJECTED_EV = '（投影）';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** 把卡片 post 中的 op 模式补全为可应用的 op（缺少关键字段时返回 null） */
export function opFromPattern(p: OpPattern, chapter: string, idx: number): DeltaOp | null {
  const r = p as Record<string, unknown>;
  const ev = PROJECTED_EV;
  switch (p.op) {
    case 'entity.create': {
      const ent = str(r.ent);
      const kind = str(r.kind);
      if (!ent || !kind) return null;
      return {
        op: 'entity.create',
        ent,
        kind: kind as 'character',
        name: str(r.name) ?? ent,
        aliases: [],
        declared: true,
        ...(r.set ? { set: r.set as Record<string, unknown> } : {}),
        ev,
      };
    }
    case 'entity.update': {
      const ent = str(r.ent);
      if (!ent || !r.set || typeof r.set !== 'object') return null;
      return { op: 'entity.update', ent, set: r.set as Record<string, unknown>, ev };
    }
    case 'entity.retire': {
      const ent = str(r.ent);
      if (!ent) return null;
      return { op: 'entity.retire', ent, how: (str(r.how) ?? 'other') as 'other', ev };
    }
    case 'event':
      return {
        op: 'event',
        id: str(r.id) ?? `proj.${chapter}.${idx}`,
        who: Array.isArray(r.who) ? (r.who as string[]) : [],
        what: str(r.what) ?? '（计划事件）',
        ev,
      };
    case 'fact.assert': {
      const fact = str(r.fact);
      if (!fact) return null;
      return { op: 'fact.assert', fact, text: str(r.text) ?? fact, about: [], ev };
    }
    case 'knowledge.learn': {
      const who = str(r.who);
      const fact = str(r.fact);
      if (!who || !fact) return null;
      return { op: 'knowledge.learn', who, fact, ev };
    }
    case 'reader.reveal': {
      const fact = str(r.fact);
      if (!fact) return null;
      return { op: 'reader.reveal', fact, ev };
    }
    case 'identity.reveal': {
      const ent = str(r.ent);
      const identity = str(r.identity);
      if (!ent || !identity) return null;
      return { op: 'identity.reveal', ent, identity, to: str(r.to) ?? 'reader', ev };
    }
    case 'obligation.open': {
      const id = str(r.id);
      if (!id) return null;
      return {
        op: 'obligation.open',
        id,
        kind: (str(r.kind) ?? 'foreshadow') as 'foreshadow',
        weight: (str(r.weight) ?? 'minor') as 'minor',
        text: str(r.text) ?? id,
        ...(Array.isArray(r.due) && r.due.length === 2 ? { due: [String(r.due[0]), String(r.due[1])] as [string, string] } : {}),
        ev,
      };
    }
    case 'obligation.advance':
    case 'obligation.pay': {
      const id = str(r.id);
      if (!id) return null;
      return { op: p.op, id, ev } as DeltaOp;
    }
    case 'obligation.abandon': {
      const id = str(r.id);
      if (!id) return null;
      return { op: 'obligation.abandon', id, reason: str(r.reason) ?? '（计划）' };
    }
    case 'arc.stage': {
      const who = str(r.who);
      const stage = str(r.stage);
      if (!who || !stage) return null;
      return { op: 'arc.stage', who, stage, ev };
    }
    case 'arc.resolve': {
      const arc = str(r.arc);
      if (!arc) return null;
      return { op: 'arc.resolve', arc, ev };
    }
    case 'power.change': {
      const who = str(r.who);
      const system = str(r.system);
      const to = str(r.to);
      if (!who || !system || !to) return null;
      return { op: 'power.change', who, system, to, ev };
    }
    case 'item.transfer': {
      const item = str(r.item);
      if (!item || !('to' in r)) return null;
      return { op: 'item.transfer', item, to: (r.to as string | null) ?? null, ev };
    }
    case 'relation.set': {
      const a = str(r.a);
      const b = str(r.b);
      const type = str(r.type);
      if (!a || !b || !type) return null;
      return { op: 'relation.set', a, b, type, ev };
    }
    case 'time.advance':
      return r.to && typeof r.to === 'object' ? { op: 'time.advance', to: r.to as Record<string, number>, flashback: false } : null;
    default:
      return null;
  }
}

/** 强制使谓词成立（投影用；or 取第一个分支，复杂的 not 忽略） */
function forcePredicate(s: Snapshot, p: Predicate): void {
  const pp = p as Record<string, unknown>;
  if ('and' in pp) {
    for (const x of pp.and as Predicate[]) forcePredicate(s, x);
    return;
  }
  if ('or' in pp) {
    const first = (pp.or as Predicate[])[0];
    if (first && evaluatePredicate(p, s) !== true) forcePredicate(s, first);
    return;
  }
  if ('not' in pp) {
    const inner = pp.not as Record<string, unknown>;
    if ('knows' in inner) forcePredicate(s, { knows_not: inner.knows as [string, string] });
    else if ('alive' in inner) forcePredicate(s, { dead: inner.alive as string });
    else if ('dead' in inner) forcePredicate(s, { alive: inner.dead as string });
    return;
  }
  const ent = (id: string) => s.entities[id];
  if ('eq' in pp) {
    const [ref, v] = pp.eq as [{ attr: [string, string] }, unknown];
    const e = ent(ref.attr[0]);
    if (e) applySet(e, { [ref.attr[1]]: v });
  } else if ('knows' in pp) {
    const [who, fact] = pp.knows as [string, string];
    s.knowledge[who] = [...new Set([...(s.knowledge[who] ?? []), fact])].sort();
  } else if ('knows_not' in pp) {
    const [who, fact] = pp.knows_not as [string, string];
    if (s.knowledge[who]) s.knowledge[who] = (s.knowledge[who] ?? []).filter((f) => f !== fact);
  } else if ('obligation' in pp) {
    const o = s.obligations[pp.obligation as string];
    if (o) o.status = pp.status as typeof o.status;
  } else if ('stage' in pp) {
    const [id, st] = pp.stage as [string, string];
    const e = ent(id);
    if (e) e.stage = st;
  } else if ('at_loc' in pp) {
    const [id, loc] = pp.at_loc as [string, string];
    const e = ent(id);
    if (e) e.attrs.loc = loc;
  } else if ('alive' in pp) {
    const e = ent(pp.alive as string);
    if (e) e.alive = true;
  } else if ('dead' in pp) {
    const e = ent(pp.dead as string);
    if (e) {
      e.alive = false;
      e.retired = 'death';
    }
  } else if ('has_cond' in pp) {
    const [id, c] = pp.has_cond as [string, string];
    const e = ent(id);
    if (e) e.conds = [...new Set([...e.conds, c])].sort();
  }
}

/** 卡片“计划会发生”的 delta（post 的 op 模式 + offscreen + pays/advances） */
export function plannedDelta(card: Card): Delta {
  const ops: DeltaOp[] = [];
  (card.post ?? []).forEach((c, i) => {
    if (isOpPattern(c)) {
      const op = opFromPattern(c, card.id, i);
      if (op) ops.push(op);
    }
  });
  for (const o of card.offscreen ?? []) ops.push({ op: 'offscreen.update', ent: o.ent, set: o.set, declared_by_card: true });
  for (const id of card.advances ?? []) ops.push({ op: 'obligation.advance', id, ev: PROJECTED_EV });
  for (const id of card.pays ?? []) ops.push({ op: 'obligation.pay', id, ev: PROJECTED_EV });
  return {
    schema: 'nv.delta/1',
    chapter: card.id,
    mode: 'full',
    summary: [],
    beats_realized: [],
    ops,
    uses_knowledge: [],
    realized_patterns: [],
    entities_present: [...(card.entities_present ?? [])],
  };
}

function renderCond(c: unknown): string {
  return JSON.stringify(c);
}

/** 投影一张卡：返回写后状态 */
export function projectCard(s: Snapshot, card: Card, opts: ApplyOptions = {}): Snapshot {
  const after = applyDelta(s, plannedDelta(card), opts);
  const out = cloneJson(after);
  for (const c of card.post ?? []) if (!isOpPattern(c)) forcePredicate(out, c as Predicate);
  return rehashSnapshot(out);
}

/** opts.entities：传实体定义时 identity.reveal 按 known_by_fact 解析（否则落到合成事实，下游 knows 谓词会误判 stale） */
export function projectBuffer(s: Snapshot, bufferCards: Card[], opts: ApplyOptions = {}): ProjectionResult {
  const cards = [...bufferCards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const before: ProjectionResult['before'] = [];
  const stale: ProjectionResult['stale'] = [];
  let cur = s;
  for (const card of cards) {
    before.push({ card: card.id, snapshot: cur });
    const reasons: string[] = [];
    for (const c of card.pre ?? []) {
      if (isOpPattern(c)) continue;
      const v = evaluatePredicate(c as Predicate, cur);
      if (v === false) reasons.push(`pre 不成立：${renderCond(c)}`);
      else if (v === 'unresolved') reasons.push(`pre 引用未解析：${renderCond(c)}`);
    }
    for (const id of [...(card.pays ?? []), ...(card.advances ?? [])]) {
      const o = cur.obligations[id];
      if (!o) reasons.push(`伏笔 ${id} 尚未埋设`);
      else if (o.status === 'paid' || o.status === 'abandoned') reasons.push(`伏笔 ${id} 已${o.status === 'paid' ? '回收' : '放弃'}`);
    }
    const planned = plannedDelta(card);
    const after = projectCard(cur, card, opts);
    for (const m of card.must_not ?? []) {
      if (isOpPattern(m)) {
        if (planned.ops.some((op) => opMatches(m, op))) reasons.push(`must_not 与本卡 post 冲突：${renderCond(m)}`);
      } else if (evaluatePredicate(m as Predicate, after) === true) {
        // 写前已经成立的 must_not 谓词（例如“X 已死”）说明计划与现状冲突
        reasons.push(`must_not 在投影状态下成立：${renderCond(m)}`);
      }
    }
    if (reasons.length) stale.push({ card: card.id, reasons });
    cur = after;
  }
  return { before, stale };
}

/** op 改动的“状态键”（ent:<id>:<字段> / know:<who>:<fact> / reader:<fact> / obl:<id> / item:<id> / rel:<a>|<b>） */
export function touchKeys(op: DeltaOp): string[] {
  switch (op.op) {
    case 'entity.create':
      return [`ent:${op.ent}:*`];
    case 'entity.update':
    case 'offscreen.update':
      return Object.keys(op.set ?? {}).map((k) => `ent:${op.ent}:${k === 'cond+' || k === 'cond-' || k === 'conds' ? 'cond' : k}`);
    case 'entity.retire':
      return [`ent:${op.ent}:*`];
    case 'knowledge.learn':
      return [`know:${op.who}:${op.fact}`];
    case 'reader.reveal':
      return [`reader:${op.fact}`];
    case 'identity.reveal':
      return [`ent:${op.ent}:identity`, op.to === 'reader' ? `reader:ident:${op.ent}` : `know:${op.to}:ident:${op.ent}`];
    case 'fact.assert':
      return [`fact:${op.fact}`];
    case 'obligation.open':
    case 'obligation.advance':
    case 'obligation.pay':
    case 'obligation.abandon':
      return [`obl:${op.id}`];
    case 'arc.stage':
      return [`ent:${op.who}:stage`];
    case 'power.change':
      return [`ent:${op.who}:power.${op.system}`];
    case 'item.transfer':
      return [`item:${op.item}`, `ent:${op.item}:owner`];
    case 'relation.set':
      return [`rel:${[op.a, op.b].sort().join('|')}`];
    default:
      return [];
  }
}

/** 卡片依赖的状态键（pre / must_not / post 谓词与 op 模式、pays/advances、offscreen） */
export function cardDependencyKeys(card: Card): string[] {
  const keys = new Set<string>();
  const fromCond = (c: unknown) => {
    if (isOpPattern(c)) {
      const op = opFromPattern(c, card.id, 0);
      if (op) for (const k of touchKeys(op)) keys.add(k);
      return;
    }
    const visit = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      const o = x as Record<string, unknown>;
      if (Array.isArray(o.and)) for (const y of o.and) visit(y);
      if (Array.isArray(o.or)) for (const y of o.or) visit(y);
      if (o.not) visit(o.not);
      for (const k of ['eq', 'ne', 'in'] as const) {
        const v = o[k] as [{ attr: [string, string] }, unknown] | undefined;
        if (v) keys.add(`ent:${v[0].attr[0]}:${v[0].attr[1]}`);
      }
      for (const k of ['knows', 'knows_not'] as const) {
        const v = o[k] as [string, string] | undefined;
        if (v) keys.add(`know:${v[0]}:${v[1]}`);
      }
      if (typeof o.obligation === 'string') keys.add(`obl:${o.obligation}`);
      if (Array.isArray(o.stage)) keys.add(`ent:${o.stage[0]}:stage`);
      if (Array.isArray(o.at_loc)) keys.add(`ent:${o.at_loc[0]}:loc`);
      if (typeof o.alive === 'string') keys.add(`ent:${o.alive}:alive`);
      if (typeof o.dead === 'string') keys.add(`ent:${o.dead}:alive`);
      if (Array.isArray(o.has_cond)) keys.add(`ent:${o.has_cond[0]}:cond`);
    };
    visit(c);
  };
  for (const c of [...(card.pre ?? []), ...(card.must_not ?? []), ...(card.post ?? [])]) fromCond(c);
  for (const id of [...(card.pays ?? []), ...(card.advances ?? [])]) keys.add(`obl:${id}`);
  for (const o of card.offscreen ?? []) for (const k of Object.keys(o.set ?? {})) keys.add(`ent:${o.ent}:${k}`);
  return [...keys].sort();
}

/**
 * delta 中计划外的 op 触及哪些未来卡涉及的实体或伏笔（标 stale）。
 * 调用方应只传入“计划外”的 op（例如去掉匹配本章卡片 post 的 op）；这里按状态键求交：
 * 实体被创建/退场（`ent:<id>:*`）触及所有依赖该实体任何字段的卡。只看卡片的条件与计划，不看 entities_present（避免主角每章都触发）。
 */
export function cardsTouchedBy(delta: Delta, bufferCards: Card[]): string[] {
  const changed = new Set<string>();
  /** 被创建/退场的实体：任何提到它的依赖键都算触及（含关系、认知） */
  const wildcard = new Set<string>();
  for (const op of delta.ops ?? []) {
    for (const k of touchKeys(op)) {
      if (k.endsWith(':*')) wildcard.add(k.slice(4, -2));
      else changed.add(k);
    }
  }
  const mentions = (key: string) => key.split(/[:|]/).some((part) => wildcard.has(part));
  const out: string[] = [];
  for (const card of bufferCards) {
    const deps = cardDependencyKeys(card);
    if (deps.some((k) => changed.has(k) || mentions(k))) out.push(card.id);
  }
  return [...new Set(out)].sort();
}
