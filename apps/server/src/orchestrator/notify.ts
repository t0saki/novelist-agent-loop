/** 通知（ntfy / webhook），附签名一次性审批链接（15 分钟）。Owner: lane F。 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import type { SseEvent, SystemSettings } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { notifications } from '../db/schema.js';

const APPROVAL_TTL_MS = 15 * 60_000;
const SEND_TIMEOUT_MS = 8_000;

export function hashApprovalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function titleOf(e: SseEvent): string {
  switch (e.type) {
    case 'inbox_new':
      return `[Novelist] ${e.item.title}`;
    case 'circuit_changed':
      return `[Novelist] 熔断 ${e.harness}@${e.version}：${e.state}`;
    case 'quota_wait':
      return `[Novelist] 账号 ${e.accountId} 配额等待`;
    default:
      return `[Novelist] ${e.type}`;
  }
}

function bodyOf(e: SseEvent): string {
  switch (e.type) {
    case 'inbox_new':
      return `${e.item.kind}${e.item.bookSlug ? ` · ${e.item.bookSlug}` : ''}`;
    case 'circuit_changed':
      return e.reason ?? e.state;
    case 'quota_wait':
      return `${e.reason}${e.until ? `（到 ${e.until}）` : ''}`;
    default:
      return JSON.stringify(e);
  }
}

async function post(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** 发送事件通知（按 settings.notifications.events 过滤）；发送失败只记录，不抛（通知不能阻塞编排） */
export async function notify(db: Db, settings: SystemSettings, e: SseEvent): Promise<void> {
  const cfg = settings.notifications;
  if (!cfg.events.includes(e.type)) return;
  const channels: { channel: 'ntfy' | 'webhook'; url: string }[] = [];
  if (cfg.ntfyUrl) channels.push({ channel: 'ntfy', url: cfg.ntfyUrl });
  if (cfg.webhookUrl) channels.push({ channel: 'webhook', url: cfg.webhookUrl });
  if (channels.length === 0) return;

  const isApproval = e.type === 'inbox_new' && e.item.kind === 'approval';
  const title = titleOf(e);
  const text = bodyOf(e);

  for (const { channel, url } of channels) {
    let token: string | null = null;
    let approvalTokenHash: string | null = null;
    let expiresAt: string | null = null;
    if (isApproval && channel === 'webhook') {
      token = randomBytes(24).toString('base64url');
      approvalTokenHash = hashApprovalToken(token);
      expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
    }
    const payload: Record<string, unknown> = { event: e, title, text, ...(token ? { approvalToken: token, approvalExpiresAt: expiresAt } : {}) };
    const rows = await db.insert(notifications).values({ channel, event: e.type, payload: { title, text }, approvalTokenHash, expiresAt }).returning({ id: notifications.id });
    const id = rows[0]?.id;
    try {
      if (channel === 'ntfy') {
        await post(url, { method: 'POST', headers: { Title: encodeURIComponent(title), Tags: 'book', 'Content-Type': 'text/plain' }, body: text });
      } else {
        await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      }
      if (id !== undefined) await db.update(notifications).set({ status: 'sent' }).where(eq(notifications.id, id));
    } catch (err) {
      if (id !== undefined) await db.update(notifications).set({ status: 'failed', error: (err as Error).message }).where(eq(notifications.id, id));
    }
  }
}

/** 校验审批链接 token（一次性、15 分钟）；通过即作废。返回关联的事件 payload */
export async function consumeApprovalToken(db: Db, token: string, now: Date = new Date()): Promise<Record<string, unknown> | null> {
  const hash = hashApprovalToken(token);
  const rows = await db
    .update(notifications)
    .set({ approvalTokenHash: null })
    .where(and(eq(notifications.approvalTokenHash, hash), isNotNull(notifications.expiresAt), gt(notifications.expiresAt, now.toISOString())))
    .returning({ payload: notifications.payload });
  return rows[0]?.payload ?? null;
}
