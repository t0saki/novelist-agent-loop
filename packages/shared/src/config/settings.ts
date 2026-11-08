/** 系统设置（settings 表，单行 key='system'）。全部可在 Web UI 修改。 */
import { z } from 'zod';
import { ISOLATION_BACKENDS, zQualityTier } from '../enums.js';

export const zSystemSettings = z.object({
  /** 当前生效的路由 preset（D2 修订默认：agy-argon） */
  activePreset: z.string().default('agy-argon'),
  defaultTier: zQualityTier.default('standard'),
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
});
export type SystemSettings = z.infer<typeof zSystemSettings>;
