/** 状态 → 中文文本的渲染辅助（views 与 context pack 共用；确定性）。Owner: lane B。 */
import type { Card, Delta, DeltaOp, Predicate, Secret, Snapshot, WorldRules } from '@novelist/shared';
import { isOpPattern } from './predicate.js';

export interface RenderCtx {
  snapshot: Snapshot;
  world: WorldRules | null;
  secrets?: Secret[];
}

export function nameOf(ctx: RenderCtx, id: string): string {
  const e = ctx.snapshot.entities[id];
  return e ? e.name : id;
}

export function condLabel(ctx: RenderCtx, cond: string): string {
  const c = ctx.world?.vocab.conditions.find((x) => x.id === cond) ?? ctx.world?.vocab.proposals.find((x) => x.id === cond);
  return c ? c.label : cond;
}

export function factText(ctx: RenderCtx, fact: string): string {
  const f = ctx.snapshot.facts[fact];
  if (f) return f.overridden ? `${f.text}［已更正］` : f.text;
  const sec = ctx.secrets?.find((s) => s.fact === fact);
  if (sec) return sec.truth;
  return fact;
}

const fmtVal = (ctx: RenderCtx, v: unknown): string => {
  if (typeof v === 'string') return /^(char|loc|fac|item|concept)\./.test(v) ? nameOf(ctx, v) : v;
  if (v === null || v === undefined) return '无';
  return JSON.stringify(v);
};

const OBL_STATUS: Record<string, string> = { open: '未回收', advanced: '推进中', paid: '已回收', abandoned: '已放弃' };

export function renderPredicate(ctx: RenderCtx, p: Predicate): string {
  const pp = p as Record<string, unknown>;
  const n = (id: string) => `${nameOf(ctx, id)}`;
  if ('and' in pp) return (pp.and as Predicate[]).map((x) => renderPredicate(ctx, x)).join(' 且 ');
  if ('or' in pp) return `（${(pp.or as Predicate[]).map((x) => renderPredicate(ctx, x)).join(' 或 ')}）`;
  if ('not' in pp) return `并非（${renderPredicate(ctx, pp.not as Predicate)}）`;
  if ('manual' in pp) return `［人工判定］${pp.manual as string}`;
  if ('eq' in pp || 'ne' in pp || 'in' in pp) {
    const [ref, v] = (pp.eq ?? pp.ne ?? pp.in) as [{ attr: [string, string] }, unknown];
    const [e, k] = ref.attr;
    if ('eq' in pp) return `${n(e)}.${k} = ${fmtVal(ctx, v)}`;
    if ('ne' in pp) return `${n(e)}.${k} ≠ ${fmtVal(ctx, v)}`;
    return `${n(e)}.${k} ∈ {${(v as unknown[]).map((x) => fmtVal(ctx, x)).join('，')}}`;
  }
  if ('knows' in pp) {
    const [w, f] = pp.knows as [string, string];
    return `${n(w)} 已知：${factText(ctx, f)}`;
  }
  if ('knows_not' in pp) {
    const [w, f] = pp.knows_not as [string, string];
    return `${n(w)} 尚不知：${factText(ctx, f)}`;
  }
  if ('obligation' in pp) return `伏笔 ${pp.obligation as string} 状态为「${OBL_STATUS[pp.status as string] ?? (pp.status as string)}」`;
  if ('stage' in pp) {
    const [e, st] = pp.stage as [string, string];
    return `${n(e)} 处于阶段 ${st}`;
  }
  if ('at_loc' in pp) {
    const [e, l] = pp.at_loc as [string, string];
    return `${n(e)} 位于 ${n(l)}`;
  }
  if ('alive' in pp) return `${n(pp.alive as string)} 存活`;
  if ('dead' in pp) return `${n(pp.dead as string)} 已死`;
  if ('has_cond' in pp) {
    const [e, c] = pp.has_cond as [string, string];
    return `${n(e)} 有状态「${condLabel(ctx, c)}」`;
  }
  return JSON.stringify(p);
}

export function renderOp(ctx: RenderCtx, op: DeltaOp | Record<string, unknown>): string {
  const o = op as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'string' ? nameOf(ctx, v) : '?');
  switch (o.op) {
    case 'entity.create':
      return `新登场：${(o.name as string) ?? n(o.ent)}（${o.ent as string}）`;
    case 'entity.update':
    case 'offscreen.update': {
      const set = (o.set ?? {}) as Record<string, unknown>;
      const parts = Object.entries(set).map(([k, v]) => {
        if (k === 'cond+')
          return `新增状态 ${[v]
            .flat()
            .map((c) => condLabel(ctx, String(c)))
            .join('、')}`;
        if (k === 'cond-')
          return `解除状态 ${[v]
            .flat()
            .map((c) => condLabel(ctx, String(c)))
            .join('、')}`;
        if (k === 'loc') return `移动到 ${fmtVal(ctx, v)}`;
        return `${k} → ${fmtVal(ctx, v)}`;
      });
      return `${n(o.ent)}${o.op === 'offscreen.update' ? '（幕后）' : ''}：${parts.join('；')}`;
    }
    case 'entity.retire':
      return `${n(o.ent)} 退场（${({ death: '死亡', departure: '离开', destroyed: '毁灭', other: '其他' } as Record<string, string>)[o.how as string] ?? String(o.how)}）`;
    case 'event':
      return `事件：${o.what as string}${Array.isArray(o.who) && o.who.length ? `（${(o.who as string[]).map(n).join('、')}）` : ''}`;
    case 'fact.assert':
      return `事实：${o.text as string}`;
    case 'knowledge.learn':
      return `${n(o.who)} 得知：${factText(ctx, o.fact as string)}`;
    case 'reader.reveal':
      return `向读者揭示：${factText(ctx, o.fact as string)}`;
    case 'identity.reveal':
      return `${n(o.ent)} 的身份「${o.identity as string}」揭示给 ${o.to === 'reader' ? '读者' : n(o.to)}`;
    case 'obligation.open':
      return `埋设伏笔 ${o.id as string}：${o.text as string}`;
    case 'obligation.advance':
      return `推进伏笔 ${o.id as string}${o.note ? `：${o.note as string}` : ''}`;
    case 'obligation.pay':
      return `回收伏笔 ${o.id as string}`;
    case 'obligation.abandon':
      return `放弃伏笔 ${o.id as string}：${(o.reason as string) ?? ''}`;
    case 'arc.stage':
      return `${n(o.who)} 进入阶段 ${o.stage as string}`;
    case 'arc.resolve':
      return `弧 ${o.arc as string} 收束`;
    case 'time.advance': {
      const t = (o.to ?? {}) as Record<string, unknown>;
      return `时间推进到 ${renderTime(t)}${o.flashback ? '（闪回）' : ''}`;
    }
    case 'power.change':
      return `${n(o.who)} ${o.system as string}：${(o.from as string) ?? '?'} → ${o.to as string}`;
    case 'item.transfer':
      return `${n(o.item)} 转到 ${o.to ? n(o.to) : '无主'}`;
    case 'relation.set':
      return `${n(o.a)} 与 ${n(o.b)}：${o.type as string}`;
    case 'contract.amend':
      return `${n(o.who)} 契约修订（${o.stage as string}）`;
    default:
      return JSON.stringify(op);
  }
}

export function renderTime(t: Record<string, unknown> | undefined): string {
  if (!t) return '未知';
  if (typeof t.label === 'string' && t.label) return t.label;
  const parts: string[] = [];
  if (t.calendar) parts.push(String(t.calendar));
  if (typeof t.year === 'number') parts.push(`${t.year} 年`);
  if (typeof t.day === 'number') parts.push(`第 ${t.day} 日`);
  if (typeof t.hour === 'number') parts.push(`${t.hour} 时`);
  return parts.join(' ') || '未知';
}

export function renderCondition(ctx: RenderCtx, c: unknown): string {
  if (isOpPattern(c)) return `发生：${renderOp(ctx, c as Record<string, unknown>)}`;
  return renderPredicate(ctx, c as Predicate);
}

/** 实体当前状态一行 */
export function renderEntityState(ctx: RenderCtx, id: string): string {
  const e = ctx.snapshot.entities[id];
  if (!e) return '（未知实体）';
  const parts: string[] = [];
  if (e.kind === 'character') parts.push(e.alive ? (e.retired ? `已退场（${e.retired}）` : '存活') : '已死亡');
  else if (!e.alive || e.retired) parts.push(e.alive ? `已退场（${e.retired}）` : '已毁');
  if (typeof e.attrs.loc === 'string') parts.push(`位置：${nameOf(ctx, e.attrs.loc)}`);
  if (e.conds.length) parts.push(`状态：${e.conds.map((c) => condLabel(ctx, c)).join('、')}`);
  if (e.stage) parts.push(`阶段：${e.stage}`);
  const power = Object.entries(e.power);
  if (power.length) parts.push(`境界：${power.map(([s, l]) => `${s} ${l}`).join('，')}`);
  const held = Object.entries(ctx.snapshot.items)
    .filter(([, v]) => v.holder === id)
    .map(([k]) => nameOf(ctx, k));
  if (held.length) parts.push(`持有：${held.join('、')}`);
  for (const [k, v] of Object.entries(e.attrs).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (k === 'loc' || k === 'owner' || k === 'holder') continue;
    parts.push(`${k}：${fmtVal(ctx, v)}`);
  }
  return parts.join('｜') || '—';
}

/** 一章 delta 中触及某实体的 op（progression） */
export function opsTouching(d: Delta, id: string): DeltaOp[] {
  return (d.ops ?? []).filter((op) => {
    const o = op as unknown as Record<string, unknown>;
    if (o.ent === id || o.who === id || o.a === id || o.b === id || o.item === id || o.to === id || o.from === id) return true;
    return Array.isArray(o.who) && (o.who as string[]).includes(id);
  });
}

/** 最近 limit 次 progression（状态变化类 op；新的在后）。beforeNo：只看该章号之前 */
export function progressions(ctx: RenderCtx, ledger: Delta[], id: string, limit: number, beforeNo = Number.POSITIVE_INFINITY): { ch: string; text: string }[] {
  const out: { ch: string; text: string }[] = [];
  for (let i = ledger.length - 1; i >= 0 && out.length < limit; i--) {
    const d = ledger[i] as Delta;
    if (Number(d.chapter.slice(1)) >= beforeNo) continue;
    const ops = opsTouching(d, id).filter((op) => op.op !== 'event' && op.op !== 'knowledge.learn' && op.op !== 'relation.set');
    for (let j = ops.length - 1; j >= 0 && out.length < limit; j--) out.push({ ch: d.chapter, text: renderOp(ctx, ops[j] as DeltaOp) });
  }
  return out.reverse();
}

/** 卡片（不含 notes）渲染为中文 markdown */
export function renderCard(ctx: RenderCtx, card: Card): string {
  const L: string[] = [];
  L.push(`### ${card.id}「${card.title}」`);
  L.push(`- 卷/弧：${card.volume} / ${card.arc}${card.key ? '｜关键章' : ''}${card.is_final ? '｜终章' : ''}`);
  if (card.length) L.push(`- 长度：${card.length.min}–${card.length.max}（目标 ${card.length.target}，口径 ${card.length.count_mode}）`);
  if (card.pov) L.push(`- 视角：${nameOf(ctx, card.pov)}（${card.pov}）`);
  if (card.entities_present.length) L.push(`- 在场：${card.entities_present.map((e) => `${nameOf(ctx, e)}（${e}）`).join('、')}`);
  if (card.strands.length) L.push(`- 线索：${card.strands.join('、')}`);
  L.push('', '**节拍**');
  for (const b of card.beats) L.push(`- ${b.id}［${b.mode}，约 ${b.cjk} 字${b.pov ? `，视角 ${nameOf(ctx, b.pov)}` : ''}］${b.goal}`);
  if (card.pre.length) {
    L.push('', '**写前成立（pre）**');
    for (const c of card.pre) L.push(`- ${renderCondition(ctx, c)}`);
  }
  if (card.post.length) {
    L.push('', '**本章必须发生（post）**');
    for (const c of card.post) L.push(`- ${renderCondition(ctx, c)}`);
  }
  if (card.must_not.length) {
    L.push('', '**本章不得发生（must_not）**');
    for (const c of card.must_not) L.push(`- ${renderCondition(ctx, c)}`);
  }
  if (card.pays.length || card.advances.length || card.may_open.length) {
    L.push('', '**伏笔**');
    if (card.pays.length) L.push(`- 回收：${card.pays.join('、')}`);
    if (card.advances.length) L.push(`- 推进：${card.advances.join('、')}`);
    if (card.may_open.length) L.push(`- 允许新埋：${card.may_open.join('、')}`);
  }
  if (card.offscreen.length) {
    L.push('', '**幕后变化（offscreen）**');
    for (const o of card.offscreen) L.push(`- ${renderOp(ctx, { op: 'offscreen.update', ent: o.ent, set: o.set })}`);
  }
  if (card.callbacks.length) {
    L.push('', '**呼应**');
    for (const c of card.callbacks) L.push(`- ${'query' in c ? `检索：${c.query}` : `引用 ${c.from}：「${c.quote}」`}`);
  }
  return L.join('\n');
}
