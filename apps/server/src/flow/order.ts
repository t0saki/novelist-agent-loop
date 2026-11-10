/**
 * v3 任务单 ORDER.md（docs/v3/DESIGN.md §3.1；p1-plan §2.4、§5）。
 * 模板在 flow/templates/order.<mode>.md（中文，内置）；引擎与 pipeline/workorder.ts 相同：{{var}} 单次替换，缺变量即抛错，
 * 插入的值不再展开。空的可选块渲染为 ''，最后把 3 个以上的连续换行压成 2 个。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, lte } from 'drizzle-orm';
import { V3_TITLE_PLACEHOLDER, chapterId } from '@novelist/shared';
import { books, chapters } from '../db/schema.js';
import { loadSystemSettings } from '../orchestrator/routing.js';
import type { BookHandle, PipelineContext, TaskResult, TaskRow } from '../runtime/types.js';
import { BUFFER_FULL_WAIT, ENDING_LIST_RE, NOTE_BUDGETS, isFrozenChapter, noteSize } from './contract.js';

export { noteSize };
import { effortFor, endingPhase, finaleBypassesBuffer, finaleCount, plannedUpper, runawayBaseOf, type FlowStep } from './decide.js';
import { shortRecent } from './feedback.js';
import { loadLibrary, renderLibraryV3 } from './library.js';
import { readV3Meta } from './state.js';
import type { OrderMode, OrderSpec, V3BookMeta, V3Hint, V3OwnerRequest } from './types.js';

export const ORDER_TEMPLATES_DIR: string = new URL('./templates/', import.meta.url).pathname;

/** auto-start 的占位书名前缀（services/auto-start.ts）；书库摘要里两种占位书名都不列 */
const AUTO_TITLE_PLACEHOLDER = '待命名·';
const LIBRARY_MAX = 20;

const cache = new Map<string, string>();

async function readOrderTemplate(mode: OrderMode | 'takeover'): Promise<string> {
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
  /** renderLibraryV3 的结果（只有开书任务单用） */
  library: string;
  /** 必读清单（"- …" 行，换行分隔） */
  mustRead: string;
  /** noteBudgetLines 的结果，换行分隔 */
  budgets: string;
  /** notes/from-owner.md 在 HEAD 非空：开书 / 写作 / 结局批的任务单加一行 owner_line（复盘从不加） */
  ownerNote: boolean;
}

/** §5.1：主人的话（只读） */
export const OWNER_LINE = '主人给你留了话：notes/from-owner.md（只读）。动笔前先读一遍，照着做。';

/**
 * 写作批 / 结局批的“结局”一节（p2-plan §5.6）：收尾阶段、失控提醒、强制收尾。都不适用时 ''。
 * 不给作者任何要自己核对的字数。
 */
export function renderEnding(spec: Pick<OrderSpec, 'from' | 'planned' | 'accepted' | 'phase' | 'forced' | 'runawayWarn' | 'runawayBase' | 'endingListExists'>): string {
  const lines: string[] = [];
  const remaining = Math.max(spec.planned - spec.accepted, 0);
  if (spec.phase === 'closing') {
    lines.push(
      spec.endingListExists
        ? `全书计划共 ${spec.planned} 章，还剩约 ${remaining} 章。照 outline.md 的"结局章节清单"往下写；清单要调整就直接改，未收线索的去处同步改在 notes/threads.md。`
        : `全书计划共 ${spec.planned} 章，还剩约 ${remaining} 章。动笔前先在 outline.md 里加一节"## 结局章节清单"：从第 ${spec.from} 章到全书结束，每章一行写要发生什么；再给 notes/threads.md 里每一条未收线索标上去处——在第几章回收，或者明确放弃。然后照清单写这一批。`,
    );
  }
  if (spec.runawayWarn) lines.push(`这本书已经写了 ${spec.accepted} 章，比当初计划的 ${spec.runawayBase ?? spec.planned} 章多出很多。按大纲在三批之内收尾，不再开新的支线。`);
  if (spec.forced) lines.push('这是最后一批：把剩下的情节在这一批里收束，写完全书，最后一章末尾单独一行写"（全书完）"。');
  if (lines.length === 0) return '';
  const heading = spec.forced ? '## 这是最后一批' : spec.phase === 'closing' ? '## 收尾阶段' : '## 提醒';
  return `${heading}\n${lines.join('\n')}\n`;
}

/** “上一批的统计”（p2-plan §5.6）：重复的说法（不带次数）、近期偏短。都没有时 '' */
export function renderFeedback(f: OrderSpec['feedback'] | undefined): string {
  if (!f) return '';
  const lines: string[] = [];
  if (f.phrases.length > 0) {
    const range = f.range ? `（第 ${f.range[0]}–${f.range[1]} 章）` : '';
    lines.push(`- 上一批${range}里重复较多的说法：${f.phrases.map((p) => `「${p}」`).join('')}。这一批换着写。`);
  }
  if (f.shortRecent) lines.push('- 近期的章节偏短，这一批每章写足。');
  if (lines.length === 0) return '';
  return `## 上一批的统计（服务器数的，仅供参考）\n${lines.join('\n')}\n`;
}

/** 结局批第 1 条：结局章节清单还没有 / 已经有 */
function endingListLine(exists: boolean | undefined): string {
  return exists
    ? '照 outline.md 的"结局章节清单"写；清单要调整就直接改，notes/threads.md 里每一条未收线索都要有去处。'
    : '动笔前先在 outline.md 里加一节"## 结局章节清单"（从这一章到全书结束，每章一行），给 notes/threads.md 里每一条未收线索安排去处：在哪一章回收，或者明确放弃。';
}

export async function renderOrder(spec: OrderSpec, extra: OrderExtra): Promise<string> {
  const budgets = extra.budgets.split('\n').filter((l) => l.trim() !== '');
  const hints = renderHints(spec.hintsShown, budgets);
  const mustRead = extra.mustRead
    .split('\n')
    .filter((l) => l.trim() !== '')
    .join('\n');
  if (spec.takeover && spec.mode !== 'retro') {
    // 接手的旧书的第一次写作 / 开书（P3 D16）：先读最后几章和旧资料、补出笔记，再续写。
    // 结局控制和写作批一样：结局批（含短篇）要写完全书并写（全书完），其余批不许写；收尾阶段、提醒、改写授权、上一批统计照常带上
    const to = spec.from + spec.count - 1;
    const finale = spec.finale;
    const fresh = spec.accepted === 0;
    const lastChapters = spec.takeover.lastChapters.map((k) => `manuscript/${chapterId(k)}.md`).join('、');
    const vars: Record<string, string> = {
      task_line: finale
        ? `接手这本书，然后从第 ${spec.from} 章写到全书结束（计划还剩约 ${spec.count} 章，章数不限）`
        : `接手这本书，然后新写第 ${spec.from}–${to} 章（共 ${spec.count} 章）`,
      rewrite_line: rewriteLine(spec.allowRewrite),
      owner_line: extra.ownerNote ? OWNER_LINE : '',
      read_line: fresh || !lastChapters
        ? '1. 这本书还没有写好的章节。先读下面这些旧资料（主人原来的设定和规划，有的很长，看到够用为止）。沿用其中的书名、设定和方向，不要另选方向：'
        : `1. 读最后三章：${lastChapters}。再读下面这些旧资料（有的很长，看到够用为止）：`,
      must_read: mustRead || '- （没有旧资料）',
      continue_line: fresh ? '3. 然后从第 1 章写起，正文从 manuscript/c00001.md 起，每个文件第一行写"# 第N章 章名"。' : `3. 然后接着第 ${spec.accepted} 章往下写，正文从 manuscript/c${pad5(spec.from)}.md 起，每个文件第一行写"# 第N章 章名"。`,
      end_rule: finale
        ? `4. ${endingListLine(spec.endingListExists)}按清单把故事写完，章数不够就加，不要仓促收尾；最后一章写完后，在末尾单独一行写"（全书完）"。`
        : '4. 故事还没到结局批，不要写"（全书完）"。',
      end_check: finale ? '\n- 结束前确认最后一章末尾有"（全书完）"。' : '',
      ending: renderEnding(spec),
      feedback: renderFeedback(spec.feedback),
      from: String(spec.from),
      to: String(to),
      accepted: String(spec.accepted),
      total_cjk: String(spec.totalCjk),
      planned: String(spec.planned),
      target_cjk: String(spec.targetCjk),
      min_chars: String(spec.minChars),
      hints,
    };
    return fillTemplate(await readOrderTemplate('takeover'), vars, 'order.takeover');
  }
  if (spec.mode === 'retro') {
    const r = spec.retro ?? { from: Math.max(1, spec.accepted), to: spec.accepted };
    const vars: Record<string, string> = {
      from: String(r.from),
      to: String(r.to),
      from5: pad5(r.from),
      to5: pad5(r.to),
      must_read: mustRead,
      accepted: String(spec.accepted),
      total_cjk: String(spec.totalCjk),
      planned: String(spec.planned),
    };
    return fillTemplate(await readOrderTemplate(spec.mode), vars, `order.${spec.mode}`);
  }
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
    owner_line: extra.ownerNote ? OWNER_LINE : '',
  };
  let vars: Record<string, string>;
  if (spec.mode === 'open-short' || spec.mode === 'open-long') {
    const resume = spec.bibleExisted ? '设定已定（bible.md、outline.md 已在目录里），不要重新构思，直接从第 1 章写起；需要时可以补充大纲。' : '';
    vars = { ...common, resume, library: extra.library };
  } else {
    vars = { ...common, rewrite_line: rewriteLine(spec.allowRewrite), must_read: mustRead, ending: renderEnding(spec), feedback: renderFeedback(spec.feedback), ending_list: endingListLine(spec.endingListExists) };
  }
  return fillTemplate(await readOrderTemplate(spec.mode), vars, `order.${spec.mode}`);
}

// ───────────────────────── 主人的改写请求（WP-2） ─────────────────────────

/** 等着处理的改写请求：章已入库、还没发布（锁定不算冻结：请求本身就解了锁），按章号排 */
export function waitingOwnerRequests(meta: V3BookMeta, publishedThrough: number, accepted: number): V3OwnerRequest[] {
  // 请求本身会解锁那一章；之后又被锁定（主人直接改了、采用了草稿）的不算（lockChapter / adoptDraft 也会把它作废）
  return meta.ownerRequests.filter((r) => r.status === 'waiting' && !isFrozenChapter(r.chapter, { publishedThrough, locked: [] }) && !meta.locked.includes(r.chapter) && r.chapter <= accepted).sort((a, b) => a.chapter - b.chapter);
}

/** p2-plan §5.6 owner_rewrite */
export function ownerRewriteHint(r: Pick<V3OwnerRequest, 'chapter' | 'note'>, at: string): V3Hint {
  const note = r.note.trim();
  const text = note
    ? `主人要求改写第 ${r.chapter} 章：${note}。直接改 manuscript/c${pad5(r.chapter)}.md（整章重写或局部修改都行），改完再写这一批的新章。`
    : `主人要求重写第 ${r.chapter} 章。直接改 manuscript/c${pad5(r.chapter)}.md，改完再写这一批的新章。`;
  return { kind: 'owner_rewrite', chapter: r.chapter, rewrite: r.chapter, text, at };
}

// ───────────────────────── buildOrderSpec（读 DB 与 HEAD） ─────────────────────────


/** Builds OrderSpec from DB/HEAD (books row, meta.v3, HEAD files bible.md/outline.md/notes sizes, publishedThrough, locked) */
export async function buildOrderSpec(ctx: PipelineContext, book: BookHandle, task: TaskRow): Promise<{ spec: OrderSpec; extra: OrderExtra } | { skip: TaskResult }> {
  const db = ctx.deps.db;
  const now = ctx.deps.now();
  // for share：回退正在认领（持有书行锁）时等它提交，下面才看得到 rewinding
  const row = (await db.select().from(books).where(eq(books.id, book.id)).limit(1).for('share'))[0];
  if (!row) return { skip: { status: 'failed', errorClass: 'config', message: `书不存在：${book.id}` } };
  const params = (task.params ?? {}) as Record<string, unknown>;
  const cfg = book.config.v3;
  const kind = task.kind as OrderSpec['kind'];
  const retro = kind === 'book.retro';

  // skip rules（p1-plan §2.13 prepareV3 1；复盘：p2-plan §3.1，没有存稿检查）
  if (row.status === 'completed' || row.status === 'archived') return { skip: { status: 'done', summary: { stale: 'completed' } } };
  const meta = readV3Meta(row.meta);
  // 回退进行中（WP-2）：这个任务是在回退认领前排下的，按旧的进度写没有意义；回退完 decideNext 会重新排
  if (meta.rewinding) return { skip: { status: 'done', summary: { stale: 'rewinding' } } };
  // 主人的改写请求（WP-2）：还没发布、已入库的章；复盘不带
  const ownerReqs = retro ? [] : waitingOwnerRequests(meta, row.publishedThrough, row.acceptedThrough);
  if (retro) {
    if (cfg.length !== 'long' && cfg.length !== 'epic') return { skip: { status: 'done', summary: { stale: 'not_long' } } };
    if (params.to !== row.acceptedThrough) return { skip: { status: 'done', summary: { stale: 'moved' } } };
  } else {
    if (kind === 'book.open' && row.acceptedThrough > 0) return { skip: { status: 'done', summary: { stale: 'opened' } } };
    if (kind === 'book.write' && params.from !== row.acceptedThrough + 1) return { skip: { status: 'done', summary: { stale: 'moved' } } };
  }

  const n0 = cfg.planned_chapters_initial ?? cfg.planned_chapters ?? Math.max(1, Math.ceil(cfg.target_cjk / 4000));
  const planned = cfg.planned_chapters ?? n0;
  const runawayBase = runawayBaseOf(n0, meta.plannedFloor);
  const settings = await loadSystemSettings(db);
  const factor = settings.v3.runawayFactor;
  // 写作批 / 结局批：结局控制按现在的 DB 重算（任务参数里的 mode 只是提示）
  const ending = kind === 'book.write' ? endingPhase({ length: cfg.length, accepted: row.acceptedThrough, planned, runawayBase, batch: cfg.batch, factor, runawayBatches: meta.runawayBatches }) : null;
  if (!retro) {
    const maxBuffer = book.config.publish.max_buffer;
    // 有等着的改写请求、主人要求立即写下一批（writeNow）时存稿满了也写这一批（只多一批：max_buffer ≥ 2 × batch）；结局批不受存稿上限限制（decide.ts finaleBypassesBuffer）
    const finaleFirst = ending !== null && finaleBypassesBuffer(ending.mode, meta.finaleNoMarker);
    if (ownerReqs.length === 0 && !meta.writeNow && !finaleFirst && (row.acceptedThrough - row.publishedThrough >= maxBuffer || row.pausedReason === 'max_buffer')) {
      return { skip: { status: 'waiting', message: BUFFER_FULL_WAIT, retryAfter: new Date(now.getTime() + 30 * 60_000).toISOString(), summary: { stale: 'buffer_full' } } };
    }
  }
  const frozen = { publishedThrough: row.publishedThrough, locked: meta.locked };
  const selected = retro ? { hintsShown: [], allowRewrite: [] } : selectHints(meta.hints, frozen);
  // 主人的改写请求排在所有提示前面，并授权改写那一章
  const hintsShown: V3Hint[] = [...ownerReqs.map((r) => ownerRewriteHint(r, now.toISOString())), ...selected.hintsShown];
  const allowRewrite = [...new Set([...selected.allowRewrite, ...ownerReqs.map((r) => r.chapter)])].sort((a, b) => a - b);

  let step: FlowStep;
  let mode: OrderMode;
  let from: number;
  let count: number;
  let runawayWarn = false;
  if (retro) {
    const rf = typeof params.from === 'number' ? params.from : 1;
    const rt = typeof params.to === 'number' ? params.to : row.acceptedThrough;
    step = { kind: 'retro', from: rf, to: rt };
    mode = 'retro';
    from = row.acceptedThrough + 1;
    count = 0;
  } else if (kind === 'book.open') {
    mode = cfg.length === 'short' ? 'open-short' : 'open-long';
    from = 1;
    count = typeof params.count === 'number' && params.count > 0 ? params.count : mode === 'open-short' ? planned : cfg.batch;
    step = { kind: 'open', mode, count };
  } else {
    const e = ending ?? endingPhase({ length: cfg.length, accepted: row.acceptedThrough, planned, runawayBase, batch: cfg.batch, factor, runawayBatches: meta.runawayBatches });
    mode = e.mode;
    from = row.acceptedThrough + 1;
    count = e.mode === 'finale' ? finaleCount(cfg.length, e.remaining, cfg.batch) : cfg.batch;
    runawayWarn = e.runawayWarn;
    step = { kind: 'write', mode: e.mode, phase: e.phase, forced: e.forced, from, count };
  }

  // HEAD 上的文件
  const head = book.headCommit;
  const listed = ['notes/progress.md', 'outline.md', 'bible.md', 'notes/cast.md', 'notes/threads.md', 'notes/retro.md'];
  const prev = !retro && from > 1 ? `manuscript/${chapterId(from - 1)}.md` : null;
  const probe = [...new Set([...listed, 'notes/chapters.md', 'notes/from-owner.md', ...Object.keys(NOTE_BUDGETS), ...(prev ? [prev] : [])])];
  const shas = await book.repo.blobShas(probe, head);
  const has = (p: string) => (shas[p] ?? '') !== '';
  const budgetFiles = Object.keys(NOTE_BUDGETS).filter(has);
  const texts = await readMany(book, [...budgetFiles, ...(!retro && has('notes/from-owner.md') ? ['notes/from-owner.md'] : [])], head);
  const sizes: Record<string, number> = {};
  for (const f of budgetFiles) sizes[f] = noteSize(texts.get(f) ?? '');
  // 主人留言：非空时任务单带 owner_line，sha 记进 order.json（收稿时只在文件还是这一版时清空并归档）
  const ownerNote = !retro && (texts.get('notes/from-owner.md') ?? '').trim() !== '';
  const ownerMessageSha = ownerNote ? shas['notes/from-owner.md'] || null : null;

  const mustLines: string[] = [];
  const present = listed.filter(has);
  if (present.length) mustLines.push(`- ${present.join('、')}；`);
  // 复盘要核对区间里每一章的记录（每章一行）：列出的行数盖住整个区间，再多几行给标题和空行
  const tailLines = step.kind === 'retro' ? Math.max(30, step.to - step.from + 1 + 5) : 30;
  if (has('notes/chapters.md')) mustLines.push(`- notes/chapters.md 的最后 ${tailLines} 行；`);
  if (prev && has(prev)) mustLines.push(`- 上一章全文：${prev}。`);
  // 接手的旧书（P3 D16）：第一次写作的任务单改成“先接手”，必读清单换成 HEAD 上的旧资料
  let takeover: OrderSpec['takeover'];
  // 一章都没有的旧书也一样（book.open）：旧的 premise / notes 是主人的设定，不能当新书另起方向
  if ((kind === 'book.write' || kind === 'book.open') && meta.takeover?.status === 'pending') {
    const legacy = await legacyFilesAt(book, head);
    const lastChapters: number[] = [];
    for (let k = Math.max(1, row.acceptedThrough - 2); k <= row.acceptedThrough; k += 1) lastChapters.push(k);
    takeover = { lastChapters, legacyFiles: legacy.map((f) => f.path) };
    mustLines.length = 0;
    for (const f of legacy) mustLines.push(`- ${f.path}${f.long ? '（很长，只看开头）' : ''}`);
  }

  // 书库摘要（WP-3，p2-plan §5.3）：同题材全部 + 全站最近 20 本 + 近期最常用的标签
  let library = '';
  if ((mode === 'open-short' || mode === 'open-long') && !takeover) {
    const genreId = book.config.genre ?? row.genre;
    const genreName = (book.genre?.pack as { name?: string } | undefined)?.name || genreId;
    library = renderLibraryV3(await loadLibrary(db, book.id, genreId), genreName);
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
    plannedMax: plannedUpper(n0, meta.plannedFloor, factor, cfg.batch),
    batch: cfg.batch,
    accepted: row.acceptedThrough,
    totalCjk: row.totalCjk,
    publishedThrough: row.publishedThrough,
    locked: meta.locked,
    allowRewrite,
    bibleExisted: has('bible.md'),
    hintsShown,
    effort: effortFor(step, cfg),
    runawayBase,
    ownerMessageSha,
    ownerRequests: ownerReqs.map((r) => ({ id: r.id, chapter: r.chapter, note: r.note })),
  };
  if (takeover) spec.takeover = takeover;
  if (step.kind === 'retro') spec.retro = { from: step.from, to: step.to };
  if (step.kind === 'write') {
    spec.phase = step.phase;
    spec.forced = step.forced;
    spec.runawayWarn = runawayWarn;
    spec.endingListExists = ENDING_LIST_RE.test(texts.get('outline.md') ?? '');
    spec.feedback = {
      phrases: meta.feedback?.phrases ?? [],
      range: meta.feedback ? [meta.feedback.from, meta.feedback.to] : null,
      shortRecent: shortRecent(await recentAverage(ctx, book.id, row.acceptedThrough), cfg.min_chapter_cjk),
    };
  }
  return { spec, extra: { library, mustRead: mustLines.join('\n'), budgets: retro ? '' : noteBudgetLines(sizes).join('\n'), ownerNote } };
}

/** 接手任务单里列的旧资料：这几个固定文件，再加 notes/v1/、bible/（.md、.yaml）、plan/volumes/ 下各最多 12 个文件（排序后取前面的）；超过 64 KB 的标“很长” */
const TAKEOVER_FIXED = ['seed.md', 'bible/premise.md', 'bible.md', 'outline.md', 'notes/progress.md'];
const TAKEOVER_DIRS: { dir: string; re: RegExp }[] = [
  { dir: 'notes/v1', re: /^notes\/v1\/[^/].*[^/]$/ },
  { dir: 'bible', re: /^bible\/.+\.(md|ya?ml)$/ },
  { dir: 'plan/volumes', re: /^plan\/volumes\/.+\.ya?ml$/ },
];
const TAKEOVER_PER_DIR = 12;
const TAKEOVER_LONG_BYTES = 64 * 1024;

async function legacyFilesAt(book: BookHandle, head: string): Promise<{ path: string; long: boolean }[]> {
  const paths: string[] = [];
  const shas = await book.repo.blobShas(TAKEOVER_FIXED, head);
  for (const p of TAKEOVER_FIXED) if ((shas[p] ?? '') !== '') paths.push(p);
  for (const d of TAKEOVER_DIRS) {
    const listed = (await book.repo.list(d.dir, { rev: head, recursive: true }).catch(() => [] as string[])).filter((p) => d.re.test(p) && !paths.includes(p)).sort();
    paths.push(...listed.slice(0, TAKEOVER_PER_DIR));
  }
  const texts = await readMany(book, paths, head);
  return paths.map((p) => ({ path: p, long: Buffer.byteLength(texts.get(p) ?? '', 'utf8') > TAKEOVER_LONG_BYTES }));
}

/** 最近 10 个入库章（no ≤ accepted）的平均字数；没有章节时 null */
async function recentAverage(ctx: PipelineContext, bookId: string, accepted: number): Promise<number | null> {
  if (accepted <= 0) return null;
  const rows = await ctx.deps.db
    .select({ cjk: chapters.cjk })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), lte(chapters.no, accepted)))
    .orderBy(desc(chapters.no))
    .limit(10);
  if (rows.length === 0) return null;
  return rows.reduce((s, r) => s + (r.cjk ?? 0), 0) / rows.length;
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
