import type { BookSummary, HarnessStatus, InboxItem, QuotaStatus } from '@novelist/shared';
import { toRatio } from './format';

export interface Alert {
  id: string;
  tone: 'danger' | 'warn' | 'info';
  text: string;
  to?: string;
}

export function buildAlerts(input: { books?: BookSummary[]; harness?: HarnessStatus[]; quota?: QuotaStatus[]; inbox?: InboxItem[]; lowBufferDays?: number }): Alert[] {
  const out: Alert[] = [];
  const low = input.lowBufferDays ?? 3;
  for (const h of input.harness ?? []) {
    if (h.circuit.state === 'open') out.push({ id: `c-${h.id}`, tone: 'danger', text: `${h.displayName} 已熔断：${h.circuit.reason ?? '未知原因'}`, to: '/admin/harness' });
    else if (h.circuit.state === 'pending_open') out.push({ id: `c-${h.id}`, tone: 'warn', text: `${h.displayName} 即将熔断：${h.circuit.reason ?? ''}`, to: '/admin/harness' });
  }
  for (const b of input.books ?? []) {
    if (b.status === 'active' && b.frontiers.bufferDays !== null && b.frontiers.bufferDays < low) out.push({ id: `b-${b.slug}`, tone: 'warn', text: `《${b.title}》存稿仅够 ${b.frontiers.bufferDays.toFixed(1)} 天`, to: `/admin/books/${b.slug}/overview` });
    if (b.waiting) out.push({ id: `w-${b.slug}`, tone: 'info', text: `《${b.title}》等待中：${b.waiting.reason}`, to: `/admin/books/${b.slug}/overview` });
  }
  for (const q of input.quota ?? []) {
    if (q.sleepUntil) out.push({ id: `s-${q.accountId}`, tone: 'warn', text: `账号 ${q.accountId} 休眠中：${q.sleepReason ?? '额度耗尽'}`, to: '/admin/quota' });
    for (const w of q.windows) {
      const r = toRatio(w.utilization);
      if (r !== null && r >= 0.9) out.push({ id: `q-${q.accountId}-${w.window}`, tone: 'warn', text: `账号 ${q.accountId} 的 ${w.window} 窗口已用 ${Math.round(r * 100)}%`, to: '/admin/quota' });
    }
  }
  const openInbox = (input.inbox ?? []).filter((i) => i.state === 'open');
  const urgent = openInbox.filter((i) => ['block', 'auth', 'circuit'].includes(i.kind));
  if (urgent.length > 0) out.push({ id: 'inbox-urgent', tone: 'danger', text: `${urgent.length} 项 Inbox 需要立即处理`, to: '/admin/inbox' });
  else if (openInbox.length > 0) out.push({ id: 'inbox', tone: 'info', text: `${openInbox.length} 项 Inbox 待处理`, to: '/admin/inbox' });
  const rank = { danger: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}
