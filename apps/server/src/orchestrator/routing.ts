/**
 * 路由（DESIGN §7）：只有两个位置——写作（writer）和杂活（utility），每个位置主、备各一个 profile，存在 settings 'routing.slots'。
 * 写作位置可被书级覆盖（book.yaml routing.writer_profile）顶替主用，备用照旧。fake 模式（config.fakeHarness）两个位置都走 fake、忽略书级覆盖；
 * 这个“强制”不存库，进程不再是 fake 模式时位置照常可改。
 * 检查：profile 存在且启用、fake 只在 allowFakeHarness 时可用、账号启用 / 风险条款已确认 / 认证有效 / 不在睡眠、并发未满、profile 不在冷却（routing.down:<id>）。
 * 主用不可用 → 备用；都不可用 → 等到最早能恢复的时刻（没有时刻就由调用方决定等多久）。
 */
import { count, eq, inArray, like } from 'drizzle-orm';
import type { Account, HarnessId, Profile, RoutingSlots, Slot, SlotId, SlotStatus } from '@novelist/shared';
import { AGY_ARGON_DEFAULT_SLUG, BUILTIN_PROFILES, DEFAULT_SLOTS, HARNESS_VENDOR, SLOT_IDS, zAccount, zProfile, zRoutingSlots, zSystemSettings } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { accounts, accountsState, books, profiles, runs, settings } from '../db/schema.js';
import type { BookHandle } from '../runtime/types.js';

export const SLOTS_KEY = 'routing.slots';
export const DOWN_PREFIX = 'routing.down:';
/** settings 里 P3 开机迁移的状态行（boot/migrate-p3.ts MIGRATION_KEY；这里不 import，免得循环依赖） */
const P3_MIGRATION_KEY = 'migration.p3';

export type RouteCause = 'auth' | 'quota' | 'concurrency' | 'disabled' | 'no_account' | 'no_route' | 'fake_disallowed' | 'ack' | 'down';

export interface ResolveSlotInput {
  slot: SlotId;
  book: BookHandle | null;
  now: Date;
  /** config.allowFakeHarness：fake profile 只有这时能被选中 */
  allowFakeHarness?: boolean;
  /** 只看能不能路由、不考虑并发上限（自动开书的“写手闲着”判断） */
  ignoreConcurrency?: boolean;
  /** config.fakeHarness：两个位置都走 fake，书级覆盖不看 */
  forced?: boolean;
}

export interface ResolvedRoute {
  slot: SlotId;
  profile: string | null;
  account: string | null;
  harness: string | null;
  model: string | null;
  usedFallback: boolean;
  /** 没有可用 profile 时：等到何时（null = 没有确定的恢复时刻） */
  waitUntil: string | null;
  reason?: string;
  /** 没有可用 profile 时，挡住的主要原因 */
  cause?: RouteCause;
  profileObj: Profile | null;
  accountObj: Account | null;
}

export function vendorOf(harness: string): string {
  return (HARNESS_VENDOR as Record<string, string>)[harness] ?? harness;
}

// ───────────────────────── 账号快照 ─────────────────────────

export interface AccountSnapshot {
  account: Account;
  sleepUntil: string | null;
  sleepReason: string | null;
  authBad: boolean;
  credExpired: boolean;
  active: number;
}

export function accountFromRow(row: typeof accounts.$inferSelect): Account | null {
  const parsed = zAccount.safeParse({ ...row.body, id: row.id, harness: row.harness, label: row.label, authMode: row.authMode, enabled: row.enabled });
  return parsed.success ? parsed.data : null;
}

export async function loadAccountSnapshots(db: Db, now: Date): Promise<AccountSnapshot[]> {
  const [acctRows, stateRows, activeRows] = await Promise.all([
    db.select().from(accounts),
    db.select().from(accountsState),
    db.select({ accountId: runs.accountId, n: count() }).from(runs).where(inArray(runs.state, ['preparing', 'spawned', 'running'])).groupBy(runs.accountId),
  ]);
  const stateOf = new Map(stateRows.map((s) => [s.accountId, s]));
  const activeOf = new Map(activeRows.map((r) => [r.accountId, Number(r.n)]));
  const out: AccountSnapshot[] = [];
  for (const row of acctRows) {
    const account = accountFromRow(row);
    if (!account) continue;
    const st = stateOf.get(row.id);
    const sleepUntil = st?.sleepUntil && new Date(st.sleepUntil).getTime() > now.getTime() ? new Date(st.sleepUntil).toISOString() : null;
    const lastAuth = st?.lastAuthCheck as { ok?: boolean } | null | undefined;
    out.push({
      account,
      sleepUntil,
      sleepReason: sleepUntil ? (st?.sleepReason ?? null) : null,
      authBad: lastAuth?.ok === false,
      credExpired: !!st?.credExpiresAt && new Date(st.credExpiresAt).getTime() <= now.getTime(),
      active: activeOf.get(row.id) ?? 0,
    });
  }
  return out;
}

// ───────────────────────── 位置的读写 ─────────────────────────

/** 没有 routing.slots 行（全新安装、开机迁移还没跑）→ DEFAULT_SLOTS */
export async function loadSlots(db: Db): Promise<RoutingSlots> {
  const rows = await db.select().from(settings).where(eq(settings.key, SLOTS_KEY)).limit(1);
  if (rows[0]) {
    const parsed = zRoutingSlots.safeParse(rows[0].value);
    if (parsed.success) return parsed.data;
  }
  return zRoutingSlots.parse(DEFAULT_SLOTS);
}

/** 写两个位置；开机迁移留下的 migratedFrom / droppedProfiles 原样保留 */
export async function saveSlots(db: Db, slots: Pick<RoutingSlots, 'writer' | 'utility'>): Promise<RoutingSlots> {
  const rows = await db.select().from(settings).where(eq(settings.key, SLOTS_KEY)).limit(1);
  const prev = rows[0] ? zRoutingSlots.safeParse(rows[0].value) : null;
  const keep = prev?.success ? { ...(prev.data.migratedFrom !== undefined ? { migratedFrom: prev.data.migratedFrom } : {}), droppedProfiles: prev.data.droppedProfiles } : {};
  const next = zRoutingSlots.parse({ ...keep, writer: slots.writer, utility: slots.utility });
  const now = new Date().toISOString();
  await db
    .insert(settings)
    .values({ key: SLOTS_KEY, value: next as unknown as Record<string, unknown>, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: next as unknown as Record<string, unknown>, updatedAt: now } });
  return next;
}

/** model_unavailable 之后的 profile 冷却（D8）：到点前路由跳过它，有备用就走备用 */
export async function markProfileDown(db: Db, profileId: string, until: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  const value = { until, reason };
  await db.insert(settings).values({ key: `${DOWN_PREFIX}${profileId}`, value, updatedAt: now }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

async function loadDown(db: Db, now: Date): Promise<Map<string, { until: string; reason: string }>> {
  const rows = await db.select().from(settings).where(like(settings.key, `${DOWN_PREFIX}%`));
  const out = new Map<string, { until: string; reason: string }>();
  for (const r of rows) {
    const v = r.value as { until?: unknown; reason?: unknown };
    if (typeof v?.until !== 'string' || Date.parse(v.until) <= now.getTime()) continue;
    out.set(r.key.slice(DOWN_PREFIX.length), { until: v.until, reason: typeof v.reason === 'string' ? v.reason : '' });
  }
  return out;
}

// ───────────────────────── 解析 ─────────────────────────

interface RoutingCtx {
  profiles: Map<string, Profile>;
  accounts: AccountSnapshot[];
  down: Map<string, { until: string; reason: string }>;
}

async function loadCtx(db: Db, now: Date): Promise<RoutingCtx> {
  const [profileRows, snapshots, down] = await Promise.all([db.select().from(profiles), loadAccountSnapshots(db, now), loadDown(db, now)]);
  const profilesMap = new Map<string, Profile>();
  for (const r of profileRows) {
    const parsed = zProfile.safeParse({ ...r.body, id: r.id, harness: r.harness, enabled: r.enabled });
    if (parsed.success) profilesMap.set(r.id, parsed.data);
  }
  return { profiles: profilesMap, accounts: snapshots, down };
}

interface CandFail {
  cause: RouteCause;
  reason: string;
  wakeAt?: string;
}
type CandResult = { ok: true; profile: Profile; account: AccountSnapshot | null } | ({ ok: false } & CandFail);

function checkProfile(ctx: RoutingCtx, input: ResolveSlotInput, profileId: string): CandResult {
  const fail = (cause: RouteCause, reason: string, wakeAt?: string): CandResult => ({ ok: false, cause, reason, ...(wakeAt ? { wakeAt } : {}) });
  const profile = ctx.profiles.get(profileId);
  if (!profile) return fail('disabled', `profile ${profileId} 不存在`);
  if (!profile.enabled) return fail('disabled', `profile ${profileId} 未启用`);
  if (profile.harness === 'fake' && !input.allowFakeHarness) return fail('fake_disallowed', 'fake 仅在 allowFakeHarness 时可用');
  const down = ctx.down.get(profileId);
  if (down) return fail('down', `profile ${profileId} 暂停到 ${down.until}：${down.reason}`, down.until);

  const pool = ctx.accounts.filter((a) => a.account.harness === profile.harness && (profile.accounts.length === 0 || profile.accounts.includes(a.account.id)));
  if (pool.length === 0) {
    if (profile.harness === 'fake') return { ok: true, profile, account: null };
    return fail('no_account', `${profile.harness} 没有可用账号`);
  }
  let lastFail: CandFail = { cause: 'no_account', reason: `${profile.harness} 账号全部不可用` };
  let earliestWake: string | undefined;
  const usable: AccountSnapshot[] = [];
  for (const a of pool) {
    if (!a.account.enabled) {
      lastFail = { cause: 'disabled', reason: `账号 ${a.account.id} 已停用` };
    } else if (profile.requires_ack.some((k) => !a.account.riskAck.includes(k))) {
      lastFail = { cause: 'ack', reason: `账号 ${a.account.id} 未确认风险条款：${profile.requires_ack.join('、')}` };
    } else if (a.authBad || a.credExpired) {
      lastFail = { cause: 'auth', reason: `账号 ${a.account.id} 认证失效` };
    } else if (a.sleepUntil) {
      lastFail = { cause: 'quota', reason: `账号 ${a.account.id} 配额等待：${a.sleepReason ?? ''}` };
      if (!earliestWake || a.sleepUntil < earliestWake) earliestWake = a.sleepUntil;
    } else if (!input.ignoreConcurrency && a.active >= a.account.concurrency) {
      lastFail = { cause: 'concurrency', reason: `账号 ${a.account.id} 并发已满` };
      if (!earliestWake) earliestWake = new Date(input.now.getTime() + 15_000).toISOString();
    } else {
      usable.push(a);
    }
  }
  if (usable.length === 0) return { ok: false, ...lastFail, ...(earliestWake ? { wakeAt: earliestWake } : {}) };
  usable.sort((a, b) => a.active - b.active || (a.account.id < b.account.id ? -1 : 1));
  return { ok: true, profile, account: usable[0] ?? null };
}

const SLOT_LABEL: Record<SlotId, string> = { writer: '写作', utility: '杂活' };

/**
 * 这个位置依次要试的 profile（去掉空值与重复）。
 * legacySticky：M4b 还没搬进 book.yaml 的旧粘性写手（见 pendingStickyWriter），book.yaml 没有覆盖时当书级覆盖用。
 */
export function slotCandidates(slots: Pick<RoutingSlots, SlotId>, slot: SlotId, book: BookHandle | null, forced: boolean, legacySticky: string | null = null): string[] {
  if (forced) return ['fake'];
  const s: Slot = slots[slot];
  const override = slot === 'writer' ? (book?.config.routing.writer_profile ?? legacySticky ?? null) : null;
  const list = override ? [override, s.fallback] : [s.primary, s.fallback];
  return [...new Set(list.filter((x): x is string => !!x))];
}

function resolveWith(ctx: RoutingCtx, candidates: string[], input: ResolveSlotInput): ResolvedRoute {
  const base = { slot: input.slot, profile: null, account: null, harness: null, model: null, usedFallback: false, waitUntil: null, profileObj: null, accountObj: null };
  if (candidates.length === 0) return { ...base, cause: 'no_route', reason: `${SLOT_LABEL[input.slot]}位置没有配置模型` };
  const fails: CandFail[] = [];
  for (const [i, id] of candidates.entries()) {
    const r = checkProfile(ctx, input, id);
    if (r.ok) {
      return { ...base, profile: r.profile.id, account: r.account?.account.id ?? null, harness: r.profile.harness, model: r.profile.model, usedFallback: i > 0, profileObj: r.profile, accountObj: r.account?.account ?? null };
    }
    fails.push(r);
  }
  const wake = fails.map((f) => f.wakeAt).filter((w): w is string => !!w).sort()[0] ?? null;
  return { ...base, waitUntil: wake, cause: fails[0]?.cause ?? 'no_route', reason: `${SLOT_LABEL[input.slot]}位置无可用模型：${fails.map((f) => f.reason).join('；')}` };
}

/**
 * M4b（boot/migrate-p3.ts runPostRecoveryMigrations）在开机时因为书在忙而延后、还没把 books.writer_profile 搬进 book.yaml 的书：
 * 在搬完之前继续用旧的粘性写手（p3 D6：行为不变）。book.yaml 已有覆盖、M4b 已处理过（迁移状态里有这本书）、
 * 接手过来的书（meta.v3.takeover）、值为空或等于写作位置主用 → null，照常走位置。
 */
export async function pendingStickyWriter(db: Db, book: BookHandle | null, primary: string | null): Promise<string | null> {
  if (!book || book.config.routing.writer_profile) return null;
  const row = (await db.select({ writerProfile: books.writerProfile, meta: books.meta }).from(books).where(eq(books.id, book.id)).limit(1))[0];
  const want = row?.writerProfile ?? null;
  if (!want || want === primary) return null;
  const v3 = (row?.meta as { v3?: { takeover?: unknown } } | null | undefined)?.v3;
  if (v3?.takeover !== undefined && v3.takeover !== null) return null;
  const st = (await db.select({ value: settings.value }).from(settings).where(eq(settings.key, P3_MIGRATION_KEY)).limit(1))[0]?.value as { writerOverrides?: Record<string, unknown> } | undefined;
  if (st?.writerOverrides && typeof st.writerOverrides === 'object' && st.writerOverrides[book.id]) return null;
  return want;
}

export async function resolveSlot(db: Db, input: ResolveSlotInput): Promise<ResolvedRoute> {
  const [slots, ctx] = await Promise.all([loadSlots(db), loadCtx(db, input.now)]);
  const sticky = input.slot === 'writer' && !input.forced ? await pendingStickyWriter(db, input.book, slots.writer.primary) : null;
  return resolveWith(ctx, slotCandidates(slots, input.slot, input.book, !!input.forced, sticky), input);
}

export function toSlotStatus(r: ResolvedRoute): SlotStatus {
  return { slot: r.slot, profile: r.profile, account: r.account, harness: r.harness, model: r.model, usedFallback: r.usedFallback, waitUntil: r.waitUntil, reason: r.profile ? null : (r.reason ?? null) };
}

/** 两个位置此刻的状态（模型页） */
export async function slotStatus(db: Db, now: Date, opts: { allowFakeHarness?: boolean; forced?: boolean }): Promise<Record<SlotId, SlotStatus>> {
  const [slots, ctx] = await Promise.all([loadSlots(db), loadCtx(db, now)]);
  const out = {} as Record<SlotId, SlotStatus>;
  for (const slot of SLOT_IDS) {
    const input: ResolveSlotInput = { slot, book: null, now, ignoreConcurrency: true, ...(opts.allowFakeHarness ? { allowFakeHarness: true } : {}) };
    out[slot] = toSlotStatus(resolveWith(ctx, slotCandidates(slots, slot, null, !!opts.forced), input));
  }
  return out;
}

/** 这本书写作用的 profile（书级覆盖 / M4b 还没搬的旧粘性写手，否则写作位置的主用）；状态句 / 书页显示用 */
export async function writerProfileOf(db: Db, book: BookHandle): Promise<string | null> {
  if (book.config.routing.writer_profile) return book.config.routing.writer_profile;
  const primary = (await loadSlots(db)).writer.primary;
  return (await pendingStickyWriter(db, book, primary)) ?? primary;
}

// ───────────────────────── seed ─────────────────────────

/** 首次启动写入内置 profiles 与 system 默认值（已存在则不覆盖）。不写 preset，也不写 routing.active（只留给上一版镜像） */
export async function seedProfiles(db: Db): Promise<void> {
  const now = new Date().toISOString();
  for (const p of BUILTIN_PROFILES) {
    const parsed = zProfile.parse(p);
    await db.insert(profiles).values({ id: parsed.id, harness: parsed.harness, enabled: parsed.enabled, builtin: true, body: parsed as unknown as Record<string, unknown>, updatedAt: now }).onConflictDoNothing({ target: profiles.id });
  }
  // 早期版本写入的占位 slug（不在 `agy models` 里）；用户自选的值不动
  const [argon] = await db.select().from(profiles).where(eq(profiles.id, 'agy-argon')).limit(1);
  if ((argon?.body as { model?: string } | undefined)?.model === 'gemini-4-argon') {
    await db.update(profiles).set({ body: { ...(argon!.body as object), model: AGY_ARGON_DEFAULT_SLUG }, updatedAt: now }).where(eq(profiles.id, 'agy-argon'));
  }
  await db.insert(settings).values({ key: 'system', value: zSystemSettings.parse({}), updatedAt: now }).onConflictDoNothing({ target: settings.key });
}

export async function loadSystemSettings(db: Db): Promise<import('@novelist/shared').SystemSettings> {
  const rows = await db.select().from(settings).where(eq(settings.key, 'system')).limit(1);
  const parsed = zSystemSettings.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : zSystemSettings.parse({});
}

export type { HarnessId };
