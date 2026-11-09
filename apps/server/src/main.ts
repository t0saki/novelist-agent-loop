/**
 * serve 入口：loadConfig → 目录 → openDb+migrate → 主密钥 → SecretStore → seed（genres、routing、settings、admin 密码）
 * → orchestrator（按 roles）→ buildServer → listen。SIGTERM：停止派发、等当前 run（stop_grace_period 90s）后退出。Owner: lane G。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config/index.js';
import { dataPaths } from './config/index.js';
import type { AppDeps } from './app.js';
import { ensureAdminPassword } from './api/auth.js';
import { buildServer } from './api/server.js';
import { ensureGitRepo } from './book/index.js';
import { migrate, openDb } from './db/client.js';
import { accounts, importJobs, settings } from './db/schema.js';
import { convertV1Packs, seedBuiltinGenres } from './genres/index.js';
import { createAutoStarter } from './services/auto-start.js';
import { createLoginManager, probeIsolation } from './harness/index.js';
import { createLogger, type Logger } from './log.js';
import { createEventBus, createOrchestrator, loadSystemSettings, seedRouting } from './orchestrator/index.js';
import { registerLoginResult } from './services/accounts.js';
import { createSecretStore, loadMasterKey, loadSessionSecret } from './services/secrets.js';

export interface RunningApp {
  deps: AppDeps;
  url: string;
  close(): Promise<void>;
}

const SHUTDOWN_GRACE_MS = 80_000;

/** 组装进程级依赖（不启动 HTTP / 调度）。CLI 与 serve 共用 */
export async function bootstrap(configIn: AppConfig, opts: { log?: Logger; migrate?: boolean } = {}): Promise<AppDeps> {
  const paths = dataPaths(configIn.dataDir);
  for (const d of [paths.root, paths.books, paths.accounts, paths.runs, paths.runsActive, paths.instructionsGlobal, paths.genres, paths.harness, paths.exports, paths.media, paths.backups, paths.tmp, configIn.harnessDir]) {
    await fs.mkdir(d, { recursive: true });
  }
  const config: AppConfig = { ...configIn, sessionSecret: await loadSessionSecret({ envValue: configIn.sessionSecret, keyFile: paths.sessionSecretFile }) };
  const log = opts.log ?? createLogger(config.logLevel);
  const dbh = await openDb({ url: config.dbKind === 'pg' ? config.databaseUrl : null, pgliteDir: config.pgliteDir });
  if (opts.migrate !== false) await migrate(dbh);
  const { key, source } = await loadMasterKey({ envValue: config.masterKey, keyFile: paths.masterKeyFile });
  const secrets = createSecretStore(dbh.db, key);
  // 单容器 all-in-one：事件总线只走进程内；拆分进程时才需要 LISTEN/NOTIFY 桥
  const splitRoles = config.roles.length < 3 && dbh.notifier;
  const bus = createEventBus(splitRoles && dbh.notifier ? { pgNotify: dbh.notifier } : undefined);
  const deps: AppDeps = {
    config,
    paths,
    dbh,
    db: dbh.db,
    log,
    bus,
    secrets,
    masterKeySource: source,
    startedAt: new Date(),
    orchestrator: createOrchestrator({ db: dbh.db, config, paths, log, bus, secrets, owner: `${os.hostname()}:${process.pid}` }),
    logins: createLoginManager({
      onFinished: (_s, acct, result) => registerLoginResult({ db: dbh.db, secrets }, acct, result),
    }),
  };
  await installNvWrapper(config.harnessDir, deps.log);
  if (opts.migrate !== false) {
    await ensureGitRepo(paths.instructionsGlobal);
    await seedBuiltinGenres(paths);
    await convertV1Packs(paths, log);
    await seedRouting(dbh.db);
    if (config.fakeHarness) await enableFakeMode(deps);
  }
  return deps;
}

/** mock 模式：确保 fake 账号存在，并把全部角色强制路由到 preset 'fake'（覆盖书级路由，重启后仍生效） */
async function enableFakeMode(deps: AppDeps): Promise<void> {
  await deps.db.insert(accounts).values({ id: 'fake', harness: 'fake', label: 'fake', authMode: 'none', enabled: true, body: {} }).onConflictDoNothing({ target: accounts.id });
  await deps.db.update(settings).set({ value: { presetId: 'fake', overrides: {}, forced: true }, updatedAt: new Date().toISOString() }).where(eq(settings.key, 'routing.active'));
  deps.log.warn('NOVELIST_FAKE_HARNESS=1：mock 模式，全部角色走 fake adapter，不调用任何模型');
}

/**
 * 把 validators/cli.js 暴露成 `nv`（harness hook 的 `${NOVELIST_NV_BIN:-nv}`）。harness env 是 env -i 起步，只继承 PATH：
 * 写一个 sh 包装到 $DATA/harness/bin（在 harness 的 PATH 里）。开发（.ts）跳过。
 */
async function installNvWrapper(harnessDir: string, log: Logger): Promise<void> {
  const cli = path.join(import.meta.dirname, 'validators', 'cli.js');
  if (!(await fs.stat(cli).then(() => true, () => false))) return;
  const wrapper = path.join(harnessDir, 'nv');
  await fs.writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 }).catch((err: Error) => log.warn({ err: err.message }, 'nv wrapper'));
}

export async function shutdownDeps(deps: AppDeps): Promise<void> {
  await deps.bus.close().catch(() => {});
  await deps.dbh.close().catch(() => {});
}

export async function startServe(config: AppConfig): Promise<RunningApp> {
  const deps = await bootstrap(config);
  const { log } = deps;
  // 导入/安装是进程内后台任务：上次进程的 running 行不可能再完成，否则新任务永远 409
  if (deps.config.roles.includes('orchestrator')) {
    const at = new Date().toISOString();
    const note = JSON.stringify([`${at} 进程重启，任务已中断，请重新发起`]);
    const interrupted = await deps.db.update(importJobs).set({ state: 'failed', endedAt: at, log: sql`${importJobs.log} || ${note}::jsonb` }).where(eq(importJobs.state, 'running')).returning({ id: importJobs.id });
    if (interrupted.length) log.warn({ jobs: interrupted.map((j) => j.id) }, '进程重启中断的导入/安装任务已标记失败');
  }
  const { generated } = await ensureAdminPassword(deps);
  if (generated) log.warn({ adminPassword: generated }, '首次启动：已生成管理员密码（只打印这一次，请立即保存）');

  const settings = await loadSystemSettings(deps.db);
  const isolation = await probeIsolation(settings.isolation);
  log.info({ selected: isolation.selected, inContainer: isolation.inContainer }, 'isolation probe');

  let app: FastifyInstance | null = null;
  let url = '';
  if (deps.config.roles.includes('web')) {
    app = await buildServer(deps);
    url = await app.listen({ host: deps.config.host, port: deps.config.port });
    log.info({ url }, 'listening');
  }

  const runOrchestrator = deps.config.roles.includes('orchestrator') || deps.config.roles.includes('runner');
  if (runOrchestrator) {
    deps.orchestrator.scheduler.setLeaderHook(createAutoStarter(deps));
    await deps.orchestrator.start();
  }

  let closing: Promise<void> | null = null;
  return {
    deps,
    url,
    close() {
      closing ??= (async () => {
        const stop = runOrchestrator ? deps.orchestrator.stop({ drain: true }) : Promise.resolve();
        await Promise.race([stop.catch((err: unknown) => log.warn({ err }, 'orchestrator stop failed')), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]);
        if (app) await app.close();
        await shutdownDeps(deps);
      })();
      return closing;
    },
  };
}
