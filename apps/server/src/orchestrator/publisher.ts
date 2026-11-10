/**
 * 连载发布（DESIGN §3.4）：cadence 槽位到点 → 按 v3 的可发布上限（flow/publish.ts#v3PublishCap）和 per_slot 入队 publish 任务。
 * 存稿 > max_buffer → 暂停该书生产，回落到 resume_buffer 以下恢复。错过的槽位不追赶（宁可空槽）。
 * 旧书不发布（loadConfig 返回 'skip'）；旧流程的 lag / 审计前沿 / 存稿告警都已删除。
 */
import { Cron } from 'croner';
import { eq, sql } from 'drizzle-orm';
import type { PublishConfig } from '@novelist/shared';
import { zPublishConfig } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { books, publishSchedule } from '../db/schema.js';

export interface BufferState {
  accepted: number;
  published: number;
  buffer: number;
  bufferDays: number | null;
  productionPaused: boolean;
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

export async function bufferState(db: Db, bookId: string, cfg: PublishConfig, now: Date = new Date()): Promise<BufferState> {
  const rows = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  const b = rows[0];
  if (!b) throw new Error(`book not found: ${bookId}`);
  const buffer = Math.max(0, b.acceptedThrough - b.publishedThrough);
  const perDay = slotsPerDay(cfg, now) * cfg.per_slot;
  return {
    accepted: b.acceptedThrough,
    published: b.publishedThrough,
    buffer,
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
 * 这一刻（slot 到点时）最多可以发到第几章（返回 ≤ published 表示不发）：v3 规则的上限（v3Cap）和 per_slot 节奏。
 * 没给上限（undefined）就什么都不发：发布对读者撤不回，拿不到 v3 规则时宁可不发。require_audited / lag / min_lag 不再看。
 */
export function eligibleThrough(state: Pick<BufferState, 'accepted' | 'published'>, cfg: PublishConfig, v3Cap: number | undefined): number {
  if (v3Cap === undefined) return state.published;
  const cap = Math.min(v3Cap, state.accepted);
  return cfg.mode === 'immediate' ? cap : Math.min(cap, state.published + cfg.per_slot);
}

export interface PublishIo {
  /**
   * 读书的发布配置与 v3 可发布上限；'skip' = 不是 v3 书（旧书不再发布，P3 D13）。出错时这一分钟跳过这本书（不发布、不改暂停、不推进槽位水位）。
   * 没提供（只有测试）：books.meta.publishConfig，上限 = 已收章数。
   */
  loadConfig?(bookId: string): Promise<{ cfg: PublishConfig; v3Cap: number } | 'skip'>;
  /** 入队 publish 任务（publish.execute 打 tag、写前沿）；默认不入队（仅更新水位，测试用） */
  enqueue?(input: { bookId: string; through: number; slot: string | null }): Promise<boolean | void>;
  /** 生产暂停/恢复（Inbox / 总线） */
  productionChanged?(input: { bookId: string; paused: boolean; buffer: number }): Promise<void>;
}

/** 现在能否发布出至少一章（不考虑 per_slot 与 cadence）：false 时暂停生产只会和发布互等 */
function canDrain(state: BufferState, cfg: PublishConfig, v3Cap: number | undefined): boolean {
  if (cfg.mode === 'manual') return true; // 手动模式 owner 随时能发布
  return eligibleThrough(state, { ...cfg, per_slot: Number.MAX_SAFE_INTEGER }, v3Cap) > state.published;
}

interface PublishMeta {
  lastSlot?: string;
}

/** 每分钟一次：推进 cadence 水位，到点的槽位入队 publish；检查 max_buffer */
export async function publishTick(db: Db, now: Date, io: PublishIo = {}): Promise<{ bookId: string; through: number }[]> {
  const rows = await db.select().from(books);
  const out: { bookId: string; through: number }[] = [];
  for (const b of rows) {
    if (b.status === 'archived' || b.status === 'draft' || b.status === 'importing') continue;
    let loaded: { cfg: PublishConfig; v3Cap: number } | 'skip' | null = null;
    if (io.loadConfig) {
      try {
        loaded = await io.loadConfig(b.id);
      } catch {
        // 读不到 book.yaml / v3 上限（瞬时故障、写到一半的文件）：这一分钟不碰这本书，lastSlot 不推进，下一分钟按 v3 规则补上
        continue;
      }
    }
    if (loaded === 'skip') continue;
    const cfg = loaded?.cfg ?? zPublishConfig.parse((b.meta as { publishConfig?: unknown }).publishConfig ?? {});
    const state = await bufferState(db, b.id, cfg, now);
    // 测试用的默认 io（没有 loadConfig）：上限 = 已收章数，显式给出
    const v3Cap = loaded ? loaded.v3Cap : state.accepted;

    // 存稿上限由 decideNext / prepareV3 自己拦；“超上限但暂时没有可发布章节”是两批之间的常态，不暂停也不发待办
    const drainable = canDrain(state, cfg, v3Cap);
    if (state.buffer > cfg.max_buffer && b.pausedReason !== 'max_buffer' && b.status === 'active') {
      if (drainable) {
        await db.update(books).set({ pausedReason: 'max_buffer', updatedAt: now.toISOString() }).where(eq(books.id, b.id));
        await io.productionChanged?.({ bookId: b.id, paused: true, buffer: state.buffer });
      }
    } else if (b.pausedReason === 'max_buffer' && (state.buffer <= cfg.resume_buffer || !drainable)) {
      await db.update(books).set({ pausedReason: null, updatedAt: now.toISOString() }).where(eq(books.id, b.id));
      await io.productionChanged?.({ bookId: b.id, paused: false, buffer: state.buffer });
    }

    if (cfg.mode === 'manual' || b.status === 'paused') continue;

    if (cfg.mode === 'immediate') {
      const through = eligibleThrough(state, cfg, v3Cap);
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
    const through = eligibleThrough(state, cfg, v3Cap);
    if (through <= state.published) continue;
    const created = await enqueueSafe(io, { bookId: b.id, through, slot: slot.toISOString() });
    await markScheduled(db, b.id, state.published + 1, through, slot.toISOString(), now);
    if (created) out.push({ bookId: b.id, through });
  }
  return out;
}

/** 只合并给定的键（jsonb ||）：tick 开头的快照可能已过时，不能整体回写 meta */
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
