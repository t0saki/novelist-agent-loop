/**
 * 调度循环（DESIGN §7.3、§7.5）：tick → 每本 active 书 nextTasks → 入队；按全局并发派发 executeTask；
 * 错峰、退避、跨书按优先级与存稿分配订阅窗口；leader 选举 用 settings 行租约（PGlite 单进程直接是 leader）。Owner: lane F。
 */
import { and, count, eq, inArray, or, sql } from 'drizzle-orm';
import { books, settings, tasks } from '../db/schema.js';
import { V3_BOOK_SQL, isV3Meta } from '../book/legacy.js';
import type { SystemSettings, TaskState } from '@novelist/shared';
import type { BookHandle, PipelineContext, TaskRow, TaskResult, TaskSpec } from '../runtime/types.js';
import { drainAllOutbox, enqueueSpec, execEnv, executeTask, finishTask, leaseMs, reattachedTaskIds, type ExecEnv, type ExecutorDeps } from './executor.js';
import { orchOf, withOrch } from './orch-state.js';
import { publishTick } from './publisher.js';
import { ACTIVE_STATES, LIVE_STATES, advancePending, claimNext, reapExpiredLeases, renewLease } from './queue.js';
import { reconcileRuns, recoverStuckPromotes } from './recovery.js';
import { recoverRewinds } from './rewind-v3.js';
import { gcRetention } from './retention.js';
import { loadSystemSettings } from './routing.js';
import { v3PublishCap } from '../flow/publish.js';
import { reconcileV3Inbox } from '../flow/inbox-v3.js';

export interface Scheduler {
  start(): Promise<void>;
  stop(opts?: { drain?: boolean }): Promise<void>;
  /** 测试用：同步跑一轮（不 sleep） */
  tick(): Promise<{ enqueued: number; dispatched: number }>;
  /** 测试用：跑到没有可执行任务或达到上限 */
  runUntilIdle(opts?: { maxTicks?: number }): Promise<void>;
  /** 当前进程内在跑的任务 */
  inFlight(): { taskId: string; kind: string; book: string | null }[];
  /** 取消某个在跑任务（用户 kill / cancel） */
  abortTask(taskId: string, reason: 'kill' | 'cancel'): boolean;
  /** 注册只在 leader 上、调度器启用时每轮调用的钩子（自动开书） */
  setLeaderHook(hook: LeaderHook | null): void;
}

export type LeaderHook = (now: Date, settings: SystemSettings) => Promise<void>;

const LEADER_KEY = 'orchestrator.leader';
const LEADER_TTL_MS = 30_000;
const PUBLISH_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 86_400_000;

/** leader 租约：settings 行 + CAS（无需专用连接；PGlite 单进程恒为 leader） */
export async function acquireLeader(env: ExecEnv): Promise<boolean> {
  const now = env.nowFn();
  const value = { owner: env.owner, expiresAt: new Date(now.getTime() + LEADER_TTL_MS).toISOString() };
  return env.db.transaction(async (tx) => {
    await tx.insert(settings).values({ key: LEADER_KEY, value }).onConflictDoNothing({ target: settings.key });
    const rows = await tx.select().from(settings).where(eq(settings.key, LEADER_KEY)).limit(1).for('update');
    const cur = rows[0]?.value as { owner?: string; expiresAt?: string } | undefined;
    if (cur?.owner !== env.owner && cur?.expiresAt && new Date(cur.expiresAt).getTime() > now.getTime()) return false;
    await tx.update(settings).set({ value, updatedAt: now.toISOString() }).where(eq(settings.key, LEADER_KEY));
    return true;
  });
}

export function createScheduler(deps: ExecutorDeps, opts?: { tickMs?: number; maxConcurrent?: number }): Scheduler {
  const env = execEnv(deps);
  const tickMs = opts?.tickMs ?? 2000;
  const running = new Map<string, { promise: Promise<void>; kind: string; book: string | null; ctrl: AbortController }>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let tickInFlight: Promise<unknown> | null = null;
  let lastPublishTick = 0;
  let lastRetention = 0;
  let retentionInFlight: Promise<void> | null = null;
  const reattached = new Set<Promise<void>>();

  const canEnqueue = (): boolean => env.config.roles.includes('orchestrator');
  const canRun = (): boolean => env.config.roles.includes('runner');

  function dispatchOne(task: TaskRow): void {
    const ctrl = new AbortController();
    // 从认领到完成全程续租（prepare 期间快照 + 指令编译可能超过一个 lease）
    const renew = setInterval(() => {
      void renewLease(env.db, task.id, env.owner, leaseMs).catch(() => {});
    }, leaseMs / 3);
    renew.unref?.();
    const promise = (async () => {
      let result: TaskResult;
      try {
        result = await executeTask(env, task, ctrl.signal);
      } catch (err) {
        env.log.warn({ err: (err as Error).message, taskId: task.id }, 'executeTask threw');
        result = { status: 'retry', errorClass: 'unknown', message: (err as Error).message };
      }
      try {
        await finishTask(env, task, result);
      } catch (err) {
        env.log.error({ err: (err as Error).message, taskId: task.id }, 'finishTask threw');
        const latest = (await env.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1))[0] as TaskRow | undefined;
        // 只回收仍在执行中的任务；completeTask 已落终态的不能重置（否则 done/failed 被复活重跑）
        if (latest && ACTIVE_STATES.includes(latest.state as (typeof ACTIVE_STATES)[number])) {
          // promote 已开始（finalizing）：下次走恢复路径，不重跑模型
          const params = latest.state === 'finalizing' ? withOrch(latest.params, { recover: orchOf(latest).recover ?? { mode: 'repromote' } }) : latest.params;
          await env.db.update(tasks).set({ state: 'ready', params, leaseOwner: null, leaseExpiresAt: null, notBefore: new Date(env.nowFn().getTime() + 30_000).toISOString(), waitReason: `finish error: ${(err as Error).message}`, updatedAt: new Date().toISOString() }).where(and(eq(tasks.id, task.id), eq(tasks.state, latest.state as TaskState)));
        }
      }
    })().finally(() => {
      clearInterval(renew);
      running.delete(task.id);
    });
    running.set(task.id, { promise, kind: task.kind, book: task.bookId, ctrl });
  }

  async function bookTick(book: { id: string }): Promise<number> {
    let enq = 0;
    let handle: BookHandle;
    try {
      handle = await env.pipe.openBook(env.pdeps, book.id);
    } catch (err) {
      env.log.warn({ err: (err as Error).message, bookId: book.id }, 'openBook failed');
      return 0;
    }
    const ctx: PipelineContext = { deps: env.pdeps, book: handle };
    let specs: TaskSpec[];
    try {
      specs = await env.pipe.nextTasks(ctx);
    } catch (err) {
      env.log.warn({ err: (err as Error).message, bookId: book.id }, 'nextTasks failed');
      return 0;
    }
    for (const spec of specs) {
      try {
        const r = await enqueueSpec(env, ctx, spec);
        if (r.created) enq += 1;
      } catch (err) {
        env.log.warn({ err: (err as Error).message, kind: spec.kind, target: spec.target }, 'enqueue failed');
      }
    }
    return enq;
  }

  async function housekeeping(now: Date, sys: Awaited<ReturnType<typeof loadSystemSettings>>): Promise<number> {
    let enq = 0;
    const own = [...running.keys(), ...reattachedTaskIds];
    await reconcileRuns(env, reattached, { excludeTasks: own });
    await recoverStuckPromotes(env, { excludeTasks: own });
    await reapExpiredLeases(env.db, now, own);
    await advancePending(env.db);
    await drainAllOutbox(env);
    // 发布：每分钟一次（测试 tickMs 很小时也按实际时间节流）
    if (now.getTime() - lastPublishTick >= PUBLISH_INTERVAL_MS) {
      lastPublishTick = now.getTime();
      const published = await publishTick(env.db, now, publisherIo(env));
      enq += published.length;
      // v3 回退中途失败的补做（同样每分钟一次）
      await recoverRewinds(env).catch((err: Error) => env.log.warn({ err: err.message }, 'recoverRewinds failed'));
      // v3 待办卫生：条件消失的自动关闭，存稿将尽且写不动的全站一条（同样每分钟一次）
      await reconcileV3Inbox(env, now).catch((err: Error) => env.log.warn({ err: err.message }, 'reconcileV3Inbox failed'));
    }
    // 保留期 GC：每天一次，后台执行（首次可能很慢，不能拖住 tick 和 leader 续租）
    if (!retentionInFlight && now.getTime() - lastRetention >= RETENTION_INTERVAL_MS) {
      lastRetention = now.getTime();
      retentionInFlight = gcRetention(env, sys, now)
        .then(
          () => {},
          (err) => env.log.warn({ err: (err as Error).message }, 'retention gc failed'),
        )
        .finally(() => {
          retentionInFlight = null;
        });
    }
    return enq;
  }

  let leaderHook: LeaderHook | null = null;

  async function tick(): Promise<{ enqueued: number; dispatched: number }> {
    const now = env.nowFn();
    let enqueued = 0;
    let dispatched = 0;
    const settingsNow = await loadSystemSettings(env.db);

    if (canEnqueue() && (await acquireLeader(env))) {
      enqueued += await housekeeping(now, settingsNow);
      if (settingsNow.schedulerEnabled && env.config.schedulerEnabled !== false) {
        // 只看 v3 书（旧书什么都不提议，也不进 tick；P3 D1）
        const bookRows = await env.db.select({ id: books.id }).from(books).where(and(inArray(books.status, ['active', 'planning', 'completed']), V3_BOOK_SQL));
        for (const b of bookRows) enqueued += await bookTick(b);
        if (leaderHook) {
          await leaderHook(now, settingsNow).catch((err: Error) => env.log.error({ err: err.message }, 'leader hook failed'));
        }
      }
    }

    if (canRun() && settingsNow.schedulerEnabled && !stopped) {
      const limit = opts?.maxConcurrent ?? settingsNow.maxConcurrentRuns;
      for (;;) {
        const active = (await env.db.select({ n: count() }).from(tasks).where(inArray(tasks.state, ACTIVE_STATES)))[0];
        if (Number(active?.n ?? 0) >= limit) break;
        const task = await claimNext(env.db, { owner: env.owner, leaseMs, excludeBooksWithActiveWrite: true, now });
        if (!task) break;
        if (running.has(task.id)) {
          // 同一任务的上一份执行还没结束（取消后被重试等）：放回队列稍后再认领，不并行跑两份
          await env.db
            .update(tasks)
            .set({ state: 'ready', leaseOwner: null, leaseExpiresAt: null, notBefore: new Date(now.getTime() + 30_000).toISOString(), waitReason: '上一份执行还在收尾', updatedAt: new Date().toISOString() })
            .where(and(eq(tasks.id, task.id), eq(tasks.state, 'leased')));
          continue;
        }
        env.bus.publish({ type: 'task_changed', taskId: task.id, book: task.bookId, state: 'leased' });
        dispatchOne(task);
        dispatched += 1;
      }
    }
    return { enqueued, dispatched };
  }

  const safeTick = async (): Promise<void> => {
    if (tickInFlight) return;
    tickInFlight = tick().catch((err) => env.log.error({ err: (err as Error).message }, 'tick failed'));
    try {
      await tickInFlight;
    } finally {
      tickInFlight = null;
    }
  };

  return {
    setLeaderHook(hook) {
      leaderHook = hook;
    },
    async start() {
      stopped = false;
      await safeTick();
      timer = setInterval(() => void safeTick(), tickMs);
      timer.unref?.();
    },
    async stop(o) {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (tickInFlight) await tickInFlight;
      if (retentionInFlight) await retentionInFlight;
      if (o?.drain) {
        await Promise.all([...running.values()].map((r) => r.promise));
        await Promise.all([...reattached]);
      } else {
        for (const r of running.values()) r.ctrl.abort('detach');
        await Promise.all([...running.values()].map((r) => r.promise));
      }
    },
    tick,
    async runUntilIdle(o) {
      const maxTicks = o?.maxTicks ?? 5000;
      for (let i = 0; i < maxTicks; i += 1) {
        const { enqueued, dispatched } = await tick();
        await Promise.all([...running.values()].map((r) => r.promise));
        await Promise.all([...reattached]);
        if (retentionInFlight) await retentionInFlight;
        if (enqueued === 0 && dispatched === 0) return;
      }
    },
    inFlight() {
      return [...running.entries()].map(([taskId, r]) => ({ taskId, kind: r.kind, book: r.book }));
    },
    abortTask(taskId, reason) {
      const r = running.get(taskId);
      if (!r) return false;
      r.ctrl.abort(reason);
      return true;
    },
  };
}

function publisherIo(env: ExecEnv): Parameters<typeof publishTick>[2] {
  return {
    loadConfig: async (bookId) => {
      // 旧书不再发布（P3 D13）：先按数据库判定，book.yaml 坏了也不打开
      const row = (await env.db.select({ meta: books.meta }).from(books).where(eq(books.id, bookId)).limit(1))[0];
      if (!row || !isV3Meta(row.meta)) return 'skip';
      const book = await env.pipe.openBook(env.pdeps, bookId);
      if (book.config.flow !== 'v3') return 'skip';
      return { cfg: book.config.publish, v3Cap: await v3PublishCap(env.db, bookId, env.nowFn(), book.config.v3.publish_after_hours) };
    },
    enqueue: async ({ bookId, through, slot }) => {
      const book = await env.pipe.openBook(env.pdeps, bookId);
      const ctx: PipelineContext = { deps: env.pdeps, book };
      return (await enqueueSpec(env, ctx, { kind: 'publish', bookId, target: `through-${through}`, lane: 'system', params: { through, slot } })).created;
    },
    productionChanged: async ({ bookId, paused, buffer }) => {
      const rows = await env.db.select({ slug: books.slug }).from(books).where(eq(books.id, bookId)).limit(1);
      if (rows[0]) env.bus.publish({ type: 'book_changed', book: rows[0].slug });
      env.log.info({ bookId, paused, buffer }, 'production paused state changed');
    },
  };
}

