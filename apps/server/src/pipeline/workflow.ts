/**
 * 章节流水线状态机的持久部分（chapters.workflow，jsonb；DESIGN §6.4、IMPL §4）。Owner: lane E。
 * 只存位置与计数；草稿、delta 本体都在 live 树 work/（gitignored）。
 */
import { and, eq } from 'drizzle-orm';
import type { ChapterWorkflowState, Finding, GateResult, Lane, RoleId, TaskKind } from '@novelist/shared';
import { chapterId } from '@novelist/shared';
import { chapters } from '../db/schema.js';
import type { Db } from '../db/client.js';

export interface DraftRef {
  /** 相对书根：work/<task>/attempt-k/out/manuscript/cNNNNN.md */
  path: string;
  taskId: string;
  attempt: number;
  runId: string;
  harness?: string;
  model?: string;
  titleProposal?: string;
}

export interface DebtDraft {
  class: 'forward' | 'metric';
  rule: string;
  detail: string;
}

export interface WorkflowCounters {
  mech: number;
  canon: number;
  findings: number;
  formatRepair: number;
  rerun: number;
  confirm: number;
  deslop: number;
  formatcheck: number;
  pairwise: number;
}

export interface ChapterWorkflow {
  v: 1;
  /** 单调递增，写进 params.instance：同 kind 的多个实例拿到不同 task id */
  seq: number;
  tier: 'lite' | 'standard' | 'key';
  key: boolean;
  draft: DraftRef | null;
  /** 修订前的草稿（pairwise 对手、A 胜时恢复） */
  prevDraft: DraftRef | null;
  /** 当前已校验的 delta 路径（相对书根，work/ 下） */
  delta: string | null;
  prevDelta: string | null;
  /** 最近一次 extract/check 的目的模式 */
  lastExtractMode: 'full' | 'diff' | null;
  /** 上一次修订是 findings 模式（pairwise 只比较评审修订前后，mech/canon 修订不比） */
  pairwisePending: boolean;
  /** 待确认（confirm）合并的 pending delta 与问题 */
  pending: { path: string; questions: ConfirmQuestion[] } | null;
  /** 各 review 槽位结果路径（key 档多个；standard 一个） */
  reviews: { slot: string; path: string; role: string; profile: string; model: string; run: string }[];
  /** 最后一次评审发现（修订依据 / 耗尽策略） */
  findings: Finding[];
  counters: WorkflowCounters;
  lastGates: GateResult[];
  debts: DebtDraft[];
  degraded: { role: string; from: string; to: string; reason: string }[];
  verdict: 'pass' | 'accept_with_debt' | 'hold' | 'block' | null;
  /** 下一步（崩溃恢复时 nextTasks 重新派发） */
  next: { kind: TaskKind; params: Record<string, unknown>; role?: RoleId | null; lane?: Lane; priority?: number } | null;
  owner: { approved: boolean; notes: string[] };
}

export interface ConfirmQuestion {
  id: string;
  kind: 'reextract' | 'unmet_post' | 'recall';
  text: string;
}

export function newWorkflow(tier: ChapterWorkflow['tier'], key: boolean): ChapterWorkflow {
  return {
    v: 1,
    seq: 0,
    tier,
    key,
    draft: null,
    prevDraft: null,
    delta: null,
    prevDelta: null,
    lastExtractMode: null,
    pairwisePending: false,
    pending: null,
    reviews: [],
    findings: [],
    counters: { mech: 0, canon: 0, findings: 0, formatRepair: 0, rerun: 0, confirm: 0, deslop: 0, formatcheck: 0, pairwise: 0 },
    lastGates: [],
    debts: [],
    degraded: [],
    verdict: null,
    next: null,
    owner: { approved: false, notes: [] },
  };
}

export async function getChapterRow(db: Db, bookId: string, no: number) {
  const rows = await db
    .select()
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.no, no)))
    .limit(1);
  return rows[0] ?? null;
}

export async function loadWorkflow(db: Db, bookId: string, no: number, tier: ChapterWorkflow['tier'], key: boolean): Promise<ChapterWorkflow> {
  const row = await getChapterRow(db, bookId, no);
  const raw = row?.workflow as Partial<ChapterWorkflow> | undefined;
  if (raw?.v !== 1) return newWorkflow(tier, key);
  return { ...newWorkflow(tier, key), ...raw, counters: { ...newWorkflow(tier, key).counters, ...(raw.counters ?? {}) } };
}

export const chapterState = (state: ChapterWorkflowState): ChapterWorkflowState => state;
export const chapterRowId = chapterId;
