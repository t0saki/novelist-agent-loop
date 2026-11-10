/**
 * 回滚兼容（P3 §1.1、D22）：上一版镜像必须还能在新镜像迁移过的数据库和数据目录上启动。
 * (1) 数据库：新镜像跑过 0000 + 0001；只认 0000 的迁移器（上一版的 journal）什么都不做；旧的列照样能读、不带 volume_title 的插入照样成功。
 * (2) 配置：上一版的 zSystemSettings / zBookConfig（fixtures/prev-image/，从 db19762 原样复制）能解析新镜像写的 settings 行和新书的 book.yaml。
 * (3) 运行：新镜像写的 session.json 满足上一版的读取面（contract、compiled、reservationIds、artifacts、spec.contract）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { MIGRATIONS_DIR, migrate, openDb, type DbHandle } from '../src/db/client.js';
import { books, chapters, runs, settings, tasks } from '../src/db/schema.js';
import { addV3Book } from '../src/flow/testing-book.js';
import { bookOpen, bookRetro, bookWrite, nextTasksV3 } from '../src/flow/handlers.js';
import { createScheduler, loadSystemSettings } from '../src/orchestrator/index.js';
import { createOrchTestEnv, type OrchTestEnv } from '../src/orchestrator/testing.js';
import type { BookHandle } from '../src/runtime/types.js';
import { createBook } from '../src/services/books.js';
import { putSettings } from '../src/services/settings.js';
import { takeOverBook } from '../src/services/takeover.js';
import { saveV3Settings, v3BookView } from '../src/services/v3-view.js';
import { createLegacyBook } from '../src/book/testing-legacy.js';
import { createTestApp, type TestApp } from '../src/testing.js';
import { zBookConfig as zPrevBookConfig } from './fixtures/prev-image/schemas/book.js';
import { zSystemSettings as zPrevSystemSettings } from './fixtures/prev-image/config/settings.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

describe('previous image vs. the migrated database', () => {
  it("the old migrator (journal with 0000 only) is a no-op; old column set reads, inserts without volume_title succeed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-prev-'));
    const h: DbHandle = await openDb({ url: null, pgliteDir: path.join(dir, 'pg') });
    cleanup.push(async () => {
      await h.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    await migrate(h);
    const cols = (await h.db.execute(sql`select column_name from information_schema.columns where table_name = 'chapters' and column_name = 'volume_title'`)) as unknown as { rows: unknown[] };
    expect(cols.rows).toHaveLength(1);

    // 上一版镜像的迁移目录：只有 0000
    const prev = path.join(dir, 'prev-migrations');
    await fs.mkdir(path.join(prev, 'meta'), { recursive: true });
    const journal = JSON.parse(await fs.readFile(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toEqual(['0000_init', '0001_volume_title']);
    await fs.writeFile(path.join(prev, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
    await fs.copyFile(path.join(MIGRATIONS_DIR, '0000_init.sql'), path.join(prev, '0000_init.sql'));
    await fs.copyFile(path.join(MIGRATIONS_DIR, 'meta', '0000_snapshot.json'), path.join(prev, 'meta', '0000_snapshot.json'));
    const { migrate: m } = await import('drizzle-orm/pglite/migrator');
    await expect(m(h.db as never, { migrationsFolder: prev })).resolves.toBeUndefined();

    // 上一版的写法：插入时不知道 volume_title；读的时候只选旧列
    await h.db.insert(books).values({ id: 'b', slug: 'b', title: 'b', genre: 'g' });
    await h.db.execute(sql`insert into chapters (book_id, no, chapter_id, title, volume) values ('b', 1, 'c00001', '第1章', 'v01')`);
    const old = (await h.db.execute(sql`select book_id, no, chapter_id, title, volume, arc, state, cjk, published_at from chapters`)) as unknown as { rows: { volume: string }[] };
    expect(old.rows).toEqual([expect.objectContaining({ volume: 'v01' })]);
    expect((await h.db.select().from(chapters).where(eq(chapters.bookId, 'b')))[0]?.volumeTitle).toBe('');
  });
});

describe('previous image vs. settings and book.yaml written by the new image', () => {
  let t: TestApp;
  afterEach(async () => {
    await t?.close();
  });

  it('the old zSystemSettings parses the system row; the old zBookConfig parses a new book.yaml', async () => {
    t = await createTestApp();
    // 新镜像写一次 settings（全局暂停 / 恢复走的就是这条路）
    await t.deps.orchestrator.pauseAll();
    await t.deps.orchestrator.resumeAll();
    const row = (await t.deps.db.select().from(settings).where(eq(settings.key, 'system')))[0];
    const prev = zPrevSystemSettings.safeParse(row?.value);
    expect(prev.success, JSON.stringify(prev.error?.issues)).toBe(true);
    expect(prev.data?.autoStart.enabled).toBe(false);
    expect((await loadSystemSettings(t.deps.db)).autoStart.enabled).toBe(false);

    const b = await createBook(t.deps, { title: '新书', slug: 'compat', genre: 'xianxia', seed: '种子', start: false });
    const raw = await fs.readFile(path.join(t.deps.paths.books, b.slug, 'book.yaml'), 'utf8');
    const cfg = zPrevBookConfig.safeParse(yamlParse(raw));
    expect(cfg.success, JSON.stringify(cfg.error?.issues)).toBe(true);
    expect(cfg.data?.flow).toBe('v3');
  }, 60_000);

  it('WP-3: the settings row with v3.effortDefaults / publishDefaults, a book.yaml with v3.effort.closing and routing.writer_profile, and a taken-over book.yaml all parse with the old schemas', async () => {
    t = await createTestApp();
    await putSettings(t.deps, { v3: { effortDefaults: { closing: 'medium', write: 'high' }, publishDefaults: { per_slot: 3, max_buffer: 18 } } });
    const row = (await t.deps.db.select().from(settings).where(eq(settings.key, 'system')))[0];
    expect((row?.value as { v3: { effortDefaults: { closing: string } } }).v3.effortDefaults.closing).toBe('medium');
    const prev = zPrevSystemSettings.safeParse(row?.value);
    expect(prev.success, JSON.stringify(prev.error?.issues)).toBe(true);
    expect(prev.data?.autoStart.enabled).toBe(false);
    expect(prev.data?.v3.runawayFactor).toBe(2);

    // 新书：effort 带 closing（全站默认值），书页再设一个写作模型覆盖
    const b = await createBook(t.deps, { title: '新书二', slug: 'compat2', genre: 'xianxia', length: 'medium', start: false });
    const bookRow = (await t.deps.db.select().from(books).where(eq(books.slug, b.slug)))[0]!;
    const s = (await v3BookView(t.deps, bookRow)).settings;
    await saveV3Settings(t.deps, bookRow, { ...s, effort: { ...s.effort, closing: 'low' }, writer_profile: 'fake', budgets: { priority: 2, monthly_usd_cap: 10, max_window_util_pct: null } });
    const raw = await fs.readFile(path.join(t.deps.paths.books, b.slug, 'book.yaml'), 'utf8');
    const doc = yamlParse(raw) as { v3: { effort: Record<string, string> }; routing: Record<string, string> };
    expect(doc.v3.effort.closing).toBe('low');
    expect(doc.routing.writer_profile).toBe('fake');
    const cfg = zPrevBookConfig.safeParse(doc);
    expect(cfg.success, JSON.stringify(cfg.error?.issues)).toBe(true);
    expect(cfg.data?.flow).toBe('v3');
    expect(cfg.data?.v3.effort).toMatchObject({ write: 'high', finale: 'high' });

    // 接手过的旧书
    await createLegacyBook(t.deps.db, t.deps.paths, 'compat-legacy', { chapters: 3 });
    const legacyRow = (await t.deps.db.select().from(books).where(eq(books.slug, 'compat-legacy')))[0]!;
    await takeOverBook(t.deps, legacyRow, { length: 'medium', target_cjk: 80_000, start: false });
    const taken = yamlParse(await fs.readFile(path.join(t.deps.paths.books, 'compat-legacy', 'book.yaml'), 'utf8'));
    const tc = zPrevBookConfig.safeParse(taken);
    expect(tc.success, JSON.stringify(tc.error?.issues)).toBe(true);
    expect(tc.data?.flow).toBe('v3');
    expect(tc.data?.publish).toMatchObject({ require_audited: false, lag: 0 });
  }, 60_000);
});

describe('previous image vs. a session.json written by the new image', () => {
  let t: OrchTestEnv;
  afterEach(async () => {
    await t?.close();
  });

  it('keeps every field the previous image reads when it reattaches or finishes a run', async () => {
    t = await createOrchTestEnv({
      pipeline: {
        handlers: { 'book.open': bookOpen, 'book.write': bookWrite, 'book.retro': bookRetro },
        next: async (ctx) => {
          const book = ctx.book as BookHandle;
          const row = (await ctx.deps.db.select().from(books).where(eq(books.id, book.id)))[0];
          return row ? nextTasksV3(ctx, book, row) : [];
        },
      },
    });
    const b = await addV3Book(t, 'sess', { chapters: 1, batch: 2 });
    const sched = createScheduler(t.deps);
    await sched.runUntilIdle({ maxTicks: 30 });
    await sched.stop();
    const run = (await t.db.select().from(runs).where(eq(runs.bookId, b.id)))[0];
    expect(run).toBeTruthy();
    const session = JSON.parse(await fs.readFile(path.join(run?.runDir as string, 'in', 'session.json'), 'utf8')) as Record<string, unknown> & { spec: Record<string, unknown>; compiled: Record<string, unknown> };
    expect(session.schema).toBe('nv.session/1');
    expect(session.contract).toBe('v3');
    expect(session.spec.contract).toBe('v3');
    expect(typeof session.compiled.stackHash).toBe('string');
    expect(session.compiled.nonces).toEqual({});
    expect(session.reservationIds).toEqual([]);
    expect(session.artifacts).toEqual([]);
    expect(typeof session.trailerKey).toBe('string');
    for (const k of ['systemFile', 'receiptSchemaFile', 'workOrderFile']) expect(typeof session.spec[k], k).toBe('string');
    expect((await t.db.select().from(tasks).where(eq(tasks.bookId, b.id)))[0]?.rebaseValidators).toEqual([]);
  }, 120_000);
});
