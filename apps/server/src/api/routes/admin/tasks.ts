/** /api/admin/tasks*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ErrorClass, Ok, Page, TaskKind, TaskRow, TaskState } from '@novelist/shared';
import { zPageQuery } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { books, tasks } from '../../../db/schema.js';
import { audit, decodeCursor, domain, encodeCursor } from '../../helpers.js';

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Querystring: { cursor?: string; limit?: string; book?: string; state?: string; kind?: string } }>('/api/admin/tasks', async (req): Promise<Page<TaskRow>> => {
    const q = zPageQuery.parse(req.query);
    const where: SQL[] = [];
    let bookId: string | null = null;
    if (req.query.book) {
      const b = await deps.db.select({ id: books.id }).from(books).where(eq(books.slug, req.query.book)).limit(1);
      bookId = b[0]?.id ?? '__none__';
      where.push(eq(tasks.bookId, bookId));
    }
    if (req.query.state) where.push(eq(tasks.state, req.query.state));
    if (req.query.kind) where.push(eq(tasks.kind, req.query.kind));
    const cur = decodeCursor(q.cursor);
    if (cur) {
      const [ts, id] = cur as [string, string];
      where.push(or(lt(tasks.updatedAt, ts), and(eq(tasks.updatedAt, ts), lt(tasks.id, id))) as SQL);
    }
    const rows = await deps.db.select().from(tasks).where(where.length ? and(...where) : undefined).orderBy(desc(tasks.updatedAt), desc(tasks.id)).limit(q.limit + 1);
    const slugs = new Map((await deps.db.select({ id: books.id, slug: books.slug }).from(books)).map((b) => [b.id, b.slug]));
    const items: TaskRow[] = rows.slice(0, q.limit).map((t) => ({
      id: t.id,
      bookSlug: t.bookId ? (slugs.get(t.bookId) ?? null) : null,
      kind: t.kind as TaskKind,
      target: t.target,
      lane: t.lane,
      tier: t.tier,
      state: t.state as TaskState,
      priority: t.priority,
      attempts: t.attempts,
      maxAttempts: t.maxAttempts,
      lastErrorClass: t.lastErrorClass as ErrorClass | null,
      notBefore: t.notBefore,
      waitReason: t.waitReason,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
    const last = rows[q.limit - 1];
    return { items, nextCursor: rows.length > q.limit && last ? encodeCursor([last.updatedAt, last.id]) : null };
  });

  app.post<{ Params: { id: string } }>('/api/admin/tasks/:id/retry', async (req): Promise<Ok> => {
    await domain(() => deps.orchestrator.retryTask(req.params.id));
    await audit(deps, req, 'task.retry', req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/tasks/:id/cancel', async (req): Promise<Ok> => {
    await domain(() => deps.orchestrator.cancelTask(req.params.id));
    await audit(deps, req, 'task.cancel', req.params.id);
    return { ok: true };
  });
}
