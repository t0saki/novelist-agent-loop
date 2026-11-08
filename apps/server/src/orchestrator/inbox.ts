/**
 * Inbox（DESIGN §7.8）：审批门（timeout / on_timeout）、hold/block、questions、auth、配额、熔断提案。Owner: lane F。
 *
 * 动作语义（body.on[action] 可覆盖默认）：
 *   body.on = { <actionId>: { task?: 'done'|'ready'|'cancelled'; followups?: TaskSpec[]; chapter?: {no,state};
 *                              book?: Partial<{status,pausedReason,writerProfile}>; circuit?: 'open'|'close';
 *                              meta?: Record<string,unknown>（合并进 books.meta） } }
 * 无 on 时按动作名的默认表：
 *   approve/accept/accept_with_debt/unblock/unhold/continue → 相关任务 done（走 onTaskDone）
 *   rewrite_with_note/retry/rewrite/revise → 相关任务重新 ready（note 进 L3.9，代数 +1）
 *   reject/abandon/cancel → 相关任务 cancelled；skip → 相关任务 done（summary.skipped）
 *   veto（熔断 Inbox）→ 关闭熔断；dismiss → 只关闭本项
 * 所有动作都不跨越模型调用；需要 followups 入队的动作走 outbox（drainInbox 由 scheduler tick 调用）。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { InboxItem } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { books, chapters, inbox, tasks } from '../db/schema.js';
import type { InboxInput, TaskRow, TaskSpec } from '../pipeline/types.js';
import type { TaskState } from '@novelist/shared';
import type { EventBus } from './bus.js';
import { closeCircuit, openCircuit } from './circuit.js';
import { orchOf, withOrch } from './orch-state.js';
import { ACTIVE_STATES, setTaskState } from './queue.js';

type InboxRow = typeof inbox.$inferSelect;

function toDto(row: InboxRow, slug: string | null): InboxItem {
  return {
    id: row.id,
    bookSlug: slug,
    kind: row.kind as InboxItem['kind'],
    title: row.title,
    body: row.body,
    state: row.state as InboxItem['state'],
    actions: (row.actions ?? []) as InboxItem['actions'],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    timeoutAt: row.timeoutAt,
  };
}

async function slugOf(db: Db, bookId: string | null): Promise<string | null> {
  if (!bookId) return null;
  const rows = await db.select({ slug: books.slug }).from(books).where(eq(books.id, bookId)).limit(1);
  return rows[0]?.slug ?? null;
}

export async function createInboxItem(db: Db, bus: EventBus, input: InboxInput): Promise<InboxItem> {
  const id = randomUUID();
  const rows = await db
    .insert(inbox)
    .values({
      id,
      bookId: input.bookId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      actions: input.actions,
      dedupeKey: input.dedupeKey ?? null,
      relatedTaskId: input.relatedTaskId ?? null,
      timeoutAt: input.timeoutAt ?? null,
      onTimeout: input.onTimeout ?? 'wait',
    })
    .onConflictDoNothing()
    .returning();
  const slug = await slugOf(db, input.bookId);
  const created = rows[0];
  if (created) {
    const item = toDto(created, slug);
    bus.publish({ type: 'inbox_new', item });
    return item;
  }
  // dedupe：已有同 dedupe_key 的 open 项，直接返回它
  const existing = await db
    .select()
    .from(inbox)
    .where(and(eq(inbox.dedupeKey, input.dedupeKey ?? '__none__'), eq(inbox.state, 'open')))
    .limit(1);
  if (!existing[0]) throw new Error('inbox insert conflict without open item');
  return toDto(existing[0], slug);
}

export interface ActionEffect {
  task?: 'done' | 'ready' | 'cancelled' | 'none';
  followups?: TaskSpec[];
  chapter?: { no: number; state: string; workflow?: Record<string, unknown> };
  book?: { status?: string; pausedReason?: string | null; writerProfile?: string };
  circuit?: 'open' | 'close';
  meta?: Record<string, unknown>;
}

const DONE_ACTIONS = new Set(['approve', 'accept', 'accept_with_debt', 'unblock', 'unhold', 'continue', 'ok']);
const READY_ACTIONS = new Set(['rewrite_with_note', 'retry', 'rewrite', 'revise', 'rerun']);
const CANCEL_ACTIONS = new Set(['reject', 'abandon', 'cancel']);

function defaultEffect(item: InboxRow, action: string): ActionEffect {
  if (item.kind === 'circuit') {
    if (action === 'veto') return { circuit: 'close', task: 'none' };
    if (action === 'approve' || action === 'open_now') return { circuit: 'open', task: 'none' };
  }
  if (action === 'skip') return { task: 'done' };
  if (DONE_ACTIONS.has(action)) return { task: 'done' };
  if (READY_ACTIONS.has(action)) return { task: 'ready' };
  if (CANCEL_ACTIONS.has(action)) return { task: 'cancelled' };
  return { task: 'none' };
}

async function applyTaskEffect(db: Db, taskId: string, effect: 'done' | 'ready' | 'cancelled', item: InboxRow, action: string, note: string | undefined): Promise<void> {
  const rows = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)) as TaskRow[];
  const task = rows[0];
  if (!task || task.state === 'done' || task.state === 'cancelled' || ACTIVE_STATES.includes(task.state as TaskState)) return;
  const now = new Date().toISOString();
  const cas = and(eq(tasks.id, taskId), eq(tasks.state, task.state as TaskState));
  const orch = orchOf(task);
  if (effect === 'done') {
    await db
      .update(tasks)
      .set({
        state: 'done',
        waitReason: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
        result: { status: 'done', summary: { inbox: action, ...(note ? { note } : {}), ...(action === 'skip' ? { skipped: true } : {}) } },
        params: withOrch(task.params, { outbox: true }),
        updatedAt: now,
      })
      .where(cas);
  } else if (effect === 'cancelled') {
    await setTaskState(db, taskId, 'cancelled', { waitReason: `inbox:${action}` });
  } else {
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
        params: withOrch(task.params, {
          generation: (orch.generation ?? 1) + 1,
          ...(note ? { ownerNotes: [...(orch.ownerNotes ?? []), { source: `inbox:${item.id}`, text: note }] } : {}),
          recover: undefined,
        }),
        updatedAt: now,
      })
      .where(cas);
  }
}

/** 把 owner 笔记附到 followup（collectOwnerNotes 读 params.ownerNotes） */
function withNote(params: Record<string, unknown> | undefined, note: string | undefined): Record<string, unknown> {
  const p = params ?? {};
  if (!note?.trim()) return p;
  const prior = Array.isArray(p.ownerNotes) ? (p.ownerNotes as string[]) : [];
  return { ...p, ownerNotes: [...prior, note] };
}

/** 执行动作（approve / reject / rewrite_with_note / accept_with_debt / unblock / migrate …），返回更新后的项，并入队后续任务 */
export async function actOnInbox(db: Db, bus: EventBus, id: string, action: string, note?: string, payload?: Record<string, unknown>): Promise<InboxItem> {
  const rows = await db.select().from(inbox).where(eq(inbox.id, id)).limit(1);
  const item = rows[0];
  if (!item) throw new Error(`inbox item not found: ${id}`);
  const slug = await slugOf(db, item.bookId);
  if (item.state !== 'open') return toDto(item, slug);
  const known = (item.actions as { id: string }[]).map((a) => a.id);
  if (known.length > 0 && !known.includes(action) && action !== 'dismiss') throw new Error(`unknown inbox action: ${action}`);

  const on = (item.body?.on ?? {}) as Record<string, ActionEffect>;
  const effect: ActionEffect = on[action] ?? defaultEffect(item, action);

  // 在跑的任务不能被 retry/cancel 重置，直接拒绝（不关单）
  if (item.relatedTaskId && effect.task && effect.task !== 'none') {
    const related = await db.select({ state: tasks.state }).from(tasks).where(eq(tasks.id, item.relatedTaskId)).limit(1);
    if (related[0] && ACTIVE_STATES.includes(related[0].state as TaskState)) throw new Error('相关任务正在执行中，请等它结束后再操作');
  }

  const followups = (effect.followups ?? []).map((f) => ({ ...f, params: withNote(f.params, note) }));
  const resolution: Record<string, unknown> = { action, ...(note ? { note } : {}), ...(payload ? { payload } : {}), ts: new Date().toISOString(), ...(followups.length ? { followups, followupsPending: true } : {}) };
  // 先 CAS 关单：双击或超时扫描并发时只有一方拿到这一行，效果只执行一次
  const updated = await db
    .update(inbox)
    .set({ state: 'resolved', resolution, resolvedAt: new Date().toISOString() })
    .where(and(eq(inbox.id, id), eq(inbox.state, 'open')))
    .returning();
  if (!updated[0]) {
    const latest = await db.select().from(inbox).where(eq(inbox.id, id)).limit(1);
    return toDto(latest[0] ?? item, slug);
  }

  if (item.relatedTaskId && effect.task && effect.task !== 'none') await applyTaskEffect(db, item.relatedTaskId, effect.task, item, action, note);
  if (effect.chapter && item.bookId) {
    let workflow = effect.chapter.workflow;
    if (workflow && (workflow as { next?: { params?: Record<string, unknown> } }).next) {
      const next = (workflow as { next: { params?: Record<string, unknown> } }).next;
      workflow = { ...workflow, next: { ...next, params: withNote(next.params, note) } };
    }
    await db
      .update(chapters)
      .set({ state: effect.chapter.state, ...(workflow ? { workflow } : {}), updatedAt: new Date().toISOString() })
      .where(and(eq(chapters.bookId, item.bookId), eq(chapters.no, effect.chapter.no)));
  }
  if (effect.book && item.bookId) await db.update(books).set({ ...effect.book, updatedAt: new Date().toISOString() }).where(eq(books.id, item.bookId));
  if (effect.meta && item.bookId) await db.update(books).set({ meta: sql`${books.meta} || ${JSON.stringify(effect.meta)}::jsonb`, updatedAt: new Date().toISOString() }).where(eq(books.id, item.bookId));
  if (effect.circuit) {
    const c = item.body as { harness?: string; version?: string; isolation?: string; reason?: string };
    if (c.harness && c.version !== undefined && c.isolation) {
      if (effect.circuit === 'close') await closeCircuit(db, c.harness, c.version, c.isolation);
      else await openCircuit(db, c.harness, c.version, c.isolation, c.reason ?? 'owner approved');
    }
  }

  // 失败切换：批准 → 书级写手改为提案的 profile
  const failover = item.body?.failover as { to?: string } | undefined;
  if (failover?.to && item.bookId && (action === 'approve' || action === 'accept')) await db.update(books).set({ writerProfile: failover.to, updatedAt: new Date().toISOString() }).where(eq(books.id, item.bookId));

  return toDto(updated[0], slug);
}

export async function dismissInbox(db: Db, id: string): Promise<void> {
  await db.update(inbox).set({ state: 'dismissed', resolvedAt: new Date().toISOString() }).where(and(eq(inbox.id, id), eq(inbox.state, 'open')));
}

export async function expireInboxTimeouts(db: Db, bus: EventBus, now: Date): Promise<number> {
  const rows = await db
    .select()
    .from(inbox)
    .where(and(eq(inbox.state, 'open'), isNotNull(inbox.timeoutAt), lte(inbox.timeoutAt, now.toISOString()), ne(inbox.onTimeout, 'wait')));
  let n = 0;
  for (const row of rows) {
    const action = row.onTimeout === 'auto_approve' ? 'approve' : 'skip';
    const actions = (row.actions as { id: string }[]).map((a) => a.id);
    await db.update(inbox).set({ actions: actions.includes(action) ? row.actions : [...(row.actions as unknown[]), { id: action, label: action }] }).where(eq(inbox.id, row.id));
    await actOnInbox(db, bus, row.id, action, undefined, { auto: true, reason: 'timeout' });
    await db.update(inbox).set({ state: 'expired' }).where(and(eq(inbox.id, row.id), eq(inbox.state, 'resolved')));
    n += 1;
  }
  return n;
}

/** 待入队的 inbox followups（outbox） */
export async function pendingInboxFollowups(db: Db): Promise<{ id: string; followups: TaskSpec[] }[]> {
  const rows = await db.select().from(inbox).where(sql`${inbox.resolution}->>'followupsPending' = 'true'`);
  return rows.map((r) => ({ id: r.id, followups: ((r.resolution as { followups?: TaskSpec[] } | null)?.followups ?? []) }));
}

export async function clearInboxFollowups(db: Db, id: string): Promise<void> {
  await db.update(inbox).set({ resolution: sql`(${inbox.resolution} - 'followupsPending')` }).where(eq(inbox.id, id));
}
