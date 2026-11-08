/**
 * Work order（DESIGN §3.5、§6.3）：每个 agent run 只领一张有界的工作单。
 * 文件格式 = YAML frontmatter（nv.workorder/1，本 schema）+ 中文 markdown 正文（任务说明 + 内联 context pack）。
 * frontmatter 对 agent 可见（让它知道要写哪些文件），也供 fake harness 与 contract gate 使用。
 */
import { z } from 'zod';
import { zRoleId, zTaskKind } from '../enums.js';

export const ARTIFACT_KINDS = [
  'chapter_draft', // manuscript 草稿（markdown，含 beat 标记）
  'check', // nv.check/1
  'delta', // nv.delta/1
  'review', // nv.review/1
  'audit', // nv.audit/1
  'patches', // nv.patches/1
  'pairwise', // nv.pairwise/1
  'summary', // markdown 摘要（带锚点）
  'plan_yaml', // 规划 yaml（compass/volume/arc/card/charc…）
  'bible_md', // 实体/秘密 .md（frontmatter + 正文）
  'markdown',
  'json',
  'yaml',
  'receipt', // nv.receipt/1（总是必需）
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const zArtifactDecl = z.object({
  /** 相对 out_dir 的路径；可含通配段（如 cards/c*.yaml）表示一组文件 */
  path: z.string().min(1),
  kind: z.enum(ARTIFACT_KINDS),
  /** 若给出，contract.schema gate 用 registry 中的该 schema 校验 */
  schema: z.string().optional(),
  required: z.boolean().default(true),
  /** 多文件声明：最少/最多个数 */
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().positive().optional(),
  /** chapter_draft 的长度区间（仅供 agent 参考；gate 以卡片为准） */
  length: z.object({ min: z.number().int(), target: z.number().int(), max: z.number().int(), count_mode: z.enum(['han', 'platform']) }).optional(),
  description: z.string().optional(),
});
export type ArtifactDecl = z.infer<typeof zArtifactDecl>;

export const zWorkOrderFrontmatter = z.object({
  schema: z.literal('nv.workorder/1'),
  task_id: z.string(),
  run_id: z.string(),
  kind: zTaskKind,
  role: zRoleId,
  book: z.string().nullable(),
  target: z.string(),
  /** 绝对路径：agent 只能写这里 */
  out_dir: z.string(),
  /** 只读输入文件（绝对路径）：草稿、原始输出等 */
  inputs: z.array(z.object({ path: z.string(), kind: z.string(), description: z.string().optional() })).default([]),
  artifacts: z.array(zArtifactDecl).min(1),
  budget: z
    .object({ max_full_chapter_reads: z.number().int().default(4), max_searches: z.number().int().default(8), max_turns: z.number().int().optional() })
    .default({ max_full_chapter_reads: 4, max_searches: 8 }),
  /** fake harness 场景（仅测试；真实 harness 忽略） */
  fake: z.record(z.string(), z.unknown()).optional(),
});
export type WorkOrderFrontmatter = z.infer<typeof zWorkOrderFrontmatter>;
