/** v3 的待办卫生（p2-plan §2.4、§3.3 J、§6 WP-3 flow/inbox-v3）。 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accounts, accountsState, books, inbox, runs, settings, tasks } from '../db/schema.js';
import { execEnv, type ExecEnv } from '../orchestrator/executor.js';
import { actOnInbox, createInboxItem, dismissInbox } from '../orchestrator/inbox.js';
import { enqueue } from '../orchestrator/queue.js';
import { createOrchTestEnv, type OrchTestEnv } from '../orchestrator/testing.js';
import type { InboxInput } from '../runtime/types.js';
import { bumpZeroDiff, resumeZeroDiffAccount } from './accounts.js';
import { QUOTA_AWAKE_END_MS, QUOTA_INBOX_AFTER_MS, lowBufferStuck, nextQuotaStreak, reconcileV3Inbox, v3InboxAllowed, type LowBufferRow, type QuotaStreak } from './inbox-v3.js';
import { addV3Book } from './testing-book.js';

const item = (dedupeKey?: string): InboxInput => ({ kind: 'notice', bookId: null, title: 't', body: {}, actions: [], ...(dedupeKey !== undefined ? { dedupeKey } : {}) });
const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms);
const MIN = 60_000;
const H = 60 * MIN;

describe('v3InboxAllowed', () => {
  it('only the DESIGN §8.3 kinds plus v3_end; quota / refusal / budget / nonce and keyless items are dropped', () => {
    const table: [string | undefined, boolean][] = [
      ['auth:acct-a', true],
      ['billing:acct-a', true],
      ['circuit:fake:1:none', true],
      ['no_route:book-x', true],
      ['zero_diff:acct-a', true],
      ['v3_no_prose:book-x', true],
      ['v3_end:book-x', true],
      ['v3_low_buffer', true],
      ['quota:acct-a', false],
      ['refusal:task-1', false],
      ['budget:task-1', false],
      ['nonce:profile-x:book-x', false],
      ['v3_pending:book-x', false],
      ['v3_agents_size:book-x', false],
      ['failed:task-1', false],
      [undefined, false],
    ];
    for (const [key, ok] of table) expect([key, v3InboxAllowed(item(key))]).toEqual([key, ok]);
  });
});

describe('nextQuotaStreak', () => {
  it("agy's 30m / 1h / 2h / 5h ladder with short awake probes in between stays one streak", () => {
    let s: QuotaStreak | null = null;
    let t = 0;
    const step = (sleeping: boolean, dt: number) => {
      t += dt;
      s = nextQuotaStreak(s, { sleeping, excluded: false, lastOkRunAt: null }, at(t));
    };
    step(true, 0);
    expect(s).toEqual({ since: at(0).toISOString(), awakeSince: null });
    for (const sleep of [30 * MIN, 1 * H, 2 * H, 5 * H]) {
      step(true, sleep);
      step(false, MIN); // 醒来试探一次
      expect(s).toMatchObject({ since: at(0).toISOString() });
      step(true, 2 * MIN); // 试探又撞上额度
      expect(s).toEqual({ since: at(0).toISOString(), awakeSince: null });
    }
  });

  it('ends after a run on the account ended without error after `since`, or after 30 min awake in a row', () => {
    const prev: QuotaStreak = { since: at(0).toISOString(), awakeSince: null };
    expect(nextQuotaStreak(prev, { sleeping: false, excluded: false, lastOkRunAt: at(10 * MIN).toISOString() }, at(11 * MIN))).toBeNull();
    // 成功的运行在这一轮开始之前：不算
    expect(nextQuotaStreak(prev, { sleeping: false, excluded: false, lastOkRunAt: at(-MIN).toISOString() }, at(11 * MIN))).toEqual({ since: prev.since, awakeSince: at(11 * MIN).toISOString() });
    const awake: QuotaStreak = { since: prev.since, awakeSince: at(MIN).toISOString() };
    expect(nextQuotaStreak(awake, { sleeping: false, excluded: false, lastOkRunAt: null }, at(MIN + QUOTA_AWAKE_END_MS - 1))).toEqual(awake);
    expect(nextQuotaStreak(awake, { sleeping: false, excluded: false, lastOkRunAt: null }, at(MIN + QUOTA_AWAKE_END_MS))).toBeNull();
    // 账单问题、空跑暂停不算额度耗尽
    expect(nextQuotaStreak(null, { sleeping: true, excluded: true, lastOkRunAt: null }, at(0))).toBeNull();
    expect(nextQuotaStreak(null, { sleeping: false, excluded: false, lastOkRunAt: null }, at(0))).toBeNull();
  });
});

describe('lowBufferStuck', () => {
  const r = (o: Partial<LowBufferRow>): LowBufferRow => ({ bookId: 'b', slug: 'b', title: 'b', bufferDays: 0.5, running: false, nextRunAt: null, nextRelease: at(8 * H).toISOString(), completed: false, ...o });
  it('buffer < 1 day and the next run is not before the next release (or there is none)', () => {
    const now = at(0);
    expect(lowBufferStuck([r({})], now)).toHaveLength(1);
    expect(lowBufferStuck([r({ nextRunAt: at(9 * H).toISOString() })], now)).toHaveLength(1);
    expect(lowBufferStuck([r({ nextRunAt: at(7 * H).toISOString() })], now)).toHaveLength(0);
    expect(lowBufferStuck([r({ running: true })], now)).toHaveLength(0);
    expect(lowBufferStuck([r({ bufferDays: 1 })], now)).toHaveLength(0);
    expect(lowBufferStuck([r({ bufferDays: null })], now)).toHaveLength(0);
    expect(lowBufferStuck([r({ completed: true })], now)).toHaveLength(0);
    expect(lowBufferStuck([r({ nextRunAt: at(9 * H).toISOString(), nextRelease: null })], now)).toHaveLength(0);
  });
});

describe('reconcileV3Inbox (DB)', () => {
  let t: OrchTestEnv;
  let env: ExecEnv;
  beforeEach(async () => {
    t = await createOrchTestEnv();
    env = execEnv(t.deps);
  });
  afterEach(async () => {
    await t.close();
  });

  const openItems = async (prefix: string) => (await t.db.select().from(inbox).where(eq(inbox.state, 'open'))).filter((i) => (i.dedupeKey ?? '').startsWith(prefix));
  const stateOf = async (key: string) => (await t.db.select().from(inbox).where(eq(inbox.dedupeKey, key))).map((i) => i.state);
  const addAccount = async (id: string) => {
    await t.db.insert(accounts).values({ id, harness: 'fake', label: id, authMode: 'none', enabled: true, body: {} });
    await t.db.insert(accountsState).values({ accountId: id });
  };
  const sleep = (id: string, until: Date | null, reason: string | null = 'quota') => t.db.update(accountsState).set({ sleepUntil: until ? until.toISOString() : null, sleepReason: reason }).where(eq(accountsState.accountId, id));
  const manifest = { hard: {}, soft: {}, rebaseValidators: [], configHash: 'c' };
  const addTask = async (id: string, bookId: string, kind: string, state: string, extra: Partial<typeof tasks.$inferInsert> = {}) => {
    await enqueue(t.db, { id, baseCommit: null, manifest, spec: { kind: kind as never, bookId, target: id, lane: 'write' } });
    await t.db.update(tasks).set({ state, ...extra }).where(eq(tasks.id, id));
  };

  it('quota: the item opens once the streak passes 12 h, does not flap between ladder steps, closes after a successful run', async () => {
    await addAccount('acct-a');
    let ms = 0;
    const tick = async (sleepFor: number | null, dt: number) => {
      ms += dt;
      await sleep('acct-a', sleepFor === null ? null : at(ms + sleepFor));
      await reconcileV3Inbox(env, at(ms));
    };
    await tick(30 * MIN, 0);
    const ladder = [30 * MIN, 1 * H, 2 * H, 5 * H, 5 * H, 5 * H];
    let opened = 0;
    for (const step of ladder) {
      // 睡到点 → 醒来试探（1 分钟）→ 又撞上额度，下一级
      await tick(null, step);
      await tick(step, MIN);
      if ((await openItems('quota:acct-a')).length) opened += 1;
      expect((await openItems('quota:')).length).toBeLessThanOrEqual(1);
    }
    expect(ms).toBeGreaterThan(QUOTA_INBOX_AFTER_MS);
    const open = await openItems('quota:acct-a');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'quota', bookId: null, title: '账号 acct-a 额度耗尽已超过 12 小时' });
    expect(String((open[0]?.body as { detail?: string }).detail)).toMatch(/^从 .+ 起一直在等额度，预计 .+ 再试。$/);
    expect(opened).toBeGreaterThanOrEqual(1);
    // 只有一条，从没关过又开
    expect(await stateOf('quota:acct-a')).toEqual(['open']);
    // 成功的一次运行之后：这一轮结束，关掉
    await t.db.insert(runs).values({ id: 'run-ok', taskId: 'x', taskKind: 'book.write', attempt: 1, role: 'writer', profileId: 'profile-x', accountId: 'acct-a', harness: 'fake', isolation: 'none', state: 'finalized', runDir: '/x', endedAt: at(ms + MIN).toISOString() });
    await tick(null, 2 * MIN);
    expect(await stateOf('quota:acct-a')).toEqual(['resolved']);
  });

  it('zero_diff closes after resume; auth closes when the check is ok again', async () => {
    await addAccount('acct-a');
    await bumpZeroDiff(t.db, 'acct-a', true, at(0));
    await bumpZeroDiff(t.db, 'acct-a', true, at(0));
    await sleep('acct-a', at(7 * 24 * H), 'v3 连续空跑');
    await createInboxItem(t.db, t.bus, { ...item('zero_diff:acct-a'), title: 'z' });
    await createInboxItem(t.db, t.bus, { ...item('auth:acct-a'), kind: 'auth', title: 'a' });
    await t.db.update(accountsState).set({ lastAuthCheck: { ok: false } }).where(eq(accountsState.accountId, 'acct-a'));
    await reconcileV3Inbox(env, at(MIN));
    expect(await stateOf('zero_diff:acct-a')).toEqual(['open']);
    expect(await stateOf('auth:acct-a')).toEqual(['open']);
    // 空跑暂停不算额度耗尽
    expect(await openItems('quota:')).toHaveLength(0);
    await resumeZeroDiffAccount(t.db, 'acct-a');
    await t.db.update(accountsState).set({ lastAuthCheck: { ok: true } }).where(eq(accountsState.accountId, 'acct-a'));
    await reconcileV3Inbox(env, at(2 * MIN));
    expect(await stateOf('zero_diff:acct-a')).toEqual(['resolved']);
    expect(await stateOf('auth:acct-a')).toEqual(['resolved']);
  });

  it('v3_no_prose closes after a landed batch; a failed retro does not keep it open, a failed write after the batch does', async () => {
    const b = await addV3Book(t, 'np', { chapters: 3, meta: { noChapterStreak: 5 } });
    await createInboxItem(t.db, t.bus, { ...item(`v3_no_prose:${b.id}`), bookId: b.id });
    await reconcileV3Inbox(env, new Date());
    expect(await stateOf(`v3_no_prose:${b.id}`)).toEqual(['open']);
    const landed = new Date(Date.now() - H).toISOString();
    await t.db.update(books).set({ meta: { v3: { noChapterStreak: 0, emptyStreak: 0, lastBatchAt: landed } } }).where(eq(books.id, b.id));
    await addTask('retro-failed', b.id, 'book.retro', 'failed', { finishedAt: new Date().toISOString() });
    await addTask('write-old', b.id, 'book.write', 'failed', { finishedAt: new Date(Date.now() - 2 * H).toISOString() });
    await addTask('write-new', b.id, 'book.write', 'failed', { finishedAt: new Date().toISOString() });
    await reconcileV3Inbox(env, new Date());
    expect(await stateOf(`v3_no_prose:${b.id}`)).toEqual(['open']);
    await t.db.update(tasks).set({ state: 'cancelled' }).where(eq(tasks.id, 'write-new'));
    await reconcileV3Inbox(env, new Date());
    expect(await stateOf(`v3_no_prose:${b.id}`)).toEqual(['resolved']);
  });

  it('no_route:<book> closes when the task routes again; legacy v3 items of v3 books are dismissed, v2 books keep theirs', async () => {
    const b = await addV3Book(t, 'nr', { chapters: 2 });
    await t.db.insert(books).values({ id: 'v2book', slug: 'v2book', title: 'v2', genre: 'g', status: 'active', meta: {} });
    await addTask('w1', b.id, 'book.write', 'blocked');
    await createInboxItem(t.db, t.bus, { ...item(`no_route:${b.id}`), kind: 'block', bookId: b.id, relatedTaskId: 'w1' });
    const legacy = [`v3_empty:${b.id}`, `v3_agents_size:${b.id}`, `v3_gap:${b.id}`, `v3_discard:${b.id}`, `low_buffer:${b.id}`, `buffer_blocked:${b.id}`, `no_route:${b.id}:writer`, `failover:${b.id}`, 'no_route:task:w1', `v3_pending:${b.id}`, 'failed:w1'];
    for (const k of legacy) await createInboxItem(t.db, t.bus, { ...item(k), bookId: b.id });
    for (const k of ['low_buffer:v2book', 'failover:v2book', 'no_route:v2book:writer']) await createInboxItem(t.db, t.bus, { ...item(k), bookId: 'v2book' });
    await reconcileV3Inbox(env, new Date());
    expect(await stateOf(`no_route:${b.id}`)).toEqual(['open']);
    for (const k of legacy) expect([k, await stateOf(k)]).toEqual([k, ['dismissed']]);
    for (const k of ['low_buffer:v2book', 'failover:v2book', 'no_route:v2book:writer']) expect(await stateOf(k)).toEqual(['open']);
    await t.db.update(tasks).set({ state: 'ready' }).where(eq(tasks.id, 'w1'));
    await reconcileV3Inbox(env, new Date());
    expect(await stateOf(`no_route:${b.id}`)).toEqual(['resolved']);
  });

  it('v3_pending stays while the pending is blocked (failures ≥ 3)', async () => {
    const pending = { taskId: 'w', runId: 'r', attempt: 1, stage: 'harvested', runDir: '/x', inDir: '/x/in', snapshotDir: '/x/book', baseCommit: 'b', manifestFile: null, trailerKey: 'k', route: { profile: 'p', account: null, harness: 'fake', model: null, isolation: 'none', stackHash: 'h' }, failures: 3, createdAt: new Date().toISOString() };
    const b = await addV3Book(t, 'pd', { chapters: 2, meta: { pending: pending as never } });
    await createInboxItem(t.db, t.bus, { ...item(`v3_pending:${b.id}`), bookId: b.id });
    await reconcileV3Inbox(env, new Date());
    expect(await stateOf(`v3_pending:${b.id}`)).toEqual(['open']);
  });

  it('one site-wide v3_low_buffer item for two stuck books, then resolved', async () => {
    const sched = (d: number) => ({ sched: { bufferDays: d, bufferFull: false, at: new Date().toISOString() } });
    const a = await addV3Book(t, 'lba', { chapters: 3, published: 2, title: '甲书', meta: sched(0.5) });
    const c = await addV3Book(t, 'lbc', { chapters: 3, published: 3, title: '丙书', meta: sched(0) });
    await addV3Book(t, 'lbd', { chapters: 9, published: 2, title: '丁书', meta: sched(3.5) });
    await addTask('blocked-c', c.id, 'book.write', 'blocked');
    const r1 = await reconcileV3Inbox(env, new Date());
    expect(r1.lowBuffer).toBe(2);
    const open = await openItems('v3_low_buffer');
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe('存稿将尽且写不动：2 本书');
    const detail = String((open[0]?.body as { detail?: string }).detail);
    expect(detail).toContain('《甲书》存稿只够约 0.5 天，当前没有在写');
    expect(detail).toContain('《丙书》存稿只够约 0 天，收稿出错，等你处理');
    // 再扫一遍：还是那一条（更新，不新开）
    await reconcileV3Inbox(env, new Date());
    expect((await t.db.select().from(inbox).where(eq(inbox.dedupeKey, 'v3_low_buffer')))).toHaveLength(1);
    // 甲在写、丙的存稿够了 → 关
    await addTask('run-a', a.id, 'book.write', 'running');
    await t.db.update(books).set({ meta: { v3: sched(2) } }).where(eq(books.id, c.id));
    const r2 = await reconcileV3Inbox(env, new Date());
    expect(r2.lowBuffer).toBe(0);
    expect(await stateOf('v3_low_buffer')).toEqual(['resolved']);
  });

  it('an owner-dismissed quota item is not reopened for the same streak (either dismiss path); a new streak opens a new one', async () => {
    await addAccount('acct-q');
    await sleep('acct-q', at(13 * H + 5 * H));
    await reconcileV3Inbox(env, at(0));
    await reconcileV3Inbox(env, at(13 * H));
    const [first] = await openItems('quota:acct-q');
    expect(first).toBeDefined();
    // 主人点“知道了”（actOnInbox 的 dismiss：resolved + resolution.action）
    await actOnInbox(t.db, t.bus, first!.id, 'dismiss');
    for (const m of [1, 2, 3]) await reconcileV3Inbox(env, at(13 * H + m * MIN));
    expect(await stateOf('quota:acct-q')).toEqual(['resolved']);
    // 这一轮结束（成功的一次运行），之后又耗尽 12 小时以上：新的一条
    await t.db.insert(runs).values({ id: 'run-q', taskId: 'x', taskKind: 'book.write', attempt: 1, role: 'writer', profileId: 'profile-x', accountId: 'acct-q', harness: 'fake', isolation: 'none', state: 'finalized', runDir: '/x', endedAt: at(14 * H).toISOString() });
    await sleep('acct-q', null);
    await reconcileV3Inbox(env, at(14 * H + MIN));
    await sleep('acct-q', at(40 * H));
    await reconcileV3Inbox(env, at(15 * H));
    await reconcileV3Inbox(env, at(28 * H));
    expect((await stateOf('quota:acct-q')).sort()).toEqual(['open', 'resolved']);
    // dismissInbox（state dismissed，不是自动关的）同样压住
    const [second] = await openItems('quota:acct-q');
    await dismissInbox(t.db, second!.id);
    await reconcileV3Inbox(env, at(28 * H + MIN));
    expect((await stateOf('quota:acct-q')).sort()).toEqual(['dismissed', 'resolved']);
  });

  it('an owner-dismissed v3_low_buffer stays closed while the same books are stuck, reopens when a new book gets stuck or after the condition went away', async () => {
    const sched = (d: number) => ({ sched: { bufferDays: d, bufferFull: false, at: new Date().toISOString() } });
    const a = await addV3Book(t, 'dla', { chapters: 3, published: 2, title: '甲书', meta: sched(0.5) });
    await reconcileV3Inbox(env, new Date());
    const [item1] = await openItems('v3_low_buffer');
    await dismissInbox(t.db, item1!.id);
    await reconcileV3Inbox(env, new Date());
    await reconcileV3Inbox(env, new Date());
    expect(await stateOf('v3_low_buffer')).toEqual(['dismissed']);
    // 又一本书写不动：重新发
    await addV3Book(t, 'dlb', { chapters: 3, published: 3, title: '乙书', meta: sched(0) });
    await reconcileV3Inbox(env, new Date());
    expect((await openItems('v3_low_buffer')).length).toBe(1);
    const [item2] = await openItems('v3_low_buffer');
    await dismissInbox(t.db, item2!.id);
    // 条件消失（两本都在写）再出现：照常发
    await addTask('run-dla', a.id, 'book.write', 'running');
    await t.db.update(books).set({ meta: { v3: sched(3) } }).where(eq(books.slug, 'dlb'));
    await reconcileV3Inbox(env, new Date());
    await t.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, 'run-dla'));
    await reconcileV3Inbox(env, new Date());
    expect((await openItems('v3_low_buffer')).length).toBe(1);
  });

  it('v3_end: the factor-0 alert closes once a marker landed (alerted flag cleared) or the backstop is on again; the backstop completion notice stays', async () => {
    const alert = await addV3Book(t, 'ea', { chapters: 20, meta: { finaleNoMarker: 2, finaleNoMarkerAlerted: true } });
    const notice = await addV3Book(t, 'en', { chapters: 20, status: 'completed', meta: { completedReason: 'backstop', completedAt: new Date().toISOString() } });
    await t.db.insert(settings).values({ key: 'system', value: { v3: { runawayFactor: 0 } }, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: settings.key, set: { value: { v3: { runawayFactor: 0 } } } });
    await createInboxItem(t.db, t.bus, { ...item(`v3_end:${alert.id}`), bookId: alert.id });
    await createInboxItem(t.db, t.bus, { ...item(`v3_end:${notice.id}`), bookId: notice.id });
    await reconcileV3Inbox(env, new Date());
    expect(await stateOf(`v3_end:${alert.id}`)).toEqual(['open']);
    // 作者补了标记、书完结：计数清零
    await t.db.update(books).set({ status: 'completed', meta: { v3: { finaleNoMarker: 0, finaleNoMarkerAlerted: false, completedReason: 'marker' } } }).where(eq(books.id, alert.id));
    await reconcileV3Inbox(env, new Date());
    expect(await stateOf(`v3_end:${alert.id}`)).toEqual(['resolved']);
    expect(await stateOf(`v3_end:${notice.id}`)).toEqual(['open']);
  });
});
