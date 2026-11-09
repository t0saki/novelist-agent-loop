/**
 * 调度集成测试：PGlite + 真实 fake harness（经 nv-shim）+ 假 pipeline。
 * 覆盖：逐章写作、崩溃恢复（promote 中断、serve 崩溃 reattach、lost）、配额等待、换 profile、写作/规划并发不活锁。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { chapterId, type TaskKind } from '@novelist/shared';
import { TRAILER } from '../book/trailers.js';
import { accounts, accountsState, books, chapters, inbox, runEvents, runs, settings, tasks, usageLedger } from '../db/schema.js';
import type { Manifest, PromotePlan, TaskHandler, TaskRow, TaskSpec } from '../pipeline/types.js';
import type { BookRuntimeState } from '../pipeline/next.js';
import { createOrchestrator } from './index.js';
import { bookRuntimeState, createScheduler } from './scheduler.js';
import { gcRetention } from './retention.js';
import { execEnv } from './executor.js';
import { recoverOnStartup } from './recovery.js';
import { addFixtureBook, agentChapterHandler, createOrchTestEnv, fileHandler, type FakePipelineOptions, type OrchTestEnv } from './testing.js';

let t: OrchTestEnv | null = null;
afterEach(async () => {
  if (t) await t.close();
  t = null;
});

const task = (db: OrchTestEnv['db'], id: string) => db.select().from(tasks).where(eq(tasks.id, id)).then((r) => r[0] as TaskRow);

/** next：按 cursor 逐章提议 chapter.write，直到 target 章；write lane 有在跑的就不提 */
function writeLane(target: number, extra?: (no: number) => Partial<TaskSpec>): FakePipelineOptions['next'] {
  return (ctx, state) => {
    if (state.acceptedThrough >= target) return [];
    if (state.active.some((a) => a.lane === 'write')) return [];
    const no = state.acceptedThrough + 1;
    return [{ kind: 'chapter.write', bookId: ctx.book?.id ?? null, target: chapterId(no), lane: 'write', ...(extra?.(no) ?? {}) }];
  };
}

function acceptEffect(task: TaskRow, bookId: string): PromotePlan['dbEffects'] {
  const no = Number(task.target.replace(/\D/g, ''));
  return async (tx, sha) => {
    await tx.update(books).set({ acceptedThrough: no, cursor: no + 1, headCommit: sha }).where(eq(books.id, bookId));
    await tx
      .insert(chapters)
      .values({ bookId, no, chapterId: chapterId(no), state: 'accepted', acceptedCommit: sha, acceptedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: { state: 'accepted', acceptedCommit: sha, acceptedAt: new Date().toISOString() } });
  };
}

function chapterAgent(opts: Parameters<typeof agentChapterHandler>[0] = {}): TaskHandler {
  return agentChapterHandler({ dbEffects: (task) => acceptEffect(task, task.bookId as string), ...opts });
}

describe('scheduler + fake harness', () => {
  it('writes chapters one at a time: commits with trailers, updates frontiers, settles runs', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': chapterAgent() }, next: writeLane(3) } });
    const book = await addFixtureBook(t, 'demo', { cards: 6 });
    const events: string[] = [];
    t.bus.subscribe((e) => {
      if (e.type === 'chapter_accepted') events.push(`accepted:${e.no}`);
    });
    const sched = createScheduler(t.deps, { maxConcurrent: 4 });
    await sched.runUntilIdle({ maxTicks: 200 });

    const row = (await t.db.select().from(books).where(eq(books.id, book.id)))[0];
    expect(row?.acceptedThrough).toBe(3);
    expect(row?.headCommit).toBe(await book.repo.head());
    for (const no of [1, 2, 3]) expect(await book.repo.exists(`manuscript/${chapterId(no)}.md`)).toBe(true);
    const log = await book.repo.log({ limit: 3 });
    expect(log.items.every((c) => c.trailers[TRAILER.task] && c.trailers[TRAILER.harness] === 'fake')).toBe(true);
    expect(events).toEqual(['accepted:1', 'accepted:2', 'accepted:3']);
    const allRuns = await t.db.select().from(runs);
    expect(allRuns).toHaveLength(3);
    expect(allRuns.every((r) => r.state === 'finalized' && r.isolation)).toBe(true);
    expect(await t.db.select().from(usageLedger)).toHaveLength(3);
    // 活跃软链已清理，快照已移除
    expect(await fs.readdir(t.paths.runsActive)).toEqual([]);
    const wt = await fs.readdir(path.join(book.dir, '.git', 'worktrees')).catch(() => []);
    expect(wt).toEqual([]);
  }, 120_000);

  it('routes writer to a sticky profile and records writer_profile', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': chapterAgent() }, next: writeLane(1) } });
    const book = await addFixtureBook(t, 'sticky', { cards: 6 });
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 200 });
    const row = (await t.db.select().from(books).where(eq(books.id, book.id)))[0];
    expect(row?.writerProfile).toBe('fake');
  }, 120_000);

  it('quota error → waiting (no attempt charged), account sleeps; rate-limit events recorded', async () => {
    t = await createOrchTestEnv({
      pipeline: {
        handlers: { 'chapter.write': chapterAgent({ fake: () => ({ fail: 'quota', rateLimit: { window: '5h', utilization: 0.99, status: 'rejected', resetsAt: new Date(Date.now() + 3600_000).toISOString() } }) }) },
        next: writeLane(1),
      },
    });
    const book = await addFixtureBook(t, 'q', { cards: 6 });
    await t.db.insert(accounts).values({ id: 'fk', harness: 'fake', authMode: 'none', body: {} });
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 100 });
    const rows = (await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('waiting');
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.notBefore).toBeTruthy();
    const st = (await t.db.select().from(accountsState).where(eq(accountsState.accountId, 'fk')))[0];
    expect(st?.sleepUntil).toBeTruthy();
    expect(((st?.util ?? {}) as Record<string, { utilization: number }>)['5h']?.utilization).toBeCloseTo(99, 1);
  }, 120_000);

  it('output_contract twice on same profile → avoid profile and reroute down the chain', async () => {
    const seen: string[] = [];
    let n = 0;
    const handler = agentChapterHandler({
      dbEffects: (task) => acceptEffect(task, task.bookId as string),
      fake: () => {
        n += 1;
        return n <= 2 ? { skipArtifacts: ['manuscript/c00001.md'] } : undefined;
      },
      afterFinalize: (r, h) => {
        seen.push(h.run.profileId);
        return r;
      },
    });
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': handler }, next: writeLane(1) } });
    // 路由链：两个 fake profile（克隆一个）
    const { profiles, routingPresets } = await import('../db/schema.js');
    await t.db.insert(profiles).values({ id: 'fake2', harness: 'fake', enabled: true, builtin: false, body: { id: 'fake2', harness: 'fake', model: 'fake-model-2' } });
    await t.db.insert(routingPresets).values({ id: 'two', name: 'two', body: { id: 'two', name: 'two', roles: { writer: { chain: ['fake', 'fake2'] } } } });
    await t.db.update(settings).set({ value: { presetId: 'two', overrides: {} } }).where(eq(settings.key, 'routing.active'));
    const book = await addFixtureBook(t, 'route', { cards: 6 });
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 300 });
    const done = (await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[];
    expect(done[0]?.state).toBe('done');
    expect(done[0]?.attempts).toBe(2);
    expect(((done[0]?.params._orch ?? {}) as { avoidProfiles?: string[] }).avoidProfiles).toEqual(['fake']);
    expect(seen).toEqual(['fake2']);
  }, 180_000);

  it('output_contract with a single profile keeps retrying it instead of blocking on no route', async () => {
    let n = 0;
    const handler = agentChapterHandler({
      dbEffects: (task) => acceptEffect(task, task.bookId as string),
      fake: () => {
        n += 1;
        return n <= 2 ? { skipArtifacts: ['manuscript/c00001.md'] } : undefined;
      },
    });
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': handler }, next: writeLane(1) } });
    const book = await addFixtureBook(t, 'single', { cards: 6 });
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 300 });
    const done = (await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[];
    expect(done[0]?.state).toBe('done');
    expect(n).toBe(3);
  }, 180_000);

  it('hold then approve: promote commits, task waits for approval, onTaskDone only after approve', async () => {
    const onDone: string[] = [];
    const planHandler = fileHandler('plan.compass', 'write', (ctx, task) => ({ files: [{ path: 'plan/compass-note.md', content: `v-${task.attempts}\n` }] }));
    const base = planHandler.execute as NonNullable<TaskHandler['execute']>;
    planHandler.execute = async (ctx, task) => {
      const r = await base(ctx, task);
      return {
        ...r,
        status: 'hold',
        message: 'approval',
        inbox: [{ kind: 'approval', bookId: task.bookId, title: '批准指南针', body: {}, actions: [{ id: 'approve', label: '批准' }], dedupeKey: 'approval:compass' }],
      };
    };
    t = await createOrchTestEnv({ pipeline: { handlers: { 'plan.compass': planHandler }, initial: (b) => [{ kind: 'plan.compass', bookId: b.id, target: 'book', lane: 'write' }], onDone: (_c, task) => {
      onDone.push(task.kind);
      return [];
    } } });
    const book = await addFixtureBook(t, 'gate', { cards: 2, status: 'planning' });
    const orch = createOrchestrator(t.deps);
    await orch.startBook(book.id, { interview: false });
    await orch.runUntilIdle();
    const row = ((await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[])[0];
    expect(row?.state).toBe('blocked');
    expect(await book.repo.exists('plan/compass-note.md')).toBe(true);
    expect(onDone).toEqual([]);
    const item = (await t.db.select().from(inbox).where(eq(inbox.kind, 'approval')))[0];
    expect(item?.relatedTaskId).toBe(row?.id);
    await orch.actInbox(item?.id as string, 'approve');
    await orch.runUntilIdle();
    expect(onDone).toEqual(['plan.compass']);
    expect((await task(t.db, row?.id as string)).state).toBe('done');
  }, 60_000);

  it('promote crash after commit: replays dbEffects exactly once, single commit, followups delivered', async () => {
    const followups: TaskSpec[] = [];
    let crash = true;
    let effects = 0;
    const handler = agentChapterHandler({
      dbEffects: (task) => async (tx, sha) => {
        await acceptEffect(task, task.bookId as string)?.(tx, sha);
        effects += 1;
        if (crash) {
          crash = false;
          throw new Error('simulated crash after commit');
        }
      },
    });
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': handler, 'audit.window': fileHandler('audit.window', 'side', (_c, tk) => ({ files: [{ path: `audits/${tk.target}.json`, content: '{}' }] })) }, next: writeLane(1), onDone: (ctx, tk) => {
      if (tk.kind === 'chapter.write') {
        const f: TaskSpec = { kind: 'audit.window', bookId: tk.bookId, target: 'win-1', lane: 'side' };
        followups.push(f);
        return [f];
      }
      return [];
    } } });
    const book = await addFixtureBook(t, 'crash', { cards: 6 });
    const sched = createScheduler(t.deps);
    await sched.runUntilIdle({ maxTicks: 100 });
    // 第一次：commit 成功，dbEffects 抛错 → finishTask 抛错，任务未完成（模拟 commit 后、DB 更新前崩溃）
    const taskRow = ((await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[])[0] as TaskRow;
    expect(await book.repo.findCommitByTrailer(TRAILER.task, taskRow.id)).toBeTruthy();
    await t.db.update(tasks).set({ state: 'finalizing', leaseOwner: 'dead', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, taskRow.id));
    expect((await t.db.select().from(books).where(eq(books.id, book.id)))[0]?.acceptedThrough).toBe(0);

    const out = await recoverOnStartup(execEnv(t.deps), new Set());
    expect(out.replayed).toEqual([taskRow.id]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 100 });
    const log = await book.repo.log({ limit: 10 });
    expect(log.items.filter((c) => c.trailers[TRAILER.task] === taskRow.id)).toHaveLength(1);
    expect((await t.db.select().from(books).where(eq(books.id, book.id)))[0]?.acceptedThrough).toBe(1);
    expect(effects).toBe(2); // 第一次抛错回滚了 tx，第二次成功；tx 里的写只生效一次
    expect((await task(t.db, taskRow.id)).state).toBe('done');
    expect(followups).toHaveLength(1);
    const audit = (await t.db.select().from(tasks).where(and(eq(tasks.bookId, book.id), eq(tasks.kind, 'audit.window'))))[0];
    expect(audit?.state).toBe('done');
  }, 120_000);

  it('promote crash before commit: repromotes from VALIDATED.json and finishes', async () => {
    let crash = true;
    const handler = chapterAgent({
      afterFinalize: (r) => r,
    });
    const pipeline = {
      handlers: { 'chapter.write': handler },
      next: writeLane(1),
    };
    t = await createOrchTestEnv({ pipeline });
    const book = await addFixtureBook(t, 'crash2', { cards: 6 });
    // 让第一次 promote 在 repo.commit 前抛错：用一个 dbEffects 之前的钩子 —— 劫持 repo.writeFiles
    const origOpen = t.pipeline.openBook.bind(t.pipeline);
    t.pipeline.openBook = async (d, id) => {
      const h = await origOpen(d, id);
      if (crash) {
        h.repo.writeFiles = async () => {
          crash = false;
          throw new Error('simulated crash before commit');
        };
      }
      return h;
    };
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 100 });
    const taskRow = ((await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[])[0] as TaskRow;
    expect(await book.repo.findCommitByTrailer(TRAILER.task, taskRow.id)).toBeNull();
    // 模拟崩溃：任务停在 finalizing，VALIDATED.json 已写，agent 产物已收割
    await t.db.update(tasks).set({ state: 'finalizing', leaseOwner: 'dead', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, taskRow.id));
    const attempt = taskRow.attempts + 1;
    expect(await fs.stat(path.join(book.dir, `work/${taskRow.id}/attempt-${attempt}/VALIDATED.json`)).then(() => true)).toBe(true);
    const out = await recoverOnStartup(execEnv(t.deps), new Set());
    expect(out.replayed).toEqual([]);
    await createScheduler(t.deps).runUntilIdle({ maxTicks: 100 });
    expect((await task(t.db, taskRow.id)).state).toBe('done');
    expect(await book.repo.findCommitByTrailer(TRAILER.task, taskRow.id)).toBeTruthy();
    expect((await t.db.select().from(books).where(eq(books.id, book.id)))[0]?.acceptedThrough).toBe(1);
    // 没有额外的 run：恢复不重跑模型
    expect(await t.db.select().from(runs)).toHaveLength(1);
  }, 120_000);

  it('serve crash during run: reattaches live shim and completes without re-running', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': chapterAgent({ fake: () => ({ sleepMs: 2500 }) }) }, next: writeLane(1) } });
    const book = await addFixtureBook(t, 'reattach', { cards: 6 });
    const sched = createScheduler(t.deps);
    await sched.tick();
    await new Promise((r) => setTimeout(r, 400));
    expect(sched.inFlight()).toHaveLength(1);
    // stop 不 drain：executor 分离，shim 继续跑（模拟进程退出）
    await sched.stop({ drain: false });
    await t.db.update(runs).set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(runs.taskId, (await t.db.select().from(tasks))[0]?.id as string));
    await t.db.update(tasks).set({ leaseOwner: 'dead' }).where(eq(tasks.bookId, book.id));

    const reattached = new Set<Promise<void>>();
    const out = await recoverOnStartup(execEnv({ ...t.deps, owner: 'runner-2' }), reattached);
    expect(out.reattached).toHaveLength(1);
    expect(out.lost).toEqual([]);
    await Promise.all([...reattached]);
    const rows = (await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[];
    expect(rows[0]?.state).toBe('done');
    expect(rows[0]?.attempts).toBe(0);
    expect(await t.db.select().from(runs).where(eq(runs.state, 'finalized'))).toHaveLength(1);
    expect(await t.db.select().from(runs)).toHaveLength(1);
    expect(await book.repo.exists('manuscript/c00001.md')).toBe(true);
  }, 120_000);

  it('dead shim → run lost, task back to ready, attempt not charged', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': chapterAgent() }, next: writeLane(1) } });
    const book = await addFixtureBook(t, 'lost', { cards: 6 });
    await t.db.insert(tasks).values({ id: 'tk-lost', bookId: book.id, kind: 'chapter.write', target: 'c00001', lane: 'write', role: 'writer', state: 'running', leaseOwner: 'dead', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const runDir = path.join(t.paths.runs, '2026-11', 'gone');
    await fs.mkdir(path.join(runDir, 'in'), { recursive: true });
    await t.db.insert(runs).values({ id: 'gone', taskId: 'tk-lost', bookId: book.id, taskKind: 'chapter.write', attempt: 1, role: 'writer', profileId: 'fake', harness: 'fake', isolation: 'container', state: 'running', runDir, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const out = await recoverOnStartup(execEnv(t.deps), new Set());
    expect(out.lost).toEqual(['gone']);
    const row = await task(t.db, 'tk-lost');
    expect(row.state).toBe('ready');
    expect(row.attempts).toBe(0);
    expect((await t.db.select().from(runs).where(eq(runs.id, 'gone')))[0]?.state).toBe('lost');
  }, 60_000);
});

describe('no livelock', () => {
  it('write lane and side-lane planning race without starving; soft-conflicting plan tasks rebase, hard-conflicting go stale and are re-proposed', async () => {
    const CHAPTERS = 30;
    const bookId = 'book-race';
    let rebases = 0;

    const writeHandler: TaskHandler = {
      kind: 'chapter.write',
      role: null,
      lane: 'write',
      maxAttempts: 3,
      manifest: async (ctx, spec) => ({ hard: await ctx.book!.repo.blobShas([`plan/cards/${spec.target}.yaml`], ctx.book!.headCommit), soft: {}, rebaseValidators: [], configHash: '' }),
      async execute(ctx, task) {
        const no = Number(task.target.replace(/\D/g, ''));
        await new Promise((r) => setTimeout(r, Math.random() * 3));
        const plan: PromotePlan = {
          bookId,
          taskId: task.id,
          runId: null,
          baseCommit: ctx.book!.headCommit,
          files: [
            { path: `manuscript/${task.target}.md`, content: `第${no}章\n` },
            { path: 'notes/progress.md', content: `${no}\n` },
          ],
          resolveTmpIds: false,
          message: `chapter ${task.target}`,
          trailers: {},
          tags: [`ch/${String(no).padStart(5, '0')}`],
          dbEffects: acceptEffect(task, bookId),
        };
        return { status: 'done', promote: plan };
      },
    };

    // 规划任务：soft 依赖最新章节（一直在变），hard 依赖一个基本不变的文件；每章提议一次，靠 rebase 通过
    const planHandler: TaskHandler = {
      kind: 'plan.arc',
      role: null,
      lane: 'side',
      maxAttempts: 3,
      manifest: async (ctx, spec) => {
        return { hard: await ctx.book!.repo.blobShas(['book.yaml'], ctx.book!.headCommit), soft: await ctx.book!.repo.blobShas(['notes/progress.md'], ctx.book!.headCommit), rebaseValidators: ['arc.numbering'], configHash: spec.target };
      },
      async rebase() {
        rebases += 1;
        return { ok: true };
      },
      async execute(ctx, task) {
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 15));
        const plan: PromotePlan = {
          bookId,
          taskId: task.id,
          runId: null,
          baseCommit: ctx.book!.headCommit,
          files: [{ path: `plan/arcs/${task.target}.yaml`, content: `arc: ${task.target}\n` }],
          resolveTmpIds: false,
          message: `plan ${task.target}`,
          trailers: {},
          tags: [],
        };
        return { status: 'done', promote: plan };
      },
    };

    const next = (ctx: Parameters<NonNullable<FakePipelineOptions['next']>>[0], state: BookRuntimeState): TaskSpec[] => {
      const specs: TaskSpec[] = [];
      if (state.acceptedThrough < CHAPTERS && !state.active.some((a) => a.lane === 'write')) {
        specs.push({ kind: 'chapter.write', bookId, target: chapterId(state.acceptedThrough + 1), lane: 'write' });
      }
      // 规划：每 3 章一个弧，多任务并发
      const arc = `a${String(Math.ceil((state.acceptedThrough + 1) / 3)).padStart(4, '0')}`;
      if (!state.active.some((a) => a.kind === 'plan.arc')) specs.push({ kind: 'plan.arc', bookId, target: arc, lane: 'side' });
      return specs;
    };

    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': writeHandler, 'plan.arc': planHandler }, next } });
    await addFixtureBook(t, 'race', { cards: 40 });
    const sched = createScheduler(t.deps, { maxConcurrent: 3 });
    await sched.runUntilIdle({ maxTicks: 500 });

    const book = (await t.db.select().from(books).where(eq(books.id, bookId)))[0];
    expect(book?.acceptedThrough).toBe(CHAPTERS);
    const all = (await t.db.select().from(tasks)) as TaskRow[];
    const stuck = all.filter((x) => ['ready', 'leased', 'running', 'finalizing', 'waiting', 'failed', 'pending', 'blocked'].includes(x.state));
    expect(stuck.map((x) => `${x.kind}:${x.target}:${x.state}:${x.lastError}`)).toEqual([]);
    const plans = all.filter((x) => x.kind === 'plan.arc');
    const planDone = plans.filter((x) => x.state === 'done');
    expect(planDone.length).toBeGreaterThanOrEqual(CHAPTERS / 3 - 1);
    // 活锁判定：写作任务全部一次通过，绝大多数规划任务未被作废
    expect(all.filter((x) => x.kind === 'chapter.write' && x.state !== 'done')).toEqual([]);
    expect(plans.filter((x) => x.state === 'stale').length).toBeLessThanOrEqual(plans.length * 0.3);
    expect(rebases).toBeGreaterThan(0);
  }, 180_000);

  it('blocked lane does not spin: failed write task stops proposals, tick reaches idle quickly', async () => {
    const failing: TaskHandler = { kind: 'chapter.write', role: null, lane: 'write', maxAttempts: 2, manifest: async (): Promise<Manifest> => ({ hard: {}, soft: {}, rebaseValidators: [], configHash: '' }), execute: async () => ({ status: 'retry', errorClass: 'unknown', message: 'boom', retryAfter: new Date(Date.now() - 1000).toISOString() }) };
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': failing }, next: writeLane(1) } });
    const book = await addFixtureBook(t, 'block', { cards: 2 });
    const sched = createScheduler(t.deps);
    await sched.runUntilIdle({ maxTicks: 50 });
    const rows = (await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.attempts).toBe(2);
    const blocks = await t.db.select().from(inbox).where(and(inArray(inbox.kind, ['block']), eq(inbox.state, 'open')));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.relatedTaskId).toBe(rows[0]?.id);
  }, 60_000);

  it('multi-book parallelism: books write concurrently within the global limit', async () => {
    let active = 0;
    let peak = 0;
    const writer: TaskHandler = {
      kind: 'chapter.write',
      role: null,
      lane: 'write',
      maxAttempts: 3,
      manifest: async (): Promise<Manifest> => ({ hard: {}, soft: {}, rebaseValidators: [], configHash: '' }),
      async execute(ctx, task) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 40));
        active -= 1;
        const plan: PromotePlan = { bookId: ctx.book!.id, taskId: task.id, runId: null, baseCommit: ctx.book!.headCommit, files: [{ path: `manuscript/${task.target}.md`, content: 'x\n' }], resolveTmpIds: false, message: 'w', trailers: {}, tags: [], dbEffects: acceptEffect(task, ctx.book!.id) };
        return { status: 'done', promote: plan };
      },
    };
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': writer }, next: writeLane(2) } });
    for (const slug of ['a1', 'a2', 'a3']) await addFixtureBook(t, slug, { cards: 3 });
    const sched = createScheduler(t.deps, { maxConcurrent: 2 });
    await sched.runUntilIdle({ maxTicks: 100 });
    expect(peak).toBe(2);
    for (const slug of ['a1', 'a2', 'a3']) {
      expect((await t.db.select().from(books).where(eq(books.slug, slug)))[0]?.acceptedThrough).toBe(2);
    }
  }, 90_000);
});

describe('orchestrator facade', () => {
  it('pause/resume, retry/cancel, status snapshot, global pause stops dispatch', async () => {
    const gate: TaskHandler = {
      kind: 'chapter.write',
      role: null,
      lane: 'write',
      maxAttempts: 3,
      manifest: async (): Promise<Manifest> => ({ hard: {}, soft: {}, rebaseValidators: [], configHash: '' }),
      execute: async () => ({ status: 'failed', errorClass: 'unknown', message: 'x' }),
    };
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': gate as TaskHandler }, next: writeLane(1) } });
    const book = await addFixtureBook(t, 'facade', { cards: 2 });
    const orch = createOrchestrator(t.deps);
    await orch.bookAction(book.id, { action: 'pause', confirm: false });
    expect((await t.db.select().from(books).where(eq(books.id, book.id)))[0]?.status).toBe('paused');
    await orch.runUntilIdle({ maxTicks: 20 });
    expect(await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))).toEqual([]);
    await orch.bookAction(book.id, { action: 'resume', confirm: false });

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

  it('feasibility via facade and approve via inbox reach task', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: {} as Record<TaskKind, TaskHandler> } });
    const orch = createOrchestrator(t.deps);
    const report = await orch.feasibility(null);
    expect(report.problems.filter((p) => p.severity === 'error')).toEqual([]);
  });
});

describe('bookRuntimeState 审批门', () => {
  it('开书访谈与待投递的打回重做都拦住规划；普通问题不拦；未投递 outbox 的 done 任务算活跃', async () => {
    t = await createOrchTestEnv();
    const book = await addFixtureBook(t, 'gate');
    const env = execEnv(t.deps);
    const state = async () => bookRuntimeState(env, await env.pipe.openBook(env.pdeps, book.id));
    const base = { bookId: book.id, title: 't', body: {}, actions: [] };
    await t.db.insert(inbox).values({ id: 'q1', ...base, kind: 'question', dedupeKey: `interview:${book.id}` });
    await t.db.insert(inbox).values({ id: 'q2', ...base, kind: 'question', dedupeKey: 'question:other' });
    await t.db.insert(inbox).values({ id: 'a1', ...base, kind: 'approval', dedupeKey: `approval:compass:${book.id}`, state: 'resolved', resolution: { action: 'reject', followupsPending: true } });
    expect((await state()).openApprovals.sort()).toEqual([`approval:compass:${book.id}`, `interview:${book.id}`].sort());

    await t.db.insert(tasks).values({ id: 'tc', bookId: book.id, kind: 'plan.compass', target: 'book', lane: 'side', state: 'done', params: { _orch: { outbox: true } } });
    expect((await state()).active.map((a) => a.id)).toContain('tc');
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
    await env.db.insert(runs).values({ id, taskId: opts.task ?? 'none', bookId: opts.book ?? null, taskKind: opts.kind ?? 'plan.arc', attempt: 1, role: 'writer', profileId: 'p', harness: 'fake', isolation: 'none', state: 'finalized', endedAt: old(40), runDir });
    return path.join(runDir, 'log', 'stdout.ndjson');
  }
  const exists = (f: string) => fs.stat(f).then(() => true, () => false);

  it('由 scheduler tick 触发：清过期事件和原始流，已验收章节的 run 保留、未验收的不保留', async () => {
    t = await createOrchTestEnv();
    const book = await addFixtureBook(t, 'gc');
    await t.db.insert(chapters).values({ bookId: book.id, no: 1, chapterId: 'c00001', state: 'accepted', acceptedCommit: 'abc' });
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
