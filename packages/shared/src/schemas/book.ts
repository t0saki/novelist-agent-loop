/**
 * book.yaml（nv.book/1）。D2/D4/D6：规模、档位、路由覆盖、发布、预算全部可在 Web UI 编辑并写回 book.yaml。
 * 合并语义：书 > 题材 > 全局 > 内置，按键深合并，数组整体替换（mergeLayers，见 ../merge.ts）。
 * 注意：parse 时所有字段都有默认值；Novelist 写回时只写用户显式设置过的键（UI 用 raw yaml 编辑，避免把默认值固化）。
 */
import { z } from 'zod';
import { zQualityTier, zRoleId } from '../enums.js';
import { zGateOverride } from './genre.js';
import { zLengthSpec } from './plan.js';
import { zRoleRoute } from '../config/routing.js';

export const BOOK_FORMAT_VERSION = 1;

export const zApprovalGate = z.object({
  required: z.boolean(),
  timeout: z.string().optional(), // ISO8601 duration，如 PT48H
  on_timeout: z.enum(['wait', 'auto_approve', 'skip']).default('wait'),
});

export const zPublishConfig = z.object({
  /** scheduled（D4 默认）| immediate（v1 行为）| manual */
  mode: z.enum(['scheduled', 'immediate', 'manual']).default('scheduled'),
  cadence: z.string().default('0 8,20 * * *'),
  timezone: z.string().default('Asia/Shanghai'),
  per_slot: z.number().int().positive().default(1),
  /** auto = max(当前弧长, min_lag)；数字不得小于 min_lag */
  lag: z.union([z.literal('auto'), z.number().int().nonnegative()]).default('auto'),
  min_lag: z.number().int().nonnegative().default(15),
  require_audited: z.boolean().default(true),
  max_buffer: z.number().int().positive().default(60),
  resume_buffer: z.number().int().positive().default(45),
  freeze_on_publish: z.boolean().default(true),
  low_buffer_days_alert: z.number().default(3),
});
export type PublishConfig = z.infer<typeof zPublishConfig>;

export const zExhaustPolicy = z.object({
  soft_only: z.object({ normal: z.enum(['accept_with_debt', 'hold']).default('accept_with_debt'), key: z.enum(['accept_with_debt', 'hold']).default('accept_with_debt') }).default({ normal: 'accept_with_debt', key: 'accept_with_debt' }),
  craft_hard: z.object({ normal: z.enum(['accept_with_debt', 'hold', 'block']).default('accept_with_debt'), key: z.enum(['accept_with_debt', 'hold', 'block']).default('hold') }).default({ normal: 'accept_with_debt', key: 'hold' }),
  canon_hard: z.enum(['block', 'hold']).default('block'),
});

/** Novelist 3（docs/v3/DESIGN.md）：书级流程开关。缺省 v2 = 旧流水线 */
export const FLOWS = ['v2', 'v3'] as const;
export type Flow = (typeof FLOWS)[number];
export const zEffort = z.enum(['low', 'medium', 'high']);
export type Effort = z.infer<typeof zEffort>;
export const V3_LENGTHS = ['short', 'medium', 'long', 'epic'] as const; // 与 AUTO_LENGTHS 同一组 id
export type V3Length = (typeof V3_LENGTHS)[number];
/** Placeholder title for v3 books created without a title. Deliberately different from auto-start's '待命名·' so nameAutoBooks never touches v3 books. */
export const V3_TITLE_PLACEHOLDER = '未命名·';

export const zV3BookConfig = z.object({
  length: z.enum(V3_LENGTHS).default('medium'),
  /** Lower bound for the whole book (CJK chars). Exceeding it triggers nothing. */
  target_cjk: z.number().int().positive().default(60_000),
  /** Planned chapter count. Server writes N0 = ceil(target_cjk / 4000) at creation and updates it from outline.md "计划：共 N 章" (clamped to [ceil(N0/2), 2*N0]). */
  planned_chapters: z.number().int().positive().optional(),
  /** N0, fixed at creation (used for the clamp and for "最多 X 章" in ORDER). */
  planned_chapters_initial: z.number().int().positive().optional(),
  min_chapter_cjk: z.number().int().positive().default(3000),
  batch: z.number().int().min(1).max(8).default(5),
  /** §3.4: a chapter becomes publishable this many hours after acceptance (if nothing else frees it earlier) */
  publish_after_hours: z.number().positive().default(24),
  /** Title left empty at creation: take the title from line 1 of bible.md after a harvest, until one is found */
  auto_title: z.boolean().default(false),
  effort: z
    .object({ open: zEffort.default('medium'), write: zEffort.default('medium'), finale: zEffort.default('high') })
    .default({ open: 'medium', write: 'medium', finale: 'high' }),
});
export type V3BookConfig = z.infer<typeof zV3BookConfig>;

export const zBookConfig = z.object({
  schema: z.literal('nv.book/1').default('nv.book/1'),
  format_version: z.number().int().default(BOOK_FORMAT_VERSION),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1),
  /** 题材包 id；必须存在（v1 教训：无题材不立项） */
  genre: z.string().min(1),
  language: z.string().default('zh-CN'),
  blurb: z.string().optional(),
  /** D6：规模全部可配置 */
  scale: z
    .object({
      target_cjk: z.number().int().positive().default(3_000_000),
      hard_max_cjk: z.number().int().positive().default(3_500_000),
      volumes: z.tuple([z.number().int(), z.number().int()]).default([10, 12]),
      chapters_per_volume: z.tuple([z.number().int(), z.number().int()]).default([80, 110]),
      /** 缺省取题材包 pacing.chapter_length */
      chapter_length: zLengthSpec.optional(),
    })
    .default({ target_cjk: 3_000_000, hard_max_cjk: 3_500_000, volumes: [10, 12], chapters_per_volume: [80, 110] }),
  /** D2 修订：默认 standard */
  tier: zQualityTier.default('standard'),
  tiers: z.object({ key_chapters: zQualityTier.default('lite') }).default({ key_chapters: 'lite' }),
  /** opt-in 机制开关 */
  optin: z
    .object({
      bakeoff: z.boolean().default(false),
      cross_extract: z.boolean().default(false),
      heldout: z.boolean().default(false),
      plan_judge: z.boolean().default(false),
      formatcheck: z.boolean().default(false),
      model_window_audit: z.boolean().default(false),
      fresh_reader: z.boolean().default(false),
      pairwise_regression: z.boolean().default(false),
      deslop: z.boolean().default(false),
    })
    .default({
      bakeoff: false,
      cross_extract: false,
      heldout: false,
      plan_judge: false,
      formatcheck: false,
      model_window_audit: false,
      fresh_reader: false,
      pairwise_regression: false,
      deslop: false,
    }),
  policy: z
    .object({
      on_exhausted: zExhaustPolicy.default({
        soft_only: { normal: 'accept_with_debt', key: 'accept_with_debt' },
        craft_hard: { normal: 'accept_with_debt', key: 'hold' },
        canon_hard: 'block',
      }),
      unplanned_invention: z.enum(['soft', 'strict']).default('soft'),
      forward_debt_cap: z.number().int().default(20),
      refusal_retry_other_vendor: z.boolean().default(true),
      contract_amend_approver: z.enum(['owner', 'showrunner', 'owner_major']).default('owner_major'),
      model_change: z.enum(['continue_and_check', 'pause']).default('continue_and_check'),
    })
    .default({
      on_exhausted: {
        soft_only: { normal: 'accept_with_debt', key: 'accept_with_debt' },
        craft_hard: { normal: 'accept_with_debt', key: 'hold' },
        canon_hard: 'block',
      },
      unplanned_invention: 'soft',
      forward_debt_cap: 20,
      refusal_retry_other_vendor: true,
      contract_amend_approver: 'owner_major',
      model_change: 'continue_and_check',
    }),
  gates: z.object({ overrides: z.record(z.string(), zGateOverride).default({}) }).default({ overrides: {} }),
  /** 路由：preset 覆盖系统当前 preset；roles 逐角色覆盖 */
  routing: z
    .object({
      preset: z.string().optional(),
      roles: z.partialRecord(zRoleId, zRoleRoute).default({}),
      /** 主笔 profile（粘性）；未设时取路由 writer 链第一个 */
      writer_profile: z.string().optional(),
    })
    .default({ roles: {} }),
  publish: zPublishConfig.default(zPublishConfig.parse({})),
  budgets: z
    .object({
      priority: z.number().int().default(0),
      max_window_util_pct: z.number().min(0).max(100).optional(),
      monthly_usd_cap: z.number().nonnegative().optional(),
      rerun_confirm_runs: z.number().int().default(20),
      rerun_confirm_window_pct: z.number().default(5),
      chapters_per_day_cap: z.number().int().optional(),
    })
    .default({ priority: 0, rerun_confirm_runs: 20, rerun_confirm_window_pct: 5 }),
  /** 书级厂商白名单（null = 不限制） */
  vendors_allow: z.array(z.string()).nullable().default(null),
  approvals: z
    .object({
      compass: zApprovalGate.default({ required: true, on_timeout: 'wait' }),
      first_volume: zApprovalGate.default({ required: true, on_timeout: 'wait' }),
      failover: zApprovalGate.default({ required: true, on_timeout: 'wait' }),
    })
    .default({
      compass: { required: true, on_timeout: 'wait' },
      first_volume: { required: true, on_timeout: 'wait' },
      failover: { required: true, on_timeout: 'wait' },
    }),
  mcp: z.enum(['auto', 'on', 'off']).default('off'),
  /** persona 模式：append（默认）| replace（需 canary） */
  persona_mode: z.enum(['append', 'replace']).default('append'),
  /** 流程：v2（缺省，旧流水线）| v3（一次运行写一批，docs/v3/DESIGN.md） */
  flow: z.enum(FLOWS).default('v2'),
  /** v3 专属配置；flow ≠ v3 时不读 */
  v3: zV3BookConfig.default(zV3BookConfig.parse({})),
});
export type BookConfig = z.infer<typeof zBookConfig>;

/** v3 publish defaults written into book.yaml by createBook (DESIGN §3.4 / §12.6) */
export const V3_PUBLISH_DEFAULTS = {
  mode: 'scheduled',
  cadence: '0 8 * * *',
  timezone: 'Asia/Shanghai',
  per_slot: 2,
  lag: 0,
  min_lag: 0,
  require_audited: false,
  max_buffer: 15,
  resume_buffer: 10,
} as const satisfies Partial<PublishConfig>;
export type BookConfigInput = z.input<typeof zBookConfig>;
