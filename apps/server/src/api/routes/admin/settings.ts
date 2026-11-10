/** /api/admin/settings、system、doctor、events（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import type { FastifyInstance } from 'fastify';
import type { DoctorReport, Ok, SseEvent, SystemInfo, SystemSettingsView } from '@novelist/shared';
import { zChangeAdminPassword } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { loadSystemSettings } from '../../../orchestrator/index.js';
import { runDoctor } from '../../../services/doctor.js';
import { putSettings, readSettingsView } from '../../../services/settings.js';
import { changeAdminPassword } from '../../auth.js';
import { audit, parseBody } from '../../helpers.js';
import { openSse } from '../../sse.js';

/** 全局流默认不含高频事件（run_event/login_output 走各自的 stream），?verbose=1 全量 */
const HIGH_VOLUME: ReadonlySet<SseEvent['type']> = new Set(['run_event', 'login_output']);

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/admin/settings', async (): Promise<SystemSettingsView> => readSettingsView(deps));

  // 按节合并 + baseUpdatedAt（services/settings.ts）；activePreset 只剩旧设置页在发：不再读、不再镜像到 routing.active
  app.put('/api/admin/settings', async (req): Promise<SystemSettingsView> => {
    const { view, fields } = await putSettings(deps, req.body);
    await audit(deps, req, 'settings.update', 'system', { fields });
    return view;
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
