import type { BookSummary, QuotaStatus } from '@novelist/shared';
import { toRatio } from './format';

export interface Alert {
  id: string;
  tone: 'danger' | 'warn' | 'info';
  text: string;
  to?: string;
}

/** 首页的提示：账号休眠、额度窗口快满、在写的书存稿将尽（待办另列，不在这里） */
export function buildAlerts(input: { books?: BookSummary[]; quota?: QuotaStatus[]; lowBufferDays?: number }): Alert[] {
  const out: Alert[] = [];
  const low = input.lowBufferDays ?? 3;
  for (const b of input.books ?? []) {
    if (b.legacy) continue;
    if (b.status === 'active' && b.frontiers.bufferDays !== null && b.frontiers.bufferDays < low) out.push({ id: `b-${b.slug}`, tone: 'warn', text: `《${b.title}》存稿仅够 ${b.frontiers.bufferDays.toFixed(1)} 天`, to: `/admin/books/${b.slug}/overview` });
  }
  for (const q of input.quota ?? []) {
    if (q.sleepUntil) out.push({ id: `s-${q.accountId}`, tone: 'warn', text: `账号 ${q.accountId} 休眠中：${q.sleepReason ?? '额度耗尽'}`, to: '/admin/models' });
    for (const w of q.windows) {
      const r = toRatio(w.utilization);
      if (r !== null && r >= 0.9) out.push({ id: `q-${q.accountId}-${w.window}`, tone: 'warn', text: `账号 ${q.accountId} 的 ${w.window} 窗口已用 ${Math.round(r * 100)}%`, to: '/admin/models' });
    }
  }
  const rank = { danger: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}
