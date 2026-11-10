import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../db/client.js';
import { books, chapters } from '../db/schema.js';
import { createTestDb } from '../db/testing.js';
import { v3Cap, v3PublishCap } from './publish.js';
import { bumpBookEmpty, clearPending, emptyV3Meta, lockChapter, patchPending, readPending, readV3Meta, setPending } from './state.js';
import type { V3Pending } from './types.js';

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

const pending = (runId: string): V3Pending => ({
  taskId: 't1',
  runId,
  attempt: 1,
  stage: 'run',
  runDir: '/r',
  inDir: '/r/in',
  snapshotDir: '/r/book',
  baseCommit: 'abc',
  manifestFile: null,
  trailerKey: `t1.g0@${runId}`,
  route: { profile: 'p', account: null, harness: 'fake', model: null, isolation: 'none', stackHash: 'h' },
  failures: 0,
  createdAt: '2026-11-10T00:00:00.000Z',
});

async function addBook(id: string, meta: Record<string, unknown> = {}): Promise<void> {
  await h.db.insert(books).values({ id, slug: id, title: id, genre: 'g', meta });
}
const metaOf = async (id: string) => (await h.db.select({ meta: books.meta }).from(books).where(eq(books.id, id)))[0]?.meta;

describe('meta.v3 atomic helpers', () => {
  it('setPending works without an existing meta.v3 and keeps other meta keys', async () => {
    await addBook('b1', { blurb: '简介' });
    await setPending(h.db, 'b1', pending('r1'));
    expect(await readPending(h.db, 'b1')).toEqual(pending('r1'));
    expect((await metaOf('b1'))?.blurb).toBe('简介');
  });
  it('patchPending only touches the matching run, failures via jsonb arithmetic', async () => {
    expect(await patchPending(h.db, 'b1', 'other', { stage: 'harvested' })).toBeNull();
    const p = await patchPending(h.db, 'b1', 'r1', { stage: 'harvested', manifestFile: '/m.json', lastError: 'boom' }, { incFailures: true });
    expect(p).toMatchObject({ stage: 'harvested', manifestFile: '/m.json', failures: 1, lastError: 'boom', runId: 'r1' });
    const q = await patchPending(h.db, 'b1', 'r1', {}, { incFailures: true });
    expect(q?.failures).toBe(2);
  });
  it('clearPending only for its own runId', async () => {
    await clearPending(h.db, 'b1', 'other');
    expect(await readPending(h.db, 'b1')).not.toBeNull();
    await clearPending(h.db, 'b1', 'r1');
    expect(await readPending(h.db, 'b1')).toBeNull();
  });
  it('bumpBookEmpty inc/reset and lockChapter append once', async () => {
    await addBook('b2', { v3: { ...emptyV3Meta(), hints: [{ kind: 'short', text: 'x', at: 'now' }] } });
    expect(await bumpBookEmpty(h.db, 'b2', 'inc')).toBe(1);
    expect(await bumpBookEmpty(h.db, 'b2', 'inc')).toBe(2);
    expect(await bumpBookEmpty(h.db, 'b2', 'reset')).toBe(0);
    await lockChapter(h.db, 'b2', 3);
    await lockChapter(h.db, 'b2', 3);
    await lockChapter(h.db, 'b2', 1);
    const m = readV3Meta(await metaOf('b2'));
    expect(m.locked).toEqual([3, 1]);
    expect(m.hints).toHaveLength(1);
    // 旧书（没有 meta.v3，P3 D1）：主人的操作不会把 meta.v3 建出来（接手到一半的书改正文也一样）
    await addBook('b3', { takeoverIntent: { from: 8 } });
    await lockChapter(h.db, 'b3', 7);
    expect(await metaOf('b3')).toEqual({ takeoverIntent: { from: 8 } });
    await addBook('b4', { v3: emptyV3Meta() });
    await lockChapter(h.db, 'b4', 7);
    expect(readV3Meta(await metaOf('b4')).locked).toEqual([7]);
  });
});

describe('v3 publish cap', () => {
  const now = new Date('2026-11-10T12:00:00.000Z');
  it('earlier batches publishable once a later batch landed; last batch after N hours; completed → all', () => {
    const meta = { ...emptyV3Meta(), lastBatchFrom: 6 };
    expect(v3Cap({ accepted: 10, completed: false, meta, agedThrough: 0, now })).toBe(5);
    expect(v3Cap({ accepted: 10, completed: false, meta, agedThrough: 10, now })).toBe(10);
    expect(v3Cap({ accepted: 10, completed: true, meta, agedThrough: 0, now })).toBe(10);
    expect(v3Cap({ accepted: 5, completed: false, meta: emptyV3Meta(), agedThrough: 0, now })).toBe(0);
  });
  it('early_end hold keeps chapter k unpublished for 72h', () => {
    const fresh = { ...emptyV3Meta(), lastBatchFrom: 6, hints: [{ kind: 'early_end' as const, chapter: 8, rewrite: 8, text: 'x', at: '2026-11-10T00:00:00.000Z' }] };
    expect(v3Cap({ accepted: 10, completed: false, meta: fresh, agedThrough: 10, now })).toBe(7);
    const old = { ...fresh, hints: [{ ...fresh.hints[0]!, at: '2026-11-06T00:00:00.000Z' }] };
    expect(v3Cap({ accepted: 10, completed: false, meta: old, agedThrough: 10, now })).toBe(10);
  });
  it('v3PublishCap reads books + chapters', async () => {
    await h.db.insert(books).values({ id: 'p1', slug: 'p1', title: 'p1', genre: 'g', status: 'active', acceptedThrough: 7, meta: { v3: { ...emptyV3Meta(), lastBatchFrom: 6 } } });
    const row = (no: number, acceptedAt: string) => ({ bookId: 'p1', no, chapterId: `c0000${no}`, state: 'accepted', acceptedAt });
    await h.db.insert(chapters).values([1, 2, 3, 4, 5].map((n) => row(n, '2026-11-08T00:00:00.000Z')).concat([row(6, '2026-11-09T06:00:00.000Z'), row(7, '2026-11-10T11:00:00.000Z')]));
    expect(await v3PublishCap(h.db, 'p1', now, 24)).toBe(6);
    expect(await v3PublishCap(h.db, 'p1', now, 48)).toBe(5);
    await h.db.update(books).set({ status: 'completed' }).where(eq(books.id, 'p1'));
    expect(await v3PublishCap(h.db, 'p1', now, 24)).toBe(7);
  });
});
