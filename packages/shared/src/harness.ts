/** Harness 共享类型（DESIGN §3.1、§3.8）。HarnessAdapter 接口本身在 apps/server/src/harness/types.ts。 */
import { z } from 'zod';
import { ISOLATION_BACKENDS, zErrorClass, zHarnessId } from './enums.js';

export const zHarnessInstall = z.object({
  id: zHarnessId,
  version: z.string(),
  binPath: z.string(),
  nodeVersion: z.string().optional(),
  sha256: z.string().default(''),
  sha256Source: z.enum(['tofu', 'upstream-lock']).default('tofu'),
  tier: z.enum(['blessed', 'probed', 'unknown']).default('unknown'),
  status: z.enum(['candidate', 'canary', 'active', 'disabled']).default('candidate'),
});
export type HarnessInstall = z.infer<typeof zHarnessInstall>;

export const zCapabilities = z.object({
  version: z.string(),
  verifiedAt: z.string(),
  isolation: z.enum(ISOLATION_BACKENDS),
  models: z.array(z.string()),
  modelSnapshotIds: z.record(z.string(), z.string()).optional(),
  structuredOutput: z.enum(['native', 'none']),
  schemaDialect: z.enum(['strict', 'lenient', 'none']),
  systemChannel: z.enum(['append-file', 'developer', 'rules-arg', 'agent-file', 'persona-patch', 'append-arg']),
  systemReplace: z.boolean(),
  shellTool: z.enum(['disableable', 'always']),
  webTool: z.enum(['disableable', 'always']),
  subagentTool: z.enum(['disableable', 'always']),
  honorsHttpsProxy: z.boolean(),
  workspaceDocLoaded: z.boolean(),
  systemChannelLoaded: z.boolean(),
  tailNonceSurvives: z.boolean(),
  maxInstructionBytes: z.number().int().optional(),
  sessionPreassign: z.boolean(),
  resume: z.boolean(),
  fork: z.boolean(),
  stopHook: z.enum(['verified', 'unverified', 'none']),
  mcpHttp: z.enum(['verified', 'unverified', 'none']),
  exitZeroOnFailure: z.boolean(),
  quotaSignal: z.enum(['inline', 'probe', 'error-only', 'none']),
  templateEscaping: z.enum(['braces-escaped', 'incompatible']).optional(),
  eventTypesSeen: z.array(z.string()),
  /** probe 各步骤结果（UI 展示） */
  probeSteps: z.array(z.object({ step: z.string(), ok: z.boolean(), detail: z.string().optional() })).default([]),
});
export type Capabilities = z.infer<typeof zCapabilities>;

export const zUsage = z.object({
  input: z.number().default(0),
  cachedInput: z.number().default(0),
  cacheWrite: z.number().default(0),
  output: z.number().default(0),
  reasoning: z.number().default(0),
  costUsd: z.number().optional(),
  costSource: z.enum(['harness', 'computed', 'unknown']).default('unknown'),
});
export type Usage = z.infer<typeof zUsage>;

/** §3.1 Outcome：completed 只表示 harness 自认为完成；验收由 validators 根据文件决定 */
export const zOutcome = z.object({
  status: z.enum(['completed', 'failed', 'cancelled', 'timeout']),
  errorClass: zErrorClass.optional(),
  retryAfter: z.string().optional(),
  sessionId: z.string().optional(),
  model: z.string().optional(),
  usage: zUsage,
  denials: z.array(z.object({ tool: z.string(), path: z.string().optional(), detail: z.string().optional() })).default([]),
  receipt: z.unknown().optional(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().default(null),
  message: z.string().optional(),
  rateLimits: z
    .array(z.object({ window: z.string(), utilization: z.number().optional(), resetsAt: z.string().optional(), status: z.string() }))
    .default([]),
});
export type Outcome = z.infer<typeof zOutcome>;

export const zQuotaSnapshot = z.object({
  ts: z.string(),
  windows: z.array(z.object({ window: z.string(), utilization: z.number().nullable(), resetsAt: z.string().nullable() })),
  raw: z.unknown().optional(),
});
export type QuotaSnapshot = z.infer<typeof zQuotaSnapshot>;

/** 认证方法描述（adapter.authMethods()；UI 据此渲染账号表单） */
export const zAuthMethodSpec = z.object({
  mode: z.string(),
  label: z.string(),
  /** 需要的 env 变量 */
  env: z.array(z.object({ name: z.string(), secret: z.boolean(), required: z.boolean(), hint: z.string().optional() })).default([]),
  /** 可上传的凭据文件 */
  files: z.array(z.object({ relPath: z.string(), part: z.enum(['state', 'config']), hint: z.string().optional() })).default([]),
  /** 交互式登录命令（网页“交互登录”按钮）；null = 不支持 */
  login: z.object({ argv: z.array(z.string()), hint: z.string().optional() }).nullable().default(null),
  riskNote: z.string().optional(),
  allowsCustomModels: z.boolean().default(false),
  /** 每组至少填一个（如自定义网关的 API_KEY / AUTH_TOKEN） */
  requireOneOf: z.array(z.array(z.string())).optional(),
});
export type AuthMethodSpec = z.infer<typeof zAuthMethodSpec>;

/** 交互登录会话（网页：输出流 + 输入框）。解析出的 URL/验证码单列，便于 UI 高亮 */
export const zLoginSession = z.object({
  id: z.string(),
  accountId: z.string(),
  harness: zHarnessId,
  state: z.enum(['starting', 'waiting_user', 'succeeded', 'failed', 'cancelled', 'expired']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  urls: z.array(z.string()).default([]),
  codes: z.array(z.string()).default([]),
  exitCode: z.number().int().nullable().default(null),
});
export type LoginSession = z.infer<typeof zLoginSession>;
export const zLoginOutputChunk = z.object({ seq: z.number().int(), ts: z.string(), stream: z.enum(['stdout', 'stderr', 'input', 'system']), text: z.string() });
export type LoginOutputChunk = z.infer<typeof zLoginOutputChunk>;

export const zIsolationProbe = z.object({
  ts: z.string(),
  selected: z.enum(ISOLATION_BACKENDS),
  preference: z.enum([...ISOLATION_BACKENDS, 'auto']),
  backends: z.array(z.object({ backend: z.enum(ISOLATION_BACKENDS), available: z.boolean(), detail: z.string(), fixHint: z.string().optional() })),
  kernel: z.string().optional(),
  lsm: z.array(z.string()).default([]),
  landlockAbi: z.number().int().nullable().default(null),
  inContainer: z.boolean(),
});
export type IsolationProbe = z.infer<typeof zIsolationProbe>;
