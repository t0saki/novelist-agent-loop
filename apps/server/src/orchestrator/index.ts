/**
 * orchestrator 公共出口 + Orchestrator 门面（API / CLI 只通过它驱动编排）。
 * 只有 v3 书能开写；旧书（meta.v3 不是对象，book/legacy.ts）的一切写作 / 发布操作都回 409 legacy_book。
 */
import { and, count, eq, gt, inArray, like } from 'drizzle-orm';
import { books, inbox as inboxTable, runs, settings, tasks } from '../db/schema.js';
import { openRepo } from '../book/repo.js';
import { isV3Meta } from '../book/legacy.js';
import type { PipelineContext, TaskRow, TaskSpec } from '../runtime/types.js';
import { isKnownKind } from '../runtime/registry.js';
import type { BookAction, ChapterAction, InboxItem } from './facade-types.js';
import { V3DiscardRefused, revertPartialV3 } from './committer.js';
import type { EventBus } from './bus.js';
import { enqueueSpec, execEnv, type ExecEnv, type ExecutorDeps } from './executor.js';
import { actOnInbox } from './inbox.js';
import { ACTIVE_STATES, QUEUED_STATES, retryTaskRow, setTaskState } from './queue.js';
import { rewindV3, type RewindV3Result } from './rewind-v3.js';
import { requestChapterRewrite } from '../flow/owner.js';
import { recoverOnStartup } from './recovery.js';
import { notify } from './notify.js';
import { loadSystemSettings, seedProfiles } from './routing.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import { logFiles } from '../harness/index.js';
import { ACTIVE_RUN_STATES } from './executor.js';
import { promises as fs } from 'node:fs';
import { HttpProblem } from '../api/problem.js';
import { resumeZeroDiffAccount } from '../flow/accounts.js';
import { clearPending, patchPending, patchV3Meta, readPending, readV3Meta } from '../flow/state.js';
import { BUFFER_FULL_WAIT } from '../flow/contract.js';

const V3_FLOW_KINDS = ['book.open', 'book.write', 'book.retro'] as const;

const legacyBook = (): HttpProblem => new HttpProblem(409, 'legacy_book', '旧书不能开写；先在书页点“接手”');
/**
 * v3 收稿连续失败后的“重试 / 放弃”（p2-plan §3.2 pendingAction）。重试 = failures 归零；放弃 = 先把这次运行已经提交的分章撤回到 drafts/，再清 pending
 * （收到的改动留在 work/ 下，GC 保留 30 天）。wakeTask：把这本书 blocked 的 v3 任务放回 ready（待办的旧入口由 actOnInbox 自己放）。返回给提示条的一句话。
 */
export async function v3PendingAction(env: ExecEnv, bookId: string, action: 'retry' | 'discard', opts: { runId?: string; wakeTask?: boolean } = {}): Promise<string> {
  const pending = await readPending(env.db, bookId);
  const runId = opts.runId ?? pending?.runId ?? '';
  if (!pending || pending.runId !== runId) {
    if (opts.runId !== undefined) return '这次收稿已经处理过了';
    throw new HttpProblem(400, 'nothing_pending', '没有等着处理的收稿');
  }
  let detail: string;
  if (action === 'retry') {
    await patchPending(env.db, bookId, runId, { failures: 0 });
    detail = '已重试收稿';
  } else {
    // 1. 先把这本书的 v3 任务原地占住：有任务在排队就绪或在跑（可能正在重放 promote）→ 409；
    //    blocked / waiting 的在同一个事务里锁住行（claimNext 用 skip locked，认领不到）并改成 blocked，撤回做完再放回去
    const parked = await env.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: tasks.id, state: tasks.state, notBefore: tasks.notBefore, waitReason: tasks.waitReason })
        .from(tasks)
        .where(and(eq(tasks.bookId, bookId), inArray(tasks.kind, [...V3_FLOW_KINDS]), inArray(tasks.state, [...QUEUED_STATES, ...ACTIVE_STATES, 'blocked'])))
        .for('update');
      if (rows.some((r) => r.state !== 'blocked' && r.state !== 'waiting')) throw new HttpProblem(409, 'v3_busy', '这本书的任务正在排队或在跑（可能正在重试收稿），等它结束再放弃');
      const waiting = rows.filter((r) => r.state === 'waiting');
      if (waiting.length) await tx.update(tasks).set({ state: 'blocked', waitReason: 'v3_discard', updatedAt: env.nowFn().toISOString() }).where(inArray(tasks.id, waiting.map((r) => r.id)));
      return waiting;
    });
    const unpark = async () => {
      for (const r of parked) await env.db.update(tasks).set({ state: 'waiting', notBefore: r.notBefore, waitReason: r.waitReason, updatedAt: env.nowFn().toISOString() }).where(and(eq(tasks.id, r.id), eq(tasks.state, 'blocked')));
    };
    // 2. 提交中途失败留下的分章提交 DB 从没计入：先撤回到 drafts/，否则下一批会按旧的 acceptedThrough 编号、把它们覆盖掉。
    //    锁内复查 pending 仍是这一次、整批没提交过，再清 pending
    let reverted: number[];
    try {
      const bookRows = await env.db.select({ slug: books.slug }).from(books).where(eq(books.id, bookId)).limit(1);
      reverted = bookRows[0] ? await revertPartialV3(env.db, openRepo(`${env.paths.books}/${bookRows[0].slug}`), bookId, { ...pending, runId }) : [];
      if (!bookRows[0]) await clearPending(env.db, bookId, runId);
    } catch (e) {
      await unpark();
      if (e instanceof V3DiscardRefused) {
        if (e.code === 'gone' && opts.runId !== undefined) return e.message;
        throw new HttpProblem(409, e.code === 'gone' ? 'nothing_pending' : 'v3_landed', e.message);
      }
      throw e;
    }
    if (!opts.wakeTask) await unpark();
    detail = reverted.length ? `已放弃这次的稿：已提交的第 ${reverted.join('、')} 章撤回到 drafts/（cNNNNN.discarded.md）` : '已放弃这次的稿';
  }
  if (opts.wakeTask) {
    const blocked = await env.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, bookId), inArray(tasks.kind, ['book.open', 'book.write', 'book.retro']), inArray(tasks.state, ['blocked', 'waiting'])));
    for (const t of blocked) await retryTaskRow(env.db, t.id);
  }
  return detail;
}

export * from './bus.js';
export * from './queue.js';
export * from './routing.js';
export * from './quota.js';
export * from './committer.js';
export * from './executor.js';
export * from './scheduler.js';
export * from './publisher.js';
export * from './inbox.js';
export * from './notify.js';
export * from './recovery.js';
export * from './orch-state.js';
export { rewindV3, applyRewindDb, recoverRewinds, batchBaseFor, backfillBatchLog, ensureBatchLog, rewindPoints, type RewindV3Result } from './rewind-v3.js';
export { planFailure, INFRA_CLASSES } from './actions.js';
export { defaultPipeline, type PipelineBinding } from './binding.js';

export interface OrchestratorStatus {
  owner: string;
  paused: boolean;
  inFlight: { taskId: string; kind: string; book: string | null }[];
  queue: Record<string, number>;
  activeRuns: number;
}

export interface OrchestratorStartOptions {
  /** 恢复（recoverOnStartup + sweepDirtyBooks）之后调用一次；出错只记日志，不影响启动 */
  afterRecover?: () => Promise<unknown>;
}

export interface Orchestrator {
  bus: EventBus;
  start(opts?: OrchestratorStartOptions): Promise<void>;
  stop(opts?: { drain?: boolean }): Promise<void>;
  /** 开书后入队首批任务（旧书 → 409 legacy_book） */
  startBook(bookId: string): Promise<void>;
  bookAction(bookId: string, action: BookAction): Promise<void>;
  chapterAction(bookId: string, no: number, action: ChapterAction): Promise<void>;
  /** v3：回退到第 to 章（p2-plan §2.6） */
  rewindV3(bookId: string, to: number, opts?: { note?: string }): Promise<RewindV3Result>;
  /** v3：收稿失败的重试 / 放弃；返回给提示条的一句话 */
  v3PendingAction(bookId: string, action: 'retry' | 'discard'): Promise<string>;
  retryTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  killRun(runId: string): Promise<void>;
  actInbox(id: string, action: string, note?: string, payload?: Record<string, unknown>): Promise<InboxItem>;
  publishNow(bookId: string, through?: number, ignoreAudit?: boolean): Promise<void>;
  /** 测试：跑到空闲 */
  runUntilIdle(opts?: { maxTicks?: number }): Promise<void>;
  /** 全局暂停 / 恢复（写 settings.schedulerEnabled） */
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  /** 状态快照（/api/admin/system、CLI） */
  status(): Promise<OrchestratorStatus>;
  /** 启动时的恢复结果（测试 / doctor） */
  scheduler: Scheduler;
}

export function createOrchestrator(deps: ExecutorDeps): Orchestrator {
  const env = execEnv(deps);
  const scheduler = createScheduler(deps, { tickMs: deps.config.schedulerTickMs });
  const reattached = new Set<Promise<void>>();
  let unsubscribeNotify: (() => void) | null = null;

  const ctxFor = async (bookId: string): Promise<PipelineContext> => ({ deps: env.pdeps, book: await env.pipe.openBook(env.pdeps, bookId) });
  const notifyBook = async (bookId: string): Promise<void> => {
    const rows = await env.db.select({ slug: books.slug }).from(books).where(eq(books.id, bookId)).limit(1);
    if (rows[0]) env.bus.publish({ type: 'book_changed', book: rows[0].slug });
  };
  /** 以数据库为准（P3 D1）：旧书什么写作 / 发布操作都不做，book.yaml 坏了也一样回 409 */
  const assertV3Book = async (bookId: string): Promise<void> => {
    const row = (await env.db.select({ meta: books.meta }).from(books).where(eq(books.id, bookId)).limit(1))[0];
    if (!row) throw new Error(`book not found: ${bookId}`);
    if (!isV3Meta(row.meta)) throw legacyBook();
  };

  async function enqueueOne(bookId: string, spec: TaskSpec): Promise<string> {
    return (await enqueueSpec(env, await ctxFor(bookId), spec)).id;
  }

  /** v3：只把 draft / paused 改成 planning（已在写或已完结的书不重置），然后按 nextTasks 入队（只有 0 章时才会是 book.open） */
  async function startV3(bookId: string, ctx: PipelineContext): Promise<void> {
    await env.db.update(books).set({ status: 'planning', pausedReason: null, updatedAt: new Date().toISOString() }).where(and(eq(books.id, bookId), inArray(books.status, ['draft', 'paused'])));
    for (const spec of await env.pipe.nextTasks(ctx)) await enqueueSpec(env, ctx, spec);
  }

  /**
   * 立即写下一批（DESIGN §9 书页状态栏）：meta.v3.writeNow = true（decideNext、任务单的存稿检查、claimNext 的 max_buffer 暂停都放行一批 book.write，
   * 这一批有新章入库就清掉）；暂停中的书一并恢复；已经有排着的写作任务就不再加，因存稿满在等的那个马上重新认领。
   */
  async function writeNow(bookId: string, now: string): Promise<void> {
    const row = (await env.db.select({ status: books.status, meta: books.meta, accepted: books.acceptedThrough }).from(books).where(eq(books.id, bookId)).limit(1))[0];
    if (!row) throw new Error(`book not found: ${bookId}`);
    if (row.status === 'completed' || row.status === 'archived') throw new HttpProblem(409, 'completed', '这本书已经完结（或已归档），没有下一批可写');
    const meta = readV3Meta(row.meta);
    if (meta.rewinding) throw new HttpProblem(409, 'rewinding', '回退进行中，等它结束再写');
    if (row.accepted === 0) {
      // 还没开书：等同“开始”
      await startV3(bookId, await ctxFor(bookId));
      return;
    }
    await patchV3Meta(env.db, bookId, (m) => ({ patch: m.writeNow ? null : { writeNow: true }, result: undefined }));
    await env.db.update(books).set({ status: 'active', pausedReason: null, updatedAt: now }).where(and(eq(books.id, bookId), eq(books.status, 'paused')));
    await env.db.update(books).set({ status: 'planning', updatedAt: now }).where(and(eq(books.id, bookId), eq(books.status, 'draft')));
    await env.db
      .update(tasks)
      .set({ notBefore: now, updatedAt: now })
      .where(and(eq(tasks.bookId, bookId), eq(tasks.kind, 'book.write'), eq(tasks.state, 'waiting'), eq(tasks.waitReason, BUFFER_FULL_WAIT)));
    const ctx = await ctxFor(bookId);
    for (const spec of await env.pipe.nextTasks(ctx)) await enqueueSpec(env, ctx, spec);
  }

  async function setSystemEnabled(enabled: boolean): Promise<void> {
    const cur = await loadSystemSettings(env.db);
    const value = { ...cur, schedulerEnabled: enabled };
    await env.db.insert(settings).values({ key: 'system', value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } });
  }

  return {
    bus: deps.bus,
    scheduler,
    async start(opts) {
      await seedProfiles(env.db);
      unsubscribeNotify = env.bus.subscribe(
        (e) => {
          void loadSystemSettings(env.db)
            .then((settings) => notify(env.db, settings, e))
            .catch((err) => env.log.warn({ err: (err as Error).message }, 'notify failed'));
        },
        (e) => e.type === 'inbox_new' || e.type === 'quota_wait',
      );
      const recovered = await recoverOnStartup(env, reattached);
      if (recovered.reattached.length || recovered.lost.length || recovered.replayed.length) env.log.info(recovered, 'orchestrator recovered');
      if (opts?.afterRecover) {
        await opts.afterRecover().catch((err: Error) => env.log.error({ err: err.message }, 'post-recovery step failed'));
      }
      if (env.config.schedulerEnabled !== false) await scheduler.start();
    },
    async stop(opts) {
      await scheduler.stop(opts);
      unsubscribeNotify?.();
      unsubscribeNotify = null;
      if (opts?.drain) await Promise.all([...reattached]);
    },
    async startBook(bookId) {
      await assertV3Book(bookId);
      await startV3(bookId, await ctxFor(bookId));
      await notifyBook(bookId);
    },
    async bookAction(bookId, a) {
      const now = new Date().toISOString();
      await assertV3Book(bookId);
      switch (a.action) {
        case 'start':
          await startV3(bookId, await ctxFor(bookId));
          break;
        case 'pause':
          await env.db.update(books).set({ status: 'paused', pausedReason: 'owner', updatedAt: now }).where(eq(books.id, bookId));
          // 暂停就撤掉还没用上的“立即写下一批”（恢复后按存稿规则写）
          await patchV3Meta(env.db, bookId, (m) => ({ patch: m.writeNow ? { writeNow: false } : null, result: undefined }));
          break;
        case 'write_now':
          await writeNow(bookId, now);
          break;
        case 'resume':
          await env.db.update(books).set({ status: 'active', pausedReason: null, updatedAt: now }).where(eq(books.id, bookId));
          break;
        case 'reindex':
          throw new HttpProblem(400, 'bad_request', 'reindex 由 API 直接处理');
        case 'rewind':
          if (a.to === undefined) throw new HttpProblem(400, 'bad_request', 'rewind 需要 to');
          await rewindV3(env, bookId, a.to, { reason: 'rewind', ...(a.note?.trim() ? { note: a.note } : {}) });
          break;
      }
      await notifyBook(bookId);
    },
    async chapterAction(bookId, no, a) {
      await assertV3Book(bookId);
      switch (a.action) {
        // 带意见重写：记一条改写请求，并入下一批写作（不单开运行）
        case 'rewrite':
          if (!a.note?.trim()) throw new HttpProblem(400, 'bad_request', '带意见重写需要写一句意见');
          await requestChapterRewrite(env.db, bookId, no, a.note, env.nowFn());
          break;
        // 从这里起重写 = 回退到上一章再写
        case 'rewrite_from': {
          const pub = (await env.db.select({ p: books.publishedThrough }).from(books).where(eq(books.id, bookId)).limit(1))[0]?.p ?? 0;
          if (no <= pub) throw new HttpProblem(409, 'published', '已发布的章节只能直接修改');
          await rewindV3(env, bookId, no - 1, { ...(a.note ? { note: a.note } : {}), reason: 'rewrite_from' });
          break;
        }
        case 'publish_now':
          await enqueueOne(bookId, { kind: 'publish', bookId, target: `through-${no}`, lane: 'system', params: { through: no, ignoreAudit: false, manual: true } });
          break;
      }
      await notifyBook(bookId);
    },
    async rewindV3(bookId, to, opts) {
      const r = await rewindV3(env, bookId, to, { ...(opts?.note ? { note: opts.note } : {}), reason: 'rewind' });
      await notifyBook(bookId);
      return r;
    },
    async v3PendingAction(bookId, action) {
      const detail = await v3PendingAction(env, bookId, action, { wakeTask: true });
      await notifyBook(bookId);
      return detail;
    },
    async retryTask(taskId) {
      const row = (await env.db.select({ kind: tasks.kind, bookId: tasks.bookId }).from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
      // 已删除的旧种类、旧书的任务：不再复活
      if (row && !isKnownKind(row.kind)) throw new HttpProblem(409, 'unknown_kind', `这个任务的种类已经不存在了：${row.kind}`);
      if (row?.bookId) await assertV3Book(row.bookId);
      // 取消后本进程还在收尾（杀 harness、收稿、提交）：这时复活同一个任务会让两份执行去收同一个快照
      if (scheduler.inFlight().some((x) => x.taskId === taskId)) throw new Error(`任务还在收尾，稍后再重试：${taskId}`);
      if (!(await retryTaskRow(env.db, taskId))) throw new Error(`任务不可重试：${taskId}`);
      env.bus.publish({ type: 'task_changed', taskId, book: null, state: 'ready' });
    },
    async cancelTask(taskId) {
      const rows = (await env.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)) as TaskRow[];
      const task = rows[0];
      if (!task) throw new Error(`任务不存在：${taskId}`);
      if (task.state === 'done' || task.state === 'failed' || task.state === 'cancelled') return;
      await setTaskState(env.db, taskId, 'cancelled', { waitReason: 'owner_cancel' });
      if (!scheduler.abortTask(taskId, 'cancel')) {
        // 进程内没有这个 run（reattach 接管 / 其它进程）：写 kill 文件，shim 负责终止，别继续烧配额
        const active = await env.db.select().from(runs).where(and(eq(runs.taskId, taskId), inArray(runs.state, ACTIVE_RUN_STATES)));
        for (const run of active) await fs.writeFile(logFiles(`${run.runDir}/log`).kill, 'user').catch(() => {});
      }
      env.bus.publish({ type: 'task_changed', taskId, book: task.bookId, state: 'cancelled' });
    },
    async killRun(runId) {
      const rows = await env.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      const run = rows[0];
      if (!run) throw new Error(`run 不存在：${runId}`);
      if (!scheduler.abortTask(run.taskId, 'kill')) {
        // 进程内没有这个 run（reattach 接管 / 其它进程）：写 kill 文件，shim 负责终止
        await fs.writeFile(logFiles(`${run.runDir}/log`).kill, 'user').catch(() => {});
      }
    },
    async actInbox(id, action, note, payload) {
      const rows = await env.db.select().from(inboxTable).where(eq(inboxTable.id, id)).limit(1);
      const row = rows[0];
      const dedupe = row?.state === 'open' ? (row.dedupeKey ?? '') : '';
      // v3 空跑暂停的账号：恢复 = 清 sleep_until + 连击归零
      if (dedupe.startsWith('zero_diff:') && action === 'resume') {
        const accountId = String((row?.body as { accountId?: unknown } | undefined)?.accountId ?? dedupe.slice('zero_diff:'.length));
        await resumeZeroDiffAccount(env.db, accountId);
        // 暂停期间路由不到账号的任务按 sleepUntil 停到了 7 天后：叫醒所有"路由等待"的任务（路由仍然不通的会再等一次），不动 attempts
        const nowIso = new Date().toISOString();
        const woken = await env.db
          .update(tasks)
          .set({ notBefore: nowIso, updatedAt: nowIso })
          .where(and(eq(tasks.state, 'waiting'), gt(tasks.notBefore, nowIso), like(tasks.waitReason, '路由等待%')))
          .returning({ bookId: tasks.bookId });
        for (const b of new Set(woken.map((w) => w.bookId).filter((x): x is string => !!x))) await notifyBook(b);
      }
      // v3 收稿连续失败（旧的待办入口）：重试 / 放弃，任务由 actOnInbox 放回 ready
      if (dedupe.startsWith('v3_pending:') && row?.bookId && (action === 'retry' || action === 'discard')) {
        await v3PendingAction(env, row.bookId, action, { runId: String((row.body as { runId?: unknown }).runId ?? '') });
      }
      const item = await actOnInbox(env.db, env.bus, id, action, note, payload);
      if (row?.bookId) await notifyBook(row.bookId);
      return item;
    },
    async publishNow(bookId, through, ignoreAudit) {
      await assertV3Book(bookId);
      let target = through;
      if (target === undefined) {
        const rows = await env.db.select({ a: books.acceptedThrough }).from(books).where(eq(books.id, bookId)).limit(1);
        target = rows[0]?.a ?? 0;
      }
      await enqueueOne(bookId, { kind: 'publish', bookId, target: `through-${target}`, lane: 'system', params: { through: target, ignoreAudit: ignoreAudit === true, manual: true } });
    },
    runUntilIdle: (opts) => scheduler.runUntilIdle(opts),
    pauseAll: () => setSystemEnabled(false),
    resumeAll: () => setSystemEnabled(true),
    async status() {
      const settingsNow = await loadSystemSettings(env.db);
      const rows = await env.db.select({ state: tasks.state, n: count() }).from(tasks).groupBy(tasks.state);
      const queue: Record<string, number> = {};
      for (const r of rows) queue[r.state] = Number(r.n);
      const active = await env.db.select({ n: count() }).from(runs).where(inArray(runs.state, ['preparing', 'spawned', 'running']));
      return { owner: env.owner, paused: !settingsNow.schedulerEnabled, inFlight: scheduler.inFlight(), queue, activeRuns: Number(active[0]?.n ?? 0) };
    },
  };
}
