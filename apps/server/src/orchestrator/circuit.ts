/**
 * 熔断（DESIGN §3.8）：按 (harness, version, isolation)，24h 滑动窗口，≥20 个 run 才判定；比率阈值；
 * 疑似先自动重跑一次 canary；主笔 harness 熔断先发 Inbox，30 分钟后生效（期间 owner 可否决）。Owner: lane F。
 *
 * 状态：closed → (疑似) pending_open（effective_at 为空 = 等 canary）→ canary 失败 → pending_open(+30min) 或 open；
 * canary 通过 → closed（样本清零）。open 1 小时后 half_open 再跑 canary。路由把 open/half_open 视为不可用。
 */
import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import type { ErrorClass } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { circuitBreakers } from '../db/schema.js';

export type CircuitState = 'closed' | 'pending_open' | 'open' | 'half_open';

interface Sample {
  ts: string;
  cls: string | null;
  unk: number;
  tail: boolean;
  contract: number;
}
interface Samples {
  runs: Sample[];
  pendingCanary?: boolean;
  canaryFailedAt?: string;
}

const WINDOW_MS = 24 * 3600_000;
export const MIN_SAMPLES = 20;
export const PENDING_OPEN_MS = 30 * 60_000;
const HALF_OPEN_AFTER_MS = 3600_000;
const MAX_SAMPLES = 2000;

function ratio(samples: Sample[], pred: (s: Sample) => boolean): number {
  return samples.length ? samples.filter(pred).length / samples.length : 0;
}

/** §3.8 判定：返回触发原因（null = 正常） */
export function evaluateCircuit(samples: Sample[], prevContractRate: number | null): string | null {
  if (samples.length < MIN_SAMPLES) return null;
  const n = samples.length;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const drift = ratio(samples, (s) => s.cls === 'drift');
  if (drift > 0.02) return `drift ${pct(drift)} > 2%`;
  const unk = samples.reduce((a, s) => a + s.unk, 0) / n;
  if (unk > 0.05) return `unknown 事件占比 ${pct(unk)} > 5%`;
  const cfg = ratio(samples, (s) => s.cls === 'config' || s.cls === 'sandbox' || s.cls === 'permission_denied');
  if (cfg > 0.05) return `config/sandbox ${pct(cfg)} > 5%`;
  const tail = ratio(samples, (s) => s.tail);
  if (tail > 0.2) return `TAIL nonce 缺失 ${pct(tail)} > 20%`;
  const crash = ratio(samples, (s) => s.cls === 'harness_crash');
  if (crash > 0.1) return `harness_crash ${pct(crash)} > 10%`;
  const contract = ratio(samples, (s) => s.contract > 0 || s.cls === 'output_contract');
  const baseline = prevContractRate ?? 0.05;
  if (contract > 0.1 && contract >= 2 * baseline) return `output_contract ${pct(contract)} ≥ 2×基线(${pct(baseline)})`;
  return null;
}

async function getRow(db: Db, harness: string, version: string, isolation: string) {
  const rows = await db
    .select()
    .from(circuitBreakers)
    .where(and(eq(circuitBreakers.harness, harness), eq(circuitBreakers.version, version), eq(circuitBreakers.isolation, isolation)))
    .limit(1);
  return rows[0] ?? null;
}

function samplesOf(row: { samples: Record<string, unknown> } | null): Samples {
  const s = (row?.samples ?? {}) as Partial<Samples>;
  return { ...s, runs: Array.isArray(s.runs) ? s.runs : [] };
}

export interface RecordRunInput {
  harness: string;
  version: string;
  isolation: string;
  errorClass: ErrorClass | null;
  unknownEventRatio: number;
  tailNonceMissing: boolean;
  contractViolations: number;
  now?: Date;
}

export async function recordRun(db: Db, input: RecordRunInput): Promise<CircuitState> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  return db.transaction(async (tx) => {
    await tx.insert(circuitBreakers).values({ harness: input.harness, version: input.version, isolation: input.isolation }).onConflictDoNothing();
    const rows = await tx
      .select()
      .from(circuitBreakers)
      .where(and(eq(circuitBreakers.harness, input.harness), eq(circuitBreakers.version, input.version), eq(circuitBreakers.isolation, input.isolation)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (!row) return 'closed';
    const samples = samplesOf(row);
    const cutoff = now.getTime() - WINDOW_MS;
    samples.runs = [...samples.runs.filter((s) => new Date(s.ts).getTime() >= cutoff), { ts: nowIso, cls: input.errorClass, unk: input.unknownEventRatio, tail: input.tailNonceMissing, contract: input.contractViolations }].slice(-MAX_SAMPLES);
    let state = row.state as CircuitState;
    let reason = row.reason;
    if (state === 'closed') {
      // 上一版本同隔离档的 output_contract 比率作基线（§3.8）
      const prevRows = await tx.select().from(circuitBreakers).where(and(eq(circuitBreakers.harness, input.harness), eq(circuitBreakers.isolation, input.isolation)));
      const prev = prevRows.find((r) => r.version !== input.version);
      const prevRuns = samplesOf(prev ?? null).runs;
      const prevRate = prevRuns.length >= 5 ? ratio(prevRuns, (s) => s.contract > 0 || s.cls === 'output_contract') : null;
      const trip = evaluateCircuit(samples.runs, prevRate);
      if (trip) {
        state = 'pending_open';
        reason = trip;
        samples.pendingCanary = true;
      }
    }
    await tx
      .update(circuitBreakers)
      .set({ state, reason, samples: samples as unknown as Record<string, unknown>, updatedAt: nowIso })
      .where(and(eq(circuitBreakers.harness, input.harness), eq(circuitBreakers.version, input.version), eq(circuitBreakers.isolation, input.isolation)));
    return state;
  });
}

export async function circuitState(db: Db, harness: string, version: string, isolation: string): Promise<CircuitState> {
  const row = await getRow(db, harness, version, isolation);
  return (row?.state as CircuitState | undefined) ?? 'closed';
}

/** 取一个未决 canary 的 (harness, version, isolation)，并标记已派发（避免重复入队） */
export async function takePendingCanaries(db: Db): Promise<{ harness: string; version: string; isolation: string; reason: string | null }[]> {
  const rows = await db.select().from(circuitBreakers).where(eq(circuitBreakers.state, 'pending_open'));
  const out: { harness: string; version: string; isolation: string; reason: string | null }[] = [];
  for (const row of rows) {
    const s = samplesOf(row);
    if (!s.pendingCanary) continue;
    s.pendingCanary = false;
    await db
      .update(circuitBreakers)
      .set({ samples: s as unknown as Record<string, unknown>, updatedAt: new Date().toISOString() })
      .where(and(eq(circuitBreakers.harness, row.harness), eq(circuitBreakers.version, row.version), eq(circuitBreakers.isolation, row.isolation)));
    out.push({ harness: row.harness, version: row.version, isolation: row.isolation, reason: row.reason });
  }
  return out;
}

export interface CanaryApplied {
  state: CircuitState;
  /** 是否需要发 Inbox（主笔 harness 的 30 分钟否决窗口） */
  needsInbox: boolean;
  reason: string | null;
  effectiveAt: string | null;
}

/** canary 结果落地：通过 → 关闭并清空样本；失败 → 主笔 harness 30 分钟后生效（Inbox 可否决），否则立即 open */
export async function applyCanaryResult(db: Db, input: { harness: string; version: string; isolation: string; ok: boolean; writerHarness: boolean; reason?: string; now?: Date }): Promise<CanaryApplied> {
  const now = input.now ?? new Date();
  const row = await getRow(db, input.harness, input.version, input.isolation);
  const nowIso = now.toISOString();
  const where = and(eq(circuitBreakers.harness, input.harness), eq(circuitBreakers.version, input.version), eq(circuitBreakers.isolation, input.isolation));
  if (input.ok || !row) {
    await db.insert(circuitBreakers).values({ harness: input.harness, version: input.version, isolation: input.isolation }).onConflictDoNothing();
    await db.update(circuitBreakers).set({ state: 'closed', reason: null, openedAt: null, effectiveAt: null, samples: { runs: [] }, updatedAt: nowIso }).where(where);
    return { state: 'closed', needsInbox: false, reason: null, effectiveAt: null };
  }
  const s = samplesOf(row);
  s.canaryFailedAt = nowIso;
  const reason = input.reason ?? row.reason ?? 'canary 失败';
  if (input.writerHarness) {
    const effectiveAt = new Date(now.getTime() + PENDING_OPEN_MS).toISOString();
    await db.update(circuitBreakers).set({ state: 'pending_open', reason, effectiveAt, samples: s as unknown as Record<string, unknown>, updatedAt: nowIso }).where(where);
    return { state: 'pending_open', needsInbox: true, reason, effectiveAt };
  }
  await db.update(circuitBreakers).set({ state: 'open', reason, openedAt: nowIso, effectiveAt: nowIso, samples: s as unknown as Record<string, unknown>, updatedAt: nowIso }).where(where);
  return { state: 'open', needsInbox: false, reason, effectiveAt: nowIso };
}

/** owner 否决 / 手动关闭 */
export async function closeCircuit(db: Db, harness: string, version: string, isolation: string): Promise<void> {
  await db.insert(circuitBreakers).values({ harness, version, isolation }).onConflictDoNothing();
  await db
    .update(circuitBreakers)
    .set({ state: 'closed', reason: null, openedAt: null, effectiveAt: null, samples: { runs: [] }, updatedAt: new Date().toISOString() })
    .where(and(eq(circuitBreakers.harness, harness), eq(circuitBreakers.version, version), eq(circuitBreakers.isolation, isolation)));
}

/** owner 批准 → 立即打开 */
export async function openCircuit(db: Db, harness: string, version: string, isolation: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(circuitBreakers).values({ harness, version, isolation }).onConflictDoNothing();
  await db.update(circuitBreakers).set({ state: 'open', reason, openedAt: now, effectiveAt: now, updatedAt: now }).where(and(eq(circuitBreakers.harness, harness), eq(circuitBreakers.version, version), eq(circuitBreakers.isolation, isolation)));
}

/** tick：pending_open 到点 → open；open 满 1 小时 → half_open（返回需要跑 canary 的三元组） */
export async function advanceCircuits(db: Db, now: Date): Promise<{ opened: { harness: string; version: string; isolation: string; reason: string | null }[]; halfOpen: { harness: string; version: string; isolation: string }[] }> {
  const nowIso = now.toISOString();
  const rows = await db
    .select()
    .from(circuitBreakers)
    .where(or(and(eq(circuitBreakers.state, 'pending_open'), isNotNull(circuitBreakers.effectiveAt), lte(circuitBreakers.effectiveAt, nowIso)), and(inArray(circuitBreakers.state, ['open']), lte(circuitBreakers.updatedAt, new Date(now.getTime() - HALF_OPEN_AFTER_MS).toISOString()))));
  const opened: { harness: string; version: string; isolation: string; reason: string | null }[] = [];
  const halfOpen: { harness: string; version: string; isolation: string }[] = [];
  for (const row of rows) {
    const where = and(eq(circuitBreakers.harness, row.harness), eq(circuitBreakers.version, row.version), eq(circuitBreakers.isolation, row.isolation), eq(circuitBreakers.state, row.state));
    if (row.state === 'pending_open') {
      await db.update(circuitBreakers).set({ state: 'open', openedAt: nowIso, updatedAt: nowIso }).where(where);
      opened.push({ harness: row.harness, version: row.version, isolation: row.isolation, reason: row.reason });
    } else {
      await db.update(circuitBreakers).set({ state: 'half_open', updatedAt: nowIso }).where(where);
      halfOpen.push({ harness: row.harness, version: row.version, isolation: row.isolation });
    }
  }
  return { opened, halfOpen };
}

