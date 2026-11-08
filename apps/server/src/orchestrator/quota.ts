/**
 * 配额（DESIGN §7.5）：订阅窗口占用率为主口径；准入 + 预留；为主人保留余量；窗口耗尽 sleep_until。Owner: lane F。
 * util_delta 单位换算来自 usage_ledger 实测（每 (profile, task kind) 的均值）；无数据时用保守默认。
 * 占用率单位：百分比 0–100（harness 上报 0–1 的小数时在 recordRateLimit 归一）。
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Account, Outcome, QualityTier, TaskKind } from '@novelist/shared';
import { normalizeTier } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { accounts, accountsState, chapters, quotaReservations, quotaSnapshots, usageLedger } from '../db/schema.js';
import type { BookHandle } from '../pipeline/types.js';
import { accountFromRow, resolveRoute } from './routing.js';

export interface ExpectedCost {
  accountId: string;
  window: string;
  amount: number;
}

const QUOTA_LOCK = 0x4e56_0002;

/** 无实测数据时的保守默认（占窗口百分比） */
const DEFAULT_COST: Record<'heavy' | 'light', Record<string, number>> = {
  heavy: { '5h': 2, '7d': 0.5, daily: 1, model_7d: 0.5, monthly_usd: 0, minute: 0, other: 1 },
  light: { '5h': 0.4, '7d': 0.08, daily: 0.2, model_7d: 0.08, monthly_usd: 0, minute: 0, other: 0.2 },
};
const HEAVY_KINDS = /^(chapter\.(write|revise|expand|compress)|plan\.|audit\.|summary\.)/;

interface UtilEntry {
  utilization: number | null;
  resetsAt: string | null;
  ts: string;
}

function windowsOf(account: Account, util: Record<string, UtilEntry>): string[] {
  const set = new Set<string>(account.windows.map((w) => w.window));
  for (const k of Object.keys(util)) set.add(k);
  set.delete('minute');
  return [...set];
}

async function accountWithUtil(db: Db, accountId: string): Promise<{ account: Account; util: Record<string, UtilEntry> } | null> {
  const [acctRows, stRows] = await Promise.all([db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1), db.select().from(accountsState).where(eq(accountsState.accountId, accountId)).limit(1)]);
  const row = acctRows[0];
  if (!row) return null;
  const account = accountFromRow(row);
  if (!account) return null;
  return { account, util: (stRows[0]?.util ?? {}) as Record<string, UtilEntry> };
}

/** 一次 (profile, kind) 在该窗口的实测平均占用；无数据时默认 */
async function measuredCost(db: Db, profileId: string, kind: TaskKind, window: string): Promise<number> {
  const rows = await db
    .select({ d: usageLedger.utilDelta })
    .from(usageLedger)
    .where(and(eq(usageLedger.profileId, profileId), eq(usageLedger.taskKind, kind)))
    .orderBy(desc(usageLedger.ts))
    .limit(30);
  const samples = rows.map((r) => Number((r.d ?? {})[window])).filter((v) => Number.isFinite(v) && v > 0);
  if (samples.length > 0) return samples.reduce((a, b) => a + b, 0) / samples.length;
  const table = DEFAULT_COST[HEAVY_KINDS.test(kind) ? 'heavy' : 'light'];
  return table[window] ?? table.other ?? 0.5;
}

export async function expectedTaskCost(db: Db, input: { profileId: string; accountId: string; kind: TaskKind; tier: QualityTier | null }): Promise<ExpectedCost[]> {
  const info = await accountWithUtil(db, input.accountId);
  if (!info) return [];
  const out: ExpectedCost[] = [];
  for (const window of windowsOf(info.account, info.util)) {
    out.push({ accountId: input.accountId, window, amount: await measuredCost(db, input.profileId, input.kind, window) });
  }
  return out;
}

/** 一章 lite/standard/key 的完整期望消耗（writer + check + 修订/补抽期望值 + planning 摊销），按涉及的账号拆分 */
export async function expectedChapterCost(db: Db, input: { bookId: string; tier: QualityTier; book?: BookHandle | null; writer?: { profileId: string; accountId: string | null } | null; allowFakeHarness?: boolean }): Promise<ExpectedCost[]> {
  const now = new Date();
  const norm = normalizeTier(input.tier);
  const parts: { role: 'writer' | 'checker' | 'extractor' | 'reviewer' | 'judge'; kind: TaskKind; factor: number }[] = [
    { role: 'writer', kind: 'chapter.write', factor: 1.35 }, // hard 失败修订 ≈30%；planning 摊销 ≈5%
    { role: norm === 'lite' ? 'checker' : 'extractor', kind: norm === 'lite' ? 'chapter.check' : 'chapter.extract', factor: 1.3 },
  ];
  if (norm !== 'lite') parts.push({ role: 'reviewer', kind: 'chapter.review', factor: 1.2 });
  if (norm === 'key') parts.push({ role: 'judge', kind: 'chapter.review', factor: 2 });
  const merged = new Map<string, ExpectedCost>();
  for (const part of parts) {
    let profileId: string | null = null;
    let accountId: string | null = null;
    if (part.role === 'writer' && input.writer) {
      profileId = input.writer.profileId;
      accountId = input.writer.accountId;
    } else {
      const r = await resolveRoute(db, { role: part.role, book: input.book ?? null, tier: input.tier, now, ignoreConcurrency: true, ...(input.allowFakeHarness ? { allowFakeHarness: true } : {}) });
      profileId = r.profile;
      accountId = r.account;
    }
    if (!profileId || !accountId) continue;
    const costs = await expectedTaskCost(db, { profileId, accountId, kind: part.kind, tier: input.tier });
    for (const c of costs) {
      const key = `${c.accountId}|${c.window}`;
      const prev = merged.get(key);
      const amount = c.amount * part.factor;
      if (prev) prev.amount += amount;
      else merged.set(key, { ...c, amount });
    }
  }
  return [...merged.values()];
}

/** 全部放得下才预留（同一事务）；否则返回最早可用时间 */
export async function reserve(db: Db, input: { taskId: string; bookId: string | null; costs: ExpectedCost[]; ttlMs?: number; now?: Date }): Promise<{ ok: true; ids: string[] } | { ok: false; waitUntil: string | null; reason: string }> {
  const now = input.now ?? new Date();
  const ttl = input.ttlMs ?? 2 * 3600_000;
  if (input.costs.length === 0) return { ok: true, ids: [] };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${QUOTA_LOCK})`);
    const accountIds = [...new Set(input.costs.map((c) => c.accountId))];
    const [acctRows, stRows, openRows] = await Promise.all([
      tx.select().from(accounts).where(inArray(accounts.id, accountIds)),
      tx.select().from(accountsState).where(inArray(accountsState.accountId, accountIds)),
      tx
        .select({ accountId: quotaReservations.accountId, window: quotaReservations.window, amount: quotaReservations.amount })
        .from(quotaReservations)
        .where(and(inArray(quotaReservations.accountId, accountIds), isNull(quotaReservations.settledAt), sql`${quotaReservations.expiresAt} > ${now.toISOString()}`)),
    ]);
    const accountMap = new Map(acctRows.map((r) => [r.id, accountFromRow(r)]));
    const stateMap = new Map(stRows.map((r) => [r.accountId, r]));
    const reservedOf = (acc: string, w: string): number => openRows.filter((r) => r.accountId === acc && r.window === w).reduce((a, r) => a + r.amount, 0);
    let waitUntil: string | null = null;
    let reason: string | null = null;
    for (const c of input.costs) {
      const account = accountMap.get(c.accountId);
      if (!account) continue;
      const util = (stateMap.get(c.accountId)?.util ?? {}) as Record<string, UtilEntry>;
      const entry = util[c.window];
      const resetsAt = entry?.resetsAt && new Date(entry.resetsAt).getTime() > now.getTime() ? entry.resetsAt : null;
      const used = (entry && entry.utilization !== null && (entry.resetsAt === null || resetsAt !== null) ? entry.utilization : 0) + reservedOf(c.accountId, c.window);
      let limit = 100 - account.reservePct;
      if ((c.window === '7d' || c.window === 'model_7d') && account.maxWeeklyUtilPct !== undefined) limit = Math.min(limit, account.maxWeeklyUtilPct);
      if (used + c.amount > limit) {
        reason = `账号 ${c.accountId} 窗口 ${c.window} 占用 ${used.toFixed(1)}%，预留后超过上限 ${limit}%`;
        if (resetsAt && (!waitUntil || resetsAt < waitUntil)) waitUntil = resetsAt;
      }
    }
    if (reason) return { ok: false, waitUntil, reason };
    const ids: string[] = [];
    const expiresAt = new Date(now.getTime() + ttl).toISOString();
    for (const c of input.costs) {
      const id = randomUUID();
      await tx.insert(quotaReservations).values({ id, accountId: c.accountId, window: c.window, bookId: input.bookId, taskId: input.taskId, amount: c.amount, expiresAt });
      ids.push(id);
    }
    return { ok: true, ids };
  });
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

/** run 结束：按实测结算、释放预留、写 usage_ledger、解析 rate_limit 信号（resetsAt → sleep_until） */
export async function settle(
  db: Db,
  input: {
    reservationIds: string[];
    runId: string;
    accountId: string | null;
    profileId: string;
    harness: string;
    model: string | null;
    kind: TaskKind;
    tier: QualityTier | null;
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
  if (input.reservationIds.length > 0) {
    await db.update(quotaReservations).set({ settledAt: now, runId: input.runId }).where(inArray(quotaReservations.id, input.reservationIds));
  }
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
    tier: input.tier,
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

/** 没跑模型就释放预留（prepare skip、run 启动失败） */
export async function releaseReservations(db: Db, ids: string[], now: Date = new Date()): Promise<void> {
  if (ids.length > 0) await db.update(quotaReservations).set({ settledAt: now.toISOString() }).where(inArray(quotaReservations.id, ids));
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

/** 超过 2 小时未结算的预留自动作废 */
export async function expireReservations(db: Db, now: Date): Promise<number> {
  const rows = await db
    .update(quotaReservations)
    .set({ settledAt: now.toISOString() })
    .where(and(isNull(quotaReservations.settledAt), lte(quotaReservations.expiresAt, now.toISOString())))
    .returning({ id: quotaReservations.id });
  return rows.length;
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

/** 书级预算：chapters_per_day_cap / monthly_usd_cap / max_window_util_pct（§7.5、book.yaml budgets） */
export async function checkBookBudget(db: Db, book: BookHandle, kind: TaskKind, now: Date): Promise<BudgetVerdict> {
  const b = book.config.budgets;
  if (kind === 'chapter.write' && b.chapters_per_day_cap !== undefined) {
    const since = new Date(now.getTime() - 86400_000).toISOString();
    const rows = await db.select({ at: chapters.acceptedAt }).from(chapters).where(and(eq(chapters.bookId, book.id), gte(chapters.acceptedAt, since))).orderBy(chapters.acceptedAt);
    if (rows.length >= b.chapters_per_day_cap && rows[0]?.at) {
      return { ok: false, waitUntil: new Date(new Date(rows[0].at).getTime() + 86400_000).toISOString(), reason: `已达每日章数上限 ${b.chapters_per_day_cap}` };
    }
  }
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

export function quotaFloorPct(account: Account): number {
  return 100 - account.reservePct;
}
