/** run 事件流 → 时间线：合并连续文本、配对工具调用与结果、累计用量。 */
import type { NEvent } from '@novelist/shared';

type Ev<T extends NEvent['t']> = Extract<NEvent, { t: T }>;

export type TimelineItem =
  | { kind: 'text'; key: string; channel: 'assistant' | 'thinking'; text: string; ts: string }
  | { kind: 'tool'; key: string; call: Ev<'tool_call'>; result: Ev<'tool_result'> | null }
  | { kind: 'event'; key: string; event: Exclude<NEvent, Ev<'text'> | Ev<'tool_call'> | Ev<'tool_result'> | Ev<'heartbeat'>> };

export function mergeEvents(into: Map<number, NEvent>, incoming: NEvent[]): void {
  for (const e of incoming) into.set(e.seq, e);
}

/**
 * 补齐起点：事件 seq 从 1 连续递增，返回最长连续前缀的末尾（没有事件时 -1）。
 * 连流时服务端内存里尚未落库的事件既不在历史里也赶不上订阅，会留下中间的洞，所以不能用 max(seq) 作为 after。
 */
export function backfillAfter(m: Map<number, NEvent>): number {
  let n = 0;
  while (m.has(n + 1)) n += 1;
  return n === 0 ? -1 : n;
}

export const sortedEvents = (m: Map<number, NEvent>) => [...m.values()].sort((a, b) => a.seq - b.seq);

export function buildTimeline(events: NEvent[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  const tools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>();
  for (const e of events) {
    if (e.t === 'heartbeat') continue;
    if (e.t === 'text') {
      const last = out[out.length - 1];
      if (last?.kind === 'text' && last.channel === e.channel) last.text += e.delta;
      else out.push({ kind: 'text', key: `t${e.seq}`, channel: e.channel, text: e.delta, ts: e.ts });
    } else if (e.t === 'tool_call') {
      const item: Extract<TimelineItem, { kind: 'tool' }> = { kind: 'tool', key: `c${e.seq}`, call: e, result: null };
      tools.set(e.id, item);
      out.push(item);
    } else if (e.t === 'tool_result') {
      const item = tools.get(e.id);
      if (item) item.result = e;
    } else {
      out.push({ kind: 'event', key: `e${e.seq}`, event: e });
    }
  }
  return out;
}

export interface UsageTotals {
  input: number;
  cached: number;
  output: number;
  costUsd: number | null;
}

/** delta 累加；total 表示截至此刻的总量，直接覆盖 */
export function totalUsage(events: NEvent[]): UsageTotals {
  const u: UsageTotals = { input: 0, cached: 0, output: 0, costUsd: null };
  for (const e of events) {
    if (e.t !== 'usage') continue;
    if (e.scope === 'total') {
      u.input = e.input;
      u.cached = e.cachedInput ?? 0;
      u.output = e.output;
      if (e.costUsd !== undefined) u.costUsd = e.costUsd;
    } else {
      u.input += e.input;
      u.cached += e.cachedInput ?? 0;
      u.output += e.output;
      if (e.costUsd !== undefined) u.costUsd = (u.costUsd ?? 0) + e.costUsd;
    }
  }
  return u;
}

export function fileChanges(events: NEvent[]): Ev<'file_change'>[] {
  return events.filter((e): e is Ev<'file_change'> => e.t === 'file_change');
}

export function describeEvent(e: Extract<TimelineItem, { kind: 'event' }>['event']): { label: string; detail: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'info' } {
  switch (e.t) {
    case 'init':
      return { label: '启动', detail: [e.model, e.version, e.authSource].filter(Boolean).join(' · '), tone: 'info' };
    case 'file_change':
      return { label: { add: '新建文件', update: '修改文件', delete: '删除文件' }[e.op], detail: e.path, tone: e.ok ? 'ok' : 'danger' };
    case 'usage':
      return { label: '用量', detail: `入 ${e.input} / 出 ${e.output}${e.cachedInput ? ` / 缓存 ${e.cachedInput}` : ''}${e.costUsd !== undefined ? ` / $${e.costUsd.toFixed(4)}` : ''}`, tone: 'neutral' };
    case 'rate_limit':
      return { label: `配额 ${e.window}`, detail: `${e.status}${e.utilization !== undefined ? ` · ${Math.round((e.utilization > 1 ? e.utilization / 100 : e.utilization) * 100)}%` : ''}${e.resetsAt ? ` · 重置 ${e.resetsAt}` : ''}`, tone: e.status === 'allowed' ? 'neutral' : e.status === 'warning' ? 'warn' : 'danger' };
    case 'retry':
      return { label: '重试', detail: `第 ${e.attempt} 次（${e.cls}）`, tone: 'warn' };
    case 'compaction':
      return { label: '上下文压缩', detail: '', tone: 'info' };
    case 'denial':
      return { label: '越权被拒', detail: [e.tool, e.path, e.detail].filter(Boolean).join(' · '), tone: 'warn' };
    case 'subagent':
      return { label: e.phase === 'start' ? '子代理启动' : '子代理结束', detail: e.role ?? e.id, tone: 'info' };
    case 'error':
      return { label: `错误 ${e.cls}`, detail: e.message, tone: 'danger' };
    case 'result':
      return { label: '结束', detail: [e.status, e.stopReason, e.turns !== undefined ? `${e.turns} 轮` : null].filter(Boolean).join(' · '), tone: e.status === 'success' ? 'ok' : 'danger' };
    case 'unknown':
      return { label: '未识别事件', detail: e.rawType, tone: 'neutral' };
  }
}
