/**
 * 全栈测试夹具（e2e / chaos）：临时 $DATA + 内存 PGlite + fake harness 账号/profile + 两个路由位置默认都是 'fake'。
 * 测试配置是 fakeHarness=false + allowFakeHarness=true，所以位置可改、书级覆盖也能测。
 * 用法：const t = await createTestApp(); … await t.deps.orchestrator.runUntilIdle(); await t.close();
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './app.js';
import { ensureAdminPassword } from './api/auth.js';
import { buildServer } from './api/server.js';
import { loadConfig } from './config/index.js';
import { accounts } from './db/schema.js';
import { saveSlots } from './orchestrator/index.js';
import { bootstrap, shutdownDeps } from './main.js';
import { silentLogger } from './log.js';

export const TEST_ADMIN_PASSWORD = 'test-admin-password';

export interface TestApp {
  deps: AppDeps;
  app: FastifyInstance;
  dataDir: string;
  /** 启动了 HTTP 时的 base URL（inject 模式下为 null） */
  url: string | null;
  close(): Promise<void>;
}

export async function createTestApp(opts?: { http?: boolean; slots?: { writer?: string; utility?: string }; web?: string }): Promise<TestApp> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-g-'));
  const config = loadConfig({
    NOVELIST_ISOLATION: 'container',
    NOVELIST_DATA_DIR: dataDir,
    NOVELIST_DATABASE_URL: 'pglite:memory',
    NOVELIST_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    NOVELIST_ALLOW_FAKE_HARNESS: '1',
    NOVELIST_INSECURE_COOKIES: '1',
    NOVELIST_WEB_DIST: opts?.web ?? path.join(dataDir, 'no-web'),
  } as NodeJS.ProcessEnv);
  const deps = await bootstrap(config, { log: silentLogger });
  await ensureAdminPassword(deps);
  await deps.db.insert(accounts).values({ id: 'fake', harness: 'fake', label: 'fake', authMode: 'none', enabled: true, body: {} }).onConflictDoNothing({ target: accounts.id });
  await saveSlots(deps.db, { writer: { primary: opts?.slots?.writer ?? 'fake', fallback: null }, utility: { primary: opts?.slots?.utility ?? 'fake', fallback: null } });
  const app = await buildServer(deps);
  let url: string | null = null;
  if (opts?.http) url = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    deps,
    app,
    dataDir,
    url,
    async close() {
      await deps.orchestrator.stop().catch(() => {});
      await app.close();
      await shutdownDeps(deps);
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}
