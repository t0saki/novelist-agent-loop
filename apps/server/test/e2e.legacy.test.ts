/**
 * 旧书端到端（P3 WP-4，§7）：导入形态的旧书（createLegacyBook：已归档、12 章、发布到第 10 章、两卷）带着旧流程留下的东西开机——
 * 一条旧种类的 blocked 任务、一条审批待办——开机迁移把任务取消、待办关掉、卷标题回填；读者端按卷显示标题。
 * 主人接手 → fake harness 补笔记并写 3 章 → 主人把这本书改成立即发布 → 读者端列出第 1–15 章：
 * 发布顺序连续（先 11、12，再 13–15；新章没有卷，排在旧卷后面），没有一章被发布两次。
 *
 * 进程内（createTestApp：内存 PGlite、fake harness 目录模式）；“开机”= 直接调 runBootMigrations（serve 在 recover 之前跑的那一步）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../src/book/index.js';
import { createLegacyBook, legacyChapterText } from '../src/book/testing-legacy.js';
import { runBootMigrations } from '../src/boot/migrate-p3.js';
import { books, chapters, inbox, tasks } from '../src/db/schema.js';
import { readV3Meta } from '../src/flow/state.js';
import { createScheduler } from '../src/orchestrator/index.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../src/testing.js';

let t: TestApp;
let cookie = '';

afterEach(async () => {
  await t?.close();
});

const admin = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
const execDeps = () => ({ db: t.deps.db, config: t.deps.config, paths: t.deps.paths, log: t.deps.log, bus: t.deps.bus, secrets: t.deps.secrets, owner: `${os.hostname()}:${process.pid}` });
const publishedAt = async (bookId: string) => new Map((await t.deps.db.select({ no: chapters.no, at: chapters.publishedAt }).from(chapters).where(eq(chapters.bookId, bookId))).map((c) => [c.no, c.at]));
/** 导入书的章节早就入库了：入库时间挪到两天前（满 publish_after_hours） */
const ageChapters = (bookId: string) => t.deps.db.update(chapters).set({ acceptedAt: new Date(Date.now() - 48 * 3600_000).toISOString() }).where(eq(chapters.bookId, bookId));

interface ReaderDetail {
  volumes: { id: string; title: string; chapters: { no: number }[] }[];
}

describe('legacy book end to end: boot → read → take over → write → publish', () => {
  it('an imported, archived, partly published book is cleaned at boot, readable with volume titles, and continues after a takeover without re-publishing anything', async () => {
    t = await createTestApp();
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
    cookie = String(login.headers['set-cookie'] ?? '').split(';')[0] ?? '';

    const slug = 'old-e2e';
    const b = await createLegacyBook(t.deps.db, t.deps.paths, slug, {
      chapters: 12,
      published: 10,
      status: 'archived',
      volumes: [
        { id: 'v01', title: '第一卷 风起', from: 1, to: 6 },
        { id: 'v02', title: '第二卷 云涌', from: 7, to: 12 },
      ],
    });
    // 旧流程留下的：一条 blocked 的旧种类任务、一条打开的审批
    await t.deps.db.insert(tasks).values({ id: 'old-extract', bookId: b.id, kind: 'chapter.extract', target: 'c00012', lane: 'side', state: 'blocked' });
    await t.deps.db.insert(inbox).values({ id: 'old-approval', kind: 'approval', title: '审批卷纲', bookId: b.id, dedupeKey: `approval:${slug}:v03`, state: 'open' });
    expect((await rowOf(slug)).meta).not.toHaveProperty('v3');

    // ── 开机 ─────
    const report = await runBootMigrations(t.deps);
    expect(report.tasksCancelled).toBeGreaterThanOrEqual(1);
    const task = (await t.deps.db.select().from(tasks).where(eq(tasks.id, 'old-extract')))[0]!;
    expect(task).toMatchObject({ state: 'cancelled', waitReason: 'p3_legacy' });
    expect((await t.deps.db.select().from(inbox).where(eq(inbox.id, 'old-approval')))[0]?.state).toBe('resolved');
    // 开机迁移从不把旧书改成新流程
    expect((await rowOf(slug)).meta).not.toHaveProperty('v3');

    // ── 读者端：只列已发布的 1–10，按卷、带卷标题 ─────
    let rb = (await admin('GET', `/api/reader/books/${slug}`)).json() as ReaderDetail;
    expect(rb.volumes.map((v) => [v.id, v.title, v.chapters.map((c) => c.no)])).toEqual([
      ['v01', '第一卷 风起', [1, 2, 3, 4, 5, 6]],
      ['v02', '第二卷 云涌', [7, 8, 9, 10]],
    ]);
    expect((await admin('GET', `/api/reader/books/${slug}/chapters/11`)).statusCode).toBe(404);
    const before = await publishedAt(b.id);

    // ── 接手：之后的写作走新流程 ─────
    await ageChapters(b.id);
    await fs.mkdir(path.join(t.deps.paths.tmp, 'fake-v3'), { recursive: true });
    await fs.writeFile(path.join(t.deps.paths.tmp, 'fake-v3', `${slug}.json`), JSON.stringify([{}]));
    const res = await admin('POST', `/api/admin/books/${slug}/takeover`, { length: 'medium', target_cjk: 60_000, batch: 3, min_chapter_cjk: 500, start: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(readV3Meta((await rowOf(slug)).meta).takeover?.status).toBe('pending');
    // 主人把这本书改成立即发布（书页的设置）
    const view = (await admin('GET', `/api/admin/books/${slug}/v3`)).json() as { settings: Record<string, unknown> & { publish: Record<string, unknown> } };
    const put = await admin('PUT', `/api/admin/books/${slug}/v3/settings`, { ...view.settings, publish: { ...view.settings.publish, mode: 'immediate' } });
    expect(put.statusCode, put.body).toBe(200);

    // ── 一批：补笔记 + 第 13–15 章；之后的批先取消，只看发布 ─────
    for (let i = 0; i < 6 && (await rowOf(slug)).acceptedThrough < 15; i += 1) await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
    const row = await rowOf(slug);
    expect(row.acceptedThrough).toBe(15);
    expect(readV3Meta(row.meta).takeover?.status).toBe('done');
    for (const x of await t.deps.db.select().from(tasks).where(eq(tasks.bookId, b.id))) if (x.kind !== 'publish') await t.deps.orchestrator.cancelTask(x.id).catch(() => {});
    const repo = openRepo(b.dir);
    for (let no = 1; no <= 12; no += 1) expect(await repo.readFile(`manuscript/c${String(no).padStart(5, '0')}.md`), String(no)).toBe(legacyChapterText(no));
    for (const p of ['bible.md', 'outline.md', 'notes/progress.md']) expect(await repo.exists(p), p).toBe(true);

    // ── 发布：新章入库满时限后，按顺序发到第 15 章 ─────
    await ageChapters(b.id);
    await createScheduler(execDeps()).runUntilIdle({ maxTicks: 5 });
    expect((await rowOf(slug)).publishedThrough).toBe(15);
    const after = await publishedAt(b.id);
    expect([...after.entries()].filter(([, at]) => at !== null).map(([no]) => no).sort((x, y) => x - y)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    // 1–10 没有被重新发布（发布时间不变）；11、12 不晚于新章
    for (let no = 1; no <= 10; no += 1) expect(after.get(no), String(no)).toBe(before.get(no));
    const ts = (no: number) => Date.parse(after.get(no) as string);
    expect(Math.max(ts(11), ts(12))).toBeLessThanOrEqual(Math.min(ts(13), ts(14), ts(15)));

    // ── 读者端：第 1–15 章，新章没有卷、排在旧卷后面 ─────
    rb = (await admin('GET', `/api/reader/books/${slug}`)).json() as ReaderDetail;
    expect(rb.volumes.map((v) => [v.id, v.title, v.chapters.map((c) => c.no)])).toEqual([
      ['v01', '第一卷 风起', [1, 2, 3, 4, 5, 6]],
      ['v02', '第二卷 云涌', [7, 8, 9, 10, 11, 12]],
      ['', '', [13, 14, 15]],
    ]);
    const listed = rb.volumes.flatMap((v) => v.chapters.map((c) => c.no));
    expect(new Set(listed).size).toBe(listed.length);
    for (const no of [11, 13, 15]) expect((await admin('GET', `/api/reader/books/${slug}/chapters/${no}`)).statusCode, String(no)).toBe(200);
  }, 240_000);
});
