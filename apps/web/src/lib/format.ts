const dtf = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dtf.format(d);
}

export function fmtRel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  if (abs < 60_000) return diff >= 0 ? '刚刚' : '即将';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} 小时${suffix}`;
  if (abs < 30 * 86_400_000) return `${Math.round(abs / 86_400_000)} 天${suffix}`;
  return fmtTime(iso);
}

export function fmtCjk(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1)} 万字`;
  return `${n.toLocaleString('zh-CN')} 字`;
}

export function fmtNum(n: number): string {
  if (Math.abs(n) >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`;
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
  return n.toLocaleString('zh-CN');
}

export const fmtUsd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(n >= 100 ? 0 : 2)}`);

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
}

export function runDuration(startedAt: string | null, endedAt: string | null, now: number = Date.now()): string {
  if (!startedAt) return '—';
  return fmtDur((endedAt ? new Date(endedAt).getTime() : now) - new Date(startedAt).getTime());
}

/** 0–1 的占用率；服务端个别窗口给的是 0–100，统一压回 0–1 */
export function toRatio(u: number | null | undefined): number | null {
  if (u === null || u === undefined) return null;
  return u > 1 ? u / 100 : u;
}

export const fmtPct = (r: number | null | undefined) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`);
export const chapterLabel = (no: number) => `第 ${no} 章`;
