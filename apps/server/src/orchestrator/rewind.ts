/**
 * 回退到第 N 章（DESIGN §4.4）。确定性操作，不走模型，不进队列：持仓库锁 reset 到 tag ch/NNNNN，重算 chapters/books 前沿。
 * 越过已发布章节需要二次确认；有任务在执行时拒绝（要先暂停/取消）。
 * 基于被丢弃 HEAD 的任务（排队中的 + 回退点之后结束的）一律标 stale：回退后重新提议时 task id 相同（hard deps 回到旧值），
 * enqueue 只复活 stale，其余状态视为幂等忽略；不标 stale 的话这些章节永远写不了，整本书停摆。
 */
import { and, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { tags as gitTags } from '@novelist/shared';
import { git } from '../book/git.js';
import { openRepo } from '../book/repo.js';
import { books, chapters, inbox, publishSchedule, tasks } from '../db/schema.js';
import { withRepoLock, clearStaleGitLocks } from './committer.js';
import type { ExecEnv } from './executor.js';
import { ACTIVE_STATES, QUEUED_STATES } from './queue.js';

const CARD_RE = /plan\/cards\/c(\d{5})\.yaml$/;

export async function rewindBook(env: ExecEnv, bookId: string, to: number, confirm: boolean): Promise<void> {
  const rows = await env.db.select().from(books).where(eq(books.id, bookId)).limit(1);
  const book = rows[0];
  if (!book) throw new Error(`book not found: ${bookId}`);
  if (!Number.isInteger(to) || to < 0 || to > book.acceptedThrough) throw new Error(`rewind 目标超出范围：${to}（当前已验收到第 ${book.acceptedThrough} 章）`);
  if (to === book.acceptedThrough) return;
  if (book.publishedThrough > to && !confirm) throw new Error('rewind 越过已发布章节，需要二次确认（confirm=true）');
  const active = await env.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, bookId), inArray(tasks.state, ACTIVE_STATES)));
  if (active.length) throw new Error(`有 ${active.length} 个任务正在执行，请先暂停本书并等待结束后再回退`);

  const repo = openRepo(`${env.paths.books}/${book.slug}`);
  const nowIso = new Date().toISOString();
  const { head, cardsThrough, commitIso } = await withRepoLock(env.db, bookId, repo, async () => {
    await clearStaleGitLocks(repo.dir);
    const rev = to === 0 ? `${gitTags.chapter(1)}^` : gitTags.chapter(to);
    const sha = (await git(repo.dir, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])).trim();
    if (!sha) throw new Error(`找不到回退目标 ${rev}`);
    await git(repo.dir, ['reset', '-q', '--hard', sha]);
    await repo.resetHard();
    // 删除目标之后的 ch/ 与 pub/ tag；tag 按提交历史判断是否已不在 HEAD 上
    for (const pattern of ['ch/*', 'pub/*']) {
      for (const t of await repo.tags(pattern)) {
        const n = Number(t.split('/')[1]);
        if (n > to) await git(repo.dir, ['tag', '-d', t]);
      }
    }
    const cards = await repo.list('plan/cards');
    const highest = cards.reduce((max, p) => {
      const m = CARD_RE.exec(p);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    return { head: sha, cardsThrough: highest, commitIso: (await git(repo.dir, ['show', '-s', '--format=%cI', sha])).trim() };
  });

  await env.db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ state: 'stale', attempts: 0, waitReason: 'rewind', leaseOwner: null, leaseExpiresAt: null, updatedAt: nowIso })
      .where(and(eq(tasks.bookId, bookId), or(inArray(tasks.state, [...QUEUED_STATES, 'blocked']), and(inArray(tasks.state, ['done', 'failed', 'cancelled']), gt(tasks.finishedAt, commitIso)))));
    await tx.update(inbox).set({ state: 'dismissed', resolvedAt: nowIso }).where(and(eq(inbox.bookId, bookId), eq(inbox.state, 'open'), inArray(inbox.kind, ['hold', 'block', 'agents_md_edit'])));
    await tx
      .update(chapters)
      // seq 保留：回退后的重写继续递增实例号，不撞上已完成任务的 id（同 chapter.accept 的约定）
      .set({ state: 'planned', workflow: sql`jsonb_build_object('v', 1, 'seq', coalesce((${chapters.workflow}->>'seq')::int, 0))`, cjk: 0, acceptedCommit: null, acceptedAt: null, publishedAt: null, verdict: null, revisions: 0, degraded: false, debts: 0, writerModel: null, updatedAt: nowIso })
      .where(and(eq(chapters.bookId, bookId), gt(chapters.no, to)));
    await tx.delete(chapters).where(and(eq(chapters.bookId, bookId), gt(chapters.no, cardsThrough)));
    await tx.delete(publishSchedule).where(and(eq(publishSchedule.bookId, bookId), gt(publishSchedule.no, to)));
    const sum = await tx.select({ total: sql<number>`coalesce(sum(${chapters.cjk}), 0)` }).from(chapters).where(and(eq(chapters.bookId, bookId), lte(chapters.no, to)));
    const meta = book.meta as { audit?: { window_through?: number; arc_through?: number } };
    const audit = { window_through: Math.min(meta.audit?.window_through ?? 0, to), arc_through: Math.min(meta.audit?.arc_through ?? 0, to) };
    await tx
      .update(books)
      .set({
        acceptedThrough: to,
        cursor: to + 1,
        publishedThrough: Math.min(book.publishedThrough, to),
        auditedThrough: Math.min(book.auditedThrough, to),
        cardsThrough,
        totalCjk: Number(sum[0]?.total ?? 0),
        headCommit: head,
        status: book.status === 'completed' ? 'active' : book.status,
        meta: sql`${books.meta} || ${JSON.stringify({ audit })}::jsonb`,
        updatedAt: nowIso,
      })
      .where(eq(books.id, bookId));
  });
}

