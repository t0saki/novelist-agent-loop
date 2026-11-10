/** 章节的只读视图（管理端）。旧流程的规划 / 质量 / 状态 / 评审视图已删除。 */
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { ChapterAdminDetail, ChapterRow, Page, RunRow, ChapterWorkflowState } from '@novelist/shared';
import { chapterId } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { bookFiles, isV3Meta, openRepo } from '../book/index.js';
import { chapters, runs, tasks } from '../db/schema.js';
import { notFound } from '../api/problem.js';
import { bookDir, decodeCursor, encodeCursor, type BookRow } from '../api/helpers.js';

type ChapterTable = typeof chapters.$inferSelect;

export function toChapterRow(c: ChapterTable): ChapterRow {
  return {
    no: c.no,
    id: c.chapterId,
    title: c.title,
    volume: c.volume,
    volumeTitle: c.volumeTitle,
    state: c.state as ChapterWorkflowState,
    cjk: c.cjk,
    acceptedAt: c.acceptedAt,
    publishedAt: c.publishedAt,
  };
}

export async function chapterPage(deps: Pick<AppDeps, 'db'>, book: BookRow, cursor: string | undefined, limit: number): Promise<Page<ChapterRow>> {
  const after = decodeCursor(cursor)?.[0];
  const where = typeof after === 'number' ? and(eq(chapters.bookId, book.id), gt(chapters.no, after)) : eq(chapters.bookId, book.id);
  const rows = await deps.db.select().from(chapters).where(where).orderBy(asc(chapters.no)).limit(limit + 1);
  const items = rows.slice(0, limit).map(toChapterRow);
  return { items, nextCursor: rows.length > limit ? encodeCursor([rows[limit - 1]?.no as number]) : null };
}

export function toRunRow(r: typeof runs.$inferSelect, slug: string | null): RunRow {
  const usage = (r.usage ?? {}) as { input?: number; output?: number; cachedInput?: number; costUsd?: number };
  return {
    id: r.id,
    taskId: r.taskId,
    bookSlug: slug,
    kind: r.taskKind as RunRow['kind'],
    attempt: r.attempt,
    role: r.role as RunRow['role'],
    profileId: r.profileId,
    accountId: r.accountId,
    harness: r.harness as RunRow['harness'],
    harnessVersion: r.harnessVersion,
    model: r.model,
    modelReported: r.modelReported,
    isolation: r.isolation as RunRow['isolation'],
    state: r.state as RunRow['state'],
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    errorClass: r.errorClass as RunRow['errorClass'],
    usage: { input: usage.input ?? 0, output: usage.output ?? 0, cached: usage.cachedInput ?? 0, costUsd: usage.costUsd ?? null },
    denials: r.denials,
    toolSteps: typeof r.outcome?.toolSteps === 'number' ? r.outcome.toolSteps : null,
  };
}

/** 章节详情：数据库行 + 正文（书目录不在时 text 为 null）+ 相关运行；新流程的书标出主人改过（锁定）的章节 */
export async function chapterDetail(deps: AppDeps, book: BookRow, no: number): Promise<ChapterAdminDetail> {
  const rows = await deps.db.select().from(chapters).where(and(eq(chapters.bookId, book.id), eq(chapters.no, no))).limit(1);
  const row = rows[0];
  if (!row) throw notFound(`第 ${no} 章`);
  const files = bookFiles(openRepo(bookDir(deps, book.slug)));
  const v3 = isV3Meta(book.meta) ? ((book.meta as { v3: { locked?: unknown } }).v3 as { locked?: unknown[] }) : null;
  const [text, taskIds] = await Promise.all([
    files.manuscript(no).catch(() => null),
    deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, book.id), eq(tasks.target, chapterId(no)))),
  ]);
  const runRows = taskIds.length ? await deps.db.select().from(runs).where(inArray(runs.taskId, taskIds.map((t) => t.id))).orderBy(desc(runs.createdAt)).limit(30) : [];
  return {
    ...toChapterRow(row),
    text,
    runs: runRows.map((r) => toRunRow(r, book.slug)),
    commit: row.acceptedCommit,
    locked: v3 !== null && Array.isArray(v3.locked) && v3.locked.includes(no),
    legacy: v3 === null,
  };
}
