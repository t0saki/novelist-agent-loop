/** 题材包文件（附录 A）：pack.yaml（gates.yaml / pacing.yaml / lexicon.yaml 只有旧流程读过，已不再解析） */
import { z } from 'zod';

export const zGenrePack = z.object({
  schema: z.literal('nv.pack/1'),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  description: z.string().default(''),
  extends: z.array(z.string()).default([]),
  version: z.string().default('1'),
  builtin: z.boolean().default(false),
  /** 停用：不再出现在开书页和自动开书里；已有的书照常解析这个包 */
  hidden: z.boolean().default(false),
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

/** 题材包目录约定：$DATA/genres/<id>/{pack.yaml,AGENTS.md,roles/<role>.md,skills/}（旧包里的其他文件原样留着，不再读取） */
export const GENRE_FILES = {
  pack: 'pack.yaml',
  agents: 'AGENTS.md',
  rolesDir: 'roles',
  skillsDir: 'skills',
} as const;
