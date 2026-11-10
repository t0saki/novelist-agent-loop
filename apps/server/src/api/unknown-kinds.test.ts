/**
 * 已删除的任务种类 / 角色 / 待办种类留在数据库里（P3 D4）：列表、详情、书页都照常 200，原样显示字符串；不会被复活或重新投递。
 */
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLegacyBook } from '../book/testing-legacy.js';
import { inbox, runs, tasks } from '../db/schema.js';
import { addV3Book } from '../flow/testing-book.js';
import { drainOutbox, execEnv } from '../orchestrator/index.js';
import type { OrchTestEnv } from '../orchestrator/testing.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';

let t: TestApp;
let cookie: string;
const admin = (method: 'GET' | 'POST', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  const legacy = await createLegacyBook(t.deps.db, t.deps.paths, 'old');
  const v3 = await addV3Book({ db: t.deps.db, paths: t.deps.paths } as unknown as OrchTestEnv, 'new', { chapters: 1 });
  await t.deps.db.insert(tasks).values([
    { id: 'ext', bookId: legacy.id, kind: 'chapter.extract', target: 'c00002', lane: 'side', role: 'extractor', state: 'blocked', waitReason: 'output_contract' },
    { id: 'arc', bookId: v3.id, kind: 'plan.arc', target: 'a0002', lane: 'side', state: 'done', params: { _orch: { outbox: true } }, result: { status: 'done', followups: [{ kind: 'chapter.write', bookId: v3.id, target: 'c00002', lane: 'write' }], inbox: [{ kind: 'approval', bookId: v3.id, title: '批准', body: {}, actions: [{ id: 'approve', label: '批准' }], dedupeKey: 'approval:x' }] } },
    { id: 'can', bookId: null, kind: 'harness.canary', target: 'fake@1:container', lane: 'system', state: 'failed' },
  ]);
  await t.deps.db.insert(runs).values({ id: 'old-run', taskId: 'ext', bookId: legacy.id, taskKind: 'chapter.write', attempt: 1, role: 'extractor', profileId: 'agy-flash-check', harness: 'agy', isolation: 'container', state: 'finalized', runDir: path.join(t.deps.paths.runs, '2026-01', 'old-run') });
  await t.deps.db.insert(inbox).values([
    { id: 'ib-a', kind: 'approval', bookId: legacy.id, title: '批准罗盘', dedupeKey: 'approval:compass:x', state: 'resolved' },
    { id: 'ib-c', kind: 'circuit', bookId: null, title: '熔断', dedupeKey: 'circuit:agy:1:container', state: 'open' },
  ]);
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('rows of removed kinds', () => {
  it('tasks, runs, run detail, inbox and books answer 200 with the raw strings', async () => {
    const all = await admin('GET', '/api/admin/tasks');
    expect(all.statusCode).toBe(200);
    expect((all.json().items as { kind: string }[]).map((x) => x.kind).sort()).toEqual(['chapter.extract', 'harness.canary', 'plan.arc']);
    const filtered = await admin('GET', '/api/admin/tasks?kind=chapter.extract');
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items).toMatchObject([{ id: 'ext', kind: 'chapter.extract', state: 'blocked', bookSlug: 'old' }]);
    const runList = await admin('GET', '/api/admin/runs');
    expect(runList.statusCode).toBe(200);
    expect(runList.json().items).toMatchObject([{ id: 'old-run', kind: 'chapter.write', role: 'extractor', bookSlug: 'old' }]);
    const run = await admin('GET', '/api/admin/runs/old-run');
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ kind: 'chapter.write', role: 'extractor', files: [] });
    const items = await admin('GET', '/api/admin/inbox');
    expect(items.statusCode).toBe(200);
    expect((items.json().items as { kind: string }[]).map((i) => i.kind).sort()).toEqual(['approval', 'circuit']);
    expect((await admin('GET', '/api/admin/books')).statusCode).toBe(200);
    for (const slug of ['old', 'new']) expect((await admin('GET', `/api/admin/books/${slug}`)).statusCode, slug).toBe(200);
  });

  it('retry of a task of a removed kind → 409 unknown_kind, the row stays as it was', async () => {
    const r = await admin('POST', '/api/admin/tasks/ext/retry');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('unknown_kind');
    expect((await t.deps.db.select().from(tasks).where(eq(tasks.id, 'ext')))[0]).toMatchObject({ state: 'blocked', kind: 'chapter.extract' });
  });

  it('drainOutbox on a done row of a removed kind only clears the flag: no followups enqueued, no inbox item created', async () => {
    const env = execEnv({ db: t.deps.db, config: t.deps.config, paths: t.deps.paths, log: t.deps.log, bus: t.deps.bus, secrets: t.deps.secrets, owner: `${os.hostname()}:${process.pid}` });
    expect(await drainOutbox(env, 'arc')).toBe(true);
    const row = (await t.deps.db.select().from(tasks).where(eq(tasks.id, 'arc')))[0];
    expect((row?.params._orch as { outbox?: unknown } | undefined)?.outbox).toBeUndefined();
    expect((await t.deps.db.select().from(tasks)).map((x) => x.id).sort()).toEqual(['arc', 'can', 'ext']);
    expect(await t.deps.db.select().from(inbox).where(eq(inbox.dedupeKey, 'approval:x'))).toEqual([]);
    expect(await drainOutbox(env, 'arc')).toBe(false);
  });
});
