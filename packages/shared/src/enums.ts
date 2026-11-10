/** 全局枚举。新增取值 = 追加（additive），不得改名/删除（见 IMPL.md §1.3）。 */
import { z } from 'zod';

export const HARNESS_IDS = ['claude-code', 'codex', 'agy', 'grok', 'dsh', 'pi', 'fake'] as const;
export type BuiltinHarnessId = (typeof HARNESS_IDS)[number];
export type HarnessId = BuiltinHarnessId | `acp:${string}`;
export const zHarnessId = z
  .string()
  .refine((s) => (HARNESS_IDS as readonly string[]).includes(s) || /^acp:[a-z0-9-]+$/.test(s), 'unknown harness id') as unknown as z.ZodType<HarnessId>;
/** harness → 厂商（用于 vendor_ne 约束、厂商白名单） */
export const HARNESS_VENDOR: Record<BuiltinHarnessId, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  agy: 'google',
  grok: 'xai',
  dsh: 'deepseek',
  pi: 'mixed',
  fake: 'fake',
};

export const ROLE_IDS = [
  'planner',
  'showrunner',
  'writer',
  'checker',
  'confirm',
  'extractor',
  'format_checker',
  'summarizer',
  'auditor',
  // opt-in roles
  'reviewer',
  'continuity',
  'judge',
  'plan_judge',
  'extractor_cross',
  'heldout',
  'editor',
  'stylist',
  // system
  'canary',
] as const;
export type RoleId = (typeof ROLE_IDS)[number];
export const zRoleId = z.enum(ROLE_IDS);

/** 附录 B 任务目录 + 系统任务 */
export const TASK_KINDS = [
  'plan.interview',
  'plan.premise',
  'plan.compass',
  'plan.bible',
  'plan.volumes',
  'plan.volume',
  'plan.arc',
  'plan.fix',
  'card.repair',
  'ctx.build',
  'chapter.write',
  'chapter.revise',
  'chapter.expand',
  'chapter.compress',
  'chapter.extract',
  'chapter.reextract',
  'chapter.check',
  'format.repair',
  'chapter.formatcheck',
  'chapter.confirm',
  'chapter.review',
  'chapter.pairwise',
  'chapter.deslop',
  'chapter.accept',
  'chapter.ingest',
  'chapter.repair',
  'summary.arc',
  'summary.volume',
  'book.blurb',
  'audit.window',
  'audit.arc',
  'audit.volume',
  'audit.heldout',
  'bakeoff.write',
  'bakeoff.judge',
  'import.bootstrap',
  'index.rebuild',
  'slop.fingerprint',
  'media.cover',
  'publish',
  'routing.feasibility',
  'harness.canary',
  // v3 流程（docs/v3/DESIGN.md）：一次运行写一批
  'book.open',
  'book.write',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const zTaskKind = z.enum(TASK_KINDS);

export const LANES = ['write', 'side', 'system'] as const;
export type Lane = (typeof LANES)[number];

/** 质量档位。lean = lite 的别名（DESIGN §6.4）。默认 standard（D2 修订）。 */
export const QUALITY_TIERS = ['lite', 'lean', 'standard', 'key'] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];
export const zQualityTier = z.enum(QUALITY_TIERS);
export const normalizeTier = (t: QualityTier): 'lite' | 'standard' | 'key' => (t === 'lean' ? 'lite' : t);

export const TASK_STATES = [
  'pending', // 依赖未满足
  'ready', // 可派发
  'waiting', // not_before 未到 / 等配额 / 等审批
  'leased', // 已认领、准备 run
  'running', // run 进行中
  'finalizing', // 校验 / promote 中
  'done',
  'failed', // 重试耗尽
  'blocked', // 需人工（Inbox）
  'stale', // hard deps 变化，作废
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const RUN_STATES = [
  'preparing',
  'spawned',
  'running',
  'exited',
  'finalized',
  'lost', // lease 过期且无法接管
  'killed',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const ISOLATION_BACKENDS = ['bwrap', 'landlock', 'container', 'degraded'] as const;
export type IsolationBackend = (typeof ISOLATION_BACKENDS)[number];
export type IsolationPreference = IsolationBackend | 'auto';

/** §3.2 错误类 */
export const ERROR_CLASSES = [
  'auth',
  'quota',
  'rate_limit',
  'overloaded',
  'billing',
  'model_unavailable',
  'network',
  'timeout_wall',
  'timeout_idle',
  'refusal',
  'context_overflow',
  'max_turns',
  'budget',
  'permission_denied',
  'sandbox',
  'config',
  'drift',
  'harness_crash',
  'output_contract',
  'unknown',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
export const zErrorClass = z.enum(ERROR_CLASSES);

/**
 * 账号认证模式（D5）。每个 harness 支持其中的子集，由 adapter.authMethods() 声明。
 * - subscription_login：harness 自己的登录（device-code/浏览器），凭据落在账号 home 的 state 部分
 * - oauth_token：长期 token 走 env（cc: CLAUDE_CODE_OAUTH_TOKEN）
 * - credential_file：上传凭据文件（codex/grok auth.json、ADC json 等）
 * - api_key：厂商官方 API key（DEEPSEEK_API_KEY、GEMINI_API_KEY、XAI_API_KEY、CODEX_API_KEY…）
 * - custom_api：自建网关（cc: ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN + 自定义模型名；
 *   codex: 自定义 provider；agy: GOOGLE_GEMINI_BASE_URL）
 * - adc：Google ADC（agy）
 * - none：fake
 */
export const AUTH_MODES = [
  'subscription_login',
  'oauth_token',
  'credential_file',
  'api_key',
  'custom_api',
  'adc',
  'none',
] as const;
export type AuthMode = (typeof AUTH_MODES)[number];
export const zAuthMode = z.enum(AUTH_MODES);

export const QUOTA_WINDOWS = ['5h', '7d', 'daily', 'minute', 'model_7d', 'monthly_usd', 'other'] as const;
export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

export const INBOX_KINDS = [
  'approval', // 审批门（compass / 第一卷 / 契约演进 / main 伏笔 abandon / failover 提案）
  'hold', // 章节 hold（关键章耗尽）
  'block', // lane block（正典 hard 冲突 / IO 契约失败）
  'question', // receipt.questions_for_planner
  'auth', // 账号认证失效
  'quota', // 周窗口耗尽 / 存稿不足
  'circuit', // 熔断提案
  'model_change', // 写手模型漂移
  'format_migration', // 书库格式版本旧
  'agents_md_edit', // 根 AGENTS.md 被手改
  'studio_conflict',
  'notice',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const BOOK_STATUSES = ['draft', 'planning', 'active', 'paused', 'completed', 'archived', 'importing'] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];

export const COUNT_MODES = ['han', 'platform'] as const;
export type CountMode = (typeof COUNT_MODES)[number];
