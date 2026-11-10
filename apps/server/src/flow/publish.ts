/**
 * v3 发布上限（docs/v3/DESIGN.md §3.4；p1-plan §2.12）：一章在“后面又有章节入库 / 全书完结 / 入库满 N 小时”之一满足后才可发布。
 * 补写、改写、主人修改都发生在读者看到之前。
 */
import { and, eq, lte, max } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { books, chapters } from '../db/schema.js';
import { firstWaitingRequest } from './owner.js';
import { readV3Meta } from './state.js';
import type { V3BookMeta } from './types.js';

/** early_end 提示的发布冻结期 */
export const EARLY_END_HOLD_MS = 72 * 3600_000;

/** 纯函数部分（便于测试）：给定书的计数、meta 与“入库满 N 小时的最大章号”，算出现在最多能发布到第几章 */
export function v3Cap(input: { accepted: number; completed: boolean; meta: V3BookMeta; agedThrough: number; now: Date; status?: string }): number {
  const { accepted, meta, now } = input;
  let cap = input.completed ? accepted : Math.min(accepted, Math.max((meta.lastBatchFrom ?? 1) - 1, input.agedThrough));
  const holdFrom = now.getTime() - EARLY_END_HOLD_MS;
  for (const h of meta.hints) {
    if (h.kind !== 'early_end' || h.chapter === undefined) continue;
    if (Date.parse(h.at) > holdFrom) cap = Math.min(cap, h.chapter - 1);
  }
  cap = Math.min(cap, requestHoldCap(meta, input.status, input.completed));
  return Math.max(0, cap);
}

/**
 * 主人要求改写的章在改写之前不发布（只在书还在写的时候：暂停或完结的书没有下一批）。
 * 返回最多能发布到第几章（没有限制时 +∞）。v3Cap（入队时）和 publish 任务（锁住书行后执行时）共用。
 */
export function requestHoldCap(meta: Pick<V3BookMeta, 'ownerRequests' | 'completedAt' | 'locked'>, status: string | undefined, completed: boolean): number {
  const k = firstWaitingRequest(meta);
  const writing = status === undefined || status === 'active' || status === 'planning';
  return k !== null && writing && !completed && meta.completedAt === undefined ? k - 1 : Number.POSITIVE_INFINITY;
}

/** §3.4: max chapter publishable now =
 *    completed ? accepted : max(lastBatchFrom-1, max no with acceptedAt ≤ now-hours), ≤ accepted;
 *  then early_end hold: for every hint early_end{chapter:k} in meta.v3.hints with at > now-72h, cap = min(cap, k-1). */
export async function v3PublishCap(db: Db, bookId: string, now: Date, hours: number): Promise<number> {
  const row = (await db.select({ accepted: books.acceptedThrough, status: books.status, meta: books.meta }).from(books).where(eq(books.id, bookId)).limit(1))[0];
  if (!row) return 0;
  const meta = readV3Meta(row.meta);
  const cutoff = new Date(now.getTime() - hours * 3600_000).toISOString();
  const aged = await db
    .select({ n: max(chapters.no) })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), lte(chapters.acceptedAt, cutoff), lte(chapters.no, row.accepted)));
  return v3Cap({ accepted: row.accepted, completed: row.status === 'completed' || meta.completedAt !== undefined, meta, agedThrough: Number(aged[0]?.n ?? 0), now, status: row.status });
}
