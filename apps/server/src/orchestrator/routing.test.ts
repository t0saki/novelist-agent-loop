/**
 * 路由位置（DESIGN §7，P3 WP-2）：写作 / 杂活两个位置，主、备各一个 profile；书级覆盖顶替写作位置的主用；fake 模式强制 fake；
 * profile 冷却（routing.down:<id>）；没有可用的 → 等到最早能恢复的时刻。
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zBookConfig } from '@novelist/shared';
import { accounts, accountsState, profiles, runs, settings } from '../db/schema.js';
import type { BookHandle } from '../runtime/types.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';
import { loadSlots, markProfileDown, resolveSlot, saveSlots, slotCandidates, slotStatus, writerProfileOf, type ResolveSlotInput } from './routing.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';

const NOW = new Date('2026-11-10T00:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv();
});
afterEach(async () => {
  await t.close();
});

async function profile(id: string, harness: string, extra: Record<string, unknown> = {}): Promise<void> {
  await t.db.insert(profiles).values({ id, harness, enabled: true, builtin: false, body: { id, harness, model: `${id}-model`, ...extra } });
}
async function account(id: string, harness: string, body: Record<string, unknown> = {}): Promise<void> {
  await t.db.insert(accounts).values({ id, harness, authMode: 'subscription_login', enabled: true, body });
}
const sleep = (id: string, until: string) => t.db.insert(accountsState).values({ accountId: id, sleepUntil: until, sleepReason: 'quota' }).onConflictDoUpdate({ target: accountsState.accountId, set: { sleepUntil: until } });
const slots = (writer: [string | null, string | null], utility: [string | null, string | null] = [null, null]) =>
  saveSlots(t.db, { writer: { primary: writer[0], fallback: writer[1] }, utility: { primary: utility[0], fallback: utility[1] } });
const book = (writerProfile?: string): BookHandle =>
  ({ id: 'b1', slug: 'b1', dir: '/x', repo: null, config: zBookConfig.parse({ schema: 'nv.book/1', slug: 'b1', title: 't', genre: 'g', ...(writerProfile ? { routing: { writer_profile: writerProfile } } : {}) }), genre: null, headCommit: '' }) as unknown as BookHandle;
const resolve = (o: Partial<ResolveSlotInput> = {}) => resolveSlot(t.db, { slot: 'writer', book: null, now: NOW, ...o });

describe('resolveSlot', () => {
  beforeEach(async () => {
    await profile('p1', 'claude-code');
    await profile('p2', 'codex');
    await profile('p3', 'grok');
    await account('acc1', 'claude-code');
    await account('acc2', 'codex');
    await account('acc3', 'grok');
  });

  it('primary usable → primary, no fallback used', async () => {
    await slots(['p1', 'p2']);
    expect(await resolve()).toMatchObject({ slot: 'writer', profile: 'p1', account: 'acc1', harness: 'claude-code', model: 'p1-model', usedFallback: false, waitUntil: null });
  });

  it('primary account sleeping → fallback (usedFallback); both sleeping → wait until the earliest; no fallback → wait', async () => {
    await slots(['p1', 'p2']);
    await sleep('acc1', later(3600_000));
    expect(await resolve()).toMatchObject({ profile: 'p2', usedFallback: true });
    await sleep('acc2', later(1800_000));
    const both = await resolve();
    expect(both).toMatchObject({ profile: null, waitUntil: later(1800_000), cause: 'quota' });
    expect(both.reason).toMatch(/^写作位置无可用模型：/);
    await slots(['p1', null]);
    expect(await resolve()).toMatchObject({ profile: null, waitUntil: later(3600_000) });
  });

  it('per-book override replaces the primary and keeps the slot fallback', async () => {
    await slots(['p1', 'p2']);
    expect(await resolve({ book: book('p3') })).toMatchObject({ profile: 'p3', usedFallback: false });
    await sleep('acc3', later(60_000));
    expect(await resolve({ book: book('p3') })).toMatchObject({ profile: 'p2', usedFallback: true });
    expect(slotCandidates(await loadSlots(t.db), 'writer', book('p3'), false)).toEqual(['p3', 'p2']);
    // 覆盖只作用于写作位置
    expect(slotCandidates(await loadSlots(t.db), 'utility', book('p3'), false)).toEqual([]);
    expect(await writerProfileOf(t.db, book('p3'))).toBe('p3');
    expect(await writerProfileOf(t.db, book())).toBe('p1');
  });

  it('forced (fake mode) → fake, the per-book override is ignored; fake only with allowFakeHarness', async () => {
    await slots(['p1', 'p2']);
    expect(await resolve({ book: book('p3'), forced: true, allowFakeHarness: true })).toMatchObject({ profile: 'fake', harness: 'fake', account: null });
    expect(await resolve({ forced: true })).toMatchObject({ profile: null, cause: 'fake_disallowed' });
    await slots(['fake', null]);
    expect(await resolve()).toMatchObject({ profile: null, cause: 'fake_disallowed' });
    expect(await resolve({ allowFakeHarness: true })).toMatchObject({ profile: 'fake' });
  });

  it('requires_ack is enforced per account', async () => {
    await profile('pa', 'claude-code', { requires_ack: ['risk_x'] });
    await slots(['pa', null]);
    expect(await resolve()).toMatchObject({ profile: null, cause: 'ack' });
    await t.db.update(accounts).set({ body: { riskAck: ['risk_x'] } }).where(eq(accounts.id, 'acc1'));
    expect(await resolve()).toMatchObject({ profile: 'pa' });
  });

  it('account concurrency full → wait 15 s (ignoreConcurrency skips the check)', async () => {
    await slots(['p1', null]);
    await t.db.insert(runs).values({ id: 'run1', taskId: 'x', taskKind: 'book.write', attempt: 1, role: 'writer', profileId: 'p1', accountId: 'acc1', harness: 'claude-code', isolation: 'container', state: 'running', runDir: '/tmp/run1' });
    expect(await resolve()).toMatchObject({ profile: null, cause: 'concurrency', waitUntil: later(15_000) });
    expect(await resolve({ ignoreConcurrency: true })).toMatchObject({ profile: 'p1' });
  });

  it('routing.down:<profile> live → fallback; expired → primary again', async () => {
    await slots(['p1', 'p2']);
    await markProfileDown(t.db, 'p1', later(1800_000), 'model gone');
    const r = await resolve();
    expect(r).toMatchObject({ profile: 'p2', usedFallback: true });
    await slots(['p1', null]);
    expect(await resolve()).toMatchObject({ profile: null, cause: 'down', waitUntil: later(1800_000) });
    expect((await resolve()).reason).toContain('model gone');
    await markProfileDown(t.db, 'p1', new Date(NOW.getTime() - 1).toISOString(), 'old');
    expect(await resolve()).toMatchObject({ profile: 'p1' });
  });

  it('a slot without primary → no_route; a missing profile → disabled, no wait time', async () => {
    await slots([null, null], ['p2', null]);
    expect(await resolve()).toMatchObject({ profile: null, cause: 'no_route', waitUntil: null, reason: '写作位置没有配置模型' });
    expect(await resolve({ slot: 'utility' })).toMatchObject({ profile: 'p2' });
    await slots(['gone', null]);
    expect(await resolve()).toMatchObject({ profile: null, cause: 'disabled', waitUntil: null });
  });

  it('slotStatus reports both slots', async () => {
    await slots(['p1', null], ['p2', null]);
    await sleep('acc2', later(600_000));
    const s = await slotStatus(t.db, NOW, {});
    expect(s.writer).toMatchObject({ slot: 'writer', profile: 'p1', usedFallback: false, reason: null });
    expect(s.utility).toMatchObject({ slot: 'utility', profile: null, waitUntil: later(600_000) });
    expect(s.utility.reason).toMatch(/^杂活位置无可用模型/);
  });

  it('saveSlots keeps migratedFrom / droppedProfiles; no row → DEFAULT_SLOTS', async () => {
    await t.db.delete(settings).where(eq(settings.key, 'routing.slots'));
    expect(await loadSlots(t.db)).toEqual({ schema: 'nv.slots/1', writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-flash-check', fallback: null }, droppedProfiles: [] });
    await t.db.insert(settings).values({ key: 'routing.slots', value: { schema: 'nv.slots/1', writer: { primary: 'p1', fallback: null }, utility: { primary: 'p2', fallback: null }, migratedFrom: 'mixed', droppedProfiles: ['grok-47'] } });
    const saved = await slots(['p2', 'p1'], ['p1', null]);
    expect(saved).toMatchObject({ migratedFrom: 'mixed', droppedProfiles: ['grok-47'], writer: { primary: 'p2', fallback: 'p1' } });
    expect(await loadSlots(t.db)).toEqual(saved);
  });
});

describe('PUT /api/admin/routing/slots and fake mode', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app.close();
  });
  async function login(): Promise<string> {
    const res = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
    return String(res.headers['set-cookie']).split(';')[0] as string;
  }

  it('refused (409 slots_forced) while the process runs in fake mode; a slot saved in fake mode is editable after a non-fake boot', async () => {
    const cookie = await login();
    const put = (payload: object) => app.app.inject({ method: 'PUT', url: '/api/admin/routing/slots', headers: { cookie }, payload });
    const body = { writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-flash-check', fallback: null } };
    (app.deps.config as { fakeHarness: boolean }).fakeHarness = true;
    const forced = await put(body);
    expect([forced.statusCode, forced.json().code]).toEqual([409, 'slots_forced']);
    const view = (await app.app.inject({ method: 'GET', url: '/api/admin/routing/slots', headers: { cookie } })).json();
    expect(view.forced).toBe(true);
    expect(view.status.writer.profile).toBe('fake');
    // 下一次不用 fake 模式启动：fake 模式写下的位置照常可改
    (app.deps.config as { fakeHarness: boolean }).fakeHarness = false;
    const ok = await put(body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ forced: false, slots: { writer: { primary: 'agy-argon' }, utility: { primary: 'agy-flash-check' } } });
  });
});
