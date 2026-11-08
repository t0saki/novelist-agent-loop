import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zSystemSettings, type SseEvent } from '@novelist/shared';
import { books, chapters, inbox, notifications, tasks } from '../db/schema.js';
import { ROOT_AGENTS_PLACEHOLDER } from '../book/repo.js';
import { TRAILER } from '../book/trailers.js';
import type { Manifest, TaskHandler, TaskRow } from '../pipeline/types.js';
import { consumeApprovalToken, createInboxItem, createOrchestrator, enqueue, notify, promote } from './index.js';
import { addFixtureBook, createOrchTestEnv, type FakePipelineOptions, type OrchTestEnv } from './testing.js';

const execFileP = promisify(execFile);
let t: OrchTestEnv;
afterEach(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

const manifest: Manifest = { hard: {}, soft: {}, rebaseValidators: [], configHash: '' };

function noopHandler(kind: TaskHandler['kind']): TaskHandler {
  return { kind, role: null, lane: 'side', maxAttempts: 3, manifest: async () => manifest, execute: async () => ({ status: 'done' }) };
}

describe('facade chapter actions', () => {
  it('前沿章 rewrite 每次新实例（带 owner 笔记），不撞上已完成的任务', async () => {
    const seen: string[][] = [];
    const write: TaskHandler = { ...noopHandler('chapter.write'), lane: 'write', manifest: async (_c, s) => ({ ...manifest, configHash: String(s.params?.instance ?? '') }), execute: async (_c, task) => {
      seen.push((task.params.ownerNotes as string[] | undefined) ?? []);
      return { status: 'done' };
    } };
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': write } } });
    const book = await addFixtureBook(t, 'x', { cards: 2 });
    const orch = createOrchestrator(t.deps);
    await orch.chapterAction(book.id, 1, { action: 'rewrite', note: '第一版', confirm: false });
    await orch.runUntilIdle({ maxTicks: 20 });
    await orch.chapterAction(book.id, 1, { action: 'rewrite', note: '再改一下', confirm: false });
    await orch.runUntilIdle({ maxTicks: 20 });
    expect(seen).toEqual([['第一版'], ['再改一下']]);
    expect(await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))).toHaveLength(2);
  });

  it('已验收章节 rewrite 走 chapter.repair，不回退前沿', async () => {
    const repair: TaskHandler = { ...noopHandler('chapter.repair'), execute: async () => ({ status: 'done' }) };
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.repair': repair } } });
    const book = await addFixtureBook(t, 'old', { cards: 6, accepted: 4 });
    const orch = createOrchestrator(t.deps);
    await orch.chapterAction(book.id, 2, { action: 'rewrite', note: '改第二章', confirm: false });
    const rows = (await t.db.select().from(tasks).where(eq(tasks.bookId, book.id))) as TaskRow[];
    expect(rows.map((r) => r.kind)).toEqual(['chapter.repair']);
    expect((await t.db.select().from(books).where(eq(books.id, book.id)))[0]?.acceptedThrough).toBe(4);
  });

  it('已发布章节 rewrite 需要 confirm（freeze_on_publish）', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.repair': noopHandler('chapter.repair') } } });
    const book = await addFixtureBook(t, 'pub', { cards: 6, accepted: 4 });
    await t.db.insert(chapters).values({ bookId: book.id, no: 2, chapterId: 'c00002', state: 'accepted', publishedAt: new Date().toISOString() });
    const orch = createOrchestrator(t.deps);
    await expect(orch.chapterAction(book.id, 2, { action: 'rewrite', confirm: false })).rejects.toThrow(/freeze_on_publish/);
    await expect(orch.chapterAction(book.id, 2, { action: 'rewrite', confirm: true })).resolves.toBeUndefined();
  });

  it('rewind：越过已发布需 confirm；reset 到 tag，前沿与 tag 一并回退', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: {} } });
    const book = await addFixtureBook(t, 'y', { cards: 6, accepted: 4 });
    await t.db.update(books).set({ publishedThrough: 4, auditedThrough: 4 }).where(eq(books.id, book.id));
    await t.db.insert(chapters).values({ bookId: book.id, no: 3, chapterId: 'c00003', state: 'accepted', cjk: 100, publishedAt: new Date().toISOString() });
    const orch = createOrchestrator(t.deps);
    await expect(orch.bookAction(book.id, { action: 'rewind', to: 2, confirm: false })).rejects.toThrow(/confirm/);
    await orch.bookAction(book.id, { action: 'rewind', to: 2, confirm: true });
    const row = (await t.db.select().from(books).where(eq(books.id, book.id)))[0];
    expect(row).toMatchObject({ acceptedThrough: 2, publishedThrough: 2, auditedThrough: 2, cursor: 3 });
    expect(await book.repo.exists('manuscript/c00003.md')).toBe(false);
    expect(await book.repo.exists('manuscript/c00002.md')).toBe(true);
    expect(await book.repo.tags('ch/*')).toEqual(['ch/00001', 'ch/00002']);
    const ch3 = (await t.db.select().from(chapters).where(and(eq(chapters.bookId, book.id), eq(chapters.no, 3))))[0];
    expect(ch3).toMatchObject({ state: 'planned', acceptedCommit: null, publishedAt: null });
  });

  it('rewind 之后章节能重新写作：同 id 的已完成任务不挡路，workflow.seq 保留', async () => {
    const written: string[] = [];
    const write: TaskHandler = { ...noopHandler('chapter.write'), lane: 'write', execute: async (_c, task) => {
      written.push(task.target);
      return { status: 'done' };
    } };
    const next: NonNullable<FakePipelineOptions['next']> = (ctx, s) => (s.active.length > 0 || s.acceptedThrough >= 3 ? [] : [{ kind: 'chapter.write', bookId: ctx.book?.id ?? null, target: `c${String(s.acceptedThrough + 1).padStart(5, '0')}`, lane: 'write' }]);
    t = await createOrchTestEnv({ pipeline: { handlers: { 'chapter.write': write }, next } });
    const book = await addFixtureBook(t, 'rw', { cards: 6, accepted: 4 });
    // 第一轮写第 3 章（manifest 固定，等价于回退后 hard deps 回到旧值 → 同一个 task id）
    await t.db.update(books).set({ acceptedThrough: 2 }).where(eq(books.id, book.id));
    const orch = createOrchestrator(t.deps);
    await orch.runUntilIdle({ maxTicks: 20 });
    expect(written).toEqual(['c00003']);
    await t.db.update(books).set({ acceptedThrough: 4 }).where(eq(books.id, book.id));
    await t.db.insert(chapters).values({ bookId: book.id, no: 3, chapterId: 'c00003', state: 'accepted', workflow: { v: 1, seq: 9 } });
    await orch.bookAction(book.id, { action: 'rewind', to: 2, confirm: false });
    const ch3 = (await t.db.select().from(chapters).where(and(eq(chapters.bookId, book.id), eq(chapters.no, 3))))[0];
    expect(ch3?.workflow).toMatchObject({ seq: 9 });
    await orch.runUntilIdle({ maxTicks: 20 });
    expect(written).toEqual(['c00003', 'c00003']);
  });

  it('unhold 映射到 hold Inbox 的放行（hold 的动作只有 approve/rewrite）', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: {} } });
    const book = await addFixtureBook(t, 'hu', { cards: 2 });
    await t.db.insert(chapters).values({ bookId: book.id, no: 1, chapterId: 'c00001', state: 'held', workflow: {} });
    const item = await createInboxItem(t.db, t.bus, { kind: 'hold', bookId: book.id, title: 'h', body: { target: 'c00001', on: { approve: { task: 'none', chapter: { no: 1, state: 'checking' } } } }, actions: [{ id: 'approve', label: '放行' }, { id: 'rewrite', label: '重写', danger: true }], dedupeKey: 'hold:c00001' });
    const orch = createOrchestrator(t.deps);
    await orch.chapterAction(book.id, 1, { action: 'unhold', confirm: false });
    expect((await t.db.select().from(inbox).where(eq(inbox.id, item.id)))[0]?.state).toBe('resolved');
    expect((await t.db.select().from(chapters).where(and(eq(chapters.bookId, book.id), eq(chapters.no, 1))))[0]?.state).toBe('checking');
  });

  it('AGENTS.md 迁移后，篡改期间被拒收的所有任务都回到队列（不止 Inbox 关联的那个）', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: {} } });
    const b = await addFixtureBook(t, 'agents2', { cards: 2 });
    await fs.writeFile(path.join(b.dir, 'AGENTS.md'), '手工改的根文件\n');
    await execFileP('git', ['-C', b.dir, 'commit', '-qam', 'manual edit', '--no-verify']);
    for (const id of ['r1', 'r2']) {
      await enqueue(t.db, { id, baseCommit: b.head, manifest, spec: { kind: 'plan.arc', bookId: b.id, target: id, lane: 'side' } });
      await t.db.update(tasks).set({ state: 'blocked', waitReason: 'agents_md_edit' }).where(eq(tasks.id, id));
    }
    const orch = createOrchestrator(t.deps);
    const item = await createInboxItem(t.db, t.bus, { kind: 'agents_md_edit', bookId: b.id, title: 'x', body: { on: { migrate: { task: 'ready' } } }, actions: [{ id: 'migrate', label: 'm' }], dedupeKey: 'agents2', relatedTaskId: 'r1' });
    await orch.actInbox(item.id, 'migrate');
    const states = await t.db.select({ id: tasks.id, state: tasks.state }).from(tasks).where(eq(tasks.bookId, b.id));
    expect(states.map((s) => s.state)).toEqual(['ready', 'ready']);
  });

  it('AGENTS.md 一键迁移：根文件恢复占位并带 migration trailer，后续 promote 不再被拒', async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: {} } });
    const b = await addFixtureBook(t, 'agents', { cards: 2 });
    await fs.writeFile(path.join(b.dir, 'AGENTS.md'), '手工改的根文件\n');
    await execFileP('git', ['-C', b.dir, 'commit', '-qam', 'manual edit', '--no-verify']);
    const orch = createOrchestrator(t.deps);
    const item = await createInboxItem(t.db, t.bus, { kind: 'agents_md_edit', bookId: b.id, title: 'x', body: {}, actions: [{ id: 'migrate', label: 'm' }], dedupeKey: 'agents' });
    await orch.actInbox(item.id, 'migrate');
    expect(await b.repo.readFile('AGENTS.md')).toBe(ROOT_AGENTS_PLACEHOLDER);
    expect(await b.repo.readFile('instructions/AGENTS.md')).toContain('手工改的根文件');
    const log = await b.repo.log({ limit: 1, path: 'AGENTS.md' });
    expect(log.items[0]?.trailers[TRAILER.migration]).toBeTruthy();
    await enqueue(t.db, { id: 'p1', baseCommit: b.head, manifest: { hard: {}, soft: {}, rebaseValidators: [], configHash: '' }, spec: { kind: 'plan.arc', bookId: b.id, target: 'a0001', lane: 'side' } });
    const task = (await t.db.select().from(tasks).where(eq(tasks.id, 'p1')))[0] as TaskRow;
    const out = await promote(t.db, b.repo, task, { hard: {}, soft: {}, rebaseValidators: [], configHash: '' }, { bookId: b.id, taskId: 'p1', runId: null, baseCommit: await b.repo.head(), files: [{ path: 'notes/x.md', content: 'x\n' }], resolveTmpIds: false, message: 'x', trailers: {}, tags: [] }, {});
    expect(out.status).toBe('committed');
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
