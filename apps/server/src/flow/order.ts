/**
 * v3 任务单 ORDER.md（docs/v3/DESIGN.md §3.1；p1-plan §2.4、§5）。
 * 模板在 flow/templates/order.<mode>.md（中文，内置）；引擎与 pipeline/workorder.ts 相同：{{var}} 单次替换，缺变量即抛错，
 * 插入的值不再展开。空的可选块渲染为 ''，最后把 3 个以上的连续换行压成 2 个。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { desc, eq, ne } from 'drizzle-orm';
import { V3_TITLE_PLACEHOLDER, chapterId } from '@novelist/shared';
import { books } from '../db/schema.js';
import type { BookHandle, PipelineContext, TaskResult, TaskRow } from '../pipeline/types.js';
import { NOTE_BUDGETS, isFrozenChapter, noteSize } from './contract.js';

export { noteSize };
import { effortFor, type FlowStep } from './decide.js';
import { readV3Meta } from './state.js';
import type { OrderMode, OrderSpec, V3Hint } from './types.js';

export const ORDER_TEMPLATES_DIR: string = new URL('./templates/', import.meta.url).pathname;

/** auto-start 的占位书名前缀（services/auto-start.ts）；书库摘要里两种占位书名都不列 */
const AUTO_TITLE_PLACEHOLDER = '待命名·';
const LIBRARY_MAX = 20;

const cache = new Map<string, string>();

async function readOrderTemplate(mode: OrderMode): Promise<string> {
  const hit = cache.get(mode);
  if (hit !== undefined) return hit;
  const text = await fs.readFile(path.join(ORDER_TEMPLATES_DIR, `order.${mode}.md`), 'utf8');
  cache.set(mode, text);
  return text;
}

/** {{var}} 单次替换；模板引用了未提供的变量时抛错。结果把 3+ 个换行压成 2 个 */
export function fillTemplate(tpl: string, vars: Record<string, string>, name = 'order'): string {
  const out = tpl.replace(/\{\{([a-z0-9_]+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`模板 ${name} 缺少变量 ${key}`);
    return v;
  });
  return out.replace(/\n{3,}/g, '\n\n');
}

const pad5 = (n: number) => String(n).padStart(5, '0');

function rewriteLine(allow: number[]): string {
  if (allow.length === 0) return '不改写旧章：已写好的章节不要动。';
  return `允许改写的旧章：${allow.map((k) => `第 ${k} 章`).join('、')}（见下面的系统提示）。除此之外，已写好的章节不要动。`;
}

/** '' when empty, else "## 上一次的系统提示（先处理这些）" + numbered list: hint texts first, then note-budget lines */
export function renderHints(hints: V3Hint[], budgets: string[]): string {
  const items = [...hints.map((h) => h.text), ...budgets].filter((t) => t.trim() !== '');
  if (items.length === 0) return '';
  return `## 上一次的系统提示（先处理这些）\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`;
}

/** ≤20 lines, '' when none. Placeholder titles (待命名· / 未命名·) and the book itself (opts.selfId) are left out */
export function renderLibrary(rows: { id?: string; title: string; blurb: string | null }[], opts: { selfId?: string } = {}): string {
  const keep = rows.filter((r) => r.title.trim() !== '' && !r.title.startsWith(AUTO_TITLE_PLACEHOLDER) && !r.title.startsWith(V3_TITLE_PLACEHOLDER) && (opts.selfId === undefined || r.id !== opts.selfId)).slice(0, LIBRARY_MAX);
  if (keep.length === 0) return '';
  return `书库摘要（不要和这些书雷同）：\n${keep.map((r) => `- 《${r.title}》${r.blurb ? `：${r.blurb}` : ''}`).join('\n')}\n`;
}

/** 超预算的笔记 → "X 太长了（约 n 字），顺手压到 b 字上下，不必精确计数。"（n 取整到百） */
export function noteBudgetLines(sizes: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [file, budget] of Object.entries(NOTE_BUDGETS)) {
    const n = sizes[file];
    if (n === undefined || n <= budget) continue;
    out.push(`${file} 太长了（约 ${Math.round(n / 100) * 100} 字），顺手压到 ${budget} 字上下，不必精确计数。`);
  }
  return out;
}

/**
 * 任务单只给出没冻结的提示（DESIGN §3.3“该章如果已发布就不再提”）：chapter 或 rewrite 指向已发布 / 主人锁定章节的提示一律丢掉；
 * allowRewrite = 剩下提示的 rewrite 字段。
 */
export function selectHints(hints: V3Hint[], frozen: { publishedThrough: number; locked: readonly number[] }): { hintsShown: V3Hint[]; allowRewrite: number[] } {
  const hintsShown = hints.filter((h) => !(h.chapter !== undefined && isFrozenChapter(h.chapter, frozen)) && !(h.rewrite !== undefined && isFrozenChapter(h.rewrite, frozen)));
  const allowRewrite = [...new Set(hintsShown.flatMap((h) => (h.rewrite !== undefined ? [h.rewrite] : [])))].sort((a, b) => a - b);
  return { hintsShown, allowRewrite };
}

export interface OrderExtra {
  /** renderLibrary 的结果（只有开书任务单用） */
  library: string;
  /** 必读清单（"- …" 行，换行分隔；不含主人的话那一行） */
  mustRead: string;
  /** noteBudgetLines 的结果，换行分隔 */
  budgets: string;
  /** notes/from-owner.md 在 HEAD 非空：必读清单末尾加一行 */
  ownerNote: boolean;
}

export async function renderOrder(spec: OrderSpec, extra: OrderExtra): Promise<string> {
  const budgets = extra.budgets.split('\n').filter((l) => l.trim() !== '');
  const hints = renderHints(spec.hintsShown, budgets);
  const mustRead = [...extra.mustRead.split('\n').filter((l) => l.trim() !== ''), ...(extra.ownerNote ? ['- 主人给你的话：notes/from-owner.md（只读）。'] : [])].join('\n');
  const common: Record<string, string> = {
    planned: String(spec.planned),
    planned_max: String(spec.plannedMax),
    target_cjk: String(spec.targetCjk),
    min_chars: String(spec.minChars),
    count: String(spec.count),
    from: String(spec.from),
    from5: pad5(spec.from),
    to: String(spec.from + spec.count - 1),
    accepted: String(spec.accepted),
    total_cjk: String(spec.totalCjk),
    hints,
  };
  let vars: Record<string, string>;
  if (spec.mode === 'open-short' || spec.mode === 'open-long') {
    const resume = spec.bibleExisted ? '设定已定（bible.md、outline.md 已在目录里），不要重新构思，直接从第 1 章写起；需要时可以补充大纲。' : '';
    vars = { ...common, resume, library: extra.library };
  } else {
    vars = { ...common, rewrite_line: rewriteLine(spec.allowRewrite), must_read: mustRead };
  }
  return fillTemplate(await readOrderTemplate(spec.mode), vars, `order.${spec.mode}`);
}

// ───────────────────────── buildOrderSpec（读 DB 与 HEAD） ─────────────────────────

function stepOf(mode: OrderMode, from: number, count: number): FlowStep {
  if (mode === 'open-short' || mode === 'open-long') return { kind: 'open', mode, count };
  return { kind: 'write', mode, from, count };
}

const MODES: readonly OrderMode[] = ['open-short', 'open-long', 'write', 'finale'];

/** Builds OrderSpec from DB/HEAD (books row, meta.v3, HEAD files bible.md/outline.md/notes sizes, publishedThrough, locked) */
export async function buildOrderSpec(ctx: PipelineContext, book: BookHandle, task: TaskRow): Promise<{ spec: OrderSpec; extra: OrderExtra } | { skip: TaskResult }> {
  const db = ctx.deps.db;
  const now = ctx.deps.now();
  const row = (await db.select().from(books).where(eq(books.id, book.id)).limit(1))[0];
  if (!row) return { skip: { status: 'failed', errorClass: 'config', message: `书不存在：${book.id}` } };
  const params = (task.params ?? {}) as Record<string, unknown>;
  const cfg = book.config.v3;
  const kind = task.kind as 'book.open' | 'book.write';

  // skip rules（p1-plan §2.13 prepareV3 1）
  if (row.status === 'completed' || row.status === 'archived') return { skip: { status: 'done', summary: { stale: 'completed' } } };
  if (kind === 'book.open' && row.acceptedThrough > 0) return { skip: { status: 'done', summary: { stale: 'opened' } } };
  if (kind === 'book.write' && params.from !== row.acceptedThrough + 1) return { skip: { status: 'done', summary: { stale: 'moved' } } };
  const maxBuffer = book.config.publish.max_buffer;
  if (row.acceptedThrough - row.publishedThrough >= maxBuffer || row.pausedReason === 'max_buffer') {
    return { skip: { status: 'waiting', retryAfter: new Date(now.getTime() + 30 * 60_000).toISOString(), summary: { stale: 'buffer_full' } } };
  }

  const meta = readV3Meta(row.meta);
  const n0 = cfg.planned_chapters_initial ?? cfg.planned_chapters ?? Math.max(1, Math.ceil(cfg.target_cjk / 4000));
  const planned = cfg.planned_chapters ?? n0;
  const fallbackMode: OrderMode = kind === 'book.open' ? (cfg.length === 'short' ? 'open-short' : 'open-long') : planned - row.acceptedThrough <= cfg.batch || cfg.length === 'short' ? 'finale' : 'write';
  const mode = MODES.includes(params.mode as OrderMode) ? (params.mode as OrderMode) : fallbackMode;
  const from = kind === 'book.open' ? 1 : row.acceptedThrough + 1;
  const count = typeof params.count === 'number' && params.count > 0 ? params.count : mode === 'open-short' ? planned : mode === 'finale' ? Math.max(planned - row.acceptedThrough, 1) : cfg.batch;
  const frozen = { publishedThrough: row.publishedThrough, locked: meta.locked };
  const { hintsShown, allowRewrite } = selectHints(meta.hints, frozen);

  // HEAD 上的文件
  const head = book.headCommit;
  const listed = ['notes/progress.md', 'outline.md', 'bible.md', 'notes/cast.md', 'notes/threads.md'];
  const prev = from > 1 ? `manuscript/${chapterId(from - 1)}.md` : null;
  const probe = [...new Set([...listed, 'notes/chapters.md', 'notes/from-owner.md', ...Object.keys(NOTE_BUDGETS), ...(prev ? [prev] : [])])];
  const shas = await book.repo.blobShas(probe, head);
  const has = (p: string) => (shas[p] ?? '') !== '';
  const budgetFiles = Object.keys(NOTE_BUDGETS).filter(has);
  const texts = await readMany(book, [...budgetFiles, ...(has('notes/from-owner.md') ? ['notes/from-owner.md'] : [])], head);
  const sizes: Record<string, number> = {};
  for (const f of budgetFiles) sizes[f] = noteSize(texts.get(f) ?? '');
  const ownerNote = (texts.get('notes/from-owner.md') ?? '').trim() !== '';

  const mustLines: string[] = [];
  const present = listed.filter(has);
  if (present.length) mustLines.push(`- ${present.join('、')}；`);
  if (has('notes/chapters.md')) mustLines.push('- notes/chapters.md 的最后 30 行；');
  if (prev && has(prev)) mustLines.push(`- 上一章全文：${prev}。`);

  let library = '';
  if (mode === 'open-short' || mode === 'open-long') {
    const rows = await db
      .select({ id: books.id, title: books.title, meta: books.meta })
      .from(books)
      .where(ne(books.id, book.id))
      .orderBy(desc(books.updatedAt))
      .limit(LIBRARY_MAX * 3);
    library = renderLibrary(
      rows.map((r) => ({ id: r.id, title: r.title, blurb: typeof (r.meta as { blurb?: unknown }).blurb === 'string' ? ((r.meta as { blurb: string }).blurb || null) : null })),
      { selfId: book.id },
    );
  }

  const spec: OrderSpec = {
    v: 1,
    mode,
    kind,
    from,
    count,
    finale: mode === 'finale' || mode === 'open-short',
    minChars: cfg.min_chapter_cjk,
    targetCjk: cfg.target_cjk,
    planned,
    plannedMax: 2 * n0,
    batch: cfg.batch,
    accepted: row.acceptedThrough,
    totalCjk: row.totalCjk,
    publishedThrough: row.publishedThrough,
    locked: meta.locked,
    allowRewrite,
    bibleExisted: has('bible.md'),
    hintsShown,
    effort: effortFor(stepOf(mode, from, count), cfg),
  };
  return { spec, extra: { library, mustRead: mustLines.join('\n'), budgets: noteBudgetLines(sizes).join('\n'), ownerNote } };
}

async function readMany(book: BookHandle, rels: string[], rev: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rels.length === 0) return out;
  const texts = book.repo.readMany ? await book.repo.readMany(rels, rev) : await Promise.all(rels.map((r) => book.repo.readFile(r, rev)));
  rels.forEach((r, i) => {
    const t = texts[i];
    if (t !== null && t !== undefined) out.set(r, t);
  });
  return out;
}
