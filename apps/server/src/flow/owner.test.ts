/** 主人的改写请求（p2-plan §2.5、§6 flow/owner.test）。 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { books } from '../db/schema.js';
import { createOrchTestEnv, type OrchTestEnv } from '../orchestrator/testing.js';
import { dropPublishedRequests, firstWaitingRequest, requestChapterRewrite } from './owner.js';
import { emptyV3Meta, readV3Meta } from './state.js';
import { addV3Book } from './testing-book.js';

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv();
});
afterEach(async () => {
  await t.close();
});

const NOW = new Date('2026-11-10T08:00:00.000Z');
const meta = async (id: string) => readV3Meta((await t.db.select().from(books).where(eq(books.id, id)))[0]?.meta);
const code = async (p: Promise<unknown>): Promise<[number, string]> =>
  p.then(
    () => [200, 'ok'],
    (e: { status?: number; code?: string }) => [e.status ?? 0, e.code ?? ''],
  );

describe('requestChapterRewrite', () => {
  it('published → 409, completed/archived → 409 v3_finished, not written yet → 400, unpublished → waiting request, unlocks the chapter, older waiting request dropped', async () => {
    const b = await addV3Book(t, 'own', { chapters: 6, published: 2, meta: { locked: [4, 5] } });
    expect(await code(requestChapterRewrite(t.db, b.id, 2, '改', NOW))).toEqual([409, 'published']);
    expect(await code(requestChapterRewrite(t.db, b.id, 7, '改', NOW))).toEqual([400, 'bad_request']);
    const r = await requestChapterRewrite(t.db, b.id, 4, '  开头太慢  ', NOW);
    expect(r).toEqual({ ok: true, detail: '已记下：下一批写作时先改写第 4 章（改写前这一章不会发布）。' });
    let m = await meta(b.id);
    expect(m.ownerRequests).toMatchObject([{ kind: 'rewrite', chapter: 4, note: '开头太慢', status: 'waiting', at: NOW.toISOString() }]);
    expect(m.locked).toEqual([5]);
    await requestChapterRewrite(t.db, b.id, 4, '换个说法', NOW);
    m = await meta(b.id);
    expect(m.ownerRequests.map((x) => [x.chapter, x.note, x.status])).toEqual([
      [4, '开头太慢', 'dropped'],
      [4, '换个说法', 'waiting'],
    ]);
    expect(firstWaitingRequest(m)).toBe(4);
    for (const status of ['completed', 'archived']) {
      await t.db.update(books).set({ status }).where(eq(books.id, b.id));
      expect(await code(requestChapterRewrite(t.db, b.id, 5, '改', NOW)), status).toEqual([409, 'v3_finished']);
    }
  });

  it('re-checks publishedThrough under the row lock (a publish that landed just before is seen)', async () => {
    const b = await addV3Book(t, 'own2', { chapters: 6 });
    // 发布在请求之前提交：读到的 row 是锁内重读的，不是调用方手里的旧值
    await t.db.update(books).set({ publishedThrough: 5 }).where(eq(books.id, b.id));
    expect(await code(requestChapterRewrite(t.db, b.id, 5, '改', NOW))).toEqual([409, 'published']);
    expect((await meta(b.id)).ownerRequests).toEqual([]);
    expect(await code(requestChapterRewrite(t.db, b.id, 6, '改', NOW))).toEqual([200, 'ok']);
  });

  it('v2 book → 409 not_v3', async () => {
    await t.db.insert(books).values({ id: 'v2', slug: 'v2', title: 'v2', genre: 'g', status: 'active', acceptedThrough: 3, meta: {} });
    expect(await code(requestChapterRewrite(t.db, 'v2', 2, '改', NOW))).toEqual([409, 'not_v3']);
  });
});

describe('dropPublishedRequests', () => {
  it('marks waiting requests on published chapters dropped; others untouched; no-op when none', async () => {
    const reqs = [
      { id: 'a', kind: 'rewrite' as const, chapter: 2, note: '', at: NOW.toISOString(), status: 'waiting' as const },
      { id: 'b', kind: 'rewrite' as const, chapter: 5, note: '', at: NOW.toISOString(), status: 'waiting' as const },
      { id: 'c', kind: 'rewrite' as const, chapter: 1, note: '', at: NOW.toISOString(), status: 'done' as const },
    ];
    const b = await addV3Book(t, 'drop', { chapters: 6, published: 3, meta: { ownerRequests: reqs } });
    const before = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.updatedAt;
    await dropPublishedRequests(t.db, b.id, 3);
    expect((await meta(b.id)).ownerRequests.map((r) => [r.id, r.status])).toEqual([
      ['a', 'dropped'],
      ['b', 'waiting'],
      ['c', 'done'],
    ]);
    expect(firstWaitingRequest(await meta(b.id))).toBe(5);
    await dropPublishedRequests(t.db, b.id, 3);
    expect((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.updatedAt).toBe(before);
    expect(firstWaitingRequest({ ...emptyV3Meta() })).toBeNull();
  });
});

describe('publish task re-checks waiting rewrite requests under the row lock', () => {
  it('a publish queued through-10 before a request on chapter 8 stops at 7; a manual publish still goes through', async () => {
    const { execEnv } = await import('../orchestrator/executor.js');
    const { publish } = await import('../pipeline/handlers/system.js');
    const env = execEnv(t.deps);
    const b = await addV3Book(t, 'pubreq', { chapters: 10, published: 5 });
    // 入队时还没有请求（publisher 算出 through-10）；执行之前主人对第 8 章提了改写
    await requestChapterRewrite(t.db, b.id, 8, '改', NOW);
    const book = await env.pipe.openBook(env.pdeps, b.id);
    const out = await publish.execute!({ deps: env.pdeps, book }, { id: 'p1', target: 'through-10', params: { through: 10, slot: 'x' } } as never);
    expect(out.summary).toMatchObject({ published: 2, through: 7 });
    expect((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.publishedThrough).toBe(7);
    // 手动发布越过请求（之后由 dropPublishedRequests 作废）
    const manual = await publish.execute!({ deps: env.pdeps, book }, { id: 'p2', target: 'through-10', params: { manual: true } } as never);
    expect(manual.summary).toMatchObject({ through: 10 });
  });

  it('firstWaitingRequest ignores a chapter locked again after the request', () => {
    const r = (chapter: number) => ({ id: `q${chapter}`, kind: 'rewrite' as const, chapter, note: '', at: NOW.toISOString(), status: 'waiting' as const });
    expect(firstWaitingRequest({ ...emptyV3Meta(), ownerRequests: [r(4), r(6)], locked: [4] })).toBe(6);
  });
});
