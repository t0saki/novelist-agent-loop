/** /api/health 与 /api/auth/*（ROUTES）。Owner: lane G。 */
import type { FastifyInstance } from 'fastify';
import { zLoginRequest, type HealthResponse, type MeResponse, type Ok } from '@novelist/shared';
import { sql } from 'drizzle-orm';
import type { AppDeps } from '../../app.js';
import { login, logout } from '../auth.js';
import { parseBody } from '../helpers.js';

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/health', async (_req, reply): Promise<HealthResponse> => {
    let ok = true;
    try {
      await deps.db.execute(sql`select 1`);
    } catch {
      ok = false;
    }
    reply.code(ok ? 200 : 503);
    return { ok, version: deps.config.version, db: deps.dbh.kind, roles: deps.config.roles, time: new Date().toISOString() };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply): Promise<MeResponse> => {
    const body = parseBody(zLoginRequest, req.body);
    return login(deps, req, reply, body.password, body.remember);
  });

  app.post('/api/auth/logout', async (req, reply): Promise<Ok> => {
    await logout(deps, req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req): Promise<MeResponse> => {
    if (!req.auth) return { role: null, insecureCookies: deps.config.insecureCookies };
    return {
      role: req.auth.role,
      ...(req.auth.readerId ? { readerId: req.auth.readerId } : {}),
      ...(req.auth.label ? { label: req.auth.label } : {}),
      insecureCookies: deps.config.insecureCookies,
    };
  });
}
