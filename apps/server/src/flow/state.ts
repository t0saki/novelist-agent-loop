/**
 * books.meta.v3 的原子更新（p1-plan §1.9、§2.16）。
 * pending / emptyStreak / locked 只用单条语句的 jsonb 更新，从不在事务外读-改-写；批次字段由 'v3.batch' 效果在事务里写。
 */
import { type SQL, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { books } from '../db/schema.js';
import type { V3AgentsSize, V3BatchLogEntry, V3BatchNote, V3BookMeta, V3Hint, V3OwnerMessageMeta, V3OwnerRequest, V3Pending, V3Sched } from './types.js';

export function emptyV3Meta(): V3BookMeta {
  return {
    hints: [],
    noChapterStreak: 0,
    emptyStreak: 0,
    finaleNoMarker: 0,
    lastBatchFrom: null,
    lastBatchAt: null,
    hintedShort: [],
    locked: [],
    pending: null,
    batchLog: [],
    retro: { afterBatches: 0, lastAt: null, lastRunId: null, lastStatus: null },
    runawayBatches: 0,
    finaleNoMarkerAlerted: false,
    shortEndUsed: false,
    plannedFloor: null,
    feedback: null,
    batchNote: null,
    agentsSize: null,
    sched: null,
    rewinding: null,
    ownerMessage: null,
    ownerMessages: [],
    ownerRequests: [],
    takeover: null,
  };
}

function readAgentsSize(v: unknown): V3AgentsSize | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (typeof a.bytes !== 'number') return null;
  return {
    bytes: a.bytes,
    hard: a.hard === true,
    limit: typeof a.limit === 'number' ? a.limit : 0,
    harness: typeof a.harness === 'string' ? a.harness : '',
    at: typeof a.at === 'string' ? a.at : '',
    layers: Array.isArray(a.layers) ? a.layers.filter((l): l is { layer: string; bytes: number } => !!l && typeof l === 'object' && typeof (l as { layer?: unknown }).layer === 'string' && typeof (l as { bytes?: unknown }).bytes === 'number') : [],
  };
}

function readSched(v: unknown): V3Sched | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  return { bufferDays: typeof s.bufferDays === 'number' && Number.isFinite(s.bufferDays) ? s.bufferDays : null, bufferFull: s.bufferFull === true, at: typeof s.at === 'string' ? s.at : '' };
}

const RETRO_STATUSES = ['done', 'failed', 'empty'] as const;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function readRetro(v: unknown): V3BookMeta['retro'] {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const st = r.lastStatus;
  return {
    afterBatches: Math.max(0, int(r.afterBatches)),
    lastAt: strOrNull(r.lastAt),
    lastRunId: strOrNull(r.lastRunId),
    lastStatus: (RETRO_STATUSES as readonly unknown[]).includes(st) ? (st as V3BookMeta['retro']['lastStatus']) : null,
  };
}

function readBatchLog(v: unknown): V3BatchLogEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is V3BatchLogEntry => !!e && typeof e === 'object' && typeof (e as V3BatchLogEntry).from === 'number' && typeof (e as V3BatchLogEntry).to === 'number');
}

function readFeedback(v: unknown): V3BookMeta['feedback'] {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  if (typeof f.from !== 'number' || typeof f.to !== 'number') return null;
  return { from: f.from, to: f.to, phrases: Array.isArray(f.phrases) ? f.phrases.filter((x): x is string => typeof x === 'string') : [] };
}

function readBatchNote(v: unknown): V3BatchNote | null {
  if (!v || typeof v !== 'object') return null;
  const n = v as Record<string, unknown>;
  return typeof n.from === 'number' && typeof n.to === 'number' && typeof n.at === 'string' ? (n as unknown as V3BatchNote) : null;
}

function readRewinding(v: unknown): V3BookMeta['rewinding'] {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  return typeof r.to === 'number' && typeof r.ts === 'string' ? { to: r.to, ts: r.ts, at: typeof r.at === 'string' ? r.at : '', ...(typeof r.note === 'string' ? { note: r.note } : {}) } : null;
}

const MESSAGE_STATUSES = ['waiting', 'read', 'replaced', 'withdrawn'] as const;
function readOwnerMessage(v: unknown): V3OwnerMessageMeta | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (typeof m.text !== 'string' || typeof m.sha !== 'string') return null;
  const status = (MESSAGE_STATUSES as readonly unknown[]).includes(m.status) ? (m.status as V3OwnerMessageMeta['status']) : 'waiting';
  const readIn = m.readIn && typeof m.readIn === 'object' ? (m.readIn as V3OwnerMessageMeta['readIn']) : null;
  return { id: typeof m.id === 'string' ? m.id : '', text: m.text, sha: m.sha, setAt: typeof m.setAt === 'string' ? m.setAt : '', readIn, archivedPath: strOrNull(m.archivedPath), status };
}

const REQUEST_STATUSES = ['waiting', 'done', 'not_done', 'dropped'] as const;
function readOwnerRequests(v: unknown): V3OwnerRequest[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is V3OwnerRequest => !!r && typeof r === 'object' && typeof (r as V3OwnerRequest).id === 'string' && typeof (r as V3OwnerRequest).chapter === 'number' && (REQUEST_STATUSES as readonly unknown[]).includes((r as V3OwnerRequest).status),
  );
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
    ...(raw.completedReason === 'marker' || raw.completedReason === 'no_marker_twice' || raw.completedReason === 'backstop' ? { completedReason: raw.completedReason } : {}),
    ...(raw.completedNote === 'short' ? { completedNote: 'short' as const } : {}),
    batchLog: readBatchLog(raw.batchLog),
    retro: readRetro(raw.retro),
    runawayBatches: Math.max(0, int(raw.runawayBatches)),
    finaleNoMarkerAlerted: raw.finaleNoMarkerAlerted === true,
    shortEndUsed: raw.shortEndUsed === true,
    plannedFloor: typeof raw.plannedFloor === 'number' && raw.plannedFloor > 0 ? raw.plannedFloor : null,
    feedback: readFeedback(raw.feedback),
    batchNote: readBatchNote(raw.batchNote),
    agentsSize: readAgentsSize(raw.agentsSize),
    sched: readSched(raw.sched),
    rewinding: readRewinding(raw.rewinding),
    ownerMessage: readOwnerMessage(raw.ownerMessage),
    ownerMessages: Array.isArray(raw.ownerMessages) ? raw.ownerMessages.map(readOwnerMessage).filter((m): m is V3OwnerMessageMeta => m !== null) : [],
    ownerRequests: readOwnerRequests(raw.ownerRequests),
    takeover: readTakeover(raw.takeover),
    ...(raw.writeNow === true ? { writeNow: true } : {}),
  };
}

function readTakeover(v: unknown): V3BookMeta['takeover'] {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (typeof t.from !== 'number' || !Number.isInteger(t.from) || t.from < 1) return null;
  return { at: typeof t.at === 'string' ? t.at : '', from: t.from, status: t.status === 'done' ? 'done' : 'pending' };
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

/** WP-3：排班用的存稿状况（meta.v3.sched），单条 jsonb 合并 */
export async function setSched(db: Db, bookId: string, s: V3Sched): Promise<void> {
  await db
    .update(books)
    .set({ meta: v3Merge(sql`jsonb_build_object('sched', ${JSON.stringify(s)}::jsonb)`) })
    .where(eq(books.id, bookId));
}

/** WP-3：AGENTS.md 超过 16 KB 的记录（null = 清掉），单条 jsonb 合并 */
export async function setAgentsSize(db: Db, bookId: string, a: V3AgentsSize | null): Promise<void> {
  await db
    .update(books)
    .set({ meta: v3Merge(sql`jsonb_build_object('agentsSize', ${JSON.stringify(a)}::jsonb)`) })
    .where(eq(books.id, bookId));
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
  // 锁住书行一次改两项：锁定这一章，同一章还在等的主人改写请求作废（主人亲手改过就以主人为准，作者不能再覆盖）
  await patchV3Meta(db, bookId, (meta) => {
    const locked = meta.locked.includes(no) ? meta.locked : [...meta.locked, no];
    const waiting = meta.ownerRequests.some((r) => r.status === 'waiting' && r.chapter === no);
    if (locked === meta.locked && !waiting) return { patch: null, result: undefined };
    return { patch: { locked, ...(waiting ? { ownerRequests: dropRequestsFor(meta.ownerRequests, no) } : {}) }, result: undefined };
  });
}

/** 第 no 章还在等的改写请求 → dropped（主人直接改了 / 采用草稿覆盖了这一章） */
export function dropRequestsFor(list: V3OwnerRequest[], no: number): V3OwnerRequest[] {
  return list.map((r) => (r.status === 'waiting' && r.chapter === no ? { ...r, status: 'dropped' as const } : r));
}

/** 复盘结束（成功、失败、空跑都算“做过了”）：afterBatches = 当前 batchLog 长度，下一次复盘再过 RETRO_EVERY 批 */
export async function markRetro(db: Db, bookId: string, r: { status: 'done' | 'failed' | 'empty'; runId: string; at: string }): Promise<void> {
  const len = sql`coalesce(jsonb_array_length(case when jsonb_typeof(${books.meta}->'v3'->'batchLog') = 'array' then ${books.meta}->'v3'->'batchLog' else '[]'::jsonb end), 0)`;
  await db
    .update(books)
    .set({ meta: v3Merge(sql`jsonb_build_object('retro', jsonb_build_object('afterBatches', ${len}, 'lastAt', ${r.at}::text, 'lastRunId', ${r.runId}::text, 'lastStatus', ${r.status}::text))`) })
    .where(eq(books.id, bookId));
}

/**
 * meta.v3 的读-改-写（主人的操作用）：一个事务里 select … for update 锁住书行，fn 返回要合并进 meta.v3 的字段（null = 不写）。
 * 与 'v3.batch' 效果同一把行锁，所以不会和收稿互相覆盖。返回 fn 的第二个结果。
 * 旧书（meta.v3 不是对象，P3 D1）什么都不写：主人的操作不能顺手把旧书变成没有接手标记的 v3 书（只有开书、接手、开机补 meta 会建 meta.v3）。
 */
export async function patchV3Meta<R>(db: Db | Tx, bookId: string, fn: (meta: V3BookMeta, row: typeof books.$inferSelect) => { patch: Partial<V3BookMeta> | null; result: R }): Promise<R> {
  const run = async (tx: Tx | Db): Promise<R> => {
    const row = (await tx.select().from(books).where(eq(books.id, bookId)).limit(1).for('update'))[0];
    if (!row) throw new Error(`书不存在：${bookId}`);
    const { patch, result } = fn(readV3Meta(row.meta), row);
    const v3 = (row.meta as { v3?: unknown } | null)?.v3;
    if (!v3 || typeof v3 !== 'object' || Array.isArray(v3)) return result;
    if (patch) await tx.update(books).set({ meta: v3Merge(sql`${JSON.stringify(patch)}::jsonb`) }).where(eq(books.id, bookId));
    return result;
  };
  return (db as Db).transaction((tx) => run(tx));
}

/** 主人留言的 meta：ownerMessage = next；history（被替换 / 撤回 / 读过的旧留言）放到 ownerMessages 最前面，最多留 20 条 */
export async function setOwnerMessageMeta(db: Db, bookId: string, next: V3OwnerMessageMeta | null, history: V3OwnerMessageMeta | null): Promise<void> {
  await patchV3Meta(db, bookId, (m) => ({ patch: { ownerMessage: next, ownerMessages: history ? [history, ...m.ownerMessages].slice(0, 20) : m.ownerMessages }, result: undefined }));
}
