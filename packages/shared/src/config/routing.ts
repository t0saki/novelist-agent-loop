/**
 * profile（DESIGN §7；全部在 Web UI 配置）：profile = (harness, model, effort, 账号池)。
 * 路由只剩两个位置（写作 / 杂活），见 config/slots.ts；书可在 book.yaml routing.writer_profile 覆盖写作位置的主用。
 */
import { z } from 'zod';
import { zHarnessId } from '../enums.js';

export const zProfile = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  label: z.string().default(''),
  harness: zHarnessId,
  /** 模型 slug（UI 通过 GET /api/admin/harness/:id/models 列出可选值；自定义 API 可填任意名） */
  model: z.string().min(1),
  effort: z.string().optional(),
  /** 账号池：空数组 = 该 harness 的任意已启用账号 */
  accounts: z.array(z.string()).default([]),
  driver: z.enum(['spawn', 'acp']).default('spawn'),
  enabled: z.boolean().default(true),
  /** 需要用户勾选的风险确认（如 agy_consumer_wrap）；未确认则 profile 不可用 */
  requires_ack: z.array(z.string()).default([]),
  limits: z
    .object({ wallMs: z.number().int().optional(), idleMs: z.number().int().optional(), maxTurns: z.number().int().optional(), maxBudgetUsd: z.number().optional() })
    .default({}),
  /** 追加给 harness 的额外 argv（高级；adapter 负责过滤危险项） */
  extra_args: z.array(z.string()).default([]),
  /** 标签：dev = 仅供开发测试的廉价模型 */
  tags: z.array(z.string()).default([]),
});
export type Profile = z.infer<typeof zProfile>;
export type ProfileInput = z.input<typeof zProfile>;
