/**
 * P3 开机迁移（p3-plan §5）：只在 serve 的编排进程里跑（bootstrap 的 bootMigrate），在数据库迁移、种子之后、恢复之前。
 * 每一步都可重复执行；不删行、不删文件、不删设置；不碰 autoStart；runBootMigrations 没有任何 git 写入。
 *  M1 classifyBooks     每次：按数据库判定 v3 / 旧书，对照 book.yaml 的 flow 出报告；只给“文件说 v3、库里丢了 meta、还没有章节”的书补 meta.v3
 *  M2 cancelLegacyTasks 每次：已删除的旧种类、旧书的活任务一律取消（wait_reason p3_legacy），清掉 outbox 标记，还在跑的 run 写 kill 文件
 *  M3a closeRemovedInbox 每次：旧书的待办、已删除种类的待办自动关闭
 *  M3b closeLegacyInbox 一次：dedupe key 不属于 v3 任何前缀的待办自动关闭
 *  M4  routingSlots     一次（没有 routing.slots 行时）：旧 preset → 写作 / 杂活两个位置；旧行不动
 *  M5 volumeTitles      每次、按书直到做完：旧书的卷标题回填到 chapters.volume_title（仓库出错的书下次再试）
 *  M6 report            每次：报告写进 settings['migration.p3'].report 并记日志
 * M4b（books.writer_profile → book.yaml routing.writer_profile）在恢复之后由 runPostRecoveryMigrations 做（唯一的 git 写入）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, like, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { parseDocument } from 'yaml';
import type { RoutingSlots } from '@novelist/shared';
import { DEFAULT_SLOTS, TASK_KINDS, zRoutingSlots } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { V3_BOOK_SQL, fillVolumeTitles, isV3Meta, readFlowTolerant } from '../book/legacy.js';
import type { Db } from '../db/client.js';
import { books, chapters, inbox, profiles, routingPresets, runs, settings, tasks } from '../db/schema.js';
import { emptyV3Meta, readV3Meta } from '../flow/state.js';
import { openRepo } from '../book/repo.js';
import { P } from '../book/layout.js';
import { TRAILER } from '../book/trailers.js';
import { clearStaleGitLocks, commitOwnerEditIf } from '../orchestrator/committer.js';
import { SLOTS_KEY, loadSlots } from '../orchestrator/routing.js';
import { slotsFromLegacy } from './legacy-presets.js';
import { V3_INBOX_PREFIXES } from '../flow/inbox-v3.js';
import { logFiles } from '../harness/runner.js';

export const MIGRATION_KEY = 'migration.p3';
const LOCK_SQL = sql`select pg_advisory_xact_lock(hashtext('novelist.migration.p3'))`;

export interface BootMigrationReport {
  books: {
    v3: number;
    legacy: number;
    missing: number;
    /** v3 书（数据库判定）但 book.yaml 不在 / 读不了 / 不是 v3 */
    invalid: string[];
    metaBackfilled: number;
    /** book.yaml 说 v3、库里是旧书、已经有章节：不自动转换（主人可以接手） */
    flowMismatch: string[];
    /** 接手到一半（meta.takeoverIntent）：主人再点一次接手就完成 */
    interruptedTakeover: string[];
  };
  tasksCancelled: number;
  outboxCleared: number;
  inboxClosed: number;
  slots?: 'created' | 'kept';
  droppedProfiles?: string[];
  writerOverrides?: { applied: number; deferred: string[] };
  volumeTitles: { rows: number; books: number; retryLater: string[] };
}

export interface MigrationState {
  v: 1;
  /** 只做一次的步骤 → 完成时间 */
  steps: Record<string, string>;
  /** 卷标题已回填的书 → 完成时间 */
  volumeTitles: Record<string, string>;
  /** M4b：已处理过的书 → 完成时间 */
  writerOverrides: Record<string, string>;
  report?: Record<string, unknown>;
}

/** 删掉的待办种类：新镜像不再产生它们 */
const REMOVED_INBOX_KINDS = ['approval', 'hold', 'question', 'circuit', 'model_change', 'format_migration', 'agents_md_edit', 'studio_conflict'];
const LIVE_TASK_STATES = ['pending', 'ready', 'waiting', 'blocked', 'leased', 'running', 'finalizing'];
const ACTIVE_RUN_STATES = ['preparing', 'spawned', 'running'];

type Deps = Pick<AppDeps, 'db' | 'paths' | 'log' | 'config'>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function readState(value: unknown): MigrationState {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<MigrationState>;
  const obj = (x: unknown): Record<string, string> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, string>) : {});
  return { v: 1, steps: obj(v.steps), volumeTitles: obj(v.volumeTitles), writerOverrides: obj(v.writerOverrides), ...(v.report ? { report: v.report } : {}) };
}

export async function loadMigrationState(db: Db | Tx): Promise<MigrationState> {
  const row = (await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MIGRATION_KEY)).limit(1))[0];
  return readState(row?.value);
}

/** 在一个事务里（持迁移锁）读改写 settings['migration.p3'] */
export async function patchMigrationState(db: Db, patch: (s: MigrationState) => void): Promise<MigrationState> {
  return db.transaction(async (tx) => {
    await tx.execute(LOCK_SQL);
    const s = await loadMigrationState(tx);
    patch(s);
    const value = s as unknown as Record<string, unknown>;
    await tx.insert(settings).values({ key: MIGRATION_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } });
    return s;
  });
}

/** v1 导入、接手：这本书的卷标题已经回填过（M5 不再看它） */
export async function markVolumeTitlesDone(db: Db, bookId: string, now = new Date()): Promise<void> {
  await patchMigrationState(db, (s) => {
    s.volumeTitles[bookId] = now.toISOString();
  });
}

const notV3Sql = sql`not coalesce(${V3_BOOK_SQL}, false)`;

// ───────────────────────── M1 ─────────────────────────

async function classifyBooks(deps: Deps, report: BootMigrationReport): Promise<void> {
  const rows = await deps.db.select({ id: books.id, slug: books.slug, meta: books.meta, accepted: books.acceptedThrough }).from(books);
  for (const row of rows) {
    const flow = await readFlowTolerant(path.join(deps.paths.books, row.slug));
    if (isV3Meta(row.meta)) {
      report.books.v3 += 1;
      if (flow !== 'v3') {
        report.books.invalid.push(row.slug);
        deps.log.warn({ slug: row.slug, bookYaml: flow }, 'p3 boot migration: v3 book whose book.yaml is missing, unreadable or not v3 (status unchanged)');
      }
      continue;
    }
    if (flow === 'missing') report.books.missing += 1;
    else report.books.legacy += 1;
    if (flow !== 'v3') continue;
    if ((row.meta as { takeoverIntent?: unknown } | null)?.takeoverIntent) {
      report.books.interruptedTakeover.push(row.slug);
      continue;
    }
    const hasChapters = (await deps.db.select({ no: chapters.no }).from(chapters).where(eq(chapters.bookId, row.id)).limit(1)).length > 0;
    if (row.accepted > 0 || hasChapters) {
      report.books.flowMismatch.push(row.slug);
      continue;
    }
    // v3 书丢了 meta、还什么都没写：补上空的 meta.v3（没什么可接手的）
    const filled = await deps.db
      .update(books)
      .set({ meta: sql`coalesce(${books.meta}, '{}'::jsonb) || jsonb_build_object('v3', ${JSON.stringify(emptyV3Meta())}::jsonb)` })
      .where(and(eq(books.id, row.id), notV3Sql))
      .returning({ id: books.id });
    if (filled.length) report.books.metaBackfilled += 1;
  }
}

// ───────────────────────── M2 ─────────────────────────

const legacyTaskSql = sql`(${notInArray(tasks.kind, [...TASK_KINDS])} or (${tasks.bookId} is not null and ${tasks.bookId} not in (select id from books where jsonb_typeof(meta->'v3') = 'object')))`;

async function cancelLegacyTasks(deps: Deps, report: BootMigrationReport, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const { cancelled, cleared } = await deps.db.transaction(async (tx) => {
    await tx.execute(LOCK_SQL);
    const cancelled = await tx
      .update(tasks)
      .set({
        state: 'cancelled',
        waitReason: 'p3_legacy',
        finishedAt: nowIso,
        leaseOwner: null,
        leaseExpiresAt: null,
        // outbox 设成 JSON null：orchOf 读作没有，drainAllOutbox 也选不到
        params: sql`jsonb_set(${tasks.params}, '{_orch,outbox}', 'null'::jsonb)`,
        updatedAt: nowIso,
      })
      .where(and(inArray(tasks.state, LIVE_TASK_STATES), legacyTaskSql))
      .returning({ id: tasks.id });
    // 任何状态：旧种类 / 旧书任务的 outbox 标记一律清掉（否则 drainAllOutbox 会把旧的后续任务和待办建回来）
    const cleared = await tx
      .update(tasks)
      .set({ params: sql`jsonb_set(${tasks.params}, '{_orch,outbox}', 'null'::jsonb)`, updatedAt: nowIso })
      .where(and(sql`${tasks.params}->'_orch'->>'outbox' = 'true'`, legacyTaskSql))
      .returning({ id: tasks.id });
    return { cancelled, cleared };
  });
  report.tasksCancelled += cancelled.length;
  report.outboxCleared += cleared.length;
  // 还在跑的旧 run：写 kill 文件。recoverOnStartup / reattach 看到的是取消了的旧任务，杀掉 shim、把 run 记成 lost，不会收它的稿
  const ids = cancelled.map((t) => t.id);
  if (ids.length === 0) return;
  const active = await deps.db.select({ id: runs.id, runDir: runs.runDir }).from(runs).where(and(inArray(runs.taskId, ids), inArray(runs.state, ACTIVE_RUN_STATES)));
  for (const r of active) {
    await fs.writeFile(logFiles(path.join(r.runDir, 'log')).kill, 'user').catch((err: Error) => deps.log.warn({ err: err.message, runId: r.id }, 'p3 boot migration: kill file not written'));
  }
}

// ───────────────────────── M3 ─────────────────────────

async function closeInbox(db: Db, where: SQL | undefined, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(LOCK_SQL);
    const rows = await tx
      .update(inbox)
      .set({ state: 'resolved', resolution: { auto: true, reason: 'p3_legacy', ts: nowIso }, resolvedAt: nowIso })
      .where(and(eq(inbox.state, 'open'), where))
      .returning({ id: inbox.id });
    return rows.length;
  });
}

/** M3a（每次）：旧书的待办、已删除种类的待办。新镜像从不产生它们，回滚过旧镜像之后再部署也能关掉旧镜像建的 */
async function closeRemovedInbox(deps: Deps, report: BootMigrationReport, now: Date): Promise<void> {
  const legacyBook = sql`${inbox.bookId} in (select id from books where not coalesce(jsonb_typeof(meta->'v3') = 'object', false))`;
  report.inboxClosed += await closeInbox(deps.db, or(legacyBook, inArray(inbox.kind, REMOVED_INBOX_KINDS)), now);
}

/** 新流程用到的 dedupe 前缀（LIKE 模式，_ 转义） */
export function v3InboxPatterns(): string[] {
  return [...new Set([...V3_INBOX_PREFIXES, 'quota:', 'v3_'])].map((p) => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

/** M3b（一次）：dedupe key 不属于新流程任何前缀的待办（旧流程的提问、拦截、nonce 提示……） */
async function closeLegacyInbox(deps: Deps, report: BootMigrationReport, now: Date): Promise<void> {
  const state = await loadMigrationState(deps.db);
  if (state.steps.closeLegacyInbox) return;
  const key = sql`coalesce(${inbox.dedupeKey}, '')`;
  const known = or(...v3InboxPatterns().map((p) => like(key, p)));
  report.inboxClosed += await closeInbox(deps.db, sql`not (${known})`, now);
  await patchMigrationState(deps.db, (s) => {
    s.steps.closeLegacyInbox = now.toISOString();
  });
}

// ───────────────────────── M4 ─────────────────────────

/** M4（只要还没有 routing.slots 行）：旧 preset → 两个路由位置。routing.active 和 routing_presets 行都不动（上一版镜像要读） */
async function routingSlots(deps: Deps, report: BootMigrationReport, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const result = await deps.db.transaction(async (tx) => {
    await tx.execute(LOCK_SQL);
    const existing = (await tx.select({ key: settings.key }).from(settings).where(eq(settings.key, SLOTS_KEY)).limit(1))[0];
    if (existing) return { created: false, dropped: [] as string[] };
    const active = (await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, 'routing.active')).limit(1))[0];
    let value: RoutingSlots;
    let dropped: string[] = [];
    if (!active) {
      // 全新安装：既没有 routing.slots 也没有旧的 routing.active
      value = zRoutingSlots.parse(DEFAULT_SLOTS);
    } else {
      const presetId = (active.value as { presetId?: unknown } | null)?.presetId;
      const row = typeof presetId === 'string' ? ((await tx.select({ body: routingPresets.body }).from(routingPresets).where(eq(routingPresets.id, presetId)).limit(1))[0] ?? null) : null;
      const ids = new Set((await tx.select({ id: profiles.id }).from(profiles)).map((r) => r.id));
      const s = slotsFromLegacy(active.value, row, ids);
      dropped = s.dropped;
      value = zRoutingSlots.parse({ writer: s.writer, utility: s.utility, migratedFrom: s.from, droppedProfiles: s.dropped });
    }
    await tx.insert(settings).values({ key: SLOTS_KEY, value: value as unknown as Record<string, unknown>, updatedAt: nowIso }).onConflictDoNothing({ target: settings.key });
    return { created: true, dropped };
  });
  report.slots = result.created ? 'created' : 'kept';
  report.droppedProfiles = result.dropped;
  if (result.dropped.length) deps.log.warn({ dropped: result.dropped }, 'p3 boot migration: profiles of the old routing preset no longer exist (dropped from the routing slots)');
}

// ───────────────────────── M4b ─────────────────────────

const BUSY_TASK_STATES = ['leased', 'running', 'finalizing'];
export const WRITER_OVERRIDE_TRAILER = 'p3-writer-override';

/**
 * M4b（p3-plan §5，恢复之后由 orchestrator.start 的 afterRecover 调用）：books.writer_profile 不再读，
 * 和写作位置主用不同的值搬进 book.yaml 的 routing.writer_profile（网页上可改的书级覆盖），行为不变。
 * 只看升级前就是 v3 的书：第一次跑时把当时的旧书全部记为做完（之后被接手的旧书，它的 books.writer_profile 是旧流程的粘性写手，不是主人的选择），
 * 接手过来的书（meta.v3.takeover 有值）也直接记为做完。
 * 书在忙（有 leased / running / finalizing 任务、meta.v3.pending、meta.v3.rewinding）或工作树不干净 → 这次跳过（deferred），
 * 由 createWriterOverrideRetry（leader tick，每分钟至多一次）再试，下次开机也会再试；延后期间路由照旧用旧的粘性写手（routing.ts pendingStickyWriter）。
 * 不需要改的书也记为做完。提交是主人提交，带 trailer Novelist-Migration: p3-writer-override。
 */
export async function runPostRecoveryMigrations(deps: Deps, now: Date = new Date()): Promise<NonNullable<BootMigrationReport['writerOverrides']>> {
  const out = { applied: 0, deferred: [] as string[] };
  if (!(await loadMigrationState(deps.db)).steps.writerOverridesInit) {
    // 第一次：此刻的旧书都不归 M4b 管（以后被接手也不管）
    const legacy = await deps.db.select({ id: books.id }).from(books).where(notV3Sql);
    await patchMigrationState(deps.db, (s) => {
      if (s.steps.writerOverridesInit) return;
      for (const r of legacy) s.writerOverrides[r.id] ??= now.toISOString();
      s.steps.writerOverridesInit = now.toISOString();
    });
  }
  const state = await loadMigrationState(deps.db);
  const slots = await loadSlots(deps.db);
  const rows = await deps.db.select({ id: books.id, slug: books.slug, meta: books.meta, writerProfile: books.writerProfile }).from(books).where(V3_BOOK_SQL);
  const done: string[] = [];
  const busy = async (bookId: string): Promise<boolean> => {
    const t = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, bookId), inArray(tasks.state, BUSY_TASK_STATES))).limit(1);
    if (t.length) return true;
    const m = readV3Meta((await deps.db.select({ meta: books.meta }).from(books).where(eq(books.id, bookId)).limit(1))[0]?.meta);
    return m.pending !== null || m.rewinding !== null;
  };
  for (const row of rows) {
    if (state.writerOverrides[row.id]) continue;
    const want = row.writerProfile;
    if (!want || want === slots.writer.primary || readV3Meta(row.meta).takeover !== null) {
      done.push(row.id);
      continue;
    }
    const repo = openRepo(path.join(deps.paths.books, row.slug));
    try {
      if (await busy(row.id)) {
        out.deferred.push(row.slug);
        continue;
      }
      const r = await commitOwnerEditIf(
        deps.db,
        repo,
        row.id,
        async () => {
          await clearStaleGitLocks(repo.dir);
          return (await repo.isClean()) && !(await busy(row.id));
        },
        async () => {
          const raw = await repo.readFile(P.bookYaml);
          if (raw === null) throw new Error('book.yaml 不存在');
          const doc = parseDocument(raw);
          if (doc.errors.length) throw new Error(`book.yaml 读不了：${doc.errors[0]?.message ?? ''}`);
          if (doc.getIn(['routing', 'writer_profile']) !== undefined) return null; // 书里已经有覆盖：以书为准
          doc.setIn(['routing', 'writer_profile'], want);
          const next = doc.toString({ lineWidth: 0 });
          if (next === raw) return null;
          return { files: [{ path: P.bookYaml, content: next }], message: `owner: keep writer ${want} for this book (routing slots)`, baseSha: null, extraTrailers: { [TRAILER.migration]: WRITER_OVERRIDE_TRAILER } };
        },
      );
      if (r === 'refused') {
        out.deferred.push(row.slug);
        continue;
      }
      if (r !== 'unchanged') out.applied += 1;
      done.push(row.id);
    } catch (err) {
      out.deferred.push(row.slug);
      deps.log.warn({ err: (err as Error).message, slug: row.slug }, 'p3 post-recovery migration: writer override not moved, retried on next boot');
    }
  }
  await patchMigrationState(deps.db, (s) => {
    for (const id of done) s.writerOverrides[id] = now.toISOString();
    s.report = { ...(s.report ?? {}), writerOverrides: out, writerOverridesAt: now.toISOString() };
  });
  deps.log.info({ writerOverrides: out }, 'p3 post-recovery migration');
  return out;
}

const RETRY_INTERVAL_MS = 60_000;

/**
 * M4b 的运行期重试（leader tick 调用，每分钟至多一次）：上一次报告里还有延后的书才跑，没有就什么都不做。
 * 书的批次收完、pending 清空之后，不必等下次开机就把覆盖搬进 book.yaml。
 */
export function createWriterOverrideRetry(deps: Deps): (now: Date) => Promise<void> {
  let nextAt = 0;
  return async (now) => {
    if (now.getTime() < nextAt) return;
    nextAt = now.getTime() + RETRY_INTERVAL_MS;
    const report = (await loadMigrationState(deps.db)).report as { writerOverrides?: { deferred?: unknown } } | undefined;
    const deferred = report?.writerOverrides?.deferred;
    if (!Array.isArray(deferred) || deferred.length === 0) return;
    await runPostRecoveryMigrations(deps, now);
  };
}

// ───────────────────────── M5 ─────────────────────────

async function volumeTitles(deps: Deps, report: BootMigrationReport, now: Date): Promise<void> {
  const state = await loadMigrationState(deps.db);
  const candidates = await deps.db
    .selectDistinct({ id: books.id, slug: books.slug })
    .from(books)
    .innerJoin(chapters, eq(chapters.bookId, books.id))
    .where(and(eq(chapters.volumeTitle, ''), or(sql`${chapters.volume} <> ''`, notV3Sql)));
  const done: string[] = [];
  for (const b of candidates) {
    if (state.volumeTitles[b.id]) continue;
    try {
      const n = await fillVolumeTitles(deps.db, deps.paths, b);
      report.volumeTitles.rows += n;
      report.volumeTitles.books += 1;
      done.push(b.id);
    } catch (err) {
      report.volumeTitles.retryLater.push(b.slug);
      deps.log.warn({ err: (err as Error).message, slug: b.slug }, 'p3 boot migration: volume titles not filled, retried on next boot');
    }
  }
  if (done.length) {
    await patchMigrationState(deps.db, (s) => {
      for (const id of done) s.volumeTitles[id] = now.toISOString();
    });
  }
}

// ───────────────────────── 入口 ─────────────────────────

/** M1–M4、M5、M6（§5）。只由 startServe 在有 orchestrator 角色的进程里调用（bootstrap 的 bootMigrate） */
export async function runBootMigrations(deps: Deps, now: Date = new Date()): Promise<BootMigrationReport> {
  const report: BootMigrationReport = {
    books: { v3: 0, legacy: 0, missing: 0, invalid: [], metaBackfilled: 0, flowMismatch: [], interruptedTakeover: [] },
    tasksCancelled: 0,
    outboxCleared: 0,
    inboxClosed: 0,
    volumeTitles: { rows: 0, books: 0, retryLater: [] },
  };
  await classifyBooks(deps, report);
  await cancelLegacyTasks(deps, report, now);
  await closeRemovedInbox(deps, report, now);
  await closeLegacyInbox(deps, report, now);
  await routingSlots(deps, report, now);
  await volumeTitles(deps, report, now);
  await patchMigrationState(deps.db, (s) => {
    s.report = { ...report, at: now.toISOString() } as unknown as Record<string, unknown>;
  });
  return report;
}
