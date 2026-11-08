/**
 * 流水线契约（DESIGN §6.4、§7.2、附录 B）。Owner: lane E。
 * TaskHandler = 一个 TaskKind 的全部业务逻辑；orchestrator（lane F）负责调度、路由、配额、run 生命周期与提交。
 *
 * 一个 agent 任务的生命周期（F 调用 E 的顺序）：
 *   handler.manifest(spec)                       → hard/soft deps（task id 与 stale check 的输入）
 *   [F] route → reserve quota → createRunSnapshot(base_commit) → buildViews(snapshot)
 *   handler.prepare(ctx, task, run)              → { kind:'run', plan } | { kind:'skip', result }
 *   [F] resolveStack+compile（指令）→ adapter.* → startRun → wait → harvestOut
 *   handler.finalize(ctx, task, harvested)       → TaskResult（含 promote / followups / inbox / chapter 索引更新）
 *   [F] committer.promote(result.promote)        → stale check / rebase(handler.rebase) → commit → dbEffects
 *   [F] 入队 followups，结算配额，移除快照
 * 确定性任务：handler.execute(ctx, task) → TaskResult（同样经 committer）。
 */
import type {
  ArtifactDecl,
  BookConfig,
  ErrorClass,
  InboxKind,
  Lane,
  Outcome,
  QualityTier,
  RoleId,
  TaskKind,
  WorkOrderFrontmatter,
  ChapterWorkflowState,
} from '@novelist/shared';
import type { AppConfig, DataPaths } from '../config/index.js';
import type { Db, Tx } from '../db/client.js';
import type { tasks } from '../db/schema.js';
import type { Logger } from '../log.js';
import type { BookRepo, FileChange } from '../book/repo.js';
import type { BookFiles } from '../book/canonical.js';
import type { ResolvedGenre } from '../genres/index.js';
import type { NonceCheckReport } from '../instructions/types.js';
import type { RunLimits } from '../harness/types.js';
import type { DbEffect } from './effects.js';

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
  files: BookFiles;
  config: BookConfig;
  genre: ResolvedGenre;
  headCommit: string;
}

export interface PipelineContext {
  deps: PipelineDeps;
  /** 无书任务（routing.feasibility、harness.canary）为 null */
  book: BookHandle | null;
}

/** 入队请求（task id 由 computeTaskId 计算，幂等：同 id 已存在则不重复创建） */
export interface TaskSpec {
  kind: TaskKind;
  bookId: string | null;
  /** c00421 / a0012 / v03 / book / <其他> */
  target: string;
  lane?: Lane;
  role?: RoleId | null;
  tier?: QualityTier;
  priority?: number;
  /**
   * handler 私有参数（不进 task id，只有 params.instance 经 configHash 进入；params 用于 revise brief、diff 模式等）。
   * 通用约定：instance = 同 kind/target 的实例号（重复派发时提供不同值才会得到新任务）；ownerNotes: string[] = 附加的 owner 笔记（L3.9，原样）。
   */
  params?: Record<string, unknown>;
  deps?: string[];
  notBefore?: string;
  parentTaskId?: string;
  maxAttempts?: number;
}

/** path → blob sha（'' = 不存在）。hard 变化 → 作废；只有 soft 变化 → rebase */
export interface Manifest {
  hard: Record<string, string>;
  soft: Record<string, string>;
  rebaseValidators: string[];
  /** 影响产物内容的配置 hash（gates 阈值、档位、长度区间、题材包版本；不含 routing/accounts/并发/预算） */
  configHash: string;
}

/** 本次 run 的路径与路由结果（F 在 prepare 前填好） */
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
  role: RoleId;
  /** 本次是否降级（review 标黄） */
  degraded: { from: string; to: string; reason: string }[];
}

/** handler.prepare 产出：工作单 + 需要放进 run 的只读输入 */
export interface AgentPlan {
  frontmatter: Omit<WorkOrderFrontmatter, 'schema' | 'task_id' | 'run_id' | 'out_dir'>;
  /** 中文 markdown 正文（任务说明 + 内联 context pack） */
  body: string;
  /** 复制进 $RUN/in/inputs/ 的文件（绝对源路径 → 相对 inDir 的目标） */
  inputs: { from: string; to: string }[];
  /** L3.9 作者块（owner 本章笔记、Inbox 附笔记、must-fix），原样 */
  ownerNotes: { source: string; text: string }[];
  limits?: Partial<RunLimits>;
  /** 修订是否尝试 resume（默认 false：新开 run） */
  resume?: { sessionId: string } | null;
}

export type PrepareResult = { kind: 'run'; plan: AgentPlan } | { kind: 'skip'; result: TaskResult };

/** run 结束、out 已收割后交给 finalize 的材料 */
export interface HarvestedRun {
  run: RunContext;
  outcome: Outcome;
  /** live 树中的 work/<task>/attempt-k/out（绝对路径） */
  stagedOutDir: string;
  files: string[];
  artifacts: ArtifactDecl[];
  nonce: NonceCheckReport;
  audit: { ok: boolean; extraFiles: string[]; tamperedConfig: string[] };
}

export interface InboxInput {
  kind: InboxKind;
  bookId: string | null;
  title: string;
  body: Record<string, unknown>;
  actions: { id: string; label: string; danger?: boolean; needsNote?: boolean }[];
  dedupeKey?: string;
  relatedTaskId?: string;
  timeoutAt?: string;
  onTimeout?: 'wait' | 'auto_approve' | 'skip';
}

/** committer 的输入（§7.7 第 4 步“目标文件集”） */
export interface PromotePlan {
  bookId: string;
  taskId: string;
  runId: string | null;
  baseCommit: string;
  files: FileChange[];
  /** 需要映射 tmp: id 的文件（committer 调 state.resolveTmpIds） */
  resolveTmpIds: boolean;
  message: string;
  /** 除 Novelist-Task/-Run/-Harness/-Model/-Instructions/-Isolation 外的额外 trailer（committer 自动加前者） */
  trailers: Record<string, string>;
  tags: string[];
  /** 提交成功后在同一事务里执行的 DB 更新（可序列化：写进 VALIDATED.json，崩溃后按名字重放）。流水线 handler 一律用它 */
  effect?: DbEffect;
  /** 闭包形式（只用于测试桩）：无法写进 VALIDATED.json，崩溃恢复时会退回重跑 handler */
  dbEffects?: (tx: Tx, commitSha: string) => Promise<void>;
}

export type TaskStatus = 'done' | 'retry' | 'failed' | 'blocked' | 'hold' | 'waiting';

export interface TaskResult {
  status: TaskStatus;
  errorClass?: ErrorClass;
  message?: string;
  /** retry：何时再试；waiting：等待到何时（如 awaiting_check） */
  retryAfter?: string;
  /** output_contract 同 profile 2 次后换 profile（§5.4） */
  avoidProfile?: string;
  promote?: PromotePlan;
  followups?: TaskSpec[];
  inbox?: InboxInput[];
  /** 无 promote 时也要更新的章节索引（state、workflow 持久部分） */
  chapter?: { no: number; state: ChapterWorkflowState; workflow?: Record<string, unknown> };
  /** 写入 tasks.result 供 UI 展示 */
  summary?: Record<string, unknown>;
}

export interface TaskHandler {
  kind: TaskKind;
  /** null = 确定性任务（不 spawn harness） */
  role: RoleId | null;
  lane: Lane;
  maxAttempts: number;
  manifest(ctx: PipelineContext, spec: TaskSpec): Promise<Manifest>;
  prepare?(ctx: PipelineContext, task: TaskRow, run: RunContext): Promise<PrepareResult>;
  finalize?(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult>;
  execute?(ctx: PipelineContext, task: TaskRow): Promise<TaskResult>;
  /** soft deps 变化时在 HEAD 上重跑确定性 validators；ok 则照常提交 */
  rebase?(ctx: PipelineContext, task: TaskRow, head: string): Promise<{ ok: boolean; reason?: string; followups?: TaskSpec[] }>;
}
