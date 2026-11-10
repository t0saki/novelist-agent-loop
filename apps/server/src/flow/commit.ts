/**
 * v3 提交计划（docs/v3/DESIGN.md §3.2 第 6 条；p1-plan §2.9）。纯函数：HarvestPlan → PromotePlan（v3 部分由 committer.promoteV3 执行）。
 * 一章一个提交并打 ch/NNNNN；改写在前（不打标签），设定和笔记跟在本批最后一个提交里。
 */
import { chapterId, tags } from '@novelist/shared';
import type { BookHandle, PromotePlan, RunContext, TaskRow } from '../runtime/types.js';
import type { HarvestPlan, OrderSpec, V3BatchEffectArgs, V3BatchNote, V3CommitPart, V3CommitPlan } from './types.js';

const subject = (prefix: string, no: number, title: string) => `${prefix}${chapterId(no)}${title ? `「${title}」` : ''}`;

export function buildPromote(input: {
  book: BookHandle;
  task: TaskRow;
  run: RunContext;
  order: OrderSpec;
  plan: HarvestPlan;
  trailerKey: string;
  noChapterStreak: number;
  nowIso: string;
  /** 本批的重复统计（有新章时） */
  feedback?: { from: number; to: number; phrases: string[] };
  /** 步数超限：每批章数减一（book.yaml v3.batch 随本批提交） */
  batchNote?: V3BatchNote;
  toolSteps?: number;
  /** WP-2：服务器替主人写的文件（读过的留言清空并归档） */
  serverTail?: NonNullable<V3CommitPlan['serverTail']>;
  ownerMessageRead?: V3BatchEffectArgs['ownerMessageRead'];
  ownerRequestResults?: V3BatchEffectArgs['ownerRequestResults'];
  /** P3：接手任务单（order.takeover）且本批有新章 → v3.batch 把 takeover 记成 done */
  takeoverDone?: boolean;
}): PromotePlan | null {
  const { book, task, run, order, plan } = input;
  if (plan.zeroDiff) return null;
  const rewrites = [...plan.rewrites].sort((a, b) => a.no - b.no);
  const fresh = [...plan.newChapters].sort((a, b) => a.no - b.no);
  const parts: V3CommitPart[] = [
    ...rewrites.map((r) => ({ no: r.no, path: `manuscript/${chapterId(r.no)}.md`, content: r.content, message: subject('chapter: rewrite ', r.no, r.title), tag: null, rewrite: true, extra: r.extra ?? [] })),
    ...fresh.map((c) => ({ no: c.no, path: `manuscript/${chapterId(c.no)}.md`, content: c.content, message: subject('chapter: ', c.no, c.title), tag: tags.chapter(c.no), rewrite: false, extra: c.extra ?? [] })),
  ];
  const bookYaml: V3CommitPlan['bookYaml'] = [];
  if (plan.plannedChapters !== undefined) bookYaml.push({ path: ['v3', 'planned_chapters'], value: plan.plannedChapters });
  if (plan.title !== undefined) bookYaml.push({ path: ['title'], value: plan.title });
  if (plan.blurb !== undefined) bookYaml.push({ path: ['blurb'], value: plan.blurb });
  if (input.batchNote) bookYaml.push({ path: ['v3', 'batch'], value: input.batchNote.to });
  const a = fresh[0]?.no ?? order.from;
  const b = fresh[fresh.length - 1]?.no ?? order.from + Math.max(order.count, 1) - 1;
  const tailMessage = order.mode === 'retro' && order.retro ? `notes: retro ${order.retro.from}–${order.retro.to} run ${run.runId.slice(0, 8)}` : `notes: ${order.kind} ${a}–${b} run ${run.runId.slice(0, 8)}`;
  const args: V3BatchEffectArgs = {
    bookId: book.id,
    runId: run.runId,
    nowIso: input.nowIso,
    chapters: [
      ...rewrites.map((r) => ({ no: r.no, cid: chapterId(r.no), title: r.title, cjk: r.cjk, rewrite: true, path: `manuscript/${chapterId(r.no)}.md` })),
      ...fresh.map((c) => ({ no: c.no, cid: chapterId(c.no), title: c.title, cjk: c.cjk, rewrite: false, path: `manuscript/${chapterId(c.no)}.md` })),
    ],
    batchFrom: fresh.length ? (fresh[0]?.no ?? null) : null,
    completed: plan.completed,
    ...(plan.completedOn !== undefined ? { completedOn: plan.completedOn } : {}),
    ...(plan.completedNote !== undefined ? { completedNote: plan.completedNote } : {}),
    ...(plan.title !== undefined ? { title: plan.title } : {}),
    ...(plan.blurb !== undefined ? { blurb: plan.blurb } : {}),
    ...(plan.tags !== undefined ? { tags: plan.tags } : {}),
    hints: plan.hints,
    noChapterStreak: input.noChapterStreak,
    finaleNoMarker: plan.finaleNoMarker,
    hintedShort: plan.hintedShort,
    orderKind: order.kind,
    baseCommit: run.baseCommit,
    runawayBatches: plan.runawayBatches,
    shortEndUsed: plan.shortEndUsed,
    plannedFloor: plan.plannedFloor,
    ...(plan.finaleNoMarkerAlert ? { finaleNoMarkerAlert: true } : {}),
    ...(input.feedback ? { feedback: input.feedback } : {}),
    ...(input.batchNote ? { batchNote: input.batchNote } : {}),
    ...(input.toolSteps !== undefined ? { toolSteps: input.toolSteps } : {}),
    ...(input.ownerMessageRead ? { ownerMessageRead: input.ownerMessageRead } : {}),
    ...(input.ownerRequestResults?.length ? { ownerRequestResults: input.ownerRequestResults } : {}),
    ...(input.takeoverDone ? { takeoverDone: true } : {}),
  };
  return {
    bookId: book.id,
    taskId: task.id,
    runId: run.runId,
    baseCommit: run.baseCommit,
    files: [],
    resolveTmpIds: false,
    message: tailMessage,
    trailers: {},
    tags: [],
    effect: { name: 'v3.batch', args: args as unknown as Record<string, unknown> },
    v3: { key: input.trailerKey, parts, tail: plan.tail, bookYaml, baseCommit: run.baseCommit, tailMessage, ...(input.serverTail?.length ? { serverTail: input.serverTail } : {}) },
  };
}
