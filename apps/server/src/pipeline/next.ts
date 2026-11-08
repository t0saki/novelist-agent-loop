/**
 * 书级 DAG（DESIGN §6.0 开书管线、§6.2 滚动规划、§6.4 单章任务图、§6.10 周期审计）。Owner: lane E。
 * scheduler（lane F）每个 tick 对每本 planning/active 书调用 nextTasks；任务结束后调用 onTaskDone 推进。
 * 两者都只“提议”TaskSpec；入队幂等（同 id 不重复）。章节内部的下一步由 handler.finalize 的 followups 给出；
 * nextTasks 负责开书、滚动规划、下一章、审计与摘要的补齐，以及崩溃后重新派发 workflow.next。
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { arcId, arcNo, chapterId, chapterNo } from '@novelist/shared';
import type { Arc, ChapterWorkflowState } from '@novelist/shared';
import { P } from '../book/index.js';
import { books, tasks } from '../db/schema.js';
import { loadBookState } from '../state/index.js';
import { auditProgress, windowTarget } from './handlers/audit.js';
import { highestCard, totalChapters } from './handlers/plan.js';
import { BAKEOFF_DIR } from './handlers/system.js';
import type { BookHandle, PipelineContext, TaskResult, TaskRow, TaskSpec } from './types.js';
import { getChapterRow } from './workflow.js';
import type { ChapterWorkflow } from './workflow.js';

export interface BookRuntimeState {
  /** 该书在 DB 中处于活跃状态（ready/leased/running/finalizing/waiting）的任务 */
  active: { id: string; kind: string; target: string; lane: string; state: string }[];
  acceptedThrough: number;
  cardsThrough: number;
  publishedThrough: number;
  auditedThrough: number;
  /** 存稿超过 max_buffer → 暂停生产，回落到 resume_buffer 以下恢复 */
  productionPaused: boolean;
  openApprovals: string[];
}

const spec = (book: BookHandle, kind: TaskSpec['kind'], target: string, params?: Record<string, unknown>): TaskSpec => ({ kind, bookId: book.id, target, ...(params ? { params } : {}) });

/** 开书：返回第一批任务（plan.interview? → plan.premise …） */
export function initialTasks(book: BookHandle, opts: { interview: boolean }): TaskSpec[] {
  return [opts.interview ? spec(book, 'plan.interview', 'book') : spec(book, 'plan.premise', 'book')];
}

const GATING_APPROVAL = /^(approval:compass|approval:volume:|interview:|bakeoff:)/;

/** 开书期的重做任务（审批打回 / 访谈答案）还在排队或执行时，后续规划步骤要等它完成 */
function firstVolumeRedoActive(state: BookRuntimeState, v1Id: string | undefined): boolean {
  return v1Id !== undefined && state.active.some((a) => a.kind === 'plan.volume' && a.target === v1Id);
}

/** 打回重做失败或阻塞时，被打回的产物不能继续用：停在这里，等 owner 在 Inbox 重试 */
async function rejectRedoStuck(ctx: PipelineContext, bookId: string): Promise<boolean> {
  const rows = await ctx.deps.db
    .select({ kind: tasks.kind, target: tasks.target, state: tasks.state, params: tasks.params })
    .from(tasks)
    .where(and(eq(tasks.bookId, bookId), inArray(tasks.kind, ['plan.compass', 'plan.volume'])))
    .orderBy(desc(tasks.createdAt));
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.kind}:${r.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if ((r.state === 'failed' || r.state === 'blocked') && String(r.params.instance ?? '').startsWith('reject-')) return true;
  }
  return false;
}

async function doneKinds(ctx: PipelineContext, bookId: string): Promise<Set<string>> {
  const rows = await ctx.deps.db
    .select({ kind: tasks.kind, target: tasks.target })
    .from(tasks)
    .where(and(eq(tasks.bookId, bookId), eq(tasks.state, 'done')));
  return new Set(rows.flatMap((r) => [r.kind, `${r.kind}:${r.target}`]));
}

/** 开书管线：返回待派发任务；stop=true 表示开书未完成，写作与其余调度都先不动 */
async function openingStep(ctx: PipelineContext, book: BookHandle, state: BookRuntimeState): Promise<{ tasks: TaskSpec[]; stop: boolean }> {
  if (state.active.some((a) => /^plan\.(interview|premise|compass|bible|volumes)$/.test(a.kind))) return { tasks: [], stop: true };
  const done = await doneKinds(ctx, book.id);
  const busy = (kind: string) => state.active.some((a) => a.kind === kind);
  const one = (kind: TaskSpec['kind'], target: string, params?: Record<string, unknown>) => ({ tasks: busy(kind) ? [] : [spec(book, kind, target, params)], stop: true });
  if (state.openApprovals.some((k) => GATING_APPROVAL.test(k))) return { tasks: [], stop: true };
  if (await rejectRedoStuck(ctx, book.id)) return { tasks: [], stop: true };
  if (busy('plan.interview')) return { tasks: [], stop: true };
  if (!done.has('plan.premise')) return one('plan.premise', 'book');
  const compass = await book.files.compass();
  if (!compass) return one('plan.compass', 'book');
  if (!(await book.files.world())) return one('plan.bible', 'book');
  const volumes = await book.files.volumes();
  if (volumes.length === 0) return one('plan.volumes', 'book');
  const v1 = volumes[0];
  if (firstVolumeRedoActive(state, v1?.id)) return { tasks: [], stop: true };
  if (v1 && v1.detail !== 'detailed') return one('plan.volume', v1.id);
  if ((await highestCard(book)) === 0) {
    const target = await nextArc(book, 0);
    if (target?.kind === 'arc') return one('plan.arc', target.arc, { volume: target.volume, start: 1 });
    return { tasks: [], stop: true };
  }
  const out: TaskSpec[] = [];
  if (!done.has('routing.feasibility') && !busy('routing.feasibility')) out.push({ kind: 'routing.feasibility', bookId: book.id, target: `book:${book.id}` });
  // bake-off（opt-in，默认关）：候选写手 × 第 1/2/11 章
  if (book.config.optin.bakeoff) {
    const blocked = await bakeoffStep(book, out, state);
    if (blocked) return { tasks: out, stop: true };
  }
  return { tasks: out, stop: false };
}

async function bakeoffStep(book: BookHandle, out: TaskSpec[], state: BookRuntimeState): Promise<boolean> {
  const candidates = book.config.routing.roles.writer?.chain ?? [];
  if (candidates.length < 2) return false;
  const chapterIds = [1, 2, 11].map((n) => chapterId(n));
  let waiting = false;
  for (const cid of chapterIds) {
    if (!(await book.files.card(chapterNo(cid)))) continue;
    if (await book.repo.exists(`${BAKEOFF_DIR}/${cid}/decision.json`)) continue;
    waiting = true;
    const allWritten = await everyExists(book, candidates.map((p) => `${BAKEOFF_DIR}/${cid}/${p}.md`));
    if (allWritten) {
      if (!state.active.some((a) => a.kind === 'bakeoff.judge' && a.target === cid)) out.push({ kind: 'bakeoff.judge', bookId: book.id, target: cid, params: { candidates } });
    } else {
      for (const p of candidates) {
        const target = `${cid}@${p}`;
        if (await book.repo.exists(`${BAKEOFF_DIR}/${cid}/${p}.md`)) continue;
        if (!state.active.some((a) => a.kind === 'bakeoff.write' && a.target === target)) out.push({ kind: 'bakeoff.write', bookId: book.id, target, params: { candidate: p } });
      }
    }
  }
  return waiting;
}

async function everyExists(book: BookHandle, rels: string[]): Promise<boolean> {
  for (const r of rels) if (!(await book.repo.exists(r))) return false;
  return true;
}

type NextPlan = { kind: 'arc'; arc: string; volume: string } | { kind: 'volume'; volume: string };

/** 下一个要细化的弧（卷按序走完；未细化的卷先 plan.volume） */
async function nextArc(book: BookHandle, cardsThrough: number): Promise<NextPlan | null> {
  const volumes = await book.files.volumes();
  const arcs = await book.files.arcs();
  const byId = new Map<string, Arc>(arcs.map((a) => [a.id, a]));
  let maxArc = arcs.reduce((m, a) => Math.max(m, arcNo(a.id)), 0);
  for (const v of volumes) {
    if (v.detail !== 'detailed') return { kind: 'volume', volume: v.id };
    for (const a of v.arcs) {
      maxArc = Math.max(maxArc, arcNo(a.id));
      const file = byId.get(a.id);
      if (file?.detail === 'detailed' && chapterNo(file.chapters[1]) <= cardsThrough) continue;
      return { kind: 'arc', arc: a.id, volume: v.id };
    }
  }
  const last = volumes[volumes.length - 1];
  if (!last) return null;
  return { kind: 'arc', arc: arcId(maxArc + 1), volume: last.id };
}

export async function nextTasks(ctx: PipelineContext, state: BookRuntimeState): Promise<TaskSpec[]> {
  const book = ctx.book;
  if (!book) return [];
  const rows = await ctx.deps.db.select().from(books).where(eq(books.id, book.id)).limit(1);
  const row = rows[0];
  if (!row || row.status === 'archived') return [];
  if (row.status === 'completed') return maintenance(ctx, book, state);

  const opening = await openingStep(ctx, book, state);
  if (opening.stop) return opening.tasks;
  const out: TaskSpec[] = [...opening.tasks];

  const accepted = state.acceptedThrough;
  const cardsThrough = Math.max(state.cardsThrough, await highestCard(book));
  const total = totalChapters(book);
  const remaining = total - cardsThrough;
  const { min, target } = book.genre.pacing.card_buffer;
  const buffer = cardsThrough - accepted;
  const planBusy = state.active.some((a) => a.kind === 'plan.arc' || a.kind === 'plan.volume');

  // 滚动规划：缓冲不足目标就排下一个弧（side lane）
  if (remaining > 0 && buffer < target && !planBusy) {
    const nextP = await nextArc(book, cardsThrough);
    if (nextP?.kind === 'volume') out.push(spec(book, 'plan.volume', nextP.volume));
    else if (nextP?.kind === 'arc') out.push(spec(book, 'plan.arc', nextP.arc, { volume: nextP.volume, start: cardsThrough + 1 }));
  }
  // 余量 ≤ min：写作 lane 让出提交窗口（§6.2）
  const writeBlocked = remaining > 0 && buffer <= min;

  out.push(...(await maintenance(ctx, book, state)));
  if (!writeBlocked && !state.productionPaused) out.push(...(await writeLane(ctx, book, state)));
  return dedupe(out);
}

function dedupe(specs: TaskSpec[]): TaskSpec[] {
  const seen = new Set<string>();
  return specs.filter((s) => {
    const k = `${s.kind}|${s.target}|${(s.params?.instance as string | undefined) ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function writeLane(ctx: PipelineContext, book: BookHandle, state: BookRuntimeState): Promise<TaskSpec[]> {
  if (state.active.some((a) => a.lane === 'write')) return [];
  const no = state.acceptedThrough + 1;
  const card = await book.files.card(no);
  if (!card) return [];
  const row = await getChapterRow(ctx.deps.db, book.id, no);
  const st = (row?.state ?? 'planned') as ChapterWorkflowState;
  const wf = (row?.workflow ?? {}) as Partial<ChapterWorkflow>;
  if (st === 'planned') return wf.next ? [redispatch(book, no, wf)] : [spec(book, 'chapter.write', chapterId(no))];
  if (st === 'needs_repair') {
    if (state.active.some((a) => a.kind === 'card.repair')) return [];
    if (card.stale) return [spec(book, 'card.repair', chapterId(no), { cards: [chapterId(no)], reasons: { [chapterId(no)]: ['章节标记 needs_repair'] } })];
    return [spec(book, 'chapter.write', chapterId(no), { instance: `repaired-${(await book.repo.head()).slice(0, 8)}` })];
  }
  if (st === 'held' || st === 'blocked' || st === 'accepted') return [];
  // 进行中但没有活跃任务（崩溃）：重新派发 workflow.next（同 instance，幂等）
  if (wf.next) return [redispatch(book, no, wf)];
  return [spec(book, 'chapter.write', chapterId(no))];
}

function redispatch(book: BookHandle, no: number, wf: Partial<ChapterWorkflow>): TaskSpec {
  const n = wf.next as NonNullable<ChapterWorkflow['next']>;
  return { kind: n.kind, bookId: book.id, target: chapterId(no), tier: wf.tier ?? 'standard', params: n.params, ...(n.role ? { role: n.role } : {}), ...(n.lane ? { lane: n.lane } : {}), ...(n.priority !== undefined ? { priority: n.priority } : {}) };
}

/** 周期审计 / 摘要 / 债务（幂等，nextTasks 与 onTaskDone 共用） */
export async function maintenance(ctx: PipelineContext, book: BookHandle, state: Pick<BookRuntimeState, 'active' | 'acceptedThrough'>): Promise<TaskSpec[]> {
  const out: TaskSpec[] = [];
  const accepted = state.acceptedThrough;
  if (accepted === 0) return out;
  const arcsAll = await book.files.arcs();
  const busyKind = (k: string) => state.active.some((a) => a.kind === k);
  const progress = await auditProgress(ctx, book);
  const bookRow = (await ctx.deps.db.select({ status: books.status }).from(books).where(eq(books.id, book.id)).limit(1))[0];
  const isDone = bookRow?.status === 'completed';
  // 确定性窗口审计：每 5 章；书完结时补上尾巴
  const windowEnd = progress.window_through + 5;
  if (windowEnd <= accepted) out.push(spec(book, 'audit.window', windowTarget(progress.window_through + 1, windowEnd)));
  else if (isDone && progress.window_through < accepted) out.push(spec(book, 'audit.window', windowTarget(progress.window_through + 1, accepted)));

  // 弧末：summary.arc → audit.arc（用 followup 串联；这里按文件补齐）
  const arcs = arcsAll.filter((a) => chapterNo(a.chapters[1]) <= accepted);
  for (const a of arcs) {
    if (!(await book.repo.exists(P.summaryArc(a.id)))) {
      if (!busyKind('summary.arc')) out.push(spec(book, 'summary.arc', a.id));
      break;
    }
    if (!(await book.repo.exists(P.audit(`arc-${a.id}`)))) {
      if (!busyKind('audit.arc')) out.push(spec(book, 'audit.arc', a.id));
      break;
    }
  }
  // 卷末：summary.volume → audit.volume + book.blurb
  for (const v of await book.files.volumes()) {
    const own = arcsAll.filter((a) => a.volume === v.id);
    if (own.length === 0 || !own.every((a) => chapterNo(a.chapters[1]) <= accepted)) continue;
    if (!(await book.repo.exists(P.summaryVolume(v.id)))) {
      if (!busyKind('summary.volume')) out.push(spec(book, 'summary.volume', v.id));
      break;
    }
    if (!(await book.repo.exists(P.audit(`volume-${v.id}`)))) {
      if (!busyKind('audit.volume')) out.push(spec(book, 'audit.volume', v.id));
      break;
    }
  }
  // minor 伏笔 triage（§6.9、§6.11）：超龄或 endgame 期间，每 20 章一次，交 plan.fix（showrunner）
  const bookRow2 = (await ctx.deps.db.select({ endgame: books.endgame }).from(books).where(eq(books.id, book.id)).limit(1))[0];
  const bookState = await loadBookState(book.dir);
  const openMinor = Object.values(bookState.snapshot.obligations).filter((o) => o.weight === 'minor' && (o.status === 'open' || o.status === 'advanced'));
  const limit = bookState.compass?.limits.minor_max_age_ch ?? 120;
  const overAge = openMinor.filter((o) => accepted - chapterNo(o.opened) > limit).length;
  if ((overAge > 0 || (bookRow2?.endgame && openMinor.length > 0)) && accepted % 20 === 0 && !busyKind('plan.fix')) {
    out.push(spec(book, 'plan.fix', 'book', { reason: `minor 伏笔 triage：超龄 ${overAge} 条，open minor ${openMinor.length} 条，请回收、降级或放弃`, instance: `triage-${accepted}` }));
  }
  // held-out 抽检（opt-in，默认关；§6.7）每 50 章
  if (book.config.optin.heldout && accepted > 0 && accepted % 50 === 0 && !(await book.repo.exists(P.audit(`heldout-held-${accepted}`)))) {
    out.push(spec(book, 'audit.heldout', `held-${accepted}`, { sample: [chapterId(Math.max(1, accepted - 2)), chapterId(Math.max(1, accepted - 1)), chapterId(accepted)] }));
  }
  // forward 债务超上限 → plan.fix
  const debts = (await book.files.debts()).filter((d) => d.class === 'forward' && d.status === 'open');
  if (debts.length > book.config.policy.forward_debt_cap && !busyKind('plan.fix')) {
    out.push(spec(book, 'plan.fix', 'book', { reason: `forward 债务 ${debts.length} 条，超过上限 ${book.config.policy.forward_debt_cap}`, instance: `debt-${accepted}` }));
  }
  return out;
}

/** 任务完成后的即时后续（scheduler 下一 tick 也会补齐；这里只是更快） */
export async function onTaskDone(ctx: PipelineContext, task: TaskRow, result: TaskResult): Promise<TaskSpec[]> {
  if (!ctx.book || result.status !== 'done') return [];
  if (task.kind === 'chapter.accept' || /^(summary|audit)\./.test(task.kind)) {
    const state = await loadBookState(ctx.book.dir);
    return maintenance(ctx, ctx.book, { active: [], acceptedThrough: state.ledger.length });
  }
  return [];
}

// ───────── owner 操作（F/G 调用）─────────

export type ChapterActionName = 'rewrite' | 'repair' | 'reextract' | 'approve';

/**
 * 章节管理动作对应的任务（ChapterAction）。F 的 chapterAction 用它入队；同时应用返回的 chapter 字段更新 chapters.state/workflow。
 * 其余动作（hold/unhold/publish_now）由 F 直接处理。
 */
export function chapterActionSpecs(
  book: BookHandle,
  no: number,
  action: ChapterActionName,
  opts: { note?: string; instance?: string; workflow?: Partial<ChapterWorkflow> } = {},
): { specs: TaskSpec[]; chapter?: { no: number; state: ChapterWorkflowState; workflow?: Record<string, unknown> } } {
  const { note, instance, workflow } = opts;
  const cid = chapterId(no);
  const ownerNotes = note?.trim() ? [note] : undefined;
  const inst = instance ?? `${action}-${Date.now()}`;
  switch (action) {
    case 'rewrite':
      // seq 沿用并递增：重写后的 extract/review 等实例号不会撞上上一轮已完成的任务
      return {
        specs: [spec(book, 'chapter.write', cid, { instance: inst, ...(ownerNotes ? { ownerNotes } : {}) })],
        chapter: { no, state: 'planned', workflow: { v: 1, seq: (workflow?.seq ?? 0) + 1, next: { kind: 'chapter.write', params: { instance: inst, ...(ownerNotes ? { ownerNotes } : {}) } } } },
      };
    case 'repair':
      return { specs: [spec(book, 'chapter.repair', cid, { instance: inst, conflicts: note ? [note] : ['人工要求修补'] })] };
    case 'reextract':
      return { specs: [spec(book, 'chapter.reextract', cid, { instance: inst })] };
    case 'approve': {
      // owner 放行：已有定稿 delta → 直接验收；hold 发生在抽取之前 → 继续抽取（修不好的工艺问题已由 owner 接受）
      if (workflow?.delta) return { specs: [spec(book, 'chapter.accept', cid, { instance: inst, ownerApproved: true })], chapter: { no, state: 'accepting' } };
      const kind = workflow?.tier === 'lite' ? 'chapter.check' : 'chapter.extract';
      return { specs: [spec(book, kind, cid, { instance: inst, mode: 'full', expandOnly: false })], chapter: { no, state: 'checking' } };
    }
  }
}
