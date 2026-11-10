/**
 * 书页状态栏的“立即写下一批”（DESIGN §9；POST /api/admin/books/:slug/actions { action: 'write_now' }）：
 * 存稿满了（decideNext 的 buffer_full、任务单的存稿检查、claimNext 的 max_buffer 暂停）也恰好写一批，这一批入库后又按存稿规则停下。
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { V3BookView } from '@novelist/shared';
import { books, tasks } from '../db/schema.js';
import { readV3Meta } from '../flow/state.js';
import { createLegacyBook } from '../book/testing-legacy.js';
import { createBook } from '../services/books.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';

let t: TestApp;
let cookie = '';

const admin = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
const writeTasks = async (bookId: string) => (await t.deps.db.select().from(tasks).where(eq(tasks.bookId, bookId))).filter((x) => x.kind === 'book.write');

async function tick(): Promise<void> {
  for (const task of await t.deps.db.select().from(tasks)) {
    if (task.state === 'waiting') await t.deps.db.update(tasks).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, task.id));
  }
  await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
}

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('write_now', () => {
  it('buffer full: exactly one book.write is enqueued and claimed (also under a max_buffer pause), then the buffer stops the book again', async () => {
    await createBook(t.deps, { title: '存稿满', slug: 'wn', genre: 'xianxia', flow: 'v3', v3: { length: 'long', batch: 2, min_chapter_cjk: 500 }, start: false });
    const s = ((await admin('GET', '/api/admin/books/wn/v3')).json() as V3BookView).settings;
    // 手动发布（不发），存稿上限 4 = 两批
    expect((await admin('PUT', '/api/admin/books/wn/v3/settings', { ...s, publish: { ...s.publish, mode: 'manual', max_buffer: 4 } })).statusCode).toBe(200);
    const id = (await rowOf('wn')).id;
    await t.deps.orchestrator.startBook(id);
    for (let i = 0; i < 4 && (await rowOf('wn')).acceptedThrough < 4; i += 1) await tick();
    expect((await rowOf('wn')).acceptedThrough).toBe(4);
    await tick();
    // 存稿满：没有排着的写作任务
    expect((await writeTasks(id)).filter((x) => !['done', 'stale', 'cancelled'].includes(x.state))).toEqual([]);
    expect((await rowOf('wn')).acceptedThrough).toBe(4);
    // 发布那边也因存稿满暂停了生产（max_buffer）：claimNext 也要放行
    await t.deps.db.update(books).set({ pausedReason: 'max_buffer' }).where(eq(books.id, id));

    const res = await admin('POST', '/api/admin/books/wn/actions', { action: 'write_now' });
    expect(res.statusCode, res.body).toBe(200);
    expect(readV3Meta((await rowOf('wn')).meta).writeNow).toBe(true);
    const live = (await writeTasks(id)).filter((x) => !['done', 'stale', 'cancelled'].includes(x.state));
    expect(live.map((x) => (x.params as { from?: number }).from)).toEqual([5]);
    // 再点一次：不重复加
    expect((await admin('POST', '/api/admin/books/wn/actions', { action: 'write_now' })).statusCode).toBe(200);
    expect((await writeTasks(id)).filter((x) => !['done', 'stale', 'cancelled'].includes(x.state))).toHaveLength(1);

    await tick();
    let row = await rowOf('wn');
    expect(row.acceptedThrough).toBe(6);
    expect(readV3Meta(row.meta).writeNow).toBeUndefined();
    // 之后照存稿规则停下：不再写
    await t.deps.db.update(books).set({ pausedReason: null }).where(eq(books.id, id));
    await tick();
    await tick();
    row = await rowOf('wn');
    expect(row.acceptedThrough).toBe(6);
    expect((await writeTasks(id)).filter((x) => !['done', 'stale', 'cancelled'].includes(x.state))).toEqual([]);
  }, 180_000);

  it('a paused book is resumed; a completed book → 409; a legacy book → 409 legacy_book', async () => {
    await createBook(t.deps, { title: '暂停', slug: 'wn-paused', genre: 'xianxia', flow: 'v3', v3: { length: 'long', batch: 2, min_chapter_cjk: 500 }, start: false });
    const id = (await rowOf('wn-paused')).id;
    await t.deps.orchestrator.startBook(id);
    await tick();
    expect((await rowOf('wn-paused')).acceptedThrough).toBe(2);
    expect((await admin('POST', '/api/admin/books/wn-paused/actions', { action: 'pause' })).statusCode).toBe(200);
    for (const x of await t.deps.db.select().from(tasks).where(eq(tasks.bookId, id))) if (!['done', 'stale', 'cancelled'].includes(x.state)) await t.deps.orchestrator.cancelTask(x.id);
    expect((await admin('POST', '/api/admin/books/wn-paused/actions', { action: 'write_now' })).statusCode).toBe(200);
    expect(await rowOf('wn-paused')).toMatchObject({ status: 'active', pausedReason: null });

    await t.deps.db.update(books).set({ status: 'completed' }).where(eq(books.id, id));
    const done = await admin('POST', '/api/admin/books/wn-paused/actions', { action: 'write_now' });
    expect(done.statusCode).toBe(409);

    await createLegacyBook(t.deps.db, t.deps.paths, 'wn-old');
    const old = await admin('POST', '/api/admin/books/wn-old/actions', { action: 'write_now' });
    expect(old.statusCode).toBe(409);
    expect(old.json().code).toBe('legacy_book');
  }, 120_000);
});
