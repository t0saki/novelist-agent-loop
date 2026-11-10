import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zSystemSettings, type SseEvent } from '@novelist/shared';
import { books, inbox, notifications, tasks } from '../db/schema.js';
import { createLegacyBook } from '../book/testing-legacy.js';
import { addV3Book } from '../flow/testing-book.js';
import { HttpProblem } from '../api/problem.js';
import type { Manifest, TaskRow } from '../runtime/types.js';
import { consumeApprovalToken, createOrchestrator, enqueue, notify } from './index.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';

let t: OrchTestEnv;
afterEach(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

const manifest: Manifest = { hard: {}, soft: {}, configHash: '' };

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof HttpProblem ? `${e.status} ${e.code}` : `error: ${(e as Error).message}`;
  }
};

describe('facade: legacy books (P3 D13)', () => {
  it('start / resume / pause / rewind / chapter actions / publish now on a legacy book → 409 legacy_book, nothing enqueued, status untouched', async () => {
    t = await createOrchTestEnv();
    const legacy = await createLegacyBook(t.db, t.paths, 'old', { chapters: 4, published: 2 });
    const orch = createOrchestrator(t.deps);
    expect(await code(orch.startBook(legacy.id))).toBe('409 legacy_book');
    for (const action of ['start', 'resume', 'pause'] as const) expect(await code(orch.bookAction(legacy.id, { action })), action).toBe('409 legacy_book');
    expect(await code(orch.bookAction(legacy.id, { action: 'rewind', to: 1 }))).toBe('409 legacy_book');
    for (const action of ['rewrite', 'rewrite_from', 'publish_now'] as const) expect(await code(orch.chapterAction(legacy.id, 3, { action, note: 'x' })), action).toBe('409 legacy_book');
    expect(await code(orch.publishNow(legacy.id, 4))).toBe('409 legacy_book');
    expect(await t.db.select().from(tasks)).toEqual([]);
    expect((await t.db.select().from(books).where(eq(books.id, legacy.id)))[0]).toMatchObject({ status: 'paused', pausedReason: 'import', publishedThrough: 2 });
  });

  it('a legacy book whose book.yaml does not parse still answers 409 (never opens the book)', async () => {
    t = await createOrchTestEnv();
    const legacy = await createLegacyBook(t.db, t.paths, 'broken', { bookYamlExtra: 'slug: [unclosed\n' });
    const orch = createOrchestrator(t.deps);
    expect(await code(orch.bookAction(legacy.id, { action: 'start' }))).toBe('409 legacy_book');
  });

  it('v3 book: reindex goes through the API (the facade answers 400); rewind without a target → 400', async () => {
    t = await createOrchTestEnv();
    const b = await addV3Book(t, 'v3a', { chapters: 2 });
    const orch = createOrchestrator(t.deps);
    expect(await code(orch.bookAction(b.id, { action: 'reindex' }))).toBe('400 bad_request');
    expect(await code(orch.bookAction(b.id, { action: 'rewind' }))).toBe('400 bad_request');
    expect(await code(orch.bookAction(b.id, { action: 'pause' }))).toBe('ok');
    expect((await t.db.select().from(books).where(eq(books.id, b.id)))[0]).toMatchObject({ status: 'paused', pausedReason: 'owner' });
  });

  it('retryTask refuses a task of a removed kind (409 unknown_kind) and a task of a legacy book (409 legacy_book)', async () => {
    t = await createOrchTestEnv();
    const legacy = await createLegacyBook(t.db, t.paths, 'old2');
    await t.db.insert(tasks).values({ id: 'old-kind', bookId: legacy.id, kind: 'chapter.extract', target: 'c00001', lane: 'side', state: 'failed' });
    await enqueue(t.db, { id: 'legacy-pub', baseCommit: null, manifest, spec: { kind: 'publish', bookId: legacy.id, target: 'through-3', lane: 'system' } });
    await t.db.update(tasks).set({ state: 'failed' }).where(eq(tasks.id, 'legacy-pub'));
    const orch = createOrchestrator(t.deps);
    expect(await code(orch.retryTask('old-kind'))).toBe('409 unknown_kind');
    expect(await code(orch.retryTask('legacy-pub'))).toBe('409 legacy_book');
    const rows = (await t.db.select().from(tasks)) as TaskRow[];
    expect(rows.map((r) => r.state).sort()).toEqual(['failed', 'failed']);
  });
});

describe('notify', () => {
  const settings = (o: Partial<ReturnType<typeof zSystemSettings.parse>['notifications']>) => zSystemSettings.parse({ notifications: { events: ['inbox_new', 'quota_wait'], ...o } });

  it('posts ntfy and webhook; failures are recorded not thrown; approval token is one-time', async () => {
    t = await createOrchTestEnv();
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string }) => {
        calls.push({ url, body: init.body ?? '' });
        return url.includes('bad') ? new Response('x', { status: 500 }) : new Response('ok');
      }),
    );
    const event: SseEvent = { type: 'inbox_new', item: { id: 'i', bookSlug: 'b', kind: 'approval', title: '批准', body: {}, state: 'open', actions: [], createdAt: '', resolvedAt: null, timeoutAt: null } };
    await notify(t.db, settings({ ntfyUrl: 'https://ntfy.example/t', webhookUrl: 'https://hook.example/bad' }), event);
    expect(calls).toHaveLength(2);
    const rows = await t.db.select().from(notifications);
    expect(rows.find((r) => r.channel === 'ntfy')?.status).toBe('sent');
    expect(rows.find((r) => r.channel === 'webhook')?.status).toBe('failed');
    const hookBody = JSON.parse(calls.find((c) => c.url.includes('hook'))?.body ?? '{}') as { approvalToken?: string };
    expect(hookBody.approvalToken).toBeTruthy();
    expect(await consumeApprovalToken(t.db, hookBody.approvalToken as string)).toBeTruthy();
    expect(await consumeApprovalToken(t.db, hookBody.approvalToken as string)).toBeNull();
  });

  it('ignores event types not in the configured list', async () => {
    t = await createOrchTestEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await notify(t.db, settings({ ntfyUrl: 'https://ntfy.example/t' }), { type: 'book_changed', book: 'b' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await t.db.select().from(inbox)).toEqual([]);
  });
});
