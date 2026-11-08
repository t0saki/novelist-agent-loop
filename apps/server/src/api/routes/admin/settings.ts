/** /api/admin/settings、system、doctor、events（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DoctorReport, Ok, SseEvent, SystemInfo, SystemSettings } from '@novelist/shared';
import { zChangeAdminPassword, zPutSettings, zSystemSettings } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { routingPresets, settings } from '../../../db/schema.js';
import { loadSystemSettings } from '../../../orchestrator/index.js';
import { runDoctor } from '../../../services/doctor.js';
import { changeAdminPassword } from '../../auth.js';
import { audit, parseBody, parsePatch } from '../../helpers.js';
import { badRequest } from '../../problem.js';
import { openSse } from '../../sse.js';

/** 全局流默认不含高频事件（run_event/login_output 走各自的 stream），?verbose=1 全量 */
const HIGH_VOLUME: ReadonlySet<SseEvent['type']> = new Set(['run_event', 'login_output']);

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/admin/settings', async (): Promise<SystemSettings> => loadSystemSettings(deps.db));

  app.put('/api/admin/settings', async (req): Promise<SystemSettings> => {
    const patch = parsePatch(zPutSettings, req.body);
    const current = await loadSystemSettings(deps.db);
    const next = zSystemSettings.parse({ ...current, ...patch });
    if (next.activePreset !== current.activePreset) {
      const exists = await deps.db.select({ id: routingPresets.id }).from(routingPresets).where(eq(routingPresets.id, next.activePreset)).limit(1);
      if (!exists[0]) throw badRequest(`preset ${next.activePreset} 不存在`);
      const nowIso = new Date().toISOString();
      const value = { presetId: next.activePreset, overrides: {} };
      await deps.db.insert(settings).values({ key: 'routing.active', value, updatedAt: nowIso }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } });
    }
    const nowIso = new Date().toISOString();
    await deps.db.insert(settings).values({ key: 'system', value: next, updatedAt: nowIso }).onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: nowIso } });
    await audit(deps, req, 'settings.update', 'system', { fields: Object.keys(patch) });
    return next;
  });

  app.put('/api/admin/settings/admin-password', async (req): Promise<Ok> => {
    const body = parseBody(zChangeAdminPassword, req.body);
    await changeAdminPassword(deps, req, body.current, body.next);
    await audit(deps, req, 'admin.password', null);
    return { ok: true };
  });

  app.get('/api/admin/system', async (): Promise<SystemInfo> => ({
    version: deps.config.version,
    node: process.versions.node,
    arch: process.arch,
    platform: process.platform,
    dataDir: deps.paths.root,
    roles: deps.config.roles,
    uptimeSec: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
    settings: await loadSystemSettings(deps.db),
  }));

  app.get<{ Querystring: { refresh?: string } }>('/api/admin/doctor', async (req): Promise<DoctorReport> => runDoctor(deps, { refresh: req.query.refresh === '1', requestProtocol: req.protocol === 'https' ? 'https' : 'http' }));

  app.get<{ Querystring: { verbose?: string } }>('/api/admin/events', async (req, reply) => {
    const sse = openSse(reply);
    sse.send({ type: 'hello', ts: new Date().toISOString() });
    const verbose = req.query.verbose === '1';
    const unsubscribe = deps.bus.subscribe(
      (e) => sse.send(e),
      (e) => verbose || !HIGH_VOLUME.has(e.type),
    );
    sse.onClose(unsubscribe);
  });
}
