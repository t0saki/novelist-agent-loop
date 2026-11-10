/**
 * 配额与用量（DESIGN §8.2）：订阅窗口占用率来自 harness 的 rate_limit 信号；窗口耗尽 → 账号睡到恢复时间；每次 run 写 usage_ledger。
 * 不做预留（旧的 quota_reservations 表留着、不再写）。书级预算（book.yaml budgets）照旧在开跑前检查。
 * 占用率单位：百分比 0–100（harness 上报 0–1 的小数时在 recordRateLimit 归一）。
 */
import { and, eq, gte } from 'drizzle-orm';
import type { Account, Outcome } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { accountsState, quotaSnapshots, usageLedger } from '../db/schema.js';
import type { BookHandle } from '../runtime/types.js';

interface UtilEntry {
  utilization: number | null;
  resetsAt: string | null;
  ts: string;
}

/** 记一条 rate_limit 信号（run 事件 / outcome）：更新 accounts_state.util + quota_snapshots；rejected 且有 resetsAt → sleep */
export async function recordRateLimit(db: Db, accountId: string, input: { window: string; utilization?: number; resetsAt?: string; status?: string; source?: string; now?: Date }): Promise<{ slept: boolean; until: string | null }> {
  const now = (input.now ?? new Date()).toISOString();
  const pct = input.utilization === undefined ? null : input.utilization <= 1 ? input.utilization * 100 : input.utilization;
  await db.transaction(async (tx) => {
    await tx.insert(accountsState).values({ accountId, util: {} }).onConflictDoNothing({ target: accountsState.accountId });
    const rows = await tx.select().from(accountsState).where(eq(accountsState.accountId, accountId)).limit(1).for('update');
    const prev = ((rows[0]?.util ?? {}) as Record<string, UtilEntry>)[input.window];
    // 上报没带 utilization 时保留已知值（否则会把事件里的占用率抹掉）
    const entry: UtilEntry = { utilization: pct ?? prev?.utilization ?? null, resetsAt: input.resetsAt ?? prev?.resetsAt ?? null, ts: now };
    const util = { ...((rows[0]?.util ?? {}) as Record<string, UtilEntry>), [input.window]: entry };
    await tx.update(accountsState).set({ util, updatedAt: now }).where(eq(accountsState.accountId, accountId));
    await tx.insert(quotaSnapshots).values({ accountId, window: input.window, utilization: pct, resetsAt: input.resetsAt ?? null, source: input.source ?? 'event', ts: now });
  });
  if (input.status === 'rejected') {
    const until = input.resetsAt ?? new Date(new Date(now).getTime() + 3600_000).toISOString();
    await sleepAccount(db, accountId, until, `窗口 ${input.window} 已耗尽`);
    return { slept: true, until };
  }
  return { slept: false, until: null };
}

/** run 结束：写 usage_ledger、解析 rate_limit 信号（resetsAt → sleep_until）、算窗口占用增量 */
export async function settle(
  db: Db,
  input: {
    runId: string;
    accountId: string | null;
    profileId: string;
    harness: string;
    model: string | null;
    kind: string;
    bookId: string | null;
    outcome: Outcome;
    /** run 开始时的窗口占用率（算 util_delta） */
    utilBefore?: Record<string, number>;
    /** API key 账号才记 USD */
    billUsd?: boolean;
    now?: Date;
  },
): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  let slept = false;
  const utilDelta: Record<string, number> = {};
  if (input.accountId) {
    for (const rl of input.outcome.rateLimits) {
      const r = await recordRateLimit(db, input.accountId, { window: rl.window, status: rl.status, source: 'outcome', ...(rl.utilization !== undefined ? { utilization: rl.utilization } : {}), ...(rl.resetsAt ? { resetsAt: rl.resetsAt } : {}) });
      slept ||= r.slept;
    }
    const rows = await db.select().from(accountsState).where(eq(accountsState.accountId, input.accountId)).limit(1);
    const util = (rows[0]?.util ?? {}) as Record<string, UtilEntry>;
    for (const [w, before] of Object.entries(input.utilBefore ?? {})) {
      const after = util[w]?.utilization;
      if (after !== null && after !== undefined && after >= before) utilDelta[w] = after - before;
    }
    if (input.outcome.status === 'failed' && input.outcome.errorClass === 'quota' && !slept) {
      await sleepAccount(db, input.accountId, input.outcome.retryAfter ?? new Date(Date.now() + 3600_000).toISOString(), input.outcome.message ?? 'quota');
    }
  }
  const u = input.outcome.usage;
  await db.insert(usageLedger).values({
    accountId: input.accountId,
    profileId: input.profileId,
    harness: input.harness,
    model: input.model,
    taskKind: input.kind,
    bookId: input.bookId,
    runId: input.runId,
    input: Math.round(u.input),
    cached: Math.round(u.cachedInput),
    cacheWrite: Math.round(u.cacheWrite),
    output: Math.round(u.output),
    reasoning: Math.round(u.reasoning),
    utilDelta,
    usd: input.billUsd && u.costUsd !== undefined ? u.costUsd : null,
    ts: now,
  });
}

/** 取账号当前各窗口的占用率（算 util_delta 的基线） */
export async function utilSnapshot(db: Db, accountId: string): Promise<Record<string, number>> {
  const rows = await db.select({ util: accountsState.util }).from(accountsState).where(eq(accountsState.accountId, accountId)).limit(1);
  const out: Record<string, number> = {};
  for (const [w, e] of Object.entries((rows[0]?.util ?? {}) as Record<string, UtilEntry>)) if (e.utilization !== null && e.utilization !== undefined) out[w] = e.utilization;
  return out;
}

export async function sleepAccount(db: Db, accountId: string, until: string | null, reason: string): Promise<void> {
  const at = until ?? new Date(Date.now() + 3600_000).toISOString();
  const now = new Date().toISOString();
  await db.insert(accountsState).values({ accountId, sleepUntil: at, sleepReason: reason }).onConflictDoUpdate({ target: accountsState.accountId, set: { sleepUntil: at, sleepReason: reason, updatedAt: now } });
}

/** 标记账号认证失效（路由跳过，直到账号页重新登录 / verify 成功） */
export async function markAuthBad(db: Db, accountId: string, detail: string): Promise<void> {
  const now = new Date().toISOString();
  const lastAuthCheck = { ok: false, ts: now, detail };
  await db.insert(accountsState).values({ accountId, lastAuthCheck }).onConflictDoUpdate({ target: accountsState.accountId, set: { lastAuthCheck, updatedAt: now } });
}

export interface BudgetVerdict {
  ok: boolean;
  waitUntil: string | null;
  reason: string | null;
}

const WINDOW_MS: Record<string, number> = { '5h': 5 * 3600_000, '7d': 7 * 86400_000, daily: 86400_000, model_7d: 7 * 86400_000 };

function nextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** 书级预算：monthly_usd_cap / max_window_util_pct（book.yaml budgets；v3 书照样生效，D20） */
export async function checkBookBudget(db: Db, book: BookHandle, now: Date): Promise<BudgetVerdict> {
  const b = book.config.budgets;
  if (b.monthly_usd_cap !== undefined) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const rows = await db.select({ usd: usageLedger.usd }).from(usageLedger).where(and(eq(usageLedger.bookId, book.id), gte(usageLedger.ts, monthStart)));
    const spent = rows.reduce((a, r) => a + (r.usd ?? 0), 0);
    if (spent >= b.monthly_usd_cap) return { ok: false, waitUntil: nextMonthUtc(now).toISOString(), reason: `已达月度 USD 上限 ${b.monthly_usd_cap}` };
  }
  if (b.max_window_util_pct !== undefined) {
    for (const [window, ms] of Object.entries(WINDOW_MS)) {
      const since = new Date(now.getTime() - ms).toISOString();
      const rows = await db.select({ d: usageLedger.utilDelta }).from(usageLedger).where(and(eq(usageLedger.bookId, book.id), gte(usageLedger.ts, since)));
      const used = rows.reduce((a, r) => a + Number((r.d ?? {})[window] ?? 0), 0);
      if (used >= b.max_window_util_pct) return { ok: false, waitUntil: new Date(now.getTime() + Math.min(ms / 6, 3600_000)).toISOString(), reason: `书在窗口 ${window} 的占用已达 ${b.max_window_util_pct}%` };
    }
  }
  return { ok: true, waitUntil: null, reason: null };
}

/** 账号月度 USD 上限（API 例外账号，§7.5） */
export async function accountUsdCapReached(db: Db, account: Account, now: Date): Promise<string | null> {
  if (account.monthlyUsdCap === undefined) return null;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const rows = await db.select({ usd: usageLedger.usd }).from(usageLedger).where(and(eq(usageLedger.accountId, account.id), gte(usageLedger.ts, monthStart)));
  const spent = rows.reduce((a, r) => a + (r.usd ?? 0), 0);
  return spent >= account.monthlyUsdCap ? nextMonthUtc(now).toISOString() : null;
}
