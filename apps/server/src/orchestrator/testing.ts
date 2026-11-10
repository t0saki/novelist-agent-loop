/**
 * orchestrator 测试工具：临时 $DATA + 内存 PGlite + 测试用 pipeline（只有测试给的 handler）。只在测试中使用。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig, dataPaths, type AppConfig, type DataPaths } from '../config/index.js';
import { createTestDb } from '../db/testing.js';
import type { Db, DbHandle } from '../db/client.js';
import { books } from '../db/schema.js';
import { silentLogger } from '../log.js';
import { P, bookFiles, openRepo } from '../book/index.js';
import type { SecretStore } from '../services/secrets.js';
import type { BookHandle, PipelineContext, TaskHandler, TaskRow, TaskResult, TaskSpec } from '../runtime/types.js';
import { UnknownTaskKindError, isKnownKind } from '../runtime/registry.js';
import type { PipelineBinding } from './binding.js';
import { createEventBus, type EventBus } from './bus.js';
import type { ExecutorDeps } from './executor.js';
import { saveSlots, seedProfiles } from './routing.js';

export const secretsStub: SecretStore = {
  put: async () => {
    throw new Error('secrets stub');
  },
  get: async () => Buffer.from(''),
  getString: async () => '',
  delete: async () => {},
  listByOwner: async () => [],
  rotate: async () => 0,
};

export interface OrchTestEnv {
  dbh: DbHandle;
  db: Db;
  dataDir: string;
  paths: DataPaths;
  config: AppConfig;
  bus: EventBus;
  deps: ExecutorDeps;
  pipeline: TestPipeline;
  close(): Promise<void>;
}

export interface TestPipelineOptions {
  /** 只有这些 handler；没给的种类照旧抛错（"no fake handler for X"），已删除的旧种类抛 UnknownTaskKindError */
  handlers?: Partial<Record<string, TaskHandler>>;
  /** 默认 [] */
  next?: (ctx: PipelineContext) => Promise<TaskSpec[]> | TaskSpec[];
  /** 默认 [] */
  onDone?: (ctx: PipelineContext, task: TaskRow, result: TaskResult) => Promise<TaskSpec[]> | TaskSpec[];
}

export type TestPipeline = PipelineBinding & { handlers: Partial<Record<string, TaskHandler>>; opts: TestPipelineOptions };

export function createTestPipeline(paths: DataPaths, opts: TestPipelineOptions = {}): TestPipeline {
  const handlers: Partial<Record<string, TaskHandler>> = { ...(opts.handlers ?? {}) };
  return {
    handlers,
    opts,
    handlerFor(kind) {
      const h = handlers[kind];
      if (h) return h;
      if (!isKnownKind(kind)) throw new UnknownTaskKindError(kind);
      throw new Error(`no fake handler for ${kind}`);
    },
    async openBook(_deps, idOrSlug) {
      const rows = await _deps.db.select().from(books).where(eq(books.id, idOrSlug)).limit(1);
      const row = rows[0] ?? (await _deps.db.select().from(books).where(eq(books.slug, idOrSlug)).limit(1))[0];
      if (!row) throw new Error(`no book ${idOrSlug}`);
      const dir = path.join(paths.books, row.slug);
      const repo = openRepo(dir);
      const config = (await bookFiles(repo).config()).config;
      // 测试环境不种题材包：给一个空链的题材
      const genre = { id: row.genre, pack: {}, chain: [] } as unknown as BookHandle['genre'];
      return { id: row.id, slug: row.slug, dir, repo, config, genre, headCommit: await repo.head() };
    },
    computeTaskId: (spec, manifest, stackHash) => createHash('sha256').update(JSON.stringify([spec.bookId, spec.kind, spec.target, manifest.hard, manifest.configHash, stackHash])).digest('hex').slice(0, 32),
    nextTasks: async (ctx) => (await opts.next?.(ctx)) ?? [],
    onTaskDone: async (ctx, task, result) => (await opts.onDone?.(ctx, task, result)) ?? [],
  };
}

export async function createOrchTestEnv(opts: { pipeline?: TestPipelineOptions; /** 两个路由位置的主用（默认都是 fake）；null = 不写 routing.slots（走 DEFAULT_SLOTS） */ slots?: { writer?: string; utility?: string } | null } = {}): Promise<OrchTestEnv> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-f-'));
  const paths = dataPaths(dataDir);
  for (const d of [paths.books, paths.accounts, paths.runs, paths.runsActive, paths.instructionsGlobal]) await fs.mkdir(d, { recursive: true });
  const config = loadConfig({ NOVELIST_DATA_DIR: dataDir, NOVELIST_ISOLATION: 'container', NOVELIST_ALLOW_FAKE_HARNESS: '1', NOVELIST_DATABASE_URL: 'pglite:memory' } as NodeJS.ProcessEnv);
  const dbh = await createTestDb();
  const db = dbh.db;
  await seedProfiles(db);
  if (opts.slots !== null) await saveSlots(db, { writer: { primary: opts.slots?.writer ?? 'fake', fallback: null }, utility: { primary: opts.slots?.utility ?? 'fake', fallback: null } });
  const bus = createEventBus();
  const pipeline = createTestPipeline(paths, opts.pipeline);
  const deps: ExecutorDeps = { db, config, paths, log: silentLogger, bus, secrets: secretsStub, owner: 'test-runner', pipeline, backoffBaseMs: 1 };
  return {
    dbh,
    db,
    dataDir,
    paths,
    config,
    bus,
    deps,
    pipeline,
    async close() {
      await bus.close();
      await dbh.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

export { P };
