import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from './config/index.js';
import { importJobs } from './db/schema.js';
import { silentLogger } from './log.js';
import { bootstrap, shutdownDeps, startServe, type RunningApp } from './main.js';

describe('startServe after a crash', () => {
  let dataDir: string;
  let config: AppConfig;
  let running: RunningApp | null = null;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-main-'));
    config = loadConfig({
      NOVELIST_DATA_DIR: dataDir,
      NOVELIST_DATABASE_URL: `pglite:${path.join(dataDir, 'pg')}`,
      NOVELIST_ROLES: 'orchestrator',
      NOVELIST_ADMIN_PASSWORD: 'test-admin-password',
      NOVELIST_LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    await running?.close();
    running = null;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('fails jobs the previous process left running, so new imports and installs are not rejected forever', async () => {
    const before = await bootstrap(config, { log: silentLogger });
    await before.db.insert(importJobs).values([
      { id: 'v1-stuck', kind: 'v1', state: 'running', request: {}, log: ['已开始'] },
      { id: 'install-stuck', kind: 'harness_install', state: 'running', request: {} },
      { id: 'finished', kind: 'v1', state: 'done', request: {}, endedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await shutdownDeps(before);

    running = await startServe(config);

    const rows = await running.deps.db.select().from(importJobs);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ['v1-stuck', 'install-stuck']) {
      expect(byId.get(id)?.state).toBe('failed');
      expect(byId.get(id)?.endedAt).toBeTruthy();
      expect(byId.get(id)?.log.at(-1)).toContain('进程重启');
    }
    expect(byId.get('v1-stuck')?.log[0]).toBe('已开始');
    expect(byId.get('finished')?.state).toBe('done');
    expect(await running.deps.db.select().from(importJobs).where(eq(importJobs.state, 'running'))).toEqual([]);
  });
});
