/**
 * v3 的待办卫生（docs/v3/DESIGN.md §8.3；p2-plan §2.4、§3.3 J）。
 * 只有这几类进待办：账号登录失效、harness 不可用、账号连续空跑、额度耗尽超过 12 小时、某本书连续 5 次没写出正文、存稿将尽且写不动（全站一条）；
 * 另加 v3_end（结局兜底）。同类按“种类 + 书”合并，条件消失自动关闭。旧流程的待办不受影响（账号级的 quota / auth / zero_diff 例外：按账号，不分流程）。
 */
import { and, desc, eq, inArray, isNotNull, isNull, max, ne, sql } from 'drizzle-orm';
import type { PublishConfig } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { accounts, accountsState, books, inbox, runs, settings, tasks } from '../db/schema.js';
import type { ExecEnv } from '../orchestrator/executor.js';
import { resolveInboxAuto, upsertOpenInbox } from '../orchestrator/inbox.js';
import { nextSlots } from '../orchestrator/publisher.js';
import { loadSystemSettings } from '../orchestrator/routing.js';
import type { InboxInput } from '../pipeline/types.js';
import { readZeroDiff } from './accounts.js';
import { readV3Meta } from './state.js';
import { fmtWhen } from './status.js';

/** DESIGN §8.3 的几类，加上 v3_end（§5“在待办里挂一条”）。quota: 不在里面：只由清扫按累计时长发（见 nextQuotaStreak），v3 运行从不直接发 */
export const V3_INBOX_PREFIXES: readonly string[] = ['auth:', 'billing:', 'circuit:', 'no_route:', 'zero_diff:', 'v3_no_prose:', 'v3_end:', 'v3_low_buffer'];

/** v3 任务 / 运行发出的待办：只放行上面这些前缀（quota:、refusal:、budget:、nonce: 等一律不发） */
export function v3InboxAllowed(item: InboxInput): boolean {
  const key = item.dedupeKey ?? '';
  return key !== '' && V3_INBOX_PREFIXES.some((p) => key.startsWith(p));
}

/** 每个账号一行 settings（key `flow.v3.quota:<accountId>`，同 flow/accounts.ts 的 zeroDiff）：这一轮额度耗尽从什么时候开始 */
export interface QuotaStreak {
  since: string;
  awakeSince: string | null;
}
export const QUOTA_INBOX_AFTER_MS = 12 * 3600_000;
export const QUOTA_AWAKE_END_MS = 30 * 60_000;

const quotaKey = (accountId: string) => `flow.v3.quota:${accountId}`;

/**
 * 纯函数，按账号。在睡（sleepUntil > now），且不是账单问题或空跑暂停（excluded，两者各有待办）→ 开始一轮（since = now）或延续（awakeSince = null）。
 * 醒着（或 excluded 的睡）：awakeSince = awakeSince ?? now。
 * 一轮结束（→ null）：since 之后这个账号有一次没出错的运行结束了，或者连续醒着 ≥ 30 分钟。
 * 所以 agy 的 30 分钟 / 1 / 2 / 5 小时阶梯（中间有短暂的试探）是一轮，不是一串。
 */
export function nextQuotaStreak(prev: QuotaStreak | null, a: { sleeping: boolean; excluded: boolean; lastOkRunAt: string | null }, now: Date): QuotaStreak | null {
  let cur = prev;
  if (cur && a.lastOkRunAt && Date.parse(a.lastOkRunAt) > Date.parse(cur.since)) cur = null;
  const nowIso = now.toISOString();
  if (a.sleeping && !a.excluded) return cur ? { since: cur.since, awakeSince: null } : { since: nowIso, awakeSince: null };
  if (!cur) return null;
  const awakeSince = cur.awakeSince ?? nowIso;
  if (now.getTime() - Date.parse(awakeSince) >= QUOTA_AWAKE_END_MS) return null;
  return { since: cur.since, awakeSince };
}

export interface LowBufferRow {
  bookId: string;
  slug: string;
  title: string;
  bufferDays: number | null;
  running: boolean;
  /** 活着的 flow 任务什么时候能跑（ready = now）；没有任务或任务 blocked 时 null */
  nextRunAt: string | null;
  nextRelease: string | null;
  completed: boolean;
}

/** 存稿撑不过 1 天的发布、而且下一次运行不在下一次发布之前（或者根本没有下一次运行）的书 */
export function lowBufferStuck(rows: LowBufferRow[], now: Date): LowBufferRow[] {
  void now;
  return rows.filter((r) => !r.completed && r.bufferDays !== null && r.bufferDays < 1 && !r.running && (r.nextRunAt === null || (r.nextRelease !== null && Date.parse(r.nextRunAt) > Date.parse(r.nextRelease))));
}

const V3_KIND_LIST = ['book.open', 'book.write', 'book.retro'];
const ACTIVE = ['leased', 'running', 'finalizing'];
const LIVE = ['pending', 'ready', 'waiting', 'leased', 'running', 'finalizing'];

/** "11月12日 08:00"（按 tz） */
function fmtAt(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}`;
}
const DEFAULT_TZ = 'Asia/Shanghai';

async function closeItem(db: Db, id: string, reason: string, how: 'resolved' | 'dismissed'): Promise<void> {
  if (how === 'resolved') return resolveInboxAuto(db, id, reason);
  const nowIso = new Date().toISOString();
  await db
    .update(inbox)
    .set({ state: 'dismissed', resolution: { auto: true, reason, ts: nowIso }, resolvedAt: nowIso })
    .where(and(eq(inbox.id, id), eq(inbox.state, 'open')));
}

type InboxRow = typeof inbox.$inferSelect;

/** 主人手动关掉的：dismissInbox（state dismissed、不是清扫自动关的）或 actOnInbox 的“知道了”（resolution.action = dismiss） */
export function ownerClosed(row: Pick<InboxRow, 'state' | 'resolution'>): boolean {
  const res = (row.resolution ?? {}) as { auto?: unknown; action?: unknown };
  return (row.state === 'dismissed' && res.auto !== true) || res.action === 'dismiss';
}

/**
 * 同一 dedupeKey 最近一条关掉的项：主人手动关的、而且那之后条件还没消失过（resolution.conditionGone 未设）时返回它。
 * 清扫据此不再重开同一件事（否则主人点“知道了”，一分钟后又是一条新项、一条新通知）。
 */
async function ownerDismissedRow(db: Db, key: string): Promise<InboxRow | null> {
  const row = (await db.select().from(inbox).where(and(eq(inbox.dedupeKey, key), ne(inbox.state, 'open'))).orderBy(desc(inbox.createdAt)).limit(1))[0];
  if (!row || !ownerClosed(row)) return null;
  return (row.resolution as { conditionGone?: unknown } | null)?.conditionGone ? null : row;
}

/** 条件消失了：主人关掉的那一条不再压着，下次同一条件出现时照常发 */
async function liftDismiss(db: Db, key: string, nowIso: string): Promise<void> {
  const row = await ownerDismissedRow(db, key);
  if (row) await db.update(inbox).set({ resolution: { ...(row.resolution ?? {}), conditionGone: nowIso } }).where(eq(inbox.id, row.id));
}

/** 主人关掉的 quota:<acc> 是同一轮额度耗尽（since 相同）时不再发 */
export function quotaSuppressed(dismissedBody: Record<string, unknown> | null | undefined, since: string): boolean {
  return dismissedBody?.since === since;
}

/** 主人关掉的 v3_low_buffer 已经列过现在每一本写不动的书时不再发；出现新的书就重新发 */
export function lowBufferSuppressed(dismissedBody: Record<string, unknown> | null | undefined, stuckIds: readonly string[]): boolean {
  const list = Array.isArray(dismissedBody?.books) ? (dismissedBody.books as { bookId?: unknown }[]) : [];
  const seen = new Set(list.map((b) => b.bookId));
  return stuckIds.length > 0 && stuckIds.every((id) => seen.has(id));
}

async function readStreak(db: Db, accountId: string): Promise<QuotaStreak | null> {
  const row = (await db.select({ value: settings.value }).from(settings).where(eq(settings.key, quotaKey(accountId))).limit(1))[0];
  const v = row?.value as Partial<QuotaStreak> | null | undefined;
  return v && typeof v.since === 'string' ? { since: v.since, awakeSince: typeof v.awakeSince === 'string' ? v.awakeSince : null } : null;
}

async function writeStreak(db: Db, accountId: string, s: QuotaStreak | null): Promise<void> {
  const nowIso = new Date().toISOString();
  const value = s ?? { since: null, awakeSince: null };
  await db.insert(settings).values({ key: quotaKey(accountId), value, updatedAt: nowIso }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } });
}

/**
 * leader 每分钟一次：自动关闭条件已消失的 v3 待办；维护全站唯一的 v3_low_buffer；把 v3 书的旧待办（已合并或不再发的种类）收起。
 * 返回关掉的条数、写不动的书数。
 */
export async function reconcileV3Inbox(env: ExecEnv, now: Date): Promise<{ closed: number; lowBuffer: number }> {
  const db = env.db;
  let closed = 0;
  const open = await db.select().from(inbox).where(eq(inbox.state, 'open'));
  const openBy = new Map(open.filter((i) => i.dedupeKey).map((i) => [i.dedupeKey as string, i]));
  const close = async (row: typeof inbox.$inferSelect, reason: string, how: 'resolved' | 'dismissed' = 'resolved') => {
    await closeItem(db, row.id, reason, how);
    openBy.delete(row.dedupeKey ?? '');
    closed += 1;
  };

  // 1. 账号：额度耗尽的累计时长（先算，再开 / 关 quota: 项）；空跑、登录失效恢复了就关
  const acctRows = await db.select({ id: accounts.id, enabled: accounts.enabled }).from(accounts);
  const stateRows = await db.select().from(accountsState);
  const stateOf = new Map(stateRows.map((s) => [s.accountId, s]));
  const okRows = await db
    .select({ accountId: runs.accountId, at: max(runs.endedAt) })
    .from(runs)
    .where(and(isNotNull(runs.accountId), isNotNull(runs.endedAt), isNull(runs.errorClass)))
    .groupBy(runs.accountId);
  const lastOk = new Map(okRows.map((r) => [r.accountId as string, r.at ? new Date(r.at).toISOString() : null]));
  const sleepingOf = (id: string) => {
    const st = stateOf.get(id);
    return !!st?.sleepUntil && Date.parse(st.sleepUntil) > now.getTime();
  };
  for (const a of acctRows) {
    const st = stateOf.get(a.id);
    const sleeping = a.enabled && sleepingOf(a.id);
    const excluded = st?.sleepReason === 'billing' || (await readZeroDiff(db, a.id)) >= 2;
    const prev = await readStreak(db, a.id);
    const streak = a.enabled ? nextQuotaStreak(prev, { sleeping, excluded, lastOkRunAt: lastOk.get(a.id) ?? null }, now) : null;
    if (JSON.stringify(prev) !== JSON.stringify(streak)) await writeStreak(db, a.id, streak);
    const key = `quota:${a.id}`;
    const dismissed = streak && !openBy.has(key) ? await ownerDismissedRow(db, key) : null;
    if (streak && now.getTime() - Date.parse(streak.since) > QUOTA_INBOX_AFTER_MS && !(dismissed && quotaSuppressed(dismissed.body, streak.since))) {
      const until = st?.sleepUntil ? new Date(st.sleepUntil).toISOString() : null;
      await upsertOpenInbox(db, env.bus, {
        kind: 'quota',
        bookId: null,
        dedupeKey: key,
        title: `账号 ${a.id} 额度耗尽已超过 12 小时`,
        body: { accountId: a.id, since: streak.since, until, detail: `从 ${fmtAt(streak.since, DEFAULT_TZ)} 起一直在等额度，${until ? `预计 ${fmtAt(until, DEFAULT_TZ)} 再试。` : '正在试探是否恢复。'}` },
        actions: [{ id: 'dismiss', label: '知道了' }],
      });
      openBy.delete(key);
    } else if (!streak && openBy.has(key)) {
      await close(openBy.get(key) as typeof inbox.$inferSelect, 'quota_recovered');
    }
    if (!streak) await liftDismiss(db, key, now.toISOString());
    const auth = openBy.get(`auth:${a.id}`);
    if (auth && (st?.lastAuthCheck as { ok?: unknown } | null | undefined)?.ok === true) await close(auth, 'auth_ok');
  }
  for (const row of [...openBy.values()]) {
    const key = row.dedupeKey ?? '';
    if (!key.startsWith('zero_diff:')) continue;
    const acc = key.slice('zero_diff:'.length);
    if ((await readZeroDiff(db, acc)) === 0 && !sleepingOf(acc)) await close(row, 'zero_diff_resumed');
  }

  // 2. v3 书：合并后的项按条件关；旧的（不再发、或已合并的）收起
  const v3Books = (await db.select().from(books).where(sql`${books.meta}->'v3' is not null`)).filter((b) => b.meta && typeof b.meta === 'object');
  const bookOf = new Map(v3Books.map((b) => [b.id, b]));
  const flowTasks = v3Books.length
    ? await db
        .select({ id: tasks.id, bookId: tasks.bookId, kind: tasks.kind, state: tasks.state, notBefore: tasks.notBefore, waitReason: tasks.waitReason, finishedAt: tasks.finishedAt })
        .from(tasks)
        .where(and(inArray(tasks.bookId, v3Books.map((b) => b.id)), inArray(tasks.kind, V3_KIND_LIST)))
    : [];
  const tasksOf = (bookId: string) => flowTasks.filter((t) => t.bookId === bookId);
  const routeStuck = (t: { state: string; waitReason: string | null } | undefined) => !!t && (t.state === 'blocked' || (t.state === 'waiting' && (t.waitReason ?? '').startsWith('无可用路由')));

  let sys: Awaited<ReturnType<typeof loadSystemSettings>> | null = null;
  const loadSettingsOnce = async () => (sys ??= await loadSystemSettings(db));
  for (const row of [...openBy.values()]) {
    const key = row.dedupeKey ?? '';
    const b = row.bookId ? bookOf.get(row.bookId) : undefined;
    if (!b) continue;
    const meta = readV3Meta(b.meta);
    const bt = tasksOf(b.id);
    if (key === `v3_no_prose:${b.id}`) {
      // 一批入库之后，之前失败的写作任务不再算；失败的复盘从来不算
      const since = meta.lastBatchAt ? Date.parse(meta.lastBatchAt) : 0;
      const failed = bt.some((t) => (t.kind === 'book.open' || t.kind === 'book.write') && t.state === 'failed' && (t.finishedAt ? Date.parse(t.finishedAt) : 0) > since);
      if (!['planning', 'active'].includes(b.status) || (meta.noChapterStreak === 0 && meta.emptyStreak === 0 && !failed)) await close(row, 'prose_landed');
    } else if (key === `v3_end:${b.id}`) {
      // 两种 v3_end：兜底完结的通知（主人读过再关，留着）；失控兜底关着时连续两次结局批没写标记的提醒——写了标记（计数清零）或兜底又打开了就关
      const factor = (await loadSettingsOnce()).v3.runawayFactor;
      if (meta.completedReason !== 'backstop' && (!meta.finaleNoMarkerAlerted || factor > 0)) await close(row, 'end_resolved');
    } else if (key === `no_route:${b.id}`) {
      const related = row.relatedTaskId ? bt.find((t) => t.id === row.relatedTaskId) : undefined;
      const stuck = related ? routeStuck(related) : bt.some((t) => routeStuck(t));
      if (!stuck) await close(row, 'route_ok');
    } else if (
      key.startsWith(`v3_empty:${b.id}`) ||
      key.startsWith(`v3_agents_size:${b.id}`) ||
      key.startsWith(`v3_gap:${b.id}`) ||
      key.startsWith(`v3_discard:${b.id}`) ||
      key === `low_buffer:${b.id}` ||
      key === `buffer_blocked:${b.id}` ||
      key.startsWith(`no_route:${b.id}:`) ||
      key === `failover:${b.id}`
    ) {
      await close(row, 'merged', 'dismissed');
    } else if (key.startsWith('no_route:task:')) {
      const t = bt.find((x) => x.id === key.slice('no_route:task:'.length));
      if (t) await close(row, 'merged', 'dismissed');
    } else if (key === `v3_pending:${b.id}`) {
      if (!meta.pending || meta.pending.failures < 3) await close(row, 'merged', 'dismissed');
    } else if (key.startsWith('failed:')) {
      const t = bt.find((x) => x.id === key.slice('failed:'.length));
      if (t && t.state !== 'failed') await close(row, 'merged', 'dismissed');
    }
  }

  // 3. 存稿将尽且写不动（全站合并为一条）
  const rows: (LowBufferRow & { reason: string; tz: string })[] = [];
  for (const b of v3Books) {
    if (b.status !== 'planning' && b.status !== 'active') continue;
    const meta = readV3Meta(b.meta);
    let cfg: PublishConfig | null = null;
    try {
      cfg = (await env.pipe.openBook(env.pdeps, b.id)).config.publish;
    } catch {
      cfg = null;
    }
    if (!cfg) continue;
    const bt = tasksOf(b.id).filter((t) => LIVE.includes(t.state) || t.state === 'blocked');
    const running = bt.some((t) => ACTIVE.includes(t.state));
    const live = bt.find((t) => LIVE.includes(t.state));
    const blocked = bt.some((t) => t.state === 'blocked');
    const nextRunAt = live ? (live.state === 'ready' || !live.notBefore ? now.toISOString() : new Date(live.notBefore).toISOString()) : null;
    let nextRelease: string | null = null;
    try {
      nextRelease = nextSlots(cfg, now, 1)[0] ?? null;
    } catch {
      nextRelease = null;
    }
    const reason = (meta.pending && meta.pending.failures >= 3) || blocked ? '收稿出错，等你处理' : nextRunAt === null ? '当前没有在写' : `下一次运行要到 ${fmtWhen(nextRunAt, now, cfg.timezone || DEFAULT_TZ)}`;
    rows.push({ bookId: b.id, slug: b.slug, title: b.title, bufferDays: meta.sched?.bufferDays ?? null, running, nextRunAt: blocked && !live ? null : nextRunAt, nextRelease, completed: false, reason, tz: cfg.timezone || DEFAULT_TZ });
  }
  const stuck = lowBufferStuck(rows, now) as typeof rows;
  const lowOpen = openBy.get('v3_low_buffer');
  const lowDismissed = stuck.length > 0 && !lowOpen ? await ownerDismissedRow(db, 'v3_low_buffer') : null;
  if (stuck.length === 0) {
    if (lowOpen) await close(lowOpen, 'buffer_ok');
    await liftDismiss(db, 'v3_low_buffer', now.toISOString());
  } else if (lowDismissed && lowBufferSuppressed(lowDismissed.body, stuck.map((r) => r.bookId))) {
    // 主人已经知道这几本书写不动了：不再重开
  } else {
    const lines = stuck.map((r) => `《${r.title}》存稿只够约 ${Math.max(0, Math.round((r.bufferDays ?? 0) * 10) / 10)} 天，${r.reason}`);
    await upsertOpenInbox(db, env.bus, {
      kind: 'notice',
      bookId: null,
      dedupeKey: 'v3_low_buffer',
      title: `存稿将尽且写不动：${stuck.length} 本书`,
      body: { books: stuck.map((r) => ({ bookId: r.bookId, slug: r.slug, title: r.title, bufferDays: r.bufferDays, reason: r.reason })), detail: lines.join('\n') },
      actions: [{ id: 'dismiss', label: '知道了' }],
    });
  }
  return { closed, lowBuffer: stuck.length };
}
