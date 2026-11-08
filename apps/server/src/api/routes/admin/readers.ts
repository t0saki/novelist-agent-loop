/** /api/admin/readers*、/api/admin/pats*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CreatedPat, Ok, PatRow, ReaderAccount } from '@novelist/shared';
import { zCreatePat, zCreateReader, zPatchReader } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { pats, readers, readingProgress } from '../../../db/schema.js';
import { deleteSessionsForReaders, loadAdminSecret, sessionSecretOf, sha256hex } from '../../auth.js';
import { hashPassword, passwordLookupId, verifyPassword } from '../../../services/passwords.js';
import { audit, parseBody } from '../../helpers.js';
import { conflict, notFound } from '../../problem.js';

type IdParams = { Params: { id: string } };

const toView = (r: typeof readers.$inferSelect): ReaderAccount => ({ id: r.id, label: r.label, allowBooks: r.allowBooks ?? null, enabled: r.enabled, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, legacy: r.legacy });
const toPatRow = (p: typeof pats.$inferSelect): PatRow => ({ id: p.id, label: p.label, scopes: p.scopes, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, revokedAt: p.revokedAt });

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /** 单框登录要求密码互不相同：不能撞管理员密码，也不能撞别的读者 */
  const assertPasswordFree = async (password: string, exceptId?: string) => {
    const admin = await loadAdminSecret(deps);
    if (admin && (await verifyPassword(password, admin.pwHash)).ok) throw conflict('密码与管理员密码相同', 'password_taken');
    const lookupId = passwordLookupId(sessionSecretOf(deps), password);
    const rows = await deps.db.select({ id: readers.id }).from(readers).where(eq(readers.lookupId, lookupId));
    if (rows.some((r) => r.id !== exceptId)) throw conflict('已有读者使用这个密码', 'password_taken');
    return lookupId;
  };

  app.get('/api/admin/readers', async (): Promise<ReaderAccount[]> => {
    const rows = await deps.db.select().from(readers).orderBy(readers.createdAt);
    return rows.map(toView);
  });

  app.post('/api/admin/readers', async (req, reply) => {
    const body = parseBody(zCreateReader, req.body);
    const lookupId = await assertPasswordFree(body.password);
    const id = randomUUID();
    await deps.db.insert(readers).values({ id, label: body.label, lookupId, pwHash: await hashPassword(body.password), allowBooks: body.allowBooks });
    await audit(deps, req, 'reader.create', id);
    const row = (await deps.db.select().from(readers).where(eq(readers.id, id)).limit(1))[0] as typeof readers.$inferSelect;
    return reply.code(201).send(toView(row));
  });

  app.patch<IdParams>('/api/admin/readers/:id', async (req): Promise<ReaderAccount> => {
    const rows = await deps.db.select().from(readers).where(eq(readers.id, req.params.id)).limit(1);
    const r = rows[0];
    if (!r) throw notFound('读者');
    const body = parseBody(zPatchReader, req.body);
    const patch: Partial<typeof readers.$inferInsert> = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.allowBooks !== undefined) patch.allowBooks = body.allowBooks;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.password !== undefined) {
      patch.lookupId = await assertPasswordFree(body.password, r.id);
      patch.pwHash = await hashPassword(body.password);
      patch.legacy = false;
      patch.tokenVersion = r.tokenVersion + 1; // 改密码：作废旧会话
    }
    await deps.db.update(readers).set(patch).where(eq(readers.id, r.id));
    await audit(deps, req, 'reader.patch', r.id, { fields: Object.keys(patch) });
    return toView((await deps.db.select().from(readers).where(eq(readers.id, r.id)).limit(1))[0] as typeof readers.$inferSelect);
  });

  app.delete<IdParams>('/api/admin/readers/:id', async (req): Promise<Ok> => {
    await deps.db.delete(readingProgress).where(eq(readingProgress.readerId, req.params.id));
    await deleteSessionsForReaders(deps, [req.params.id]);
    await deps.db.delete(readers).where(eq(readers.id, req.params.id));
    await audit(deps, req, 'reader.delete', req.params.id);
    return { ok: true };
  });

  app.get('/api/admin/pats', async (): Promise<PatRow[]> => {
    const rows = await deps.db.select().from(pats).orderBy(desc(pats.createdAt));
    return rows.map(toPatRow);
  });

  app.post('/api/admin/pats', async (req, reply) => {
    const body = parseBody(zCreatePat, req.body);
    const token = `nvpat_${randomBytes(30).toString('base64url')}`;
    const id = randomUUID();
    await deps.db.insert(pats).values({ id, label: body.label, hash: sha256hex(token), scopes: body.scopes });
    await audit(deps, req, 'pat.create', id, { label: body.label });
    const row = (await deps.db.select().from(pats).where(eq(pats.id, id)).limit(1))[0] as typeof pats.$inferSelect;
    return reply.code(201).send({ ...toPatRow(row), token } satisfies CreatedPat);
  });

  app.delete<IdParams>('/api/admin/pats/:id', async (req): Promise<Ok> => {
    await deps.db.update(pats).set({ revokedAt: new Date().toISOString() }).where(and(eq(pats.id, req.params.id)));
    await audit(deps, req, 'pat.revoke', req.params.id);
    return { ok: true };
  });
}
