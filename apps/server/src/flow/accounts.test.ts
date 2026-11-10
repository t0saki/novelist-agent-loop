import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../db/client.js';
import { accounts, accountsState, settings } from '../db/schema.js';
import { createTestDb } from '../db/testing.js';
import { sleepAccount } from '../orchestrator/quota.js';
import { bumpZeroDiff, readZeroDiff, resetZeroDiff, resumeZeroDiffAccount, zeroDiffAccountKey, zeroDiffInbox } from './accounts.js';

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});
const now = new Date('2026-11-10T00:00:00.000Z');

describe('zero-diff accounting', () => {
  it('two concurrent bumps on different accounts both persist', async () => {
    const [a, b] = await Promise.all([bumpZeroDiff(h.db, 'acc-a', true, now), bumpZeroDiff(h.db, 'acc-b', true, now)]);
    expect([a, b]).toEqual([1, 1]);
    expect(await readZeroDiff(h.db, 'acc-a')).toBe(1);
    expect(await readZeroDiff(h.db, 'acc-b')).toBe(1);
    const row = (await h.db.select().from(settings).where(eq(settings.key, 'flow.v3.zeroDiff:acc-a')))[0];
    expect(row?.value).toEqual({ streak: 1, lastAt: now.toISOString() });
  });
  it('two concurrent bumps on the same account → streak 2', async () => {
    const r = await Promise.all([bumpZeroDiff(h.db, 'acc-c', true, now), bumpZeroDiff(h.db, 'acc-c', true, now)]);
    expect(r.sort()).toEqual([1, 2]);
    expect(await readZeroDiff(h.db, 'acc-c')).toBe(2);
  });
  it('non-zero-diff resets', async () => {
    await bumpZeroDiff(h.db, 'acc-d', true, now);
    await bumpZeroDiff(h.db, 'acc-d', true, now);
    expect(await bumpZeroDiff(h.db, 'acc-d', false, now)).toBe(0);
    expect(await readZeroDiff(h.db, 'acc-d')).toBe(0);
    expect(await bumpZeroDiff(h.db, 'acc-new', false, now)).toBe(0);
    await bumpZeroDiff(h.db, 'acc-d', true, now);
    await resetZeroDiff(h.db, 'acc-d');
    expect(await readZeroDiff(h.db, 'acc-d')).toBe(0);
    expect(await readZeroDiff(h.db, 'never-seen')).toBe(0);
  });
  it('resume inbox action clears sleep and streak', async () => {
    await h.db.insert(accounts).values({ id: 'acc-r', harness: 'fake', label: 'r', authMode: 'none', enabled: true, body: {} });
    await bumpZeroDiff(h.db, 'acc-r', true, now);
    await bumpZeroDiff(h.db, 'acc-r', true, now);
    await sleepAccount(h.db, 'acc-r', new Date(now.getTime() + 7 * 24 * 3600_000).toISOString(), 'v3 连续空跑');
    await resumeZeroDiffAccount(h.db, 'acc-r');
    const st = (await h.db.select().from(accountsState).where(eq(accountsState.accountId, 'acc-r')))[0];
    expect(st?.sleepUntil).toBeNull();
    expect(await readZeroDiff(h.db, 'acc-r')).toBe(0);
  });
  it('account key and inbox item', () => {
    expect(zeroDiffAccountKey('acc1', 'p1')).toBe('acc1');
    expect(zeroDiffAccountKey(null, 'p1')).toBe('profile:p1');
    const tail = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const item = zeroDiffInbox('acc1', 2, tail);
    expect(item).toMatchObject({ kind: 'notice', bookId: null, title: '账号 acc1 连续 2 次空跑，已暂停', dedupeKey: 'zero_diff:acc1', actions: [{ id: 'resume', label: '恢复账号' }, { id: 'dismiss', label: '知道了' }] });
    expect(String(item.body.stderrTail).split('\n')).toHaveLength(20);
    expect(String(item.body.stderrTail).endsWith('line 29')).toBe(true);
  });
});
