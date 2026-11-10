/** 书的生命周期服务（开书、删除、reindex）与书级视图（summary/overview/publish）。Owner: lane G（调用 B 的 initBookRepo、C 的 genreExists、E 的 initialTasks、F 的 startBook）。 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { and, count, desc, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { parseDocument } from 'yaml';
import type { BookOverview, BookSummary, CreateBook, Frontiers, GitCommitRow, PublishOverview } from '@novelist/shared';
import { V3_PUBLISH_DEFAULTS, V3_TITLE_PLACEHOLDER, chapterId, countCjk, parseChapterHeading, stripBeatMarkers, stripTitleLine, zCreateBook } from '@novelist/shared';
import type { z } from 'zod';
import type { AppDeps } from '../app.js';
import { bookFiles, CanonicalParseError, initBookRepo, openRepo, P, type BookRepo } from '../book/index.js';
import { books, chapters, inbox, runs, tasks, publishSchedule, readingProgress, bookEvents } from '../db/schema.js';
import { genreExists } from '../genres/index.js';
import { HttpProblem, conflict } from '../api/problem.js';
import { bookBySlug, bookDir, type BookRow } from '../api/helpers.js';
import { bufferState, commitOwnerEdit, loadSystemSettings, nextSlots } from '../orchestrator/index.js';
import { loadBookState, milestoneStatus } from '../state/index.js';
import type { PublishConfig } from '@novelist/shared';

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
  const { slugifyName } = await import('../state/ids.js');
  // 空书名（只有 v3 允许）：不拼音化，直接用随机 slug
  const candidate = title.trim() || opts.blankRandom !== true ? slugifyName(title, taken).slice(0, 60).replace(/-$/, '') : '';
  if (SLUG_RE.test(candidate) && !taken.has(candidate)) return candidate;
  return `book-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;
}

/** 无题材不立项（v1 教训）：genre 不存在 → 400 */
export async function createBook(deps: AppDeps, input: CreateBook): Promise<BookSummary> {
  const parsed: z.output<typeof zCreateBook> = zCreateBook.parse(input);
  if (!(await genreExists(deps.paths, parsed.genre))) throw new HttpProblem(400, 'unknown_genre', `题材包不存在：${parsed.genre}`);
  const slug = parsed.slug ?? (await makeSlug(deps, parsed.title, { blankRandom: parsed.flow === 'v3' }));
  const existing = await deps.db.select({ id: books.id }).from(books).where(eq(books.slug, slug)).limit(1);
  if (existing[0]) throw conflict(`书 ${slug} 已存在`);
  const dir = bookDir(deps, slug);
  if (await fs.stat(dir).then(() => true, () => false)) throw conflict(`目录 ${slug} 已存在`);

  if (parsed.flow === 'v3') return createBookV3(deps, parsed, slug, dir);

  const tier = parsed.tier ?? (await loadSystemSettings(deps.db)).defaultTier;
  const config: Record<string, unknown> = { slug, title: parsed.title, genre: parsed.genre, tier };
  if (parsed.scale) config.scale = parsed.scale;
  if (parsed.preset) config.routing = { preset: parsed.preset };
  if (parsed.approvals) config.approvals = parsed.approvals;
  const { commit } = await initBookRepo(dir, { config: config as never, premise: parsed.seed });
  const id = randomUUID();
  await deps.db.insert(books).values({ id, slug, title: parsed.title, genre: parsed.genre, status: 'draft', tier, headCommit: commit });
  await deps.db.insert(bookEvents).values({ bookId: id, kind: 'book.created', body: { slug, seed_chars: parsed.seed.length } });
  if (parsed.start) await deps.orchestrator.startBook(id, { interview: parsed.interview });
  deps.bus.publish({ type: 'book_changed', book: slug });
  const row = await bookBySlug(deps, slug);
  return (await summarize(deps, [row]))[0] as BookSummary;
}

/**
 * v3 开书（p1-plan §3 WP-C）：book.yaml 写 flow/v3/发布默认值，仓库用 v3 布局（seed.md、不入库的根 AGENTS.md）。
 * 书名可留空：用 '未命名·' 占位（与自动开书的 '待命名·' 不同，nameAutoBooks 不会碰），由作者在 bible.md 里起名（auto_title）。
 */
async function createBookV3(deps: AppDeps, parsed: z.output<typeof zCreateBook>, slug: string, dir: string): Promise<BookSummary> {
  const settings = await loadSystemSettings(deps.db);
  const len = parsed.v3?.length ?? 'medium';
  const target = parsed.v3?.target_cjk ?? settings.autoStart.lengths[len].targetCjk;
  const n0 = Math.max(1, Math.ceil(target / 4000));
  const batch = parsed.v3?.batch ?? 5;
  const typed = parsed.title.trim();
  const title = typed || `${V3_TITLE_PLACEHOLDER}${nanoid(6)}`;
  const maxBuffer = Math.max(15, 2 * batch);
  const config: Record<string, unknown> = {
    slug,
    title,
    genre: parsed.genre,
    tier: 'lite',
    flow: 'v3',
    v3: { length: len, target_cjk: target, planned_chapters: n0, planned_chapters_initial: n0, batch, min_chapter_cjk: parsed.v3?.min_chapter_cjk ?? 3000, auto_title: !typed },
    publish: { ...V3_PUBLISH_DEFAULTS, max_buffer: maxBuffer, resume_buffer: maxBuffer - 5 },
  };
  const { commit } = await initBookRepo(dir, { config: config as never, premise: parsed.seed, layout: 'v3' });
  const id = randomUUID();
  const meta = { v3: { hints: [], noChapterStreak: 0, emptyStreak: 0, finaleNoMarker: 0, lastBatchFrom: null, lastBatchAt: null, hintedShort: [], locked: [], pending: null } };
  await deps.db.insert(books).values({ id, slug, title, genre: parsed.genre, status: 'draft', tier: 'lite', headCommit: commit, meta });
  await deps.db.insert(bookEvents).values({ bookId: id, kind: 'book.created', body: { slug, seed_chars: parsed.seed.length, flow: 'v3' } });
  if (parsed.start) await deps.orchestrator.startBook(id, { interview: false });
  deps.bus.publish({ type: 'book_changed', book: slug });
  const row = await bookBySlug(deps, slug);
  return (await summarize(deps, [row]))[0] as BookSummary;
}

export async function deleteBook(deps: AppDeps, slug: string): Promise<void> {
  const book = await bookBySlug(deps, slug);
  await deps.db.update(books).set({ status: 'archived', pausedReason: 'deleting', updatedAt: new Date().toISOString() }).where(eq(books.id, book.id));
  const live = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, book.id), inArray(tasks.state, [...LIVE_TASK_STATES])));
  for (const t of live) await deps.orchestrator.cancelTask(t.id).catch(() => {});
  const active = await deps.db.select({ n: count() }).from(runs).where(and(eq(runs.bookId, book.id), inArray(runs.state, [...ACTIVE_RUN_STATES])));
  if (Number(active[0]?.n ?? 0) > 0) throw conflict('还有运行中的 run，已暂停并取消任务，请等它们结束后重试', 'runs_active');
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
  await fs.rm(bookDir(deps, slug), { recursive: true, force: true });
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
    const card = await files.card(no, head).catch(() => null);
    const update = { chapterId: chapterId(no), cjk, state: 'accepted', updatedAt: nowIso, ...(card ? { title: card.title, volume: card.volume, arc: card.arc } : {}) };
    const publishedAt = no <= pubThrough ? nowIso : null;
    await deps.db
      .insert(chapters)
      .values({ bookId: book.id, no, title: card?.title ?? `第${no}章`, volume: card?.volume ?? '', arc: card?.arc ?? '', ...update, publishedAt })
      .onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: update });
  }
  const cards = (await repo.list('plan/cards', { rev: head })).map((p) => Number(/c(\d{5})\.yaml$/.exec(p)?.[1] ?? 0));
  const cardsThrough = cards.length ? Math.max(...cards) : 0;
  await deps.db.update(books).set({ acceptedThrough, totalCjk, cursor: acceptedThrough + 1, cardsThrough, headCommit: head, publishedThrough: Math.max(book.publishedThrough, pubThrough), updatedAt: nowIso }).where(eq(books.id, book.id));
  deps.bus.publish({ type: 'book_changed', book: slug });
}

function frontiers(row: BookRow, bufferDays: number | null): Frontiers {
  return {
    accepted: row.acceptedThrough,
    audited: row.auditedThrough,
    published: row.publishedThrough,
    cardsPlanned: row.cardsThrough,
    buffer: Math.max(0, row.acceptedThrough - row.publishedThrough),
    bufferDays,
  };
}

export async function summarize(deps: Pick<AppDeps, 'db'>, rows: BookRow[]): Promise<BookSummary[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
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
    tier: row.tier as BookSummary['tier'],
    totalCjk: row.totalCjk,
    frontiers: frontiers(row, null),
    activeTasks: taskCount.get(row.id) ?? 0,
    waiting: waiting.get(row.id) ?? null,
    inboxOpen: inboxCount.get(row.id) ?? 0,
    updatedAt: row.updatedAt,
  }));
}

export async function listBookSummaries(deps: Pick<AppDeps, 'db'>): Promise<BookSummary[]> {
  const rows = await deps.db.select().from(books).orderBy(desc(books.updatedAt));
  return summarize(deps, rows);
}

export function commitRow(c: { sha: string; ts: string; subject: string; trailers: Record<string, string>; tags: string[] }): GitCommitRow {
  return { sha: c.sha, ts: c.ts, subject: c.subject, trailers: c.trailers, tags: c.tags };
}

export async function bookOverview(deps: AppDeps, row: BookRow): Promise<BookOverview> {
  const repo = openRepo(bookDir(deps, row.slug));
  const files = bookFiles(repo);
  const [{ config }, summary, log, debtList, current, state] = await Promise.all([
    files.config(),
    summarize(deps, [row]),
    repo.log({ limit: 10 }),
    files.debts().catch(() => []),
    deps.db.select().from(chapters).where(and(eq(chapters.bookId, row.id), notInArray(chapters.state, ['accepted', 'planned']))).orderBy(chapters.no).limit(1),
    loadBookState(bookDir(deps, row.slug)).catch(() => null),
  ]);
  const milestones = state ? milestoneStatus(state).map((m) => ({ id: m.id, at: m.at, done: m.done, position: row.acceptedThrough ? Math.min(1, m.at / row.acceptedThrough) : 0 })) : [];
  let currentChapter: BookOverview['currentChapter'] = null;
  if (current[0]) {
    const chId = chapterId(current[0].no);
    const task = await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, row.id), eq(tasks.target, chId), inArray(tasks.state, [...LIVE_TASK_STATES]))).limit(1);
    currentChapter = { no: current[0].no, state: current[0].state, taskId: task[0]?.id ?? null };
  }
  const open = debtList.filter((d) => d.status === 'open');
  const base = summary[0] as BookSummary;
  return {
    ...base,
    frontiers: frontiers(row, (await bufferState(deps.db, row.id, config.publish, 0)).bufferDays),
    config,
    writerProfile: row.writerProfile,
    currentChapter,
    milestones,
    debts: { forwardOpen: open.filter((d) => d.class === 'forward').length, metricOpen: open.filter((d) => d.class === 'metric').length, cap: config.policy.forward_debt_cap },
    recentCommits: log.items.map(commitRow),
    formatVersion: row.formatVersion,
  };
}

export async function publishOverview(deps: AppDeps, row: BookRow, cfgIn?: PublishConfig): Promise<PublishOverview> {
  let cfg = cfgIn;
  if (!cfg) cfg = (await bookFiles(openRepo(bookDir(deps, row.slug))).config()).config.publish;
  const state = await bufferState(deps.db, row.id, cfg, 0);
  let slots: string[] = [];
  try {
    slots = nextSlots(cfg, new Date(), 5);
  } catch {
    // cadence 配置错误由 PUT 校验提示
  }
  return {
    slug: row.slug,
    title: row.title,
    config: cfg,
    frontiers: frontiers(row, state.bufferDays),
    nextSlots: slots,
    paused: row.status === 'paused' || state.productionPaused,
    pausedReason: row.pausedReason,
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

