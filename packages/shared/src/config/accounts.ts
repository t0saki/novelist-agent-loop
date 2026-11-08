/**
 * Harness 账号（D5）：env 变量（key / base URL）、上传的凭据文件、网页交互登录、订阅档位、并发与配额余量。
 * 秘密值从不出现在这些 DTO 里——只有 secret 引用与“是否已设置”。
 */
import { z } from 'zod';
import { QUOTA_WINDOWS, zAuthMode, zHarnessId } from '../enums.js';

export const zEnvBinding = z.object({
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  /** 非秘密值（如 ANTHROPIC_BASE_URL）直接存；秘密值存 secrets 表，这里只放 secretId */
  value: z.string().optional(),
  secretId: z.string().optional(),
  secret: z.boolean().default(false),
});
export type EnvBinding = z.infer<typeof zEnvBinding>;

export const zCredentialFile = z.object({
  /** 相对账号 home 的路径，如 .codex/auth.json、.grok/auth.json、adc.json */
  relPath: z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+$/),
  secretId: z.string(),
  /** state：可被 harness 刷新回写（codex auth.json）；config：每 run 只读物化 */
  part: z.enum(['state', 'config']).default('state'),
  uploadedAt: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
});
export type CredentialFile = z.infer<typeof zCredentialFile>;

export const zQuotaWindowConfig = z.object({
  window: z.enum(QUOTA_WINDOWS),
  /** 人工给定的容量（单位由 unit 决定）；未知则 null，由实测账本估算 */
  capacity: z.number().nullable().default(null),
  unit: z.enum(['pct', 'messages', 'tokens', 'usd']).default('pct'),
});

export const zAccount = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  harness: zHarnessId,
  label: z.string().default(''),
  authMode: zAuthMode,
  /** 订阅档位标签：pro/max/ultra/plus/team/free/api/custom… 仅用于 UI 与容量估算 */
  plan: z.string().default(''),
  enabled: z.boolean().default(true),
  env: z.array(zEnvBinding).default([]),
  files: z.array(zCredentialFile).default([]),
  /** custom_api 下的自定义模型名（会并入该 harness 的模型列表） */
  customModels: z.array(z.string()).default([]),
  concurrency: z.number().int().positive().default(1),
  reservePct: z.number().min(0).max(100).default(30),
  maxWeeklyUtilPct: z.number().min(0).max(100).optional(),
  monthlyUsdCap: z.number().nonnegative().optional(),
  windows: z.array(zQuotaWindowConfig).default([]),
  /** 已确认的风险条款，如 ["agy_consumer_wrap"] */
  riskAck: z.array(z.string()).default([]),
  notes: z.string().default(''),
});
export type Account = z.infer<typeof zAccount>;
export type AccountInput = z.input<typeof zAccount>;

/** 账号运行时状态（accounts_state 表） */
export const zAccountState = z.object({
  accountId: z.string(),
  sleepUntil: z.string().nullable(),
  sleepReason: z.string().nullable(),
  util: z.record(z.string(), z.object({ utilization: z.number().nullable(), resetsAt: z.string().nullable(), ts: z.string() })).default({}),
  credExpiresAt: z.string().nullable(),
  lastAuthCheck: z.object({ ok: z.boolean(), ts: z.string(), detail: z.string().optional(), configOnly: z.boolean().optional() }).nullable(),
  activeRuns: z.number().int().default(0),
});
export type AccountState = z.infer<typeof zAccountState>;

/** 风险说明（UI 信息展示；D5：agy consumer 照常可用，只显示说明） */
export const RISK_NOTES: Record<string, { level: 'low' | 'medium' | 'high'; text: string; source?: string }> = {
  agy_consumer_wrap: {
    level: 'high',
    text: 'Antigravity 官方 FAQ：consumer 订阅下将 agy 包装进第三方应用“not supported”，可能导致账号受限。是否使用由你决定。',
    source: 'https://antigravity.google/docs/faq',
  },
  cc_subscription_unattended: {
    level: 'medium',
    text: 'Claude 订阅额度按“ordinary, individual usage”设定，24/7 无人值守属于灰区；额度与本人交互使用共享。',
  },
  codex_subscription_automation: {
    level: 'medium',
    text: 'OpenAI 指引：自动化场景推荐 API key；ChatGPT 登录下 codex exec 未被禁止。',
  },
  api_key_billing: { level: 'low', text: 'API key 按量计费，受月度 USD 上限约束。' },
};
