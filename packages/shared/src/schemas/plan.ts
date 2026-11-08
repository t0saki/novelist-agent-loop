/** 规划层级 schema（DESIGN §6.1、附录 A）：compass / volume / arc / card / charc / strands / oblig / change */
import { z } from 'zod';
import { COUNT_MODES } from '../enums.js';
import { zArcId, zChapterId, zEntityRef, zObligationRef, zVolumeId } from '../ids.js';
import { zOpPattern } from './delta.js';
import { zPredicate } from './predicate.js';

const range = <T extends z.ZodTypeAny>(t: T) => z.tuple([t, t]);

export const zLengthSpec = z.object({
  min: z.number().int().positive(),
  target: z.number().int().positive(),
  max: z.number().int().positive(),
  count_mode: z.enum(COUNT_MODES).default('han'),
});
export type LengthSpec = z.infer<typeof zLengthSpec>;

export const zScale = z.object({
  target_cjk: z.number().int().positive(),
  hard_max_cjk: z.number().int().positive(),
  volumes: range(z.number().int().positive()),
  chapters_per_volume: range(z.number().int().positive()),
});
export type Scale = z.infer<typeof zScale>;

export const zCompass = z.object({
  schema: z.literal('nv.compass/1'),
  logline: z.string().min(1),
  genre: z.string(),
  promises: z.array(z.string()).default([]),
  themes: z.array(z.string()).default([]),
  protagonist_arc: z.object({
    lie: z.string(),
    want: z.string(),
    need: z.string(),
    truth: z.string(),
    stages: z.array(z.string()).min(1),
  }),
  /** 单章长度不在这里（取自 pacing.yaml / book.yaml） */
  scale: zScale,
  phases: z.record(z.string(), range(zChapterId)).default({}),
  /** ending 块锁定：只能通过 amendment 修改 */
  ending: z.object({
    direction: z.string(),
    required_closures: z.array(zObligationRef).default([]),
    final_state: z.array(zPredicate).default([]),
  }),
  main_threads: z
    .array(
      z.object({
        id: z.string(),
        desc: z.string(),
        not_before_volume: zVolumeId.optional(),
        milestones: z.array(z.object({ id: z.string(), at: z.number().min(0).max(1), desc: z.string().optional() })).default([]),
      }),
    )
    .default([]),
  escalation_ladder: z
    .array(
      z.object({
        vol: zVolumeId,
        stakes: z.string(),
        power_range: range(z.string()).optional(),
        novelty: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  strand_policy: z
    .object({
      quest: z.number(),
      fire: z.number(),
      constellation: z.number(),
      max_quest_run: z.number().int(),
      max_gap_fire: z.number().int(),
      min_strands_per_ch: z.number().int(),
    })
    .partial()
    .default({}),
  invariants: z.array(z.string()).default([]),
  limits: z
    .object({
      open_major_per_volume: z.number().int().default(6),
      open_total: z.number().int().default(60),
      minor_max_age_ch: z.number().int().default(120),
    })
    .default({ open_major_per_volume: 6, open_total: 60, minor_max_age_ch: 120 }),
});
export type Compass = z.infer<typeof zCompass>;

export const zVolume = z.object({
  schema: z.literal('nv.volume/1'),
  id: zVolumeId,
  title: z.string(),
  /** skeleton = 只有骨架；detailed = 已细化（§6.2） */
  detail: z.enum(['skeleton', 'detailed']).default('skeleton'),
  goal: z.string().default(''),
  stakes: z.string().optional(),
  novelty: z.array(z.string()).default([]),
  power_range: range(z.string()).optional(),
  milestones_due: z.array(z.string()).default([]),
  chapters: range(zChapterId).optional(),
  arcs: z.array(z.object({ id: zArcId, title: z.string(), question: z.string().optional() })).default([]),
});
export type Volume = z.infer<typeof zVolume>;

export const zArc = z.object({
  schema: z.literal('nv.arc/1'),
  id: zArcId,
  volume: zVolumeId,
  title: z.string(),
  detail: z.enum(['outline', 'detailed']).default('outline'),
  question: z.string(),
  /** 弧收尾时必须有 arc.resolve op */
  resolve_by: zChapterId,
  chapters: range(zChapterId),
  goal: z.string().default(''),
  strands: z.array(z.string()).default([]),
  opens: z.array(zObligationRef).default([]),
  pays: z.array(zObligationRef).default([]),
  character_stages: z.array(z.object({ who: zEntityRef, to: z.string() })).default([]),
  beats: z.array(z.object({ ch: zChapterId.optional(), goal: z.string() })).default([]),
  climax: zChapterId.optional(),
});
export type Arc = z.infer<typeof zArc>;

export const BEAT_MODES = ['dramatize', 'interior', 'summary', 'transition', 'dialogue', 'action'] as const;
export const zBeat = z.object({
  id: z.string().regex(/^b\d+$/),
  mode: z.enum(BEAT_MODES).default('dramatize'),
  cjk: z.number().int().positive(),
  goal: z.string().min(1),
  pov: zEntityRef.optional(),
});
export type Beat = z.infer<typeof zBeat>;

/** 卡片条件：谓词，或 op 模式（例：{ op: knowledge.learn, who, fact }） */
export const zCardCondition = z.union([zPredicate, zOpPattern]);

export const zCard = z.object({
  schema: z.literal('nv.card/1'),
  id: zChapterId,
  title: z.string().min(1),
  volume: zVolumeId,
  arc: zArcId,
  base_ledger_hash: z.string().optional(),
  length: zLengthSpec.optional(),
  pov: zEntityRef.optional(),
  entities_present: z.array(zEntityRef).default([]),
  pre: z.array(zCardCondition).default([]),
  post: z.array(zCardCondition).default([]),
  must_not: z.array(zCardCondition).default([]),
  /** 本章允许新开的伏笔（may_open 规则） */
  may_open: z.array(z.string()).default([]),
  pays: z.array(zObligationRef).default([]),
  advances: z.array(zObligationRef).default([]),
  offscreen: z.array(z.object({ ent: zEntityRef, set: z.record(z.string(), z.unknown()) })).default([]),
  beats: z.array(zBeat).min(1),
  callbacks: z
    .array(z.union([z.object({ query: z.string() }), z.object({ quote: z.string(), from: zChapterId })]))
    .default([]),
  strands: z.array(z.string()).default([]),
  /** owner 本章笔记 → system channel L3.9（不进 context pack） */
  notes: z.string().optional(),
  key: z.boolean().default(false),
  is_final: z.boolean().default(false),
  /** 卡片级质量档覆盖 */
  tier: z.enum(['lite', 'lean', 'standard', 'key']).optional(),
  stale: z.boolean().default(false),
});
export type Card = z.infer<typeof zCard>;

export const zCharacterArc = z.object({
  schema: z.literal('nv.charc/1'),
  who: zEntityRef,
  lie: z.string().optional(),
  want: z.string().optional(),
  need: z.string().optional(),
  truth: z.string().optional(),
  stages: z.array(z.object({ id: z.string(), desc: z.string(), by: zChapterId.optional() })).min(1),
});
export type CharacterArc = z.infer<typeof zCharacterArc>;

export const zStrands = z.object({
  schema: z.literal('nv.strands/1'),
  strands: z.array(z.object({ id: z.string(), kind: z.enum(['quest', 'fire', 'constellation']), desc: z.string() })),
});
export type Strands = z.infer<typeof zStrands>;

/** 规划层伏笔计划（与账本里的 obligation 状态互补：这里放 payoff_plan / due 的计划） */
export const zObligationPlan = z.object({
  schema: z.literal('nv.oblig/1'),
  items: z.array(
    z.object({
      id: zObligationRef,
      weight: z.enum(['main', 'major', 'minor']),
      text: z.string(),
      payoff_plan: z.string().optional(),
      due: z.tuple([zChapterId, zChapterId]).optional(),
      revalidated_at: z.string().optional(),
    }),
  ),
});
export type ObligationPlan = z.infer<typeof zObligationPlan>;

export const zPlanChange = z.object({
  schema: z.literal('nv.change/1'),
  ts: z.string(),
  task: z.string().optional(),
  kind: z.enum(['create', 'update', 'repair', 'revalidate', 'amend', 'owner_edit']),
  paths: z.array(z.string()),
  summary: z.string(),
});
export type PlanChange = z.infer<typeof zPlanChange>;
