/**
 * 待办（DESIGN §8.3）：账号认证 / 额度、没有可用路由、写不出正文等，同类按“种类 + 书”合并。
 *
 * 动作语义（body.on[action] 可覆盖默认）：
 *   body.on = { <actionId>: { task?: 'done'|'ready'|'cancelled'; chapter?: {no,state};
 *                              book?: Partial<{status,pausedReason,writerProfile}>; meta?: Record<string,unknown>（合并进 books.meta） } }
 * 无 on 时按动作名的默认表：
 *   approve/accept/unblock/continue → 相关任务 done（走 onTaskDone）
 *   retry/rewrite/rerun → 相关任务重新 ready（代数 +1）
 *   reject/abandon/cancel → 相关任务 cancelled；skip → 相关任务 done（summary.skipped）
 *   dismiss → 只关闭本项
 * 所有动作都不跨越模型调用。旧库里还开着的审批、熔断之类由开机迁移关掉（boot/migrate-p3.ts M3）。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { InboxItem } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { books, chapters, inbox, tasks } from '../db/schema.js';
import type { InboxInput, TaskRow } from '../runtime/types.js';
import type { TaskState } from '@novelist/shared';
import type { EventBus } from './bus.js';
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

/**
 * 同类按“种类 + 书”合并（v3，DESIGN §8.3）：已有同 dedupeKey 的 open 项 → 只更新标题、正文、动作和相关任务（不再发通知）；没有 → createInboxItem。
 * 没有 dedupeKey 时等同 createInboxItem。
 */
export async function upsertOpenInbox(db: Db, bus: EventBus, input: InboxInput): Promise<InboxItem> {
  if (!input.dedupeKey) return createInboxItem(db, bus, input);
  const updated = await db
    .update(inbox)
    .set({ title: input.title, body: input.body, actions: input.actions, ...(input.relatedTaskId !== undefined ? { relatedTaskId: input.relatedTaskId } : {}) })
    .where(and(eq(inbox.dedupeKey, input.dedupeKey), eq(inbox.state, 'open')))
    .returning();
  if (updated[0]) return toDto(updated[0], await slugOf(db, updated[0].bookId));
  return createInboxItem(db, bus, input);
}

/** 条件消失，自动关闭：state 'resolved'，resolution { auto: true, reason } */
export async function resolveInboxAuto(db: Db, id: string, reason: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await db
    .update(inbox)
    .set({ state: 'resolved', resolution: { auto: true, reason, ts: nowIso }, resolvedAt: nowIso })
    .where(and(eq(inbox.id, id), eq(inbox.state, 'open')));
}

export interface ActionEffect {
  task?: 'done' | 'ready' | 'cancelled' | 'none';
  chapter?: { no: number; state: string; workflow?: Record<string, unknown> };
  book?: { status?: string; pausedReason?: string | null; writerProfile?: string };
  meta?: Record<string, unknown>;
}

const DONE_ACTIONS = new Set(['approve', 'accept', 'accept_with_debt', 'unblock', 'unhold', 'continue', 'ok']);
const READY_ACTIONS = new Set(['rewrite_with_note', 'retry', 'rewrite', 'revise', 'rerun']);
const CANCEL_ACTIONS = new Set(['reject', 'abandon', 'cancel']);

function defaultEffect(item: InboxRow, action: string): ActionEffect {
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
          recover: undefined,
        }),
        updatedAt: now,
      })
      .where(cas);
  }
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

  const resolution: Record<string, unknown> = { action, ...(note ? { note } : {}), ...(payload ? { payload } : {}), ts: new Date().toISOString() };
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
    const workflow = effect.chapter.workflow;
    await db
      .update(chapters)
      .set({ state: effect.chapter.state, ...(workflow ? { workflow } : {}), updatedAt: new Date().toISOString() })
      .where(and(eq(chapters.bookId, item.bookId), eq(chapters.no, effect.chapter.no)));
  }
  if (effect.book && item.bookId) await db.update(books).set({ ...effect.book, updatedAt: new Date().toISOString() }).where(eq(books.id, item.bookId));
  if (effect.meta && item.bookId) await db.update(books).set({ meta: sql`${books.meta} || ${JSON.stringify(effect.meta)}::jsonb`, updatedAt: new Date().toISOString() }).where(eq(books.id, item.bookId));

  return toDto(updated[0], slug);
}

export async function dismissInbox(db: Db, id: string): Promise<void> {
  await db.update(inbox).set({ state: 'dismissed', resolvedAt: new Date().toISOString() }).where(and(eq(inbox.id, id), eq(inbox.state, 'open')));
}
