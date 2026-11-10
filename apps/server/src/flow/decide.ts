/**
 * v3：一本书的下一步（docs/v3/DESIGN.md §2、§5；p1-plan §2.3）。纯函数，表驱动测试。
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
  /** book.open/book.write in LIVE states (computed by nextTasksV3 from the tasks table, not from BookRuntimeState) */
  activeFlowTask: boolean;
  /** meta.v3.pending set */
  pending: boolean;
}

export type FlowStep =
  | { kind: 'none'; reason: 'inactive' | 'busy' | 'buffer_full' | 'completed' }
  | { kind: 'open'; mode: 'open-short' | 'open-long'; count: number }
  | { kind: 'write'; mode: 'write' | 'finale'; from: number; count: number };

export function decideNext(s: FlowState): FlowStep {
  // 1. 只有 planning / active 的书才排班
  if (s.status !== 'planning' && s.status !== 'active') return { kind: 'none', reason: s.status === 'completed' ? 'completed' : 'inactive' };
  // 2. 一本书同时只有一个 v3 任务
  if (s.activeFlowTask) return { kind: 'none', reason: 'busy' };
  // 3. 还没有任何章节：开书
  if (s.accepted === 0) return s.length === 'short' ? { kind: 'open', mode: 'open-short', count: s.planned } : { kind: 'open', mode: 'open-long', count: s.batch };
  // 4. 存稿满了就停（有未收完的稿时照样提出任务：执行任务才会消化 pending，且不会再开新 run）
  if (!s.pending && (s.productionPaused || s.accepted - s.published >= s.maxBuffer)) return { kind: 'none', reason: 'buffer_full' };
  // 5. 写作批 / 结局批
  const from = s.accepted + 1;
  const remaining = s.planned - s.accepted;
  if (s.length === 'short' || remaining <= s.batch) return { kind: 'write', mode: 'finale', from, count: Math.max(remaining, 1) };
  return { kind: 'write', mode: 'write', from, count: s.batch };
}

/** 开书（两种）用 effort.open，写作批用 effort.write，结局批用 effort.finale */
export function effortFor(step: FlowStep, cfg: V3BookConfig): 'low' | 'medium' | 'high' {
  if (step.kind === 'open') return cfg.effort.open;
  if (step.kind === 'write') return step.mode === 'finale' ? cfg.effort.finale : cfg.effort.write;
  return cfg.effort.write;
}
