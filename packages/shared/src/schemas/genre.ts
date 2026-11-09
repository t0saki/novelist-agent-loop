/** 题材包文件（附录 A）：pack.yaml / gates.yaml / pacing.yaml / lexicon.yaml */
import { z } from 'zod';
import { zLengthSpec } from './plan.js';

/** 工艺 gate 规则 id（§6.5）。I/O 契约 gate 不在这里，不可关闭 */
export const CRAFT_RULE_IDS = [
  'length.total',
  'length.beat',
  'beat.markers',
  'end.markers',
  'placeholder',
  'meta.text',
  'repeat.intra',
  'repeat.cross',
  'lexicon',
  'dramatize',
  'single_sentence_paragraph',
  'dialogue_ratio',
  'opening_cliche',
] as const;
export type CraftRuleId = (typeof CRAFT_RULE_IDS)[number];
export const CONTRACT_RULE_IDS = [
  'contract.path',
  'contract.artifacts_exact',
  'contract.utf8',
  'contract.nonempty',
  'contract.schema',
  'contract.truncation',
  'contract.receipt',
  'contract.nonce',
] as const;
export type ContractRuleId = (typeof CONTRACT_RULE_IDS)[number];

export const zGateLevel = z.enum(['hard', 'soft', 'off']);
export const zGateRule = z.object({
  level: zGateLevel,
  /** 规则特定参数（阈值、正则等），由 validators 解释 */
  params: z.record(z.string(), z.unknown()).default({}),
  /** 允许清单：匹配的文本不计违规（书层 allow 压过一切 ban） */
  allow: z.array(z.string()).default([]),
});
export type GateRule = z.infer<typeof zGateRule>;
/** 覆盖项：任何字段都可省略；disable=true 等价 level=off */
export const zGateOverride = z.object({
  disable: z.boolean().optional(),
  level: zGateLevel.optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  allow: z.array(z.string()).optional(),
});
export type GateOverride = z.infer<typeof zGateOverride>;

export const zGatesFile = z.object({
  schema: z.literal('nv.gates/1'),
  rules: z.record(z.string(), z.union([zGateRule, zGateOverride])).default({}),
});
export type GatesFile = z.infer<typeof zGatesFile>;

export const zLexiconEntry = z.union([
  z.string(),
  z.object({ pattern: z.string(), regex: z.boolean().default(false), weight: z.number().default(1), note: z.string().optional() }),
]);
export const zLexicon = z.object({
  schema: z.literal('nv.lexicon/1'),
  ban: z.array(zLexiconEntry).default([]),
  watch: z.array(zLexiconEntry).default([]),
  allow: z.array(zLexiconEntry).default([]),
  /** 套路模式（开头/结尾），带权重 */
  patterns: z.array(z.object({ id: z.string(), regex: z.string(), weight: z.number().default(1), where: z.enum(['open', 'close', 'any']).default('any') })).default([]),
});
export type Lexicon = z.infer<typeof zLexicon>;

export const zPacing = z.object({
  schema: z.literal('nv.pacing/1'),
  chapter_length: zLengthSpec,
  beats_per_chapter: z.tuple([z.number().int(), z.number().int()]).default([4, 7]),
  arc_length: z.tuple([z.number().int(), z.number().int()]).default([10, 25]),
  card_buffer: z.object({ min: z.number().int().default(6), target: z.number().int().default(12) }).default({ min: 6, target: 12 }),
  /** 平台口径换算系数（han → platform），仅 UI 显示 */
  platform_ratio: z.number().default(1.13),
});
export type Pacing = z.infer<typeof zPacing>;

export const zGenrePack = z.object({
  schema: z.literal('nv.pack/1'),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  description: z.string().default(''),
  extends: z.array(z.string()).default([]),
  version: z.string().default('1'),
  builtin: z.boolean().default(false),
  /** 事件词族：召回探针用（§6.6），如 death: [死, 陨落, 断气] */
  event_families: z.record(z.string(), z.array(z.string())).default({}),
  catalogs: z.record(z.string(), z.array(z.string())).default({}),
  rubric: z.record(z.string(), z.number()).default({}),
  /** 自动开书配置（v1 的 theme 字段转换而来，也可手写）；缺省表示这个包不参与自动开书 */
  auto: z
    .object({
      enabled: z.boolean().default(false),
      /** 加权轮转的权重，越大开书越多 */
      weight: z.number().min(0).default(1),
      keywords: z.array(z.string()).default([]),
      length_hint: z.string().default(''),
      min_chapters: z.number().int().positive().nullable().default(null),
      /** 要求自动开书的种子声明所有角色都是成年人 */
      adult_only: z.boolean().default(false),
    })
    .optional(),
  /** v1 主题导入时原样保留的元数据（含内容分级等，Novelist 不解释） */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type GenrePack = z.infer<typeof zGenrePack>;

/** 题材包目录约定：$DATA/genres/<id>/{pack.yaml,gates.yaml,pacing.yaml,lexicon.yaml,AGENTS.md,roles/<role>.md,skills/} */
export const GENRE_FILES = {
  pack: 'pack.yaml',
  gates: 'gates.yaml',
  pacing: 'pacing.yaml',
  lexicon: 'lexicon.yaml',
  agents: 'AGENTS.md',
  rolesDir: 'roles',
  skillsDir: 'skills',
} as const;
