/** /api/admin/inbox*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { InboxItem, Page } from '@novelist/shared';
import { zInboxAct, zPageQuery } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { books, inbox } from '../../../db/schema.js';
import { audit, decodeCursor, domain, encodeCursor, parseBody } from '../../helpers.js';

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Querystring: { cursor?: string; limit?: string; state?: string; book?: string } }>('/api/admin/inbox', async (req): Promise<Page<InboxItem>> => {
    const q = zPageQuery.parse(req.query);
    const where: SQL[] = [];
    if (req.query.state) where.push(eq(inbox.state, req.query.state));
    if (req.query.book) {
      const b = await deps.db.select({ id: books.id }).from(books).where(eq(books.slug, req.query.book)).limit(1);
      where.push(eq(inbox.bookId, b[0]?.id ?? '__none__'));
    }
    const cur = decodeCursor(q.cursor);
    if (cur) {
      const [ts, id] = cur as [string, string];
      where.push(or(lt(inbox.createdAt, ts), and(eq(inbox.createdAt, ts), lt(inbox.id, id))) as SQL);
    }
    const rows = await deps.db.select().from(inbox).where(where.length ? and(...where) : undefined).orderBy(desc(inbox.createdAt), desc(inbox.id)).limit(q.limit + 1);
    const slugs = new Map((await deps.db.select({ id: books.id, slug: books.slug }).from(books)).map((b) => [b.id, b.slug]));
    const items: InboxItem[] = rows.slice(0, q.limit).map((r) => ({
      id: r.id,
      bookSlug: r.bookId ? (slugs.get(r.bookId) ?? null) : null,
      kind: r.kind as InboxItem['kind'],
      title: r.title,
      body: r.body,
      state: r.state as InboxItem['state'],
      actions: r.actions as InboxItem['actions'],
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      timeoutAt: r.timeoutAt,
    }));
    const last = rows[q.limit - 1];
    return { items, nextCursor: rows.length > q.limit && last ? encodeCursor([last.createdAt, last.id]) : null };
  });

  app.post<{ Params: { id: string } }>('/api/admin/inbox/:id/act', async (req): Promise<InboxItem> => {
    const body = parseBody(zInboxAct, req.body);
    const item = await domain(() => deps.orchestrator.actInbox(req.params.id, body.action, body.note, body.payload));
    await audit(deps, req, `inbox.${body.action}`, req.params.id);
    return item;
  });
}
