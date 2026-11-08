/** 设定集 schema（DESIGN §4.2、附录 A）：实体 frontmatter / world rules / secrets / glossary */
import { z } from 'zod';
import { ENTITY_KINDS, zChapterId, zEntityId, zEntityRef, zFactRef } from '../ids.js';

export const zAlias = z.object({
  text: z.string().min(1),
  /** ambiguous 别名只在消歧条件满足时计为提及（§6.3） */
  ambiguous: z.boolean().default(false),
  scope: z.object({ pov: zEntityRef.optional() }).optional(),
});
export type Alias = z.infer<typeof zAlias>;

/** 实体 .md 的 YAML frontmatter；正文是自由 markdown */
export const zEntity = z.object({
  id: zEntityId,
  kind: z.enum(ENTITY_KINDS),
  name: z.string().min(1),
  aliases: z.array(z.union([z.string(), zAlias])).default([]),
  identities: z.array(z.object({ id: z.string(), alias: z.string(), known_by_fact: zFactRef.optional() })).default([]),
  tier: z.enum(['major', 'minor', 'extra']).default('minor'),
  born: z.object({ year: z.number().int(), calendar: z.string().optional() }).optional(),
  first_ch: zChapterId.optional(),
  contract_by_stage: z
    .record(
      z.string(),
      z.object({
        voice: z.string().optional(),
        never: z.array(z.string()).default([]),
        limits: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  /** tier=major 必须有 */
  arc: z.string().optional(),
  relations: z.array(z.object({ to: zEntityRef, type: z.string() })).default([]),
  /** 初始状态（fold 的起点），键同 entity.update.set */
  initial: z.record(z.string(), z.unknown()).default({}),
});
export type Entity = z.infer<typeof zEntity>;

export const zWorldRules = z.object({
  schema: z.literal('nv.world/1'),
  calendar: z
    .object({ name: z.string(), epoch: z.string().optional(), units: z.record(z.string(), z.number()).optional() })
    .optional(),
  systems: z
    .array(z.object({ id: z.string(), name: z.string(), ranks: z.array(z.string()).default([]), rules: z.array(z.string()).default([]) }))
    .default([]),
  vocab: z
    .object({
      /** 受控条件词表：id 形如 injury.arm.left.fracture，label 为中文显示名 */
      conditions: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
      proposals: z.array(z.object({ id: z.string(), label: z.string(), from: zChapterId.optional() })).default([]),
    })
    .default({ conditions: [], proposals: [] }),
  rules: z.array(z.string()).default([]),
});
export type WorldRules = z.infer<typeof zWorldRules>;

/** bible/secrets/<id>.md 的 frontmatter */
export const zSecret = z.object({
  schema: z.literal('nv.secret/1'),
  id: z.string(),
  fact: zFactRef.optional(),
  truth: z.string(),
  reveal_plan: z.array(z.object({ at: zChapterId.optional(), to: z.string(), how: z.string().optional() })).default([]),
  /** 确定性 grep 的正则（JS 语法）。命中即按 must_not 处理 */
  leak_signatures: z.array(z.string()).default([]),
});
export type Secret = z.infer<typeof zSecret>;

export const zGlossary = z.object({
  schema: z.literal('nv.glossary/1').optional(),
  terms: z.array(z.object({ term: z.string(), def: z.string().optional(), aliases: z.array(z.string()).default([]) })).default([]),
});
export type Glossary = z.infer<typeof zGlossary>;
