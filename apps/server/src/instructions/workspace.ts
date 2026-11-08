/** 生成书仓库根 AGENTS.md 与 .agents/skills（DESIGN §4.1、§5.2、§5.7）。Owner: lane C。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, stringify as yamlStringify } from 'yaml';
import { BUILTIN_INSTRUCTIONS_DIR } from './layers.js';

export interface WorkspaceDocInput {
  bookTitle: string;
  /** 内置 contract.md 渲染后的 L0 契约摘要 */
  contract: string;
  skills: { name: string; description: string }[];
}

const FIRST_LINE = '本文件由 Novelist 生成；你的书层指令在 instructions/AGENTS.md';

const BOOK_MAP = `| 路径 | 内容 |
|---|---|
| book.yaml | 本书配置 |
| bible/ | 设定：premise.md、glossary.yaml、world/、entities/（人物/地点/势力/物品/概念）、secrets/ |
| plan/ | compass.yaml、volumes/、arcs/、cards/、character-arcs/、strands.yaml、obligations.yaml |
| state/ledger/ | 每章的状态增量（canonical） |
| manuscript/ | 已验收正文 |
| summaries/ | 弧、卷、全书摘要 |
| style/ | voice.md、samples/、lexicon.yaml |
| instructions/ | 作者文件（归作者所有） |
| views/ | 派生视图（可能过期，以 work order 给出的 context 为准） |
| work/ | 每个任务的临时目录（你的 out_dir 在这里） |`;

/** 首行可见：“本文件由 Novelist 生成；你的书层指令在 instructions/AGENTS.md”。不含 nonce、不重复作者层 */
export function renderWorkspaceDoc(input: WorkspaceDocInput): string {
  const parts = [
    FIRST_LINE,
    `# 《${input.bookTitle}》书库`,
    '作者指令在你的 system prompt 中，那里的内容优先于本文件。',
    '## 文件机制\n\n' + input.contract.trim(),
    `## 书库地图\n\n${BOOK_MAP}`,
  ];
  if (input.skills.length > 0) {
    parts.push(`## Skills（.agents/skills）\n\n${input.skills.map((s) => `- \`${s.name}\`：${s.description}`).join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}

/** agentskills 规范的 6 个 frontmatter 字段（§5.7） */
const SKILL_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function normalizeSkillMd(text: string): string {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return text;
  const doc = parseDocument(m[1]!);
  if (doc.errors.length > 0) return text;
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  const kept = Object.fromEntries(Object.entries(data).filter(([k]) => SKILL_FIELDS.includes(k)));
  return `---\n${yamlStringify(kept, { lineWidth: 0 })}---\n${text.slice(m[0].length)}`;
}

async function listSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(path.join(dir, e.name), rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** 合并 书 > 题材 > 全局 > 内置 的 skills，返回要写到 .agents/skills/<name>/SKILL.md 的文件（相对书根） */
export async function renderSkills(input: { bookDir: string; genreDirs: string[]; globalDir: string }): Promise<{ path: string; content: string }[]> {
  // 低优先级在前，同名 skill 整目录被高优先级覆盖
  const roots = [path.join(BUILTIN_INSTRUCTIONS_DIR, 'skills'), path.join(input.globalDir, 'skills'), ...input.genreDirs.map((d) => path.join(d, 'skills')), path.join(input.bookDir, 'instructions', 'skills')];
  const winner = new Map<string, string>();
  for (const root of roots) for (const name of await listSkillDirs(root)) winner.set(name, path.join(root, name));
  const out: { path: string; content: string }[] = [];
  for (const [name, dir] of [...winner].sort(([a], [b]) => a.localeCompare(b))) {
    for (const rel of await walkFiles(dir)) {
      const buf = await fs.readFile(path.join(dir, rel));
      const text = buf.toString('utf8');
      if (Buffer.compare(Buffer.from(text, 'utf8'), buf) !== 0) continue; // 只分发文本文件
      out.push({ path: `.agents/skills/${name}/${rel}`, content: rel === 'SKILL.md' ? normalizeSkillMd(text) : text });
    }
  }
  return out;
}

/** 从 renderSkills 的结果提取 workspace doc 的 skills 索引 */
export function skillIndex(files: { path: string; content: string }[]): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const f of files) {
    const m = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(f.path);
    if (!m) continue;
    const fm = FRONTMATTER_RE.exec(f.content);
    const data = fm ? ((parseDocument(fm[1]!).toJS() ?? {}) as Record<string, unknown>) : {};
    out.push({ name: m[1]!, description: typeof data.description === 'string' ? data.description : '' });
  }
  return out;
}

const normalize = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();

/** 根 AGENTS.md 是否被手改（与重新生成的内容比较） */
export function isWorkspaceDocModified(current: string, regenerated: string): boolean {
  return normalize(current) !== normalize(regenerated);
}
