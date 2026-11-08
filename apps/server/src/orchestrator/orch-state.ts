/**
 * orchestrator 在 tasks.params._orch 里保存的私有状态（IMPL §1.3：用现有 jsonb 扩展列）。Owner: lane F。
 * handler 永远看不到 / 不依赖这个键（E 从 params 读自己的字段）。
 */
import type { TaskRow } from '../pipeline/types.js';

export interface OrchTaskState {
  /** 本任务避开的 profile（output_contract 2 次、模型不可用、配置错误） */
  avoidProfiles?: string[];
  /** refusal 跨厂商重试时避开的厂商 */
  avoidVendors?: string[];
  /** 瞬时错误（overloaded/network）累计次数：决定退避，不消耗 attempt */
  transient?: number;
  /** 各 ErrorClass 的累计次数 */
  classCounts?: Record<string, number>;
  /** 每个 profile 的 output_contract 次数 */
  contractFailures?: Record<string, number>;
  /** 每个 profile 的 TAIL nonce 缺失次数 */
  tailMissing?: Record<string, number>;
  /** 附笔记重写：追加进 L3.9 的 owner 笔记 */
  ownerNotes?: { source: string; text: string }[];
  /** 重写代数：>1 时 commit trailer 带 .g<n>（否则幂等检查会把重写当成已提交） */
  generation?: number;
  /** 崩溃恢复：'replay' 只重放 dbEffects；'repromote' 重新提交 */
  recover?: { mode: 'replay' | 'repromote'; commit?: string };
  /** dbEffects 已执行到的 commit（exactly-once） */
  effectsCommit?: string;
  /** outbox：followups/inbox/onTaskDone 还没投递 */
  outbox?: boolean;
  /** 章内写手厂商缓存（vendor_ne_writer） */
  writerVendor?: string;
}

export function orchOf(task: Pick<TaskRow, 'params'>): OrchTaskState {
  const raw = (task.params ?? {})._orch;
  return raw && typeof raw === 'object' ? (raw as OrchTaskState) : {};
}

export function withOrch(params: Record<string, unknown> | null | undefined, patch: Partial<OrchTaskState>): Record<string, unknown> {
  const p = { ...(params ?? {}) };
  const cur = p._orch && typeof p._orch === 'object' ? (p._orch as OrchTaskState) : {};
  const next: Record<string, unknown> = { ...cur, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  p._orch = next;
  return p;
}

/** commit trailer Novelist-Task 的值：第 1 代 = task id；重写第 n 代 = <id>.g<n> */
export function taskTrailerValue(taskId: string, generation: number | undefined): string {
  return generation && generation > 1 ? `${taskId}.g${generation}` : taskId;
}

/** 从 target 解析章号（c00421 → 421） */
export function chapterNoOf(target: string): number | null {
  const m = /^c(\d+)/.exec(target);
  return m ? Number(m[1]) : null;
}
