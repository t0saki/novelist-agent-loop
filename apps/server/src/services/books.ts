/** 书的生命周期服务（开书、删除、reindex）与书级视图（summary/overview/publish）。新书一律是 v3 流程；旧书只读。 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { parseDocument } from 'yaml';
import type { AutoLength, BookConfig, BookOverview, BookSummary, CreateBookCompat, CreateBookParsed, Frontiers, GitCommitRow, V3Length } from '@novelist/shared';
import { AUTO_LENGTHS, V3_PUBLISH_DEFAULTS, V3_TITLE_PLACEHOLDER, chapterId, countCjk, parseChapterHeading, stripBeatMarkers, stripTitleLine, zBookConfig, zCreateBook } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { bookFiles, CanonicalParseError, fillVolumeTitles, initBookRepo, moveToTrash, openRepo, P, slugifyName, V3_BOOK_SQL, type BookRepo } from '../book/index.js';
import { books, chapters, inbox, runs, tasks, publishSchedule, readingProgress, bookEvents } from '../db/schema.js';
import { genreExists, listGenres } from '../genres/index.js';
import { syncBibleMeta } from '../flow/library.js';
import { HttpProblem, conflict } from '../api/problem.js';
import { bookBySlug, bookDir, type BookRow } from '../api/helpers.js';
import { bufferState, commitOwnerEdit, ensureBatchLog, loadSystemSettings } from '../orchestrator/index.js';
import { isV3Row, v3Summaries } from './v3-view.js';

export const AUTO_CREATED_EVENT = 'book.auto_created';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 活动任务状态：未终结（含等待） */
export const LIVE_TASK_STATES = ['pending', 'ready', 'waiting', 'leased', 'running', 'finalizing'] as const;
const ACTIVE_RUN_STATES = ['preparing', 'spawned', 'running'] as const;

export async function makeSlug(deps: Pick<AppDeps, 'db' | 'paths'>, title: string, opts: { blankRandom?: boolean } = {}): Promise<string> {
  const taken = new Set((await deps.db.select({ s: books.slug }).from(books)).map((r) => r.s));
  try {
    for (const name of await fs.readdir(deps.paths.books)) taken.add(name);
  } catch {
    // books 目录尚未创建
  }
  // 空书名：不拼音化，直接用随机 slug
  const candidate = title.trim() || opts.blankRandom !== true ? slugifyName(title, taken).slice(0, 60).replace(/-$/, '') : '';
  if (SLUG_RE.test(candidate) && !taken.has(candidate)) return candidate;
  return `book-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;
}

/** 开书的结果：题材、篇幅、种子都已定下 */
export interface ResolvedNewBook {
  genre: string;
  length: V3Length;
  seed: string;
  title: string;
}

const AUTO_EVENT_KIND = AUTO_CREATED_EVENT;

/**
 * 开书表单 → 具体的题材 / 篇幅 / 种子（P3 WP-3）。
 * 题材 'random'：在可见的题材包里按自动开书的权重（设置里的覆盖 → pack.yaml 的 auto.weight → 1）和自动开过的本数挑，与自动开书同一个规则；
 * 篇幅 'random'：按篇幅分布补最近 20 本自动书的缺口（题材包的篇幅倾向加权）；
 * 种子：请求里给了 seed 就原样用；否则按题材拼一份（buildAutoSeedV3：成人题材的年龄声明照旧带上），再接上主人的一句话想法。
 */
export async function resolveNewBook(deps: Pick<AppDeps, 'db' | 'paths'>, input: CreateBookParsed, opts: { rng?: () => number } = {}): Promise<ResolvedNewBook> {
  // auto-start.ts 依赖本文件（createBook），这里动态引入避免循环
  const { buildAutoSeedV3, lengthClass, pickGenre, pickKeywords, pickLength } = await import('./auto-start.js');
  const settings = await loadSystemSettings(deps.db);
  const cfg = settings.autoStart;
  const packs = (await listGenres(deps.paths)).filter((p) => !p.hidden);
  const events = await deps.db.select({ body: bookEvents.body }).from(bookEvents).where(eq(bookEvents.kind, AUTO_EVENT_KIND)).orderBy(desc(bookEvents.ts), desc(bookEvents.id));
  const counts = new Map<string, number>();
  for (const e of events) {
    const g = typeof e.body.genre === 'string' ? e.body.genre : null;
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let genreId = input.genre;
  if (genreId === 'random') {
    const weightOf = (p: (typeof packs)[number]) => cfg.genreWeights[p.id] ?? p.auto?.weight ?? 1;
    const weighted = packs.filter((p) => weightOf(p) > 0);
    const pool = weighted.length > 0 ? weighted : packs;
    const picked = pickGenre(pool, counts, new Map(pool.map((p) => [p.id, weightOf(p)])));
    if (!picked) throw new HttpProblem(400, 'no_genre', '没有可用的题材包，先新建或恢复一个');
    genreId = picked;
  } else if (!(await genreExists(deps.paths, genreId))) {
    throw new HttpProblem(400, 'unknown_genre', `题材包不存在：${genreId}`);
  }
  const pack = (await listGenres(deps.paths)).find((p) => p.id === genreId);
  let length: V3Length;
  if (input.length === 'random') {
    const recent = events
      .map((e) => e.body.length)
      .filter((l): l is AutoLength => typeof l === 'string' && (AUTO_LENGTHS as readonly string[]).includes(l))
      .slice(0, 20);
    length = pickLength(recent, cfg.lengthMix, pack?.auto?.length_hint ? lengthClass(pack.auto.length_hint) : null);
  } else {
    length = input.length;
  }
  let seed = input.seed;
  if (seed === undefined) {
    const base = pack ? buildAutoSeedV3(pack, { ordinal: counts.get(genreId) ?? 0, keywords: pickKeywords(pack.auto?.keywords ?? [], opts.rng ?? Math.random) }) : '';
    const idea = input.idea.trim();
    seed = `${base}${idea ? `\n主人的想法：${idea}\n` : ''}`;
  }
  return { genre: genreId, length, seed, title: input.title };
}

/** 无题材不立项（v1 教训）：genre 不存在 → 400。新书一律走 v3 流程（请求里的 flow / tier / preset 不再起作用） */
export async function createBook(deps: AppDeps, input: CreateBookCompat, opts: { rng?: () => number } = {}): Promise<BookSummary> {
  const parsed = zCreateBook.parse(input);
  const resolved = await resolveNewBook(deps, parsed, opts);
  const slug = parsed.slug ?? (await makeSlug(deps, parsed.title, { blankRandom: true }));
  const existing = await deps.db.select({ id: books.id }).from(books).where(eq(books.slug, slug)).limit(1);
  if (existing[0]) throw conflict(`书 ${slug} 已存在`);
  const dir = bookDir(deps, slug);
  if (await fs.stat(dir).then(() => true, () => false)) throw conflict(`目录 ${slug} 已存在`);
  return createBookV3(deps, parsed, resolved, slug, dir);
}

/**
 * v3 开书（p1-plan §3 WP-C）：book.yaml 写 flow/v3/发布默认值，仓库用 v3 布局（seed.md、不入库的根 AGENTS.md）。
 * 书名可留空：用 '未命名·' 占位（与自动开书的 '待命名·' 不同，nameAutoBooks 不会碰），由作者在 bible.md 里起名（auto_title）。
 */
async function createBookV3(deps: AppDeps, parsed: CreateBookParsed, resolved: ResolvedNewBook, slug: string, dir: string): Promise<BookSummary> {
  const settings = await loadSystemSettings(deps.db);
  const len = resolved.length;
  const target = parsed.target_cjk ?? settings.autoStart.lengths[len].targetCjk;
  const n0 = Math.max(1, Math.ceil(target / 4000));
  const batch = parsed.batch ?? 5;
  const typed = resolved.title.trim();
  const title = typed || `${V3_TITLE_PLACEHOLDER}${nanoid(6)}`;
  // 发布与 effort 的全站默认值（系统页、模型页可改；初始值 = 以前写死的那一套）
  const pd = settings.v3.publishDefaults;
  const maxBuffer = Math.max(pd.max_buffer, 2 * batch);
  const config: Record<string, unknown> = {
    slug,
    title,
    genre: resolved.genre,
    flow: 'v3',
    v3: { length: len, target_cjk: target, planned_chapters: n0, planned_chapters_initial: n0, batch, min_chapter_cjk: parsed.min_chapter_cjk ?? 3000, auto_title: !typed, effort: { ...settings.v3.effortDefaults } },
    publish: { ...V3_PUBLISH_DEFAULTS, mode: pd.mode, cadence: pd.cadence, timezone: pd.timezone, per_slot: pd.per_slot, max_buffer: maxBuffer, resume_buffer: Math.max(1, maxBuffer - 5) },
  };
  const { commit } = await initBookRepo(dir, { config: config as never, premise: resolved.seed, layout: 'v3' });
  const id = randomUUID();
  const meta = { v3: { hints: [], noChapterStreak: 0, emptyStreak: 0, finaleNoMarker: 0, lastBatchFrom: null, lastBatchAt: null, hintedShort: [], locked: [], pending: null } };
  await deps.db.insert(books).values({ id, slug, title, genre: resolved.genre, status: 'draft', headCommit: commit, meta });
  await deps.db.insert(bookEvents).values({ bookId: id, kind: 'book.created', body: { slug, seed_chars: resolved.seed.length, flow: 'v3', length: len } });
  if (parsed.start) await deps.orchestrator.startBook(id);
  deps.bus.publish({ type: 'book_changed', book: slug });
  const row = await bookBySlug(deps, slug);
  return (await summarize(deps, [row]))[0] as BookSummary;
}

/**
 * 删书：数据库行照旧删除；书目录移进回收站（$DATA/trash/books/<slug>-<时间>，带墓碑），不做不可恢复的删除（P3 D14）。
 * 目录本来就不在（手工移走过）：只删数据库行。移动失败时数据库已删、目录还在原处：可以重建行后 `novelist reindex` 找回。
 */
export async function deleteBook(deps: AppDeps, slug: string): Promise<void> {
  const book = await bookBySlug(deps, slug);
  await deps.db.update(books).set({ status: 'archived', pausedReason: 'deleting', updatedAt: new Date().toISOString() }).where(eq(books.id, book.id));
  const live = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, book.id), inArray(tasks.state, [...LIVE_TASK_STATES])));
  for (const t of live) await deps.orchestrator.cancelTask(t.id).catch(() => {});
  const active = await deps.db.select({ n: count() }).from(runs).where(and(eq(runs.bookId, book.id), inArray(runs.state, [...ACTIVE_RUN_STATES])));
  if (Number(active[0]?.n ?? 0) > 0) throw conflict('还有运行中的 run，已暂停并取消任务，请等它们结束后重试', 'runs_active');
  const deletedAt = new Date().toISOString();
  await deps.db.transaction(async (tx) => {
    await tx.delete(tasks).where(eq(tasks.bookId, book.id));
    await tx.delete(runs).where(eq(runs.bookId, book.id));
    await tx.delete(inbox).where(eq(inbox.bookId, book.id));
    await tx.delete(publishSchedule).where(eq(publishSchedule.bookId, book.id));
    await tx.delete(readingProgress).where(eq(readingProgress.bookId, book.id));
    // 开书记录留着：删书不退回当天的自动开书额度，题材轮转序号也不回退
    await tx.delete(bookEvents).where(and(eq(bookEvents.bookId, book.id), ne(bookEvents.kind, AUTO_CREATED_EVENT)));
    await tx.delete(books).where(eq(books.id, book.id)); // chapters 级联
  });
  const dir = bookDir(deps, slug);
  if (await fs.stat(dir).then(() => true, () => false)) {
    const tombstone = { id: book.id, slug, title: book.title, genre: book.genre, status: book.status, meta: book.meta, acceptedThrough: book.acceptedThrough, publishedThrough: book.publishedThrough, deletedAt };
    try {
      await moveToTrash(deps.paths, 'books', slug, dir, tombstone);
    } catch (err) {
      deps.log.error({ err: (err as Error).message, slug }, 'delete book: moving the directory to the trash failed (database rows already deleted, directory left in place)');
      throw new HttpProblem(500, 'trash_failed', `书已从数据库删除，但目录没能移进回收站：${(err as Error).message}`);
    }
  }
  deps.bus.publish({ type: 'book_changed', book: slug });
}

/** 从书库 git 重建 books/chapters 索引（novelist reindex） */
export async function reindexBook(deps: AppDeps, slug: string): Promise<void> {
  const book = await bookBySlug(deps, slug);
  const repo = openRepo(bookDir(deps, slug));
  const files = bookFiles(repo);
  const head = await repo.head();
  const manuscriptFiles = (await repo.list(P.manuscriptDir, { rev: head })).filter((p) => /\/c\d{5}\.md$/.test(p));
  const noOf = (p: string) => Number(/c(\d{5})\.md$/.exec(p)?.[1]);
  const tagList = new Set(await repo.tags('pub/*'));
  const pubThrough = [...tagList].reduce((m, t) => Math.max(m, Number(t.split('/')[1] ?? 0)), 0);
  const nowIso = new Date().toISOString();
  let acceptedThrough = 0;
  let totalCjk = 0;
  const nos = manuscriptFiles.map(noOf).sort((a, b) => a - b);
  const v3 = (await files.config().catch(() => null))?.config.flow === 'v3';
  for (const [i, no] of nos.entries()) {
    if (no === i + 1) acceptedThrough = no;
    const text = await files.manuscript(no, head);
    if (text === null) continue;
    const cjk = countCjk(text, 'han');
    totalCjk += cjk;
    if (v3) {
      // v3：标题只取正文首行的标题行；没有标题行就保留库里的值，从不编造“第N章”
      const heading = parseChapterHeading(text.split('\n').find((l) => l.trim() !== '') ?? '');
      const update = { chapterId: chapterId(no), cjk, state: 'accepted', updatedAt: nowIso, ...(heading ? { title: heading.title } : {}) };
      await deps.db
        .insert(chapters)
        .values({ bookId: book.id, no, title: heading?.title ?? '', volume: '', arc: '', ...update, publishedAt: no <= pubThrough ? nowIso : null })
        .onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: update });
      continue;
    }
    // 旧书：已有行的标题、卷保持原样；卷标题之后由 fillVolumeTitles 按 plan/volumes 回填
    const update = { chapterId: chapterId(no), cjk, state: 'accepted', updatedAt: nowIso };
    const publishedAt = no <= pubThrough ? nowIso : null;
    await deps.db
      .insert(chapters)
      .values({ bookId: book.id, no, title: `第${no}章`, volume: '', arc: '', ...update, publishedAt })
      .onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: update });
  }
  await deps.db.update(books).set({ acceptedThrough, totalCjk, cursor: acceptedThrough + 1, headCommit: head, publishedThrough: Math.max(book.publishedThrough, pubThrough), updatedAt: nowIso }).where(eq(books.id, book.id));
  // v3（phase 1 写的书没有 batchLog）：按提交 trailer 回填批次（回退点、复盘用）
  if (v3 && acceptedThrough > 0) await ensureBatchLog(deps.db, repo, book.id);
  // v3：标签（书库摘要用）按 HEAD 上 bible.md 的第三行补上
  if (v3) {
    const bible = await repo.readFile('bible.md', head).catch(() => null);
    if (bible) await syncBibleMeta(deps.db, book.id, bible);
  } else {
    await fillVolumeTitles(deps.db, deps.paths, book).catch((err: Error) => deps.log.warn({ err: err.message, slug }, 'reindex: volume titles not filled'));
  }
  deps.bus.publish({ type: 'book_changed', book: slug });
}

function frontiers(row: BookRow, bufferDays: number | null): Frontiers {
  return {
    accepted: row.acceptedThrough,
    published: row.publishedThrough,
    buffer: Math.max(0, row.acceptedThrough - row.publishedThrough),
    bufferDays,
  };
}

export async function summarize(deps: Pick<AppDeps, 'db' | 'paths'>, rows: BookRow[]): Promise<BookSummary[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  // v3 书：状态句与花费（批量查询；flow 按 meta.v3 判断，旧书不读 book.yaml）
  const v3 = await v3Summaries(deps, rows, new Date());
  const [taskRows, inboxRows, waitingRows] = await Promise.all([
    deps.db.select({ bookId: tasks.bookId, n: count() }).from(tasks).where(and(inArray(tasks.bookId, ids), inArray(tasks.state, [...LIVE_TASK_STATES]))).groupBy(tasks.bookId),
    deps.db.select({ bookId: inbox.bookId, n: count() }).from(inbox).where(and(inArray(inbox.bookId, ids), eq(inbox.state, 'open'))).groupBy(inbox.bookId),
    deps.db.select({ bookId: tasks.bookId, waitReason: tasks.waitReason, notBefore: tasks.notBefore }).from(tasks).where(and(inArray(tasks.bookId, ids), eq(tasks.state, 'waiting'))).orderBy(desc(tasks.updatedAt)),
  ]);
  const taskCount = new Map(taskRows.map((r) => [r.bookId, Number(r.n)]));
  const inboxCount = new Map(inboxRows.map((r) => [r.bookId, Number(r.n)]));
  const waiting = new Map<string, { reason: string; until: string | null }>();
  for (const w of waitingRows) {
    if (w.bookId && !waiting.has(w.bookId)) waiting.set(w.bookId, { reason: w.waitReason ?? 'waiting', until: w.notBefore });
  }
  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    genre: row.genre,
    status: row.status as BookSummary['status'],
    totalCjk: row.totalCjk,
    frontiers: frontiers(row, null),
    activeTasks: taskCount.get(row.id) ?? 0,
    waiting: waiting.get(row.id) ?? null,
    inboxOpen: inboxCount.get(row.id) ?? 0,
    updatedAt: row.updatedAt,
    flow: isV3Row(row) ? 'v3' : 'v2',
    legacy: !isV3Row(row),
    v3: v3.get(row.id) ?? null,
  }));
}

export const BOOK_FILTERS = ['active', 'finished', 'legacy', 'all'] as const;
export type BookFilter = (typeof BOOK_FILTERS)[number];

/** 首页的筛选：active = 在写和等待中的新流程书（缺省），finished = 已完结 / 归档的新流程书，legacy = 旧书（导入的、旧流程写的），all = 全部 */
export async function listBookSummaries(deps: Pick<AppDeps, 'db' | 'paths'>, opts: { filter?: BookFilter } = {}): Promise<BookSummary[]> {
  const filter = opts.filter ?? 'active';
  const where =
    filter === 'active'
      ? and(V3_BOOK_SQL, inArray(books.status, ['draft', 'planning', 'active', 'paused']))
      : filter === 'finished'
        ? and(V3_BOOK_SQL, inArray(books.status, ['completed', 'archived']))
        : filter === 'legacy'
          ? sql`not coalesce(${V3_BOOK_SQL}, false)`
          : undefined;
  const rows = await deps.db.select().from(books).where(where).orderBy(desc(books.updatedAt));
  return summarize(deps, rows);
}

export function commitRow(c: { sha: string; ts: string; subject: string; trailers: Record<string, string>; tags: string[] }): GitCommitRow {
  return { sha: c.sha, ts: c.ts, subject: c.subject, trailers: c.trailers, tags: c.tags };
}

/** book.yaml 读不出来（旧书的旧键不合 schema、文件没了）时的兜底配置：页面照常打开 */
export function fallbackConfig(row: Pick<BookRow, 'slug' | 'title' | 'genre'>): BookConfig {
  return zBookConfig.parse({ schema: 'nv.book/1', slug: SLUG_RE.test(row.slug) ? row.slug : 'legacy', title: row.title || row.slug || 'legacy', genre: row.genre || 'generic' });
}

export async function bookOverview(deps: AppDeps, row: BookRow): Promise<BookOverview> {
  const dir = bookDir(deps, row.slug);
  const dirMissing = !(await fs.stat(dir).then((st) => st.isDirectory(), () => false));
  const repo = openRepo(dir);
  const [loaded, summary, log] = await Promise.all([
    dirMissing ? Promise.resolve(null) : bookFiles(repo).config().catch(() => null),
    summarize(deps, [row]),
    dirMissing ? Promise.resolve({ items: [] }) : repo.log({ limit: 10 }).catch(() => ({ items: [] })),
  ]);
  const config = loaded?.config ?? fallbackConfig(row);
  const cfg = loaded?.config ?? null;
  const base = summary[0] as BookSummary;
  return {
    ...base,
    frontiers: frontiers(row, (await bufferState(deps.db, row.id, config.publish)).bufferDays),
    config: cfg ? { flow: cfg.flow, publish: cfg.publish, v3: cfg.v3, routing: cfg.routing, genre: cfg.genre, title: cfg.title } : null,
    writerOverride: cfg?.routing.writer_profile ?? null,
    recentCommits: log.items.map(commitRow),
    dirMissing,
  };
}

/** 改 book.yaml 的部分键（保留注释/顺序，走 committer 协议），返回新 raw */
export async function patchBookYaml(deps: AppDeps, row: BookRow, repo: BookRepo, patch: (doc: ReturnType<typeof parseDocument>) => void, message: string): Promise<string> {
  const raw = await repo.readFile(P.bookYaml);
  if (raw === null) throw new CanonicalParseError(P.bookYaml, [{ path: '', message: 'book.yaml 不存在' }]);
  const doc = parseDocument(raw);
  patch(doc);
  const next = doc.toString({ lineWidth: 0 });
  if (next === raw) return next; // 没有实际改动：不提交（否则 git 报 nothing to commit，前端看到 500）
  await commitOwnerEdit(deps.db, repo, row.id, { files: [{ path: P.bookYaml, content: next }], message, baseSha: null });
  return next;
}

/** stripTitle：v3 书的正文首行是“# 第N章 标题”，读者端去掉它（v2 和导入的书保留原样） */
export async function collectManuscripts(repo: BookRepo, nos: number[], opts?: { stripTitle?: boolean }): Promise<Map<number, string>> {
  const rels = nos.map((n) => P.manuscript(n));
  const texts = repo.readMany ? await repo.readMany(rels) : await Promise.all(rels.map((r) => repo.readFile(r)));
  const out = new Map<number, string>();
  nos.forEach((no, i) => {
    const t = texts[i];
    if (t != null) out.set(no, opts?.stripTitle ? stripTitleLine(stripBeatMarkers(t)) : stripBeatMarkers(t));
  });
  return out;
}

