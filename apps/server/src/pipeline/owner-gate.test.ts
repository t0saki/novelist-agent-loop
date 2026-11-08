/** hold/block 的 owner 放行与重写（真实 handler + fake harness）。Owner: lane E。 */
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { books, chapters, tasks } from '../db/schema.js';
import { createTestDb } from '../db/testing.js';
import { createEventBus } from '../orchestrator/bus.js';
import { actOnInbox, clearInboxFollowups, createInboxItem, pendingInboxFollowups } from '../orchestrator/inbox.js';
import { runDbEffect } from './effects.js';
import { createMiniBook, enqueueSpec, runUntilIdle, startBook, type MiniEnv } from './testing.js';

let env: MiniEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function deliverFollowups(e: MiniEnv): Promise<void> {
  for (const item of await pendingInboxFollowups(e.dbh.db)) {
    const ctx = await e.ctx();
    for (const f of item.followups) await enqueueSpec(e, f, ctx);
    await clearInboxFollowups(e.dbh.db, item.id);
  }
}

const bookRow = async (e: MiniEnv) => (await e.dbh.db.select().from(books).where(eq(books.id, e.bookId)))[0];
const chapterRow = async (e: MiniEnv, no: number) => (await e.dbh.db.select().from(chapters).where(eq(chapters.bookId, e.bookId))).find((r) => r.no === no);

describe('hold → owner 决定', () => {
  it('放行：held 章节继续抽取并最终验收（不再卡死）', async () => {
    // 第 1 章是关键章：craft_hard.key 默认 hold。写作稿偏短，修订耗尽后进 hold
    env = await createMiniBook({
      chapters: 1,
      scenario: (t) => (t.kind === 'chapter.write' || t.kind === 'chapter.expand' ? { draftChars: 1500 } : undefined),
    });
    await startBook(env);
    await runUntilIdle(env);
    expect((await chapterRow(env, 1))?.state).toBe('held');
    expect((await bookRow(env))?.acceptedThrough).toBe(0);
    const input = env.inbox.find((i) => i.kind === 'hold');
    expect(input).toBeTruthy();

    const bus = createEventBus();
    const item = await createInboxItem(env.dbh.db, bus, input as NonNullable<typeof input>);
    await actOnInbox(env.dbh.db, bus, item.id, 'approve');
    // 关单后状态已推进，writeLane 不会把章节重新当成 planned 派 chapter.write
    expect((await chapterRow(env, 1))?.state).not.toBe('held');
    expect((await env.dbh.db.select().from(tasks).where(eq(tasks.id, input!.relatedTaskId as string)))[0]?.state).toBe('done');
    await deliverFollowups(env);
    await runUntilIdle(env);
    expect((await bookRow(env))?.acceptedThrough).toBe(1);
    expect((await chapterRow(env, 1))?.state).toBe('accepted');
  }, 120_000);

  it('重写：新实例 chapter.write，笔记进入 params.ownerNotes', async () => {
    env = await createMiniBook({
      chapters: 1,
      scenario: (t, nth) => (t.kind === 'chapter.expand' || (t.kind === 'chapter.write' && nth === 1) ? { draftChars: 1500 } : undefined),
    });
    await startBook(env);
    await runUntilIdle(env);
    const input = env.inbox.find((i) => i.kind === 'hold') as NonNullable<MiniEnv['inbox'][number]>;
    const bus = createEventBus();
    const item = await createInboxItem(env.dbh.db, bus, input);
    await actOnInbox(env.dbh.db, bus, item.id, 'rewrite', '开头换个场景');
    expect((await env.dbh.db.select().from(tasks).where(eq(tasks.id, input.relatedTaskId as string)))[0]?.state).toBe('cancelled');
    await deliverFollowups(env);
    await runUntilIdle(env);
    const writes = await env.dbh.db.select().from(tasks).where(eq(tasks.kind, 'chapter.write'));
    expect(writes.some((w) => (w.params.ownerNotes as string[] | undefined)?.includes('开头换个场景'))).toBe(true);
    expect((await bookRow(env))?.acceptedThrough).toBe(1);
  }, 120_000);
});

describe('规划审批打回', () => {
  it('reject：重做同一 kind（新实例，笔记进 ownerNotes），不当作批准', async () => {
    env = await createMiniBook({ chapters: 1, config: { approvals: { compass: { required: true, on_timeout: 'wait' }, first_volume: { required: false, on_timeout: 'wait' }, failover: { required: false, on_timeout: 'wait' } } } as never });
    await startBook(env);
    await runUntilIdle(env);
    const input = env.inbox.find((i) => i.kind === 'approval') as NonNullable<MiniEnv['inbox'][number]>;
    expect(input.dedupeKey).toMatch(/^approval:compass/);
    const bus = createEventBus();
    const item = await createInboxItem(env.dbh.db, bus, input);
    await actOnInbox(env.dbh.db, bus, item.id, 'reject', '结局走向要改');
    env.openApprovals.delete(input.dedupeKey as string);
    await deliverFollowups(env);
    await runUntilIdle(env);
    const compass = await env.dbh.db.select().from(tasks).where(eq(tasks.kind, 'plan.compass'));
    expect(compass).toHaveLength(2);
    expect(compass.some((c) => (c.params.ownerNotes as string[] | undefined)?.includes('结局走向要改'))).toBe(true);
    expect(env.openApprovals.has(input.dedupeKey as string)).toBe(true); // 重做后再次进审批
  }, 120_000);
});

describe('重写已验收章节（真实 handler）', () => {
  it('chapter.repair → reextract：前沿不回退，字数等于各章之和，不重新走 accept', async () => {
    env = await createMiniBook({ chapters: 2 });
    await startBook(env);
    await runUntilIdle(env);
    const before = await bookRow(env);
    expect(before?.acceptedThrough).toBeGreaterThanOrEqual(1);
    const accepts = (await env.dbh.db.select().from(tasks).where(eq(tasks.kind, 'chapter.accept'))).length;
    await enqueueSpec(env, { kind: 'chapter.repair', bookId: env.bookId, target: 'c00001', lane: 'side', params: { instance: 'owner-1', conflicts: ['owner 要求重写本章'] } }, await env.ctx());
    await runUntilIdle(env);
    expect(env.log.some((l) => l.kind === 'chapter.reextract' && l.status === 'done')).toBe(true);
    const after = await bookRow(env);
    expect(after).toMatchObject({ acceptedThrough: before?.acceptedThrough, cursor: before?.cursor });
    expect((await env.dbh.db.select().from(tasks).where(eq(tasks.kind, 'chapter.accept'))).length).toBe(accepts);
    expect((await chapterRow(env, 1))?.state).toBe('accepted');
    const rows = await env.dbh.db.select().from(chapters).where(eq(chapters.bookId, env.bookId));
    expect(after?.totalCjk).toBe(rows.reduce((n, r) => n + r.cjk, 0));
  }, 180_000);
});

describe('audit.advance', () => {
  it('并发审计基于旧快照提交时进度不回退', async () => {
    const dbh = await createTestDb();
    try {
      await dbh.db.insert(books).values({ id: 'b', slug: 'b', title: 't', genre: 'g', status: 'active', meta: { audit: { window_through: 20, arc_through: 10 }, publish: { lastSlot: 'x' } } });
      // audit.arc 读到的快照 window_through=15：不能把窗口进度压回去
      await dbh.db.transaction((tx) => runDbEffect(tx, 'sha', { name: 'audit.advance', args: { bookId: 'b', nowIso: new Date().toISOString(), audit: { window_through: 15, arc_through: 25 } } }));
      const row = (await dbh.db.select().from(books))[0];
      expect(row?.meta).toMatchObject({ audit: { window_through: 20, arc_through: 25 }, publish: { lastSlot: 'x' } });
      expect(row?.auditedThrough).toBe(20);
    } finally {
      await dbh.close();
    }
  });
});

const onlyCompassGate = { approvals: { compass: { required: true, on_timeout: 'wait' }, first_volume: { required: false, on_timeout: 'wait' }, failover: { required: false, on_timeout: 'wait' } } } as never;
const kindsRun = (e: MiniEnv) => e.log.map((l) => l.kind);

describe('打回重做失败', () => {
  it('重做 failed/blocked 时不拿被打回的罗盘继续规划', async () => {
    env = await createMiniBook({
      chapters: 1,
      config: onlyCompassGate,
      scenario: (t, nth) => (t.kind === 'plan.compass' && nth >= 2 ? { content: { 'plan/compass.yaml': 'schema: nv.compass/1\nlogline: 123\n' } } : undefined),
    });
    await startBook(env);
    await runUntilIdle(env);
    const input = env.inbox.find((i) => i.kind === 'approval') as NonNullable<MiniEnv['inbox'][number]>;
    const bus = createEventBus();
    const item = await createInboxItem(env.dbh.db, bus, input);
    await actOnInbox(env.dbh.db, bus, item.id, 'reject', '结局走向要改');
    env.openApprovals.delete(input.dedupeKey as string);
    await deliverFollowups(env);
    await runUntilIdle(env);
    const compass = await env.dbh.db.select().from(tasks).where(eq(tasks.kind, 'plan.compass'));
    expect(compass.map((c) => c.state).sort()).toEqual(expect.arrayContaining(['done']));
    expect(compass.some((c) => c.state === 'failed' || c.state === 'blocked')).toBe(true);
    expect(kindsRun(env)).not.toContain('plan.bible');
  }, 120_000);
});

describe('开书访谈', () => {
  const interviewScenario = (t: { kind: string }) => (t.kind === 'plan.interview' ? { content: { 'interview.json': JSON.stringify({ questions: [{ id: 'q1', text: '主角多大？' }] }) } } : undefined);

  it('问题未回答前不开始 premise；回答后答案写进 premise 附录', async () => {
    env = await createMiniBook({ chapters: 1, config: onlyCompassGate, scenario: interviewScenario });
    await startBook(env, { interview: true });
    await runUntilIdle(env);
    expect(kindsRun(env)).toEqual(['plan.interview']);
    const input = env.inbox.find((i) => i.kind === 'question') as NonNullable<MiniEnv['inbox'][number]>;
    expect(input.dedupeKey).toMatch(/^interview:/);

    const bus = createEventBus();
    const item = await createInboxItem(env.dbh.db, bus, input);
    await actOnInbox(env.dbh.db, bus, item.id, 'answer', '主角十七岁');
    env.openApprovals.delete(input.dedupeKey as string);
    await deliverFollowups(env);
    await runUntilIdle(env);
    const premise = await env.dbh.db.select().from(tasks).where(eq(tasks.kind, 'plan.premise'));
    expect(premise).toHaveLength(1);
    expect(premise[0]?.params.ownerNotes).toEqual(['主角十七岁']);
    const ctx = await env.ctx();
    expect(await ctx.book?.files.premise()).toContain('主角十七岁');
  }, 120_000);

  it('跳过访谈也放行 premise', async () => {
    env = await createMiniBook({ chapters: 1, config: onlyCompassGate, scenario: interviewScenario });
    await startBook(env, { interview: true });
    await runUntilIdle(env);
    const input = env.inbox.find((i) => i.kind === 'question') as NonNullable<MiniEnv['inbox'][number]>;
    const bus = createEventBus();
    const item = await createInboxItem(env.dbh.db, bus, input);
    await actOnInbox(env.dbh.db, bus, item.id, 'skip');
    env.openApprovals.delete(input.dedupeKey as string);
    await runUntilIdle(env);
    expect(kindsRun(env)).toContain('plan.premise');
  }, 120_000);
});

describe('chapter.accept 的 DB 效果', () => {
  it('前沿单调不回退，字数按差值累计', async () => {
    const dbh = await createTestDb();
    try {
      await dbh.db.insert(books).values({ id: 'b', slug: 'b', title: 't', genre: 'g', status: 'active', acceptedThrough: 50, cursor: 51, totalCjk: 1000 });
      await dbh.db.insert(chapters).values({ bookId: 'b', no: 5, chapterId: 'c00005', state: 'accepted', cjk: 100 });
      await dbh.db.transaction((tx) => runDbEffect(tx, 'sha', { name: 'chapter.accept', args: { bookId: 'b', no: 5, cid: 'c00005', title: 't', volume: 'v01', arc: 'a0001', cjk: 120, nowIso: new Date().toISOString(), verdict: 'pass', revisions: 0, degraded: false, debts: 0, writerModel: null, isFinal: false, seq: 7 } }));
      expect((await dbh.db.select().from(books))[0]).toMatchObject({ acceptedThrough: 50, cursor: 51, totalCjk: 1020 });
      expect((await dbh.db.select().from(chapters))[0]?.workflow).toMatchObject({ seq: 7 });
    } finally {
      await dbh.close();
    }
  });
});
