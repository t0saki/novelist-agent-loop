// copied verbatim from db19762 (packages/shared/src/config/routing.ts); do not edit — the previous image's schema, used by test/compat.prev-image.test.ts
/**
 * 路由与 profile（DESIGN §7.4；D2 修订：全部在 Web UI 配置，无需预先决定）。
 * profile = (harness, model, effort, 账号池)；preset = 角色 → 路由的整套映射；书可在 book.yaml 覆盖。
 */
import { z } from 'zod';
import { zHarnessId, zRoleId } from '../enums.js';

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

export const ROUTE_CONSTRAINTS = ['none', 'vendor_ne_writer', 'vendor_ne_planner', 'not_in_judges'] as const;
export const zRoleRoute = z.object({
  /** 有序 profile 链；第一个可用者胜出 */
  chain: z.array(z.string()).min(1),
  /** 降级链（约束不可满足或额度耗尽时，按序放宽；§7.4） */
  degrade_to: z.array(z.string()).default([]),
  same_as: zRoleId.optional(),
  sticky: z.enum(['book', 'none']).default('none'),
  on_quota: z.enum(['wait', 'degrade']).default('degrade'),
  failover_after_ms: z.number().int().optional(),
  failover_on: z.array(z.enum(['auth', 'circuit_open', 'model_unavailable'])).default([]),
  failover_chain: z.array(z.string()).default([]),
  failover_requires_approval: z.boolean().default(true),
  constraint: z.enum(ROUTE_CONSTRAINTS).default('none'),
  /** judges：panel 人数与是否要求不同厂商 */
  panel: z.number().int().positive().optional(),
  distinct_vendors: z.boolean().default(false),
});
export type RoleRoute = z.infer<typeof zRoleRoute>;
export type RoleRouteInput = z.input<typeof zRoleRoute>;

export const zRoutingPreset = z.object({
  schema: z.literal('nv.routing/1').default('nv.routing/1'),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  description: z.string().default(''),
  builtin: z.boolean().default(false),
  /** 本 preset 需要的 profile 模板（导入 preset 时若同 id profile 不存在则创建） */
  profiles: z.array(z.lazy(() => zProfile)).default([]),
  roles: z.partialRecord(zRoleId, zRoleRoute),
});
export type RoutingPreset = z.infer<typeof zRoutingPreset>;
export type RoutingPresetInput = z.input<typeof zRoutingPreset>;

/** routing.resolve 的结果（lane F 产出，UI 可行性检查展示） */
export const zRouteDecision = z.object({
  role: zRoleId,
  profile: z.string().nullable(),
  account: z.string().nullable(),
  harness: z.string().nullable(),
  model: z.string().nullable(),
  degraded: z.array(z.object({ from: z.string(), to: z.string(), reason: z.string() })).default([]),
  /** 无可用 profile 时：等待到何时 / 原因 */
  waitUntil: z.string().nullable().default(null),
  reason: z.string().optional(),
  sameVendorAsWriter: z.boolean().default(false),
});
export type RouteDecision = z.infer<typeof zRouteDecision>;
