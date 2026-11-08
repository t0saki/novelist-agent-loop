/**
 * serve 崩溃恢复（DESIGN §7.7、§2.3）。Owner: lane F。
 * runs/active 下的 run：shim 活着 → reattach；否则 run 标 lost，任务回 ready（attempt 不加）。
 * 书库：finalizing 的任务 → recoverBook（按 Novelist-Task trailer 判定已提交/未提交）。
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { books, runs, tasks } from '../db/schema.js';
import { openRepo } from '../book/repo.js';
import { clearStaleGitLocks, recoverBook, withRepoLock } from './committer.js';
import { markRunLost, reattach, ACTIVE_RUN_STATES, type ExecEnv } from './executor.js';

/** 把 lease 已过期的 run 接管或判 lost；也用于启动时（lease 一定过期或属于上个进程） */
export async function reconcileRuns(env: ExecEnv, reattached: Set<Promise<void>>, opts?: { all?: boolean; excludeTasks?: string[] }): Promise<{ reattached: string[]; lost: string[] }> {
  const nowIso = env.nowFn().toISOString();
  const rows = await env.db
    .select()
    .from(runs)
    .where(and(inArray(runs.state, ACTIVE_RUN_STATES), opts?.all ? sql`${runs.leaseOwner} is distinct from ${env.owner}` : lte(runs.leaseExpiresAt, nowIso)));
  const result = { reattached: [] as string[], lost: [] as string[] };
  for (const row of rows) {
    if (opts?.excludeTasks?.includes(row.taskId)) continue;
    if (row.state === 'preparing') {
      await markRunLost(env, row);
      result.lost.push(row.id);
      continue;
    }
    const r = await reattach(env, row);
    if (r) {
      result.reattached.push(row.id);
      const p = r.finished.finally(() => reattached.delete(p));
      reattached.add(p);
    } else {
      await markRunLost(env, row);
      result.lost.push(row.id);
    }
  }
  return result;
}

/** 启动：接管 run + 恢复各书中断的 promote */
export async function recoverOnStartup(env: ExecEnv, reattached: Set<Promise<void>>): Promise<{ reattached: string[]; lost: string[]; replayed: string[]; resetBooks: string[] }> {
  const runsRes = await reconcileRuns(env, reattached, { all: true });
  const { replayed, resetBooks } = await recoverStuckPromotes(env, { foreignOwner: true });
  await sweepDirtyBooks(env);
  return { ...runsRes, replayed, resetBooks };
}

/** 启动时：所有书清理崩溃残留的 git 锁和半途写入（commitOwnerEdit 崩溃不会留下 finalizing 任务，recoverBook 覆盖不到） */
async function sweepDirtyBooks(env: ExecEnv): Promise<void> {
  const rows = await env.db.select({ id: books.id, slug: books.slug }).from(books);
  for (const b of rows) {
    const repo = openRepo(`${env.paths.books}/${b.slug}`);
    try {
      await withRepoLock(env.db, b.id, repo, async () => {
        await clearStaleGitLocks(repo.dir);
        if (!(await repo.isClean())) {
          env.log.warn({ bookId: b.id }, 'book repo dirty at startup, resetting');
          await repo.resetHard();
        }
      });
    } catch (err) {
      env.log.warn({ err: (err as Error).message, bookId: b.id }, 'startup repo sweep failed');
    }
  }
}

/** 恢复 finalizing 且 lease 已过期（或属于别的进程，启动时）的任务 */
export async function recoverStuckPromotes(env: ExecEnv, opts: { foreignOwner?: boolean; excludeTasks?: string[] } = {}): Promise<{ replayed: string[]; resetBooks: string[] }> {
  const now = env.nowFn().getTime();
  const rows = await env.db.select({ id: tasks.id, bookId: tasks.bookId, owner: tasks.leaseOwner, expires: tasks.leaseExpiresAt }).from(tasks).where(eq(tasks.state, 'finalizing'));
  const byBook = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.bookId || opts.excludeTasks?.includes(r.id)) continue;
    const expired = !r.expires || new Date(r.expires).getTime() <= now;
    const foreign = opts.foreignOwner === true && r.owner !== env.owner;
    if (!expired && !foreign) continue;
    byBook.set(r.bookId, [...(byBook.get(r.bookId) ?? []), r.id]);
  }
  const replayed: string[] = [];
  const resetBooks: string[] = [];
  for (const [bookId, ids] of byBook) {
    const bookRows = await env.db.select({ slug: books.slug }).from(books).where(eq(books.id, bookId)).limit(1);
    if (!bookRows[0]) continue;
    try {
      const out = await recoverBook(env.db, openRepo(`${env.paths.books}/${bookRows[0].slug}`), bookId, { taskIds: ids });
      replayed.push(...out.replayed);
      if (out.reset) resetBooks.push(bookId);
    } catch (err) {
      env.log.error({ err: (err as Error).message, bookId }, 'recoverBook failed');
    }
  }
  return { replayed, resetBooks };
}
