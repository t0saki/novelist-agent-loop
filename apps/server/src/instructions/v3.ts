/**
 * v3 根 AGENTS.md（docs/v3/DESIGN.md；p1-plan §2.5、§5.5）。
 * 与 v2 的 system channel 不同：没有 nonce、没有回执，整份指令写进书快照根目录的 AGENTS.md（cc 经 CLAUDE.md 的 @AGENTS.md 读取）。
 * 层次复用 resolveStack（v3 输入）：内置约定 → 篇幅要领 → 全局 → 题材（base→self）→ 本书；planner / 任务文件不进入。
 * 用户文本逐字保留，从不截断（超过 16 KB 只告警，见 V3_AGENTS_SOFT_LIMIT）。
 */
import { createHash } from 'node:crypto';
import type { V3Length } from '@novelist/shared';
import { resolveStack } from './layers.js';
import type { InstructionLayer } from './types.js';

export interface V3AgentsInput {
  globalDir: string;
  genreDirs: { id: string; dir: string; name: string }[];
  bookDir: string;
  length: V3Length;
  /** unsaved contents (absolute path → text) that take precedence over the disk (save-time size check) */
  drafts?: Record<string, string>;
}

/** 超过即告警 + inbox（不截断）；各 harness 的硬上限由 caps.maxInstructionBytes 判断 */
export const V3_AGENTS_SOFT_LIMIT = 16_384;
/** cc 读 CLAUDE.md；用 @ 引用把 AGENTS.md 拉进来 */
export const V3_CLAUDE_MD = '@AGENTS.md\n';

const LENGTH_LABEL: Record<V3Length, string> = { short: '短篇', medium: '中篇', long: '长篇', epic: '超长' };

const HEADER = [
  '<!-- 本文件由 Novelist 在每次运行前生成，不入库；要修改请到网页的"指令"页。 -->',
  '# 写作指令',
  '',
  '以下各节按顺序排列，后面的优先；互相冲突时，以最后的"本书"一节为准。',
].join('\n');

const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 节序号：1→一、10→十、12→十二、21→二十一 */
export function cnOrdinal(n: number): string {
  if (n < 10) return CN_DIGIT[n] ?? String(n);
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${tens === 1 ? '' : CN_DIGIT[tens]}十${ones === 0 ? '' : CN_DIGIT[ones]}`;
  }
  return String(n);
}

interface Section {
  title: string;
  layers: InstructionLayer[];
}

export async function renderAgentsMdV3(
  input: V3AgentsInput,
): Promise<{ text: string; bytes: number; stackHash: string; layers: { id: string; label: string; bytes: number }[] }> {
  const stack = await resolveStack({
    globalDir: input.globalDir,
    genreDirs: input.genreDirs.map((g) => ({ id: g.id, dir: g.dir })),
    bookDir: input.bookDir,
    role: 'writer',
    taskKind: null,
    ownerNotes: [],
    v3: { length: input.length },
    ...(input.drafts ? { drafts: input.drafts } : {}),
  });
  const nonEmpty = stack.layers.filter((l) => l.content.trim() !== '');
  const pick = (pred: (l: InstructionLayer) => boolean) => nonEmpty.filter(pred);
  const sections: Section[] = [
    { title: '书房约定（内置）', layers: pick((l) => l.id === 'S0') },
    { title: `篇幅要领：${LENGTH_LABEL[input.length]}`, layers: pick((l) => l.id === 'S1') },
    { title: '全局', layers: pick((l) => l.kind === 'L1') },
    ...input.genreDirs.map((g) => ({ title: `题材：${g.name || g.id}`, layers: pick((l) => l.id === `L2:${g.id}` || l.id === `L2:${g.id}.role`) })),
    { title: '本书', layers: pick((l) => l.kind === 'L3') },
  ].filter((s) => s.layers.length > 0);

  const parts: string[] = [HEADER];
  sections.forEach((s, i) => {
    const body = s.layers.map((l) => l.content.replace(/\s+$/, '')).join('\n\n');
    parts.push(`## ${cnOrdinal(i + 1)}、${s.title}\n\n${body}`);
  });
  const text = `${parts.join('\n\n')}\n`;
  const stackHash = createHash('sha256')
    .update(JSON.stringify(['v3', input.length, nonEmpty.map((l) => [l.id, l.mode, l.content])]))
    .digest('hex');
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    stackHash,
    layers: nonEmpty.map((l) => ({ id: l.id, label: l.label, bytes: Buffer.byteLength(l.content, 'utf8') })),
  };
}
