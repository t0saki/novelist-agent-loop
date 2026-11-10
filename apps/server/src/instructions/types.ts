/**
 * 指令分层契约（DESIGN §5；v3：docs/v3/DESIGN.md §3.1）。
 * 不变量：从不改写/过滤/摘要/重排用户文本。v3 把各层拼成书快照根的 AGENTS.md（instructions/v3.ts）。
 */
import type { RoleId, TaskKind, V3Length } from '@novelist/shared';

/** 层 id：S0 契约、S1 内置角色、L1 全局、L2 题材（每个 extends 链成员一层）、L3 书、L3.9 owner 笔记 */
export type LayerKind = 'S0' | 'S1' | 'L1' | 'L2' | 'L3' | 'L3.9';

export interface InstructionLayer {
  /** 唯一 id：'S0' | 'S1' | 'L1' | 'L1.role' | 'L2:xianxia' | 'L2:xianxia.role' | 'L3' | 'L3.role' | 'L3.9' */
  id: string;
  kind: LayerKind;
  label: string;
  owner: 'novelist' | 'user';
  /** 来源文件（绝对路径；L3.9 为 'card:c00421' / 'inbox:<id>'） */
  source: string;
  /** include 已展开的原文 */
  content: string;
  /** 角色文件以 @extends 开头 = 追加；否则替换同一来源层内更低层的同名角色 */
  mode: 'replace' | 'extends';
  /** nonce 标签：C | S1 | G | R | B | N（§5.2） */
  nonceTag: string;
}

export interface InstructionStack {
  role: RoleId;
  taskKind: TaskKind | null;
  genreChain: string[];
  /** 已按 §5.1 排序：S0, S1, L1…, L2…, L3…, L3.9 */
  layers: InstructionLayer[];
  /** 被同一来源层内后继角色文件替换、未进入 layers 的层（指令预览展示） */
  replaced?: { id: string; label: string; source: string }[];
}

export interface ResolveStackInput {
  /** $DATA/instructions/global */
  globalDir: string;
  /** 已解析的题材链目录（base 在前，自身在后） */
  genreDirs: { id: string; dir: string }[];
  /** 书仓库（或 run 快照）根目录；无书任务为 null */
  bookDir: string | null;
  role: RoleId;
  taskKind: TaskKind | null;
  /** L3.9：owner 本章笔记、Inbox 附笔记重写、owner must-fix（原样） */
  ownerNotes: { source: string; text: string }[];
  /** 预览用：path → 未保存内容 */
  drafts?: Record<string, string>;
  /**
   * v3（docs/v3/DESIGN.md）：S0 = builtin/v3/contract.md，S1 = builtin/v3/length-<len>.md（非角色层），
   * role 固定为 writer，跳过 L1.task / L3.task，忽略 ownerNotes
   */
  v3?: { length: V3Length };
}
