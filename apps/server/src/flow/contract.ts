/**
 * v3 收稿约定：保护名单、冻结章节、笔记预算、全书完标记（docs/v3/DESIGN.md §3.2、§4；p1-plan §2.2）。纯函数。
 */

/** 作者改了也不收的文件（服务器生成或主人所有） */
export const V3_PROTECTED_EXACT = ['AGENTS.md', 'CLAUDE.md', 'ORDER.md', 'book.yaml', 'seed.md', 'notes/from-owner.md'];
export const V3_PROTECTED_PREFIX = ['instructions/', 'work/'];
/** Harness instruction files (any depth, any case): a model-written one would override or extend the server's AGENTS.md on every later run */
export const V3_INSTRUCTION_BASENAMES: ReadonlySet<string> = new Set(['agents.md', 'agents.override.md', 'claude.md', 'claude.local.md', 'gemini.md']);

export function isInstructionFile(rel: string): boolean {
  return V3_INSTRUCTION_BASENAMES.has((rel.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase());
}

/** Files that are never collected: the exact list, the prefixes, harness instruction files at any depth, and any path segment starting with "." (.git .claude .agents .codex .gemini .index .cache .gitignore …) */
export function isProtected(rel: string): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (V3_PROTECTED_EXACT.includes(p)) return true;
  if (V3_PROTECTED_PREFIX.some((pre) => p.startsWith(pre))) return true;
  if (isInstructionFile(p)) return true;
  return p.split('/').some((seg) => seg.startsWith('.'));
}

/** Chapters a run may never change: published (≤ publishedThrough) or owner-locked. Their edits ARE collected and mapped to drafts/ (DESIGN §3.2: "改动不生效，另存到 drafts/") */
export function isFrozenChapter(no: number, ctx: { publishedThrough: number; locked: readonly number[] }): boolean {
  return no <= ctx.publishedThrough || ctx.locked.includes(no);
}

/** 笔记体积预算（汉字/字符，约数）；超了在任务单里点名让作者自己压 */
export const NOTE_BUDGETS: Record<string, number> = { 'bible.md': 8000, 'outline.md': 8000, 'notes/cast.md': 6000, 'notes/threads.md': 4000, 'notes/progress.md': 1500 };

export const END_MARKER = '（全书完）';
/** 独占一行的全书完标记：（全书完）、全文完、（全书终）、——全书完——、【全书完结】…（最后一段末尾内嵌的见 checks.cleanChapterText） */
export const END_MARKER_RE = /^\s*(?:[—\-－~～]+\s*)?[（(【[]?\s*全[书文][完终]结?\s*[）)】\]]?\s*(?:[—\-－~～]+)?\s*$/u;

export const HARVEST_MAX_FILE_BYTES = 1_048_576;

/** 笔记体积（不计空白的字符数；预算、缩水检查共用） */
export function noteSize(text: string): number {
  return [...text.replace(/\s+/gu, '')].length;
}
