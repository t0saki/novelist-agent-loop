/**
 * P3 开机迁移（p3-plan §5、§7 WP-1）：直接调用 runBootMigrations（PGlite + 临时目录），不经过 createTestApp。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLegacyBook } from '../book/testing-legacy.js';
import { parse as parseYaml } from 'yaml';
import { books, chapters, inbox, profiles, routingPresets, runs, settings, tasks } from '../db/schema.js';
import { addV3Book } from '../flow/testing-book.js';
import { logFiles } from '../harness/runner.js';
import { claimNext } from '../orchestrator/queue.js';
import { loadSystemSettings, resolveSlot, saveSlots, writerProfileOf } from '../orchestrator/routing.js';
import { openRepo } from '../book/repo.js';
import { emptyV3Meta } from '../flow/state.js';
import { createOrchTestEnv, type OrchTestEnv } from '../orchestrator/testing.js';
import { createTestApp, TEST_ADMIN_PASSWORD } from '../testing.js';
import { MIGRATION_KEY, WRITER_OVERRIDE_TRAILER, createWriterOverrideRetry, loadMigrationState, runBootMigrations, runPostRecoveryMigrations, v3InboxPatterns } from './migrate-p3.js';

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv();
});
afterEach(async () => {
  await t.close();
});

const migrate = () => runBootMigrations({ db: t.db, paths: t.paths, log: t.deps.log, config: t.config });
const taskRow = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0];
const outboxOf = (row: { params: Record<string, unknown> } | undefined) => (row?.params._orch as { outbox?: unknown } | undefined)?.outbox;
const openKeys = async () => (await t.db.select({ k: inbox.dedupeKey, kind: inbox.kind }).from(inbox).where(eq(inbox.state, 'open'))).map((r) => r.k ?? `<${r.kind}>`).sort();
const chapterRow = async (bookId: string, no: number) => (await t.db.select().from(chapters).where(and(eq(chapters.bookId, bookId), eq(chapters.no, no))))[0];

let seq = 0;
async function addInbox(o: { kind: string; key: string | null; bookId?: string | null }): Promise<string> {
  const id = `ib-${++seq}`;
  await t.db.insert(inbox).values({ id, kind: o.kind, title: o.kind, bookId: o.bookId ?? null, dedupeKey: o.key, state: 'open' });
  return id;
}

describe('M2 cancelLegacyTasks', () => {
  it('cancels live tasks of legacy books and of removed kinds, clears stale outbox flags, writes kill files for their running runs; v3 tasks untouched; idempotent', async () => {
    const legacy = await createLegacyBook(t.db, t.paths, 'old', { status: 'active', pausedReason: null });
    const v3 = await addV3Book(t, 'new', { chapters: 1 });
    const outbox = { _orch: { outbox: true } };
    await t.db.insert(tasks).values([
      { id: 'l-ready', bookId: legacy.id, kind: 'chapter.write', target: 'c00004', lane: 'write', state: 'ready' },
      { id: 'l-waiting', bookId: legacy.id, kind: 'publish', target: 'through-3', lane: 'system', state: 'waiting', params: outbox },
      { id: 'l-blocked', bookId: legacy.id, kind: 'chapter.extract', target: 'c00003', lane: 'side', state: 'blocked' },
      { id: 'l-leased', bookId: legacy.id, kind: 'plan.arc', target: 'a0002', lane: 'side', state: 'leased', leaseOwner: 'dead' },
      { id: 'canary', bookId: null, kind: 'harness.canary', target: 'fake@1:container', lane: 'system', state: 'ready' },
      { id: 'v3-waiting', bookId: v3.id, kind: 'book.write', target: 'book', lane: 'write', state: 'waiting', params: outbox },
      { id: 'old-done', bookId: v3.id, kind: 'chapter.extract', target: 'c00001', lane: 'side', state: 'done', params: outbox },
    ]);
    const runDir = path.join(t.paths.runs, '2026-11', 'legacy-run');
    await fs.mkdir(path.join(runDir, 'log'), { recursive: true });
    await t.db.insert(runs).values({ id: 'legacy-run', taskId: 'l-leased', bookId: legacy.id, taskKind: 'plan.arc', attempt: 1, role: 'planner', profileId: 'fake', harness: 'fake', isolation: 'container', state: 'running', runDir });

    const r1 = await migrate();
    expect(r1.tasksCancelled).toBe(5);
    for (const id of ['l-ready', 'l-waiting', 'l-blocked', 'l-leased', 'canary']) {
      const row = await taskRow(id);
      expect(row, id).toMatchObject({ state: 'cancelled', waitReason: 'p3_legacy', leaseOwner: null });
      expect(outboxOf(row), id).toBeFalsy();
    }
    expect(await taskRow('v3-waiting')).toMatchObject({ state: 'waiting' });
    expect(outboxOf(await taskRow('v3-waiting'))).toBe(true);
    // 已经 done 的旧种类：标记清掉，状态不动
    expect(await taskRow('old-done')).toMatchObject({ state: 'done' });
    expect(outboxOf(await taskRow('old-done'))).toBeFalsy();
    expect(r1.outboxCleared).toBe(1);
    expect(await fs.readFile(logFiles(path.join(runDir, 'log')).kill, 'utf8')).toBe('user');

    const before = await t.db.select().from(tasks);
    const r2 = await migrate();
    expect(r2.tasksCancelled).toBe(0);
    expect(r2.outboxCleared).toBe(0);
    expect(await t.db.select().from(tasks)).toEqual(before);
  });
});

describe('M3 inbox', () => {
  it('M3a closes removed kinds and legacy-book items every boot; M3b closes unknown dedupe keys once; v3 / infra items stay open', async () => {
    const legacy = await createLegacyBook(t.db, t.paths, 'old');
    const v3 = await addV3Book(t, 'new', { chapters: 1 });
    await addInbox({ kind: 'block', key: `block:chapter.write:c00004`, bookId: legacy.id });
    await addInbox({ kind: 'approval', key: `approval:compass:${v3.id}`, bookId: v3.id });
    await addInbox({ kind: 'circuit', key: 'circuit:codex:1:container' });
    await addInbox({ kind: 'quota', key: 'quota:acc' });
    await addInbox({ kind: 'notice', key: `v3_no_prose:${v3.id}`, bookId: v3.id });
    await addInbox({ kind: 'notice', key: 'zero_diff:acc' });
    await addInbox({ kind: 'notice', key: 'nonce:p:global' });
    const r1 = await migrate();
    expect(r1.inboxClosed).toBe(4);
    expect(await openKeys()).toEqual(['quota:acc', `v3_no_prose:${v3.id}`, 'zero_diff:acc'].sort());
    const closed = (await t.db.select().from(inbox).where(eq(inbox.state, 'resolved')))[0];
    expect(closed?.resolution).toMatchObject({ auto: true, reason: 'p3_legacy' });
    expect((await loadMigrationState(t.db)).steps.closeLegacyInbox).toBeTruthy();

    // 回滚过旧镜像之后再部署：旧镜像建的审批 / 拦截项每次开机都关；未知前缀的只在第一次关
    await addInbox({ kind: 'approval', key: `approval:first_volume:${v3.id}`, bookId: v3.id });
    await addInbox({ kind: 'block', key: 'block:plan.arc:a0003', bookId: legacy.id });
    await addInbox({ kind: 'notice', key: 'refusal:t1' });
    const r2 = await migrate();
    expect(r2.inboxClosed).toBe(2);
    expect(await openKeys()).toEqual(['quota:acc', 'refusal:t1', `v3_no_prose:${v3.id}`, 'zero_diff:acc'].sort());
  });

  it('the v3 dedupe prefixes are LIKE patterns with escaped underscores', () => {
    const p = v3InboxPatterns();
    expect(p).toContain('quota:%');
    expect(p).toContain('v3\\_%');
    expect(p).toContain('zero\\_diff:%');
  });
});

describe('M1 classifyBooks', () => {
  it('backfills meta.v3 only for a v3 book.yaml without chapters; reports mismatch / interrupted takeover / invalid / missing; never changes status', async () => {
    const lost = await addV3Book(t, 'lostmeta', { chapters: 0, status: 'planning' });
    await t.db.update(books).set({ meta: {} }).where(eq(books.id, lost.id));
    const mismatch = await addV3Book(t, 'mismatch', { chapters: 5 });
    await t.db.update(books).set({ meta: { blurb: 'x' } }).where(eq(books.id, mismatch.id));
    const intent = await addV3Book(t, 'intent', { chapters: 2 });
    await t.db.update(books).set({ meta: { takeoverIntent: { at: '2026-11-10T00:00:00.000Z', from: 3 } } }).where(eq(books.id, intent.id));
    const bad = await addV3Book(t, 'badyaml', { chapters: 1 });
    await fs.writeFile(path.join(bad.dir, 'book.yaml'), 'slug: [unclosed\n');
    const legacy = await createLegacyBook(t.db, t.paths, 'old');
    await t.db.insert(books).values({ id: 'gone', slug: 'gone', title: 'gone', genre: 'xianxia', status: 'paused', pausedReason: 'import' });
    await t.db.insert(tasks).values({ id: 'mm-write', bookId: mismatch.id, kind: 'book.write', target: 'book', lane: 'write', state: 'ready' });

    const r = await migrate();
    expect(r.books).toMatchObject({ v3: 1, legacy: 4, missing: 1, metaBackfilled: 1, flowMismatch: ['mismatch'], interruptedTakeover: ['intent'], invalid: ['badyaml'] });
    expect((await t.db.select().from(books).where(eq(books.id, lost.id)))[0]?.meta).toMatchObject({ v3: { hints: [], batchLog: [] } });
    expect((await t.db.select().from(books).where(eq(books.id, mismatch.id)))[0]?.meta).toEqual({ blurb: 'x' });
    expect((await t.db.select().from(books).where(eq(books.id, intent.id)))[0]?.meta).not.toHaveProperty('v3');
    // mismatch 仍是旧书：它的任务认领不到（M2 已经把它取消了）
    expect((await taskRow('mm-write'))?.state).toBe('cancelled');
    expect(await claimNext(t.db, { owner: 'o', leaseMs: 1000 })).toBeNull();
    const statuses = Object.fromEntries((await t.db.select({ slug: books.slug, status: books.status }).from(books)).map((b) => [b.slug, b.status]));
    expect(statuses).toMatchObject({ lostmeta: 'planning', mismatch: 'active', intent: 'active', badyaml: 'active', old: 'paused', gone: 'paused' });
    expect(legacy.id).toBe('book-old');
  });
});

describe('M5 volumeTitles', () => {
  async function volumeBook(slug: string) {
    const b = await createLegacyBook(t.db, t.paths, slug, {
      chapters: 8,
      volumes: [{ id: 'v01', title: '第一卷 风起', from: 1, to: 5, extra: { goal: '旧字段', milestones_due: ['m1'] } }],
      files: { 'plan/volumes/v02.yaml': 'id: v02\ntitle: [broken\n', 'plan/volumes/v03.yaml': 'id: v03\nchapters: [c00006, c00007]\n' },
    });
    const vol: Record<number, string> = { 1: 'v01', 2: 'v01', 3: '', 4: '', 5: 'v01', 6: 'v02', 7: 'v03', 8: '' };
    for (const [no, v] of Object.entries(vol)) await t.db.update(chapters).set({ volume: v }).where(and(eq(chapters.bookId, b.id), eq(chapters.no, Number(no))));
    return b;
  }

  it('fills titles by id, assigns in-range rows to their volume, never writes an id as a title; per-book marker; later runs skip the book', async () => {
    const b = await volumeBook('vol');
    const r1 = await migrate();
    expect(r1.volumeTitles).toMatchObject({ rows: 5, books: 1, retryLater: [] });
    for (const no of [1, 2, 3, 4, 5]) expect(await chapterRow(b.id, no), String(no)).toMatchObject({ volume: 'v01', volumeTitle: '第一卷 风起' });
    expect(await chapterRow(b.id, 6)).toMatchObject({ volume: 'v02', volumeTitle: '' });
    expect(await chapterRow(b.id, 7)).toMatchObject({ volume: 'v03', volumeTitle: '' });
    expect(await chapterRow(b.id, 8)).toMatchObject({ volume: '', volumeTitle: '' });
    expect((await loadMigrationState(t.db)).volumeTitles[b.id]).toBeTruthy();

    // 之后删掉 YAML 也不影响（读者端只读数据库），第二次开机不再碰这本书
    await fs.rm(path.join(b.dir, 'plan'), { recursive: true, force: true });
    const r2 = await migrate();
    expect(r2.volumeTitles).toMatchObject({ rows: 0, books: 0 });
    expect(await chapterRow(b.id, 1)).toMatchObject({ volumeTitle: '第一卷 风起' });
  });

  it('a broken repo is skipped and retried on the next boot; a taken-over book (meta.v3) with unfilled rows is still filled', async () => {
    const broken = await volumeBook('broke');
    await fs.rename(path.join(broken.dir, '.git'), path.join(broken.dir, '.git-away'));
    const taken = await createLegacyBook(t.db, t.paths, 'taken', { chapters: 2, volumes: [{ id: 'v01', title: '卷一', from: 1, to: 2 }] });
    await t.db.update(books).set({ meta: { v3: { hints: [] } } }).where(eq(books.id, taken.id));
    const r1 = await migrate();
    expect(r1.volumeTitles.retryLater).toEqual(['broke']);
    expect((await loadMigrationState(t.db)).volumeTitles[broken.id]).toBeUndefined();
    expect(await chapterRow(broken.id, 1)).toMatchObject({ volumeTitle: '' });
    expect(await chapterRow(taken.id, 2)).toMatchObject({ volume: 'v01', volumeTitle: '卷一' });

    await fs.rename(path.join(broken.dir, '.git-away'), path.join(broken.dir, '.git'));
    const r2 = await migrate();
    expect(r2.volumeTitles.retryLater).toEqual([]);
    expect(await chapterRow(broken.id, 1)).toMatchObject({ volumeTitle: '第一卷 风起' });
    expect((await loadMigrationState(t.db)).volumeTitles[broken.id]).toBeTruthy();
  });
});

describe('M6 report', () => {
  it('persists the last report in settings and never touches autoStart', async () => {
    await createLegacyBook(t.db, t.paths, 'old');
    const r = await migrate();
    const state = await loadMigrationState(t.db);
    expect(state.report).toMatchObject({ books: { legacy: 1 }, tasksCancelled: r.tasksCancelled, at: expect.any(String) });
    expect((await loadSystemSettings(t.db)).autoStart.enabled).toBe(false);
    const sys = (await t.db.select().from(settings).where(eq(settings.key, 'system')))[0]?.value as { autoStart?: { enabled?: unknown } } | undefined;
    expect(sys?.autoStart?.enabled).not.toBe(true);
  });

  it('bootstrap() without bootMigrate (the CLI path, createTestApp) writes no migration.p3 row', async () => {
    const app = await createTestApp();
    try {
      expect(await app.deps.db.select().from(settings).where(eq(settings.key, MIGRATION_KEY))).toEqual([]);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe('M4 routingSlots', () => {
  const slotsRow = async () => (await t.db.select().from(settings).where(eq(settings.key, 'routing.slots')))[0];
  const activeRow = async () => (await t.db.select().from(settings).where(eq(settings.key, 'routing.active')))[0];
  async function legacy(active: Record<string, unknown> | null, preset?: { id: string; body: Record<string, unknown> }): Promise<void> {
    await t.db.delete(settings).where(eq(settings.key, 'routing.slots'));
    if (active) await t.db.insert(settings).values({ key: 'routing.active', value: active, updatedAt: '2026-01-01T00:00:00.000Z' });
    if (preset) await t.db.insert(routingPresets).values({ id: preset.id, name: preset.id, builtin: false, body: preset.body });
  }
  const addProfile = (id: string) => t.db.insert(profiles).values({ id, harness: 'fake', enabled: true, builtin: false, body: { id, harness: 'fake', model: 'fake-model' } });

  it('routing.active agy-argon without a preset row → writer agy-argon / no fallback, utility agy-flash-check; routing.active untouched', async () => {
    await legacy({ presetId: 'agy-argon', overrides: {} });
    const before = await activeRow();
    const r = await migrate();
    expect(r.slots).toBe('created');
    expect(r.droppedProfiles).toEqual([]);
    expect((await slotsRow())?.value).toEqual({ schema: 'nv.slots/1', writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-flash-check', fallback: null }, migratedFrom: 'agy-argon', droppedProfiles: [] });
    expect(await activeRow()).toEqual(before);
    // 再跑一次：已有 routing.slots，不动
    const again = await migrate();
    expect(again.slots).toBe('kept');
  });

  it('a custom preset row: writer chain [a, b] and checker [c] → a / b, c; overrides.writer.chain wins', async () => {
    for (const id of ['pa', 'pb', 'pc', 'px']) await addProfile(id);
    const body = { id: 'mine', name: 'mine', roles: { writer: { chain: ['pa', 'pb'] }, checker: { chain: ['pc'] } } };
    await legacy({ presetId: 'mine', overrides: {} }, { id: 'mine', body });
    await migrate();
    expect((await slotsRow())?.value).toMatchObject({ writer: { primary: 'pa', fallback: 'pb' }, utility: { primary: 'pc', fallback: null }, migratedFrom: 'mine' });
    await t.db.delete(settings).where(eq(settings.key, 'routing.active'));
    await legacy({ presetId: 'mine', overrides: { writer: { chain: ['px'] } } });
    await migrate();
    expect((await slotsRow())?.value).toMatchObject({ writer: { primary: 'px', fallback: null }, utility: { primary: 'pc', fallback: null } });
  });

  it('a sticky writer route (sticky: book, every built-in preset) gets no automatic fallback: a v3 book on a migrated mixed / dev-cheap / sticky custom chain waits instead of switching vendor', async () => {
    for (const id of ['pa', 'pb', 'pc']) await addProfile(id);
    const body = { id: 'stuck', name: 'stuck', roles: { writer: { chain: ['pa', 'pb'], sticky: 'book' }, checker: { chain: ['pc'] } } };
    await legacy({ presetId: 'stuck', overrides: {} }, { id: 'stuck', body });
    await migrate();
    expect((await slotsRow())?.value).toMatchObject({ writer: { primary: 'pa', fallback: null }, utility: { primary: 'pc', fallback: null } });
    await t.db.delete(settings).where(eq(settings.key, 'routing.active'));
    await legacy({ presetId: 'dev-cheap', overrides: {} });
    await migrate();
    expect((await slotsRow())?.value).toMatchObject({ writer: { primary: 'cc-haiku', fallback: null }, migratedFrom: 'dev-cheap' });
    await t.db.delete(settings).where(eq(settings.key, 'routing.active'));
    await legacy({ presetId: 'mixed', overrides: {} });
    await migrate();
    expect((await slotsRow())?.value).toMatchObject({ writer: { primary: 'cc-opus', fallback: null }, migratedFrom: 'mixed' });
    // cc-opus 不可用（停用）：写作位置没有可用模型 → 任务等，不会落到 cx-sol
    await t.db.update(profiles).set({ enabled: false }).where(eq(profiles.id, 'cc-opus'));
    const b = await addV3Book(t, 'mixed-book', { chapters: 1 });
    const handle = await t.pipeline.openBook(t.deps as never, b.id);
    const route = await resolveSlot(t.db, { slot: 'writer', book: handle, now: new Date() });
    expect(route.profile).toBeNull();
  });

  it('a profile of the old preset deleted beforehand → dropped (row and report); utility falls back to the writer', async () => {
    await t.db.delete(profiles).where(eq(profiles.id, 'agy-flash-check'));
    await legacy({ presetId: 'agy-argon', overrides: {} });
    const r = await migrate();
    expect(r.droppedProfiles).toEqual(['agy-flash-check']);
    expect((await slotsRow())?.value).toMatchObject({ writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-argon', fallback: null }, droppedProfiles: ['agy-flash-check'] });
  });

  it('an existing routing.slots row is never touched; a fresh install (no routing.active either) gets DEFAULT_SLOTS', async () => {
    const before = await slotsRow();
    expect(before).toBeTruthy();
    expect((await migrate()).slots).toBe('kept');
    expect(await slotsRow()).toEqual(before);
    await legacy(null);
    expect((await migrate()).slots).toBe('created');
    expect((await slotsRow())?.value).toEqual({ schema: 'nv.slots/1', writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-flash-check', fallback: null }, droppedProfiles: [] });
    expect(await activeRow()).toBeUndefined();
  });

  it('after a migration that dropped a profile, a PUT changing only the writer slot succeeds (API)', async () => {
    const app = await createTestApp();
    try {
      await app.deps.db.delete(settings).where(eq(settings.key, 'routing.slots'));
      await app.deps.db.insert(settings).values({ key: 'routing.active', value: { presetId: 'mixed', overrides: {} } });
      await app.deps.db.delete(profiles).where(eq(profiles.id, 'cx-terra'));
      const r = await runBootMigrations(app.deps);
      expect(r.droppedProfiles).toEqual(['cx-terra']);
      const login = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
      const cookie = String(login.headers['set-cookie']).split(';')[0] as string;
      const view = (await app.app.inject({ method: 'GET', url: '/api/admin/routing/slots', headers: { cookie } })).json();
      // mixed 的 cx-sol 只在需要审批的 failover_chain 里：不变成自动备用
      expect(view.slots).toMatchObject({ writer: { primary: 'cc-opus', fallback: null }, utility: { primary: 'cc-opus', fallback: null }, migratedFrom: 'mixed', droppedProfiles: ['cx-terra'] });
      const put = await app.app.inject({ method: 'PUT', url: '/api/admin/routing/slots', headers: { cookie }, payload: { writer: { primary: 'agy-argon', fallback: 'cx-sol' }, utility: view.slots.utility } });
      expect(put.statusCode).toBe(200);
      expect(put.json().slots).toMatchObject({ writer: { primary: 'agy-argon', fallback: 'cx-sol' }, droppedProfiles: ['cx-terra'] });
    } finally {
      await app.close();
    }
  });
});

describe('M4b runPostRecoveryMigrations (writer overrides)', () => {
  const post = () => runPostRecoveryMigrations({ db: t.db, paths: t.paths, log: t.deps.log, config: t.config });
  const bookYaml = async (b: { repo: { readFile(p: string): Promise<string | null> } }) => (await b.repo.readFile('book.yaml')) as string;
  async function v3With(slug: string, writerProfile: string | null) {
    const b = await addV3Book(t, slug, { chapters: 1 });
    await t.db.update(books).set({ writerProfile }).where(eq(books.id, b.id));
    return b;
  }
  beforeEach(async () => {
    await saveSlots(t.db, { writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-flash-check', fallback: null } });
  });

  it('a differing books.writer_profile moves into book.yaml routing.writer_profile with the migration trailer; equal / unset → no commit; both marked done', async () => {
    const moved = await v3With('m-moved', 'cc-opus');
    const same = await v3With('m-same', 'agy-argon');
    const none = await v3With('m-none', null);
    const heads = { same: await same.repo.head(), none: await none.repo.head() };
    const r = await post();
    expect(r).toEqual({ applied: 1, deferred: [] });
    expect(parseYaml(await bookYaml(moved)).routing).toEqual({ writer_profile: 'cc-opus' });
    const last = (await moved.repo.log({ limit: 1 })).items[0];
    expect(last?.trailers['Novelist-Migration']).toBe(WRITER_OVERRIDE_TRAILER);
    expect(last?.trailers['Novelist-Owner-Edit']).toBe('true');
    expect((await t.db.select().from(books).where(eq(books.id, moved.id)))[0]?.headCommit).toBe(await moved.repo.head());
    expect(await same.repo.head()).toBe(heads.same);
    expect(await none.repo.head()).toBe(heads.none);
    const state = await loadMigrationState(t.db);
    expect(Object.keys(state.writerOverrides).sort()).toEqual([moved.id, none.id, same.id].sort());
    // 再跑：都做过了，不再提交
    const head = await moved.repo.head();
    expect(await post()).toEqual({ applied: 0, deferred: [] });
    expect(await moved.repo.head()).toBe(head);
  });

  it('a book with a finalizing task or meta.v3.pending is deferred (no commit) and retried on the next call once clear; a dirty worktree is deferred; legacy books are ignored', async () => {
    const busy = await v3With('m-busy', 'cc-opus');
    const pend = await v3With('m-pend', 'cc-opus');
    const dirty = await v3With('m-dirty', 'cc-opus');
    const old = await createLegacyBook(t.db, t.paths, 'm-old', {});
    await t.db.update(books).set({ writerProfile: 'cc-opus' }).where(eq(books.id, old.id));
    await t.db.insert(tasks).values({ id: 'fin', bookId: busy.id, kind: 'book.write', target: 'batch-c00002', lane: 'write', state: 'finalizing' });
    const meta = (await t.db.select().from(books).where(eq(books.id, pend.id)))[0]?.meta as { v3: Record<string, unknown> };
    await t.db.update(books).set({ meta: { ...meta, v3: { ...meta.v3, pending: { taskId: 'x', runId: 'r' } } } }).where(eq(books.id, pend.id));
    await fs.writeFile(path.join(dirty.dir, 'stray.md'), '主人没提交的文件\n');
    const heads = [await busy.repo.head(), await pend.repo.head(), await dirty.repo.head()];
    const r = await post();
    expect(r.applied).toBe(0);
    expect(r.deferred.sort()).toEqual(['m-busy', 'm-dirty', 'm-pend']);
    expect([await busy.repo.head(), await pend.repo.head(), await dirty.repo.head()]).toEqual(heads);
    // 只有第一次跑时就在的旧书记为做完（以后被接手也不归 M4b 管），延后的书没有记
    expect((await loadMigrationState(t.db)).writerOverrides).toEqual({ [old.id]: expect.any(String) });
    // 条件消失后的下一次（下次开机）
    await t.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, 'fin'));
    await t.db.update(books).set({ meta }).where(eq(books.id, pend.id));
    await fs.rm(path.join(dirty.dir, 'stray.md'));
    const r2 = await post();
    expect(r2).toEqual({ applied: 3, deferred: [] });
    for (const b of [busy, pend, dirty]) expect(parseYaml(await bookYaml(b)).routing).toEqual({ writer_profile: 'cc-opus' });
    expect(parseYaml((await fs.readFile(path.join(old.dir, 'book.yaml'), 'utf8')) as string).routing).toBeUndefined();
  });

  it('a legacy book with a stale v2 sticky writer: present at the first run → marked done; converted to v3 later (takeover) → the next run makes no commit and adds no override', async () => {
    const old = await createLegacyBook(t.db, t.paths, 'm-legacy', { chapters: 2 });
    await t.db.update(books).set({ writerProfile: 'cc-opus' }).where(eq(books.id, old.id));
    expect(await post()).toEqual({ applied: 0, deferred: [] });
    expect((await loadMigrationState(t.db)).steps.writerOverridesInit).toBeTruthy();
    // 之后被转成 v3（没有接手标记也一样：第一次跑时它是旧书）
    const row = (await t.db.select().from(books).where(eq(books.id, old.id)))[0]!;
    await t.db.update(books).set({ meta: { ...(row.meta as object), v3: emptyV3Meta() } }).where(eq(books.id, old.id));
    const repo = openRepo(old.dir);
    const head = await repo.head();
    expect(await post()).toEqual({ applied: 0, deferred: [] });
    expect(await repo.head()).toBe(head);
    expect(parseYaml((await repo.readFile('book.yaml')) as string).routing).toBeUndefined();
  });

  it('a taken-over book (meta.v3.takeover set) is never given the old sticky writer, even when the init marker predates it', async () => {
    const b = await v3With('m-taken', 'cc-opus');
    const row = (await t.db.select().from(books).where(eq(books.id, b.id)))[0]!;
    const meta = row.meta as { v3: Record<string, unknown> };
    await t.db.update(books).set({ meta: { ...meta, v3: { ...meta.v3, takeover: { at: '2026-11-01T00:00:00.000Z', from: 2, status: 'done' } } } }).where(eq(books.id, b.id));
    const head = await b.repo.head();
    expect(await post()).toEqual({ applied: 0, deferred: [] });
    expect(await b.repo.head()).toBe(head);
    expect((await loadMigrationState(t.db)).writerOverrides[b.id]).toBeTruthy();
    // 路由也不用旧值
    const handle = await t.pipeline.openBook(t.deps as never, b.id);
    expect(await writerProfileOf(t.db, handle)).toBe('agy-argon');
  });

  it('while deferred the book keeps its old sticky writer (resolveSlot / writerProfileOf); the leader-tick retry moves it into book.yaml once the run is done (no restart), throttled to once a minute', async () => {
    await t.db.insert(profiles).values({ id: 'fx', harness: 'fake', enabled: true, builtin: false, body: { id: 'fx', harness: 'fake', model: 'fake-model' } });
    const b = await v3With('m-live', 'fx');
    await t.db.insert(tasks).values({ id: 'live', bookId: b.id, kind: 'book.write', target: 'batch-c00002', lane: 'write', state: 'running' });
    expect(await post()).toEqual({ applied: 0, deferred: ['m-live'] });
    const handle = await t.pipeline.openBook(t.deps as never, b.id);
    expect(handle.config.routing.writer_profile).toBeUndefined();
    const route = await resolveSlot(t.db, { slot: 'writer', book: handle, now: new Date(), allowFakeHarness: true });
    expect(route).toMatchObject({ profile: 'fx', usedFallback: false });
    expect(await writerProfileOf(t.db, handle)).toBe('fx');

    const retry = createWriterOverrideRetry({ db: t.db, paths: t.paths, log: t.deps.log, config: t.config });
    const t0 = new Date('2026-11-11T00:00:00.000Z');
    await retry(t0); // 还在跑：仍然延后
    expect(parseYaml(await bookYaml(b)).routing).toBeUndefined();
    await t.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, 'live'));
    await retry(new Date(t0.getTime() + 30_000)); // 一分钟之内：不再跑
    expect(parseYaml(await bookYaml(b)).routing).toBeUndefined();
    await retry(new Date(t0.getTime() + 61_000));
    expect(parseYaml(await bookYaml(b)).routing).toEqual({ writer_profile: 'fx' });
    expect((await loadMigrationState(t.db)).writerOverrides[b.id]).toBeTruthy();
    // 做完以后：路由读 book.yaml 的覆盖；主人在书页上清掉覆盖后，旧列不会再顶回来
    const after = await t.pipeline.openBook(t.deps as never, b.id);
    expect(await writerProfileOf(t.db, after)).toBe('fx');
    expect(await writerProfileOf(t.db, { ...after, config: { ...after.config, routing: {} } } as never)).toBe('agy-argon');
    // 没有延后的书：retry 什么都不做
    const head = await b.repo.head();
    await retry(new Date(t0.getTime() + 200_000));
    expect(await b.repo.head()).toBe(head);
  });

  it('a book.yaml that already has routing.writer_profile is left alone (the book wins)', async () => {
    const b = await v3With('m-own', 'cc-opus');
    const yaml = await bookYaml(b);
    await b.repo.writeFiles([{ path: 'book.yaml', content: `${yaml.trimEnd()}\nrouting:\n  writer_profile: cx-sol\n` }]);
    await b.repo.commit({ message: 'owner', trailers: { 'Novelist-Owner-Edit': 'true' } });
    const head = await b.repo.head();
    expect(await post()).toEqual({ applied: 0, deferred: [] });
    expect(await b.repo.head()).toBe(head);
    expect(parseYaml(await bookYaml(b)).routing).toEqual({ writer_profile: 'cx-sol' });
  });
});
