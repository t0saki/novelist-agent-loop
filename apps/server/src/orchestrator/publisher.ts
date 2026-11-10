/**
 * 连载发布（DESIGN §9.4；D4 默认）：cadence 槽位到点 → 若 audited_through ≥ 章号且存稿 ≥ lag → 入队 publish 任务。
 * lag=auto → max(当前弧长, min_lag)；存稿 > max_buffer → 暂停该书生产，回落到 resume_buffer 以下恢复；
 * 存稿可维持天数 < low_buffer_days_alert → Inbox 提醒。存稿不足 lag 时宁可空槽，不追赶、不发未审计章。Owner: lane F。
 */
import { Cron } from 'croner';
import { eq, sql } from 'drizzle-orm';
import type { PublishConfig } from '@novelist/shared';
import { zPublishConfig } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { books, publishSchedule } from '../db/schema.js';

export interface BufferState {
  accepted: number;
  audited: number;
  published: number;
  buffer: number;
  lag: number;
  bufferDays: number | null;
  productionPaused: boolean;
}

function effectiveLag(cfg: PublishConfig, arcLength: number): number {
  if (cfg.mode === 'immediate') return 0;
  return cfg.lag === 'auto' ? Math.max(arcLength, cfg.min_lag) : Math.max(cfg.lag, cfg.min_lag);
}

/** 按 cadence 估算每天有几个发布槽位（未来 7 天的平均；乘 per_slot 才是章数） */
export function slotsPerDay(cfg: PublishConfig, from: Date): number {
  if (cfg.mode !== 'scheduled') return 0;
  try {
    const cron = new Cron(cfg.cadence, { timezone: cfg.timezone });
    const end = from.getTime() + 7 * 86400_000;
    let n = 0;
    let cur: Date | null = cron.nextRun(from);
    while (cur && cur.getTime() < end && n < 7 * 24 * 60) {
      n += 1;
      cur = cron.nextRun(cur);
    }
    return n / 7;
  } catch {
    return 0;
  }
}

export async function bufferState(db: Db, bookId: string, cfg: PublishConfig, arcLength: number, now: Date = new Date()): Promise<BufferState> {
  const rows = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  const b = rows[0];
  if (!b) throw new Error(`book not found: ${bookId}`);
  const buffer = Math.max(0, b.acceptedThrough - b.publishedThrough);
  const perDay = slotsPerDay(cfg, now) * cfg.per_slot;
  return {
    accepted: b.acceptedThrough,
    audited: b.auditedThrough,
    published: b.publishedThrough,
    buffer,
    lag: effectiveLag(cfg, arcLength),
    bufferDays: perDay > 0 ? buffer / perDay : null,
    productionPaused: b.pausedReason === 'max_buffer',
  };
}

/** 计算下一批槽位时间（croner） */
export function nextSlots(cfg: PublishConfig, from: Date, count: number): string[] {
  if (cfg.mode !== 'scheduled') return [];
  const out: string[] = [];
  const cron = new Cron(cfg.cadence, { timezone: cfg.timezone });
  let cur: Date | null = from;
  for (let i = 0; i < count && cur; i += 1) {
    cur = cron.nextRun(cur);
    if (cur) out.push(cur.toISOString());
  }
  return out;
}

/**
 * 这一刻（slot 到点时）最多可以发到第几章（返回 ≤ published 表示不发）。
 * v3Cap 给出时（v3 书，flow/publish.ts）：不看 lag 与审计，只按 v3 规则的上限和 per_slot 节奏。
 */
export function eligibleThrough(state: Pick<BufferState, 'accepted' | 'audited' | 'published' | 'lag'>, cfg: PublishConfig, ignoreAudit = false, v3Cap?: number): number {
  if (v3Cap !== undefined) {
    const cap = Math.min(v3Cap, state.accepted);
    return cfg.mode === 'immediate' ? cap : Math.min(cap, state.published + cfg.per_slot);
  }
  const byBuffer = state.accepted - state.lag + 1;
  let through = cfg.mode === 'immediate' ? state.accepted : Math.min(byBuffer, state.published + cfg.per_slot);
  if (cfg.require_audited && !ignoreAudit && cfg.mode !== 'immediate') through = Math.min(through, state.audited);
  return Math.min(through, state.accepted);
}

export interface PublishIo {
  /** 读书的发布配置与当前弧长（默认：books.meta.publishConfig，弧长 0） */
  loadConfig?(bookId: string): Promise<{ cfg: PublishConfig; arcLength: number; v3Cap?: number }>;
  /** 入队 publish 任务（publish.execute 打 tag、写前沿）；默认不入队（仅更新水位，测试用） */
  enqueue?(input: { bookId: string; through: number; slot: string | null }): Promise<boolean | void>;
  /** 存稿告警（Inbox） */
  lowBuffer?(input: { bookId: string; bufferDays: number }): Promise<void>;
  /** 生产暂停/恢复（Inbox / 总线） */
  productionChanged?(input: { bookId: string; paused: boolean; buffer: number }): Promise<void>;
  /** 存稿超上限但没有可发布章节（lag/审计卡住）：不暂停生产，提醒 owner */
  bufferBlocked?(input: { bookId: string; buffer: number; lag: number; audited: number; published: number }): Promise<void>;
}

const LOW_BUFFER_COOLDOWN_MS = 24 * 3600_000;

/** 现在能否发布出至少一章（不考虑 per_slot 与 cadence）：false 时暂停生产只会和发布互等 */
function canDrain(state: BufferState, cfg: PublishConfig, v3Cap?: number): boolean {
  if (cfg.mode === 'manual') return true; // 手动模式 owner 随时能发布
  return eligibleThrough(state, { ...cfg, per_slot: Number.MAX_SAFE_INTEGER }, false, v3Cap) > state.published;
}

interface PublishMeta {
  lastSlot?: string;
}

/** 每分钟一次：推进 cadence 水位，到点的槽位按 lag/审计入队 publish；检查 max_buffer；检查存稿告警 */
export async function publishTick(db: Db, now: Date, io: PublishIo = {}): Promise<{ bookId: string; through: number }[]> {
  const rows = await db.select().from(books);
  const out: { bookId: string; through: number }[] = [];
  for (const b of rows) {
    if (b.status === 'archived' || b.status === 'draft' || b.status === 'importing') continue;
    const loaded = io.loadConfig ? await io.loadConfig(b.id).catch(() => null) : null;
    const cfg = loaded?.cfg ?? zPublishConfig.parse((b.meta as { publishConfig?: unknown }).publishConfig ?? {});
    const state = await bufferState(db, b.id, cfg, loaded?.arcLength ?? 0, now);
    const v3Cap = loaded?.v3Cap;
    // v3：存稿上限由 decideNext / prepareV3 自己拦；“超上限但暂时没有可发布章节”是两批之间的常态，不发这两类待办
    const v3 = v3Cap !== undefined;

    const drainable = canDrain(state, cfg, v3Cap);
    if (state.buffer > cfg.max_buffer && b.pausedReason !== 'max_buffer' && b.status === 'active') {
      if (drainable) {
        await db.update(books).set({ pausedReason: 'max_buffer', updatedAt: now.toISOString() }).where(eq(books.id, b.id));
        await io.productionChanged?.({ bookId: b.id, paused: true, buffer: state.buffer });
      } else if (!v3) {
        await io.bufferBlocked?.({ bookId: b.id, buffer: state.buffer, lag: state.lag, audited: state.audited, published: state.published }).catch(() => {});
      }
    } else if (b.pausedReason === 'max_buffer' && (state.buffer <= cfg.resume_buffer || !drainable)) {
      await db.update(books).set({ pausedReason: null, updatedAt: now.toISOString() }).where(eq(books.id, b.id));
      await io.productionChanged?.({ bookId: b.id, paused: false, buffer: state.buffer });
      if (!drainable && state.buffer > cfg.resume_buffer && !v3) await io.bufferBlocked?.({ bookId: b.id, buffer: state.buffer, lag: state.lag, audited: state.audited, published: state.published }).catch(() => {});
    }

    const alertedAt = (b.meta as { lowBufferAlertAt?: string }).lowBufferAlertAt;
    const finished = b.status === 'completed' && state.accepted === state.published;
    if (!v3 && state.bufferDays !== null && state.published > 0 && state.bufferDays < cfg.low_buffer_days_alert && !finished && (!alertedAt || now.getTime() - new Date(alertedAt).getTime() >= LOW_BUFFER_COOLDOWN_MS)) {
      await io.lowBuffer?.({ bookId: b.id, bufferDays: state.bufferDays }).catch(() => {});
      await mergeMeta(db, b.id, { lowBufferAlertAt: now.toISOString() });
    }

    if (cfg.mode === 'manual' || b.status === 'paused') continue;

    if (cfg.mode === 'immediate') {
      const through = eligibleThrough(state, cfg, false, v3Cap);
      if (through > state.published) {
        const created = await enqueueSafe(io, { bookId: b.id, through, slot: null });
        await markScheduled(db, b.id, state.published + 1, through, null, now);
        if (created) out.push({ bookId: b.id, through });
      }
      continue;
    }

    // scheduled：只处理“上次水位之后最近的一个到点槽位”，错过的不追赶（宁可空槽）
    const meta = (b.meta ?? {}) as { publish?: PublishMeta };
    const lastSlot = meta.publish?.lastSlot ? new Date(meta.publish.lastSlot) : null;
    if (!lastSlot) {
      await mergeMeta(db, b.id, { publish: { lastSlot: now.toISOString() } });
      continue;
    }
    let slot: Date | null = null;
    try {
      const cron = new Cron(cfg.cadence, { timezone: cfg.timezone });
      let cur: Date | null = cron.nextRun(lastSlot);
      let guard = 0;
      while (cur && cur.getTime() <= now.getTime() && guard < 2000) {
        slot = cur;
        cur = cron.nextRun(cur);
        guard += 1;
      }
    } catch {
      continue; // cadence 配置错误：UI 校验负责提示
    }
    if (!slot) continue;
    await mergeMeta(db, b.id, { publish: { lastSlot: slot.toISOString() } });
    const through = eligibleThrough(state, cfg, false, v3Cap);
    if (through <= state.published) continue;
    const created = await enqueueSafe(io, { bookId: b.id, through, slot: slot.toISOString() });
    await markScheduled(db, b.id, state.published + 1, through, slot.toISOString(), now);
    if (created) out.push({ bookId: b.id, through });
  }
  return out;
}

/** 只合并给定的键（jsonb ||）：tick 开头的快照可能已过时，不能整体回写 meta（会丢掉 audit 进度） */
async function mergeMeta(db: Db, bookId: string, patch: Record<string, unknown>): Promise<void> {
  await db.update(books).set({ meta: sql`${books.meta} || ${JSON.stringify(patch)}::jsonb` }).where(eq(books.id, bookId));
}

async function enqueueSafe(io: PublishIo, input: { bookId: string; through: number; slot: string | null }): Promise<boolean> {
  try {
    const r = await io.enqueue?.(input);
    return r !== false;
  } catch {
    return false;
  }
}

async function markScheduled(db: Db, bookId: string, from: number, to: number, slot: string | null, now: Date): Promise<void> {
  for (let no = from; no <= to; no += 1) {
    await db.insert(publishSchedule).values({ bookId, no, notBefore: now.toISOString(), slot, state: 'queued' }).onConflictDoNothing();
  }
}
