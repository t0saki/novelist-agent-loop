// copied verbatim from db19762 (packages/shared/src/config/settings.ts); do not edit — the previous image's schema, used by test/compat.prev-image.test.ts
/** 系统设置（settings 表，单行 key='system'）。全部可在 Web UI 修改。 */
import { z } from 'zod';
import { ISOLATION_BACKENDS, zQualityTier } from '../enums.js';

export const AUTO_LENGTHS = ['short', 'medium', 'long', 'epic'] as const;
export type AutoLength = (typeof AUTO_LENGTHS)[number];
const zAutoLength = z.object({ targetCjk: z.number().int().positive(), chaptersMin: z.number().int().positive(), chaptersMax: z.number().int().positive() });
/** 默认值取自 v1 已写完作品的字数分布（p25≈1.5 万、中位≈5.5 万、p90≈19 万、最长≈49 万） */
export const AUTO_LENGTH_DEFAULTS = {
  short: { targetCjk: 15_000, chaptersMin: 4, chaptersMax: 8 },
  medium: { targetCjk: 60_000, chaptersMin: 12, chaptersMax: 30 },
  long: { targetCjk: 200_000, chaptersMin: 30, chaptersMax: 70 },
  epic: { targetCjk: 500_000, chaptersMin: 30, chaptersMax: 80 },
};

/** 自动开书的篇幅目标分布（按本数的百分比，和为 100；PUT 设置时检查） */
export const AUTO_LENGTH_MIX_DEFAULT = { short: 40, medium: 35, long: 20, epic: 5 };
const zLengthMix = z.object({ short: z.number().min(0).max(100), medium: z.number().min(0).max(100), long: z.number().min(0).max(100), epic: z.number().min(0).max(100) });
export type LengthMix = z.infer<typeof zLengthMix>;

export const zSystemSettings = z.object({
  /** 当前生效的路由 preset（D2 修订默认：agy-argon） */
  activePreset: z.string().default('agy-argon'),
  defaultTier: zQualityTier.default('lite'),
  defaultGenre: z.string().optional(),
  isolation: z.enum([...ISOLATION_BACKENDS, 'auto']).default('auto'),
  /** 全局配额余量（账号可覆盖） */
  reservePct: z.number().min(0).max(100).default(30),
  maxConcurrentRuns: z.number().int().positive().default(4),
  schedulerEnabled: z.boolean().default(true),
  retention: z
    .object({ runEventsDays: z.number().int().default(30), rawStreamDays: z.number().int().default(30), keepAcceptedRawDays: z.number().int().default(365), thinkingDays: z.number().int().default(90) })
    .default({ runEventsDays: 30, rawStreamDays: 30, keepAcceptedRawDays: 365, thinkingDays: 90 }),
  notifications: z
    .object({
      ntfyUrl: z.string().optional(),
      webhookUrl: z.string().optional(),
      events: z.array(z.string()).default(['inbox_new', 'circuit_changed', 'quota_wait']),
    })
    .default({ events: ['inbox_new', 'circuit_changed', 'quota_wait'] }),
  readers: z.object({ defaultVisibility: z.enum(['all', 'none']).default('all') }).default({ defaultVisibility: 'all' }),
  tls: z.enum(['proxy', 'caddy', 'insecure_lan']).default('proxy'),
  idleTimeouts: z
    .object({ writerMs: z.number().int().default(20 * 60_000), otherMs: z.number().int().default(10 * 60_000), dshMs: z.number().int().default(15 * 60_000) })
    .default({ writerMs: 1_200_000, otherMs: 600_000, dshMs: 900_000 }),
  wallTimeoutMs: z.number().int().default(60 * 60_000),
  workOrderMaxCjk: z.number().int().default(65_000),
  /** v3 流程的全站设置 */
  v3: z
    .object({
      /** 失控兜底（基准 = 主人一侧的计划章数 max(planned_chapters_initial, plannedFloor)）：写作批开写时已写到基准的 0.75×factor 章，任务单要求三批内收尾；达到 factor× 后再写两批仍未完结，下一批强制收尾，之后按完结处理。0 = 关闭 */
      // 开着时至少 2：作者合法的计划最多到基准的两倍，低于 2 的倍数会把按计划写的书提前截断。库里旧存的 (0, 2) 读出来按 2（PUT 路由直接拒收）
      runawayFactor: z
        .number()
        .min(0)
        .max(10)
        .transform((v) => (v > 0 && v < 2 ? 2 : v))
        .default(2),
    })
    .default({ runawayFactor: 2 }),
  /** 自动开书（v1 的 auto_generate）：默认关闭 */
  autoStart: z
    .object({
      enabled: z.boolean().default(false),
      /** 旧键：保持原样、不再读取（phase 3 删除）。生产库里存的是首装时写入的 1 */
      maxActiveBooks: z.number().int().positive().default(1),
      /** 未完结的自有书（planning / active / paused，不含导入的书）达到这个数就不再开新书 */
      maxUnfinishedBooks: z.number().int().positive().default(3),
      /** 24 小时内最多自动开几本，0 表示不限 */
      maxPerDay: z.number().int().min(0).default(2),
      /** 参与的题材包；null 表示 pack.yaml 里 auto.enabled 为 true 的包 */
      genres: z.array(z.string()).nullable().default(null),
      /** 题材权重覆盖；缺省用 pack.yaml 的 auto.weight，再缺省 1；0 = 不参与 */
      genreWeights: z.record(z.string(), z.number().min(0)).default({}),
      /** 各篇幅档的目标字数 */
      lengths: z.object({ short: zAutoLength, medium: zAutoLength, long: zAutoLength, epic: zAutoLength }).default(AUTO_LENGTH_DEFAULTS),
      /** 篇幅目标分布（按本数的百分比，和为 100） */
      lengthMix: zLengthMix.default(AUTO_LENGTH_MIX_DEFAULT),
    })
    .default({ enabled: false, maxActiveBooks: 1, maxUnfinishedBooks: 3, maxPerDay: 2, genres: null, genreWeights: {}, lengths: AUTO_LENGTH_DEFAULTS, lengthMix: AUTO_LENGTH_MIX_DEFAULT }),
});
export type SystemSettings = z.infer<typeof zSystemSettings>;
