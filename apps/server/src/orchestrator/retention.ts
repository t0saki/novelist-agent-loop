/**
 * 保留期 GC（settings.retention，IMPL §6）：每天一次。
 * run_events 按 ts 清理；原始流（log/stdout.ndjson）按 rawStreamDays 删除，已验收章节的 run 延长到 keepAcceptedRawDays；thinking 事件按 thinkingDays 单独清理。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { SystemSettings } from '@novelist/shared';
import { chapters, runEvents, runs, tasks } from '../db/schema.js';
import type { ExecEnv } from './executor.js';

const DAY_MS = 86_400_000;
const STREAM_FILES = ['stdout.ndjson', 'stderr.log'];
const BATCH = 500;

const cutoff = (now: Date, days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();

export interface GcReport {
  runEvents: number;
  thinking: number;
  rawStreams: number;
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
  const report = { runEvents: deleted.length, thinking: thinking.length, rawStreams };
  if (report.runEvents || report.thinking || report.rawStreams) env.log.info(report, 'retention gc');
  return report;
}
