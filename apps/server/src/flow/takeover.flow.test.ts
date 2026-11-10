/**
 * 接手旧书之后的写作（P3 WP-3，D16）：调度器 + fake harness 目录模式（createTestApp，进程内）。
 * 第一次写作是接手任务单（先读最后三章和旧资料、补笔记，再续写），有新章入库后改回普通写作任务单；
 * 旧章从不被改写；发布从已发布的下一章接着来，旧的 require_audited / lag 不再卡住。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepo, type BookRepo } from '../book/index.js';
import { createLegacyBook, legacyChapterText } from '../book/testing-legacy.js';
import { books, chapters, runs, tasks } from '../db/schema.js';
import { createScheduler } from '../orchestrator/index.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';
import { renderOrder } from './order.js';
import { readV3Meta } from './state.js';
import type { OrderSpec } from './types.js';

let t: TestApp;
let cookie = '';

afterEach(async () => {
  await t?.close();
});

async function boot(): Promise<void> {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}

const admin = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
const execDeps = () => ({ db: t.deps.db, config: t.deps.config, paths: t.deps.paths, log: t.deps.log, bus: t.deps.bus, secrets: t.deps.secrets, owner: `${os.hostname()}:${process.pid}` });

async function scenarios(slug: string, list: unknown[]): Promise<void> {
  const dir = path.join(t.deps.paths.tmp, 'fake-v3');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(list));
}

/** 跑一批：等待中的任务立刻可执行，再走一个 tick；返回这次 run 的 order.json 和按它渲染的任务单（快照收完稿就删了） */
async function step(slug: string): Promise<{ md: string; order: OrderSpec }> {
  const row = await rowOf(slug);
  await t.deps.db.update(books).set({ updatedAt: new Date().toISOString() }).where(eq(books.id, row.id));
  for (const x of await t.deps.db.select().from(tasks).where(eq(tasks.bookId, row.id))) {
    if (x.state === 'waiting') await t.deps.db.update(tasks).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, x.id));
  }
  const before = new Set((await t.deps.db.select({ id: runs.id }).from(runs).where(eq(runs.bookId, row.id))).map((r) => r.id));
  await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
  const run = (await t.deps.db.select().from(runs).where(eq(runs.bookId, row.id))).find((r) => !before.has(r.id));
  if (!run) throw new Error('no run');
  const order = JSON.parse(await fs.readFile(path.join(run.runDir, 'in', 'order.json'), 'utf8')) as OrderSpec;
  const md = await renderOrder(order, { library: '', mustRead: (order.takeover?.legacyFiles ?? []).map((p) => `- ${p}`).join('\n'), budgets: '', ownerNote: false });
  return { md, order };
}

/** 把旧章的入库时间挪到两天前（生产里导入书的章节早就入库了：满 publish_after_hours，可以发布） */
async function ageChapters(bookId: string): Promise<void> {
  await t.deps.db.update(chapters).set({ acceptedAt: new Date(Date.now() - 48 * 3600_000).toISOString() }).where(eq(chapters.bookId, bookId));
}

const publishedNos = async (bookId: string) => (await t.deps.db.select({ no: chapters.no, at: chapters.publishedAt }).from(chapters).where(eq(chapters.bookId, bookId))).filter((c) => c.at !== null).map((c) => c.no).sort((a, b) => a - b);

describe('a taken-over legacy book writes on (scheduler + fake harness)', () => {
  it('first order = takeover (last three chapters, legacy files); a run without chapters keeps it pending; once chapters land: takeover done, next order is the normal write; old chapters never rewritten', async () => {
    await boot();
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'tf', { chapters: 6, published: 6, volumes: [{ id: 'v01', title: '第一卷', from: 1, to: 6 }] });
    const repo: BookRepo = openRepo(b.dir);
    const res = await admin('POST', '/api/admin/books/tf/takeover', { length: 'medium', target_cjk: 60_000, batch: 2, min_chapter_cjk: 500, start: true });
    expect(res.statusCode, res.body).toBe(200);

    // 1. 只补了笔记、没有正文：接手还没做完，下一张还是接手任务单
    await scenarios('tf', [{ v3: { chapters: 0 } }, { v3: { chapters: 2 } }, {}]);
    let r = await step('tf');
    expect(r.order).toMatchObject({ kind: 'book.write', from: 7, count: 2, takeover: { lastChapters: [4, 5, 6] } });
    expect(r.md).toMatch(/^任务：接手这本书，然后新写第 7–8 章（共 2 章）$/m);
    expect(r.md).toContain('读最后三章：manuscript/c00004.md、manuscript/c00005.md、manuscript/c00006.md。');
    expect(r.order.takeover?.legacyFiles).toEqual(expect.arrayContaining(['bible/premise.md', 'notes/v1/bible.json', 'plan/volumes/v01.yaml']));
    expect((await rowOf('tf')).acceptedThrough).toBe(6);
    expect(readV3Meta((await rowOf('tf')).meta).takeover?.status).toBe('pending');

    // 2. 两章入库：接手做完；作者建了自己的笔记；旧章原样
    r = await step('tf');
    expect(r.order.takeover).toBeDefined();
    let row = await rowOf('tf');
    expect(row.acceptedThrough).toBe(8);
    expect(readV3Meta(row.meta).takeover?.status).toBe('done');
    for (const p of ['bible.md', 'outline.md', 'notes/cast.md', 'notes/threads.md', 'notes/progress.md', 'notes/chapters.md']) expect(await repo.exists(p), p).toBe(true);
    for (let no = 1; no <= 6; no += 1) expect(await repo.readFile(`manuscript/c0000${no}.md`)).toBe(legacyChapterText(no));
    // 旧的东西都还在：根 AGENTS.md、bible/、plan/、notes/v1/
    for (const p of ['AGENTS.md', 'bible/premise.md', 'plan/volumes/v01.yaml', 'notes/v1/bible.json']) expect(await repo.exists(p), p).toBe(true);

    // 3. 之后是普通的写作任务单
    r = await step('tf');
    expect(r.order.takeover).toBeUndefined();
    expect(r.md).toMatch(/^任务：新写第 9–10 章/m);
    row = await rowOf('tf');
    expect(row.acceptedThrough).toBe(10);
    // 新章没有卷：读者端排在旧卷后面
    const rb = (await admin('GET', '/api/reader/books/tf')).json() as { volumes: { id: string; title: string; chapters: { no: number }[] }[] };
    expect(rb.volumes[0]).toMatchObject({ id: 'v01', title: '第一卷' });
  }, 180_000);

  it('a legacy book with no chapters: the first order is a takeover order for book.open (the old premise / notes, no new direction, no library); once chapters land the takeover is done', async () => {
    await boot();
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'tf-zero', { chapters: 0, files: { 'notes/v1/outline.json': '{ "大纲": ["林枫下山"] }\n' } });
    expect((await admin('POST', '/api/admin/books/tf-zero/takeover', { length: 'medium', target_cjk: 60_000, batch: 2, min_chapter_cjk: 500, start: true })).statusCode).toBe(200);
    await scenarios('tf-zero', [{}]);
    const r = await step('tf-zero');
    expect(r.order).toMatchObject({ kind: 'book.open', from: 1, takeover: { lastChapters: [] } });
    expect(r.order.takeover?.legacyFiles).toEqual(expect.arrayContaining(['bible/premise.md', 'notes/v1/bible.json', 'notes/v1/outline.json']));
    expect(r.md).toMatch(/^任务：接手这本书，然后新写第 1–2 章（共 2 章）$/m);
    expect(r.md).toContain('沿用其中的书名、设定和方向');
    expect(r.md).not.toContain('最不像');
    expect(r.md).not.toContain('seed.md');
    const row = await rowOf('tf-zero');
    expect(row.acceptedThrough).toBe(2);
    expect(readV3Meta(row.meta).takeover?.status).toBe('done');
    expect(await openRepo(b.dir).exists('bible/premise.md')).toBe(true);
  }, 120_000);

  it('a short takeover: the first batch is the finale (write to the end, end marker) and the book completes', async () => {
    await boot();
    await createLegacyBook(t.deps.db, t.deps.paths, 'tf-short', { chapters: 4, published: 4 });
    expect((await admin('POST', '/api/admin/books/tf-short/takeover', { length: 'short', target_cjk: 2000, batch: 2, min_chapter_cjk: 500, start: true })).statusCode).toBe(200);
    await scenarios('tf-short', [{}]);
    const r = await step('tf-short');
    expect(r.order).toMatchObject({ kind: 'book.write', mode: 'finale', from: 5, takeover: { lastChapters: [2, 3, 4] } });
    expect(r.md).toMatch(/^任务：接手这本书，然后从第 5 章写到全书结束（计划还剩约 2 章，章数不限）$/m);
    expect(r.md).toContain('在末尾单独一行写"（全书完）"');
    const row = await rowOf('tf-short');
    expect(row.acceptedThrough).toBe(6);
    expect(row.status).toBe('completed');
    expect(readV3Meta(row.meta).takeover?.status).toBe('done');
  }, 120_000);

  it('the author touches an old chapter during the takeover run → the old text stays, the rewrite goes to drafts/', async () => {
    await boot();
    const b = await createLegacyBook(t.deps.db, t.deps.paths, 'tf-touch', { chapters: 5, published: 0 });
    expect((await admin('POST', '/api/admin/books/tf-touch/takeover', { length: 'medium', target_cjk: 60_000, batch: 2, min_chapter_cjk: 500, start: true })).statusCode).toBe(200);
    await scenarios('tf-touch', [{ v3: { rewriteAccepted: 3 } }]);
    await step('tf-touch');
    const repo = openRepo(b.dir);
    expect(await repo.readFile('manuscript/c00003.md')).toBe(legacyChapterText(3));
    expect(await repo.exists('drafts/c00003.rewrite.md')).toBe(true);
    expect((await rowOf('tf-touch')).acceptedThrough).toBe(7);
  }, 120_000);

  it('publishing: a fully published book (12 of 12) publishes the new chapters and never re-publishes 1–12; a partly published one (10 of 12) publishes 11, 12, then the new ones, in order', async () => {
    await boot();
    // 新流程的立即发布（系统页的默认发布节奏，接手时写进 book.yaml）
    const cur = (await admin('GET', '/api/admin/settings')).json();
    expect((await admin('PUT', '/api/admin/settings', { baseUpdatedAt: cur.updatedAt, v3: { publishDefaults: { mode: 'immediate' } } })).statusCode).toBe(200);

    // 旧书带着旧流程的发布设置（要审计、滞后 30 章）：接手时换掉
    const full = await createLegacyBook(t.deps.db, t.deps.paths, 'tf-full', { chapters: 12, published: 12, bookYamlExtra: 'publish:\n  require_audited: true\n  lag: 30\n' });
    const part = await createLegacyBook(t.deps.db, t.deps.paths, 'tf-part', { chapters: 12, published: 10, bookYamlExtra: 'publish:\n  require_audited: true\n  lag: 30\n' });
    for (const b of [full, part]) await ageChapters(b.id);
    const pubBefore = new Map((await t.deps.db.select({ no: chapters.no, at: chapters.publishedAt }).from(chapters).where(eq(chapters.bookId, full.id))).map((c) => [c.no, c.at]));
    for (const slug of ['tf-full', 'tf-part']) {
      await scenarios(slug, [{}]);
      expect((await admin('POST', '/api/admin/books/' + slug + '/takeover', { length: 'long', target_cjk: 200_000, batch: 2, min_chapter_cjk: 500, start: true })).statusCode).toBe(200);
    }

    // 各写一批（13–14）；之后的批先取消（下一次提议在 10 分钟后），只看发布
    const done = new Set<string>();
    for (let i = 0; i < 6 && done.size < 2; i += 1) {
      await t.deps.orchestrator.runUntilIdle({ maxTicks: 1 });
      for (const b of [full, part]) {
        if ((await t.deps.db.select().from(books).where(eq(books.id, b.id)))[0]!.acceptedThrough < 14) continue;
        done.add(b.id);
        for (const x of await t.deps.db.select().from(tasks).where(eq(tasks.bookId, b.id))) if (x.kind !== 'publish') await t.deps.orchestrator.cancelTask(x.id);
      }
    }
    expect(done.size).toBe(2);
    // 部分发布的那本：11、12 在新章之前就发了（旧的 lag / require_audited 不再卡）
    expect((await publishedNos(part.id)).slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // 新章入库满时限后发布
    for (const b of [full, part]) await ageChapters(b.id);
    await createScheduler(execDeps()).runUntilIdle({ maxTicks: 5 });
    for (const b of [full, part]) {
      expect(await publishedNos(b.id)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
      expect((await t.deps.db.select().from(books).where(eq(books.id, b.id)))[0]!.publishedThrough).toBe(14);
      expect((await t.deps.db.select().from(books).where(eq(books.id, b.id)))[0]!.acceptedThrough).toBe(14);
    }
    // 1–12 没有被重新发布（发布时间不变）
    for (const c of await t.deps.db.select({ no: chapters.no, at: chapters.publishedAt }).from(chapters).where(eq(chapters.bookId, full.id))) if (c.no <= 12) expect(c.at, String(c.no)).toBe(pubBefore.get(c.no));
    // 按顺序：11、12 不晚于 13、14
    const at = new Map((await t.deps.db.select({ no: chapters.no, at: chapters.publishedAt }).from(chapters).where(eq(chapters.bookId, part.id))).map((c) => [c.no, Date.parse(c.at as string)]));
    expect(Math.max(at.get(11)!, at.get(12)!)).toBeLessThanOrEqual(Math.min(at.get(13)!, at.get(14)!));
    for (const no of [11, 12, 13, 14]) expect((await admin('GET', '/api/reader/books/tf-part/chapters/' + no)).statusCode, String(no)).toBe(200);
  }, 240_000);
});
