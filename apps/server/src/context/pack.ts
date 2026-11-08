/**
 * Context pack 编译器（DESIGN §6.3）：编译成单个 markdown 文件，内联进 work order。Owner: lane B。
 * section 固定配额，section 内按相关性截断，不跨 section 挤占；style 不可截断。默认合计 65k。
 *
 * 配额口径：码点数（measureText 'chars'），汉字、标点、字母都计 1——它是汉字数的上界，同时约束字节数。
 * 每个 section 的正文 ≤ 配额（style 例外：不可截断，放不下的风格样本整篇略过并注明路径）。
 * 标题、说明等固定开销不计入配额（PACK_OVERHEAD_MAX 以内）。
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Card, Entity, Lexicon, Override, Snapshot } from '@novelist/shared';
import { chapterId, chapterNo, countCjk, normalizeForMatch } from '@novelist/shared';
import { P } from '../book/layout.js';
import {
  type BookState,
  aliasEntities,
  conditionRefs,
  createFolder,
  factText,
  loadBookState,
  nameOf,
  patternStats,
  progressions,
  renderCard,
  renderCondition,
  renderEntityState,
  renderOp,
  renderTime,
  type RenderCtx,
} from '../state/index.js';
import { collectVoiceAnchors } from '../state/voice.js';
import { type AliasIndex, buildAliasIndex } from './alias.js';
import { syncIndex } from './bm25.js';
import { measureText, truncateCjk } from './cjk.js';

export const SECTION_QUOTAS = {
  card: 4000,
  prev: 13000,
  cast: 12000,
  knowledge: 4000,
  obligations: 4000,
  story: 10000,
  world: 4000,
  retrieval: 6000,
  patterns: 2000,
  style: 6000,
} as const;
export type SectionId = keyof typeof SECTION_QUOTAS;

/** 固定开销上限（标题、说明、section 标题） */
export const PACK_OVERHEAD_MAX = 1500;

export interface ContextPack {
  text: string;
  cjk: number;
  hash: string;
  sections: { id: SectionId; quota: number; used: number; truncated: boolean; sources: string[] }[];
  /** lane B 扩展：编译时顺带得到的统计（E 用来决定是否派 plan.fix 等） */
  stats?: { overdue: number; reentry: string[]; retrievalHits: number; castEntities: string[] };
}

export interface ContextPackOptions {
  /** 必须是已 buildViews 过的快照目录（或 live 树） */
  bookDir: string;
  card: Card;
  snapshot: Snapshot;
  quotas?: Partial<Record<SectionId, number>>;
  /** 风格样本轮换用：hash(chapter_id) mod N */
  sampleSeed?: string;
  /** lane B 扩展：已加载的书状态（省一次读取）；题材链合并后的 lexicon（缺省读 style/lexicon.yaml） */
  state?: BookState;
  lexicon?: Lexicon | null;
}

const SECTION_TITLES: Record<SectionId, string> = {
  card: '本章卡片',
  prev: '前文',
  cast: '在场人物',
  knowledge: '认知与禁区',
  obligations: '伏笔',
  story: '故事梗概',
  world: '世界设定',
  retrieval: '相关旧文（检索）',
  patterns: '近期场面类型',
  style: '风格',
};
const ORDER: SectionId[] = ['card', 'prev', 'cast', 'knowledge', 'obligations', 'story', 'world', 'retrieval', 'patterns', 'style'];

const M = (t: string) => measureText(t, 'chars');

interface Built {
  body: string;
  truncated: boolean;
  sources: string[];
}

/** 在 quota 内按顺序装填若干块：先平均分配，短块的余量依次让给后面的长块；每块内部 head 截断 */
export function fillBlocks(blocks: string[], quota: number, sep = '\n\n'): { text: string; truncated: boolean } {
  const bs = blocks.filter((b) => b.trim() !== '');
  if (bs.length === 0) return { text: '', truncated: false };
  const sepCost = M(sep) * (bs.length - 1);
  const lens = bs.map(M);
  if (lens.reduce((a, b) => a + b, 0) + sepCost <= quota) return { text: bs.join(sep), truncated: false };
  let remaining = Math.max(0, quota - sepCost);
  const alloc = new Array<number>(bs.length).fill(0);
  let pending = bs.map((_, i) => i);
  for (;;) {
    if (pending.length === 0) break;
    const share = Math.floor(remaining / pending.length);
    const small = pending.filter((i) => (lens[i] as number) <= share);
    if (small.length === 0) {
      for (const i of pending) alloc[i] = share;
      break;
    }
    for (const i of small) {
      alloc[i] = lens[i] as number;
      remaining -= lens[i] as number;
    }
    pending = pending.filter((i) => !small.includes(i));
  }
  const out: string[] = [];
  bs.forEach((b, i) => {
    const a = alloc[i] as number;
    if (a <= 0) return;
    out.push(truncateCjk(b, a, 'head', 'chars').text.replace(/\s+$/, ''));
  });
  let text = out.join(sep);
  if (M(text) > quota) text = truncateCjk(text, quota, 'head', 'chars').text;
  return { text, truncated: true };
}

function cap(text: string, quota: number, keep: 'head' | 'tail' = 'head'): { text: string; truncated: boolean } {
  const r = truncateCjk(text, quota, keep, 'chars');
  return { text: r.text.replace(/\s+$/, ''), truncated: r.truncated };
}

function entityDefs(state: BookState): Map<string, { entity: Entity; body: string; path: string }> {
  return new Map(state.entities.map((e) => [e.entity.id, e]));
}

// ------------------------------------------------------------------------------------------
// sections
// ------------------------------------------------------------------------------------------

async function sectionPrev(state: BookState, card: Card, quota: number): Promise<Built> {
  const n = chapterNo(card.id);
  const sources: string[] = [];
  let truncated = false;
  // 最近 10 章摘要（N−1、N−2 之外：N−3 … N−12），来自 delta.summary
  const sumLines: string[] = [];
  for (let k = n - 12; k <= n - 3; k++) {
    if (k < 1) continue;
    const d = state.ledger[k - 1];
    if (!d || d.chapter !== chapterId(k)) continue;
    const s = d.summary.map((x) => x.s).join('');
    if (s) {
      sumLines.push(`- ${d.chapter}：${cap(s, 300).text}`);
      sources.push(P.ledger(k));
    }
  }
  let summaries = '';
  if (sumLines.length) {
    const r = cap(`**近期各章摘要**\n${sumLines.join('\n')}`, Math.min(2600, Math.floor(quota * 0.2)), 'tail');
    summaries = r.text;
    truncated ||= r.truncated;
  }
  let room = quota - M(summaries) - (summaries ? 2 : 0);
  const n1 = n >= 2 ? await state.manuscript(n - 1) : null;
  const n2 = n >= 3 ? await state.manuscript(n - 2) : null;
  const header = (k: number) => `**${chapterId(k)} 全文${''}**\n`;
  let t1 = '';
  let t2 = '';
  if (n1) {
    sources.push(P.manuscript(n - 1));
    const reserve = n2 ? Math.min(3000, Math.floor(room / 2)) : 0;
    const r = cap(n1.trim(), Math.max(0, room - reserve - M(header(n - 1)) - 2), 'tail');
    t1 = `${header(n - 1)}${r.truncated ? '（前略）\n' : ''}${r.text}`;
    truncated ||= r.truncated;
    room -= M(t1) + 2;
  }
  if (n2 && room > 200) {
    sources.push(P.manuscript(n - 2));
    const r = cap(n2.trim(), Math.max(0, room - M(header(n - 2)) - 8), 'tail');
    t2 = `${header(n - 2)}${r.truncated ? '（前略）\n' : ''}${r.text}`;
    truncated ||= r.truncated;
  } else if (n2) truncated = true;
  const body = [summaries, t2, t1].filter(Boolean).join('\n\n');
  const fin = cap(body, quota, 'tail');
  return { body: fin.text, truncated: truncated || fin.truncated, sources };
}

function castOrder(card: Card, ctx: RenderCtx, aliases: AliasIndex): string[] {
  const ids: string[] = [];
  const push = (id: string | undefined) => {
    if (id && !id.startsWith('tmp:') && !ids.includes(id)) ids.push(id);
  };
  push(card.pov);
  for (const b of card.beats) push(b.pov);
  for (const e of card.entities_present) push(e);
  for (const c of [...card.pre, ...card.post, ...card.must_not])
    for (const e of conditionRefs(c).entities) if (ctx.snapshot.entities[e]?.kind === 'character') push(e);
  const text = [card.title, ...card.beats.map((b) => b.goal)].join('\n');
  for (const m of aliases.resolve(aliases.scan(text), text, card.entities_present, card.pov ? { pov: card.pov } : {})) if (ctx.snapshot.entities[m.entity]?.kind === 'character') push(m.entity);
  return ids.slice(0, 16);
}

async function sectionCast(
  state: BookState,
  card: Card,
  ctx: RenderCtx,
  aliases: AliasIndex,
  quota: number,
): Promise<Built & { ids: string[]; reentry: string[] }> {
  const n = chapterNo(card.id);
  const s = ctx.snapshot;
  const defs = entityDefs(state);
  const ids = castOrder(card, ctx, aliases).filter((id) => s.entities[id]);
  const reentry = ids.filter((id) => {
    const ls = s.entities[id]?.last_seen;
    return !!ls && n - chapterNo(ls) > 50;
  });
  // voice 锚点：近 60 章 + 重新登场者最后出场的那一章
  const chapters: { ch: string; text: string }[] = [];
  for (let k = n - 1; k >= 1 && k >= n - 60; k--) {
    const t = await state.manuscript(k);
    if (t) chapters.push({ ch: chapterId(k), text: t });
  }
  for (const id of reentry) {
    const ls = chapterNo(s.entities[id]?.last_seen as string);
    const t = await state.manuscript(ls);
    if (t && !chapters.some((c) => c.ch === chapterId(ls))) chapters.push({ ch: chapterId(ls), text: t });
  }
  const anchors = collectVoiceAnchors(chapters, aliases, new Set(ids), 3);
  // 离场时的状态：折叠到各自最后出场那一章（不是当前快照，离场期间 offscreen.update 可能已改过）
  const departure = new Map<string, string>();
  if (reentry.length) {
    const folder = createFolder({ entities: state.entities.map((x) => x.entity), world: state.world, ledger: state.ledger, overrides: state.overrides });
    const lastSeen = (id: string) => chapterNo(s.entities[id]?.last_seen as string);
    for (const id of [...reentry].sort((a, b) => lastSeen(a) - lastSeen(b))) {
      const at = folder.advanceTo(lastSeen(id));
      if (at.entities[id]) departure.set(id, renderEntityState({ ...ctx, snapshot: at }, id));
    }
  }
  const sources = new Set<string>();
  const blocks: string[] = [];
  for (const id of ids) {
    const e = s.entities[id];
    if (!e) continue;
    const def = defs.get(id);
    if (def) sources.add(def.path);
    const L: string[] = [];
    L.push(`#### ${e.name}（${id}）${def ? ` · ${def.entity.tier}` : ''}${id === card.pov ? ' · 视角' : ''}`);
    const al = def ? (aliases.aliasesOf?.(id) ?? []).filter((a) => a !== e.name) : [];
    if (al.length) L.push(`- 别名：${al.join('、')}`);
    L.push(`- 状态：${renderEntityState(ctx, id)}`);
    if (def) {
      const keys = Object.keys(def.entity.contract_by_stage ?? {}).sort();
      const cur = e.stage && def.entity.contract_by_stage[e.stage] ? e.stage : (keys.filter((k) => e.stage?.startsWith(k)).pop() ?? keys[0]);
      const c = cur ? def.entity.contract_by_stage[cur] : undefined;
      if (c)
        L.push(
          `- 契约（${cur}）：${[c.voice ? `语气：${c.voice}` : '', c.never.length ? `绝不：${c.never.join('、')}` : '', c.limits.length ? `底线：${c.limits.join('、')}` : ''].filter(Boolean).join('；')}`,
        );
    }
    const prog = progressions(ctx, state.ledger, id, 3, n);
    if (prog.length) L.push(`- 最近变化：${prog.map((p) => `${p.ch} ${p.text}`).join('；')}`);
    const q = anchors.get(id);
    if (q?.length) L.push(`- 代表台词：${q.map((x) => `“${x.quote}”`).join(' ')}`);
    if (reentry.includes(id)) {
      const ls = chapterNo(e.last_seen as string);
      L.push(`- 重新登场提要（已离场 ${n - 1 - ls} 章，最后出场 ${e.last_seen}）：`);
      L.push(`  - 离场时状态：${departure.get(id) ?? renderEntityState(ctx, id)}`);
      const t = await state.manuscript(ls);
      if (t) {
        sources.add(P.manuscript(ls));
        const paras = t.split(/\n+/).filter((p) => aliases.resolve(aliases.scan(p), p, [id]).some((m) => m.entity === id));
        const last = paras.slice(-2).map((p) => cap(p.trim(), 300).text);
        if (last.length) L.push(`  - 最后出场原文：${last.map((p) => `「${p}」`).join(' ')}`);
      }
      const during: string[] = [];
      for (const d of state.ledger) {
        const no = chapterNo(d.chapter);
        if (no <= ls || no >= n) continue;
        for (const op of d.ops) {
          const o = op as unknown as Record<string, unknown>;
          const touches = o.ent === id || (Array.isArray(o.who) && (o.who as string[]).includes(id)) || o.a === id || o.b === id;
          const atLoc = op.op === 'event' && typeof e.attrs.loc === 'string' && op.loc === e.attrs.loc;
          if (touches || atLoc) during.push(`${d.chapter} ${renderOp(ctx, op)}`);
        }
      }
      if (during.length) L.push(`  - 离场期间相关：${during.slice(-5).join('；')}`);
    }
    if (def?.body.trim()) L.push(`- 设定：${cap(def.body.trim().replace(/\n+/g, ' '), 400).text}`);
    blocks.push(L.join('\n'));
  }
  const r = fillBlocks(blocks, quota);
  return { body: r.text, truncated: r.truncated, sources: [...sources].sort(), ids, reentry };
}

function recentFacts(state: BookState, n: number, window = 20): Set<string> {
  const out = new Set<string>();
  for (const d of state.ledger) {
    const no = chapterNo(d.chapter);
    if (no >= n || no < n - window) continue;
    for (const op of d.ops) {
      if (op.op === 'knowledge.learn' || op.op === 'fact.assert' || op.op === 'reader.reveal') out.add(op.fact);
    }
    for (const u of d.uses_knowledge ?? []) out.add(u.fact);
  }
  return out;
}

function sectionKnowledge(state: BookState, card: Card, ctx: RenderCtx, castIds: string[], quota: number): Built {
  const n = chapterNo(card.id);
  const s = ctx.snapshot;
  const condFacts = new Set<string>();
  for (const c of [...card.pre, ...card.post, ...card.must_not]) for (const f of conditionRefs(c).facts) condFacts.add(f);
  const recent = recentFacts(state, n);
  const blocks: string[] = [];
  if (card.must_not.length) blocks.push(`**本章不得发生**\n${card.must_not.map((c) => `- ${renderCondition(ctx, c)}`).join('\n')}`);
  const knowsLines: string[] = [];
  for (const c of [...card.pre, ...card.post]) {
    const o = c as Record<string, unknown>;
    if ('knows' in o || 'knows_not' in o) knowsLines.push(`- ${renderCondition(ctx, c)}`);
  }
  if (knowsLines.length) blocks.push(`**本章涉及的认知条件**\n${knowsLines.join('\n')}`);
  const present = castIds.length ? castIds : card.entities_present;
  const perEnt: string[] = [];
  for (const id of present) {
    const ks = s.knowledge[id] ?? [];
    if (!ks.length) continue;
    const rel = ks.filter((f) => condFacts.has(f) || recent.has(f));
    const lines = rel.map((f) => `  - ${factText(ctx, f)}（${f}）`);
    const rest = ks.length - rel.length;
    perEnt.push(
      `- ${nameOf(ctx, id)} 知道：${lines.length ? `\n${lines.join('\n')}` : '（近期无相关）'}${rest > 0 ? `\n  - 另知 ${rest} 条（见 views/knowledge.md）` : ''}`,
    );
  }
  if (perEnt.length) blocks.push(`**在场人物的相关认知**\n${perEnt.join('\n')}`);
  const reader: string[] = [];
  for (const f of s.reader_knows) if (condFacts.has(f) || recent.has(f)) reader.push(`- 已知：${factText(ctx, f)}`);
  const secrets = state.secrets.map((x) => x.secret).filter((sec) => sec.fact && !s.reader_knows.includes(sec.fact));
  const relSecrets = secrets
    .filter((sec) => condFacts.has(sec.fact as string))
    .concat(
      secrets
        .filter((sec) => !condFacts.has(sec.fact as string))
        .map((sec) => ({
          sec,
          at:
            sec.reveal_plan
              .map((r) => (r.at ? chapterNo(r.at) : Number.POSITIVE_INFINITY))
              .filter((x) => x >= n)
              .sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY,
        }))
        .sort((a, b) => a.at - b.at || (a.sec.id < b.sec.id ? -1 : 1))
        .slice(0, 5)
        .map((x) => x.sec),
    );
  for (const sec of relSecrets) reader.push(`- 读者尚不知（不得泄露）：${sec.truth}`);
  if (reader.length) blocks.push(`**读者当前认知**\n${reader.join('\n')}`);
  const overridden = Object.entries(s.facts).filter(([f, x]) => x.overridden && (condFacts.has(f) || recent.has(f)));
  if (overridden.length) blocks.push(`**已更正的事实（以此为准）**\n${overridden.map(([f, x]) => `- ${f}：${x.text}`).join('\n')}`);
  const r = fillBlocks(blocks, quota);
  return { body: r.text, truncated: r.truncated, sources: ['views/knowledge.md'] };
}

function sectionObligations(state: BookState, card: Card, ctx: RenderCtx, quota: number): Built & { overdue: number } {
  const n = chapterNo(card.id);
  const s = ctx.snapshot;
  const named = new Set<string>([...card.pays, ...card.advances]);
  for (const c of [...card.pre, ...card.post, ...card.must_not]) for (const o of conditionRefs(c).obligations) named.add(o);
  const advNotes = (id: string): string[] => {
    const out: string[] = [];
    for (const d of state.ledger) {
      if (chapterNo(d.chapter) >= n) break;
      for (const op of d.ops)
        if (op.op === 'obligation.advance' && op.id === id) out.push(`${d.chapter}${op.note ? ` ${op.note}` : ''}：「${cap(op.ev, 80).text}」`);
    }
    return out;
  };
  const line = (id: string, detail: boolean): string => {
    const o = s.obligations[id];
    if (!o) return `- ${id}：（尚未埋设）`;
    const head = `- ${o.id}［${o.weight}/${o.kind}/${o.status}］${o.text}（埋于 ${o.opened}${o.due ? `，期限 ${o.due[0]}–${o.due[1]}` : ''}）`;
    if (!detail) return head;
    const L = [head];
    if (o.open_ev) L.push(`  - 埋设原文：「${cap(o.open_ev, 160).text}」`);
    const adv = advNotes(id);
    if (adv.length) L.push(`  - 历次推进：${adv.slice(-4).join('；')}`);
    return L.join('\n');
  };
  const blocks: string[] = [];
  const cardLines: string[] = [];
  for (const id of card.pays) cardLines.push(`${line(id, true)}\n  - 本章：回收`);
  for (const id of card.advances) cardLines.push(`${line(id, true)}\n  - 本章：推进`);
  for (const id of [...named].filter((x) => !card.pays.includes(x) && !card.advances.includes(x)).sort()) cardLines.push(line(id, false));
  if (card.may_open.length) cardLines.push(`- 本章允许新埋：${card.may_open.join('、')}`);
  if (cardLines.length) blocks.push(`**本卡指定**\n${cardLines.join('\n')}`);
  const open = Object.values(s.obligations).filter((o) => (o.status === 'open' || o.status === 'advanced') && !named.has(o.id));
  const overdue = open.filter((o) => o.due && chapterNo(o.due[1]) < n).sort((a, b) => ((a.due?.[1] ?? '') < (b.due?.[1] ?? '') ? -1 : a.id < b.id ? -1 : 1));
  const urgent = open
    .filter((o) => o.due && chapterNo(o.due[1]) >= n)
    .sort((a, b) => ((a.due?.[1] ?? '') < (b.due?.[1] ?? '') ? -1 : (a.due?.[1] ?? '') > (b.due?.[1] ?? '') ? 1 : a.id < b.id ? -1 : 1));
  if (urgent.length)
    blocks.push(
      `**最紧迫（前 5）**\n${urgent
        .slice(0, 5)
        .map((o) => line(o.id, false))
        .join('\n')}`,
    );
  const totalOverdue =
    overdue.length +
    [...named].filter((id) => {
      const o = s.obligations[id];
      return o && (o.status === 'open' || o.status === 'advanced') && o.due && chapterNo(o.due[1]) < n;
    }).length;
  if (overdue.length)
    blocks.push(
      `**已逾期（前 5，共 ${totalOverdue} 条${totalOverdue > 5 ? '，超过 5 条将安排 plan.fix' : ''}）**\n${overdue
        .slice(0, 5)
        .map((o) => line(o.id, false))
        .join('\n')}`,
    );
  const allOpen = Object.values(s.obligations).filter((o) => o.status === 'open' || o.status === 'advanced');
  blocks.push(
    `未回收伏笔共 ${allOpen.length} 条（main ${allOpen.filter((o) => o.weight === 'main').length}、major ${allOpen.filter((o) => o.weight === 'major').length}、minor ${allOpen.filter((o) => o.weight === 'minor').length}）；全表见 views/obligations.md。`,
  );
  const r = fillBlocks(blocks, quota);
  return { body: r.text, truncated: r.truncated, sources: ['views/obligations.md'], overdue: totalOverdue };
}

async function sectionStory(state: BookState, card: Card, quota: number): Promise<Built> {
  const n = chapterNo(card.id);
  const sources: string[] = [];
  let truncated = false;
  const parts: string[] = [];
  const book = await state.files.summary('book');
  let used = 0;
  if (book?.trim()) {
    const r = cap(book.trim(), Math.min(5000, quota), 'tail');
    parts.push(`**全书**\n${r.text}`);
    truncated ||= r.truncated;
    sources.push(P.summaryBook);
    used += M(parts[parts.length - 1] as string) + 2;
  }
  // 当前卷滚动摘要（≤3k）：summaries/volumes/<v>.md；没有则用本卷已完成弧的弧摘要拼接
  let vol = await state.files.summary('volume', card.volume);
  let volSrc = P.summaryVolume(card.volume);
  if (!vol?.trim()) {
    const arcs = state.arcs.filter((a) => a.volume === card.volume && a.id < card.arc);
    const texts: string[] = [];
    for (const a of arcs) {
      const t = await state.files.summary('arc', a.id);
      if (t?.trim()) texts.push(`${a.id}「${a.title}」：${t.trim()}`);
    }
    vol = texts.join('\n');
    volSrc = 'summaries/arcs/*';
  }
  if (vol?.trim()) {
    const r = cap(vol.trim(), Math.min(3000, Math.max(0, quota - used - 20)), 'tail');
    if (r.text) {
      parts.push(`**本卷（${card.volume}）至今**\n${r.text}`);
      truncated ||= r.truncated;
      sources.push(volSrc);
      used += M(parts[parts.length - 1] as string) + 2;
    }
  }
  // 当前弧：弧摘要（若已有）或弧计划 + 本弧已写各章摘要（不含 prev 已覆盖的最近 12 章）
  const arc = state.arcs.find((a) => a.id === card.arc);
  const arcLines: string[] = [];
  if (arc) {
    arcLines.push(`问题：${arc.question}${arc.goal ? `；目标：${arc.goal}` : ''}（${arc.chapters[0]}–${arc.chapters[1]}，收束于 ${arc.resolve_by}）`);
    sources.push(P.arc(arc.id));
  }
  const arcSum = await state.files.summary('arc', card.arc);
  if (arcSum?.trim()) {
    arcLines.push(arcSum.trim());
    sources.push(P.summaryArc(card.arc));
  } else if (arc) {
    const from = chapterNo(arc.chapters[0]);
    for (let k = from; k < n - 12; k++) {
      const d = state.ledger[k - 1];
      if (d?.summary.length) arcLines.push(`- ${d.chapter}：${cap(d.summary.map((x) => x.s).join(''), 200).text}`);
    }
  }
  if (arcLines.length) {
    const r = cap(`**本弧（${card.arc}）**\n${arcLines.join('\n')}`, Math.max(0, quota - used), 'tail');
    if (r.text) parts.push(r.text);
    truncated ||= r.truncated;
  }
  const fin = cap(parts.join('\n\n'), quota, 'head');
  return { body: fin.text, truncated: truncated || fin.truncated, sources };
}

function sectionWorld(state: BookState, card: Card, ctx: RenderCtx, castIds: string[], quota: number): Built {
  const s = ctx.snapshot;
  const w = state.world;
  const defs = entityDefs(state);
  const blocks: string[] = [];
  const sources = new Set<string>();
  if (w) sources.add(P.worldRules);
  const timeLine = `故事时间：${renderTime(s.time as Record<string, unknown> | undefined)}${w?.calendar ? `（历法：${w.calendar.name}${w.calendar.epoch ? `，纪元 ${w.calendar.epoch}` : ''}）` : ''}`;
  blocks.push(timeLine);
  const locs: string[] = [];
  for (const id of castIds.length ? castIds : card.entities_present) {
    const loc = s.entities[id]?.attrs.loc;
    if (typeof loc === 'string' && !locs.includes(loc)) locs.push(loc);
  }
  for (const e of card.entities_present) if (s.entities[e]?.kind === 'location' && !locs.includes(e)) locs.push(e);
  const locLines: string[] = [];
  for (const l of locs.slice(0, 4)) {
    const def = defs.get(l);
    if (def) sources.add(def.path);
    locLines.push(`- ${nameOf(ctx, l)}（${l}）${def?.body.trim() ? `：${cap(def.body.trim().replace(/\n+/g, ' '), 500).text}` : ''}`);
  }
  if (locLines.length) blocks.push(`**当前地点**\n${locLines.join('\n')}`);
  if (w) {
    const usedSystems = new Set<string>();
    for (const id of castIds) for (const sys of Object.keys(s.entities[id]?.power ?? {})) usedSystems.add(sys);
    const systems = w.systems.filter((x) => usedSystems.has(x.id) || usedSystems.has(x.name) || w.systems.length <= 2);
    if (systems.length)
      blocks.push(
        `**体系**\n${systems.map((x) => `- ${x.name}（${x.id}）：${x.ranks.join(' → ')}${x.rules.length ? `\n${x.rules.map((r) => `  - ${r}`).join('\n')}` : ''}`).join('\n')}`,
      );
    const conds = new Set<string>();
    for (const id of castIds) for (const c of s.entities[id]?.conds ?? []) conds.add(c);
    if (w.vocab.conditions.length) {
      const inPlay = w.vocab.conditions.filter((c) => conds.has(c.id));
      blocks.push(
        `**状态词表**（在场人物：${inPlay.length ? inPlay.map((c) => `${c.label}=${c.id}`).join('、') : '无'}；全表 ${w.vocab.conditions.length} 条）`,
      );
    }
    if (w.rules.length) blocks.push(`**世界规则**\n${w.rules.map((r) => `- ${r}`).join('\n')}`);
  }
  const r = fillBlocks(blocks, quota);
  return { body: r.text, truncated: r.truncated, sources: [...sources].sort() };
}

type FactAsserts = Map<string, { text: string; ev: string }[]>;

/** 被 fact override 指向的事实在账本里的原始说法（折叠后的 snapshot 只有更正后的文本，匹配不到旧段落） */
function originalFactAsserts(state: BookState): FactAsserts {
  const targets = new Set(state.overrides.flatMap((o) => (o.target.kind === 'fact' ? [o.target.fact] : [])));
  const out: FactAsserts = new Map();
  if (targets.size === 0) return out;
  for (const d of state.ledger)
    for (const op of d.ops) if (op.op === 'fact.assert' && targets.has(op.fact)) out.set(op.fact, [...(out.get(op.fact) ?? []), { text: op.text, ev: op.ev }]);
  return out;
}

function overrideNotesFor(
  hitCh: string,
  hitText: string,
  overrides: Override[],
  state: BookState,
  aliases: AliasIndex,
  ctx: RenderCtx,
  factAsserts: FactAsserts,
): string[] {
  const out: string[] = [];
  const norm = normalizeForMatch(hitText);
  const hitNo = chapterNo(hitCh);
  for (const o of overrides) {
    const t = o.target;
    if (t.kind === 'op' && t.chapter === hitCh) {
      const d = state.ledger[hitNo - 1];
      const op = d?.ops[t.op_index] as { ev?: string } | undefined;
      if (!op?.ev || norm.includes(normalizeForMatch(op.ev))) out.push(`［已更正：见 override #${o.id}，${o.note}］`);
    } else if (t.kind === 'entity' && chapterNo(o.effective_from) > hitNo) {
      if (aliases.scan(hitText).some((m) => m.entity === t.ent && !m.ambiguous))
        out.push(
          `［已更正：见 override #${o.id}，${nameOf(ctx, t.ent)}.${t.field} 正确为 ${typeof o.value === 'string' ? o.value : JSON.stringify(o.value)}；${o.note}］`,
        );
    } else if (t.kind === 'fact' && chapterNo(o.effective_from) > hitNo) {
      const said = (x: string) => x !== '' && norm.includes(x);
      const hit = (factAsserts.get(t.fact) ?? []).some((a) => said(normalizeForMatch(a.ev)) || said(normalizeForMatch(a.text).slice(0, 6)));
      const f = ctx.snapshot.facts[t.fact];
      if (hit) out.push(`［已更正：见 override #${o.id}，${f ? `正确为 ${f.text}；` : '该事实已撤销；'}${o.note}］`);
    } else if (t.kind === 'obligation' && chapterNo(o.effective_from) > hitNo) {
      const ev = ctx.snapshot.obligations[t.id]?.open_ev;
      if (ev && norm.includes(normalizeForMatch(ev))) out.push(`［已更正：见 override #${o.id}，${o.note}］`);
    }
  }
  return out;
}

async function sectionRetrieval(
  state: BookState,
  card: Card,
  ctx: RenderCtx,
  aliases: AliasIndex,
  quota: number,
  bookDir: string,
): Promise<Built & { hits: number }> {
  const n = chapterNo(card.id);
  const idx = await syncIndex(bookDir);
  const allowed = (docId: string) => {
    const no = Number(docId.slice(1, 6));
    return no < n - 2;
  };
  const picked: { docId: string; text: string; why: string }[] = [];
  const has = (id: string) => picked.some((p) => p.docId === id);
  // 1) quote 呼应：直接定位原段落
  for (const c of card.callbacks) {
    if (!('quote' in c)) continue;
    const q = normalizeForMatch(c.quote);
    const ids = idx
      .docIds()
      .filter((id) => id.startsWith(`${c.from}#`))
      .sort((a, b) => Number(a.split('#p')[1]) - Number(b.split('#p')[1]));
    for (const id of ids) {
      const t = idx.getText(id);
      if (t && normalizeForMatch(t).includes(q) && !has(id)) {
        picked.push({ docId: id, text: t, why: `呼应「${cap(c.quote, 20).text}」` });
        break;
      }
    }
  }
  // 2) 检索：每个 query 回调取前 3，再用卡片整体（标题 + 节拍 + 在场人物）补足到 8
  for (const c of card.callbacks) {
    if (!('query' in c)) continue;
    for (const h of idx.search(c.query, 3, allowed))
      if (!has(h.docId) && picked.length < 8) picked.push({ docId: h.docId, text: h.text, why: `检索「${c.query}」` });
  }
  const q = [card.title, ...card.beats.map((b) => b.goal), ...card.entities_present.map((e) => nameOf(ctx, e))].join(' ');
  for (const h of idx.search(q, 16, allowed)) {
    if (picked.length >= 8) break;
    if (!has(h.docId)) picked.push({ docId: h.docId, text: h.text, why: '卡片相关' });
  }
  const factAsserts = originalFactAsserts(state);
  const blocks = picked.map((p) => {
    const ch = p.docId.slice(0, 6);
    const notes = overrideNotesFor(ch, p.text, state.overrides, state, aliases, ctx, factAsserts);
    return `**${p.docId}**（${p.why}）\n${p.text}${notes.length ? `\n${notes.join('\n')}` : ''}`;
  });
  const r = fillBlocks(blocks, quota);
  return {
    body: r.text,
    truncated: r.truncated,
    sources: [...new Set(picked.map((p) => P.manuscript(chapterNo(p.docId.slice(0, 6)))))].sort(),
    hits: picked.length,
  };
}

function sectionPatterns(state: BookState, card: Card, quota: number): Built {
  const stats = patternStats(state, chapterNo(card.id));
  if (!stats.length) return { body: '', truncated: false, sources: [] };
  const recent = stats.filter((x) => x.last10 > 0);
  const L: string[] = [];
  if (recent.length) L.push(`近 10 章已写：${recent.map((x) => `${x.id}×${x.last10}`).join('、')}（避免重复同类场面）`);
  L.push('| 类型 | 近 10 | 近 30 | 全书 | 最近 |', '|---|---|---|---|---|');
  for (const x of stats.slice(0, 20)) L.push(`| ${x.id} | ${x.last10} | ${x.last30} | ${x.total} | ${x.lastCh} |`);
  const r = cap(L.join('\n'), quota);
  return { body: r.text, truncated: r.truncated, sources: ['views/patterns.md'] };
}

function lexiconSummary(lex: Lexicon | null | undefined): string {
  if (!lex) return '';
  const txt = (e: Lexicon['ban'][number]) => (typeof e === 'string' ? e : e.pattern);
  const L: string[] = [];
  if (lex.ban.length) L.push(`- 禁用：${lex.ban.map(txt).join('、')}`);
  if (lex.allow.length) L.push(`- 允许（优先于禁用）：${lex.allow.map(txt).join('、')}`);
  if (lex.watch.length) L.push(`- 慎用：${lex.watch.map(txt).join('、')}`);
  return L.length ? `**词表**\n${L.join('\n')}` : '';
}

async function sectionStyle(bookDir: string, card: Card, lex: Lexicon | null | undefined, quota: number, seed: string): Promise<Built> {
  const sources: string[] = [];
  const parts: string[] = [];
  let voice: string | null = null;
  try {
    voice = await fs.readFile(path.join(bookDir, P.styleVoice), 'utf8');
  } catch {
    voice = null;
  }
  if (voice?.trim()) {
    parts.push(`**语气卡**\n${voice.trim()}`);
    sources.push(P.styleVoice);
  }
  const ls = lexiconSummary(lex);
  if (ls) {
    parts.push(ls);
    sources.push(P.styleLexicon);
  }
  let samples: string[] = [];
  try {
    samples = (await fs.readdir(path.join(bookDir, P.styleSamplesDir))).filter((f) => f.endsWith('.md')).sort();
  } catch {
    samples = [];
  }
  if (samples.length) {
    const h = createHash('sha256').update(seed).digest();
    const start = h.readUInt32BE(0) % samples.length;
    const skipped: string[] = [];
    for (let i = 0; i < samples.length; i++) {
      const f = samples[(start + i) % samples.length] as string;
      const rel = `${P.styleSamplesDir}/${f}`;
      const t = (await fs.readFile(path.join(bookDir, rel), 'utf8')).trim();
      const block = `**风格样本（${f}）**\n${t}`;
      const used = M(parts.join('\n\n'));
      if (used + 2 + M(block) <= quota) {
        parts.push(block);
        sources.push(rel);
      } else if (i === 0) skipped.push(rel);
      if (i >= 1) break; // 最多两篇
    }
    if (skipped.length) parts.push(`（样本 ${skipped.join('、')} 超出配额未内联，可自行 Read）`);
  }
  void card;
  return { body: parts.join('\n\n'), truncated: false, sources };
}

// ------------------------------------------------------------------------------------------

export async function buildContextPack(opts: ContextPackOptions): Promise<ContextPack> {
  const { card, snapshot } = opts;
  const bookDir = path.resolve(opts.bookDir);
  const state = opts.state ?? (await loadBookState(bookDir));
  const quotas: Record<SectionId, number> = { ...SECTION_QUOTAS, ...(opts.quotas ?? {}) };
  const ctx: RenderCtx = { snapshot, world: state.world, secrets: state.secrets.map((s) => s.secret) };
  const aliases = buildAliasIndex(aliasEntities(state));
  const built: Partial<Record<SectionId, Built>> = {};

  const cardR = cap(renderCard(ctx, card), quotas.card);
  built.card = { body: cardR.text, truncated: cardR.truncated, sources: [P.card(chapterNo(card.id))] };
  built.prev = await sectionPrev(state, card, quotas.prev);
  const cast = await sectionCast(state, card, ctx, aliases, quotas.cast);
  built.cast = cast;
  built.knowledge = sectionKnowledge(state, card, ctx, cast.ids, quotas.knowledge);
  const obl = sectionObligations(state, card, ctx, quotas.obligations);
  built.obligations = obl;
  built.story = await sectionStory(state, card, quotas.story);
  built.world = sectionWorld(state, card, ctx, cast.ids, quotas.world);
  const ret = await sectionRetrieval(state, card, ctx, aliases, quotas.retrieval, bookDir);
  built.retrieval = ret;
  built.patterns = sectionPatterns(state, card, quotas.patterns);
  built.style = await sectionStyle(bookDir, card, opts.lexicon === undefined ? state.lexicon : opts.lexicon, quotas.style, opts.sampleSeed ?? card.id);

  const out: string[] = [];
  out.push(`<!-- nv:context-pack/1 card=${card.id} through=${snapshot.through ?? 'none'} snapshot=${snapshot.hash.slice(0, 16)} -->`);
  out.push(`# 上下文包：${card.id}「${card.title}」`);
  out.push('');
  out.push('> 本文件由 Novelist 根据账本与快照编译，只读。overrides 优先于 manuscript 原文；需要更多前文时可 Read manuscript/**（快照版本，固定不变）。');
  const sections: ContextPack['sections'] = [];
  ORDER.forEach((id, i) => {
    const b = built[id] as Built;
    out.push('', `## ${i + 1}. ${SECTION_TITLES[id]}`, '', b.body || '（无）');
    sections.push({ id, quota: quotas[id], used: M(b.body), truncated: b.truncated, sources: b.sources });
  });
  const text = `${out.join('\n')}\n`;
  return {
    text,
    cjk: countCjk(text, 'han'),
    hash: createHash('sha256').update(text).digest('hex'),
    sections,
    stats: { overdue: obl.overdue, reentry: cast.reentry, retrievalHits: ret.hits, castEntities: cast.ids },
  };
}

/** chapter.check / extract 用的瘦身输入：卡片 + 在场实体切片 + must_not + 状态词表 + 相关伏笔 + 实体名录（草稿由调用方另行带入） */
export async function buildCheckSlice(opts: { bookDir: string; card: Card; snapshot: Snapshot; state?: BookState }): Promise<string> {
  const { card, snapshot } = opts;
  const state = opts.state ?? (await loadBookState(path.resolve(opts.bookDir)));
  const ctx: RenderCtx = { snapshot, world: state.world, secrets: state.secrets.map((s) => s.secret) };
  const aliases = buildAliasIndex(aliasEntities(state));
  const n = chapterNo(card.id);
  const L: string[] = [];
  L.push(`# 校对切片：${card.id}「${card.title}」`, '');
  L.push('## 卡片', cap(renderCard(ctx, card), 4000).text, '');
  const ids = castOrder(card, ctx, aliases).filter((id) => snapshot.entities[id]);
  const ent: string[] = [];
  for (const id of ids) {
    const e = snapshot.entities[id];
    if (!e) continue;
    const al = (aliases.aliasesOf?.(id) ?? []).filter((a) => a !== e.name);
    ent.push(
      `- ${e.name}（${id}）${al.length ? `［别名：${al.join('、')}］` : ''}：${renderEntityState(ctx, id)}${(snapshot.knowledge[id] ?? []).length ? `；已知事实：${(snapshot.knowledge[id] ?? []).slice(-12).join('、')}` : ''}`,
    );
  }
  L.push('## 在场实体（写前状态）', fillBlocks(ent, 6000, '\n').text || '（无）', '');
  if (card.must_not.length) L.push('## 不得发生', card.must_not.map((c) => `- ${renderCondition(ctx, c)}`).join('\n'), '');
  const w = state.world;
  if (w?.vocab.conditions.length)
    L.push('## 受控状态词表（cond 只能用这些 id）', cap(w.vocab.conditions.map((c) => `- ${c.id}：${c.label}`).join('\n'), 2000).text, '');
  const obls = Object.values(snapshot.obligations)
    .filter((o) => o.status === 'open' || o.status === 'advanced')
    .sort((a, b) => {
      const pa = card.pays.includes(a.id) || card.advances.includes(a.id) ? 0 : a.weight === 'main' ? 1 : a.weight === 'major' ? 2 : 3;
      const pb = card.pays.includes(b.id) || card.advances.includes(b.id) ? 0 : b.weight === 'main' ? 1 : b.weight === 'major' ? 2 : 3;
      return pa - pb || (a.id < b.id ? -1 : 1);
    });
  if (obls.length) L.push('## 未回收伏笔（相关优先）', cap(obls.map((o) => `- ${o.id}［${o.weight}］${o.text}`).join('\n'), 2000).text, '');
  // 实体名录：主要角色 + 近期出场者（抽取时用正式 id）
  const defs = entityDefs(state);
  const roster = Object.values(snapshot.entities)
    .filter((e) => !ids.includes(e.id))
    .map((e) => ({ e, tier: defs.get(e.id)?.entity.tier ?? 'minor', ls: e.last_seen ? chapterNo(e.last_seen) : 0 }))
    .filter((x) => x.tier === 'major' || n - x.ls <= 30)
    .sort((a, b) => (a.tier === 'major' ? 0 : 1) - (b.tier === 'major' ? 0 : 1) || b.ls - a.ls || (a.e.id < b.e.id ? -1 : 1))
    .map((x) => {
      const al = (aliases.aliasesOf?.(x.e.id) ?? []).filter((a) => a !== x.e.name);
      return `- ${x.e.id}：${x.e.name}${al.length ? `（${al.join('、')}）` : ''}`;
    });
  if (roster.length) L.push('## 实体名录（其他）', cap(roster.join('\n'), 3000).text, '');
  return `${L.join('\n').replace(/\n+$/, '')}\n`;
}
