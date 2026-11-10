/** /api/admin/harness*（契约见 @novelist/shared ROUTES）+ 安装（POST /api/admin/harness/:id/install，§3.8）。Owner: lane G。 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, count, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Account, Capabilities, HarnessInstall, HarnessStatus, HarnessId } from '@novelist/shared';
import { zAccount, zProfile } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { accounts, capabilities, harnessInstalls, importJobs, profiles } from '../../../db/schema.js';
import { detectInstalls, getAdapter, installHarness, isValidHarnessVersion, listAdapters, PINNED_VERSIONS, planInstall, probeIsolation, resolveAccount, runProbe } from '../../../harness/index.js';
import { accountFromRow, loadSlots, loadSystemSettings } from '../../../orchestrator/index.js';
import { audit, domain } from '../../helpers.js';
import { badRequest, conflict, notFound } from '../../problem.js';

const adapterOf = (id: string) => {
  try {
    return getAdapter(id as HarnessId);
  } catch {
    throw notFound(`harness ${id} `);
  }
};

async function statusOf(deps: AppDeps, installs: HarnessInstall[], id: HarnessId, isolation: string): Promise<HarnessStatus> {
  const adapter = getAdapter(id);
  const inst = installs.find((i) => i.id === id) ?? null;
  let caps: Capabilities | null = null;
  if (inst) {
    const rows = await deps.db.select().from(capabilities).where(and(eq(capabilities.harness, id), eq(capabilities.version, inst.version), eq(capabilities.isolation, isolation))).limit(1);
    caps = (rows[0]?.body as Capabilities | undefined) ?? null;
  }
  const acctRows = await deps.db.select({ n: count() }).from(accounts).where(eq(accounts.harness, id));
  let installHint = '';
  try {
    const plan = planInstall(deps.paths, id, PINNED_VERSIONS[id] ?? 'latest');
    installHint = plan.commands.map((c) => c.join(' ')).join(' && ');
  } catch {
    installHint = adapter.id === 'fake' ? '内置测试 harness' : '';
  }
  return {
    id,
    displayName: adapter.displayName,
    installed: !!inst,
    install: inst,
    binPath: inst?.binPath ?? null,
    versionDetected: inst?.version ?? null,
    supportedVersions: adapter.supportedVersions,
    capabilities: caps,
    authMethods: adapter.authMethods(),
    accounts: Number(acctRows[0]?.n ?? 0),
    installHint,
  };
}

/** live 探测用的模型：杂活位置的 profile 正好是这个 harness 时用它的模型和 effort，否则 adapter 默认 */
export async function probeModelFor(deps: AppDeps, harness: HarnessId): Promise<{ model?: string; effort?: string }> {
  const id = (await loadSlots(deps.db)).utility.primary;
  if (!id) return {};
  const row = (await deps.db.select().from(profiles).where(eq(profiles.id, id)).limit(1))[0];
  const p = row ? zProfile.safeParse({ ...row.body, id: row.id, harness: row.harness, enabled: row.enabled }) : null;
  if (!p?.success || p.data.harness !== harness) return {};
  return { model: p.data.model, ...(p.data.effort ? { effort: p.data.effort } : {}) };
}

/** 探测 / 列模型用的账号：指定 id，否则该 harness 首个启用账号，否则空账号 */
async function accountForProbe(deps: AppDeps, harness: HarnessId, accountId: string | undefined): Promise<Account> {
  if (accountId) {
    const rows = await deps.db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const a = rows[0] ? accountFromRow(rows[0]) : null;
    if (!a) throw notFound(`账号 ${accountId} `);
    return a;
  }
  const rows = await deps.db.select().from(accounts).where(and(eq(accounts.harness, harness), eq(accounts.enabled, true))).orderBy(desc(accounts.updatedAt)).limit(1);
  const a = rows[0] ? accountFromRow(rows[0]) : null;
  return a ?? zAccount.parse({ id: 'probe-anon', harness, authMode: 'none' });
}

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/admin/harness', async (): Promise<HarnessStatus[]> => {
    const settings = await loadSystemSettings(deps.db);
    const isolation = (await probeIsolation(settings.isolation !== 'auto' ? settings.isolation : deps.config.isolation)).selected;
    const installs = await detectInstalls(deps.config.harnessDir);
    return Promise.all(
      listAdapters()
        .filter((a) => a.id !== 'fake' || deps.config.allowFakeHarness)
        .map((a) => statusOf(deps, installs, a.id as HarnessId, isolation)),
    );
  });

  app.post<{ Params: { id: string }; Querystring: { accountId?: string; live?: string } }>('/api/admin/harness/:id/probe', async (req): Promise<Capabilities> => {
    const adapter = adapterOf(req.params.id);
    const harness = adapter.id as HarnessId;
    const inst = (await detectInstalls(deps.config.harnessDir)).find((i) => i.id === harness);
    if (!inst) throw conflict(`${harness} 尚未安装`, 'harness_not_installed');
    const settings = await loadSystemSettings(deps.db);
    const isolation = (await probeIsolation(settings.isolation !== 'auto' ? settings.isolation : deps.config.isolation)).selected;
    const acct = await resolveAccount(await accountForProbe(deps, harness, req.query.accountId), deps.paths, deps.secrets);
    const scratchDir = await fs.mkdtemp(path.join(deps.paths.tmp, `probe-${harness}-`));
    try {
      const live = req.query.live === '1';
      // live = 目录探测（runDirectoryCanary）：模型取杂活位置的 profile（同一个 harness 时），否则 adapter 默认
      const pm = live ? await probeModelFor(deps, harness) : {};
      const caps = await domain(() => runProbe(adapter, inst, acct, { isolation, scratchDir, live, ...pm, fixturesDir: path.join(deps.paths.harness, 'fixtures', harness, inst.version) }));
      const now = new Date().toISOString();
      await deps.db.insert(capabilities).values({ harness, version: inst.version, isolation, body: caps as unknown as Record<string, unknown>, verifiedAt: now }).onConflictDoUpdate({ target: [capabilities.harness, capabilities.version, capabilities.isolation], set: { body: caps as unknown as Record<string, unknown>, verifiedAt: now } });
      await deps.db
        .insert(harnessInstalls)
        .values({ harness, version: inst.version, binPath: inst.binPath, sha256: inst.sha256, sha256Source: inst.sha256Source, tier: inst.tier, status: inst.status, ...(inst.nodeVersion ? { nodeVersion: inst.nodeVersion } : {}) })
        .onConflictDoUpdate({ target: [harnessInstalls.harness, harnessInstalls.version], set: { binPath: inst.binPath, sha256: inst.sha256, tier: inst.tier, status: inst.status } });
      await audit(deps, req, 'harness.probe', harness, { live: req.query.live === '1' });
      return caps;
    } finally {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  app.get<{ Params: { id: string }; Querystring: { accountId?: string } }>('/api/admin/harness/:id/models', async (req): Promise<string[]> => {
    const adapter = adapterOf(req.params.id);
    const harness = adapter.id as HarnessId;
    const acct = await accountForProbe(deps, harness, req.query.accountId);
    const models = new Set(acct.customModels);
    const inst = (await detectInstalls(deps.config.harnessDir)).find((i) => i.id === harness);
    if (inst) {
      try {
        const resolved = await resolveAccount(acct, deps.paths, deps.secrets);
        for (const m of await adapter.listModels(resolved, inst)) models.add(m);
      } catch (e) {
        deps.log.warn({ harness, err: (e as Error).message }, 'listModels failed');
      }
    }
    return [...models].sort();
  });

  // 安装 harness（§3.8）：后台执行，输出写进 import_jobs（kind='harness_install'），GET 轮询进度
  app.post<{ Params: { id: string }; Body: { version?: string } | undefined }>('/api/admin/harness/:id/install', async (req, reply) => {
    const adapter = adapterOf(req.params.id);
    const harness = adapter.id as HarnessId;
    const running = await deps.db.select({ id: importJobs.id }).from(importJobs).where(and(eq(importJobs.kind, 'harness_install'), eq(importJobs.state, 'running'))).limit(1);
    if (running[0]) throw conflict('已有安装任务在进行', 'install_running');
    const version = req.body?.version ?? PINNED_VERSIONS[harness] ?? 'latest';
    if (version !== 'latest' && !isValidHarnessVersion(version)) throw badRequest(`非法的版本号：${version}`);
    const plan = planInstall(deps.paths, harness, version);
    const id = randomUUID();
    await deps.db.insert(importJobs).values({ id, kind: 'harness_install', state: 'running', request: { harness, version, commands: plan.commands } });
    await audit(deps, req, 'harness.install', harness, { version });
    const lines: string[] = [];
    const flush = () => deps.db.update(importJobs).set({ log: lines.slice(-2000) }).where(eq(importJobs.id, id));
    void installHarness(deps.paths, plan, (line) => {
      lines.push(line);
      if (lines.length % 20 === 0) void flush().catch(() => {});
    })
      .then(async (inst) => {
        await flush();
        await deps.db.update(importJobs).set({ state: 'done', report: inst as unknown as Record<string, unknown>, endedAt: new Date().toISOString() }).where(eq(importJobs.id, id));
      })
      .catch(async (e: Error) => {
        lines.push(`安装失败：${e.message}`);
        await flush();
        await deps.db.update(importJobs).set({ state: 'failed', endedAt: new Date().toISOString() }).where(eq(importJobs.id, id));
      });
    return reply.code(202).send({ id, state: 'running', commands: plan.commands });
  });

  app.get<{ Params: { id: string } }>('/api/admin/harness/install-jobs/:id', async (req) => {
    const rows = await deps.db.select().from(importJobs).where(and(eq(importJobs.id, req.params.id), eq(importJobs.kind, 'harness_install'))).limit(1);
    if (!rows[0]) throw notFound('安装任务');
    const r = rows[0];
    return { id: r.id, state: r.state, startedAt: r.startedAt, endedAt: r.endedAt, log: r.log, install: r.report };
  });

}
