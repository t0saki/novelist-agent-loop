/** /api/admin 下 books 相关路由（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { BookConfigDoc, BookQuality, GitCommitRow, ImpactEstimate, Ok, Page, PublishOverview, RepoEntry, RepoFile } from '@novelist/shared';
import { zBookAction, zCreateBook, zPageQuery, zPatchBook, zPublishConfig, zPublishNow, zPutBookConfig, zPutPublish, zPutRepoFile } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { bookFiles, openRepo } from '../../../book/index.js';
import { books } from '../../../db/schema.js';
import { assertPublishConfig } from '../../../services/publish-config.js';
import { bookOverview, commitRow, createBook, deleteBook, listBookSummaries, patchBookYaml, publishOverview, summarize } from '../../../services/books.js';
import { estimateImpact, listTree, readBookConfigDoc, readRepoFile, saveBookConfig, saveChapterText, saveRepoFile } from '../../../services/repo-files.js';
import { auditsList, bookQuality, planOverview, reviewsPage, stateView } from '../../../services/chapters.js';
import { audit, bookBySlug, bookDir, domain, parseBody, parsePatch, requireRel } from '../../helpers.js';
import { badRequest, conflict } from '../../problem.js';

type SlugParams = { Params: { slug: string } };

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/admin/books', async () => listBookSummaries(deps));

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
    if (body.title !== undefined && body.title !== book.title) {
      const title = body.title;
      await patchBookYaml(deps, book, openRepo(bookDir(deps, book.slug)), (doc) => doc.setIn(['title'], title), 'owner: rename book');
      await deps.db.update(books).set({ title, updatedAt: new Date().toISOString() }).where(eq(books.id, book.id));
    }
    if (body.status) {
      if (body.status === 'paused') await domain(() => deps.orchestrator.bookAction(book.id, { action: 'pause', confirm: false }));
      else if (body.status === 'active') await domain(() => deps.orchestrator.bookAction(book.id, { action: 'resume', confirm: false }));
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
    await domain(() => deps.orchestrator.bookAction(book.id, body));
    await audit(deps, req, `book.action.${body.action}`, book.slug, body);
    return { ok: true };
  });

  app.get<SlugParams>('/api/admin/books/:slug/config', async (req): Promise<BookConfigDoc> => {
    await bookBySlug(deps, req.params.slug);
    return readBookConfigDoc(openRepo(bookDir(deps, req.params.slug)));
  });

  app.put<SlugParams>('/api/admin/books/:slug/config', async (req): Promise<BookConfigDoc> => {
    const book = await bookBySlug(deps, req.params.slug);
    const body = parseBody(zPutBookConfig, req.body);
    const doc = await saveBookConfig(deps, book, openRepo(bookDir(deps, book.slug)), body.raw, body.baseSha);
    await audit(deps, req, 'book.config', book.slug);
    return doc;
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

  app.get<SlugParams & { Querystring: { all?: string } }>('/api/admin/books/:slug/plan', async (req) => planOverview(deps, await bookBySlug(deps, req.params.slug), { allCards: req.query.all === '1' }));

  app.get<SlugParams>('/api/admin/books/:slug/state', async (req) => stateView(deps, await bookBySlug(deps, req.params.slug)));

  app.get<SlugParams & { Querystring: { cursor?: string; limit?: string } }>('/api/admin/books/:slug/reviews', async (req) => {
    const q = zPageQuery.parse(req.query);
    return reviewsPage(deps, await bookBySlug(deps, req.params.slug), q.cursor, q.limit);
  });

  app.get<SlugParams>('/api/admin/books/:slug/audits', async (req) => auditsList(deps, await bookBySlug(deps, req.params.slug)));

  app.get<SlugParams>('/api/admin/books/:slug/debts', async (req) => {
    await bookBySlug(deps, req.params.slug);
    return bookFiles(openRepo(bookDir(deps, req.params.slug))).debts();
  });

  app.get<SlugParams>('/api/admin/books/:slug/feasibility', async (req) => {
    const book = await bookBySlug(deps, req.params.slug);
    return domain(() => deps.orchestrator.feasibility(book.id));
  });

  app.get<SlugParams>('/api/admin/books/:slug/quality', async (req): Promise<BookQuality> => bookQuality(deps, await bookBySlug(deps, req.params.slug)));

  app.get<SlugParams>('/api/admin/books/:slug/publish', async (req): Promise<PublishOverview> => publishOverview(deps, await bookBySlug(deps, req.params.slug)));

  app.put<SlugParams>('/api/admin/books/:slug/publish', async (req): Promise<PublishOverview> => {
    const book = await bookBySlug(deps, req.params.slug);
    const patch = parsePatch(zPutPublish, req.body);
    const repo = openRepo(bookDir(deps, book.slug));
    const cfg = (await bookFiles(repo).config()).config;
    const current = cfg.publish;
    const next = zPublishConfig.parse({ ...current, ...patch });
    assertPublishConfig(next, cfg.flow === 'v3' ? { batch: cfg.v3.batch } : undefined);
    await patchBookYaml(
      deps,
      book,
      repo,
      (doc) => {
        for (const [k, v] of Object.entries(patch)) doc.setIn(['publish', k], v);
      },
      'owner: edit publish config',
    );
    await audit(deps, req, 'book.publish_config', book.slug, patch);
    return publishOverview(deps, book, next);
  });

  app.post<SlugParams>('/api/admin/books/:slug/publish/now', async (req): Promise<Ok> => {
    const book = await bookBySlug(deps, req.params.slug);
    const body = parseBody(zPublishNow, req.body);
    if (book.acceptedThrough === 0) throw conflict('还没有已验收章节');
    await domain(() => deps.orchestrator.publishNow(book.id, body.through, body.ignoreAudit));
    await audit(deps, req, 'book.publish_now', book.slug, body);
    return { ok: true };
  });

}
