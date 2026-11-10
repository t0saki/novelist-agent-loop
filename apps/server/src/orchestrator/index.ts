/**
 * lane F 公共出口 + Orchestrator 门面（API / CLI 只通过它驱动编排）。Owner: lane F。
 */
import { randomUUID } from 'node:crypto';
import { and, count, eq, gt, inArray, like } from 'drizzle-orm';
import { books, chapters, inbox as inboxTable, runs, settings, tasks } from '../db/schema.js';
import { P } from '../book/layout.js';
import { openRepo } from '../book/repo.js';
import type { PipelineContext, TaskRow, TaskSpec } from '../pipeline/types.js';
import type { BookAction, ChapterAction, FeasibilityReport, InboxItem } from './facade-types.js';
import { commitOwnerEdit, revertPartialV3 } from './committer.js';
import type { EventBus } from './bus.js';
import { enqueueSpec, execEnv, type ExecutorDeps } from './executor.js';
import { actOnInbox, createInboxItem } from './inbox.js';
import { ACTIVE_STATES, QUEUED_STATES, retryTaskRow, setTaskState } from './queue.js';
import { rewindBook } from './rewind.js';
import { chapterActionSpecs } from '../pipeline/next.js';
import type { ChapterWorkflow } from '../pipeline/workflow.js';
import { ROOT_AGENTS_PLACEHOLDER } from '../book/repo.js';
import { TRAILER } from '../book/trailers.js';
import { recoverOnStartup } from './recovery.js';
import { notify } from './notify.js';
import { checkFeasibility, loadSystemSettings, seedRouting } from './routing.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import { logFiles } from '../harness/index.js';
import { ACTIVE_RUN_STATES } from './executor.js';
import { promises as fs } from 'node:fs';
import { HttpProblem } from '../api/problem.js';
import type { BookRuntimeState } from '../pipeline/next.js';
import { resumeZeroDiffAccount } from '../flow/accounts.js';
import { clearPending, patchPending, readPending } from '../flow/state.js';

/** v3 的 nextTasks 自己读 DB，不用 BookRuntimeState */
const EMPTY_STATE: BookRuntimeState = { active: [], acceptedThrough: 0, cardsThrough: 0, publishedThrough: 0, auditedThrough: 0, productionPaused: false, openApprovals: [] };

const v3Unsupported = (): HttpProblem => new HttpProblem(409, 'v3_unsupported', '新流程的书暂不支持回退/重写（P1b 提供）');

export * from './bus.js';
export * from './queue.js';
export * from './routing.js';
export * from './quota.js';
export * from './circuit.js';
export * from './committer.js';
export * from './executor.js';
export * from './scheduler.js';
export * from './publisher.js';
export * from './inbox.js';
export * from './notify.js';
export * from './recovery.js';
export * from './orch-state.js';
export { planFailure, INFRA_CLASSES } from './actions.js';
export { defaultPipeline, type PipelineBinding } from './binding.js';
export type { BookRuntimeState } from '../pipeline/next.js';

export interface OrchestratorStatus {
  owner: string;
  paused: boolean;
  inFlight: { taskId: string; kind: string; book: string | null }[];
  queue: Record<string, number>;
  activeRuns: number;
}

export interface Orchestrator {
  bus: EventBus;
  start(): Promise<void>;
  stop(opts?: { drain?: boolean }): Promise<void>;
  /** 开书后入队首批任务 */
  startBook(bookId: string, opts: { interview: boolean }): Promise<void>;
  bookAction(bookId: string, action: BookAction): Promise<void>;
  chapterAction(bookId: string, no: number, action: ChapterAction): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  killRun(runId: string): Promise<void>;
  actInbox(id: string, action: string, note?: string, payload?: Record<string, unknown>): Promise<InboxItem>;
  publishNow(bookId: string, through?: number, ignoreAudit?: boolean): Promise<void>;
  feasibility(bookId: string | null): Promise<FeasibilityReport>;
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

  async function enqueueOne(bookId: string, spec: TaskSpec): Promise<string> {
    return (await enqueueSpec(env, await ctxFor(bookId), spec)).id;
  }

  /** v3：只把 draft / paused 改成 planning（已在写或已完结的书不重置），然后按 nextTasks 入队（只有 0 章时才会是 book.open） */
  async function startV3(bookId: string, ctx: PipelineContext): Promise<void> {
    await env.db.update(books).set({ status: 'planning', pausedReason: null, updatedAt: new Date().toISOString() }).where(and(eq(books.id, bookId), inArray(books.status, ['draft', 'paused'])));
    for (const spec of await env.pipe.nextTasks(ctx, EMPTY_STATE)) await enqueueSpec(env, ctx, spec);
  }

  async function setSystemEnabled(enabled: boolean): Promise<void> {
    const cur = await loadSystemSettings(env.db);
    const value = { ...cur, schedulerEnabled: enabled };
    await env.db.insert(settings).values({ key: 'system', value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } });
  }

  return {
    bus: deps.bus,
    scheduler,
    async start() {
      await seedRouting(env.db);
      unsubscribeNotify = env.bus.subscribe(
        (e) => {
          void loadSystemSettings(env.db)
            .then((settings) => notify(env.db, settings, e))
            .catch((err) => env.log.warn({ err: (err as Error).message }, 'notify failed'));
        },
        (e) => e.type === 'inbox_new' || e.type === 'circuit_changed' || e.type === 'quota_wait',
      );
      const recovered = await recoverOnStartup(env, reattached);
      if (recovered.reattached.length || recovered.lost.length || recovered.replayed.length) env.log.info(recovered, 'orchestrator recovered');
      if (env.config.schedulerEnabled !== false) await scheduler.start();
    },
    async stop(opts) {
      await scheduler.stop(opts);
      unsubscribeNotify?.();
      unsubscribeNotify = null;
      if (opts?.drain) await Promise.all([...reattached]);
    },
    async startBook(bookId, opts) {
      const ctx = await ctxFor(bookId);
      const book = ctx.book as NonNullable<PipelineContext['book']>;
      if (book.config.flow === 'v3') {
        await startV3(bookId, ctx);
        await notifyBook(bookId);
        return;
      }
      await env.db.update(books).set({ status: 'planning', updatedAt: new Date().toISOString() }).where(and(eq(books.id, bookId), inArray(books.status, ['draft', 'paused'])));
      for (const spec of env.pipe.initialTasks(book, opts)) await enqueueSpec(env, ctx, spec);
      await notifyBook(bookId);
    },
    async bookAction(bookId, a) {
      const now = new Date().toISOString();
      switch (a.action) {
        case 'start': {
          const ctx = await ctxFor(bookId);
          const book = ctx.book as NonNullable<PipelineContext['book']>;
          if (book.config.flow === 'v3') {
            await startV3(bookId, ctx);
            break;
          }
          await env.db.update(books).set({ status: 'planning', pausedReason: null, updatedAt: now }).where(eq(books.id, bookId));
          for (const spec of env.pipe.initialTasks(book, { interview: a.interview === true })) await enqueueSpec(env, ctx, spec);
          break;
        }
        case 'pause':
          await env.db.update(books).set({ status: 'paused', pausedReason: 'owner', updatedAt: now }).where(eq(books.id, bookId));
          break;
        case 'resume':
          await env.db.update(books).set({ status: 'active', pausedReason: null, updatedAt: now }).where(eq(books.id, bookId));
          break;
        case 'drain':
          // 停止派发新任务（等当前 run 结束）：先暂停，已在跑的不打断
          await env.db.update(books).set({ status: 'paused', pausedReason: 'drain', updatedAt: now }).where(eq(books.id, bookId));
          break;
        case 'reindex':
          await enqueueOne(bookId, { kind: 'index.rebuild', bookId, target: 'book', lane: 'system' });
          break;
        case 'rewind': {
          // 只为认出 v3：打不开的书（book.yaml 不合法、题材包没了）照旧走 v2 的回退，回退本身不需要解析配置
          const isV3 = await ctxFor(bookId).then(
            (c) => c.book?.config.flow === 'v3',
            () => false,
          );
          if (isV3) throw v3Unsupported();
          if (a.to === undefined) throw new Error('rewind 需要 to');
          await rewindBook(env, bookId, a.to, a.confirm === true);
          break;
        }
        case 'migrate':
          await enqueueOne(bookId, { kind: 'index.rebuild', bookId, target: 'migrate', lane: 'system', params: { migrate: true } });
          break;
      }
      await notifyBook(bookId);
    },
    async chapterAction(bookId, no, a) {
      const target = `c${String(no).padStart(5, '0')}`;
      const now = new Date().toISOString();
      const ownerNote = a.note ? { source: `chapter-action:${a.action}`, text: a.note } : undefined;
      const noteParams = a.note ? { ownerNote: a.note, _orch: { ownerNotes: [ownerNote] } } : {};
      const requeue = async (spec: TaskSpec): Promise<void> => {
        const { id, created } = await enqueueSpec(env, await ctxFor(bookId), spec);
        if (!created) await retryTaskRow(env.db, id, { force: true, ...(ownerNote ? { ownerNote } : {}) });
      };
      const chapterRows = await env.db.select().from(chapters).where(and(eq(chapters.bookId, bookId), eq(chapters.no, no))).limit(1);
      const chapterRow = chapterRows[0];
      const bookHandle = (await ctxFor(bookId)).book as NonNullable<PipelineContext['book']>;
      const workflow = (chapterRow?.workflow ?? {}) as Partial<ChapterWorkflow>;
      if (bookHandle.config.flow === 'v3' && (a.action === 'rewrite' || a.action === 'repair' || a.action === 'reextract')) throw v3Unsupported();
      const instance = `${a.action}-${randomUUID().slice(0, 12)}`;
      const assertNotFrozen = (): void => {
        if (chapterRow?.publishedAt && bookHandle.config.publish.freeze_on_publish && !a.confirm) throw new Error(`第 ${no} 章已发布，受 freeze_on_publish 保护；确认要修改请带 confirm=true`);
      };
      switch (a.action) {
        case 'rewrite': {
          assertNotFrozen();
          const accepted = (await env.db.select({ a: books.acceptedThrough }).from(books).where(eq(books.id, bookId)).limit(1))[0]?.a ?? 0;
          if (no <= accepted) {
            // 已验收章节：写新稿 → reextract → cascadeReplay，不走前沿 accept（否则 acceptedThrough 回退、账本错位）
            await enqueueOne(bookId, { kind: 'chapter.repair', bookId, target, lane: 'side', priority: 10, params: { instance, conflicts: [a.note?.trim() || 'owner 要求重写本章'], ...(a.note?.trim() ? { ownerNotes: [a.note] } : {}), ...(chapterRow?.publishedAt ? { allowPublished: true } : {}) } });
            break;
          }
          const liveTasks = await env.db.select({ id: tasks.id, state: tasks.state }).from(tasks).where(and(eq(tasks.bookId, bookId), eq(tasks.target, target), eq(tasks.lane, 'write'), inArray(tasks.state, [...ACTIVE_STATES, ...QUEUED_STATES])));
          if (liveTasks.some((t) => (ACTIVE_STATES as string[]).includes(t.state))) throw new Error('本章有任务正在执行，请先取消或等待结束');
          for (const t of liveTasks) await setTaskState(env.db, t.id, 'cancelled', { waitReason: 'owner_rewrite' });
          const planned = chapterActionSpecs(bookHandle, no, 'rewrite', { ...(a.note ? { note: a.note } : {}), instance, workflow });
          if (planned.chapter) await env.db.insert(chapters).values({ bookId, no, chapterId: target, state: planned.chapter.state, workflow: planned.chapter.workflow ?? {}, updatedAt: now }).onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: { state: planned.chapter.state, workflow: planned.chapter.workflow ?? {}, updatedAt: now } });
          // 前沿章由 writeLane 按 workflow.next 派发（已入队的同实例幂等）；只有前沿章才立即入队
          if (no === accepted + 1) for (const spec of planned.specs) await enqueueOne(bookId, spec);
          break;
        }
        case 'repair':
          assertNotFrozen();
          await requeue({ kind: 'chapter.repair', bookId, target, lane: 'side', params: { ...noteParams, instance, conflicts: [a.note?.trim() || '人工要求修补'], ...(chapterRow?.publishedAt ? { allowPublished: true } : {}) }, priority: 10 });
          break;
        case 'reextract':
          await requeue({ kind: 'chapter.reextract', bookId, target, lane: 'side', params: { ...noteParams, instance } });
          break;
        case 'hold':
          await env.db.update(chapters).set({ state: 'held', workflow: { ...workflow, heldFrom: chapterRow?.state ?? 'planned' }, updatedAt: now }).where(and(eq(chapters.bookId, bookId), eq(chapters.no, no)));
          break;
        case 'unhold':
        case 'approve': {
          // 找这一章的待处理项：body.target 或 related task 的 target
          const open = await env.db.select().from(inboxTable).where(and(eq(inboxTable.bookId, bookId), eq(inboxTable.state, 'open'), inArray(inboxTable.kind, ['hold', 'block', 'approval'])));
          let item = open.find((row) => (row.body as { target?: string }).target === target);
          if (!item) {
            const ids = open.map((row) => row.relatedTaskId).filter((x): x is string => !!x);
            const related = ids.length ? await env.db.select({ id: tasks.id, target: tasks.target }).from(tasks).where(inArray(tasks.id, ids)) : [];
            const match = related.find((r) => r.target === target);
            if (match) item = open.find((row) => row.relatedTaskId === match.id);
          }
          if (item) {
            const known = (item.actions as { id: string }[]).map((x) => x.id);
            // unhold 只是 approve 的别名：hold/block 的 Inbox 动作是 approve/rewrite
            await actOnInbox(env.db, env.bus, item.id, known.includes(a.action) ? a.action : 'approve', a.note);
          } else if (a.action === 'unhold') {
            // 手工 hold（无 Inbox 项）：恢复进 hold 之前的状态，writeLane 按 workflow.next 继续
            const restored = (workflow as { heldFrom?: string }).heldFrom ?? 'planned';
            const { heldFrom: _dropped, ...rest } = workflow as { heldFrom?: string };
            await env.db.update(chapters).set({ state: restored, workflow: rest, updatedAt: now }).where(and(eq(chapters.bookId, bookId), eq(chapters.no, no)));
          }
          break;
        }
        case 'publish_now':
          await enqueueOne(bookId, { kind: 'publish', bookId, target: `through-${no}`, lane: 'system', params: { through: no, ignoreAudit: a.ignoreAudit === true, manual: true } });
          break;
      }
      await notifyBook(bookId);
    },
    async retryTask(taskId) {
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
      // v3 收稿连续失败：重试 = failures 归零（任务回 ready）；放弃 = 清 pending（收到的改动留在 work/ 下，GC 保留 30 天）
      if (dedupe.startsWith('v3_pending:') && row?.bookId && (action === 'retry' || action === 'discard')) {
        const runId = String((row.body as { runId?: unknown }).runId ?? '');
        if (action === 'retry') await patchPending(env.db, row.bookId, runId, { failures: 0 });
        else {
          // 提交中途失败留下的分章提交 DB 从没计入：先撤回到 drafts/，否则下一批会按旧的 acceptedThrough 编号、把它们覆盖掉
          const pending = await readPending(env.db, row.bookId);
          const bookRows = await env.db.select({ slug: books.slug }).from(books).where(eq(books.id, row.bookId)).limit(1);
          if (pending && pending.runId === runId && bookRows[0]) {
            const reverted = await revertPartialV3(env.db, openRepo(`${env.paths.books}/${bookRows[0].slug}`), row.bookId, pending);
            if (reverted.length) {
              await createInboxItem(env.db, env.bus, {
                kind: 'notice',
                bookId: row.bookId,
                title: `第 ${reverted.join('、')} 章已提交过，已撤回到 drafts/`,
                body: { runId, chapters: reverted, detail: `放弃收稿时，这次运行已经提交的第 ${reverted.join('、')} 章从正文里撤回，原文存在 drafts/cNNNNN.discarded.md。` },
                actions: [{ id: 'dismiss', label: '知道了' }],
                dedupeKey: `v3_discard:${row.bookId}:${runId}`,
              });
            }
          }
          await clearPending(env.db, row.bookId, runId);
        }
      }
      if (row?.kind === 'agents_md_edit' && action === 'migrate' && row.bookId && row.state === 'open') {
        const bookRows = await env.db.select({ slug: books.slug }).from(books).where(eq(books.id, row.bookId)).limit(1);
        if (bookRows[0]) {
          const repo = openRepo(`${env.paths.books}/${bookRows[0].slug}`);
          const current = (await repo.readFile(P.agentsMd)) ?? '';
          const existing = (await repo.readFile(P.instructionsAgents)) ?? '';
          // 同一提交里把根 AGENTS.md 恢复成占位并带 migration trailer，否则篡改判定不解除，所有 promote 继续被拒
          await commitOwnerEdit(env.db, repo, row.bookId, {
            files: [
              { path: P.instructionsAgents, content: `${existing}\n\n<!-- 自根 AGENTS.md 迁移 -->\n${current}` },
              { path: P.agentsMd, content: ROOT_AGENTS_PLACEHOLDER },
            ],
            message: 'owner: migrate root AGENTS.md edits to instructions/AGENTS.md',
            baseSha: null,
            extraTrailers: { [TRAILER.migration]: 'agents-md' },
          });
        }
      }
      const item = await actOnInbox(env.db, env.bus, id, action, note, payload);
      if (row?.kind === 'agents_md_edit' && action === 'migrate' && row.bookId) {
        // 篡改期间被拒收的任务可能不止一个（side lane 并发），Inbox 按 dedupe 只关联第一个；其余一并放回队列，否则永远 blocked
        const rejected = await env.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, row.bookId), eq(tasks.state, 'blocked'), eq(tasks.waitReason, 'agents_md_edit')));
        for (const t of rejected) await retryTaskRow(env.db, t.id);
      }
      if (row?.bookId) await notifyBook(row.bookId);
      return item;
    },
    async publishNow(bookId, through, ignoreAudit) {
      let target = through;
      if (target === undefined) {
        const rows = await env.db.select({ a: books.acceptedThrough }).from(books).where(eq(books.id, bookId)).limit(1);
        target = rows[0]?.a ?? 0;
      }
      await enqueueOne(bookId, { kind: 'publish', bookId, target: `through-${target}`, lane: 'system', params: { through: target, ignoreAudit: ignoreAudit === true, manual: true } });
    },
    async feasibility(bookId) {
      const book = bookId ? await env.pipe.openBook(env.pdeps, bookId) : null;
      return checkFeasibility(env.db, book, { allowFakeHarness: env.config.allowFakeHarness });
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
