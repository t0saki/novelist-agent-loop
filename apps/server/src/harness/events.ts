/**
 * 事件解析工具（DESIGN §3.2）。Owner: lane A。
 * 归一化事件 schema 本身在 @novelist/shared/events。
 */
import type { ErrorClass, NEvent, NEventBody, Usage } from '@novelist/shared';
import type { StreamParser } from './types.js';
export type { NEvent, NEventBody } from '@novelist/shared';

/** 只按 LF 切行的缓冲器；保留未完结的尾行（CRLF 的 \r 由调用方 trim） */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts;
  }
  end(): string[] {
    const rest = this.buf;
    this.buf = '';
    return rest ? [rest] : [];
  }
}

/** runner 统一补 seq/ts/runId */
export function stamp(runId: string, startSeq: number, bodies: NEventBody[], now: () => string = () => new Date().toISOString()): NEvent[] {
  return bodies.map((b, i) => ({ ...b, seq: startSeq + i, ts: now(), runId }) as NEvent);
}

/** JSON 行解析：失败返回 null（调用方发 {t:'unknown'}） */
export function tryParseJsonLine(line: string): Record<string, unknown> | null {
  const s = line.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 通用 NDJSON parser 外壳：只按 LF 切行，逐行交给 map；map 抛异常或返回 undefined 时发 unknown；
 * 非 JSON 行发 unknown{rawType:'non_json'}；空行忽略。绝不抛异常。
 */
export function ndjsonParser(map: (obj: Record<string, unknown>) => NEventBody[] | undefined, onEnd?: () => NEventBody[]): StreamParser {
  const split = new LineSplitter();
  const handle = (line: string): NEventBody[] => {
    const s = line.replace(/\r$/, '');
    if (!s.trim()) return [];
    const obj = tryParseJsonLine(s);
    if (!obj) return [{ t: 'unknown', rawType: 'non_json' }];
    try {
      const out = map(obj);
      if (out === undefined) return [{ t: 'unknown', rawType: String(obj.type ?? obj.event ?? '?') }];
      return out;
    } catch {
      return [{ t: 'unknown', rawType: `parse_error:${String(obj.type ?? obj.event ?? '?')}` }];
    }
  };
  return {
    push(chunk: string): NEventBody[] {
      const out: NEventBody[] = [];
      for (const l of split.push(chunk)) out.push(...handle(l));
      return out;
    },
    end(): NEventBody[] {
      const out: NEventBody[] = [];
      for (const l of split.end()) out.push(...handle(l));
      if (onEnd) {
        try {
          out.push(...onEnd());
        } catch {
          /* never throw */
        }
      }
      return out;
    },
  };
}

// ───────── 事件汇总（classify 与 RunResult 用） ─────────
type Ev = NEvent | NEventBody;

/** usage：有 scope=total 时取最后一个 total；否则累加 delta */
export function summarizeUsage(events: Ev[]): Usage {
  let total: Extract<Ev, { t: 'usage' }> | null = null;
  const acc: Usage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costSource: 'unknown' };
  let deltaCost: number | undefined;
  let sawDelta = false;
  for (const e of events) {
    if (e.t !== 'usage') continue;
    if (e.scope === 'total') total = e;
    else {
      sawDelta = true;
      acc.input += e.input;
      acc.cachedInput += e.cachedInput ?? 0;
      acc.cacheWrite += e.cacheWrite ?? 0;
      acc.output += e.output;
      acc.reasoning += e.reasoning ?? 0;
      if (e.costUsd !== undefined) {
        deltaCost = (deltaCost ?? 0) + e.costUsd;
        acc.costSource = e.costSource;
      }
    }
  }
  if (total) {
    return {
      input: total.input,
      cachedInput: total.cachedInput ?? 0,
      cacheWrite: total.cacheWrite ?? 0,
      output: total.output,
      reasoning: total.reasoning ?? 0,
      ...(total.costUsd !== undefined ? { costUsd: total.costUsd } : {}),
      costSource: total.costUsd !== undefined ? total.costSource : 'unknown',
    };
  }
  if (sawDelta && deltaCost !== undefined) acc.costUsd = deltaCost;
  return acc;
}

export function lastOf<T extends Ev['t']>(events: Ev[], t: T): Extract<Ev, { t: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.t === t) return events[i] as Extract<Ev, { t: T }>;
  return undefined;
}

export function firstOf<T extends Ev['t']>(events: Ev[], t: T): Extract<Ev, { t: T }> | undefined {
  for (const e of events) if (e.t === t) return e as Extract<Ev, { t: T }>;
  return undefined;
}

/** 会话 id：result 优先，其次 init */
export function sessionIdOf(events: Ev[]): string | undefined {
  const r = lastOf(events, 'result');
  if (r?.sessionId) return r.sessionId;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t === 'init' && e.sessionId) return e.sessionId;
  }
  return undefined;
}

export function modelOf(events: Ev[]): string | undefined {
  for (const e of events) if (e.t === 'init' && e.model) return e.model;
  return undefined;
}

/** 便捷构造：error 事件 */
export function errorEvent(cls: ErrorClass, message: string, retryable?: boolean): NEventBody {
  return { t: 'error', cls, message: message.slice(0, 2000), retryable: retryable ?? RETRYABLE.has(cls) };
}

export const RETRYABLE: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
  'rate_limit',
  'quota',
  'overloaded',
  'network',
  'timeout_idle',
  'timeout_wall',
  'harness_crash',
  'drift',
  'output_contract',
  'unknown',
]);

/** 取 epoch 秒/毫秒或 ISO 串 → ISO */
export function toIso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v) {
    if (/^\d+$/.test(v)) return toIso(Number(v));
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
export function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
