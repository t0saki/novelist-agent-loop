/**
 * books.meta.v3 的原子更新（p1-plan §1.9、§2.16）。
 * pending / emptyStreak / locked 只用单条语句的 jsonb 更新，从不在事务外读-改-写；批次字段由 'v3.batch' 效果在事务里写。
 */
import { type SQL, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { books } from '../db/schema.js';
import type { V3BookMeta, V3Hint, V3Pending } from './types.js';

export function emptyV3Meta(): V3BookMeta {
  return { hints: [], noChapterStreak: 0, emptyStreak: 0, finaleNoMarker: 0, lastBatchFrom: null, lastBatchAt: null, hintedShort: [], locked: [], pending: null };
}

const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x)) : []);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** books.meta（任意 jsonb）→ 补齐默认值的 V3BookMeta（纯函数） */
export function readV3Meta(meta: unknown): V3BookMeta {
  const raw = ((meta as { v3?: unknown } | null)?.v3 ?? {}) as Record<string, unknown>;
  const base = emptyV3Meta();
  return {
    ...base,
    hints: Array.isArray(raw.hints) ? (raw.hints as V3Hint[]).filter((h) => h && typeof h.kind === 'string' && typeof h.text === 'string') : [],
    noChapterStreak: int(raw.noChapterStreak),
    emptyStreak: int(raw.emptyStreak),
    finaleNoMarker: int(raw.finaleNoMarker),
    lastBatchFrom: typeof raw.lastBatchFrom === 'number' ? raw.lastBatchFrom : null,
    lastBatchAt: typeof raw.lastBatchAt === 'string' ? raw.lastBatchAt : null,
    hintedShort: nums(raw.hintedShort),
    locked: nums(raw.locked),
    pending: raw.pending && typeof raw.pending === 'object' ? (raw.pending as V3Pending) : null,
    ...(typeof raw.completedAt === 'string' ? { completedAt: raw.completedAt } : {}),
    ...(raw.completedReason === 'marker' || raw.completedReason === 'no_marker_twice' ? { completedReason: raw.completedReason } : {}),
  };
}

/** meta.v3 合并一个对象（meta.v3 不存在时先建空对象）：jsonb_set(meta,'{v3}', coalesce(meta->'v3','{}') || patch) */
const v3Merge = (patch: SQL) => sql`jsonb_set(coalesce(${books.meta}, '{}'::jsonb), '{v3}', coalesce(${books.meta}->'v3', '{}'::jsonb) || ${patch}, true)`;

/** jsonb_set(meta, '{v3,pending}', $p) */
export async function setPending(db: Db, bookId: string, p: V3Pending): Promise<void> {
  await db
    .update(books)
    .set({ meta: v3Merge(sql`jsonb_build_object('pending', ${JSON.stringify(p)}::jsonb)`) })
    .where(eq(books.id, bookId));
}

/** 只在 pending.runId = runId 时合并 patch；opts.incFailures 用 jsonb 算术把 failures +1。返回更新后的 pending（不匹配时 null） */
export async function patchPending(db: Db, bookId: string, runId: string, patch: Partial<V3Pending>, opts: { incFailures?: boolean } = {}): Promise<V3Pending | null> {
  const inc = opts.incFailures === true;
  const rows = await db
    .update(books)
    .set({
      meta: sql`jsonb_set(${books.meta}, '{v3,pending}', (${books.meta}->'v3'->'pending') || ${JSON.stringify(patch)}::jsonb || (case when ${inc}::boolean then jsonb_build_object('failures', coalesce((${books.meta}->'v3'->'pending'->>'failures')::int, 0) + 1) else '{}'::jsonb end), false)`,
    })
    .where(sql`${books.id} = ${bookId} and ${books.meta}->'v3'->'pending'->>'runId' = ${runId}`)
    .returning({ pending: sql<V3Pending | null>`${books.meta}->'v3'->'pending'` });
  return rows[0]?.pending ?? null;
}

/** where meta->'v3'->'pending'->>'runId' = $runId */
export async function clearPending(db: Db, bookId: string, runId: string): Promise<void> {
  await db
    .update(books)
    .set({ meta: sql`jsonb_set(${books.meta}, '{v3,pending}', 'null'::jsonb, false)` })
    .where(sql`${books.id} = ${bookId} and ${books.meta}->'v3'->'pending'->>'runId' = ${runId}`);
}

export async function readPending(db: Db, bookId: string): Promise<V3Pending | null> {
  const rows = await db.select({ meta: books.meta }).from(books).where(eq(books.id, bookId)).limit(1);
  return rows[0] ? readV3Meta(rows[0].meta).pending : null;
}

/** 书的空跑连击：inc = +1，reset = 0；返回新值 */
export async function bumpBookEmpty(db: Db, bookId: string, op: 'inc' | 'reset'): Promise<number> {
  const next = op === 'inc' ? sql`coalesce((${books.meta}->'v3'->>'emptyStreak')::int, 0) + 1` : sql`0`;
  const rows = await db
    .update(books)
    .set({ meta: v3Merge(sql`jsonb_build_object('emptyStreak', ${next})`) })
    .where(eq(books.id, bookId))
    .returning({ n: sql<number>`(${books.meta}->'v3'->>'emptyStreak')::int` });
  return Number(rows[0]?.n ?? 0);
}

/** 主人改过的章节：追加到 meta.v3.locked（已有则不变） */
export async function lockChapter(db: Db, bookId: string, no: number): Promise<void> {
  const cur = sql`coalesce(${books.meta}->'v3'->'locked', '[]'::jsonb)`;
  await db
    .update(books)
    .set({ meta: v3Merge(sql`jsonb_build_object('locked', case when ${cur} @> jsonb_build_array(${no}::int) then ${cur} else ${cur} || jsonb_build_array(${no}::int) end)`) })
    .where(eq(books.id, bookId));
}
