/**
 * 指令分层契约（DESIGN §5）。Owner: lane C。
 * 不变量：编译器从不改写/过滤/摘要/重排用户文本；最后一个作者块永远来自书层（L3）或 owner 本章笔记（L3.9）；
 * nonce 每个 run 随机生成，只出现在 $RUN/in/system.md。
 */
import type { Capabilities, HarnessId, InstructionLayerReport, RoleId, TaskKind, V3Length } from '@novelist/shared';
import type { RunSpec } from '../harness/types.js';

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

export interface NoncePair {
  head: string;
  tail: string;
}
/** layerId → nonce 对（S0 只有 head） */
export type NonceSet = Record<string, NoncePair>;

export interface CompiledInstructions {
  /** $RUN/in/system.md 的完整内容（含 nonce） */
  systemMd: string;
  /** 无 nonce 镜像（views/instructions/<role>.md，仅供审计与 Studio） */
  mirrorMd: string;
  layers: InstructionLayerReport[];
  nonces: NonceSet;
  /** 不含 nonce 的内容 hash（进入 task id 与 commit trailer Novelist-Instructions） */
  stackHash: string;
  bytes: number;
  lastAuthorLayerId: string;
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

export interface BudgetResult {
  ok: boolean;
  bytes: number;
  limit: number | null;
  /** 不可承载原因（UI：“压缩该层或换 harness”） */
  reason?: string;
}

export interface MaterializeInput {
  harness: HarnessId;
  spec: RunSpec;
  compiled: CompiledInstructions;
  caps: Capabilities;
  personaMode: 'append' | 'replace';
  /** home 配置目录（grok hooks 等写到 home；agy agent 文件写到 $RUN/book，dsh patch 写到 $RUN/in） */
  home: string;
  /** 根 AGENTS.md 的内容；省略时从 spec.bookDir 读取（预览时传入） */
  workspaceDoc?: string;
}

export interface MaterializeResult {
  /** 需要写出的文件（绝对路径；$RUN/in/* 或 home 配置部分） */
  files: { path: string; content: string; mode?: number }[];
  /** 追加到 harness argv 的片段（如 ['--append-system-prompt-file', '$RUN/in/system.md']） */
  argv: string[];
  env: Record<string, string>;
  budget: BudgetResult;
  notes: string[];
}

export interface NonceCheckReport {
  layers: { layer: string; head: boolean; tail: boolean }[];
  /** agent 读过 $RUN/in/*（回显不计入证明） */
  tainted: boolean;
  missingTail: string[];
  /** writer/checker/reviewer/judge 缺任一作者层 TAIL → false（§5.6 生产规则） */
  ok: boolean;
}
