/**
 * HTTP API 契约（web ⇄ server）。请求体 = zod（server 校验），响应 = TS 类型。
 * 路由清单见 ROUTES（同时是 IMPL.md 路由表的来源）。错误：RFC 9457 problem+json（ApiProblem）。
 * 分页：?cursor=&limit=，响应 Page<T>。所有时间为 ISO8601 字符串。
 */
import { z } from 'zod';
import type {
  AuthMode,
  BookStatus,
  ErrorClass,
  HarnessId,
  InboxKind,
  IsolationBackend,
  RoleId,
  RunState,
  TaskState,
} from './enums.js';
import { zAuthMode } from './enums.js';
import type { NEvent } from './events.js';
import type { AuthMethodSpec, Capabilities, HarnessInstall, IsolationProbe, LoginOutputChunk, LoginSession, Outcome } from './harness.js';
import type { Account, AccountState } from './config/accounts.js';
import { zAccount } from './config/accounts.js';
import type { Profile } from './config/routing.js';
import { zProfile } from './config/routing.js';
import type { SystemSettings } from './config/settings.js';
import { zSystemSettings } from './config/settings.js';
import type { BookConfig, Effort, Flow, PublishConfig, V3Length } from './schemas/book.js';
import { V3_LENGTHS, zEffort } from './schemas/book.js';
import { zPublishConfig } from './schemas/book.js';

// ───────────────────────── 通用 ─────────────────────────
export interface ApiProblem {
  type: string; // 'about:blank' 或 'https://novelist/errors/<code>'
  title: string;
  status: number;
  detail?: string;
  code?: string;
  errors?: { path: string; message: string }[];
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export const zPageQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(50) });
export interface Ok {
  ok: true;
}

// ───────────────────────── 认证 ─────────────────────────
export type SessionRole = 'admin' | 'reader';
/** 单框登录：先匹配管理员密码，再按 HMAC 前缀查读者密码（§9.6，兼容 v1） */
export const zLoginRequest = z.object({ password: z.string().min(1).max(1024), remember: z.boolean().default(true) });
export type LoginRequest = z.input<typeof zLoginRequest>;
export interface MeResponse {
  role: SessionRole | null;
  readerId?: string;
  label?: string;
  insecureCookies: boolean;
}
export interface HealthResponse {
  ok: boolean;
  version: string;
  db: 'pg' | 'pglite';
  roles: string[];
  time: string;
}

// ───────────────────────── 读者端 ─────────────────────────
export interface ReaderBookCard {
  slug: string;
  title: string;
  genre: string;
  blurb: string;
  status: BookStatus;
  publishedChapters: number;
  publishedCjk: number;
  lastPublishedAt: string | null;
  coverUrl: string | null;
  progress: { ch: number; scroll: number } | null;
}
export interface ReaderVolume {
  id: string;
  title: string;
  chapters: { no: number; id: string; title: string; cjk: number; publishedAt: string }[];
}
export interface ReaderBookDetail extends ReaderBookCard {
  volumes: ReaderVolume[];
}
export interface ReaderChapter {
  slug: string;
  no: number;
  id: string;
  title: string;
  volumeTitle: string;
  /** 已剥离 beat 标记的正文（markdown 段落） */
  text: string;
  cjk: number;
  publishedAt: string;
  revisedAt: string | null;
  prev: number | null;
  next: number | null;
}
export const zProgressPut = z.object({ ch: z.number().int().positive(), scroll: z.number().min(0).max(1) });
export type ProgressPut = z.infer<typeof zProgressPut>;

// ───────────────────────── 管理端：书 ─────────────────────────
export interface Frontiers {
  /** 已验收的最后一章号 */
  accepted: number;
  published: number;
  buffer: number;
  bufferDays: number | null;
}
export interface BookSummary {
  slug: string;
  title: string;
  genre: string;
  status: BookStatus;
  totalCjk: number;
  frontiers: Frontiers;
  activeTasks: number;
  waiting: { reason: string; until: string | null } | null;
  inboxOpen: number;
  updatedAt: string;
  /** 流程（meta.v3 存在 = v3；列表不读 book.yaml） */
  flow: Flow;
  /** 旧书（导入或旧流程写的书；meta.v3 不是对象）：只读，可接手 */
  legacy: boolean;
  /** 新流程书的状态句与花费；旧流程书为 null */
  v3: V3BookSummary | null;
}
export interface BookOverview extends BookSummary {
  /** book.yaml 里页面用得到的几节；读不出来（旧书的旧键不合 schema、书目录不在）时为 null */
  config: Pick<BookConfig, 'flow' | 'publish' | 'v3' | 'routing' | 'genre' | 'title'> | null;
  /** 本书的写作模型覆盖（book.yaml routing.writer_profile）；null = 跟随写作位置 */
  writerOverride: string | null;
  recentCommits: GitCommitRow[];
  /** 书目录不存在（仓库被手动移走）：页面只显示数据库里的信息 */
  dirMissing: boolean;
}
/**
 * 开书（P3）：每本新书都是 v3。题材可以是 'random'（按自动开书的权重在可见的包里挑），篇幅可以是 'random'（按篇幅分布补缺口）；
 * 一句话想法可空。seed 是完整种子文本（API / CLI 用）；不给时服务器按题材拼一份（成人题材的年龄声明照旧带上）。
 * 旧请求里的 flow / tier / preset / interview / approvals / scale 一律忽略（zod 剥掉）。
 */
const zCreateBookBody = z.object({
  genre: z.string().min(1),
  length: z.enum([...V3_LENGTHS, 'random']).default('random'),
  idea: z.string().max(300).default(''),
  /** 可留空：由作者在 bible.md 里起名 */
  title: z.string().default(''),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  seed: z.string().optional(),
  target_cjk: z.number().int().positive().optional(),
  batch: z.number().int().min(1).max(8).optional(),
  min_chapter_cjk: z.number().int().positive().optional(),
  start: z.boolean().default(true),
});
const NESTED_V3_KEYS = ['length', 'target_cjk', 'batch', 'min_chapter_cjk'] as const;
/**
 * P2 的请求形状（带 flow，或 v3: { length, target_cjk, batch, min_chapter_cjk }）再收一个版本（P3 D27）：嵌套的键挪到顶层（顶层已有的为准），
 * 并保留 P2 的缺省值：篇幅缺省中篇、种子缺省为空（不由服务器拼）。
 */
function liftNestedV3(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { v3, ...rest } = input as Record<string, unknown>;
  const p2 = v3 !== undefined || 'flow' in rest;
  const out: Record<string, unknown> = { ...rest };
  if (v3 && typeof v3 === 'object' && !Array.isArray(v3)) {
    for (const k of NESTED_V3_KEYS) if (out[k] === undefined && (v3 as Record<string, unknown>)[k] !== undefined) out[k] = (v3 as Record<string, unknown>)[k];
  }
  if (p2) {
    if (out.length === undefined) out.length = 'medium';
    if (out.seed === undefined) out.seed = '';
  }
  return out;
}
export const zCreateBook = z.preprocess(liftNestedV3, zCreateBookBody);
export type CreateBook = z.input<typeof zCreateBookBody>;
/** 服务器内部（自动开书、脚本、测试）还收 P2 形状：flow / tier 忽略，v3 嵌套挪到顶层 */
export type CreateBookCompat = CreateBook & { flow?: string; tier?: string; v3?: { length?: V3Length; target_cjk?: number; batch?: number; min_chapter_cjk?: number } };
export type CreateBookParsed = z.output<typeof zCreateBookBody>;
export const zPatchBook = z.object({ status: z.enum(['active', 'paused', 'archived']).optional(), title: z.string().optional() });
/** write_now：立即写下一批（存稿满了、或因存稿满暂停时也写这一批，只多写这一批） */
export const BOOK_ACTIONS = ['start', 'pause', 'resume', 'reindex', 'rewind', 'write_now'] as const;
export const zBookAction = z.object({ action: z.enum(BOOK_ACTIONS), to: z.number().int().optional(), note: z.string().max(2000).optional() });

/** 接手旧书（P3 D16）：book.yaml 加上 flow: v3 和 v3 / 发布设置，写作从下一章接着来，第一次写作先补笔记 */
export const zTakeover = z.object({
  length: z.enum(V3_LENGTHS),
  target_cjk: z.number().int().positive(),
  batch: z.number().int().min(1).max(8).default(5),
  min_chapter_cjk: z.number().int().positive().default(3000),
  start: z.boolean().default(true),
});
export type Takeover = z.input<typeof zTakeover>;

/**
 * 接手时写进 book.yaml 的计划章数（服务端和接手对话框共用）。
 * 已有章节：按这本书实际的每章字数（不低于每章下限）折算目标字数，至少还留 closingBatches + 2 批（第一批不会就进入收尾阶段）；
 * 短篇每一批都是结局批，至少再写一批。一章都没有：和开新书一样按每章 4000 字折算。
 */
export function takeoverPlanned(p: { accepted: number; totalCjk: number; target_cjk: number; batch: number; min_chapter_cjk: number; length: V3Length }, closingBatches: number): number {
  if (p.accepted <= 0) return Math.max(1, Math.ceil(p.target_cjk / 4000));
  const avg = Math.max(p.totalCjk / p.accepted, p.min_chapter_cjk, 1);
  const floor = p.length === 'short' ? p.accepted + p.batch : p.accepted + (closingBatches + 2) * p.batch;
  return Math.max(Math.ceil(p.target_cjk / avg), floor);
}

/** 接手对话框的默认值与提示 */
export interface TakeoverDefaults {
  length: V3Length;
  target_cjk: number;
  batch: number;
  min_chapter_cjk: number;
  accepted: number;
  totalCjk: number;
  /** 按建议篇幅渲染出的根 AGENTS.md 字节数（渲染失败时 0） */
  agentsBytes: number;
  agentsOver: boolean;
  /** 按默认值折算的计划章数（takeoverPlanned） */
  planned: number;
  /** 剩余计划章数不超过 closingBatches × 每批章数时进入收尾阶段（对话框据此提示） */
  closingBatches: number;
  /** 已写章数之后还有已入库 / 已发布的章节或正文文件（v1 导入有缺章）：接手会被拒绝（409 chapter_gap），先补齐或移走 */
  gap: { missing: number[]; extra: number[] } | null;
}

/** 书库文件浏览/编辑（plan/bible/instructions/style… 任意受控路径） */
export interface RepoEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
  /** canonical = 正典入库；user = 用户指令；generated = 生成；derived = 派生不入库 */
  owner: 'canonical' | 'user' | 'generated' | 'derived';
}
export interface RepoFile {
  path: string;
  content: string;
  sha: string;
  commit: string;
}
export const zPutRepoFile = z.object({ path: z.string(), content: z.string(), baseSha: z.string().nullable(), message: z.string().optional(), confirm: z.boolean().default(false) });
/** 保存前影响估算（§6.10 第 5 条，§7.8 随时编辑） */
export interface ImpactEstimate {
  invalidatedTasks: number;
  estimatedRuns: number;
  affectedChapters: [number, number] | null;
  affectedDeltas: number;
  windowPct: Record<string, number>;
  usd: number;
  needsConfirm: boolean;
  notes: string[];
}

export interface GitCommitRow {
  sha: string;
  ts: string;
  subject: string;
  trailers: Record<string, string>;
  tags: string[];
}

export type ChapterWorkflowState =
  | 'planned'
  | 'writing'
  | 'gating'
  | 'revising'
  | 'checking'
  | 'format_repair'
  | 'delta_check'
  | 'reviewing'
  | 'accepting'
  | 'accepted'
  | 'awaiting_check'
  | 'held'
  | 'blocked'
  | 'needs_repair';
export interface ChapterRow {
  no: number;
  id: string;
  title: string;
  volume: string;
  /** 卷标题（旧书从 plan/volumes 回填；空 = 只显示卷 id） */
  volumeTitle: string;
  state: ChapterWorkflowState;
  cjk: number;
  acceptedAt: string | null;
  publishedAt: string | null;
}
export interface ChapterAdminDetail extends ChapterRow {
  /** 正文；书目录不在时为 null */
  text: string | null;
  runs: RunRow[];
  commit: string | null;
  /** 主人直接改过、作者不能再覆盖（新流程的书） */
  locked: boolean;
  /** 旧书：只能读和直接改 */
  legacy: boolean;
}
/** rewrite = 带意见重写（并入下一批）；rewrite_from = “从这里起重写后续”（= 回退到第 N−1 章再写）；publish_now = 立即发布到这一章 */
export const CHAPTER_ACTIONS = ['rewrite', 'rewrite_from', 'publish_now'] as const;
export const zChapterAction = z.object({ action: z.enum(CHAPTER_ACTIONS), note: z.string().optional() });

// ───────────────────────── v3：主人的操作（p2-plan §1.4 WP-2） ─────────────────────────
/** 给作者的话（一次性）；'' = 撤回还没被读的那段 */
export const zV3OwnerMessage = z.object({ text: z.string().max(4000) });
export const zV3AdoptDraft = z.object({ path: z.string().min(1) });
export const zV3DiscardDraft = z.object({ path: z.string().min(1) });
export const zV3Rewind = z.object({ to: z.number().int().min(0), note: z.string().max(2000).optional() });
export const zV3PendingAction = z.object({ action: z.enum(['retry', 'discard']) });
/** 主人操作的结果：detail 是给提示条的一句中文 */
export interface V3ActionResult {
  ok: true;
  detail: string;
}
/** 书页“草稿”一栏的一行 */
export interface V3DraftRow {
  path: string;
  size: number;
  kind: 'unfinished' | 'rewrite' | 'dup' | 'pre' | 'retro' | 'owner_conflict' | 'rewound' | 'replaced' | 'other';
  chapter: number | null;
  target: string | null;
  adoptable: boolean;
  reason: string | null;
  handled: boolean;
}

// ───────────────────────── v3：读模型与设置（p2-plan §1.4 WP-4） ─────────────────────────
export type V3StatusKind =
  | 'draft'
  | 'opening'
  | 'writing'
  | 'finale'
  | 'retro'
  | 'harvesting'
  | 'queued'
  | 'waiting_quota'
  | 'waiting_account'
  | 'waiting_retry'
  | 'needs_owner'
  | 'buffer_full'
  | 'paused'
  | 'completed'
  | 'archived'
  | 'idle'
  | 'rewinding';
/** 一句状态（首页、书页） */
export interface V3Status {
  kind: V3StatusKind;
  sentence: string;
  since: string | null;
  until: string | null;
  notes: string[];
}
/** 累计花费：运行次数、小时、输出 token、每千字输出 token */
export interface V3Cost {
  runs: number;
  hours: number;
  outputTokens: number;
  tokensPer1kChars: number | null;
}
export interface V3BookSummary {
  length: V3Length;
  targetCjk: number;
  plannedChapters: number;
  status: V3Status;
  cost: V3Cost;
}
export interface V3RunCostRow {
  runId: string;
  taskKind: string;
  mode: string | null;
  chapters: [number, number] | null;
  startedAt: string | null;
  minutes: number | null;
  outputTokens: number;
  inputTokens: number;
  cachedTokens: number;
  model: string | null;
  state: RunState;
  errorClass: ErrorClass | null;
  toolSteps: number | null;
}
export interface V3OwnerMessageView {
  text: string;
  setAt: string;
  readIn: { kind: string; from: number; to: number; at: string } | null;
  archivedPath: string | null;
}
export interface V3OwnerRequestView {
  id: string;
  chapter: number;
  note: string;
  at: string;
  status: 'waiting' | 'done' | 'not_done' | 'dropped';
}
export interface V3BatchRow {
  kind: string;
  from: number;
  to: number;
  at: string;
  runId: string | null;
}
export interface V3StoryFile {
  path: string;
  size: number;
  budget: number | null;
  over: boolean;
}
export interface V3Settings {
  target_cjk: number;
  min_chapter_cjk: number;
  batch: number;
  /** closing = 收尾阶段的写作批（book.yaml 没写时显示 finale 的值） */
  effort: { open: Effort; write: Effort; closing: Effort; finale: Effort; retro: Effort };
  publish: { mode: PublishConfig['mode']; cadence: string; timezone: string; per_slot: number; max_buffer: number };
  /** 本书的写作模型覆盖（profile id）；null = 跟随写作位置 */
  writer_profile: string | null;
  /** 书级预算（照旧生效）：null = 不设上限 */
  budgets: { priority: number; monthly_usd_cap: number | null; max_window_util_pct: number | null };
}
export const zV3Settings = z.object({
  target_cjk: z.number().int().positive(),
  min_chapter_cjk: z.number().int().positive(),
  batch: z.number().int().min(1).max(8),
  effort: z.object({ open: zEffort, write: zEffort, closing: zEffort, finale: zEffort, retro: zEffort }),
  publish: z.object({ mode: zPublishConfig.shape.mode, cadence: z.string(), timezone: z.string(), per_slot: z.number().int().positive(), max_buffer: z.number().int().positive() }),
  writer_profile: z.string().min(1).nullable(),
  budgets: z.object({ priority: z.number().int(), monthly_usd_cap: z.number().nonnegative().nullable(), max_window_util_pct: z.number().min(0).max(100).nullable() }),
});
export interface V3AgentsSizeView {
  bytes: number;
  hard: boolean;
  limit: number;
  harness: string;
  at: string;
  layers: { layer: string; bytes: number }[];
}
/** 新流程书页的全部数据（GET /api/admin/books/:slug/v3） */
export interface V3BookView {
  slug: string;
  length: V3Length;
  planned: number;
  accepted: number;
  published: number;
  totalCjk: number;
  status: V3Status;
  settings: V3Settings;
  ownerMessage: V3OwnerMessageView | null;
  ownerHistory: V3OwnerMessageView[];
  ownerRequests: V3OwnerRequestView[];
  batches: V3BatchRow[];
  drafts: V3DraftRow[];
  story: V3StoryFile[];
  runs: V3RunCostRow[];
  cost: V3Cost;
  retro: { enabled: boolean; batchesSince: number; every: number; lastAt: string | null };
  hints: { kind: string; text: string }[];
  pending: { failures: number; lastError: string | null; blocked: boolean } | null;
  rewindPoints: { to: number; label: string }[];
  locked: number[];
  agentsSize: V3AgentsSizeView | null;
}
export const zPutChapterText = z.object({ text: z.string().min(1), baseSha: z.string(), confirm: z.boolean().default(false) });

// ───────────────────────── 任务 / run ─────────────────────────
export interface TaskRow {
  id: string;
  bookSlug: string | null;
  kind: string;
  target: string;
  lane: string;
  state: TaskState;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastErrorClass: ErrorClass | null;
  notBefore: string | null;
  waitReason: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface RunRow {
  id: string;
  taskId: string;
  bookSlug: string | null;
  kind: string;
  attempt: number;
  role: string;
  profileId: string;
  accountId: string | null;
  harness: HarnessId;
  harnessVersion: string;
  model: string | null;
  modelReported: string | null;
  isolation: IsolationBackend;
  state: RunState;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  errorClass: ErrorClass | null;
  usage: { input: number; output: number; cached: number; costUsd: number | null };
  denials: number;
  /** tool_call 事件数（runs.outcome.toolSteps；旧 run 为 null） */
  toolSteps: number | null;
}
export interface RunDetail extends RunRow {
  outcome: Outcome | null;
  nonceReport: { layer: string; head: boolean; tail: boolean }[] | null;
  files: { path: string; size: number; area: 'in' | 'log' | 'out' }[];
  argvPreview: string[];
}
export const zRunEventsQuery = z.object({ after: z.coerce.number().int().default(-1), limit: z.coerce.number().int().max(5000).default(1000) });

// ───────────────────────── Inbox ─────────────────────────
export interface InboxItem {
  id: string;
  bookSlug: string | null;
  kind: InboxKind;
  title: string;
  body: Record<string, unknown>;
  state: 'open' | 'resolved' | 'dismissed' | 'expired';
  actions: { id: string; label: string; danger?: boolean; needsNote?: boolean }[];
  createdAt: string;
  resolvedAt: string | null;
  timeoutAt: string | null;
}
export const zInboxAct = z.object({ action: z.string(), note: z.string().optional(), payload: z.record(z.string(), z.unknown()).optional() });

// ───────────────────────── 指令 ─────────────────────────
/** scope: 'global' | 'genre:<id>' | 'book:<slug>' | 'builtin'（只读） */
export const zInstructionScope = z.string().regex(/^(global|builtin|genre:[a-z0-9-]+|book:[a-z0-9-]+)$/);
export interface InstructionFileEntry {
  scope: string;
  path: string;
  size: number;
  layer: 'S0' | 'S1' | 'L1' | 'L2' | 'L3';
  role: RoleId | null;
}
/**
 * v3 指令预览（P3 WP-3）：按一本书（它的题材链、篇幅、书目录）或一个题材包 + 篇幅（空书目录）渲染根 AGENTS.md。
 * drafts：路径 → 未保存内容（绝对路径，或 `global:<rel>` / `genre:<id>:<rel>` / `book:<slug>:<rel>`），编辑器实时预览用。
 */
export const zInstructionPreviewV3 = z.object({
  book: z.string().optional(),
  genre: z.string().optional(),
  length: z.enum(V3_LENGTHS).optional(),
  drafts: z.record(z.string(), z.string()).default({}),
});
export type InstructionPreviewV3Request = z.input<typeof zInstructionPreviewV3>;
export interface InstructionPreviewV3 {
  /** 渲染出的根 AGENTS.md 全文 */
  text: string;
  bytes: number;
  limit: number;
  over: boolean;
  layers: { id: string; label: string; bytes: number }[];
}
// ───────────────────────── 题材包 ─────────────────────────
export interface GenreSummary {
  id: string;
  name: string;
  description: string;
  extends: string[];
  builtin: boolean;
  /** 已停用（不出现在开书页和自动开书里） */
  hidden: boolean;
  books: number;
  files: string[];
  /** pack.yaml 的 auto 配置摘要；null 表示未配置 */
  auto: { enabled: boolean; weight: number; keywords: number; lengthHint: string; keywordList: string[]; adultOnly: boolean; minChapters: number | null } | null;
  /**
   * 旧设置里的覆盖（autoStart.genres / autoStart.genreWeights，优先于 pack.yaml）：listed = 设置里列了题材清单时这个包在不在里面（没列清单 = null），
   * weight = 设置里给这个包的权重（没给 = null）。界面显示为“覆盖”，只能清除
   */
  override: { listed: boolean | null; weight: number | null };
}
/** 题材包停用 / 恢复 */
export const zGenreVisibility = z.object({ hidden: z.boolean() });
/** 题材包的自动开书配置（写回 pack.yaml 的 auto.*，保留注释；成人标记和最少章数只读） */
export const zPatchGenreAuto = z.object({
  enabled: z.boolean().optional(),
  weight: z.number().min(0).max(100).optional(),
  keywords: z.array(z.string().min(1).max(40)).max(200).optional(),
  length_hint: z.string().max(40).optional(),
});
export type PatchGenreAuto = z.input<typeof zPatchGenreAuto>;
export const zCreateGenre = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), name: z.string(), extends: z.array(z.string()).default([]), copyFrom: z.string().optional() });

// ───────────────────────── Harness / 账号 / profile / 路由 ─────────────────────────
export interface HarnessStatus {
  id: HarnessId;
  displayName: string;
  installed: boolean;
  install: HarnessInstall | null;
  binPath: string | null;
  versionDetected: string | null;
  supportedVersions: string;
  capabilities: Capabilities | null;
  authMethods: AuthMethodSpec[];
  accounts: number;
  installHint: string;
}
export interface AccountView extends Omit<Account, 'env'> {
  /** 秘密值打码，只告诉是否已设置 */
  env: { name: string; secret: boolean; set: boolean; value?: string }[];
  state: AccountState | null;
  riskNotes: { id: string; level: string; text: string; acked: boolean }[];
}
export const zCreateAccount = zAccount.omit({ files: true }).extend({
  env: z.array(z.object({ name: z.string(), value: z.string(), secret: z.boolean().default(false) })).default([]),
});
export type CreateAccount = z.input<typeof zCreateAccount>;
export const zPatchAccount = zCreateAccount.partial().omit({ id: true, harness: true });
export const zPutEnv = z.object({ value: z.string(), secret: z.boolean().default(true) });
export const zStartLogin = z.object({ mode: zAuthMode.optional(), argv: z.array(z.string()).optional() });
export const zLoginInput = z.object({ text: z.string(), newline: z.boolean().default(true) });
export interface LoginSessionView extends LoginSession {
  output: LoginOutputChunk[];
}
export interface AccountCheck {
  ok: boolean;
  authMode: AuthMode;
  detail: string;
  models: string[];
  /** 订阅 run 确认没有带 API key 等启动核对项 */
  checks: { id: string; ok: boolean; detail: string }[];
  /** verified：真实连通并接受密钥；reachable：有响应但密钥未验证；failed：不通；config_only：仅校验配置，未实际连通；null：该认证方式不做连通探测 */
  connectivity: 'verified' | 'reachable' | 'failed' | 'config_only' | null;
}
export const zPatchProfile = zProfile.partial().omit({ id: true });
// ───────────────────────── 发布 / 配额 / 用量 ─────────────────────────
export const zPublishNow = z.object({ through: z.number().int().positive().optional(), ignoreAudit: z.boolean().default(false) });
export interface QuotaStatus {
  accountId: string;
  harness: HarnessId;
  plan: string;
  windows: { window: string; utilization: number | null; reserved: number; resetsAt: string | null }[];
  sleepUntil: string | null;
  sleepReason: string | null;
  activeRuns: number;
  concurrency: number;
}
export const zUsageQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(['day', 'book', 'profile', 'account', 'task_kind']).default('day'),
  book: z.string().optional(),
});
export interface UsageReport {
  groupBy: string;
  rows: { key: string; runs: number; input: number; cached: number; output: number; usd: number; utilDelta: Record<string, number> }[];
  perChapter: { profile: string; tier: string; tokens: number; utilDelta: Record<string, number>; samples: number }[];
}

// ───────────────────────── 读者 / PAT / 设置 / doctor / v1 导入 ─────────────────────────
export interface ReaderAccount {
  id: string;
  label: string;
  allowBooks: string[] | null;
  enabled: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  legacy: boolean;
}
export const zCreateReader = z.object({ label: z.string().default(''), password: z.string().min(4), allowBooks: z.array(z.string()).nullable().default(null) });
export const zPatchReader = z.object({ label: z.string().optional(), password: z.string().min(4).optional(), allowBooks: z.array(z.string()).nullable().optional(), enabled: z.boolean().optional() });
export interface PatRow {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export const zCreatePat = z.object({ label: z.string().min(1), scopes: z.array(z.string()).default(['admin']) });
export interface CreatedPat extends PatRow {
  /** 只在创建时返回一次 */
  token: string;
}
/**
 * 改系统设置（P3 D30）：每个页面只发自己那一节，服务器按节合并（services/settings.ts mergeSettings），合并结果再整体校验。
 * baseUpdatedAt = GET 返回的 updatedAt；给了且和库里不一致 → 409 stale_settings（页面重新读一遍再改）
 */
export const zPutSettings = z.object({ baseUpdatedAt: z.string().nullable().optional() }).passthrough();
/** GET /api/admin/settings：设置 + 设置行的 updatedAt（还没存过 = null） */
export type SystemSettingsView = SystemSettings & { updatedAt: string | null };
export const zChangeAdminPassword = z.object({ current: z.string(), next: z.string().min(8) });
export interface DoctorReport {
  ts: string;
  isolation: IsolationProbe;
  db: { kind: 'pg' | 'pglite'; ok: boolean; version: string; migrations: string };
  disk: { path: string; freeBytes: number; ok: boolean }[];
  tools: { name: string; ok: boolean; version: string | null; detail?: string }[];
  harnesses: { id: HarnessId; ok: boolean; detail: string }[];
  access: { protocol: 'http' | 'https'; trustProxy: boolean; insecureCookies: boolean; warning: string | null };
  masterKey: { source: 'env' | 'file' | 'generated'; ok: boolean };
  hints: string[];
}
export interface SystemInfo {
  version: string;
  node: string;
  arch: string;
  platform: string;
  dataDir: string;
  roles: string[];
  uptimeSec: number;
  settings: SystemSettings;
}
export const zV1ImportPreviewRequest = z.object({ databaseUrl: z.string().optional() });
export interface V1ImportPreview {
  source: string;
  ok: boolean;
  error?: string;
  novels: { id: number; slug: string; title: string; status: string; chapters: number; doneChapters: number; words: number; theme: string }[];
  themes: { id: number; name: string }[];
  readers: number;
  progressRows: number;
}
export const zV1ImportRequest = z.object({
  databaseUrl: z.string().optional(),
  novels: z.union([z.literal('all'), z.array(z.number().int())]).default('all'),
  readers: z.boolean().default(true),
  themes: z.boolean().default(true),
  includeDrafts: z.boolean().default(false),
});
export interface V1ImportJob {
  id: string;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt: string | null;
  log: string[];
  report: { books: { slug: string; chapters: number; dropped: number }[]; readers: number; genres: string[] } | null;
}

// ───────────────────────── SSE ─────────────────────────
/** GET /api/admin/events（text/event-stream）。event: <type>，data: JSON(SseEvent) */
export type SseEvent =
  | { type: 'hello'; ts: string }
  | { type: 'task_changed'; taskId: string; book: string | null; state: TaskState }
  | { type: 'run_started'; runId: string; taskId: string; book: string | null; role: RoleId; profile: string }
  | { type: 'run_event'; runId: string; event: NEvent }
  | { type: 'run_exit'; runId: string; state: RunState; errorClass: ErrorClass | null }
  | { type: 'quota_wait'; accountId: string; until: string | null; reason: string }
  | { type: 'inbox_new'; item: InboxItem }
  | { type: 'chapter_accepted'; book: string; no: number; cjk: number }
  | { type: 'chapter_published'; book: string; no: number }
  | { type: 'circuit_changed'; harness: HarnessId; version: string; state: string; reason: string | null }
  | { type: 'book_changed'; book: string }
  | { type: 'login_output'; sessionId: string; chunk: LoginOutputChunk }
  | { type: 'login_state'; session: LoginSession };
export type SseEventType = SseEvent['type'];

// ───────────────────────── 路由表（单一事实来源） ─────────────────────────
export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth: 'public' | 'reader' | 'admin';
  req?: string;
  res: string;
  desc: string;
}
export const ROUTES: RouteSpec[] = [
  // auth / health
  { method: 'GET', path: '/api/health', auth: 'public', res: 'HealthResponse', desc: '健康检查' },
  { method: 'POST', path: '/api/auth/login', auth: 'public', req: 'LoginRequest', res: 'MeResponse', desc: '单框登录（管理员或读者）' },
  { method: 'POST', path: '/api/auth/logout', auth: 'public', res: 'Ok', desc: '登出' },
  { method: 'GET', path: '/api/auth/me', auth: 'public', res: 'MeResponse', desc: '当前会话' },
  // reader
  { method: 'GET', path: '/api/reader/books', auth: 'reader', res: 'ReaderBookCard[]', desc: '书库' },
  { method: 'GET', path: '/api/reader/books/:slug', auth: 'reader', res: 'ReaderBookDetail', desc: '书详情与目录' },
  { method: 'GET', path: '/api/reader/books/:slug/chapters/:no', auth: 'reader', res: 'ReaderChapter', desc: '章节正文（仅已发布）' },
  { method: 'GET', path: '/api/reader/books/:slug/progress', auth: 'reader', res: '{ch,scroll}|null', desc: '阅读进度' },
  { method: 'PUT', path: '/api/reader/books/:slug/progress', auth: 'reader', req: 'ProgressPut', res: 'Ok', desc: '保存阅读进度' },
  { method: 'GET', path: '/api/reader/books/:slug/export.epub', auth: 'reader', res: 'application/epub+zip', desc: '导出 EPUB（?vol=v03 按卷）' },
  { method: 'GET', path: '/api/reader/books/:slug/export.txt', auth: 'reader', res: 'text/plain', desc: '导出 TXT' },
  { method: 'GET', path: '/api/reader/books/:slug/cover', auth: 'reader', res: 'image/*', desc: '封面' },
  // admin: books
  { method: 'GET', path: '/api/admin/books', auth: 'admin', res: 'BookSummary[]', desc: '书列表（?filter=active|finished|legacy|all，缺省 active）' },
  { method: 'POST', path: '/api/admin/books', auth: 'admin', req: 'CreateBook', res: 'BookSummary', desc: '开书（book new）' },
  { method: 'GET', path: '/api/admin/books/:slug', auth: 'admin', res: 'BookOverview', desc: '书概览' },
  { method: 'PATCH', path: '/api/admin/books/:slug', auth: 'admin', req: 'PatchBook', res: 'BookSummary', desc: '改状态/标题' },
  { method: 'DELETE', path: '/api/admin/books/:slug', auth: 'admin', res: 'Ok', desc: '删除书（需 ?confirm=slug）' },
  { method: 'POST', path: '/api/admin/books/:slug/actions', auth: 'admin', req: 'BookAction', res: 'Ok', desc: 'start/pause/resume/reindex/rewind' },
  { method: 'GET', path: '/api/admin/books/:slug/takeover', auth: 'admin', res: 'TakeoverDefaults', desc: '接手旧书的默认值' },
  { method: 'POST', path: '/api/admin/books/:slug/takeover', auth: 'admin', req: 'Takeover', res: 'BookSummary', desc: '接手旧书（改成新流程，从下一章接着写）' },
  { method: 'GET', path: '/api/admin/books/:slug/tree', auth: 'admin', res: 'RepoEntry[]', desc: '书库文件树（?dir=）' },
  { method: 'GET', path: '/api/admin/books/:slug/file', auth: 'admin', res: 'RepoFile', desc: '读书库文件（?path=）' },
  { method: 'PUT', path: '/api/admin/books/:slug/file', auth: 'admin', req: 'PutRepoFile', res: 'RepoFile|ImpactEstimate', desc: '写书库文件（needsConfirm 时 409 返回 ImpactEstimate；旧书只能写正文和 notes/）' },
  { method: 'POST', path: '/api/admin/books/:slug/file/impact', auth: 'admin', req: 'PutRepoFile', res: 'ImpactEstimate', desc: '保存前影响估算' },
  { method: 'GET', path: '/api/admin/books/:slug/git/log', auth: 'admin', res: 'Page<GitCommitRow>', desc: '提交历史（含 trailer）' },
  { method: 'GET', path: '/api/admin/books/:slug/chapters', auth: 'admin', res: 'Page<ChapterRow>', desc: '章节列表' },
  { method: 'GET', path: '/api/admin/books/:slug/chapters/:no', auth: 'admin', res: 'ChapterAdminDetail', desc: '章节详情' },
  { method: 'PUT', path: '/api/admin/books/:slug/chapters/:no/text', auth: 'admin', req: 'PutChapterText', res: 'ChapterAdminDetail|ImpactEstimate', desc: '手改正文（触发级联）' },
  { method: 'POST', path: '/api/admin/books/:slug/chapters/:no/actions', auth: 'admin', req: 'ChapterAction', res: 'Ok', desc: '章节操作' },
  { method: 'POST', path: '/api/admin/books/:slug/publish/now', auth: 'admin', req: 'PublishNow', res: 'Ok', desc: '立即发布' },
  // admin: v3 书的主人操作
  { method: 'PUT', path: '/api/admin/books/:slug/v3/message', auth: 'admin', req: 'V3OwnerMessage', res: 'V3ActionResult', desc: '给作者的话（一次性）' },
  { method: 'POST', path: '/api/admin/books/:slug/v3/drafts/adopt', auth: 'admin', req: 'V3AdoptDraft', res: 'V3ActionResult', desc: '采用草稿' },
  { method: 'POST', path: '/api/admin/books/:slug/v3/drafts/discard', auth: 'admin', req: 'V3DiscardDraft', res: 'V3ActionResult', desc: '收起草稿（移到 drafts/discarded/）' },
  { method: 'POST', path: '/api/admin/books/:slug/v3/rewind', auth: 'admin', req: 'V3Rewind', res: 'V3ActionResult', desc: '回退到第 N 章' },
  { method: 'POST', path: '/api/admin/books/:slug/v3/pending', auth: 'admin', req: 'V3PendingAction', res: 'V3ActionResult', desc: '收稿失败：重试 / 放弃' },
  { method: 'GET', path: '/api/admin/books/:slug/v3', auth: 'admin', res: 'V3BookView', desc: '新流程书页数据' },
  { method: 'PUT', path: '/api/admin/books/:slug/v3/settings', auth: 'admin', req: 'V3Settings', res: 'V3BookView', desc: '新流程设置（写回 book.yaml）' },
  // tasks / runs
  { method: 'GET', path: '/api/admin/tasks', auth: 'admin', res: 'Page<TaskRow>', desc: '任务（?book&state&kind）' },
  { method: 'POST', path: '/api/admin/tasks/:id/retry', auth: 'admin', res: 'Ok', desc: '重试任务' },
  { method: 'POST', path: '/api/admin/tasks/:id/cancel', auth: 'admin', res: 'Ok', desc: '取消任务' },
  { method: 'GET', path: '/api/admin/runs', auth: 'admin', res: 'Page<RunRow>', desc: 'run 列表（?book&state&harness）' },
  { method: 'GET', path: '/api/admin/runs/:id', auth: 'admin', res: 'RunDetail', desc: 'run 详情' },
  { method: 'GET', path: '/api/admin/runs/:id/events', auth: 'admin', res: 'NEvent[]', desc: 'run 事件（?after=seq）' },
  { method: 'GET', path: '/api/admin/runs/:id/file', auth: 'admin', res: 'text/plain', desc: 'run 文件（?area=in|log|out&path=）' },
  { method: 'GET', path: '/api/admin/runs/:id/stream', auth: 'admin', res: 'SSE(run_event|run_exit)', desc: '单个 run 实时流' },
  { method: 'POST', path: '/api/admin/runs/:id/kill', auth: 'admin', res: 'Ok', desc: '终止 run' },
  // inbox
  { method: 'GET', path: '/api/admin/inbox', auth: 'admin', res: 'Page<InboxItem>', desc: 'Inbox（?state=open）' },
  { method: 'POST', path: '/api/admin/inbox/:id/act', auth: 'admin', req: 'InboxAct', res: 'InboxItem', desc: '处理 Inbox 项' },
  // instructions / genres
  { method: 'GET', path: '/api/admin/instructions/files', auth: 'admin', res: 'InstructionFileEntry[]', desc: '指令文件（?scope=global|builtin|genre:x|book:y）' },
  { method: 'GET', path: '/api/admin/instructions/file', auth: 'admin', res: 'RepoFile', desc: '读指令文件（?scope&path）' },
  { method: 'PUT', path: '/api/admin/instructions/file', auth: 'admin', req: 'PutRepoFile&{scope}', res: 'RepoFile|ImpactEstimate', desc: '写指令文件' },
  { method: 'DELETE', path: '/api/admin/instructions/file', auth: 'admin', res: 'Ok', desc: '删除指令文件（?scope&path）' },
  { method: 'POST', path: '/api/admin/instructions/preview', auth: 'admin', req: 'InstructionPreviewV3', res: 'InstructionPreviewV3', desc: '根 AGENTS.md 预览（按书，或按题材包 + 篇幅）' },
  { method: 'GET', path: '/api/admin/genres', auth: 'admin', res: 'GenreSummary[]', desc: '题材包列表' },
  { method: 'POST', path: '/api/admin/genres', auth: 'admin', req: 'CreateGenre', res: 'GenreSummary', desc: '新建题材包' },
  { method: 'DELETE', path: '/api/admin/genres/:id', auth: 'admin', res: 'Ok', desc: '删除题材包（没有书在用、没有包继承；内置包记墓碑，目录移进回收站）' },
  { method: 'POST', path: '/api/admin/genres/:id/visibility', auth: 'admin', req: 'GenreVisibility', res: 'GenreSummary', desc: '停用 / 恢复题材包' },
  { method: 'PATCH', path: '/api/admin/genres/:id/auto', auth: 'admin', req: 'PatchGenreAuto', res: 'GenreSummary', desc: '题材包的自动开书配置（写回 pack.yaml）' },
  // harness / accounts / profiles / routing
  { method: 'GET', path: '/api/admin/harness', auth: 'admin', res: 'HarnessStatus[]', desc: 'harness 状态' },
  { method: 'POST', path: '/api/admin/harness/:id/probe', auth: 'admin', res: 'Capabilities', desc: '能力探测（?accountId）' },
  { method: 'GET', path: '/api/admin/harness/:id/models', auth: 'admin', res: 'string[]', desc: '列模型（agy models 等；?accountId）' },
  { method: 'POST', path: '/api/admin/harness/:id/install', auth: 'admin', req: '{version?}', res: '{id,state,commands}', desc: '安装 harness（202）' },
  { method: 'GET', path: '/api/admin/harness/install-jobs/:id', auth: 'admin', res: '{id,state,startedAt,endedAt,log,install}', desc: '安装进度' },
  { method: 'GET', path: '/api/admin/accounts', auth: 'admin', res: 'AccountView[]', desc: '账号列表' },
  { method: 'POST', path: '/api/admin/accounts', auth: 'admin', req: 'CreateAccount', res: 'AccountView', desc: '新建账号' },
  { method: 'GET', path: '/api/admin/accounts/:id', auth: 'admin', res: 'AccountView', desc: '账号详情' },
  { method: 'PATCH', path: '/api/admin/accounts/:id', auth: 'admin', req: 'PatchAccount', res: 'AccountView', desc: '修改账号' },
  { method: 'DELETE', path: '/api/admin/accounts/:id', auth: 'admin', res: 'Ok', desc: '删除账号' },
  { method: 'PUT', path: '/api/admin/accounts/:id/env/:name', auth: 'admin', req: 'PutEnv', res: 'AccountView', desc: '设置 env（秘密加密存储）' },
  { method: 'DELETE', path: '/api/admin/accounts/:id/env/:name', auth: 'admin', res: 'AccountView', desc: '删除 env' },
  { method: 'POST', path: '/api/admin/accounts/:id/files', auth: 'admin', req: 'multipart(relPath,part,file)', res: 'AccountView', desc: '上传凭据文件' },
  { method: 'DELETE', path: '/api/admin/accounts/:id/files', auth: 'admin', res: 'AccountView', desc: '删除凭据文件（?relPath）' },
  { method: 'POST', path: '/api/admin/accounts/:id/verify', auth: 'admin', res: 'AccountCheck', desc: '核对认证与模型' },
  { method: 'POST', path: '/api/admin/accounts/:id/login', auth: 'admin', req: 'StartLogin', res: 'LoginSessionView', desc: '启动交互登录' },
  { method: 'GET', path: '/api/admin/login-sessions/:sid', auth: 'admin', res: 'LoginSessionView', desc: '登录会话状态与输出' },
  { method: 'GET', path: '/api/admin/login-sessions/:sid/stream', auth: 'admin', res: 'SSE(login_output|login_state)', desc: '登录输出流' },
  { method: 'POST', path: '/api/admin/login-sessions/:sid/input', auth: 'admin', req: 'LoginInput', res: 'Ok', desc: '向登录进程写入输入' },
  { method: 'POST', path: '/api/admin/login-sessions/:sid/cancel', auth: 'admin', res: 'Ok', desc: '取消登录' },
  { method: 'GET', path: '/api/admin/profiles', auth: 'admin', res: 'Profile[]', desc: 'profile 列表' },
  { method: 'POST', path: '/api/admin/profiles', auth: 'admin', req: 'Profile', res: 'Profile', desc: '新建 profile' },
  { method: 'PATCH', path: '/api/admin/profiles/:id', auth: 'admin', req: 'PatchProfile', res: 'Profile', desc: '修改 profile' },
  { method: 'DELETE', path: '/api/admin/profiles/:id', auth: 'admin', res: 'Ok', desc: '删除 profile' },
  { method: 'GET', path: '/api/admin/routing/slots', auth: 'admin', res: 'RoutingSlotsView', desc: '两个路由位置（写作 / 杂活）的主备与当前状态' },
  { method: 'PUT', path: '/api/admin/routing/slots', auth: 'admin', req: 'PutRoutingSlots', res: 'RoutingSlotsView', desc: '改路由位置（fake 模式下 409）' },
  { method: 'POST', path: '/api/admin/routing/slots/:slot/canary', auth: 'admin', res: 'SlotCanaryResult', desc: '用该位置当前的 profile 试跑一次目录探测' },
  // quota / usage
  { method: 'GET', path: '/api/admin/quota', auth: 'admin', res: 'QuotaStatus[]', desc: '账号窗口占用/预留/重置' },
  { method: 'GET', path: '/api/admin/usage', auth: 'admin', res: 'UsageReport', desc: '用量报表' },
  // readers / pats / settings / doctor / import
  { method: 'GET', path: '/api/admin/readers', auth: 'admin', res: 'ReaderAccount[]', desc: '读者' },
  { method: 'POST', path: '/api/admin/readers', auth: 'admin', req: 'CreateReader', res: 'ReaderAccount', desc: '新建读者密码' },
  { method: 'PATCH', path: '/api/admin/readers/:id', auth: 'admin', req: 'PatchReader', res: 'ReaderAccount', desc: '修改读者' },
  { method: 'DELETE', path: '/api/admin/readers/:id', auth: 'admin', res: 'Ok', desc: '删除读者' },
  { method: 'GET', path: '/api/admin/pats', auth: 'admin', res: 'PatRow[]', desc: 'PAT 列表' },
  { method: 'POST', path: '/api/admin/pats', auth: 'admin', req: 'CreatePat', res: 'CreatedPat', desc: '签发 PAT' },
  { method: 'DELETE', path: '/api/admin/pats/:id', auth: 'admin', res: 'Ok', desc: '吊销 PAT' },
  { method: 'GET', path: '/api/admin/settings', auth: 'admin', res: 'SystemSettingsView', desc: '系统设置（带 updatedAt）' },
  { method: 'PUT', path: '/api/admin/settings', auth: 'admin', req: 'PutSettings', res: 'SystemSettingsView', desc: '修改系统设置（按节合并；baseUpdatedAt 过期 → 409）' },
  { method: 'PUT', path: '/api/admin/settings/admin-password', auth: 'admin', req: 'ChangeAdminPassword', res: 'Ok', desc: '改管理员密码' },
  { method: 'GET', path: '/api/admin/system', auth: 'admin', res: 'SystemInfo', desc: '系统信息' },
  { method: 'GET', path: '/api/admin/doctor', auth: 'admin', res: 'DoctorReport', desc: 'doctor（隔离探测等）' },
  { method: 'POST', path: '/api/admin/import-v1/preview', auth: 'admin', req: 'V1ImportPreviewRequest', res: 'V1ImportPreview', desc: 'v1 导入预览' },
  { method: 'POST', path: '/api/admin/import-v1', auth: 'admin', req: 'V1ImportRequest', res: 'V1ImportJob', desc: '启动 v1 导入' },
  { method: 'GET', path: '/api/admin/import-v1/jobs/:id', auth: 'admin', res: 'V1ImportJob', desc: 'v1 导入进度' },
  // SSE
  { method: 'GET', path: '/api/admin/events', auth: 'admin', res: 'SSE(SseEvent)', desc: '全局事件流' },
];

// 让 import type 的符号在类型检查时被使用（避免误删）
export type _ApiTypeRefs = [Profile, RunState, AccountState];
