/** /api/admin/profiles*、/api/admin/routing/*（D2 修订；契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ActiveRouting, FeasibilityReport, Ok, Profile, RoutingPreset } from '@novelist/shared';
import { DEFAULT_PRESET_ID, zPatchProfile, zProfile, zPutActiveRouting, zRoutingPreset, zSystemSettings } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { books, profiles, routingPresets, settings } from '../../../db/schema.js';
import { effectiveRouting, loadSystemSettings } from '../../../orchestrator/index.js';
import { audit, domain, parseBody, parsePatch } from '../../helpers.js';
import { badRequest, conflict, forbidden, notFound } from '../../problem.js';

type IdParams = { Params: { id: string } };

async function loadActive(deps: AppDeps): Promise<{ presetId: string; overrides: Record<string, unknown> }> {
  const rows = await deps.db.select().from(settings).where(eq(settings.key, 'routing.active')).limit(1);
  const v = (rows[0]?.value ?? {}) as { presetId?: string; overrides?: Record<string, unknown> };
  return { presetId: v.presetId ?? DEFAULT_PRESET_ID, overrides: v.overrides ?? {} };
}

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // ── profiles ──
  app.get('/api/admin/profiles', async (): Promise<Profile[]> => {
    const rows = await deps.db.select().from(profiles).orderBy(profiles.id);
    return rows.map((r) => r.body as unknown as Profile);
  });

  app.post('/api/admin/profiles', async (req, reply) => {
    const body = parseBody(zProfile, req.body);
    if ((await deps.db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, body.id)).limit(1))[0]) throw conflict(`profile ${body.id} 已存在`);
    await deps.db.insert(profiles).values({ id: body.id, harness: body.harness, enabled: body.enabled, builtin: false, body: body as unknown as Record<string, unknown> });
    await audit(deps, req, 'profile.create', body.id);
    return reply.code(201).send(body);
  });

  app.patch<IdParams>('/api/admin/profiles/:id', async (req): Promise<Profile> => {
    const patch = parsePatch(zPatchProfile, req.body);
    const rows = await deps.db.select().from(profiles).where(eq(profiles.id, req.params.id)).limit(1);
    if (!rows[0]) throw notFound(`profile ${req.params.id} `);
    const next = zProfile.parse({ ...(rows[0].body as object), ...patch, id: rows[0].id });
    await deps.db.update(profiles).set({ harness: next.harness, enabled: next.enabled, body: next as unknown as Record<string, unknown>, updatedAt: new Date().toISOString() }).where(eq(profiles.id, next.id));
    await audit(deps, req, 'profile.patch', next.id);
    return next;
  });

  app.delete<IdParams>('/api/admin/profiles/:id', async (req): Promise<Ok> => {
    const rows = await deps.db.select().from(profiles).where(eq(profiles.id, req.params.id)).limit(1);
    if (!rows[0]) throw notFound(`profile ${req.params.id} `);
    if (rows[0].builtin) throw forbidden('内置 profile 不能删除，可以禁用', 'builtin_readonly');
    await deps.db.delete(profiles).where(eq(profiles.id, req.params.id));
    await audit(deps, req, 'profile.delete', req.params.id);
    return { ok: true };
  });

  // ── presets ──
  app.get('/api/admin/routing/presets', async (): Promise<RoutingPreset[]> => {
    const rows = await deps.db.select().from(routingPresets).orderBy(routingPresets.id);
    return rows
      .map((r) => ({ ...(r.body as unknown as RoutingPreset), builtin: r.builtin }))
      .filter((p) => p.id !== 'fake' || deps.config.allowFakeHarness)
      .map((p) => (p.id === 'dev-cheap' ? { ...p, name: `${p.name}（仅测试）` } : p))
      .sort((a, b) => Number(a.id === 'dev-cheap') - Number(b.id === 'dev-cheap'));
  });

  app.post('/api/admin/routing/presets', async (req, reply) => {
    const body = parseBody(zRoutingPreset, req.body);
    if ((await deps.db.select({ id: routingPresets.id }).from(routingPresets).where(eq(routingPresets.id, body.id)).limit(1))[0]) throw conflict(`preset ${body.id} 已存在`);
    const stored = { ...body, builtin: false };
    await deps.db.insert(routingPresets).values({ id: stored.id, name: stored.name, builtin: false, body: stored as unknown as Record<string, unknown> });
    await audit(deps, req, 'preset.create', stored.id);
    return reply.code(201).send(stored);
  });

  // 内置 preset 另存为副本 <id>-custom；返回的 id 可能与路径不同
  app.put<IdParams>('/api/admin/routing/presets/:id', async (req): Promise<RoutingPreset> => {
    const body = parseBody(zRoutingPreset, req.body);
    const rows = await deps.db.select().from(routingPresets).where(eq(routingPresets.id, req.params.id)).limit(1);
    if (!rows[0]) throw notFound(`preset ${req.params.id} `);
    const nowIso = new Date().toISOString();
    if (rows[0].builtin) {
      const copyId = `${req.params.id}-custom`;
      const stored = { ...body, id: copyId, builtin: false };
      await deps.db.insert(routingPresets).values({ id: copyId, name: stored.name, builtin: false, body: stored as unknown as Record<string, unknown>, updatedAt: nowIso }).onConflictDoUpdate({ target: routingPresets.id, set: { name: stored.name, body: stored as unknown as Record<string, unknown>, updatedAt: nowIso } });
      await audit(deps, req, 'preset.copy', copyId, { from: req.params.id });
      // 编辑正在生效的内置 preset：副本要接替它，否则用户的修改根本不生效
      const active = await loadActive(deps);
      if (active.presetId === req.params.id) {
        const value = { presetId: copyId, overrides: active.overrides };
        await deps.db.insert(settings).values({ key: 'routing.active', value, updatedAt: nowIso }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } });
        const sys = zSystemSettings.parse({ ...(await loadSystemSettings(deps.db)), activePreset: copyId });
        await deps.db.update(settings).set({ value: sys, updatedAt: nowIso }).where(eq(settings.key, 'system'));
      }
      return stored;
    }
    const stored = { ...body, id: req.params.id, builtin: false };
    await deps.db.update(routingPresets).set({ name: stored.name, body: stored as unknown as Record<string, unknown>, updatedAt: nowIso }).where(eq(routingPresets.id, stored.id));
    await audit(deps, req, 'preset.update', stored.id);
    return stored;
  });

  app.delete<IdParams>('/api/admin/routing/presets/:id', async (req): Promise<Ok> => {
    const rows = await deps.db.select().from(routingPresets).where(eq(routingPresets.id, req.params.id)).limit(1);
    if (!rows[0]) throw notFound(`preset ${req.params.id} `);
    if (rows[0].builtin) throw forbidden('内置 preset 不能删除', 'builtin_readonly');
    if ((await loadActive(deps)).presetId === req.params.id) throw conflict('该 preset 正在生效');
    await deps.db.delete(routingPresets).where(eq(routingPresets.id, req.params.id));
    await audit(deps, req, 'preset.delete', req.params.id);
    return { ok: true };
  });

  const activeView = async (): Promise<ActiveRouting> => {
    const a = await loadActive(deps);
    return { presetId: a.presetId, overrides: a.overrides, effective: await effectiveRouting(deps.db, null) };
  };

  app.get('/api/admin/routing/active', async (): Promise<ActiveRouting> => activeView());

  app.put('/api/admin/routing/active', async (req): Promise<ActiveRouting> => {
    const body = parseBody(zPutActiveRouting, req.body);
    if (!(await deps.db.select({ id: routingPresets.id }).from(routingPresets).where(eq(routingPresets.id, body.presetId)).limit(1))[0]) throw badRequest(`preset ${body.presetId} 不存在`);
    const nowIso = new Date().toISOString();
    const value = { presetId: body.presetId, overrides: body.overrides };
    await deps.db.insert(settings).values({ key: 'routing.active', value, updatedAt: nowIso }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } });
    const sys = zSystemSettings.parse({ ...(await loadSystemSettings(deps.db)), activePreset: body.presetId });
    await deps.db.update(settings).set({ value: sys, updatedAt: nowIso }).where(eq(settings.key, 'system'));
    await audit(deps, req, 'routing.active', body.presetId);
    return activeView();
  });

  app.post<{ Querystring: { book?: string } }>('/api/admin/routing/check', async (req): Promise<FeasibilityReport> => {
    let bookId: string | null = null;
    if (req.query.book) {
      const rows = await deps.db.select({ id: books.id }).from(books).where(eq(books.slug, req.query.book)).limit(1);
      if (!rows[0]) throw notFound(`书 ${req.query.book} `);
      bookId = rows[0].id;
    }
    return domain(() => deps.orchestrator.feasibility(bookId));
  });
}
