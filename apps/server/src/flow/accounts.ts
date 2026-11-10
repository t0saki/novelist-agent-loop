/**
 * v3 空跑记账（docs/v3/DESIGN.md §8.2“空跑算在账号头上”；p1-plan §2.11）。
 * 每个账号一行 settings（key `flow.v3.zeroDiff:<accountKey>`），单条 upsert 原子更新，不同账号的并发 run 互不覆盖。
 * 连续 2 次空跑暂停账号（7 天兜底）并进待办；正常出口是待办里的“恢复账号”。
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { accountsState, settings } from '../db/schema.js';
import type { InboxInput } from '../pipeline/types.js';

/** backstop only; the inbox "恢复" action is the normal way out */
export const ZERO_DIFF_PAUSE_MS = 7 * 24 * 3600_000;

const keyOf = (accountKey: string) => `flow.v3.zeroDiff:${accountKey}`;

/** accountId，没有账号的 profile 用 `profile:<id>` */
export function zeroDiffAccountKey(accountId: string | null, profileId: string): string {
  return accountId ?? `profile:${profileId}`;
}

/** One atomic upsert on settings key `flow.v3.zeroDiff:<accountKey>`; returns the new streak (0 when !zeroDiff). */
export async function bumpZeroDiff(db: Db, accountKey: string, zeroDiff: boolean, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const rows = await db
    .insert(settings)
    .values({ key: keyOf(accountKey), value: { streak: zeroDiff ? 1 : 0, lastAt: nowIso } })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`jsonb_build_object('streak', case when ${zeroDiff}::boolean then coalesce((${settings.value}->>'streak')::int, 0) + 1 else 0 end, 'lastAt', ${nowIso}::text)`,
        updatedAt: nowIso,
      },
    })
    .returning({ streak: sql<number>`(${settings.value}->>'streak')::int` });
  return Number(rows[0]?.streak ?? 0);
}

export async function resetZeroDiff(db: Db, accountKey: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await db
    .insert(settings)
    .values({ key: keyOf(accountKey), value: { streak: 0, lastAt: nowIso } })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`jsonb_build_object('streak', 0, 'lastAt', ${nowIso}::text)`, updatedAt: nowIso } });
}

/** 当前连击（没有记录 = 0） */
export async function readZeroDiff(db: Db, accountKey: string): Promise<number> {
  const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, keyOf(accountKey))).limit(1);
  const v = rows[0]?.value as { streak?: unknown } | undefined;
  return typeof v?.streak === 'number' ? v.streak : 0;
}

/** 待办“恢复账号”：清掉账号的 sleep_until 并把空跑连击归零（orchestrator actInbox 调用） */
export async function resumeZeroDiffAccount(db: Db, accountId: string): Promise<void> {
  await db.update(accountsState).set({ sleepUntil: null, sleepReason: null, updatedAt: new Date().toISOString() }).where(eq(accountsState.accountId, accountId));
  await resetZeroDiff(db, accountId);
}

export function zeroDiffInbox(accountId: string, streak: number, stderrTail: string): InboxInput {
  const tail = stderrTail.split('\n').slice(-20).join('\n');
  return {
    kind: 'notice',
    bookId: null,
    title: `账号 ${accountId} 连续 ${streak} 次空跑，已暂停`,
    body: { accountId, stderrTail: tail },
    dedupeKey: `zero_diff:${accountId}`,
    actions: [
      { id: 'resume', label: '恢复账号' },
      { id: 'dismiss', label: '知道了' },
    ],
  };
}
