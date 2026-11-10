/** /api/reader/*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, count, desc, eq, inArray, isNotNull, max, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ok, ReaderBookCard, ReaderBookDetail, ReaderChapter, ReaderVolume } from '@novelist/shared';
import { zProgressPut } from '@novelist/shared';
import type { AppDeps } from '../../app.js';
import { bookFiles, openRepo } from '../../book/index.js';
import { books, chapters, readers, readingProgress } from '../../db/schema.js';
import { collectManuscripts } from '../../services/books.js';
import { assertBookDir, buildEpub, buildTxt, collectExport } from '../../services/export.js';
import { loadSystemSettings } from '../../orchestrator/index.js';
import { bookBySlug, bookDir, type BookRow, parseBody } from '../helpers.js';
import { HttpProblem, badRequest, notFound } from '../problem.js';

const COVER_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

async function coverFile(deps: AppDeps, slug: string): Promise<{ file: string; type: string } | null> {
  for (const ext of Object.keys(COVER_EXT)) {
    const file = path.join(deps.paths.media, slug, `cover${ext}`);
    if (await fs.stat(file).then(() => true, () => false)) return { file, type: COVER_EXT[ext] as string };
  }
  return null;
}

const readerKey = (req: FastifyRequest): string => req.auth?.readerId ?? 'admin';

/** 读者可见范围：allow_books 显式列表；NULL 走系统默认 defaultVisibility */
async function visibleFilter(deps: AppDeps, req: FastifyRequest): Promise<((row: BookRow) => boolean)> {
  if (req.auth?.role === 'admin') return () => true;
  const rows = await deps.db.select({ allow: readers.allowBooks }).from(readers).where(eq(readers.id, req.auth?.readerId as string)).limit(1);
  const allow = rows[0]?.allow ?? null;
  if (allow !== null) {
    const set = new Set(allow);
    return (row) => set.has(row.slug);
  }
  const settings = await loadSystemSettings(deps.db);
  return () => settings.readers.defaultVisibility === 'all';
}

async function requireVisibleBook(deps: AppDeps, req: FastifyRequest, slug: string): Promise<BookRow> {
  const book = await bookBySlug(deps, slug);
  if (!(await visibleFilter(deps, req))(book)) throw notFound(`书 ${slug} `);
  return book;
}

async function blurbOf(deps: AppDeps, book: BookRow): Promise<string> {
  const meta = book.meta as { blurb?: string };
  if (meta.blurb) return meta.blurb;
  const config = await bookFiles(openRepo(bookDir(deps, book.slug))).config().catch(() => null);
  return config?.config.blurb ?? '';
}

async function progressOf(deps: AppDeps, req: FastifyRequest, bookId: string): Promise<{ ch: number; scroll: number } | null> {
  const rows = await deps.db.select().from(readingProgress).where(and(eq(readingProgress.readerId, readerKey(req)), eq(readingProgress.bookId, bookId))).limit(1);
  return rows[0] ? { ch: rows[0].no, scroll: rows[0].scroll } : null;
}

async function bookCards(deps: AppDeps, req: FastifyRequest, rows: BookRow[]): Promise<ReaderBookCard[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const stats = await deps.db
    .select({ bookId: chapters.bookId, n: count(), cjk: sql<number>`coalesce(sum(${chapters.cjk}), 0)::int`, last: max(chapters.publishedAt) })
    .from(chapters)
    .where(and(inArray(chapters.bookId, ids), isNotNull(chapters.publishedAt)))
    .groupBy(chapters.bookId);
  const statOf = new Map(stats.map((s) => [s.bookId, s]));
  const progress = await deps.db.select().from(readingProgress).where(and(eq(readingProgress.readerId, readerKey(req)), inArray(readingProgress.bookId, ids)));
  const progressOfBook = new Map(progress.map((p) => [p.bookId, p]));
  const out: ReaderBookCard[] = [];
  for (const row of rows) {
    const s = statOf.get(row.id);
    if (!s || Number(s.n) === 0) continue; // 没有已发布章节的书不进书库
    const p = progressOfBook.get(row.id);
    const cover = await coverFile(deps, row.slug);
    out.push({
      slug: row.slug,
      title: row.title,
      genre: row.genre,
      blurb: await blurbOf(deps, row),
      status: row.status as ReaderBookCard['status'],
      publishedChapters: Number(s.n),
      publishedCjk: Number(s.cjk),
      lastPublishedAt: s.last ?? null,
      coverUrl: cover ? `/api/reader/books/${row.slug}/cover` : null,
      progress: p ? { ch: p.no, scroll: p.scroll } : null,
    });
  }
  return out;
}

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/reader/books', async (req): Promise<ReaderBookCard[]> => {
    const visible = await visibleFilter(deps, req);
    const rows = (await deps.db.select().from(books).orderBy(desc(books.updatedAt))).filter(visible);
    return bookCards(deps, req, rows);
  });

  app.get<{ Params: { slug: string } }>('/api/reader/books/:slug', async (req): Promise<ReaderBookDetail> => {
    const book = await requireVisibleBook(deps, req, req.params.slug);
    const cards = await bookCards(deps, req, [book]);
    const card = cards[0];
    if (!card) throw notFound(`书 ${book.slug} `);
    const rows = await deps.db.select().from(chapters).where(and(eq(chapters.bookId, book.id), isNotNull(chapters.publishedAt))).orderBy(asc(chapters.no));
    // 卷标题来自 chapters.volume_title（旧书在开机迁移 / 导入时从 plan/volumes 回填）；没有标题就显示卷 id
    const grouped: ReaderVolume[] = [];
    for (const c of rows) {
      let g = grouped[grouped.length - 1];
      if (!g || g.id !== c.volume) {
        g = { id: c.volume, title: c.volumeTitle || c.volume, chapters: [] };
        grouped.push(g);
      }
      g.chapters.push({ no: c.no, id: c.chapterId, title: c.title, cjk: c.cjk, publishedAt: c.publishedAt as string });
    }
    return { ...card, volumes: grouped };
  });

  app.get<{ Params: { slug: string; no: string } }>('/api/reader/books/:slug/chapters/:no', async (req): Promise<ReaderChapter> => {
    const book = await requireVisibleBook(deps, req, req.params.slug);
    const no = Number(req.params.no);
    if (!Number.isInteger(no) || no <= 0) throw badRequest('章节号不合法');
    const rows = await deps.db.select().from(chapters).where(and(eq(chapters.bookId, book.id), eq(chapters.no, no))).limit(1);
    const row = rows[0];
    if (!row?.publishedAt) throw notFound(`第 ${no} 章`);
    await assertBookDir(deps, book.slug);
    const repo = openRepo(bookDir(deps, book.slug));
    // v3 书的首行是“# 第N章 标题”（标题另有字段），读者端去掉；v2 和导入的书保持原样
    const v3 = (await bookFiles(repo).config().catch(() => null))?.config.flow === 'v3';
    const text = (await collectManuscripts(repo, [no], v3 ? { stripTitle: true } : undefined)).get(no);
    if (text === undefined) throw notFound(`第 ${no} 章正文`);
    const neighbors = await deps.db.select({ no: chapters.no }).from(chapters).where(and(eq(chapters.bookId, book.id), isNotNull(chapters.publishedAt))).orderBy(asc(chapters.no));
    const idx = neighbors.findIndex((n) => n.no === no);
    return {
      slug: book.slug,
      no,
      id: row.chapterId,
      title: row.title,
      volumeTitle: row.volumeTitle || row.volume,
      text,
      cjk: row.cjk,
      publishedAt: row.publishedAt,
      revisedAt: row.revisedAt,
      prev: idx > 0 ? (neighbors[idx - 1]?.no ?? null) : null,
      next: idx >= 0 && idx < neighbors.length - 1 ? (neighbors[idx + 1]?.no ?? null) : null,
    };
  });

  app.get<{ Params: { slug: string } }>('/api/reader/books/:slug/progress', async (req) => {
    const book = await requireVisibleBook(deps, req, req.params.slug);
    return progressOf(deps, req, book.id);
  });

  app.put<{ Params: { slug: string } }>('/api/reader/books/:slug/progress', async (req): Promise<Ok> => {
    const book = await requireVisibleBook(deps, req, req.params.slug);
    const body = parseBody(zProgressPut, req.body);
    const nowIso = new Date().toISOString();
    await deps.db
      .insert(readingProgress)
      .values({ readerId: readerKey(req), bookId: book.id, no: body.ch, scroll: body.scroll, updatedAt: nowIso })
      .onConflictDoUpdate({ target: [readingProgress.readerId, readingProgress.bookId], set: { no: body.ch, scroll: body.scroll, updatedAt: nowIso } });
    return { ok: true };
  });

  const exportOpts = async (req: FastifyRequest<{ Params: { slug: string }; Querystring: { vol?: string; scope?: string } }>) => {
    const book = await requireVisibleBook(deps, req, req.params.slug);
    if (req.query.scope === 'accepted' && req.auth?.role !== 'admin') throw new HttpProblem(403, 'forbidden', '需要管理员权限');
    const published = req.query.scope !== 'accepted';
    const cover = await coverFile(deps, book.slug);
    const coverBytes = cover ? await fs.readFile(cover.file).catch(() => undefined) : undefined;
    return { book, opts: { published, volume: req.query.vol, author: 'Novelist', blurb: await blurbOf(deps, book), cover: coverBytes } };
  };

  const attachment = (name: string) => `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(name)}`;

  app.get<{ Params: { slug: string }; Querystring: { vol?: string; scope?: string } }>('/api/reader/books/:slug/export.epub', async (req, reply) => {
    const { book, opts } = await exportOpts(req);
    const data = await collectExport(deps, book, opts);
    if (data.chapters.length === 0) throw notFound('可导出的章节');
    const epub = await buildEpub(data);
    return reply.header('content-disposition', attachment(`${data.title}.epub`)).type('application/epub+zip').send(epub);
  });

  app.get<{ Params: { slug: string }; Querystring: { vol?: string; scope?: string } }>('/api/reader/books/:slug/export.txt', async (req, reply) => {
    const { book, opts } = await exportOpts(req);
    const data = await collectExport(deps, book, opts);
    if (data.chapters.length === 0) throw notFound('可导出的章节');
    return reply.header('content-disposition', attachment(`${data.title}.txt`)).type('text/plain; charset=utf-8').send(buildTxt(data));
  });

  app.get<{ Params: { slug: string } }>('/api/reader/books/:slug/cover', async (req, reply) => {
    const book = await requireVisibleBook(deps, req, req.params.slug);
    const cover = await coverFile(deps, book.slug);
    if (!cover) throw notFound('封面');
    return reply.header('cache-control', 'private, max-age=3600').type(cover.type).send(await fs.readFile(cover.file));
  });
}
