/** /api/admin/books/:slug/v3/*：新流程书的主人操作（契约见 @novelist/shared ROUTES；p2-plan §2.8、§3.2）。 */
import type { FastifyInstance } from 'fastify';
import type { V3ActionResult, V3BookView } from '@novelist/shared';
import { zV3AdoptDraft, zV3DiscardDraft, zV3OwnerMessage, zV3PendingAction, zV3Rewind, zV3Settings } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { notV3 } from '../../../flow/owner.js';
import { adoptDraft, discardDraft, pendingAction, setOwnerMessage } from '../../../services/v3-book.js';
import { saveV3Settings, v3BookView } from '../../../services/v3-view.js';
import { audit, bookBySlug, parseBody, type BookRow } from '../../helpers.js';

type SlugParams = { Params: { slug: string } };

/** 每个路由先认书：不是新流程的书一律 409 not_v3 */
async function v3Book(deps: AppDeps, slug: string): Promise<BookRow> {
  const row = await bookBySlug(deps, slug);
  const v3 = (row.meta as { v3?: unknown } | null)?.v3;
  if (v3 === undefined || v3 === null) throw notV3();
  return row;
}

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<SlugParams>('/api/admin/books/:slug/v3', async (req): Promise<V3BookView> => v3BookView(deps, await v3Book(deps, req.params.slug)));

  app.put<SlugParams>('/api/admin/books/:slug/v3/settings', async (req): Promise<V3BookView> => {
    const book = await v3Book(deps, req.params.slug);
    const body = parseBody(zV3Settings, req.body);
    await saveV3Settings(deps, book, body);
    await audit(deps, req, 'book.v3.settings', book.slug, body);
    return v3BookView(deps, await bookBySlug(deps, book.slug));
  });

  app.put<SlugParams>('/api/admin/books/:slug/v3/message', async (req): Promise<V3ActionResult> => {
    const book = await v3Book(deps, req.params.slug);
    const body = parseBody(zV3OwnerMessage, req.body);
    const r = await setOwnerMessage(deps, book, body.text);
    await audit(deps, req, 'book.v3.message', book.slug, { chars: body.text.length });
    return r;
  });

  app.post<SlugParams>('/api/admin/books/:slug/v3/drafts/adopt', async (req): Promise<V3ActionResult> => {
    const book = await v3Book(deps, req.params.slug);
    const body = parseBody(zV3AdoptDraft, req.body);
    const r = await adoptDraft(deps, book, body.path);
    await audit(deps, req, 'book.v3.adopt', book.slug, body);
    return r;
  });

  app.post<SlugParams>('/api/admin/books/:slug/v3/drafts/discard', async (req): Promise<V3ActionResult> => {
    const book = await v3Book(deps, req.params.slug);
    const body = parseBody(zV3DiscardDraft, req.body);
    const r = await discardDraft(deps, book, body.path);
    await audit(deps, req, 'book.v3.discard', book.slug, body);
    return r;
  });

  app.post<SlugParams>('/api/admin/books/:slug/v3/rewind', async (req): Promise<V3ActionResult> => {
    const book = await v3Book(deps, req.params.slug);
    const body = parseBody(zV3Rewind, req.body);
    const r = await deps.orchestrator.rewindV3(book.id, body.to, body.note ? { note: body.note } : {});
    await audit(deps, req, 'book.v3.rewind', book.slug, body);
    const head = r.to === 0 ? '已退回到开头' : `已回退到第 ${r.to} 章`;
    return { ok: true, detail: r.movedDir ? `${head}，后面的旧稿移到了 ${r.movedDir}/` : head };
  });

  app.post<SlugParams>('/api/admin/books/:slug/v3/pending', async (req): Promise<V3ActionResult> => {
    const book = await v3Book(deps, req.params.slug);
    const body = parseBody(zV3PendingAction, req.body);
    const r = await pendingAction(deps, book, body.action);
    await audit(deps, req, `book.v3.pending.${body.action}`, book.slug);
    return r;
  });
}
