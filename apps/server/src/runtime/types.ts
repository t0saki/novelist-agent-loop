/**
 * 任务运行时契约（v3 流程，docs/v3/DESIGN.md §2、§10）。从旧流水线的 types 迁来并收窄。
 * TaskHandler = 一个 TaskKind 的全部业务逻辑；orchestrator 负责调度、路由、run 生命周期与提交。
 *
 * agent 任务（有 prepare 的 handler）的生命周期：
 *   handler.manifest(spec)                 → hard/soft deps（task id 与 stale check 的输入）
 *   [orchestrator] route → createRunSnapshot(base_commit)
 *   handler.prepare(ctx, task, run)        → { kind:'run', plan } | { kind:'skip', result }
 *   [orchestrator] 写根 AGENTS.md / ORDER.md → startRun → wait → 收稿（book/harvest.ts）
 *   handler.finalize(ctx, task, harvested) → TaskResult（含 promote / followups / inbox）
 *   [orchestrator] committer.promoteV3(result.promote) → 逐章提交 → db effect
 * 确定性任务（publish）：handler.execute(ctx, task) → TaskResult。
 */
import type { BookConfig, ErrorClass, InboxKind, Lane, Outcome, TaskKind } from '@novelist/shared';
import type { AppConfig, DataPaths } from '../config/index.js';
import type { Db } from '../db/client.js';
import type { tasks } from '../db/schema.js';
import type { Logger } from '../log.js';
import type { BookRepo } from '../book/repo.js';
import type { ResolvedGenre } from '../genres/index.js';
import type { RunLimits } from '../harness/types.js';
import type { DbEffect } from './effects.js';
import type { V3CommitPlan } from '../flow/types.js';

export type { V3CommitPlan } from '../flow/types.js';

export type TaskRow = typeof tasks.$inferSelect;

export interface PipelineDeps {
  db: Db;
  config: AppConfig;
  paths: DataPaths;
  log: Logger;
  now(): Date;
}

/** 打开的书（live 树）；每次任务开始时由 openBook 重新加载 */
export interface BookHandle {
  id: string;
  slug: string;
  dir: string;
  repo: BookRepo;
  config: BookConfig;
  genre: ResolvedGenre;
  headCommit: string;
}

export interface PipelineContext {
  deps: PipelineDeps;
  /** 无书任务为 null（现在只有测试用得到） */
  book: BookHandle | null;
}

/** 入队请求（task id 由 computeTaskId 计算，幂等：同 id 已存在则不重复创建） */
export interface TaskSpec {
  kind: TaskKind;
  bookId: string | null;
  /** book / through-N / cNNNNN / <其他> */
  target: string;
  lane?: Lane;
  role?: string | null;
  priority?: number;
  /**
   * handler 私有参数（不进 task id，只有 params.instance / params.mode 经 configHash 进入）。
   * 通用约定：instance = 同 kind/target 的实例号（重复派发时提供不同值才会得到新任务）。
   */
  params?: Record<string, unknown>;
  deps?: string[];
  notBefore?: string;
  parentTaskId?: string;
  maxAttempts?: number;
}

/** path → blob sha（'' = 不存在）。hard 变化 → 作废 */
export interface Manifest {
  hard: Record<string, string>;
  soft: Record<string, string>;
  /** 影响产物内容的配置 hash（实例号、模式、题材包版本、handler 自己的 extra） */
  configHash: string;
  /** @deprecated ignored; enqueue always writes [] (tests still pass it) */
  rebaseValidators?: string[];
}

/** 本次 run 的路径与路由结果（orchestrator 在 prepare 前填好） */
export interface RunContext {
  runId: string;
  attempt: number;
  runDir: string;
  /** $RUN/book（快照） */
  snapshotDir: string;
  /** $RUN/book/work/<task>/attempt-k/out */
  outDir: string;
  inDir: string;
  baseCommit: string;
  profileId: string;
  accountId: string | null;
  harness: string;
  model: string;
  role: string;
  /** @deprecated 路由不再降级；不写、不读（测试夹具里还带着 []） */
  degraded?: { from: string; to: string; reason: string }[];
}

/** handler.prepare 产出：根 AGENTS.md + ORDER.md + 启动语（没有回执 / schema / nonce） */
export interface AgentPlan {
  v3: { agentsMd: string; agentsBytes: number; claudeMd: string; orderMd: string; launchPrompt: string; stackHash: string; /** 各层字节数（超限提示用） */ layers?: { id: string; label: string; bytes: number }[] };
  limits?: Partial<RunLimits>;
  /** per-run effort override (wins over profile.effort) */
  effort?: 'low' | 'medium' | 'high';
}

export type PrepareResult = { kind: 'run'; plan: AgentPlan } | { kind: 'skip'; result: TaskResult };

/** run 结束、收稿之后交给 finalize 的材料 */
export interface HarvestedRun {
  run: RunContext;
  outcome: Outcome;
  /** 收稿清单（book/harvest.ts 的 changes.json；null = 没有收到任何改动）与本次 run 的幂等键 */
  v3: { manifestFile: string | null; lost: boolean; stderrTail: string; trailerKey: string; ownerCancelled: boolean; /** tool_call 事件数（runner；消化 pending 时取自 runs.outcome） */ toolSteps?: number };
}

export interface InboxInput {
  kind: InboxKind;
  bookId: string | null;
  title: string;
  body: Record<string, unknown>;
  actions: { id: string; label: string; danger?: boolean; needsNote?: boolean }[];
  dedupeKey?: string;
  relatedTaskId?: string;
}

/** committer 的输入：逐章提交计划 + 提交后的 DB 效果 */
export interface PromotePlan {
  bookId: string;
  taskId: string;
  runId: string | null;
  baseCommit: string;
  message: string;
  /** 除 Novelist-Task/-Run/-Harness/-Model/-Instructions/-Isolation 外的额外 trailer（committer 自动加前者） */
  trailers: Record<string, string>;
  tags: string[];
  /** 提交成功后在同一事务里执行的 DB 更新（可序列化，按名字重放） */
  effect?: DbEffect;
  /** 逐章提交计划（committer.promoteV3） */
  v3: V3CommitPlan;
  /** @deprecated ignored (flow/commit.ts#buildPromote still writes [] / false) */
  files?: never[];
  /** @deprecated ignored */
  resolveTmpIds?: false;
}

export type TaskStatus = 'done' | 'retry' | 'failed' | 'blocked' | 'waiting';

export interface TaskResult {
  status: TaskStatus;
  errorClass?: ErrorClass;
  message?: string;
  /** retry：何时再试；waiting：等待到何时 */
  retryAfter?: string;
  promote?: PromotePlan;
  followups?: TaskSpec[];
  inbox?: InboxInput[];
  /** 写入 tasks.result 供 UI 展示 */
  summary?: Record<string, unknown>;
}

export interface TaskHandler {
  kind: TaskKind;
  /** null = 确定性任务（不 spawn harness） */
  role: 'writer' | null;
  lane: Lane;
  maxAttempts: number;
  manifest(ctx: PipelineContext, spec: TaskSpec): Promise<Manifest>;
  /** 有 prepare = agent 任务（v3 的 run 生命周期：pending 收稿、逐章提交、classifyV3Run） */
  prepare?(ctx: PipelineContext, task: TaskRow, run: RunContext): Promise<PrepareResult>;
  finalize?(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult>;
  execute?(ctx: PipelineContext, task: TaskRow): Promise<TaskResult>;
}
