/**
 * RunSession 两向兼容（P3 D22，WP-2）：
 *  (1) 上一版镜像写的 session.json（contract:'v3'、compiled:{nonces,stackHash}、reservationIds、artifacts，没有 stackHash）照样 reattach 并走 v3 收尾；
 *  (2) 旧流程（v2）形状的 session：markRunLost 删它的快照；
 *  (3) 这一版写的 session 带着兼容字段（上一版镜像能 reattach / 收尾 / 判 lost），markRunLost 留着快照（pending 指着它）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { books, runs, tasks } from '../db/schema.js';
import { addV3Book } from '../flow/testing-book.js';
import { bookOpen, bookRetro, bookWrite, nextTasksV3 } from '../flow/handlers.js';
import { readV3Meta } from '../flow/state.js';
import type { BookHandle, TaskRow } from '../runtime/types.js';
import { execEnv, loadSession, markRunLost, sessionStackHash } from './executor.js';
import { recoverOnStartup } from './recovery.js';
import { createScheduler } from './scheduler.js';
import { createOrchTestEnv, type OrchTestEnv, type TestPipelineOptions } from './testing.js';

let t: OrchTestEnv | null = null;
afterEach(async () => {
  if (t) await t.close();
  t = null;
});

const v3Pipeline: TestPipelineOptions = {
  handlers: { 'book.open': bookOpen, 'book.write': bookWrite, 'book.retro': bookRetro },
  next: async (ctx) => {
    const book = ctx.book as BookHandle;
    const row = (await ctx.deps.db.select().from(books).where(eq(books.id, book.id)))[0];
    return row ? nextTasksV3(ctx, book, row) : [];
  },
};

async function fakeScenario(env: OrchTestEnv, slug: string, queue: unknown[]): Promise<void> {
  const dir = path.join(env.paths.tmp, 'fake-v3');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(queue));
}

/** 起一个 v3 run，进程“退出”（executor 分离，shim 继续跑），返回 run 行 */
async function startAndDetach(env: OrchTestEnv, slug: string, sleepMs: number): Promise<{ book: Awaited<ReturnType<typeof addV3Book>>; taskId: string; run: typeof runs.$inferSelect }> {
  const book = await addV3Book(env, slug, { chapters: 2, batch: 2, planned: 12 });
  await fakeScenario(env, slug, [{ sleepMs }]);
  const sched = createScheduler(env.deps);
  await sched.tick();
  await new Promise((r) => setTimeout(r, 600));
  await sched.stop({ drain: false });
  const taskId = (await env.db.select().from(tasks).where(eq(tasks.bookId, book.id)))[0]?.id as string;
  const run = (await env.db.select().from(runs).where(eq(runs.taskId, taskId)))[0] as typeof runs.$inferSelect;
  return { book, taskId, run };
}

describe('RunSession two-way compatibility (D22)', () => {
  it('(3) a session written by this image carries the rollback fields; markRunLost keeps its snapshot', async () => {
    t = await createOrchTestEnv({ pipeline: v3Pipeline });
    const { run } = await startAndDetach(t, 'new-shape', 2500);
    const raw = JSON.parse(await fs.readFile(path.join(run.runDir, 'in', 'session.json'), 'utf8')) as Record<string, unknown> & { spec: Record<string, unknown>; compiled: Record<string, unknown> };
    expect(typeof raw.stackHash).toBe('string');
    expect(raw).toMatchObject({ schema: 'nv.session/1', contract: 'v3', compiled: { nonces: {}, stackHash: raw.stackHash }, reservationIds: [], artifacts: [] });
    expect(raw.spec).toMatchObject({ contract: 'v3', systemFile: path.join(run.runDir, 'in', 'system.md'), receiptSchemaFile: path.join(run.runDir, 'in', 'receipt.schema.json') });
    // 占位路径：文件从不创建
    await expect(fs.stat(raw.spec.systemFile as string)).rejects.toThrow();
    await expect(fs.stat(raw.spec.receiptSchemaFile as string)).rejects.toThrow();
    expect(raw.spec.subagents).toBeUndefined();
    expect(run.stackHash).toBe(raw.stackHash);
    const snapshot = raw.spec.bookDir as string;
    expect((await fs.stat(snapshot)).isDirectory()).toBe(true);
    // 等 shim 结束，再判 lost：快照留着（pending 指着它）
    await new Promise((r) => setTimeout(r, 2500));
    await markRunLost(execEnv(t.deps), run);
    expect((await fs.stat(snapshot)).isDirectory()).toBe(true);
    expect((await t.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.state).toBe('lost');
  }, 60_000);

  it('(1) a session in the previous image shape reattaches (fake shim) and finishes through the v3 path', async () => {
    t = await createOrchTestEnv({ pipeline: v3Pipeline });
    const { book, taskId, run } = await startAndDetach(t, 'old-shape', 2500);
    const file = path.join(run.runDir, 'in', 'session.json');
    const cur = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    // 上一版镜像写的形状：没有顶层 stackHash，指令 hash 只在 compiled 里
    const { stackHash, ...rest } = cur;
    const prev = { ...rest, compiled: { nonces: {}, stackHash: 'prev-image-hash' }, reservationIds: [], artifacts: [], contract: 'v3' };
    expect(stackHash).toBeTruthy();
    await fs.writeFile(file, JSON.stringify(prev));
    expect(sessionStackHash((await loadSession(run.runDir)) as never)).toBe('prev-image-hash');
    await t.db.update(runs).set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(runs.id, run.id));
    await t.db.update(tasks).set({ leaseOwner: 'dead' }).where(eq(tasks.id, taskId));
    const reattached = new Set<Promise<void>>();
    const out = await recoverOnStartup(execEnv({ ...t.deps, owner: 'runner-2' }), reattached);
    expect(out.reattached).toHaveLength(1);
    await Promise.all([...reattached]);
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, taskId)))[0] as TaskRow;
    expect(row.state).toBe('done');
    expect((await t.db.select().from(books).where(eq(books.id, book.id)))[0]?.acceptedThrough).toBe(4);
    expect(readV3Meta((await t.db.select().from(books).where(eq(books.id, book.id)))[0]?.meta).pending).toBeNull();
    const last = (await book.repo.log({ limit: 1 })).items[0];
    expect(last?.trailers['Novelist-Instructions']).toBe('prev-image-hash');
  }, 120_000);

  it('(2) an old v2-shaped session (no contract): markRunLost removes its snapshot', async () => {
    t = await createOrchTestEnv({ pipeline: v3Pipeline });
    const book = await addV3Book(t, 'v2-shape', { chapters: 1 });
    const runDir = path.join(t.paths.runs, '2026-11', 'v2run');
    const snapshot = path.join(runDir, 'book');
    await fs.mkdir(path.join(runDir, 'in'), { recursive: true });
    await fs.mkdir(snapshot, { recursive: true });
    await fs.writeFile(path.join(runDir, 'in', 'session.json'), JSON.stringify({ schema: 'nv.session/1', spec: { bookDir: snapshot }, runCtx: { baseCommit: book.head }, reservationIds: [], utilBefore: {}, compiled: { nonces: { L3: { head: 'h', tail: 't' } }, stackHash: 'x' }, artifacts: [] }));
    await t.db.insert(tasks).values({ id: 'v2t', bookId: book.id, kind: 'book.write', target: 'b', lane: 'write', state: 'running' });
    await t.db.insert(runs).values({ id: 'v2run', taskId: 'v2t', bookId: book.id, taskKind: 'chapter.write', attempt: 1, role: 'writer', profileId: 'fake', harness: 'fake', isolation: 'container', state: 'running', runDir });
    const row = (await t.db.select().from(runs).where(eq(runs.id, 'v2run')))[0] as typeof runs.$inferSelect;
    await markRunLost(execEnv(t.deps), row);
    await expect(fs.stat(snapshot)).rejects.toThrow();
  }, 60_000);
});
