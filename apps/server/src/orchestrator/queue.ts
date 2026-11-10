/**
 * 任务队列（DESIGN §7.2、§7.3）：Postgres `FOR UPDATE SKIP LOCKED` 认领 + lease。Owner: lane F。
 * 幂等：enqueue 以 computeTaskId 的结果为主键，冲突即忽略。任何 DB 事务都不跨越模型调用。
 *
 * 状态：pending（依赖未满足）→ ready → leased → running → finalizing → done；
 * waiting（not_before 到期可再认领；not_before 为空 = 等外部事件，如审批）；
 * blocked（需人工）；failed（重试耗尽）；stale（hard deps 变化，作废）；cancelled。
 * attempts 只在“真正消耗了一次尝试”时增加（retry）；lost / waiting 不增加。
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Lane, TaskState } from '@novelist/shared';
import { TASK_KINDS } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { books, tasks } from '../db/schema.js';
import type { TaskResult, TaskRow, TaskSpec, Manifest } from '../runtime/types.js';
import { orchOf, withOrch, type OrchTaskState } from './orch-state.js';

export interface EnqueueInput {
  spec: TaskSpec;
  id: string;
  manifest: Manifest;
  baseCommit: string | null;
}

/** 活跃状态：占用 lane / 不能重复认领 */
export const ACTIVE_STATES: TaskState[] = ['leased', 'running', 'finalizing'];
export const QUEUED_STATES: TaskState[] = ['pending', 'ready', 'waiting'];
export const LIVE_STATES: TaskState[] = [...QUEUED_STATES, ...ACTIVE_STATES];

const CLAIM_LOCK = 0x4e56_0001;

export async function enqueue(db: Db, input: EnqueueInput): Promise<{ id: string; created: boolean }> {
  const { spec, id, manifest, baseCommit } = input;
  const deps = spec.deps ?? [];
  const state: TaskState = deps.length > 0 ? 'pending' : 'ready';
  const rows = await db
    .insert(tasks)
    .values({
      id,
      bookId: spec.bookId,
      kind: spec.kind,
      target: spec.target,
      lane: spec.lane ?? 'side',
      role: spec.role ?? null,
      priority: spec.priority ?? 0,
      deps,
      state,
      baseCommit,
      hardManifest: manifest.hard,
      softManifest: manifest.soft,
      // 旧流程的 rebase 校验已删除：列照旧写空数组（上一版镜像读得到）
      rebaseValidators: [],
      params: spec.params ?? {},
      maxAttempts: spec.maxAttempts ?? 6,
      notBefore: spec.notBefore ?? null,
      parentTaskId: spec.parentTaskId ?? null,
    })
    .onConflictDoNothing({ target: tasks.id })
    .returning({ id: tasks.id });
  if (rows.length > 0) return { id, created: true };
  // 同 id 已存在。stale 的任务被重新提议（hard deps 又变回来了）→ 复活；其余状态一律幂等忽略。
  const revived = await db
    .update(tasks)
    .set({ state, notBefore: spec.notBefore ?? null, lastError: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
    .where(and(eq(tasks.id, id), eq(tasks.state, 'stale')))
    .returning({ id: tasks.id });
  return { id, created: revived.length > 0 };
}

export interface ClaimFilter {
  lanes?: Lane[];
  /** 每本书写作 lane 最多 1 个在跑；side lane 受 committer 锁约束 */
  excludeBooksWithActiveWrite?: boolean;
  roles?: (string | null)[];
  owner: string;
  leaseMs: number;
  /** 测试注入 */
  now?: Date;
}

/**
 * 认领一个可执行任务。可执行 =（ready，或 waiting 且 not_before 已到）且 not_before 已到；
 * 书未暂停（`publish` 任务不受暂停影响；max_buffer 暂停只拦新章写作）。
 * 序：任务优先级 → 书优先级 → 存稿少的书优先（§7.5）→ 入队时间。
 * 整个认领在一个短事务里，先取 advisory xact lock，让“同书写作 lane 至多 1 个”不被并发认领突破。
 */
export async function claimNext(db: Db, f: ClaimFilter): Promise<TaskRow | null> {
  const now = (f.now ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK})`);
    const conds = [
      or(eq(tasks.state, 'ready'), and(eq(tasks.state, 'waiting'), isNotNull(tasks.notBefore))),
      or(isNull(tasks.notBefore), lte(tasks.notBefore, now)),
      sql`(${books.id} is null or ${books.status} in ('active','planning','completed') or ${tasks.kind} = 'publish')`,
      // 只认现有的任务种类，只跑 v3 书的任务（旧书、已删除的旧种类留在表里，永远认领不到；P3 D1）
      inArray(tasks.kind, [...TASK_KINDS]),
      sql`(${books.id} is null or jsonb_typeof(${books.meta}->'v3') = 'object')`,
      // v3：有主人改写请求在等、或主人要求立即写下一批（meta.v3.writeNow）的书，max_buffer 暂停也放行一批 book.write（改写要在这一批里做）；
      // 结局批也放行（不受存稿上限限制；prepare 里 buildOrderSpec 按 DB 重算，参数过时最多白跑一次 prepare）
      sql`not (coalesce(${books.pausedReason}, '') = 'max_buffer' and ${tasks.kind} in ('book.write')
        and not (${tasks.kind} = 'book.write' and (coalesce(${tasks.params}->>'mode', '') = 'finale'
          or coalesce(${books.meta}->'v3'->>'writeNow', '') = 'true'
          or jsonb_path_exists(coalesce(${books.meta}->'v3'->'ownerRequests', '[]'::jsonb), '$[*] ? (@.status == "waiting")'))))`,
    ];
    if (f.lanes && f.lanes.length > 0) conds.push(inArray(tasks.lane, f.lanes));
    if (f.roles) {
      const named = f.roles.filter((r): r is string => r !== null);
      const incNull = f.roles.includes(null);
      conds.push(or(...(named.length ? [inArray(tasks.role, named)] : []), ...(incNull ? [isNull(tasks.role)] : [])));
    }
    if (f.excludeBooksWithActiveWrite !== false) {
      conds.push(
        sql`not (${tasks.lane} = 'write' and exists (select 1 from tasks t2 where t2.book_id = ${tasks.bookId} and t2.lane = 'write' and t2.state in ('leased','running','finalizing')))`,
      );
    }
    const picked = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .leftJoin(books, eq(tasks.bookId, books.id))
      .where(and(...conds))
      // v3（DESIGN §8.2）：存稿还能撑的天数最少的先写，平手时最久没写的先写；旧流程的任务仍按存稿章数
      .orderBy(
        desc(tasks.priority),
        desc(sql`coalesce(${books.priority}, 0)`),
        asc(
          sql`case when ${tasks.kind} in ('book.open','book.write','book.retro') then coalesce((${books.meta}->'v3'->'sched'->>'bufferDays')::float8, 999) else coalesce(${books.acceptedThrough} - ${books.publishedThrough}, 0) end`,
        ),
        asc(sql`case when ${tasks.kind} in ('book.open','book.write','book.retro') then coalesce(${books.meta}->'v3'->>'lastBatchAt', '') else '' end`),
        asc(tasks.createdAt),
      )
      .limit(1)
      .for('update', { of: tasks, skipLocked: true });
    const first = picked[0];
    if (!first) return null;
    const expires = new Date((f.now ?? new Date()).getTime() + f.leaseMs).toISOString();
    const rows = await tx
      .update(tasks)
      .set({ state: 'leased', leaseOwner: f.owner, leaseExpiresAt: expires, waitReason: null, notBefore: null, updatedAt: now })
      .where(eq(tasks.id, first.id))
      .returning();
    return (rows[0] ?? null) as TaskRow | null;
  });
}

export async function renewLease(db: Db, taskId: string, owner: string, leaseMs: number): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(), updatedAt: new Date().toISOString() })
    .where(and(eq(tasks.id, taskId), eq(tasks.leaseOwner, owner)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/** 重试退避：2^attempts × base（默认 30 秒），上限 30 分钟，±10% 抖动（错峰） */
export function backoffMs(attempts: number, baseMs = 30_000, rng: () => number = Math.random): number {
  const exp = Math.min(30 * 60_000, baseMs * 2 ** Math.max(0, attempts));
  return Math.round(exp * (0.9 + rng() * 0.2));
}

export interface CompleteOptions {
  now?: Date;
  backoffBaseMs?: number;
}

/** 按 TaskResult 落终态 / 重试（attempts+1，not_before=退避）/ waiting / blocked */
export async function completeTask(db: Db, taskId: string, result: TaskResult, opts?: CompleteOptions): Promise<TaskState> {
  const nowDate = opts?.now ?? new Date();
  const now = nowDate.toISOString();
  const rows = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)) as TaskRow[];
  const task = rows[0];
  if (!task) throw new Error(`completeTask: no such task ${taskId}`);
  const orch: OrchTaskState = { ...orchOf(task) };
  delete orch.recover;

  let state: TaskState;
  let attempts = task.attempts;
  let notBefore: string | null = null;
  let waitReason: string | null = null;
  switch (result.status) {
    case 'done':
      state = 'done';
      break;
    case 'failed':
      state = 'failed';
      break;
    case 'blocked':
      state = 'blocked';
      waitReason = result.message ?? 'blocked';
      break;
    case 'waiting':
      state = 'waiting';
      notBefore = result.retryAfter ?? null;
      waitReason = result.message ?? 'waiting';
      break;
    case 'retry':
      attempts += 1;
      if (attempts >= task.maxAttempts) {
        state = 'failed';
      } else {
        state = 'ready';
        notBefore = result.retryAfter ?? new Date(nowDate.getTime() + backoffMs(attempts - 1, opts?.backoffBaseMs)).toISOString();
      }
      break;
  }
  const terminal = state === 'done' || state === 'failed';
  const persistedResult: Record<string, unknown> = {
    status: result.status,
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.errorClass ? { errorClass: result.errorClass } : {}),
    ...(result.followups?.length ? { followups: result.followups } : {}),
    ...(result.inbox?.length ? { inbox: result.inbox } : {}),
  };
  // outbox：完成后还要投递的副作用（followups/inbox/onTaskDone）；崩溃后 tick 补投
  if (result.status === 'done' || result.followups?.length || result.inbox?.length) orch.outbox = true;

  // tasks 终态在一个事务里落地（后继任务由 outbox 投递）
  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        state,
        attempts,
        notBefore,
        waitReason,
        params: withOrch(task.params, orch),
        result: persistedResult,
        lastErrorClass: result.errorClass ?? (result.status === 'done' ? null : task.lastErrorClass),
        lastError: result.status === 'waiting' ? task.lastError : (result.message ?? (result.status === 'done' ? null : task.lastError)),
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: terminal ? now : null,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId));
  });
  return state;
}

export async function setTaskState(db: Db, taskId: string, state: TaskState, extra?: { waitReason?: string; notBefore?: string; error?: string }): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(tasks)
    .set({
      state,
      ...(extra?.waitReason !== undefined ? { waitReason: extra.waitReason } : {}),
      ...(extra?.notBefore !== undefined ? { notBefore: extra.notBefore } : {}),
      ...(extra?.error !== undefined ? { lastError: extra.error } : {}),
      ...(['leased', 'running', 'finalizing'].includes(state) ? {} : { leaseOwner: null, leaseExpiresAt: null }),
      ...(state === 'done' || state === 'failed' || state === 'cancelled' ? { finishedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(tasks.id, taskId));
}

/** lease 过期的任务回到 ready（runner 崩溃）；run 仍存活的由 reattach 接管（调用方先做 reattach） */
export async function reapExpiredLeases(db: Db, now: Date, excludeTasks: string[] = []): Promise<string[]> {
  const rows = (await db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.state, ACTIVE_STATES), isNotNull(tasks.leaseExpiresAt), lte(tasks.leaseExpiresAt, now.toISOString())))) as TaskRow[];
  const ids: string[] = [];
  for (const t of rows) {
    if (excludeTasks.includes(t.id)) continue;
    const params = t.state === 'finalizing' ? withOrch(t.params, { recover: orchOf(t).recover ?? { mode: 'repromote' } }) : t.params;
    const updated = await db
      .update(tasks)
      .set({ state: 'ready', params, leaseOwner: null, leaseExpiresAt: null, waitReason: `lease expired (${t.state})`, updatedAt: now.toISOString() })
      .where(and(eq(tasks.id, t.id), eq(tasks.state, t.state as TaskState)))
      .returning({ id: tasks.id });
    if (updated.length > 0) ids.push(t.id);
  }
  return ids;
}

/** pending → ready（依赖全部 done）；依赖 stale → 自身 stale；依赖 failed/cancelled → blocked。返回变化的 id */
export async function advancePending(db: Db): Promise<string[]> {
  const pending = (await db.select().from(tasks).where(eq(tasks.state, 'pending'))) as TaskRow[];
  if (pending.length === 0) return [];
  const depIds = [...new Set(pending.flatMap((t) => t.deps))];
  const depRows = depIds.length ? await db.select({ id: tasks.id, state: tasks.state }).from(tasks).where(inArray(tasks.id, depIds)) : [];
  const stateOf = new Map(depRows.map((r) => [r.id, r.state]));
  const changed: string[] = [];
  const now = new Date().toISOString();
  for (const t of pending) {
    const states = t.deps.map((d) => stateOf.get(d) ?? 'missing');
    let next: TaskState | null = null;
    let reason: string | undefined;
    if (states.every((s) => s === 'done')) next = 'ready';
    else if (states.some((s) => s === 'stale' || s === 'missing')) next = 'stale';
    else if (states.some((s) => s === 'failed' || s === 'cancelled')) {
      next = 'blocked';
      reason = 'dependency_failed';
    }
    if (!next) continue;
    await db
      .update(tasks)
      .set({ state: next, waitReason: reason ?? null, updatedAt: now })
      .where(and(eq(tasks.id, t.id), eq(tasks.state, 'pending')));
    changed.push(t.id);
  }
  return changed;
}

/** owner 手动重试：不论 failed/blocked/cancelled/stale 都回到 ready，attempts 归零，代数 +1；依赖它而 blocked 的任务回到 pending */
export async function retryTaskRow(db: Db, taskId: string, opts?: { force?: boolean }): Promise<boolean> {
  const rows = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)) as TaskRow[];
  const task = rows[0];
  if (!task || (!opts?.force && !['failed', 'blocked', 'cancelled', 'stale', 'waiting'].includes(task.state))) return false;
  if (opts?.force && ['leased', 'running', 'finalizing'].includes(task.state)) return false;
  const orch = orchOf(task);
  const now = new Date().toISOString();
  await db
    .update(tasks)
    .set({
      state: 'ready',
      attempts: 0,
      notBefore: null,
      waitReason: null,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
      params: withOrch(task.params, { generation: (orch.generation ?? 1) + 1, transient: 0, classCounts: {}, recover: undefined, outbox: undefined }),
      updatedAt: now,
    })
    .where(eq(tasks.id, taskId));
  await db
    .update(tasks)
    .set({ state: 'pending', waitReason: null, updatedAt: now })
    .where(and(eq(tasks.state, 'blocked'), eq(tasks.waitReason, 'dependency_failed'), sql`${taskId} = any(${tasks.deps})`));
  return true;
}
