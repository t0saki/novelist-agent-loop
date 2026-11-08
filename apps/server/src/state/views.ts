/**
 * 派生视图（DESIGN §4.3）：确定性生成，有 golden test；不入库（gitignored）。Owner: lane B。
 * ctx.build 在 run 快照内调用 buildViews（基于 base_commit）；committer 验收后增量刷新 live 树 views/。
 */
import path from 'node:path';
import type { Snapshot } from '@novelist/shared';
import { chapterId, chapterNo } from '@novelist/shared';
import { buildAliasIndex } from '../context/alias.js';
import { atomicWrite } from '../book/repo.js';
import { P } from '../book/layout.js';
import { canonicalJson } from './canon.js';
import { aliasEntities, loadBookState, type BookState } from './load.js';
import { factText, nameOf, progressions, renderEntityState, renderOp, renderTime, type RenderCtx } from './render.js';
import { collectVoiceAnchors } from './voice.js';

export const VIEW_FILES = [
  'snapshot.json',
  'context-card.md',
  'cast.md',
  'obligations.md',
  'timeline.md',
  'knowledge.md',
  'relations.md',
  'patterns.md',
  'progress.md',
  'aliases.json',
] as const;
export type ViewFile = (typeof VIEW_FILES)[number];

/** 带缩进、键排序的 JSON（golden 友好） */
export function prettyCanonical(v: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(v)), null, 2)}\n`;
}

const TIER_ORDER: Record<string, number> = { major: 0, minor: 1, extra: 2 };

function ctxOf(state: BookState): RenderCtx {
  return { snapshot: state.snapshot, world: state.world, secrets: state.secrets.map((s) => s.secret) };
}

function throughNo(s: Snapshot): number {
  return s.through ? chapterNo(s.through) : 0;
}

/** 已出场实体中，按 tier + id 排序 */
function sortedEntityIds(state: BookState): string[] {
  const tier = new Map(state.entities.map((e) => [e.entity.id, e.entity.tier]));
  return Object.keys(state.snapshot.entities).sort((a, b) => {
    const ta = TIER_ORDER[tier.get(a) ?? 'minor'] ?? 1;
    const tb = TIER_ORDER[tier.get(b) ?? 'minor'] ?? 1;
    return ta - tb || (a < b ? -1 : a > b ? 1 : 0);
  });
}

function renderContextCard(state: BookState): string {
  const s = state.snapshot;
  const ctx = ctxOf(state);
  const L: string[] = ['# 当前状态卡', ''];
  L.push(`- 已验收至：${s.through ?? '（尚无）'}`);
  L.push(`- 累计字数：${s.total_cjk}`);
  L.push(`- 故事时间：${renderTime(s.time as Record<string, unknown> | undefined)}`);
  const open = Object.values(s.obligations).filter((o) => o.status === 'open' || o.status === 'advanced');
  L.push(`- 未回收伏笔：${open.length}`);
  L.push(`- 已收束弧：${s.arcs_resolved.length ? s.arcs_resolved.join('、') : '无'}`);
  L.push('', '## 主要角色');
  const tier = new Map(state.entities.map((e) => [e.entity.id, e.entity.tier]));
  for (const id of sortedEntityIds(state)) {
    if (tier.get(id) !== 'major') continue;
    L.push(`- **${nameOf(ctx, id)}**（${id}）：${renderEntityState(ctx, id)}`);
  }
  L.push('', '## 最近事件');
  for (const ev of s.events.slice(-10)) L.push(`- ${ev.ch} ${ev.what}${ev.who.length ? `（${ev.who.map((w) => nameOf(ctx, w)).join('、')}）` : ''}`);
  return `${L.join('\n')}\n`;
}

async function voiceAnchors(state: BookState, ids: string[], perEntity: number, lookback = 60): Promise<Map<string, { ch: string; quote: string }[]>> {
  const through = throughNo(state.snapshot);
  const chapters: { ch: string; text: string }[] = [];
  for (let n = through; n >= 1 && n > through - lookback; n--) {
    const t = await state.manuscript(n);
    if (t) chapters.push({ ch: chapterId(n), text: t });
  }
  return collectVoiceAnchors(chapters, buildAliasIndex(aliasEntities(state)), new Set(ids), perEntity);
}

async function renderCast(state: BookState): Promise<string> {
  const s = state.snapshot;
  const ctx = ctxOf(state);
  const defs = new Map(state.entities.map((e) => [e.entity.id, e.entity]));
  const ids = sortedEntityIds(state);
  const anchorsFor = ids.filter((id) => {
    const k = s.entities[id]?.kind;
    return k === 'character' && (defs.get(id)?.tier ?? 'minor') !== 'extra';
  });
  const anchors = await voiceAnchors(state, anchorsFor, 5);
  const L: string[] = ['# 人物与实体', ''];
  for (const id of ids) {
    const e = s.entities[id];
    if (!e) continue;
    const def = defs.get(id);
    L.push(`## ${e.name}（${id}）· ${e.kind}${def ? ` · ${def.tier}` : ''}`);
    const aliases = (def?.aliases ?? []).map((a) =>
      typeof a === 'string' ? a : `${a.text}${a.ambiguous ? '（歧义）' : ''}${a.scope?.pov ? `（仅 ${nameOf(ctx, a.scope.pov)} 视角）` : ''}`,
    );
    if (aliases.length) L.push(`- 别名：${aliases.join('、')}`);
    L.push(`- 状态：${renderEntityState(ctx, id)}`);
    L.push(`- 首次 / 最近出场：${e.first_seen ?? '—'} / ${e.last_seen ?? '—'}`);
    if (def) {
      const stageKeys = Object.keys(def.contract_by_stage ?? {});
      const cur =
        e.stage && def.contract_by_stage[e.stage]
          ? e.stage
          : (stageKeys
              .filter((k) => e.stage?.startsWith(k))
              .sort()
              .pop() ?? stageKeys.sort()[0]);
      const contract = cur ? def.contract_by_stage[cur] : undefined;
      if (contract) {
        L.push(
          `- 当前阶段契约（${cur}）：${contract.voice ? `语气：${contract.voice}` : ''}${contract.never.length ? `；绝不：${contract.never.join('、')}` : ''}${contract.limits.length ? `；底线：${contract.limits.join('、')}` : ''}`,
        );
      }
    }
    const prog = progressions(ctx, state.ledger, id, 5);
    if (prog.length) {
      L.push('- 最近变化：');
      for (const p of prog) L.push(`  - ${p.ch} ${p.text}`);
    }
    const q = anchors.get(id);
    if (q?.length) {
      L.push('- 代表台词：');
      for (const x of q) L.push(`  - “${x.quote}”（${x.ch}）`);
    }
    L.push('');
  }
  return `${L.join('\n').replace(/\n+$/, '')}\n`;
}

function renderObligations(state: BookState): string {
  const s = state.snapshot;
  const through = throughNo(s);
  const all = Object.values(s.obligations).sort((a, b) => (a.id < b.id ? -1 : 1));
  const open = all.filter((o) => o.status === 'open' || o.status === 'advanced');
  const overdue = open.filter((o) => o.due && chapterNo(o.due[1]) < through + 1);
  const L: string[] = ['# 伏笔账本', ''];
  L.push(
    `- 未回收：${open.length}｜逾期：${overdue.length}｜已回收：${all.filter((o) => o.status === 'paid').length}｜已放弃：${all.filter((o) => o.status === 'abandoned').length}`,
  );
  const row = (o: (typeof all)[number]) =>
    `| ${o.id} | ${o.weight} | ${o.kind} | ${o.status} | ${o.opened} | ${o.due ? `${o.due[0]}–${o.due[1]}` : '—'} | ${o.advances.length ? o.advances.join(' ') : '—'} | ${o.text.replace(/\|/g, '｜')} |`;
  const head = ['| id | 权重 | 类型 | 状态 | 埋设 | 期限 | 推进 | 内容 |', '|---|---|---|---|---|---|---|---|'];
  if (overdue.length) {
    L.push('', '## 逾期', ...head);
    for (const o of overdue.sort((a, b) => ((a.due?.[1] ?? '') < (b.due?.[1] ?? '') ? -1 : 1))) L.push(row(o));
  }
  L.push('', '## 未回收（按期限）', ...head);
  const byDue = [...open].sort((a, b) => {
    const da = a.due?.[1] ?? 'c99999';
    const db = b.due?.[1] ?? 'c99999';
    return da < db ? -1 : da > db ? 1 : a.id < b.id ? -1 : 1;
  });
  for (const o of byDue) L.push(row(o));
  const closed = all.filter((o) => o.status === 'paid' || o.status === 'abandoned').sort((a, b) => ((a.closed ?? '') < (b.closed ?? '') ? 1 : -1));
  if (closed.length) {
    L.push('', '## 最近收束', ...head);
    for (const o of closed.slice(0, 30)) L.push(row(o));
  }
  return `${L.join('\n')}\n`;
}

function renderTimeline(state: BookState): string {
  const ctx = ctxOf(state);
  const L: string[] = ['# 时间线', ''];
  for (const d of state.ledger) {
    const time = d.ops.filter((o) => o.op === 'time.advance');
    const evs = d.ops.filter((o) => o.op === 'event' || o.op === 'entity.retire' || o.op === 'arc.resolve');
    if (!time.length && !evs.length && !d.summary.length) continue;
    const t = time.map((o) => renderOp(ctx, o)).join('；');
    L.push(`## ${d.chapter}${t ? ` · ${t}` : ''}`);
    for (const o of evs) L.push(`- ${renderOp(ctx, o)}`);
    if (!evs.length && d.summary[0]) L.push(`- ${d.summary[0].s}`);
  }
  return `${L.join('\n')}\n`;
}

function renderKnowledge(state: BookState): string {
  const s = state.snapshot;
  const ctx = ctxOf(state);
  const L: string[] = ['# 认知', '', '## 事实'];
  for (const [id, f] of Object.entries(s.facts).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    L.push(`- ${id}（${f.since}）：${f.text}${f.overridden ? '［已更正］' : ''}`);
  L.push('', '## 谁知道什么');
  for (const who of Object.keys(s.knowledge).sort()) {
    const fs = s.knowledge[who] ?? [];
    if (!fs.length) continue;
    L.push(`### ${nameOf(ctx, who)}（${who}）`);
    for (const f of fs) L.push(`- ${f}：${factText(ctx, f)}`);
  }
  L.push('', '## 读者已知');
  for (const f of s.reader_knows) L.push(`- ${f}：${factText(ctx, f)}`);
  const secrets = state.secrets.map((x) => x.secret);
  if (secrets.length) {
    L.push('', '## 秘密（作者真相）');
    for (const sec of [...secrets].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const known = sec.fact ? s.reader_knows.includes(sec.fact) : false;
      L.push(
        `- ${sec.id}${sec.fact ? `（${sec.fact}）` : ''}：${known ? '读者已知' : '读者未知'}；知情者：${
          sec.fact
            ? Object.keys(s.knowledge)
                .filter((w) => (s.knowledge[w] ?? []).includes(sec.fact as string))
                .map((w) => nameOf(ctx, w))
                .join('、') || '无'
            : '—'
        }`,
      );
    }
  }
  return `${L.join('\n')}\n`;
}

function renderRelations(state: BookState): string {
  const ctx = ctxOf(state);
  const L: string[] = ['# 关系', '', '| A | B | 关系 | 自 |', '|---|---|---|---|'];
  const rels = [...state.snapshot.relations].sort((a, b) => (a.a + a.b < b.a + b.b ? -1 : 1));
  for (const r of rels) L.push(`| ${nameOf(ctx, r.a)}（${r.a}） | ${nameOf(ctx, r.b)}（${r.b}） | ${r.type} | ${r.since} |`);
  return `${L.join('\n')}\n`;
}

/** 实际写出的场面类型统计（来自 delta.realized_patterns） */
export function patternStats(
  state: Pick<BookState, 'ledger'>,
  beforeNo = Number.POSITIVE_INFINITY,
): { id: string; total: number; last10: number; last30: number; lastCh: string }[] {
  const ledger = state.ledger.filter((d) => chapterNo(d.chapter) < beforeNo);
  const n = ledger.length;
  const m = new Map<string, { id: string; total: number; last10: number; last30: number; lastCh: string }>();
  ledger.forEach((d, i) => {
    for (const p of new Set(d.realized_patterns ?? [])) {
      const x = m.get(p) ?? { id: p, total: 0, last10: 0, last30: 0, lastCh: d.chapter };
      x.total++;
      if (i >= n - 10) x.last10++;
      if (i >= n - 30) x.last30++;
      x.lastCh = d.chapter;
      m.set(p, x);
    }
  });
  return [...m.values()].sort((a, b) => b.last10 - a.last10 || b.last30 - a.last30 || b.total - a.total || (a.id < b.id ? -1 : 1));
}

function renderPatterns(state: BookState): string {
  const L: string[] = ['# 场面类型（实际写出）', '', '| 类型 | 近 10 章 | 近 30 章 | 全书 | 最近 |', '|---|---|---|---|---|'];
  for (const p of patternStats(state)) L.push(`| ${p.id} | ${p.last10} | ${p.last30} | ${p.total} | ${p.lastCh} |`);
  return `${L.join('\n')}\n`;
}

/** 里程碑完成度（compass.main_threads）：事件 id/描述引用里程碑 id，或列出它的卷已写完 → 完成 */
export function milestoneStatus(state: BookState): { thread: string; id: string; at: number; done: boolean; behind: boolean }[] {
  const s = state.snapshot;
  const target = state.config?.scale.target_cjk ?? state.compass?.scale.target_cjk ?? 0;
  const pos = target > 0 ? s.total_cjk / target : 0;
  const through = throughNo(s);
  const out: { thread: string; id: string; at: number; done: boolean; behind: boolean }[] = [];
  for (const t of state.compass?.main_threads ?? []) {
    for (const m of t.milestones) {
      const byEvent = s.events.some((e) => e.id === m.id || e.what.includes(m.id));
      const byVolume = state.volumes.some((v) => v.milestones_due.includes(m.id) && v.chapters && chapterNo(v.chapters[1]) <= through);
      const done = byEvent || byVolume;
      out.push({ thread: t.id, id: m.id, at: m.at, done, behind: !done && pos > m.at + 0.1 });
    }
  }
  return out;
}

function renderProgress(state: BookState): string {
  const s = state.snapshot;
  const through = throughNo(s);
  const target = state.config?.scale.target_cjk ?? state.compass?.scale.target_cjk ?? 0;
  const pos = target > 0 ? s.total_cjk / target : 0;
  const L: string[] = ['# 进度', ''];
  L.push(`- 已验收：${through} 章，${s.total_cjk} 字${target ? `（目标 ${target}，${(pos * 100).toFixed(1)}%）` : ''}`);
  L.push('', '## 分卷', '| 卷 | 标题 | 章节 | 已验收 |', '|---|---|---|---|');
  for (const v of state.volumes) {
    const [a, b] = v.chapters ? [chapterNo(v.chapters[0]), chapterNo(v.chapters[1])] : [0, -1];
    const done = v.chapters ? Math.max(0, Math.min(through, b) - a + 1) : 0;
    L.push(`| ${v.id} | ${v.title} | ${v.chapters ? `${v.chapters[0]}–${v.chapters[1]}` : '—'} | ${v.chapters ? `${done}/${b - a + 1}` : '—'} |`);
  }
  const ms = milestoneStatus(state);
  if (ms.length) {
    L.push('', '## 里程碑完成度 vs 字数位置', `当前位置：${(pos * 100).toFixed(1)}%`, '', '| 主线 | 里程碑 | 预期位置 | 状态 |', '|---|---|---|---|');
    for (const m of ms) L.push(`| ${m.thread} | ${m.id} | ${(m.at * 100).toFixed(0)}% | ${m.done ? '完成' : m.behind ? '落后' : '未到'} |`);
    // 文本曲线：每 10% 一格，● 已完成里程碑数 / ○ 预期数
    L.push('', '```');
    for (let p = 1; p <= 10; p++) {
      const x = p / 10;
      const expected = ms.filter((m) => m.at <= x).length;
      const done = ms.filter((m) => m.at <= x && m.done).length;
      L.push(`${String(p * 10).padStart(3)}% ${'●'.repeat(done)}${'○'.repeat(expected - done)}${x <= pos + 1e-9 ? '' : ' ·'}`);
    }
    L.push('```');
  }
  return `${L.join('\n')}\n`;
}

/** aliases.json：实体 → 名字与别名；文本 → 实体列表（歧义可见） */
export function aliasesJson(state: BookState): unknown {
  const entities: Record<string, { name: string; kind: string; aliases: { text: string; ambiguous: boolean; pov?: string }[] }> = {};
  const byText: Record<string, string[]> = {};
  const add = (text: string, id: string) => {
    byText[text] = [...new Set([...(byText[text] ?? []), id])].sort();
  };
  for (const { entity: e } of state.entities) {
    const aliases = (e.aliases ?? []).map((a) => {
      if (typeof a === 'string') return { text: a, ambiguous: false };
      const x: { text: string; ambiguous: boolean; pov?: string } = { text: a.text, ambiguous: !!a.ambiguous };
      if (a.scope?.pov) x.pov = a.scope.pov;
      return x;
    });
    for (const idn of e.identities ?? []) aliases.push({ text: idn.alias, ambiguous: false });
    entities[e.id] = { name: e.name, kind: e.kind, aliases };
    add(e.name, e.id);
    for (const a of aliases) add(a.text, e.id);
  }
  // 账本中新登场（尚未写成实体文件）的实体
  for (const d of state.ledger) {
    for (const op of d.ops) {
      if (op.op !== 'entity.create' || entities[op.ent]) continue;
      entities[op.ent] = { name: op.name, kind: op.kind, aliases: (op.aliases ?? []).map((t) => ({ text: t, ambiguous: false })) };
      add(op.name, op.ent);
      for (const t of op.aliases ?? []) add(t, op.ent);
    }
  }
  return { schema: 'nv.aliases/1', entities, texts: byText };
}

/** 纯渲染：BookState → 全部视图文本（golden test 用） */
export async function renderViews(state: BookState): Promise<Record<ViewFile, string>> {
  return {
    'snapshot.json': prettyCanonical(state.snapshot),
    'context-card.md': renderContextCard(state),
    'cast.md': await renderCast(state),
    'obligations.md': renderObligations(state),
    'timeline.md': renderTimeline(state),
    'knowledge.md': renderKnowledge(state),
    'relations.md': renderRelations(state),
    'patterns.md': renderPatterns(state),
    'progress.md': renderProgress(state),
    'aliases.json': prettyCanonical(aliasesJson(state)),
  };
}

/** 读取书根（或快照）的规范文件 → fold → 写 views/*；返回 snapshot 与写出的文件 */
export async function buildViews(bookDir: string, opts?: { through?: number }): Promise<{ snapshot: Snapshot; written: string[] }> {
  const state = await loadBookState(bookDir, opts?.through === undefined ? {} : { through: opts.through });
  const views = await renderViews(state);
  const written: string[] = [];
  for (const name of VIEW_FILES) {
    const rel = P.view(name);
    await atomicWrite(path.join(state.dir, rel), views[name]);
    written.push(rel);
  }
  return { snapshot: state.snapshot, written };
}
