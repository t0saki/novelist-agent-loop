/**
 * 保留期 GC（settings.retention，IMPL §6）：每天一次。
 * run_events 按 ts 清理；原始流（log/stdout.ndjson）按 rawStreamDays 删除，已验收章节的 run 延长到 keepAcceptedRawDays；thinking 事件按 thinkingDays 单独清理。
 * 快照：v3 书里结束 7 天以上、仍留着 $RUN/book 的 run（失败、收稿前崩溃）删快照，被 meta.v3.pending 引用的除外（旧流程的书、没有书的 run 不动）；
 * v3 书 work/<task>/run-<id>/ 收稿目录保留 30 天（pending 引用的不删）；动过的书最后 git worktree prune。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { SystemSettings } from '@novelist/shared';
import { books, chapters, runEvents, runs, tasks } from '../db/schema.js';
import { pruneWorktrees, removeRunSnapshot } from '../book/worktree.js';
import { readV3Meta } from '../flow/state.js';
import type { ExecEnv } from './executor.js';

const DAY_MS = 86_400_000;
const STREAM_FILES = ['stdout.ndjson', 'stderr.log'];
const BATCH = 500;
/** 结束多久后删掉遗留的 run 快照 */
const SNAPSHOT_DAYS = 7;
/** v3 收稿目录（work/<task>/run-<id>/）保留天数 */
const RUN_CHANGES_DAYS = 30;

const cutoff = (now: Date, days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();

export interface GcReport {
  runEvents: number;
  thinking: number;
  rawStreams: number;
  /** 删掉的遗留 run 快照（$RUN/book） */
  snapshots?: number;
  /** 删掉的 v3 收稿目录 */
  runChanges?: number;
}

export async function gcRetention(env: ExecEnv, settings: Pick<SystemSettings, 'retention'>, now: Date): Promise<GcReport> {
  const { runEventsDays, rawStreamDays, keepAcceptedRawDays, thinkingDays } = settings.retention;
  const deleted = await env.db.delete(runEvents).where(lte(runEvents.ts, cutoff(now, runEventsDays))).returning({ runId: runEvents.runId });
  const thinking = await env.db
    .delete(runEvents)
    .where(and(eq(runEvents.t, 'text'), sql`${runEvents.body}->>'channel' = 'thinking'`, lte(runEvents.ts, cutoff(now, thinkingDays))))
    .returning({ runId: runEvents.runId });

  // 原始流：先按短保留期找 run，再把仍在 keepAcceptedRawDays 内的已验收章节 run 排除
  const rawCutoff = cutoff(now, rawStreamDays);
  const acceptedCutoff = cutoff(now, keepAcceptedRawDays);
  let rawStreams = 0;
  // 清理后 run 行还在，分批必须按主键往后翻，否则永远停在最前面一批
  for (let after = ''; ; ) {
    const old = await env.db
      .select({ id: runs.id, runDir: runs.runDir, bookId: runs.bookId, taskKind: runs.taskKind, target: tasks.target, endedAt: runs.endedAt })
      .from(runs)
      .leftJoin(tasks, eq(runs.taskId, tasks.id))
      .where(and(gt(runs.id, after), isNotNull(runs.endedAt), lte(runs.endedAt, rawCutoff), inArray(runs.state, ['exited', 'finalized', 'killed', 'lost'])))
      .orderBy(asc(runs.id))
      .limit(BATCH);
    if (old.length === 0) break;
    after = old[old.length - 1]?.id as string;
    const bookIds = [...new Set(old.map((r) => r.bookId).filter((x): x is string => !!x))];
    const acceptedRows = bookIds.length ? await env.db.select({ bookId: chapters.bookId, chapterId: chapters.chapterId }).from(chapters).where(and(inArray(chapters.bookId, bookIds), isNotNull(chapters.acceptedCommit))) : [];
    const accepted = new Set(acceptedRows.map((a) => `${a.bookId}:${a.chapterId}`));
    for (const r of old) {
      const acceptedRun = !!r.taskKind?.startsWith('chapter.') && accepted.has(`${r.bookId}:${r.target}`);
      if (acceptedRun && r.endedAt && r.endedAt > acceptedCutoff) continue;
      for (const f of STREAM_FILES) {
        const file = path.join(r.runDir, 'log', f);
        const existed = await fs.stat(file).then(() => true, () => false);
        await fs.rm(file, { force: true });
        if (existed) rawStreams += 1;
      }
    }
    if (old.length < BATCH) break;
  }
  const { snapshots, runChanges } = await gcSnapshots(env, now);
  const report = { runEvents: deleted.length, thinking: thinking.length, rawStreams, snapshots, runChanges };
  if (report.runEvents || report.thinking || report.rawStreams || snapshots || runChanges) env.log.info(report, 'retention gc');
  return report;
}

const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false);

/**
 * 快照与 v3 收稿目录（p1-plan §3 retention）。只动 flow: v3 的书：旧流程的书照旧不清 $RUN/book，
 * 没有书的 run（harness.canary 等）的产物就在 $RUN/book/work/… 里、run 详情页还在读，也不碰。
 */
async function gcSnapshots(env: ExecEnv, now: Date): Promise<{ snapshots: number; runChanges: number }> {
  const bookRows = await env.db.select({ id: books.id, slug: books.slug, meta: books.meta }).from(books);
  const v3Books = new Set<string>();
  for (const b of bookRows) {
    try {
      if ((await env.pipe.openBook(env.pdeps, b.id)).config.flow === 'v3') v3Books.add(b.id);
    } catch {
      // 打不开的书：什么都不清
    }
  }
  const pendingRun = new Map(bookRows.map((b) => [b.id, readV3Meta(b.meta).pending?.runId ?? null]));
  const dirOf = new Map(bookRows.map((b) => [b.id, path.join(env.paths.books, b.slug)]));
  const touched = new Set<string>();
  let snapshots = 0;
  const snapCutoff = cutoff(now, SNAPSHOT_DAYS);
  for (let after = ''; ; ) {
    const old = await env.db
      .select({ id: runs.id, runDir: runs.runDir, bookId: runs.bookId, baseCommit: runs.baseCommit })
      .from(runs)
      .where(and(gt(runs.id, after), isNotNull(runs.endedAt), lte(runs.endedAt, snapCutoff), inArray(runs.state, ['exited', 'finalized', 'killed', 'lost'])))
      .orderBy(asc(runs.id))
      .limit(BATCH);
    if (old.length === 0) break;
    after = old[old.length - 1]?.id as string;
    for (const r of old) {
      if (!r.bookId || !v3Books.has(r.bookId)) continue;
      const snap = path.join(r.runDir, 'book');
      if (!(await exists(snap))) continue;
      // pending 指着的快照里有没收的稿
      if (pendingRun.get(r.bookId) === r.id) continue;
      const bookDir = dirOf.get(r.bookId) as string;
      await removeRunSnapshot({ dir: snap, baseCommit: r.baseCommit ?? '', bookDir }).catch(() => {});
      touched.add(bookDir);
      snapshots += 1;
    }
    if (old.length < BATCH) break;
  }

  let runChanges = 0;
  const changesCutoff = now.getTime() - RUN_CHANGES_DAYS * DAY_MS;
  for (const b of bookRows) {
    if (!v3Books.has(b.id)) continue;
    const pending = readV3Meta(b.meta).pending;
    const bookDir = dirOf.get(b.id) as string;
    const work = path.join(bookDir, 'work');
    const taskDirs = await fs.readdir(work, { withFileTypes: true }).catch(() => []);
    for (const t of taskDirs) {
      if (!t.isDirectory()) continue;
      const runDirs = await fs.readdir(path.join(work, t.name), { withFileTypes: true }).catch(() => []);
      for (const r of runDirs) {
        if (!r.isDirectory() || !r.name.startsWith('run-')) continue;
        const abs = path.join(work, t.name, r.name);
        if (pending && (pending.runId === r.name.slice(4) || (pending.manifestFile ?? '').startsWith(`${abs}${path.sep}`))) continue;
        const st = await fs.stat(abs).catch(() => null);
        if (!st || st.mtimeMs > changesCutoff) continue;
        await fs.rm(abs, { recursive: true, force: true });
        runChanges += 1;
      }
    }
    touched.add(bookDir);
  }
  for (const dir of touched) await pruneWorktrees(dir).catch(() => {});
  return { snapshots, runChanges };
}
