/** /api/admin/books/:slug/chapters*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import type { FastifyInstance } from 'fastify';
import type { Ok } from '@novelist/shared';
import { zChapterAction, zPageQuery, zPutChapterText } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { chapterDetail, chapterPage } from '../../../services/chapters.js';
import { saveChapterText } from '../../../services/repo-files.js';
import { audit, bookBySlug, domain, parseBody } from '../../helpers.js';
import { badRequest } from '../../problem.js';

type ChapterParams = { Params: { slug: string; no: string } };

const noOf = (raw: string): number => {
  const no = Number(raw);
  if (!Number.isInteger(no) || no <= 0) throw badRequest('章节号不合法');
  return no;
};

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Params: { slug: string }; Querystring: { cursor?: string; limit?: string } }>('/api/admin/books/:slug/chapters', async (req) => {
    const q = zPageQuery.parse(req.query);
    return chapterPage(deps, await bookBySlug(deps, req.params.slug), q.cursor, q.limit);
  });

  app.get<ChapterParams>('/api/admin/books/:slug/chapters/:no', async (req) => chapterDetail(deps, await bookBySlug(deps, req.params.slug), noOf(req.params.no)));

  app.put<ChapterParams>('/api/admin/books/:slug/chapters/:no/text', async (req, reply) => {
    const book = await bookBySlug(deps, req.params.slug);
    const no = noOf(req.params.no);
    const body = parseBody(zPutChapterText, req.body);
    const r = await saveChapterText(deps, book, no, body.text, body.baseSha, body.confirm);
    if (r.kind === 'needs_confirm') return reply.code(409).send(r.impact);
    await audit(deps, req, 'chapter.text', `${book.slug}:${no}`);
    return chapterDetail(deps, await bookBySlug(deps, book.slug), no);
  });

  app.post<ChapterParams>('/api/admin/books/:slug/chapters/:no/actions', async (req): Promise<Ok> => {
    const book = await bookBySlug(deps, req.params.slug);
    const no = noOf(req.params.no);
    const body = parseBody(zChapterAction, req.body);
    await domain(() => deps.orchestrator.chapterAction(book.id, no, body));
    await audit(deps, req, `chapter.action.${body.action}`, `${book.slug}:${no}`, body);
    return { ok: true };
  });
}
