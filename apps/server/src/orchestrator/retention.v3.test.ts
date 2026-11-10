import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { books, runs } from '../db/schema.js';
import { git } from '../book/git.js';
import { createRunSnapshot } from '../book/worktree.js';
import { emptyV3Meta } from '../flow/state.js';
import { addV3Book } from '../flow/testing-book.js';
import type { V3Pending } from '../flow/types.js';
import { execEnv } from './executor.js';
import { gcRetention } from './retention.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv();
});
afterEach(async () => {
  await t.close();
});

const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const RETENTION = { retention: { runEventsDays: 30, rawStreamDays: 30, keepAcceptedRawDays: 365, thinkingDays: 3 } };
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

const pending = (runId: string, runDir: string, manifestFile: string | null = null): V3Pending => ({
  taskId: 'tk',
  runId,
  attempt: 1,
  stage: manifestFile ? 'harvested' : 'run',
  runDir,
  inDir: path.join(runDir, 'in'),
  snapshotDir: path.join(runDir, 'book'),
  baseCommit: 'x',
  manifestFile,
  trailerKey: `tk@${runId}`,
  route: { profile: 'p', account: null, harness: 'fake', model: null, isolation: 'none', stackHash: 'h' },
  failures: 0,
  createdAt: daysAgo(10).toISOString(),
});

/** 一个结束于 endedDaysAgo 天前、$RUN/book 还在的 run */
async function oldRun(b: { id: string; dir: string; head: string }, runId: string, endedDaysAgo: number): Promise<string> {
  const runDir = path.join(t.paths.runs, '2026-01', runId);
  await createRunSnapshot(b.dir, b.head, path.join(runDir, 'book'));
  await t.db.insert(runs).values({ id: runId, taskId: 'tk', bookId: b.id, taskKind: 'book.write', attempt: 1, role: 'writer', profileId: 'p', harness: 'fake', isolation: 'none', state: 'finalized', endedAt: daysAgo(endedDaysAgo).toISOString(), runDir, baseCommit: b.head });
  return runDir;
}

const worktrees = async (dir: string) => (await git(dir, ['worktree', 'list', '--porcelain'])).split('\n').filter((l) => l.startsWith('worktree ')).length;

describe('retention: v3 snapshots and run changes', () => {
  it('snapshot older than 7 days removed and worktree pruned', async () => {
    const b = await addV3Book(t, 'r1', { chapters: 2 });
    const oldDir = await oldRun(b, 'run-old', 8);
    const newDir = await oldRun(b, 'run-new', 2);
    expect(await worktrees(b.dir)).toBe(3);
    // 登记还在、目录已被手工删掉的 worktree 也会被 prune
    const gone = path.join(t.paths.runs, 'gone', 'book');
    await createRunSnapshot(b.dir, b.head, gone);
    await fs.rm(gone, { recursive: true, force: true });
    const report = await gcRetention(execEnv(t.deps), RETENTION, NOW);
    expect(report.snapshots).toBe(1);
    expect(await exists(path.join(oldDir, 'book'))).toBe(false);
    expect(await exists(path.join(newDir, 'book'))).toBe(true);
    expect(await worktrees(b.dir)).toBe(2);
  });

  it('book-less runs (canary output lives in $RUN/book) and v2 book runs keep $RUN/book', async () => {
    const canaryDir = path.join(t.paths.runs, '2026-01', 'run-canary');
    const out = path.join(canaryDir, 'book', 'work', 'tk', 'attempt-1', 'out', 'canary.md');
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, 'ok\n');
    await t.db.insert(runs).values({ id: 'run-canary', taskId: 'tk', bookId: null, taskKind: 'harness.canary', attempt: 1, role: 'writer', profileId: 'p', harness: 'fake', isolation: 'none', state: 'finalized', endedAt: daysAgo(20).toISOString(), runDir: canaryDir });
    const v2 = await addV3Book(t, 'r5', { chapters: 1 });
    await fs.writeFile(path.join(v2.dir, 'book.yaml'), (await fs.readFile(path.join(v2.dir, 'book.yaml'), 'utf8')).replace('flow: v3', 'flow: v2'));
    const v2Run = await oldRun(v2, 'run-v2', 20);
    const report = await gcRetention(execEnv(t.deps), RETENTION, NOW);
    expect(report.snapshots).toBe(0);
    expect(await exists(out)).toBe(true);
    expect(await exists(path.join(v2Run, 'book', 'manuscript', 'c00001.md'))).toBe(true);
  });

  it('snapshot referenced by pending kept', async () => {
    const b = await addV3Book(t, 'r2', { chapters: 2 });
    const runDir = await oldRun(b, 'run-pending', 9);
    await t.db.update(books).set({ meta: { v3: { ...emptyV3Meta(), pending: pending('run-pending', runDir) } } }).where(eq(books.id, b.id));
    const report = await gcRetention(execEnv(t.deps), RETENTION, NOW);
    expect(report.snapshots).toBe(0);
    expect(await exists(path.join(runDir, 'book', 'manuscript', 'c00001.md'))).toBe(true);
  });

  it('work/*/run-*/ older than 30 days removed unless pending', async () => {
    const b = await addV3Book(t, 'r3', { chapters: 1 });
    const mk = async (rel: string, d: number) => {
      const abs = path.join(b.dir, 'work', rel);
      await fs.mkdir(path.join(abs, 'changes'), { recursive: true });
      await fs.writeFile(path.join(abs, 'changes.json'), '{}');
      const when = daysAgo(d);
      await fs.utimes(abs, when, when);
      return abs;
    };
    const stale = await mk('tk-a/run-aaa', 40);
    const fresh = await mk('tk-a/run-bbb', 5);
    const kept = await mk('tk-b/run-ccc', 45);
    const attempt = path.join(b.dir, 'work', 'tk-a', 'attempt-1');
    await fs.mkdir(attempt, { recursive: true });
    await fs.utimes(attempt, daysAgo(60), daysAgo(60));
    await t.db.update(books).set({ meta: { v3: { ...emptyV3Meta(), pending: pending('ccc', '/r', path.join(kept, 'changes.json')) } } }).where(eq(books.id, b.id));
    const report = await gcRetention(execEnv(t.deps), RETENTION, NOW);
    expect(report.runChanges).toBe(1);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(kept)).toBe(true);
    // 只动 run-*/：旧流程的 attempt 目录不归这一步管
    expect(await exists(attempt)).toBe(true);
  });

  it('v2 books: work/ untouched', async () => {
    const b = await addV3Book(t, 'r4', { chapters: 1 });
    const yaml = (await fs.readFile(path.join(b.dir, 'book.yaml'), 'utf8')).replace('flow: v3', 'flow: v2');
    await fs.writeFile(path.join(b.dir, 'book.yaml'), yaml);
    const abs = path.join(b.dir, 'work', 'tk', 'run-old');
    await fs.mkdir(abs, { recursive: true });
    await fs.utimes(abs, daysAgo(90), daysAgo(90));
    const report = await gcRetention(execEnv(t.deps), RETENTION, NOW);
    expect(report.runChanges).toBe(0);
    expect(await exists(abs)).toBe(true);
  });
});
