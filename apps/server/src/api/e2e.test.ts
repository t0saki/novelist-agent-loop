import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { tasks } from '../db/schema.js';
import { TEST_ADMIN_PASSWORD, createTestApp, type TestApp } from '../testing.js';

/** 接线冒烟：真实 pipeline + fake harness 经 API 开书，跑到第一个审批门。完整三章 e2e 见集成步骤。 */
describe('book pipeline via API', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
    cookie = String(res.headers['set-cookie']).split(';')[0] as string;
  });

  afterAll(async () => {
    await t.close();
  });

  it('starts planning through the fake harness and stops at the compass approval', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/admin/books', headers: { cookie }, payload: { title: '管线之书', slug: 'wired', genre: 'xianxia', seed: '种子', start: true } });
    expect(created.statusCode).toBe(201);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });

    const tasks = (await t.app.inject({ url: '/api/admin/tasks?book=wired&limit=50', headers: { cookie } })).json();
    const states = tasks.items.map((x: { kind: string; state: string }) => `${x.kind}:${x.state}`);
    expect(states.filter((s: string) => s.endsWith(':failed'))).toEqual([]);

    const runs = (await t.app.inject({ url: '/api/admin/runs?book=wired', headers: { cookie } })).json();
    expect(runs.items.length).toBeGreaterThan(0);
    expect(runs.items[0].harness).toBe('fake');
    expect(runs.items[0].createdAt ?? runs.items[0].startedAt).toMatch(/T.*Z$/);
    const detail = (await t.app.inject({ url: `/api/admin/runs/${runs.items[0].id}`, headers: { cookie } })).json();
    expect(detail.files.some((f: { path: string; area: string }) => f.area === 'in' && f.path === 'workorder.md')).toBe(true);
    expect(detail.argvPreview.length).toBeGreaterThan(0);

    const inbox = (await t.app.inject({ url: '/api/admin/inbox?state=open&book=wired', headers: { cookie } })).json();
    expect(inbox.items.map((i: { kind: string }) => i.kind)).toContain('approval');
    const compass = await t.app.inject({ url: '/api/admin/books/wired/file?path=plan/compass.yaml', headers: { cookie } });
    expect(compass.statusCode).toBe(200);
  }, 120_000);

  it('向导先建书再 start：actions.start 的 interview 开关真正入队 plan.interview', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/admin/books', headers: { cookie }, payload: { title: '访谈之书', slug: 'interviewed', genre: 'xianxia', seed: '种子', start: false, interview: true } });
    expect(created.statusCode).toBe(201);
    const started = await t.app.inject({ method: 'POST', url: '/api/admin/books/interviewed/actions', headers: { cookie }, payload: { action: 'start', interview: true } });
    expect(started.statusCode).toBe(200);
    const rows = await t.deps.db.select().from(tasks).where(eq(tasks.kind, 'plan.interview'));
    expect(rows.map((r) => r.target)).toEqual(['book']);
    await t.deps.orchestrator.bookAction(rows[0]?.bookId as string, { action: 'pause', confirm: false });
    for (const r of rows) await t.deps.orchestrator.cancelTask(r.id);
  });

  it('打回罗盘：经 API 重跑 plan.compass，笔记进任务参数，不算批准，后续规划不启动', async () => {
    const open = (await t.app.inject({ url: '/api/admin/inbox?state=open&book=wired', headers: { cookie } })).json();
    const approval = open.items.find((i: { kind: string }) => i.kind === 'approval');
    const acted = await t.app.inject({ method: 'POST', url: `/api/admin/inbox/${approval.id}/act`, headers: { cookie }, payload: { action: 'reject', note: '结局走向要改' } });
    expect(acted.statusCode).toBe(200);
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });

    const compassTasks = await t.deps.db.select().from(tasks).where(eq(tasks.kind, 'plan.compass'));
    expect(compassTasks).toHaveLength(2);
    expect(compassTasks.every((c) => c.state === 'done')).toBe(true);
    expect(compassTasks.some((c) => (c.params.ownerNotes as string[] | undefined)?.includes('结局走向要改'))).toBe(true);
    expect(await t.deps.db.select().from(tasks).where(eq(tasks.kind, 'plan.bible'))).toHaveLength(0);

    const plan = await t.app.inject({ url: '/api/admin/books/wired/plan', headers: { cookie } });
    expect(plan.json().compassApproved).toBe(false);
    const again = (await t.app.inject({ url: '/api/admin/inbox?state=open&book=wired', headers: { cookie } })).json();
    const second = again.items.find((i: { kind: string }) => i.kind === 'approval');
    expect(second.id).not.toBe(approval.id);

    await t.app.inject({ method: 'POST', url: `/api/admin/inbox/${second.id}/act`, headers: { cookie }, payload: { action: 'approve' } });
    await t.deps.orchestrator.runUntilIdle({ maxTicks: 30 });
    expect((await t.app.inject({ url: '/api/admin/books/wired/plan', headers: { cookie } })).json().compassApproved).toBe(true);
    expect((await t.deps.db.select().from(tasks).where(eq(tasks.kind, 'plan.bible'))).length).toBeGreaterThan(0);
  }, 180_000);
});
