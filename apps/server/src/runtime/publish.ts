/**
 * publish 任务（确定性）：publisher 按节奏入队，主人“立即发布”也走它。打 tag published/N、更新 chapters.published_at、books.published_through。
 * 只发布 v3 书（发布规则见 flow/publish.ts）；旧书不再发布（P3 D13），已发布的章节照常可读。
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { chapterNo, tags as gitTags } from '@novelist/shared';
import { P } from '../book/index.js';
import { books, chapters, publishSchedule } from '../db/schema.js';
import { requestHoldCap } from '../flow/publish.js';
import { readV3Meta } from '../flow/state.js';
import { isLegacyConfig } from './book.js';
import { buildManifest, requireBook } from './manifest.js';
import type { BookHandle, PipelineContext, TaskHandler, TaskResult } from './types.js';

/** publish 任务的 target：`through-N`（发布到第 N 章，publisher / publishNow）或 cNNNNN（单章） */
function publishThrough(target: string): number {
  const m = /^through-(\d+)$/.exec(target);
  return m ? Number(m[1]) : chapterNo(target);
}

/**
 * v3 书的发布（p2-plan §3.2）：在事务里锁住书行再算上限，和采用草稿、改写请求、回退的检查用同一把锁；
 * 回退进行中（meta.v3.rewinding）最多发布到回退目标。git 的 published/N 标签在事务提交之后打（-f 幂等）。
 */
async function publishV3(ctx: PipelineContext, book: BookHandle, through: number, nowIso: string, manual: boolean): Promise<TaskResult> {
  const r = await ctx.deps.db.transaction(async (tx) => {
    const row = (await tx.select({ published: books.publishedThrough, accepted: books.acceptedThrough, status: books.status, meta: books.meta }).from(books).where(eq(books.id, book.id)).limit(1).for('update'))[0];
    const from = (row?.published ?? 0) + 1;
    const meta = readV3Meta(row?.meta);
    const rewinding = meta.rewinding;
    // 入队之后主人才提的改写请求：锁内复查（手动发布越过请求，之后由 dropPublishedRequests 作废）
    const hold = manual ? Number.MAX_SAFE_INTEGER : Math.min(Number.MAX_SAFE_INTEGER, requestHoldCap(meta, row?.status, row?.status === 'completed'));
    const to = Math.min(through, row?.accepted ?? through, rewinding ? rewinding.to : Number.MAX_SAFE_INTEGER, hold);
    if (to < from) return { from, to };
    await tx.update(chapters).set({ publishedAt: sql`COALESCE(${chapters.publishedAt}, ${nowIso})` }).where(and(eq(chapters.bookId, book.id), gte(chapters.no, from), lte(chapters.no, to)));
    await tx.update(publishSchedule).set({ state: 'published', publishedAt: nowIso }).where(and(eq(publishSchedule.bookId, book.id), gte(publishSchedule.no, from), lte(publishSchedule.no, to)));
    await tx.update(books).set({ publishedThrough: sql`GREATEST(${books.publishedThrough}, ${to})`, updatedAt: nowIso }).where(eq(books.id, book.id));
    return { from, to };
  });
  if (r.to < r.from) return { status: 'done', summary: { published: 0, through } };
  for (let no = r.from; no <= r.to; no++) await book.repo.tag(gitTags.published(no));
  return { status: 'done', summary: { published: r.to - r.from + 1, through: r.to } };
}

export const publish: TaskHandler = {
  kind: 'publish',
  role: null,
  lane: 'system',
  maxAttempts: 3,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.manuscript(publishThrough(spec.target))] }),
  async execute(ctx, task): Promise<TaskResult> {
    const book = requireBook(ctx);
    if (isLegacyConfig(book.config)) return { status: 'done', summary: { published: 0, skipped: 'legacy' } };
    const through = publishThrough(task.target);
    const nowIso = ctx.deps.now().toISOString();
    return publishV3(ctx, book, through, nowIso, (task.params as { manual?: boolean } | null)?.manual === true);
  },
};
