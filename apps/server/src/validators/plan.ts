/** 规划 validators（DESIGN §6.2）：谓词语法、每卡有 title、编号连续、伏笔窗口、弧指纹相似度、里程碑落后。Owner: lane D。 */
import type { Arc, ArcFingerprint, Card, Compass, Finding, Snapshot, Volume } from '@novelist/shared';
import { chapterId, chapterNo, zCardCondition, zDeltaOp, zPredicate } from '@novelist/shared';
import { isOpPattern, loadBookState, projectBuffer } from '../state/index.js';
import { finding } from './util.js';

export interface PlanValidationInput {
  compass: Compass | null;
  volumes: Volume[];
  arcs: Arc[];
  cards: Card[];
  snapshot: Snapshot;
  fingerprints: ArcFingerprint[];
  /** 本次新增/修改的文件（相对书根） */
  changed: string[];
  /** 弧指纹相似度拒收阈值（默认 0.85） */
  fingerprintThreshold?: number;
}

const OP_NAMES = new Set<string>(zDeltaOp.options.map((o) => o.shape.op.value));
const DEFAULT_FP_THRESHOLD = 0.85;
const MIN_FP_TOKENS = 5;
const MILESTONE_LAG = 0.1;

type Add = (severity: 'hard' | 'soft', category: string, message: string) => void;

function collector(): { hard: Finding[]; soft: Finding[]; add: Add } {
  const hard: Finding[] = [];
  const soft: Finding[] = [];
  const counters = new Map<string, number>();
  const add: Add = (severity, category, message) => {
    const n = (counters.get(category) ?? 0) + 1;
    counters.set(category, n);
    (severity === 'hard' ? hard : soft).push(finding(`${category}#${n}`, severity, category, message));
  };
  return { hard, soft, add };
}

function checkConditions(card: Card, add: Add): void {
  for (const field of ['pre', 'post', 'must_not'] as const) {
    for (const cond of card[field]) {
      if (!zCardCondition.safeParse(cond).success) add('hard', 'predicate.syntax', `${card.id}.${field} 的条件不合法`);
      else if (isOpPattern(cond) && !OP_NAMES.has(cond.op)) add('hard', 'predicate.op', `${card.id}.${field} 使用了未知 op：${cond.op}`);
    }
  }
}

/** 卡片编号连续（只检查给定的卡）、title 非空、beat id 不重复、条件合法 */
function checkCards(cards: Card[], add: Add): void {
  const sorted = [...cards].sort((a, b) => (a.id < b.id ? -1 : 1));
  sorted.forEach((card, i) => {
    if (card.title.trim().length === 0) add('hard', 'card.title', `${card.id} 缺少 title`);
    const ids = card.beats.map((b) => b.id);
    if (new Set(ids).size !== ids.length) add('hard', 'card.beats', `${card.id} 的 beat id 重复`);
    if (card.length) {
      const sum = card.beats.reduce((a, b) => a + b.cjk, 0);
      if (sum < card.length.min * 0.8 || sum > card.length.max * 1.2) add('soft', 'card.beat_budget', `${card.id} 的 beat 预算合计 ${sum} 与长度区间不符`);
    }
    checkConditions(card, add);
    const prev = sorted[i - 1];
    if (prev) {
      const gap = chapterNo(card.id) - chapterNo(prev.id);
      if (gap === 0) add('hard', 'card.duplicate', `卡片编号重复：${card.id}`);
      else if (gap > 1) add('hard', 'card.numbering', `卡片编号不连续：${prev.id} → ${card.id}`);
    }
  });
}

/** 弧章节区间连续、卡片在区间内、resolve_by 在区间内、引用存在 */
function checkStructure(volumes: Volume[], arcs: Arc[], cards: Card[], add: Add): void {
  const sorted = [...arcs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const volumeIds = new Set(volumes.map((v) => v.id));
  sorted.forEach((arc, i) => {
    if (volumes.length && !volumeIds.has(arc.volume)) add('hard', 'arc.volume', `${arc.id} 引用了不存在的卷 ${arc.volume}`);
    if (arc.chapters[0] > arc.chapters[1]) add('hard', 'arc.range', `${arc.id} 的章节区间颠倒`);
    if (arc.resolve_by < arc.chapters[0] || arc.resolve_by > arc.chapters[1]) add('hard', 'arc.resolve_by', `${arc.id} 的 resolve_by 不在章节区间内`);
    const prev = sorted[i - 1];
    if (prev) {
      const expected = chapterId(chapterNo(prev.chapters[1]) + 1);
      if (arc.chapters[0] < expected) add('hard', 'arc.overlap', `${prev.id} 与 ${arc.id} 的章节区间重叠`);
      else if (arc.chapters[0] > expected) add('hard', 'arc.gap', `${prev.id} 与 ${arc.id} 之间缺少章节`);
    }
  });
  const arcById = new Map(arcs.map((a) => [a.id, a]));
  for (const card of cards) {
    if (volumes.length && !volumeIds.has(card.volume)) add('hard', 'card.volume', `${card.id} 引用了不存在的卷 ${card.volume}`);
    if (arcs.length === 0) continue;
    const arc = arcById.get(card.arc);
    if (!arc) add('hard', 'card.arc', `${card.id} 引用了不存在的弧 ${card.arc}`);
    else if (card.id < arc.chapters[0] || card.id > arc.chapters[1]) add('hard', 'card.arc_range', `${card.id} 不在 ${arc.id} 的区间内`);
  }
}

/** 伏笔窗口：回收引用存在、未收束、在 due 窗口内 */
export function checkObligationWindows(cards: Card[], snapshot: Snapshot, add: Add): void {
  const opened = new Set<string>();
  const sorted = [...cards].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const o of Object.values(snapshot.obligations)) {
    if (o.due && o.due[0] > o.due[1]) add('hard', 'obligation.due', `伏笔 ${o.id} 的 due 窗口颠倒`);
  }
  for (const card of sorted) {
    for (const id of card.pays) {
      const o = snapshot.obligations[id];
      if (!o && !opened.has(id)) add('hard', 'obligation.pay_unknown', `${card.id} 回收了未埋设的伏笔 ${id}`);
      else if (o && (o.status === 'paid' || o.status === 'abandoned')) add('hard', 'obligation.pay_closed', `${card.id} 回收了已收束的伏笔 ${id}`);
      else if (o?.due && (card.id < o.due[0] || card.id > o.due[1])) add('soft', 'obligation.window', `${card.id} 回收 ${id} 超出窗口 ${o.due[0]}–${o.due[1]}`);
    }
    for (const c of card.post) {
      if (isOpPattern(c) && c.op === 'obligation.open' && typeof c.id === 'string') opened.add(c.id);
    }
    for (const m of card.may_open) opened.add(m);
  }
}

function featureTokens(features: ArcFingerprint['features']): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(features)) {
    if (Array.isArray(v)) for (const x of v) out.add(`${k}=${x}`);
    else out.add(`${k}=${v}`);
  }
  return out;
}

function fingerprintSimilarity(a: ArcFingerprint, b: ArcFingerprint): number {
  if (a.vector.length > 0 && a.vector.length === b.vector.length) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    a.vector.forEach((x, i) => {
      const y = b.vector[i] as number;
      dot += x * y;
      na += x * x;
      nb += y * y;
    });
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }
  const ta = featureTokens(a.features);
  const tb = featureTokens(b.features);
  if (ta.size < MIN_FP_TOKENS || tb.size < MIN_FP_TOKENS) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / (ta.size + tb.size - common);
}

/** 由弧与其卡片推导指纹特征（audit.arc 落盘时也应使用，保证新旧可比） */
export function arcFingerprintFeatures(arc: Arc, cards: Card[]): ArcFingerprint['features'] {
  const inArc = cards.filter((c) => c.arc === arc.id);
  return {
    strands: [...new Set([...arc.strands, ...inArc.flatMap((c) => c.strands)])].sort(),
    modes: [...new Set(inArc.flatMap((c) => c.beats.map((b) => b.mode)))].sort(),
    stages: arc.character_stages.map((s) => s.to).sort(),
    chapters: inArc.length,
    opens: arc.opens.length,
    pays: arc.pays.length,
  };
}

function checkFingerprints(input: PlanValidationInput, add: Add): void {
  const threshold = input.fingerprintThreshold ?? DEFAULT_FP_THRESHOLD;
  for (const arc of input.arcs) {
    if (!input.changed.some((p) => p === arc.id || p === `plan/arcs/${arc.id}.yaml`)) continue;
    const stored = input.fingerprints.find((fp) => fp.arc === arc.id);
    const current: ArcFingerprint = stored ?? {
      schema: 'nv.arcfp/1',
      arc: arc.id,
      ts: '',
      features: arcFingerprintFeatures(arc, input.cards),
      vector: [],
    };
    for (const old of input.fingerprints) {
      if (old.arc === arc.id) continue;
      const sim = fingerprintSimilarity(current, old);
      if (sim > threshold) add('hard', 'arc.fingerprint', `${arc.id} 与历史弧 ${old.arc} 的指纹相似度 ${sim.toFixed(2)} 超过阈值 ${threshold}`);
    }
  }
}

function checkMilestones(input: PlanValidationInput, add: Add): void {
  const { compass, snapshot, volumes, arcs } = input;
  if (!compass) return;
  const milestones = compass.main_threads.flatMap((t) => t.milestones);
  if (milestones.length === 0 || compass.scale.target_cjk <= 0) return;
  const position = snapshot.total_cjk / compass.scale.target_cjk;
  const resolved = new Set(snapshot.arcs_resolved);
  const finishedVolume = (v: Volume): boolean => {
    const own = arcs.filter((a) => a.volume === v.id);
    return own.length > 0 && own.every((a) => resolved.has(a.id));
  };
  const doneByVolume = new Set(volumes.filter(finishedVolume).flatMap((v) => v.milestones_due));
  const doneByEvent = new Set(snapshot.events.map((e) => e.id));
  const done = milestones.filter((m) => doneByVolume.has(m.id) || doneByEvent.has(m.id)).length;
  const expected = milestones.filter((m) => m.at <= position).length / milestones.length;
  const actual = done / milestones.length;
  if (expected - actual > MILESTONE_LAG) add('soft', 'milestone.lag', `里程碑完成度 ${actual.toFixed(2)} 落后字数位置 ${expected.toFixed(2)} 超过 10%`);
  if (snapshot.through) {
    for (const arc of arcs) {
      if (arc.resolve_by <= snapshot.through && !resolved.has(arc.id)) add('soft', 'arc.overdue', `${arc.id} 已到 resolve_by 仍未收束`);
    }
  }
}

export function validatePlan(input: PlanValidationInput): { ok: boolean; hard: Finding[]; soft: Finding[] } {
  const { hard, soft, add } = collector();
  checkCards(input.cards, add);
  checkStructure(input.volumes, input.arcs, input.cards, add);
  checkObligationWindows(input.cards, input.snapshot, add);
  checkFingerprints(input, add);
  checkMilestones(input, add);
  if (input.compass) {
    for (const p of input.compass.ending.final_state) {
      if (!zPredicate.safeParse(p).success) add('hard', 'predicate.syntax', 'compass.ending.final_state 含不合法谓词');
    }
    for (const id of input.compass.ending.required_closures) {
      if (!input.snapshot.obligations[id] && !input.cards.some((c) => c.may_open.includes(id))) {
        add('soft', 'compass.closure_unknown', `ending.required_closures 中的 ${id} 尚未埋设`);
      }
    }
  }
  return { ok: hard.length === 0, hard, soft };
}

type RebaseValidator = (bookDir: string, target: string) => Promise<{ ok: boolean; reason?: string }>;

const targetNo = (target: string): number | null => {
  const m = /c(\d{5})/.exec(target);
  return m ? Number.parseInt(m[1] as string, 10) : null;
};

/** 缓冲区内（账本之后）到 target 章（默认到全部）的卡片 */
async function loadBuffer(bookDir: string, target: string) {
  const state = await loadBookState(bookDir, { noCache: true });
  const through = state.snapshot.through ? chapterNo(state.snapshot.through) : 0;
  const to = targetNo(target) ?? 99999;
  const cards = await state.files.cards(through + 1, to);
  return { state, cards };
}

const firstFailure = (findings: Finding[]): { ok: boolean; reason?: string } =>
  findings.length === 0 ? { ok: true } : { ok: false, reason: findings.map((f) => f.message).join('；') };

/** 命名的 rebase validator（tasks.rebase_validators 中的字符串 → 函数），stale check soft 依赖变化时在 HEAD 上重跑 */
export const REBASE_VALIDATORS: Record<string, RebaseValidator> = {
  'card.projected_pre': async (bookDir, target) => {
    const { state, cards } = await loadBuffer(bookDir, target);
    const { stale } = projectBuffer(state.snapshot, cards, { entities: state.entities.map((e) => e.entity) });
    return stale.length === 0 ? { ok: true } : { ok: false, reason: stale.map((s) => `${s.card}: ${s.reasons.join(',')}`).join('；') };
  },
  'card.obligation_window': async (bookDir, target) => {
    const { state, cards } = await loadBuffer(bookDir, target);
    const { hard, add } = collector();
    checkObligationWindows(cards, state.snapshot, add);
    return firstFailure(hard);
  },
  'plan.numbering': async (bookDir, target) => {
    const { state, cards } = await loadBuffer(bookDir, target);
    const { hard, add } = collector();
    checkCards(cards, add);
    checkStructure(state.volumes, state.arcs, cards, add);
    return firstFailure(hard);
  },
};
