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
  /** 自动开书（v1 的 auto_generate）：默认关闭 */
  autoStart: z
    .object({
      enabled: z.boolean().default(false),
      /** 同时在写的书达到这个数就不再开新书 */
      maxActiveBooks: z.number().int().positive().default(1),
      /** 24 小时内最多自动开几本，0 表示不限 */
      maxPerDay: z.number().int().min(0).default(2),
      /** 参与的题材包；null 表示 pack.yaml 里 auto.enabled 为 true 的包 */
      genres: z.array(z.string()).nullable().default(null),
      /** 各篇幅档的规模；题材包的 auto.length_hint 决定用哪一档 */
      lengths: z.object({ short: zAutoLength, medium: zAutoLength, long: zAutoLength, epic: zAutoLength }).default(AUTO_LENGTH_DEFAULTS),
    })
    .default({ enabled: false, maxActiveBooks: 1, maxPerDay: 2, genres: null, lengths: AUTO_LENGTH_DEFAULTS }),
});
export type SystemSettings = z.infer<typeof zSystemSettings>;
