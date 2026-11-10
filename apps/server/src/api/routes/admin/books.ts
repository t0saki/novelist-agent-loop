/** /api/admin 下 books 相关路由（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { GitCommitRow, ImpactEstimate, Ok, Page, RepoEntry, RepoFile, TakeoverDefaults } from '@novelist/shared';
import { zBookAction, zCreateBook, zPageQuery, zPatchBook, zPublishNow, zPutRepoFile, zTakeover } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { isV3Meta, openRepo } from '../../../book/index.js';
import { books } from '../../../db/schema.js';
import { BOOK_FILTERS, type BookFilter, bookOverview, commitRow, createBook, deleteBook, listBookSummaries, patchBookYaml, reindexBook, summarize } from '../../../services/books.js';
import { estimateImpact, listTree, readRepoFile, saveChapterText, saveRepoFile } from '../../../services/repo-files.js';
import { takeOverBook, takeoverDefaults } from '../../../services/takeover.js';
import { audit, bookBySlug, bookDir, domain, parseBody, requireRel } from '../../helpers.js';
import { HttpProblem, badRequest, conflict } from '../../problem.js';

type SlugParams = { Params: { slug: string } };

/** 旧书能写的只有正文和 notes/（主人在接手前可以先做批注，P3 D26）；别的路径只读 */
const LEGACY_WRITABLE = /^(manuscript\/c\d{5}\.md|notes\/.+)$/;
const legacyReadOnly = (rel: string) => new HttpProblem(409, 'legacy_read_only', `旧书的 ${rel} 只读；先接手这本书再改`);

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Querystring: { filter?: string } }>('/api/admin/books', async (req) => {
    const filter = req.query.filter ?? 'active';
    if (!(BOOK_FILTERS as readonly string[]).includes(filter)) throw badRequest(`filter 只能是 ${BOOK_FILTERS.join(' / ')}`);
    return listBookSummaries(deps, { filter: filter as BookFilter });
  });

  app.post('/api/admin/books', async (req, reply) => {
    const body = parseBody(zCreateBook, req.body);
    const created = await createBook(deps, body);
    await audit(deps, req, 'book.create', created.slug);
    return reply.code(201).send(created);
  });

  app.get<SlugParams>('/api/admin/books/:slug', async (req) => bookOverview(deps, await bookBySlug(deps, req.params.slug)));

  app.patch<SlugParams>('/api/admin/books/:slug', async (req) => {
    const book = await bookBySlug(deps, req.params.slug);
    const body = parseBody(zPatchBook, req.body);
    // 旧书只能改书名（状态的变化都要经过接手）
    if (body.status && !isV3Meta(book.meta)) throw new HttpProblem(409, 'legacy_book', '旧书不能改状态；先在书页点“接手”');
    if (body.title !== undefined && body.title !== book.title) {
      const title = body.title;
      await patchBookYaml(deps, book, openRepo(bookDir(deps, book.slug)), (doc) => doc.setIn(['title'], title), 'owner: rename book');
      await deps.db.update(books).set({ title, updatedAt: new Date().toISOString() }).where(eq(books.id, book.id));
    }
    if (body.status) {
      if (body.status === 'paused') await domain(() => deps.orchestrator.bookAction(book.id, { action: 'pause' }));
      else if (body.status === 'active') await domain(() => deps.orchestrator.bookAction(book.id, { action: 'resume' }));
      else await deps.db.update(books).set({ status: 'archived', archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(eq(books.id, book.id));
    }
    await audit(deps, req, 'book.patch', book.slug, body);
    return (await summarize(deps, [await bookBySlug(deps, book.slug)]))[0];
  });

  app.delete<SlugParams & { Querystring: { confirm?: string } }>('/api/admin/books/:slug', async (req): Promise<Ok> => {
    if (req.query.confirm !== req.params.slug) throw badRequest('需要 ?confirm=<slug> 二次确认');
    await deleteBook(deps, req.params.slug);
    await audit(deps, req, 'book.delete', req.params.slug);
    return { ok: true };
  });

  app.post<SlugParams>('/api/admin/books/:slug/actions', async (req): Promise<Ok> => {
    const book = await bookBySlug(deps, req.params.slug);
    const body = parseBody(zBookAction, req.body);
    // 重建索引不经过编排器（旧书也能做）：直接从书库 git 重建 books/chapters 行
    if (body.action === 'reindex') await reindexBook(deps, book.slug);
    else await domain(() => deps.orchestrator.bookAction(book.id, body));
    await audit(deps, req, `book.action.${body.action}`, book.slug, body);
    return { ok: true };
  });

  /** 接手旧书（services/takeover.ts）：GET 给对话框的默认值，POST 接手（可重入；新流程的书 409 not_legacy） */
  app.get<SlugParams>('/api/admin/books/:slug/takeover', async (req): Promise<TakeoverDefaults> => takeoverDefaults(deps, await bookBySlug(deps, req.params.slug)));

  app.post<SlugParams>('/api/admin/books/:slug/takeover', async (req) => {
    const book = await bookBySlug(deps, req.params.slug);
    const body = parseBody(zTakeover, req.body);
    const summary = await takeOverBook(deps, book, body);
    await audit(deps, req, 'book.takeover', book.slug, body);
    return summary;
  });

  app.get<SlugParams & { Querystring: { dir?: string } }>('/api/admin/books/:slug/tree', async (req): Promise<RepoEntry[]> => {
    await bookBySlug(deps, req.params.slug);
    return listTree(deps, req.params.slug, req.query.dir);
  });

  app.get<SlugParams & { Querystring: { path?: string } }>('/api/admin/books/:slug/file', async (req): Promise<RepoFile> => {
    await bookBySlug(deps, req.params.slug);
    return readRepoFile(openRepo(bookDir(deps, req.params.slug)), requireRel(req.query.path));
  });

  app.put<SlugParams>('/api/admin/books/:slug/file', async (req, reply) => {
    const book = await bookBySlug(deps, req.params.slug);
    const body = parseBody(zPutRepoFile, req.body);
    if (!isV3Meta(book.meta) && !LEGACY_WRITABLE.test(requireRel(body.path))) throw legacyReadOnly(body.path);
    const manuscript = /^manuscript\/c(\d{5})\.md$/.exec(body.path);
    if (manuscript) {
      const r = await saveChapterText(deps, book, Number(manuscript[1]), body.content, body.baseSha, body.confirm);
      if (r.kind === 'needs_confirm') return reply.code(409).send(r.impact);
      await audit(deps, req, 'book.file', book.slug, { path: body.path });
      return readRepoFile(openRepo(bookDir(deps, book.slug)), body.path);
    }
    const r = await saveRepoFile(deps, book, { path: body.path, content: body.content, baseSha: body.baseSha, message: body.message, confirm: body.confirm });
    if (r.kind === 'needs_confirm') return reply.code(409).send(r.impact);
    await audit(deps, req, 'book.file', book.slug, { path: body.path });
    return r.file;
  });

  app.post<SlugParams>('/api/admin/books/:slug/file/impact', async (req): Promise<ImpactEstimate> => {
    const book = await bookBySlug(deps, req.params.slug);
    const body = parseBody(zPutRepoFile, req.body);
    return estimateImpact(deps, book, openRepo(bookDir(deps, book.slug)), requireRel(body.path));
  });

  app.get<SlugParams & { Querystring: { cursor?: string; limit?: string; path?: string } }>('/api/admin/books/:slug/git/log', async (req): Promise<Page<GitCommitRow>> => {
    await bookBySlug(deps, req.params.slug);
    const q = zPageQuery.parse(req.query);
    const repo = openRepo(bookDir(deps, req.params.slug));
    const log = await repo.log({ limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}), ...(req.query.path ? { path: requireRel(req.query.path) } : {}) });
    return { items: log.items.map(commitRow), nextCursor: log.nextCursor };
  });

  app.post<SlugParams>('/api/admin/books/:slug/publish/now', async (req): Promise<Ok> => {
    const book = await bookBySlug(deps, req.params.slug);
    const body = parseBody(zPublishNow, req.body);
    if (book.acceptedThrough === 0) throw conflict('还没有已验收章节');
    if (!isV3Meta(book.meta)) throw new HttpProblem(409, 'legacy_book', '旧书不能发布；先在书页点“接手”');
    await domain(() => deps.orchestrator.publishNow(book.id, body.through, body.ignoreAudit));
    await audit(deps, req, 'book.publish_now', book.slug, body);
    return { ok: true };
  });

}
