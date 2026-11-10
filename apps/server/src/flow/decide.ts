/**
 * v3：一本书的下一步（docs/v3/DESIGN.md §2、§5、§8.2；p1-plan §2.3，p2-plan §3.1）。纯函数，表驱动测试。
 */
import type { V3BookConfig, V3Length } from '@novelist/shared';

export interface FlowState {
  /** books.status */
  status: string;
  accepted: number;
  published: number;
  planned: number;
  batch: number;
  length: V3Length;
  maxBuffer: number;
  productionPaused: boolean;
  /** book.open/book.write/book.retro in LIVE states (computed by nextTasksV3 from the tasks table, not from BookRuntimeState) */
  activeFlowTask: boolean;
  /** meta.v3.pending set */
  pending: boolean;
  // ── phase 2 ──
  /** settings.v3.runawayFactor（0 = 关闭失控兜底） */
  factor?: number;
  /** meta.v3.runawayBatches */
  runawayBatches?: number;
  /** long/epic and RETRO_EVERY landed batches since the last retro */
  retroDue?: boolean;
  /** every batch since the last retro (≤ RETRO_EVERY + 1); null when the book moved since the last landing */
  retroRange?: { from: number; to: number } | null;
  /** a waiting owner rewrite request (WP-2) */
  ownerRequestWaiting?: boolean;
  /** owner-side plan: max(planned_chapters_initial, plannedFloor) */
  runawayBase?: number;
  /** 上次复盘以来写完的批数（batchLog 里 afterBatches 之后、kind 不是 adopt 的条数） */
  sinceRetro?: number;
  /** meta.v3.rewinding set (WP-2) */
  rewinding?: boolean;
  /** meta.v3.finaleNoMarker：上一个结局批没写（全书完）的次数（> 0 时结局批不再越过存稿上限） */
  finaleNoMarker?: number;
}

export type FlowStep =
  | { kind: 'none'; reason: 'inactive' | 'busy' | 'buffer_full' | 'completed' | 'rewinding' }
  | { kind: 'open'; mode: 'open-short' | 'open-long'; count: number }
  | { kind: 'retro'; from: number; to: number }
  | { kind: 'write'; mode: 'write' | 'finale'; phase: 'normal' | 'closing'; forced: boolean; from: number; count: number };

/** 长篇 / 超长：每写完这么多批做一次复盘 */
export const RETRO_EVERY = 4;
/** 剩余计划章数 ≤ 这么多批：收尾阶段 */
export const CLOSING_BATCHES = 3;
/** 达到 factor × 基准后再写这么多批仍未完结：下一批强制收尾 */
export const RUNAWAY_GRACE_BATCHES = 2;
/** × factor：写作批里提醒“三批内收尾”（factor 2 → 1.5 倍） */
export const RUNAWAY_WARN_RATIO = 0.75;
/** 剩余计划章数不超过一批半：直接并成一个结局批（DESIGN 附录：实测的 1 章结局批） */
export const FINALE_MERGE_RATIO = 1.5;

/** 一个结局批最多写的章数（短篇除外：短篇的结局批就是“写完全书”） */
export const finaleMergeMax = (batch: number): number => Math.max(1, Math.floor(FINALE_MERGE_RATIO * batch));

export interface EndingInput {
  length: V3Length;
  accepted: number;
  planned: number;
  runawayBase: number;
  batch: number;
  factor: number;
  runawayBatches: number;
}

export interface EndingPhase {
  mode: 'write' | 'finale';
  phase: 'normal' | 'closing';
  forced: boolean;
  runawayWarn: boolean;
  remaining: number;
}

/** 失控兜底的基准：主人一侧的计划章数（作者改 outline.md 移动不了它） */
export function runawayBaseOf(n0: number, plannedFloor: number | null | undefined): number {
  return Math.max(n0, plannedFloor ?? 0);
}

/**
 * 失控兜底的触发线：factor × max(基准, ⌈计划/2⌉)。作者合法的计划最多到基准的两倍（见 plannedUpper），
 * 所以兜底不会在一本按计划写的书写到计划之前开始。map.ts 的失控计数用同一个函数。
 */
export function runawayOver(accepted: number, factor: number, runawayBase: number, planned: number): boolean {
  return factor > 0 && accepted >= factor * Math.max(runawayBase, Math.ceil(planned / 2));
}

/**
 * 作者可以把计划章数加到多少（开书任务单的 planned_max、收稿时 outline.md 的上限夹取、书页改目标共用）：
 * 默认 2·N0；开着失控兜底时不超过“提醒线 + 三批”，这样提醒“三批之内收尾”时计划里剩下的也不会超过三批。
 */
export function plannedUpper(n0: number, plannedFloor: number | null | undefined, factor: number, batch: number): number {
  const base = runawayBaseOf(n0, plannedFloor);
  const cap = factor > 0 ? Math.min(2 * n0, Math.ceil(RUNAWAY_WARN_RATIO * factor * base) + CLOSING_BATCHES * Math.max(1, batch)) : 2 * n0;
  return Math.max(cap, plannedFloor ?? 0, 1);
}

/** 结局批写几章：剩余计划章数（至少 1）；中篇以上不超过一批半（被强制收尾的也一样） */
export function finaleCount(length: V3Length, remaining: number, batch: number): number {
  const n = Math.max(remaining, 1);
  return length === 'short' ? n : Math.min(n, finaleMergeMax(batch));
}

/**
 * 结局批不受存稿上限限制（DESIGN 附录：差一批就完结的书不该被存稿卡上好几天）。
 * 只放行第一次：上一个结局批没写（全书完）时（finaleNoMarker > 0；失控兜底关着时会一直按结局批写）照常受存稿上限约束。
 */
export function finaleBypassesBuffer(mode: 'write' | 'finale', finaleNoMarker: number | undefined): boolean {
  return mode === 'finale' && (finaleNoMarker ?? 0) === 0;
}

/** 结局控制（DESIGN §5）：按章数判断，字数只管下限 */
export function endingPhase(s: EndingInput): EndingPhase {
  const remaining = s.planned - s.accepted;
  const over = runawayOver(s.accepted, s.factor, s.runawayBase, s.planned);
  const forced = over && s.runawayBatches >= RUNAWAY_GRACE_BATCHES;
  const mode = s.length === 'short' || forced || remaining <= finaleMergeMax(s.batch) ? 'finale' : 'write';
  const phase = mode === 'write' && s.length !== 'short' && remaining <= CLOSING_BATCHES * s.batch ? 'closing' : 'normal';
  const runawayWarn = mode === 'write' && s.factor > 0 && s.accepted >= Math.ceil(RUNAWAY_WARN_RATIO * s.factor * s.runawayBase);
  return { mode, phase, forced, runawayWarn, remaining };
}

export function decideNext(s: FlowState): FlowStep {
  // 1. 只有 planning / active 的书才排班
  if (s.status !== 'planning' && s.status !== 'active') return { kind: 'none', reason: s.status === 'completed' ? 'completed' : 'inactive' };
  // 2. 一本书同时只有一个 v3 任务；回退进行中什么都不排
  if (s.activeFlowTask) return { kind: 'none', reason: 'busy' };
  if (s.rewinding) return { kind: 'none', reason: 'rewinding' };
  // 3. 还没有任何章节：开书
  if (s.accepted === 0) return s.length === 'short' ? { kind: 'open', mode: 'open-short', count: s.planned } : { kind: 'open', mode: 'open-long', count: s.batch };
  // 4. 结局控制先算：结局批不受存稿上限限制，复盘也不抢在结局批前面
  const from = s.accepted + 1;
  const e = endingPhase({
    length: s.length,
    accepted: s.accepted,
    planned: s.planned,
    runawayBase: s.runawayBase ?? s.planned,
    batch: s.batch,
    factor: s.factor ?? 0,
    runawayBatches: s.runawayBatches ?? 0,
  });
  const finaleFirst = finaleBypassesBuffer(e.mode, s.finaleNoMarker);
  // 5. 存稿满了就停（有未收完的稿、主人要求改写、下一批是结局批时照样提出任务：执行任务才会消化 pending，且不会再开新 run）
  const ownerReq = s.ownerRequestWaiting === true;
  const bufferStop = !s.pending && !ownerReq && !finaleFirst && (s.productionPaused || s.accepted - s.published >= s.maxBuffer);
  // 6. 复盘：存稿满了立刻做；还要写的书先写下一批，那一批入库后（sinceRetro = RETRO_EVERY + 1）再做
  if (s.retroDue && !s.pending && !ownerReq && !finaleFirst && s.retroRange && (bufferStop || (s.sinceRetro ?? 0) >= RETRO_EVERY + 1)) {
    return { kind: 'retro', from: s.retroRange.from, to: s.retroRange.to };
  }
  if (bufferStop) return { kind: 'none', reason: 'buffer_full' };
  // 7. 写作批 / 结局批
  return { kind: 'write', mode: e.mode, phase: e.phase, forced: e.forced, from, count: e.mode === 'finale' ? finaleCount(s.length, e.remaining, s.batch) : s.batch };
}

/** 开书用 effort.open，复盘用 effort.retro，结局批和收尾阶段的写作批用 effort.finale，其余写作批用 effort.write */
export function effortFor(step: FlowStep, cfg: V3BookConfig): 'low' | 'medium' | 'high' {
  if (step.kind === 'open') return cfg.effort.open;
  if (step.kind === 'retro') return cfg.effort.retro;
  if (step.kind === 'write') return step.mode === 'finale' || step.phase === 'closing' ? cfg.effort.finale : cfg.effort.write;
  return cfg.effort.write;
}
