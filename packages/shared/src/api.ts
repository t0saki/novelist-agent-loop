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
  QualityTier,
  RoleId,
  RunState,
  TaskKind,
  TaskState,
} from './enums.js';
import { zAuthMode, zHarnessId, zQualityTier, zRoleId } from './enums.js';
import type { NEvent } from './events.js';
import type { AuthMethodSpec, Capabilities, HarnessInstall, IsolationProbe, LoginOutputChunk, LoginSession, Outcome } from './harness.js';
import type { Account, AccountState } from './config/accounts.js';
import { zAccount } from './config/accounts.js';
import type { Profile, RouteDecision, RoutingPreset } from './config/routing.js';
import { zProfile, zRoleRoute, zRoutingPreset } from './config/routing.js';
import type { SystemSettings } from './config/settings.js';
import { zSystemSettings } from './config/settings.js';
import type { BookConfig, PublishConfig } from './schemas/book.js';
import { zBookConfig } from './schemas/book.js';
import { zPublishConfig } from './schemas/book.js';
import type { Card } from './schemas/plan.js';
import type { Delta } from './schemas/delta.js';
import type { Audit, GateResult, Review } from './schemas/artifacts.js';
import type { Debt, EntityState, ObligationState, Snapshot } from './schemas/state.js';

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
  audited: number;
  published: number;
  cardsPlanned: number;
  buffer: number;
  bufferDays: number | null;
}
export interface BookSummary {
  slug: string;
  title: string;
  genre: string;
  status: BookStatus;
  tier: QualityTier;
  totalCjk: number;
  frontiers: Frontiers;
  activeTasks: number;
  waiting: { reason: string; until: string | null } | null;
  inboxOpen: number;
  updatedAt: string;
}
export interface BookOverview extends BookSummary {
  config: BookConfig;
  writerProfile: string | null;
  currentChapter: { no: number; state: string; taskId: string | null } | null;
  milestones: { id: string; at: number; done: boolean; position: number }[];
  debts: { forwardOpen: number; metricOpen: number; cap: number };
  recentCommits: GitCommitRow[];
  formatVersion: number;
}
export const zCreateBook = z.object({
  title: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  genre: z.string().min(1),
  /** 种子：premise / 设想 / 参考，原样写入 bible/premise.md */
  seed: z.string().default(''),
  tier: zQualityTier.optional(),
  preset: z.string().optional(),
  interview: z.boolean().default(false),
  /** 覆盖 book.yaml 的审批关卡（无人值守开书用） */
  approvals: zBookConfig.shape.approvals.unwrap().partial().optional(),
  scale: z
    .object({
      target_cjk: z.number().int().positive(),
      hard_max_cjk: z.number().int().positive(),
      volumes: z.tuple([z.number().int(), z.number().int()]),
      chapters_per_volume: z.tuple([z.number().int(), z.number().int()]),
      chapter_length: z.object({ min: z.number().int(), target: z.number().int(), max: z.number().int(), count_mode: z.enum(['han', 'platform']) }).optional(),
    })
    .partial()
    .optional(),
  start: z.boolean().default(true),
});
export type CreateBook = z.input<typeof zCreateBook>;
export const zPatchBook = z.object({ status: z.enum(['active', 'paused', 'archived']).optional(), title: z.string().optional() });
export const BOOK_ACTIONS = ['start', 'pause', 'resume', 'reindex', 'rewind', 'drain', 'migrate'] as const;
export const zBookAction = z.object({ action: z.enum(BOOK_ACTIONS), to: z.number().int().optional(), confirm: z.boolean().default(false), interview: z.boolean().optional() });

/** book.yaml 原文编辑 */
export interface BookConfigDoc {
  raw: string;
  parsed: BookConfig | null;
  errors: { path: string; message: string }[];
  sha: string;
}
export const zPutBookConfig = z.object({ raw: z.string(), baseSha: z.string() });

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

export interface PlanOverview {
  compass: unknown | null;
  compassApproved: boolean;
  volumes: { id: string; title: string; detail: string; chapters: [string, string] | null }[];
  arcs: { id: string; volume: string; title: string; chapters: [string, string]; resolved: boolean }[];
  cards: { id: string; title: string; stale: boolean; key: boolean; state: ChapterWorkflowState | 'planned' }[];
  cardBuffer: { have: number; min: number; target: number };
  endgame: boolean;
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
  arc: string;
  state: ChapterWorkflowState;
  cjk: number;
  acceptedAt: string | null;
  audited: boolean;
  publishedAt: string | null;
  verdict: Review['verdict'] | null;
  revisions: number;
  degraded: boolean;
  debts: number;
}
export interface ChapterAdminDetail extends ChapterRow {
  text: string | null;
  draft: string | null;
  card: Card | null;
  delta: Delta | null;
  review: Review | null;
  gates: GateResult[];
  debtsList: Debt[];
  runs: RunRow[];
  commit: string | null;
}
export const CHAPTER_ACTIONS = ['rewrite', 'repair', 'reextract', 'approve', 'hold', 'unhold', 'publish_now'] as const;
export const zChapterAction = z.object({ action: z.enum(CHAPTER_ACTIONS), note: z.string().optional(), confirm: z.boolean().default(false), ignoreAudit: z.boolean().optional() });
export const zPutChapterText = z.object({ text: z.string().min(1), baseSha: z.string(), confirm: z.boolean().default(false) });

export interface StateView {
  snapshot: Pick<Snapshot, 'through' | 'hash' | 'time' | 'total_cjk'>;
  entities: (EntityState & { tier: string; aliases: string[] })[];
  obligations: ObligationState[];
  overdue: ObligationState[];
  knowledge: { who: string; facts: string[] }[];
  readerKnows: string[];
  timeline: { ch: string; what: string; who: string[] }[];
}

// ───────────────────────── 任务 / run ─────────────────────────
export interface TaskRow {
  id: string;
  bookSlug: string | null;
  kind: TaskKind;
  target: string;
  lane: string;
  tier: string | null;
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
  kind: TaskKind;
  attempt: number;
  role: RoleId;
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
export const zInstructionPreviewRequest = z.object({
  book: z.string().optional(),
  genre: z.string().optional(),
  role: zRoleId,
  harness: zHarnessId,
  profileId: z.string().optional(),
  taskKind: z.string().optional(),
  chapter: z.number().int().optional(),
  /** 草稿覆盖：path → 未保存内容，用于编辑器实时预览 */
  drafts: z.record(z.string(), z.string()).default({}),
});
export type InstructionPreviewRequest = z.input<typeof zInstructionPreviewRequest>;
export interface InstructionLayerReport {
  id: string; // S0 | S1 | L1 | L1.role | L2:<genre> | L2:<genre>.role | L3 | L3.role | L3.9
  label: string;
  source: string; // 文件路径
  bytes: number;
  tokens: number;
  mode: 'replace' | 'extends';
}
export interface EffectiveGate {
  rule: string;
  family: 'contract' | 'craft';
  level: 'hard' | 'soft' | 'off';
  params: Record<string, unknown>;
  allow: string[];
  source: 'novelist' | 'builtin' | 'global' | 'genre' | 'book';
}
export interface InstructionPreview {
  /** 预览用占位 nonce（不是真实 run 的 nonce） */
  systemMd: string;
  workspaceDoc: string;
  layers: InstructionLayerReport[];
  /** 被同一来源层内后继角色文件替换、不生效的层 */
  replaced: { id: string; label: string; source: string }[];
  budget: { ok: boolean; bytes: number; limit: number | null; reason?: string };
  effectiveGates: EffectiveGate[];
  /** adapter.materialize 的产物（文件与 argv 预览，秘密值已打码） */
  materialized: { files: { path: string; content: string }[]; argv: string[]; env: Record<string, string> };
  lastAuthorBlock: string;
}

// ───────────────────────── 题材包 ─────────────────────────
export interface GenreSummary {
  id: string;
  name: string;
  description: string;
  extends: string[];
  builtin: boolean;
  books: number;
  files: string[];
  /** pack.yaml 的 auto 配置摘要；null 表示未配置 */
  auto: { enabled: boolean; weight: number; keywords: number; lengthHint: string } | null;
}
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
  circuit: { state: 'closed' | 'open' | 'half_open' | 'pending_open'; reason: string | null; effectiveAt: string | null };
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
export const zCreateProfile = zProfile;
export const zPatchProfile = zProfile.partial().omit({ id: true });
export const zCreatePreset = zRoutingPreset;
export const zPutActiveRouting = z.object({ presetId: z.string(), overrides: z.partialRecord(zRoleId, zRoleRoute).default({}) });
export interface ActiveRouting {
  presetId: string;
  overrides: Partial<Record<RoleId, unknown>>;
  effective: RoutingPreset;
}
export interface FeasibilityReport {
  book: string | null;
  tier: QualityTier;
  roles: RouteDecision[];
  problems: { severity: 'error' | 'warning' | 'info'; role: RoleId | null; message: string }[];
  /** 每窗口可写章数估算（来自实测账本；无数据时 null） */
  chaptersPerWindow: { accountId: string; window: string; chapters: number | null; basis: string }[];
}

// ───────────────────────── 发布 / 配额 / 用量 ─────────────────────────
export interface PublishOverview {
  slug: string;
  title: string;
  config: PublishConfig;
  frontiers: Frontiers;
  nextSlots: string[];
  paused: boolean;
  pausedReason: string | null;
}
export const zPutPublish = zPublishConfig.partial();
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
export const zPutSettings = zSystemSettings.partial();
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
  bootstrapExtract: z.boolean().default(false),
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
/** 质量页：弧指纹相似度、extractor 召回、审计前沿（DESIGN §9.2） */
export interface BookQuality {
  arcs: { arc: string; ts: string; features: Record<string, unknown>; similarityToPrev: number | null; topMatch: { arc: string; similarity: number } | null }[];
  recall: { chapter: string; misses: number }[];
  recallTotal: number;
  frontiers: { accepted: number; audited: number; published: number };
  audits: { name: string; kind: string; range: [string, string]; passed: boolean; hard: number; soft: number; ts: string }[];
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
  { method: 'GET', path: '/api/admin/books', auth: 'admin', res: 'BookSummary[]', desc: '书列表' },
  { method: 'POST', path: '/api/admin/books', auth: 'admin', req: 'CreateBook', res: 'BookSummary', desc: '开书（book new）' },
  { method: 'GET', path: '/api/admin/books/:slug', auth: 'admin', res: 'BookOverview', desc: '书概览' },
  { method: 'PATCH', path: '/api/admin/books/:slug', auth: 'admin', req: 'PatchBook', res: 'BookSummary', desc: '改状态/标题' },
  { method: 'DELETE', path: '/api/admin/books/:slug', auth: 'admin', res: 'Ok', desc: '删除书（需 ?confirm=slug）' },
  { method: 'POST', path: '/api/admin/books/:slug/actions', auth: 'admin', req: 'BookAction', res: 'Ok', desc: 'start/pause/resume/reindex/rewind/drain/migrate' },
  { method: 'GET', path: '/api/admin/books/:slug/config', auth: 'admin', res: 'BookConfigDoc', desc: 'book.yaml 原文+解析' },
  { method: 'PUT', path: '/api/admin/books/:slug/config', auth: 'admin', req: 'PutBookConfig', res: 'BookConfigDoc', desc: '保存 book.yaml（committer 提交）' },
  { method: 'GET', path: '/api/admin/books/:slug/tree', auth: 'admin', res: 'RepoEntry[]', desc: '书库文件树（?dir=）' },
  { method: 'GET', path: '/api/admin/books/:slug/file', auth: 'admin', res: 'RepoFile', desc: '读书库文件（?path=）' },
  { method: 'PUT', path: '/api/admin/books/:slug/file', auth: 'admin', req: 'PutRepoFile', res: 'RepoFile|ImpactEstimate', desc: '写书库文件（needsConfirm 时 409 返回 ImpactEstimate）' },
  { method: 'POST', path: '/api/admin/books/:slug/file/impact', auth: 'admin', req: 'PutRepoFile', res: 'ImpactEstimate', desc: '保存前影响估算' },
  { method: 'GET', path: '/api/admin/books/:slug/git/log', auth: 'admin', res: 'Page<GitCommitRow>', desc: '提交历史（含 trailer）' },
  { method: 'GET', path: '/api/admin/books/:slug/plan', auth: 'admin', res: 'PlanOverview', desc: '规划总览' },
  { method: 'GET', path: '/api/admin/books/:slug/quality', auth: 'admin', res: 'BookQuality', desc: '质量页（弧指纹、召回统计、审计前沿）' },
  { method: 'GET', path: '/api/admin/books/:slug/chapters', auth: 'admin', res: 'Page<ChapterRow>', desc: '章节列表' },
  { method: 'GET', path: '/api/admin/books/:slug/chapters/:no', auth: 'admin', res: 'ChapterAdminDetail', desc: '章节详情' },
  { method: 'PUT', path: '/api/admin/books/:slug/chapters/:no/text', auth: 'admin', req: 'PutChapterText', res: 'ChapterAdminDetail|ImpactEstimate', desc: '手改正文（触发级联）' },
  { method: 'POST', path: '/api/admin/books/:slug/chapters/:no/actions', auth: 'admin', req: 'ChapterAction', res: 'Ok', desc: '章节操作' },
  { method: 'GET', path: '/api/admin/books/:slug/state', auth: 'admin', res: 'StateView', desc: '状态视图（snapshot）' },
  { method: 'GET', path: '/api/admin/books/:slug/reviews', auth: 'admin', res: 'Page<Review>', desc: '评审记录' },
  { method: 'GET', path: '/api/admin/books/:slug/audits', auth: 'admin', res: 'Audit[]', desc: '审计记录' },
  { method: 'GET', path: '/api/admin/books/:slug/debts', auth: 'admin', res: 'Debt[]', desc: '债务' },
  { method: 'GET', path: '/api/admin/books/:slug/feasibility', auth: 'admin', res: 'FeasibilityReport', desc: '路由可行性检查' },
  { method: 'GET', path: '/api/admin/books/:slug/publish', auth: 'admin', res: 'PublishOverview', desc: '发布配置与前沿' },
  { method: 'PUT', path: '/api/admin/books/:slug/publish', auth: 'admin', req: 'PutPublish', res: 'PublishOverview', desc: '改发布配置（写回 book.yaml）' },
  { method: 'POST', path: '/api/admin/books/:slug/publish/now', auth: 'admin', req: 'PublishNow', res: 'Ok', desc: '立即发布' },
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
  { method: 'POST', path: '/api/admin/instructions/preview', auth: 'admin', req: 'InstructionPreviewRequest', res: 'InstructionPreview', desc: '编译预览（按 harness）+ 生效 gate' },
  { method: 'GET', path: '/api/admin/genres', auth: 'admin', res: 'GenreSummary[]', desc: '题材包列表' },
  { method: 'POST', path: '/api/admin/genres', auth: 'admin', req: 'CreateGenre', res: 'GenreSummary', desc: '新建题材包' },
  { method: 'DELETE', path: '/api/admin/genres/:id', auth: 'admin', res: 'Ok', desc: '删除题材包（内置不可删）' },
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
  { method: 'GET', path: '/api/admin/routing/presets', auth: 'admin', res: 'RoutingPreset[]', desc: '路由 preset' },
  { method: 'POST', path: '/api/admin/routing/presets', auth: 'admin', req: 'RoutingPreset', res: 'RoutingPreset', desc: '新建自定义 preset' },
  { method: 'PUT', path: '/api/admin/routing/presets/:id', auth: 'admin', req: 'RoutingPreset', res: 'RoutingPreset', desc: '修改 preset（内置会另存为副本）' },
  { method: 'DELETE', path: '/api/admin/routing/presets/:id', auth: 'admin', res: 'Ok', desc: '删除自定义 preset' },
  { method: 'GET', path: '/api/admin/routing/active', auth: 'admin', res: 'ActiveRouting', desc: '当前生效路由' },
  { method: 'PUT', path: '/api/admin/routing/active', auth: 'admin', req: 'PutActiveRouting', res: 'ActiveRouting', desc: '切换 preset / 全局覆盖' },
  { method: 'POST', path: '/api/admin/routing/check', auth: 'admin', res: 'FeasibilityReport', desc: '全局可行性检查（?book=）' },
  // schedule / quota / usage
  { method: 'GET', path: '/api/admin/schedule', auth: 'admin', res: 'PublishOverview[]', desc: '全部书的发布排期' },
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
  { method: 'GET', path: '/api/admin/settings', auth: 'admin', res: 'SystemSettings', desc: '系统设置' },
  { method: 'PUT', path: '/api/admin/settings', auth: 'admin', req: 'PutSettings', res: 'SystemSettings', desc: '修改系统设置' },
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
export type _ApiTypeRefs = [Profile, Audit, RunState, AccountState];
