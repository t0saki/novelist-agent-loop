/**
 * serve 入口：loadConfig → 目录 → openDb+migrate → 主密钥 → SecretStore → seed（genres、routing、settings、admin 密码）
 * → orchestrator（按 roles）→ buildServer → listen。SIGTERM：停止派发、等当前 run（stop_grace_period 90s）后退出。Owner: lane G。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config/index.js';
import { dataPaths } from './config/index.js';
import type { AppDeps } from './app.js';
import { ensureAdminPassword } from './api/auth.js';
import { buildServer } from './api/server.js';
import { ensureGitRepo } from './book/index.js';
import { migrate, openDb } from './db/client.js';
import { accounts, importJobs } from './db/schema.js';
import { convertV1Packs, seedBuiltinGenres } from './genres/index.js';
import { createAutoStarter } from './services/auto-start.js';
import { createLoginManager, probeIsolation } from './harness/index.js';
import { createLogger, type Logger } from './log.js';
import { createEventBus, createOrchestrator, loadSystemSettings, saveSlots, seedProfiles } from './orchestrator/index.js';
import { registerLoginResult } from './services/accounts.js';
import { createWriterOverrideRetry, runBootMigrations, runPostRecoveryMigrations } from './boot/migrate-p3.js';
import { createSecretStore, loadMasterKey, loadSessionSecret } from './services/secrets.js';

export interface RunningApp {
  deps: AppDeps;
  url: string;
  close(): Promise<void>;
}

const SHUTDOWN_GRACE_MS = 80_000;

/** 组装进程级依赖（不启动 HTTP / 调度）。CLI 与 serve 共用 */
export async function bootstrap(configIn: AppConfig, opts: { log?: Logger; migrate?: boolean; /** P3 开机迁移（boot/migrate-p3.ts）；只有 startServe 在编排进程里传 true */ bootMigrate?: boolean } = {}): Promise<AppDeps> {
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
  if (opts.migrate !== false) {
    await ensureGitRepo(paths.instructionsGlobal);
    await seedBuiltinGenres(paths);
    await convertV1Packs(paths, log);
    await seedProfiles(dbh.db);
    // P3 开机迁移：只在 serve 的编排进程里跑（CLI 命令、只有 web / runner 的进程不跑；它们靠 claimNext / tick / 门面的过滤保持安全）
    if (opts.bootMigrate) {
      const report = await runBootMigrations(deps);
      log.info({ report }, 'p3 boot migration');
    }
    if (config.fakeHarness) await enableFakeMode(deps);
  }
  return deps;
}

/**
 * mock 模式：确保 fake 账号存在，两个路由位置都写成 fake（与以前覆盖路由一致）。
 * 强制本身不存库：路由按 config.fakeHarness 在运行时强制走 fake、忽略书级覆盖；以后不用 fake 模式启动时位置照常可改。
 */
async function enableFakeMode(deps: AppDeps): Promise<void> {
  await deps.db.insert(accounts).values({ id: 'fake', harness: 'fake', label: 'fake', authMode: 'none', enabled: true, body: {} }).onConflictDoNothing({ target: accounts.id });
  await saveSlots(deps.db, { writer: { primary: 'fake', fallback: null }, utility: { primary: 'fake', fallback: null } });
  deps.log.warn('NOVELIST_FAKE_HARNESS=1：mock 模式，两个路由位置都走 fake adapter，不调用任何模型');
}

export async function shutdownDeps(deps: AppDeps): Promise<void> {
  await deps.bus.close().catch(() => {});
  await deps.dbh.close().catch(() => {});
}

export async function startServe(config: AppConfig): Promise<RunningApp> {
  const deps = await bootstrap(config, { bootMigrate: config.roles.includes('orchestrator') });
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
    const autoStart = createAutoStarter(deps);
    // M4b 开机时延后的书：leader tick 里每分钟至多重试一次（没有延后的书就什么都不做）
    const retryWriterOverrides = deps.config.roles.includes('orchestrator') ? createWriterOverrideRetry(deps) : null;
    deps.orchestrator.scheduler.setLeaderHook(async (now, settings) => {
      if (retryWriterOverrides) await retryWriterOverrides(now).catch((err: Error) => log.warn({ err: err.message }, 'p3 writer-override retry failed'));
      await autoStart(now, settings);
    });
    // M4b（书级写手覆盖搬进 book.yaml）只在编排进程里、恢复之后跑；出错只记日志
    await deps.orchestrator.start(deps.config.roles.includes('orchestrator') ? { afterRecover: () => runPostRecoveryMigrations(deps) } : {});
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
