/**
 * 角色路由与降级阶梯（DESIGN §7.4；D2 修订：全部在 Web UI 配置）。Owner: lane F。
 * 生效路由 = book.yaml routing.roles > book.yaml routing.preset > settings 'routing.active'（preset + 全局覆盖）。
 * resolve 检查：profile enabled、requires_ack 已确认、账号 enabled 且未 sleep、并发未满、熔断未开、厂商白名单、
 * constraint（vendor_ne_writer 等）。全部不满足 → 按 degrade_to → 放宽 constraint → 返回 waitUntil。
 * 模型 slug 不在 listModels 里只在可行性检查给 warning（IMPL §12：Argon slug 未核实，不硬失败）。
 */
import { and, count, eq, inArray } from 'drizzle-orm';
import type { Account, FeasibilityReport, HarnessId, Profile, QualityTier, RoleId, RoleRoute, RouteDecision, RoutingPreset } from '@novelist/shared';
import { AGY_ARGON_DEFAULT_SLUG, BUILTIN_PRESETS, BUILTIN_PROFILES, DEFAULT_PRESET_ID, HARNESS_VENDOR, RISK_NOTES, ROUTABLE_ROLES, normalizeTier, zAccount, zProfile, zRoutingPreset, zSystemSettings } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { accounts, accountsState, books, capabilities, circuitBreakers, profiles, routingPresets, runs, settings, usageLedger } from '../db/schema.js';
import type { BookHandle } from '../pipeline/types.js';

export interface ResolveInput {
  role: RoleId;
  book: BookHandle | null;
  tier: QualityTier;
  /** 本章写手的厂商（vendor_ne_writer） */
  writerVendor?: string | null;
  /** 规划者厂商（vendor_ne_planner） */
  plannerVendor?: string | null;
  /** not_in_judges：本章 judge 用过的 profile */
  excludeProfiles?: string[];
  /** output_contract 2 次后避开的 profile */
  avoidProfiles?: string[];
  /** refusal 跨厂商重试时避开的厂商 */
  avoidVendors?: string[];
  now: Date;
  /** config.allowFakeHarness：fake profile 只有这时能被选中 */
  allowFakeHarness?: boolean;
  /** 计算路由但不考虑并发上限（配额估算、可行性检查） */
  ignoreConcurrency?: boolean;
}

export type RouteCause = 'auth' | 'circuit_open' | 'model_unavailable' | 'quota' | 'concurrency' | 'disabled' | 'constraint' | 'no_account' | 'no_route' | 'fake_disallowed' | 'vendor' | 'avoided' | 'ack';

export interface ResolvedRoute extends RouteDecision {
  profileObj: Profile | null;
  accountObj: Account | null;
  /** 无可用 profile 时，阻塞的主要原因（failover / UI 用） */
  cause?: RouteCause;
}

export function vendorOf(harness: string): string {
  return (HARNESS_VENDOR as Record<string, string>)[harness] ?? harness;
}

// ───────────────────────── 路由上下文（一次解析用一个快照） ─────────────────────────

export interface AccountSnapshot {
  account: Account;
  sleepUntil: string | null;
  sleepReason: string | null;
  authBad: boolean;
  credExpired: boolean;
  active: number;
}

interface RoutingCtx {
  profiles: Map<string, Profile>;
  accounts: AccountSnapshot[];
  /** harness → 是否有未关闭的熔断 */
  openCircuits: Set<string>;
  writerProfile: string | null;
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

/** mock 模式（NOVELIST_FAKE_HARNESS=1）写入的强制路由：忽略书级 preset / roles / 粘性写手 */
async function loadActive(db: Db): Promise<{ presetId?: string; overrides?: Partial<Record<RoleId, unknown>>; forced?: boolean }> {
  const rows = await db.select().from(settings).where(eq(settings.key, 'routing.active')).limit(1);
  return (rows[0]?.value ?? {}) as { presetId?: string; overrides?: Partial<Record<RoleId, unknown>>; forced?: boolean };
}

async function loadCtx(db: Db, book: BookHandle | null, now: Date): Promise<RoutingCtx> {
  const [profileRows, snapshots, circuits, bookRows, active] = await Promise.all([
    db.select().from(profiles),
    loadAccountSnapshots(db, now),
    db.select().from(circuitBreakers).where(inArray(circuitBreakers.state, ['open', 'half_open'])),
    book ? db.select({ w: books.writerProfile }).from(books).where(eq(books.id, book.id)).limit(1) : Promise.resolve([]),
    loadActive(db),
  ]);
  const profilesMap = new Map<string, Profile>();
  for (const r of profileRows) {
    const parsed = zProfile.safeParse({ ...r.body, id: r.id, harness: r.harness, enabled: r.enabled });
    if (parsed.success) profilesMap.set(r.id, parsed.data);
  }
  return {
    profiles: profilesMap,
    accounts: snapshots,
    openCircuits: new Set(circuits.map((c) => c.harness)),
    writerProfile: active.forced ? null : (book?.config.routing.writer_profile ?? (bookRows[0]?.w as string | null | undefined) ?? null),
  };
}

async function loadRoleRoutes(db: Db, book: BookHandle | null): Promise<RoutingPreset> {
  return effectiveRouting(db, book);
}

function derefRoute(preset: RoutingPreset, role: RoleId): RoleRoute | null {
  const r = preset.roles[role];
  if (!r) return null;
  if (r.same_as && r.same_as !== role) {
    const target = preset.roles[r.same_as];
    return target ?? r;
  }
  return r;
}

// ───────────────────────── 单个 profile 的可用性 ─────────────────────────

interface CandFail {
  cause: RouteCause;
  reason: string;
  wakeAt?: string;
}
type CandResult = { ok: true; profile: Profile; account: AccountSnapshot | null } | ({ ok: false } & CandFail);

function checkProfile(ctx: RoutingCtx, input: ResolveInput, profileId: string, opts: { constraint: RoleRoute['constraint'] }): CandResult {
  const fail = (cause: RouteCause, reason: string, wakeAt?: string): CandResult => ({ ok: false, cause, reason, ...(wakeAt ? { wakeAt } : {}) });
  const profile = ctx.profiles.get(profileId);
  if (!profile) return fail('disabled', `profile ${profileId} 不存在`);
  if (!profile.enabled) return fail('disabled', `profile ${profileId} 未启用`);
  if (profile.harness === 'fake' && !input.allowFakeHarness) return fail('fake_disallowed', 'fake 仅在 allowFakeHarness 时可用');
  if (input.avoidProfiles?.includes(profileId)) return fail('avoided', `本任务避开 ${profileId}`);
  const vendor = vendorOf(profile.harness);
  if (input.avoidVendors?.includes(vendor)) return fail('avoided', `本任务避开厂商 ${vendor}`);
  const allow = input.book?.config.vendors_allow;
  if (allow && profile.harness !== 'fake' && !allow.includes(vendor)) return fail('vendor', `书级厂商白名单不含 ${vendor}`);
  if (opts.constraint === 'vendor_ne_writer' && input.writerVendor && vendor === input.writerVendor) return fail('constraint', `与写手同厂商（${vendor}）`);
  if (opts.constraint === 'vendor_ne_planner' && input.plannerVendor && vendor === input.plannerVendor) return fail('constraint', `与规划者同厂商（${vendor}）`);
  if (opts.constraint === 'not_in_judges' && input.excludeProfiles?.includes(profileId)) return fail('constraint', '该 profile 已担任评委');
  if (ctx.openCircuits.has(profile.harness)) return fail('circuit_open', `${profile.harness} 熔断中`);

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

function decision(input: ResolveInput, profile: Profile, snap: AccountSnapshot | null, degraded: RouteDecision['degraded'], route: RoleRoute): ResolvedRoute {
  return {
    role: input.role,
    profile: profile.id,
    account: snap?.account.id ?? null,
    harness: profile.harness,
    model: profile.model,
    degraded,
    waitUntil: null,
    sameVendorAsWriter: route.constraint === 'vendor_ne_writer' && !!input.writerVendor && vendorOf(profile.harness) === input.writerVendor,
    profileObj: profile,
    accountObj: snap?.account ?? null,
  };
}

function noRoute(input: ResolveInput, fails: CandFail[], reason: string): ResolvedRoute {
  const wake = fails.map((f) => f.wakeAt).filter((w): w is string => !!w).sort()[0] ?? null;
  const firstCause = fails.find((f) => f.cause !== 'avoided' && f.cause !== 'constraint' && f.cause !== 'fake_disallowed')?.cause ?? fails[0]?.cause ?? 'no_route';
  return {
    role: input.role,
    profile: null,
    account: null,
    harness: null,
    model: null,
    degraded: [],
    waitUntil: wake,
    reason: fails.length ? `${reason}：${fails.map((f) => f.reason).join('；')}` : reason,
    sameVendorAsWriter: false,
    profileObj: null,
    accountObj: null,
    cause: firstCause,
  };
}

/** 纯解析逻辑（一次快照内确定）；测试直接调用 */
function resolveWith(ctx: RoutingCtx, preset: RoutingPreset, input: ResolveInput): ResolvedRoute {
  const route = derefRoute(preset, input.role);
  if (!route) return noRoute(input, [], `preset ${preset.id} 没有角色 ${input.role} 的路由`);

  // 粘性写手：一旦确定只用这个 profile；额度耗尽 → wait，不换写手（§7.4）
  const sticky = input.role === 'writer' && route.sticky === 'book' ? ctx.writerProfile : null;
  if (sticky) {
    const r = checkProfile(ctx, input, sticky, { constraint: 'none' });
    if (r.ok) return decision(input, r.profile, r.account, [], route);
    return noRoute(input, [r], `写手 ${sticky} 不可用`);
  }

  const fails: CandFail[] = [];
  for (const id of route.chain) {
    const r = checkProfile(ctx, input, id, { constraint: route.constraint });
    if (r.ok) return decision(input, r.profile, r.account, [], route);
    fails.push(r);
  }
  // on_quota=wait 的角色（写手）：全部是额度/并发等待时不降级
  const allWaiting = fails.length > 0 && fails.every((f) => f.cause === 'quota' || f.cause === 'concurrency');
  if (route.on_quota === 'wait' && allWaiting) return noRoute(input, fails, '配额等待');

  const primary = route.chain[0] ?? '';
  for (const id of route.degrade_to) {
    const r = checkProfile(ctx, input, id, { constraint: route.constraint });
    if (r.ok) return decision(input, r.profile, r.account, [{ from: primary, to: id, reason: fails[0]?.reason ?? 'chain 不可用' }], route);
    fails.push(r);
  }
  // 放宽厂商约束（§7.4 第 4 条：不同厂商 → 同厂商 → …）；记录并标黄
  if (route.constraint !== 'none') {
    for (const id of [...route.chain, ...route.degrade_to]) {
      if (id === primary && input.avoidProfiles?.includes(id)) continue;
      const r = checkProfile(ctx, input, id, { constraint: 'none' });
      if (r.ok) {
        const d = decision(input, r.profile, r.account, [{ from: primary, to: id, reason: `放宽约束 ${route.constraint}` }], route);
        return { ...d, sameVendorAsWriter: !!input.writerVendor && vendorOf(r.profile.harness) === input.writerVendor };
      }
      fails.push(r);
    }
  }
  return noRoute(input, fails, `角色 ${input.role} 无可用 profile`);
}

export async function resolveRoute(db: Db, input: ResolveInput): Promise<ResolvedRoute> {
  const [preset, ctx] = await Promise.all([loadRoleRoutes(db, input.book), loadCtx(db, input.book, input.now)]);
  return resolveWith(ctx, preset, input);
}

// ───────────────────────── effective routing ─────────────────────────

function presetFromRow(row: typeof routingPresets.$inferSelect | undefined, id: string): RoutingPreset | null {
  if (row) {
    const parsed = zRoutingPreset.safeParse({ ...row.body, id: row.id, name: row.name, builtin: row.builtin });
    if (parsed.success) return parsed.data;
  }
  const builtin = BUILTIN_PRESETS.find((p) => p.id === id);
  return builtin ? zRoutingPreset.parse(builtin) : null;
}

async function loadPreset(db: Db, id: string): Promise<RoutingPreset | null> {
  const rows = await db.select().from(routingPresets).where(eq(routingPresets.id, id)).limit(1);
  return presetFromRow(rows[0], id);
}

export async function effectiveRouting(db: Db, book: BookHandle | null): Promise<RoutingPreset> {
  const active = await loadActive(db);
  const honorBook = book && !active.forced ? book : null;
  const presetId = honorBook?.config.routing.preset ?? active.presetId ?? DEFAULT_PRESET_ID;
  const preset = (await loadPreset(db, presetId)) ?? (await loadPreset(db, DEFAULT_PRESET_ID));
  if (!preset) throw new Error(`routing preset 不存在：${presetId}`);
  const merged: RoutingPreset = { ...preset, roles: { ...preset.roles } };
  // 全局覆盖只作用于全局 active preset；书级 preset 显式指定时以书为准
  if (!honorBook?.config.routing.preset) {
    for (const [k, v] of Object.entries(active.overrides ?? {})) {
      const parsed = zRoutingPreset.shape.roles.safeParse({ [k]: v });
      if (parsed.success) merged.roles = { ...merged.roles, ...parsed.data };
    }
  }
  if (honorBook) merged.roles = { ...merged.roles, ...honorBook.config.routing.roles };
  return merged;
}

/** 哪些 harness 正在当主笔（熔断 30 分钟保护、failover） */
export async function writerHarnesses(db: Db): Promise<Set<string>> {
  const out = new Set<string>();
  const [rows, profileRows, preset] = await Promise.all([db.select({ w: books.writerProfile }).from(books).where(inArray(books.status, ['active', 'planning'])), db.select().from(profiles), effectiveRouting(db, null)]);
  const harnessOf = new Map(profileRows.map((r) => [r.id, r.harness]));
  for (const r of rows) {
    const h = r.w ? harnessOf.get(r.w) : undefined;
    if (h) out.add(h);
  }
  for (const id of preset.roles.writer?.chain ?? []) {
    const h = harnessOf.get(id);
    if (h) out.add(h);
  }
  return out;
}

// ───────────────────────── 可行性检查 ─────────────────────────

const DEFAULT_ROLES: RoleId[] = ['planner', 'showrunner', 'writer', 'checker', 'confirm', 'extractor', 'format_checker', 'summarizer', 'auditor'];
const STANDARD_ROLES: RoleId[] = ['reviewer', 'continuity', 'judge'];

export interface FeasibilityOptions {
  allowFakeHarness?: boolean;
  now?: Date;
}

/** 开书/改路由时的可行性检查（§7.4）：模拟全部默认角色与已开启的 opt-in 角色 */
export async function checkFeasibility(db: Db, book: BookHandle | null, opts?: FeasibilityOptions): Promise<FeasibilityReport> {
  const now = opts?.now ?? new Date();
  const preset = await effectiveRouting(db, book);
  const ctx = await loadCtx(db, book, now);
  const tier: QualityTier = (book?.config.tier as QualityTier | undefined) ?? 'standard';
  const norm = normalizeTier(tier);
  const roles = new Set<RoleId>(DEFAULT_ROLES);
  if (norm !== 'lite') for (const r of STANDARD_ROLES) roles.add(r);
  for (const r of Object.keys(preset.roles) as RoleId[]) if (!ROUTABLE_ROLES.includes(r)) roles.delete(r);

  const decisions: RouteDecision[] = [];
  const problems: FeasibilityReport['problems'] = [];
  const chosen = new Set<string>();
  let writerVendor: string | null = null;
  const writerDecision = resolveWith(ctx, preset, { role: 'writer', book, tier, now, ignoreConcurrency: true, ...(opts?.allowFakeHarness ? { allowFakeHarness: true } : {}) });
  if (writerDecision.harness) writerVendor = vendorOf(writerDecision.harness);

  for (const role of roles) {
    const d = role === 'writer' ? writerDecision : resolveWith(ctx, preset, { role, book, tier, now, writerVendor, ignoreConcurrency: true, ...(opts?.allowFakeHarness ? { allowFakeHarness: true } : {}) });
    const { profileObj: _p, accountObj: _a, cause: _c, ...view } = d;
    decisions.push(view);
    if (d.profile) chosen.add(d.profile);
    if (!d.profile) problems.push({ severity: 'error', role, message: d.reason ?? `角色 ${role} 无可用路由` });
    else if (d.degraded.length > 0) problems.push({ severity: 'warning', role, message: `角色 ${role} 降级：${d.degraded.map((x) => `${x.from} → ${x.to}（${x.reason}）`).join('；')}` });
    if (d.sameVendorAsWriter) problems.push({ severity: 'warning', role, message: `角色 ${role} 与写手同厂商，结果将标黄` });
  }

  // 模型 slug / 风险说明
  const capRows = await db.select().from(capabilities);
  const profileList = [...chosen].map((id) => ctx.profiles.get(id)).filter((p): p is Profile => !!p);
  for (const p of profileList) {
    const known = new Set<string>();
    for (const r of capRows) if (r.harness === p.harness) for (const m of ((r.body as { models?: string[] }).models ?? [])) known.add(m);
    for (const a of ctx.accounts) if (a.account.harness === p.harness) for (const m of a.account.customModels) known.add(m);
    if (known.size > 0 && !known.has(p.model)) problems.push({ severity: 'warning', role: null, message: `profile ${p.id} 的模型 ${p.model} 不在 ${p.harness} 的已知模型列表中（可在 UI 修改 slug）` });
    for (const ack of p.requires_ack) {
      const note = RISK_NOTES[ack];
      if (note) problems.push({ severity: 'info', role: null, message: note.text });
    }
    if (ctx.openCircuits.has(p.harness)) problems.push({ severity: 'error', role: null, message: `${p.harness} 当前熔断中` });
  }
  if (book?.config.routing.preset === 'fake' || preset.id === 'fake') problems.push({ severity: 'info', role: null, message: 'fake preset：仅测试用，不调用任何模型' });

  return { book: book?.slug ?? null, tier, roles: decisions, problems, chaptersPerWindow: await estimateChapters(db, ctx, chosen, preset) };
}

/** 每窗口可写章数 ≈ (1 − reserve_pct) × 100 ÷ 每章窗口占用率（来自实测账本；无数据 null） */
async function estimateChapters(db: Db, ctx: RoutingCtx, chosen: Set<string>, preset: RoutingPreset): Promise<FeasibilityReport['chaptersPerWindow']> {
  const out: FeasibilityReport['chaptersPerWindow'] = [];
  const writerIds = new Set(preset.roles.writer?.chain ?? []);
  const seen = new Set<string>();
  for (const id of chosen) {
    if (!writerIds.has(id)) continue;
    const profile = ctx.profiles.get(id);
    if (!profile) continue;
    const pool = ctx.accounts.filter((a) => a.account.harness === profile.harness && (profile.accounts.length === 0 || profile.accounts.includes(a.account.id)));
    for (const a of pool) {
      if (seen.has(a.account.id)) continue;
      seen.add(a.account.id);
      const rows = await db
        .select({ d: usageLedger.utilDelta })
        .from(usageLedger)
        .where(and(eq(usageLedger.accountId, a.account.id), eq(usageLedger.profileId, id), eq(usageLedger.taskKind, 'chapter.write')));
      const per: Record<string, { sum: number; n: number }> = {};
      for (const r of rows) {
        for (const [w, v] of Object.entries(r.d ?? {})) {
          per[w] ??= { sum: 0, n: 0 };
          const s = per[w];
          s.sum += Number(v);
          s.n += 1;
        }
      }
      const windows = new Set([...a.account.windows.map((w) => w.window as string), ...Object.keys(per)]);
      if (windows.size === 0) windows.add('7d');
      for (const w of windows) {
        const stat = per[w];
        out.push(
          stat && stat.sum > 0
            ? { accountId: a.account.id, window: w, chapters: Math.floor((100 - a.account.reservePct) / (stat.sum / stat.n)), basis: `实测 ${stat.n} 章的平均占用率` }
            : { accountId: a.account.id, window: w, chapters: null, basis: '无实测数据（待运行后估算）' },
        );
      }
    }
  }
  return out;
}

// ───────────────────────── seed ─────────────────────────

/** 首次启动写入内置 profiles / presets / settings 默认值（已存在则不覆盖） */
export async function seedRouting(db: Db): Promise<void> {
  const now = new Date().toISOString();
  for (const p of BUILTIN_PROFILES) {
    const parsed = zProfile.parse(p);
    await db.insert(profiles).values({ id: parsed.id, harness: parsed.harness, enabled: parsed.enabled, builtin: true, body: parsed as unknown as Record<string, unknown>, updatedAt: now }).onConflictDoNothing({ target: profiles.id });
  }
  for (const p of BUILTIN_PRESETS) {
    const parsed = zRoutingPreset.parse(p);
    // 内置 preset 在 UI 里只能另存为副本，所以可以随版本更新
    await db.insert(routingPresets).values({ id: parsed.id, name: parsed.name, builtin: true, body: parsed as unknown as Record<string, unknown>, updatedAt: now }).onConflictDoUpdate({ target: routingPresets.id, set: { name: parsed.name, body: parsed as unknown as Record<string, unknown>, updatedAt: now }, setWhere: eq(routingPresets.builtin, true) });
  }
  // 早期版本写入的占位 slug（不在 `agy models` 里）；用户自选的值不动
  const [argon] = await db.select().from(profiles).where(eq(profiles.id, 'agy-argon')).limit(1);
  if ((argon?.body as { model?: string } | undefined)?.model === 'gemini-4-argon') {
    await db.update(profiles).set({ body: { ...(argon!.body as object), model: AGY_ARGON_DEFAULT_SLUG }, updatedAt: now }).where(eq(profiles.id, 'agy-argon'));
  }
  await db.insert(settings).values({ key: 'routing.active', value: { presetId: DEFAULT_PRESET_ID, overrides: {} }, updatedAt: now }).onConflictDoNothing({ target: settings.key });
  await db.insert(settings).values({ key: 'system', value: zSystemSettings.parse({}), updatedAt: now }).onConflictDoNothing({ target: settings.key });
}

export async function loadSystemSettings(db: Db): Promise<import('@novelist/shared').SystemSettings> {
  const rows = await db.select().from(settings).where(eq(settings.key, 'system')).limit(1);
  const parsed = zSystemSettings.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : zSystemSettings.parse({});
}

export type { HarnessId };
