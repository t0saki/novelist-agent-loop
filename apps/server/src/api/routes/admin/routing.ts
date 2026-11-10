/**
 * /api/admin/profiles*、/api/admin/routing/slots*（契约见 @novelist/shared ROUTES）。
 * 路由只剩两个位置（写作 / 杂活），各有主、备一个 profile（DESIGN §7）。旧的 preset / active / check 路由已删除；routing.active 行留着不动（上一版镜像要读）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { HarnessId, Ok, Profile, RoutingSlotsView, SlotCanaryResult, SlotId } from '@novelist/shared';
import { SLOT_IDS, zAccount, zCapabilities, zPatchProfile, zProfile, zPutRoutingSlots } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { capabilities, profiles } from '../../../db/schema.js';
import { defaultCapabilities, detectInstalls, getAdapter, probeIsolation, resolveAccount, runDirectoryCanary } from '../../../harness/index.js';
import { loadSlots, loadSystemSettings, resolveSlot, saveSlots, slotStatus, toSlotStatus } from '../../../orchestrator/index.js';
import { audit, domain, parseBody, parsePatch } from '../../helpers.js';
import { badRequest, conflict, forbidden, notFound } from '../../problem.js';

type IdParams = { Params: { id: string } };

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
    const slots = await loadSlots(deps.db);
    const using = SLOT_IDS.filter((s) => slots[s].primary === req.params.id || slots[s].fallback === req.params.id);
    if (using.length) throw conflict(`profile ${req.params.id} 正用在路由位置（${using.join('、')}），先在模型页换掉`, 'profile_in_use');
    await deps.db.delete(profiles).where(eq(profiles.id, req.params.id));
    await audit(deps, req, 'profile.delete', req.params.id);
    return { ok: true };
  });

  // ── 路由位置（写作 / 杂活） ──
  const slotsView = async (): Promise<RoutingSlotsView> => {
    const [slots, status, rows] = await Promise.all([loadSlots(deps.db), slotStatus(deps.db, new Date(), { allowFakeHarness: deps.config.allowFakeHarness, forced: deps.config.fakeHarness }), deps.db.select().from(profiles).orderBy(profiles.id)]);
    return { slots, forced: deps.config.fakeHarness, status, profiles: rows.map((r) => r.body as unknown as Profile) };
  };

  app.get('/api/admin/routing/slots', async (): Promise<RoutingSlotsView> => slotsView());

  app.put('/api/admin/routing/slots', async (req): Promise<RoutingSlotsView> => {
    // fake 模式（NOVELIST_FAKE_HARNESS=1）下两个位置被强制成 fake：这时改了也不生效，直接拒绝；不是 fake 模式启动时照常可改
    if (deps.config.fakeHarness) throw conflict('fake 模式下两个位置都固定走 fake，不能修改', 'slots_forced');
    const body = parseBody(zPutRoutingSlots, req.body);
    const current = await loadSlots(deps.db);
    const known = new Set((await deps.db.select({ id: profiles.id }).from(profiles)).map((r) => r.id));
    for (const slot of SLOT_IDS) {
      const next = body[slot];
      if (next.primary && next.fallback && next.primary === next.fallback) throw badRequest(`${slot} 位置的主用和备用是同一个 profile`, 'same_profile');
      // 只检查改动了的 id：留着指向已删除 profile 的另一个位置，不挡住保存这一个
      for (const key of ['primary', 'fallback'] as const) {
        const id = next[key];
        if (id && id !== current[slot][key] && !known.has(id)) throw badRequest(`profile ${id} 不存在`, 'unknown_profile');
      }
    }
    await saveSlots(deps.db, body);
    await audit(deps, req, 'routing.slots', null, { writer: body.writer, utility: body.utility });
    return slotsView();
  });

  app.post<{ Params: { slot: string } }>('/api/admin/routing/slots/:slot/canary', async (req): Promise<SlotCanaryResult> => {
    const slot = req.params.slot as SlotId;
    if (!(SLOT_IDS as readonly string[]).includes(slot)) throw notFound(`路由位置 ${req.params.slot} `);
    const now = new Date();
    const route = await resolveSlot(deps.db, { slot, book: null, now, ignoreConcurrency: true, allowFakeHarness: deps.config.allowFakeHarness, forced: deps.config.fakeHarness });
    if (!route.profileObj || !route.harness) throw conflict(route.reason ?? '这个位置没有可用的模型', 'no_route');
    const harness = route.harness as HarnessId;
    const adapter = getAdapter(harness);
    const inst = (await detectInstalls(deps.config.harnessDir)).find((i) => i.id === harness);
    if (!inst) throw conflict(`${harness} 尚未安装`, 'harness_not_installed');
    const settingsNow = await loadSystemSettings(deps.db);
    const isolation = (await probeIsolation(settingsNow.isolation)).selected;
    const account = route.accountObj ?? zAccount.parse({ id: 'fake-default', harness, authMode: 'none' });
    const acct = await resolveAccount(account, deps.paths, deps.secrets);
    const capRows = await deps.db.select().from(capabilities).where(and(eq(capabilities.harness, harness), eq(capabilities.version, inst.version), eq(capabilities.isolation, isolation))).limit(1);
    const stored = capRows[0] ? zCapabilities.safeParse(capRows[0].body) : null;
    const base = stored?.success ? stored.data : defaultCapabilities(harness, inst.version, isolation);
    const scratchDir = await fs.mkdtemp(path.join(deps.paths.tmp, `canary-${slot}-`));
    try {
      const { caps, result } = await domain(() =>
        runDirectoryCanary(adapter, inst, acct, { isolation, scratchDir, live: true, model: route.model as string, ...(route.profileObj?.effort ? { effort: route.profileObj.effort } : {}) }, base),
      );
      const at = new Date().toISOString();
      await deps.db.insert(capabilities).values({ harness, version: inst.version, isolation, body: caps as unknown as Record<string, unknown>, verifiedAt: at }).onConflictDoUpdate({ target: [capabilities.harness, capabilities.version, capabilities.isolation], set: { body: caps as unknown as Record<string, unknown>, verifiedAt: at } });
      await audit(deps, req, 'routing.slots.canary', slot, { profile: route.profile, ok: result.ok });
      return { status: toSlotStatus(route), caps, result };
    } finally {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
