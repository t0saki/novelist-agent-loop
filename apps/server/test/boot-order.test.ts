/**
 * 开机顺序（P3 §5 / §7 WP-1）：真实的 startServe（bootstrap 带 bootMigrate + orchestrator.start）跑在 PGlite 目录上。
 * 上一个进程留下：旧书的 chapter.extract 任务在跑，它的 fake shim 还活着（旧形状的 session.json，没有 contract）；一本 v3 书在写。
 * 期望：开机迁移先把旧任务取消（p3_legacy）、写 kill 文件；恢复时 reattach 看到取消了的旧任务 → 杀掉 shim，run 记 lost，任务保持 cancelled；
 * v3 书照常被调度、写完一批。
 */
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createLegacyBook } from '../src/book/testing-legacy.js';
import { loadConfig } from '../src/config/index.js';
import { books, runs, tasks } from '../src/db/schema.js';
import { addV3Book } from '../src/flow/testing-book.js';
import { startRun } from '../src/harness/runner.js';
import { makeRunFixture } from '../src/harness/testing.js';
import { logFiles } from '../src/harness/runner.js';
import { silentLogger } from '../src/log.js';
import { bootstrap, shutdownDeps, startServe, type RunningApp } from '../src/main.js';
import type { OrchTestEnv } from '../src/orchestrator/testing.js';

let running: RunningApp | null = null;
let dataDir = '';
let shimPid = 0;

afterEach(async () => {
  await running?.close();
  running = null;
  if (shimPid) {
    try {
      process.kill(shimPid, 'SIGKILL');
    } catch {
      // 已经退出
    }
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return cond();
}

describe('boot order: migration before recovery', () => {
  it('a running legacy task is cancelled and its live shim killed (run lost, task stays cancelled); the v3 book is claimed and finishes a batch', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-boot-'));
    const config = loadConfig({
      NOVELIST_DATA_DIR: dataDir,
      NOVELIST_DATABASE_URL: `pglite:${path.join(dataDir, 'pg')}`,
      NOVELIST_ROLES: 'orchestrator,runner',
      NOVELIST_ADMIN_PASSWORD: 'test-admin-password',
      NOVELIST_LOG_LEVEL: 'silent',
      NOVELIST_FAKE_HARNESS: '1',
      NOVELIST_ISOLATION: 'container',
      NOVELIST_SCHEDULER_TICK_MS: '200',
    } as NodeJS.ProcessEnv);

    // ── 上一个进程 ──
    const before = await bootstrap(config, { log: silentLogger });
    const legacy = await createLegacyBook(before.db, before.paths, 'old', { status: 'active', pausedReason: null });
    const v3 = await addV3Book({ db: before.db, paths: before.paths } as unknown as OrchTestEnv, 'new', { chapters: 1, batch: 2, planned: 12 });
    const f = await makeRunFixture({ dataRoot: dataDir, kind: 'chapter.extract', role: 'extractor', bookSlug: 'old', fake: { sleepMs: 60_000 } });
    const handle = await startRun(f.prepared, { onEvent: () => undefined, onActivity: () => undefined });
    shimPid = handle.shimPid;
    // 旧镜像写的 session.json：没有 contract（v2 的形状）
    writeFileSync(
      path.join(f.spec.inDir, 'session.json'),
      JSON.stringify({ schema: 'nv.session/1', spec: f.spec, runCtx: { runId: f.spec.runId, attempt: 1, runDir: f.spec.runDir, snapshotDir: f.spec.bookDir, outDir: f.spec.outDir, inDir: f.spec.inDir, baseCommit: 'x', profileId: 'fake', accountId: null, harness: 'fake', model: 'fake', role: 'extractor', degraded: [] }, reservationIds: [], utilBefore: {}, harnessVersion: f.prepared.install.version, isolation: 'container', compiled: { nonces: {}, stackHash: 'old' }, artifacts: [], billUsd: false, accountEnvNames: [] }),
    );
    await before.db.insert(tasks).values({ id: 'old-ext', bookId: legacy.id, kind: 'chapter.extract', target: 'c00002', lane: 'side', role: 'extractor', state: 'running', leaseOwner: 'previous-process', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    await before.db.insert(runs).values({ id: f.spec.runId, taskId: 'old-ext', bookId: legacy.id, taskKind: 'chapter.extract', attempt: 1, role: 'extractor', profileId: 'fake', harness: 'fake', harnessVersion: f.prepared.install.version, isolation: 'container', state: 'running', runDir: f.spec.runDir, shimPid: handle.shimPid, leaseOwner: 'previous-process', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    await fs.mkdir(before.paths.runsActive, { recursive: true });
    await fs.symlink(path.relative(before.paths.runsActive, f.spec.runDir), path.join(before.paths.runsActive, f.spec.runId)).catch(() => undefined);
    expect(alive(shimPid)).toBe(true);
    await shutdownDeps(before);

    // ── 新镜像开机 ──
    running = await startServe(config);
    const db = running.deps.db;
    const oldTask = (await db.select().from(tasks).where(eq(tasks.id, 'old-ext')))[0];
    expect(oldTask).toMatchObject({ state: 'cancelled', waitReason: 'p3_legacy' });
    expect((oldTask?.params._orch as { recover?: unknown } | undefined)?.recover).toBeUndefined();
    expect(await fs.readFile(logFiles(f.spec.logDir).kill, 'utf8')).toBe('user');
    expect((await db.select().from(runs).where(eq(runs.id, f.spec.runId)))[0]?.state).toBe('lost');
    expect(await until(async () => !alive(shimPid), 15_000)).toBe(true);
    shimPid = 0;

    // v3 书照常写：book.write 被认领并完成，章节入库
    const done = await until(async () => (await db.select().from(tasks).where(and(eq(tasks.bookId, v3.id), eq(tasks.kind, 'book.write'), eq(tasks.state, 'done')))).length > 0, 90_000);
    expect(done).toBe(true);
    expect((await db.select().from(books).where(eq(books.id, v3.id)))[0]?.acceptedThrough).toBeGreaterThanOrEqual(3);
    expect((await db.select().from(tasks).where(eq(tasks.id, 'old-ext')))[0]?.state).toBe('cancelled');
    expect(await db.select().from(tasks).where(eq(tasks.bookId, legacy.id))).toHaveLength(1);
  }, 150_000);
});
