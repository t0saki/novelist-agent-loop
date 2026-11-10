/**
 * 调度集成测试（v3 书）：PGlite + 真实 fake harness（目录模式，经 nv-shim）+ 测试用 pipeline。
 * 覆盖：serve 崩溃后接管在跑的 shim、shim 死掉判 lost、多本书在全局并发内并行、门面的暂停 / 重试 / 取消 / 全局暂停、保留期 GC。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { books, chapters, runEvents, runs, tasks } from '../db/schema.js';
import { addV3Book } from '../flow/testing-book.js';
import { bookRetro, bookWrite, bookOpen, nextTasksV3 } from '../flow/handlers.js';
import type { BookHandle, Manifest, PipelineContext, TaskHandler, TaskRow, TaskSpec } from '../runtime/types.js';
import { createOrchestrator } from './index.js';
import { createScheduler } from './scheduler.js';
import { gcRetention } from './retention.js';
import { execEnv } from './executor.js';
import { recoverOnStartup } from './recovery.js';
import { createOrchTestEnv, type OrchTestEnv, type TestPipelineOptions } from './testing.js';

let t: OrchTestEnv | null = null;
afterEach(async () => {
  if (t) await t.close();
  t = null;
});

const task = (db: OrchTestEnv['db'], id: string) => db.select().from(tasks).where(eq(tasks.id, id)).then((r) => r[0] as TaskRow);
const manifest: Manifest = { hard: {}, soft: {}, configHash: '' };

/** 真实的 v3 handler 和下一步（与 flow/handlers.test.ts 相同） */
const v3Pipeline: TestPipelineOptions = {
  handlers: { 'book.open': bookOpen, 'book.write': bookWrite, 'book.retro': bookRetro },
  next: async (ctx) => {
    const book = ctx.book as BookHandle;
    const row = (await ctx.deps.db.select().from(books).where(eq(books.id, book.id)))[0];
    return row ? nextTasksV3(ctx, book, row) : [];
  },
};

/** fake harness 的场景队列（每次 run 取队首，见 flow/handlers.ts popFakeScenario） */
async function fakeScenario(env: OrchTestEnv, slug: string, queue: unknown[]): Promise<void> {
  const dir = path.join(env.paths.tmp, 'fake-v3');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(queue));
}

/** 确定性的 book.write（不跑模型）：每本书一次只提议一个，写够 n 个为止 */
function deterministicWrites(n: number, execute: TaskHandler['execute']): TestPipelineOptions {
  const handler: TaskHandler = { kind: 'book.write', role: null, lane: 'write', maxAttempts: 3, manifest: async (_c, s) => ({ ...manifest, configHash: String(s.target) }), execute };
  return {
    handlers: { 'book.write': handler },
    next: async (ctx: PipelineContext): Promise<TaskSpec[]> => {
      const bookId = (ctx.book as BookHandle).id;
      const rows = await ctx.deps.db.select({ state: tasks.state }).from(tasks).where(eq(tasks.bookId, bookId));
      if (rows.some((r) => !['done', 'failed', 'cancelled', 'stale'].includes(r.state))) return [];
      if (rows.length >= n) return [];
      return [{ kind: 'book.write', bookId, target: `w-${rows.length + 1}`, lane: 'write' }];
    },
  };
}

describe('scheduler + fake harness (v3 books)', () => {
  it('serve crash during run: reattaches live shim and completes without re-running', async () => {
    t = await createOrchTestEnv({ pipeline: v3Pipeline });
    const book = await addV3Book(t, 'reattach', { chapters: 2, batch: 2, planned: 12 });
    await fakeScenario(t, 'reattach', [{ sleepMs: 2500 }]);
    const sched = createScheduler(t.deps);
    await sched.tick();
    await new Promise((r) => setTimeout(r, 600));
    expect(sched.inFlight()).toHaveLength(1);
    // stop 不 drain：executor 分离，shim 继续跑（模拟进程退出）
    await sched.stop({ drain: false });
    const taskId = (await t.db.select().from(tasks).where(eq(tasks.bookId, book.id)))[0]?.id as string;
    await t.db.update(runs).set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(runs.taskId, taskId));
    await t.db.update(tasks).set({ leaseOwner: 'dead' }).where(eq(tasks.bookId, book.id));

    const reattached = new Set<Promise<void>>();
    const out = await recoverOnStartup(execEnv({ ...t.deps, owner: 'runner-2' }), reattached);
    expect(out.reattached).toHaveLength(1);
    expect(out.lost).toEqual([]);
    await Promise.all([...reattached]);
    const row = await task(t.db, taskId);
    expect(row.kind).toBe('book.write');
    expect(row.state).toBe('done');
    expect(row.attempts).toBe(0);
    expect(await t.db.select().from(runs).where(eq(runs.state, 'finalized'))).toHaveLength(1);
    expect(await t.db.select().from(runs)).toHaveLength(1);
    expect(await book.repo.exists('manuscript/c00003.md')).toBe(true);
    expect((await t.db.select().from(books).where(eq(books.id, book.id)))[0]?.acceptedThrough).toBe(4);
  }, 120_000);

  it('dead shim → run lost, task back to ready, attempt not charged', async () => {
    t = await createOrchTestEnv({ pipeline: v3Pipeline });
    const book = await addV3Book(t, 'lost', { chapters: 2 });
    await t.db.insert(tasks).values({ id: 'tk-lost', bookId: book.id, kind: 'book.write', target: 'book', lane: 'write', role: 'writer', state: 'running', leaseOwner: 'dead', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const runDir = path.join(t.paths.runs, '2026-11', 'gone');
    await fs.mkdir(path.join(runDir, 'in'), { recursive: true });
    await t.db.insert(runs).values({ id: 'gone', taskId: 'tk-lost', bookId: book.id, taskKind: 'book.write', attempt: 1, role: 'writer', profileId: 'fake', harness: 'fake', isolation: 'container', state: 'running', runDir, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const out = await recoverOnStartup(execEnv(t.deps), new Set());
    expect(out.lost).toEqual(['gone']);
    const row = await task(t.db, 'tk-lost');
    expect(row.state).toBe('ready');
    expect(row.attempts).toBe(0);
    expect((await t.db.select().from(runs).where(eq(runs.id, 'gone')))[0]?.state).toBe('lost');
  }, 60_000);

  it('multi-book parallelism: books write concurrently within the global limit', async () => {
    let active = 0;
    let peak = 0;
    t = await createOrchTestEnv({
      pipeline: deterministicWrites(2, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 40));
        active -= 1;
        return { status: 'done' };
      }),
    });
    for (const slug of ['a1', 'a2', 'a3']) await addV3Book(t, slug, { chapters: 1 });
    const sched = createScheduler(t.deps, { maxConcurrent: 2 });
    await sched.runUntilIdle({ maxTicks: 100 });
    expect(peak).toBe(2);
    for (const slug of ['a1', 'a2', 'a3']) {
      const id = `book-${slug}`;
      const rows = (await t.db.select().from(tasks).where(eq(tasks.bookId, id))) as TaskRow[];
      expect(rows.map((r) => r.state)).toEqual(['done', 'done']);
    }
  }, 90_000);
});

describe('orchestrator facade', () => {
  it('pause/resume, retry/cancel, status snapshot, global pause stops dispatch', async () => {
    t = await createOrchTestEnv({ pipeline: deterministicWrites(1, async () => ({ status: 'failed', errorClass: 'unknown', message: 'x' })) });
    const book = await addV3Book(t, 'facade', { chapters: 1 });
    const orch = createOrchestrator(t.deps);
    await orch.bookAction(book.id, { action: 'pause' });
    expect((await t.db.select().from(books).where(eq(books.id, book.id)))[0]?.status).toBe('paused');
    await orch.runUntilIdle({ maxTicks: 20 });
    expect(await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))).toEqual([]);
    await orch.bookAction(book.id, { action: 'resume' });

    await orch.pauseAll();
    await orch.runUntilIdle({ maxTicks: 20 });
    let status = await orch.status();
    expect(status.paused).toBe(true);
    expect(status.queue.ready ?? 0).toBe(0);
    await orch.resumeAll();

    await orch.runUntilIdle({ maxTicks: 20 });
    const id = ((await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[])[0]?.id as string;
    expect((await task(t.db, id)).state).toBe('failed');
    await orch.retryTask(id);
    expect((await task(t.db, id)).state).toBe('ready');
    await orch.cancelTask(id);
    expect((await task(t.db, id)).state).toBe('cancelled');
    status = await orch.status();
    expect(status.queue.cancelled).toBe(1);
  }, 60_000);

  it('tick never proposes for a legacy book, even one left in status active', async () => {
    const proposed: string[] = [];
    t = await createOrchTestEnv({
      pipeline: {
        handlers: {},
        next: (ctx) => {
          proposed.push((ctx.book as BookHandle).id);
          return [];
        },
      },
    });
    const { createLegacyBook } = await import('../book/testing-legacy.js');
    const legacy = await createLegacyBook(t.db, t.paths, 'old-active', { status: 'active', pausedReason: null });
    const v3 = await addV3Book(t, 'new', { chapters: 1 });
    const sched = createScheduler(t.deps);
    await sched.tick();
    await sched.stop();
    expect(proposed).toEqual([v3.id]);
    expect(proposed).not.toContain(legacy.id);
  });
});

describe('保留期 GC', () => {
  const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  async function addRun(env: OrchTestEnv, id: string, opts: { book?: string; task?: string; kind?: string; files?: boolean } = {}): Promise<string> {
    const runDir = path.join(env.paths.runs, id);
    if (opts.files !== false) {
      await fs.mkdir(path.join(runDir, 'log'), { recursive: true });
      await fs.writeFile(path.join(runDir, 'log', 'stdout.ndjson'), 'x');
    }
    await env.db.insert(runs).values({ id, taskId: opts.task ?? 'none', bookId: opts.book ?? null, taskKind: opts.kind ?? 'book.write', attempt: 1, role: 'writer', profileId: 'p', harness: 'fake', isolation: 'none', state: 'finalized', endedAt: old(40), runDir });
    return path.join(runDir, 'log', 'stdout.ndjson');
  }
  const exists = (f: string) => fs.stat(f).then(() => true, () => false);

  it('由 scheduler tick 触发：清过期事件和原始流，已验收章节的 run 保留、未验收的不保留', async () => {
    t = await createOrchTestEnv();
    const book = await addV3Book(t, 'gc');
    await t.db.insert(chapters).values({ bookId: book.id, no: 1, chapterId: 'c00001', state: 'accepted', acceptedCommit: 'abc' });
    // 旧行（已删除的任务种类）照样参与 GC：kind 只是字符串
    await t.db.insert(tasks).values([
      { id: 'ta', bookId: book.id, kind: 'chapter.write', target: 'c00001', lane: 'write', state: 'done' },
      { id: 'tb', bookId: book.id, kind: 'chapter.write', target: 'c00002', lane: 'write', state: 'done' },
    ]);
    const accepted = await addRun(t, 'ra', { book: book.id, task: 'ta', kind: 'chapter.write' });
    const unaccepted = await addRun(t, 'rb', { book: book.id, task: 'tb', kind: 'chapter.write' });
    await t.db.insert(runEvents).values([
      { runId: 'ra', seq: 1, ts: old(40), t: 'text', body: { channel: 'assistant', delta: 'x' } },
      { runId: 'ra', seq: 2, ts: old(1), t: 'text', body: { channel: 'assistant', delta: 'x' } },
    ]);

    const s = createScheduler(t.deps);
    await s.tick();
    await s.stop();

    expect((await t.db.select().from(runEvents)).map((e) => e.seq)).toEqual([2]);
    expect(await exists(accepted)).toBe(true);
    expect(await exists(unaccepted)).toBe(false);
    // 旧任务没有被复活或重新派发
    expect((await t.db.select({ state: tasks.state }).from(tasks).where(and(eq(tasks.bookId, book.id), inArray(tasks.id, ['ta', 'tb'])))).map((r) => r.state)).toEqual(['done', 'done']);
  });

  it('按主键分批：第一批之后的 run 也会清理；thinking 单独按天数清理', async () => {
    t = await createOrchTestEnv();
    await t.db.insert(runs).values(Array.from({ length: 500 }, (_, i) => ({ id: `a${String(i).padStart(4, '0')}`, taskId: 'none', taskKind: 'plan.arc', attempt: 1, role: 'writer', profileId: 'p', harness: 'fake', isolation: 'none', state: 'finalized', endedAt: old(40), runDir: path.join(t!.paths.runs, 'missing') })));
    const last = await addRun(t, 'z-last');
    await t.db.insert(runEvents).values([
      { runId: 'z-last', seq: 1, ts: old(5), t: 'text', body: { channel: 'thinking', delta: 'x' } },
      { runId: 'z-last', seq: 2, ts: old(5), t: 'text', body: { channel: 'assistant', delta: 'x' } },
    ]);
    const report = await gcRetention(execEnv(t.deps), { retention: { runEventsDays: 30, rawStreamDays: 30, keepAcceptedRawDays: 365, thinkingDays: 3 } }, new Date());
    expect(report.rawStreams).toBe(1);
    expect(await exists(last)).toBe(false);
    expect((await t.db.select().from(runEvents)).map((e) => e.seq)).toEqual([2]);
  });
});
