/**
 * 书级“下一步”（v3，docs/v3/DESIGN.md §2）：scheduler 每个 tick 对每本 v3 书调用 nextTasks；任务结束后调用 onTaskDone 推进。
 * 两者都只“提议”TaskSpec；入队幂等（同 id 不重复）。旧书（book.yaml 不是 v3）什么都不提议。
 */
import { eq } from 'drizzle-orm';
import { books } from '../db/schema.js';
import { isV3Kind, nextTasksV3 } from '../flow/handlers.js';
import { isLegacyConfig } from './book.js';
import type { PipelineContext, TaskResult, TaskRow, TaskSpec } from './types.js';

export async function nextTasks(ctx: PipelineContext): Promise<TaskSpec[]> {
  const book = ctx.book;
  if (!book || isLegacyConfig(book.config)) return [];
  const row = (await ctx.deps.db.select().from(books).where(eq(books.id, book.id)).limit(1))[0];
  if (!row || row.status === 'archived') return [];
  return nextTasksV3(ctx, book, row);
}

/** 任务完成后的即时后续（只是加快：下一个 tick 也会提出同一个 id） */
export async function onTaskDone(ctx: PipelineContext, task: TaskRow, result: TaskResult): Promise<TaskSpec[]> {
  if (!isV3Kind(task.kind) || result.status !== 'done' || !ctx.book) return [];
  const row = (await ctx.deps.db.select().from(books).where(eq(books.id, ctx.book.id)).limit(1))[0];
  return row ? nextTasksV3(ctx, ctx.book, row) : [];
}
