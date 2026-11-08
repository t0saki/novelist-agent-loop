/**
 * lane F 测试工具：临时 $DATA + 内存 PGlite + 假 pipeline（handler 用真实 fake harness 跑）。Owner: lane F。只在测试中使用。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { stringify as yamlStringify } from 'yaml';
import { zBookConfig, type TaskKind, type WorkOrderFrontmatter } from '@novelist/shared';
import { loadConfig, dataPaths, type AppConfig, type DataPaths } from '../config/index.js';
import { createTestDb } from '../db/testing.js';
import type { Db, DbHandle } from '../db/client.js';
import { books, settings } from '../db/schema.js';
import { silentLogger } from '../log.js';
import { P, bookFiles, createFixtureBook, openRepo, type BookRepo } from '../book/index.js';
import type { SecretStore } from '../services/secrets.js';
import type { BookHandle, HarvestedRun, Manifest, PipelineContext, PromotePlan, TaskHandler, TaskRow, TaskResult, TaskSpec } from '../pipeline/types.js';
import type { BookRuntimeState } from '../pipeline/next.js';
import type { PipelineBinding } from './binding.js';
import { createEventBus, type EventBus } from './bus.js';
import type { ExecutorDeps } from './executor.js';
import { seedRouting } from './routing.js';

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
  pipeline: FakePipeline;
  close(): Promise<void>;
}

export interface FakePipelineOptions {
  handlers?: Partial<Record<TaskKind, TaskHandler>>;
  next?: (ctx: PipelineContext, state: BookRuntimeState) => Promise<TaskSpec[]> | TaskSpec[];
  initial?: (book: BookHandle, opts: { interview: boolean }) => TaskSpec[];
  onDone?: (ctx: PipelineContext, task: TaskRow, result: TaskResult) => Promise<TaskSpec[]> | TaskSpec[];
}

export type FakePipeline = PipelineBinding & { handlers: Partial<Record<TaskKind, TaskHandler>>; opts: FakePipelineOptions };

export function createFakePipeline(paths: DataPaths, opts: FakePipelineOptions = {}): FakePipeline {
  const handlers: Partial<Record<TaskKind, TaskHandler>> = { ...(opts.handlers ?? {}) };
  return {
    handlers,
    opts,
    handlerFor(kind) {
      const h = handlers[kind];
      if (!h) throw new Error(`no fake handler for ${kind}`);
      return h;
    },
    async openBook(_deps, idOrSlug) {
      const rows = await _deps.db.select().from(books).where(eq(books.id, idOrSlug)).limit(1);
      const row = rows[0] ?? (await _deps.db.select().from(books).where(eq(books.slug, idOrSlug)).limit(1))[0];
      if (!row) throw new Error(`no book ${idOrSlug}`);
      const dir = path.join(paths.books, row.slug);
      const repo = openRepo(dir);
      const files = bookFiles(repo);
      const config = (await files.config()).config;
      const genre = { id: row.genre, pack: {}, chain: [], gates: [], pacing: {}, lexicon: {}, eventFamilies: {} } as unknown as BookHandle['genre'];
      return { id: row.id, slug: row.slug, dir, repo, files, config, genre, headCommit: await repo.head() };
    },
    effectiveTier: () => 'standard',
    computeTaskId: (spec, manifest, stackHash) => createHash('sha256').update(JSON.stringify([spec.bookId, spec.kind, spec.target, manifest.hard, manifest.configHash, stackHash])).digest('hex').slice(0, 32),
    initialTasks: (book, o) => opts.initial?.(book, o) ?? [],
    nextTasks: async (ctx, state) => (await opts.next?.(ctx, state)) ?? [],
    onTaskDone: async (ctx, task, result) => (await opts.onDone?.(ctx, task, result)) ?? [],
    renderWorkOrder: (fm: WorkOrderFrontmatter, body: string) => `---\n${yamlStringify(fm)}---\n\n${body}`,
  };
}

/** 确定性 handler（不跑模型）：写一个文件并提交 */
export function fileHandler(kind: TaskKind, lane: 'write' | 'side' | 'system', build: (ctx: PipelineContext, task: TaskRow) => { files: { path: string; content: string }[]; manifest?: Manifest; dbEffects?: PromotePlan['dbEffects'] }, manifestFn?: (ctx: PipelineContext, spec: TaskSpec) => Promise<Manifest> | Manifest): TaskHandler {
  return {
    kind,
    role: null,
    lane,
    maxAttempts: 6,
    manifest: async (ctx, spec) => (manifestFn ? manifestFn(ctx, spec) : { hard: {}, soft: {}, rebaseValidators: [], configHash: '' }),
    async execute(ctx, task) {
      const r = build(ctx, task);
      const book = ctx.book as BookHandle;
      const plan: PromotePlan = { bookId: book.id, taskId: task.id, runId: null, baseCommit: book.headCommit, files: r.files, resolveTmpIds: false, message: `${kind} ${task.target}`, trailers: {}, tags: [], ...(r.dbEffects ? { dbEffects: r.dbEffects } : {}) };
      return { status: 'done', promote: plan };
    },
  };
}

/** fake harness 写一个产物，finalize 把它提交进书库 */
export function agentChapterHandler(opts: { kind?: TaskKind; role?: string; artifact?: (task: TaskRow) => string; fake?: (task: TaskRow) => Record<string, unknown> | undefined; afterFinalize?: (r: TaskResult, h: HarvestedRun) => TaskResult; dbEffects?: (task: TaskRow) => PromotePlan['dbEffects'] } = {}): TaskHandler {
  const kind = opts.kind ?? 'chapter.write';
  const artifact = opts.artifact ?? ((task: TaskRow) => `manuscript/${task.target}.md`);
  return {
    kind,
    role: (opts.role ?? 'writer') as TaskHandler['role'],
    lane: 'write',
    maxAttempts: 4,
    manifest: async () => ({ hard: {}, soft: {}, rebaseValidators: [], configHash: '' }),
    async prepare(_ctx, task, run) {
      const fake = opts.fake?.(task);
      return {
        kind: 'run',
        plan: {
          frontmatter: {
            kind,
            role: run.role,
            book: _ctx.book?.slug ?? null,
            target: task.target,
            inputs: [],
            budget: { max_full_chapter_reads: 4, max_searches: 8 },
            artifacts: [
              { path: artifact(task), kind: 'chapter_draft', length: { min: 30, target: 50, max: 80, count_mode: 'han' } },
              { path: 'receipt.json', kind: 'receipt', schema: 'nv.receipt/1' },
            ],
            ...(fake ? { fake } : {}),
          } as never,
          body: '# 测试\n\n- id: b1\n',
          inputs: [],
          ownerNotes: [],
          limits: { wallMs: 60_000, idleMs: 30_000, maxTurns: 10 },
        },
      };
    },
    async finalize(ctx, task, h) {
      const rel = artifact(task);
      if (!h.files.includes(rel)) return { status: 'retry', errorClass: 'output_contract', message: `missing ${rel}` };
      const text = await fs.readFile(path.join(h.stagedOutDir, rel), 'utf8');
      const book = ctx.book as BookHandle;
      const plan: PromotePlan = { bookId: book.id, taskId: task.id, runId: h.run.runId, baseCommit: h.run.baseCommit, files: [{ path: rel, content: text }], resolveTmpIds: false, message: `${kind} ${task.target}`, trailers: {}, tags: [], ...(opts.dbEffects ? { dbEffects: opts.dbEffects(task) } : {}) };
      const result: TaskResult = { status: 'done', promote: plan, chapter: { no: Number(task.target.replace(/\D/g, '')), state: 'accepted' } };
      return opts.afterFinalize ? opts.afterFinalize(result, h) : result;
    },
  };
}

export async function createOrchTestEnv(opts: { pipeline?: FakePipelineOptions; preset?: string } = {}): Promise<OrchTestEnv> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-f-'));
  const paths = dataPaths(dataDir);
  for (const d of [paths.books, paths.accounts, paths.runs, paths.runsActive, paths.instructionsGlobal]) await fs.mkdir(d, { recursive: true });
  const config = loadConfig({ NOVELIST_DATA_DIR: dataDir, NOVELIST_ISOLATION: 'container', NOVELIST_ALLOW_FAKE_HARNESS: '1', NOVELIST_DATABASE_URL: 'pglite:memory' } as NodeJS.ProcessEnv);
  const dbh = await createTestDb();
  const db = dbh.db;
  await seedRouting(db);
  await db.update(settings).set({ value: { presetId: opts.preset ?? 'fake', overrides: {} } }).where(eq(settings.key, 'routing.active'));
  const bus = createEventBus();
  const pipeline = createFakePipeline(paths, opts.pipeline);
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

export async function addFixtureBook(env: OrchTestEnv, slug = 'b1', opts: { cards?: number; accepted?: number; status?: string; meta?: Record<string, unknown> } = {}): Promise<{ id: string; repo: BookRepo; head: string; dir: string }> {
  const dir = path.join(env.paths.books, slug);
  const { repo, head } = await createFixtureBook(dir, { slug, cards: opts.cards ?? 6, accepted: opts.accepted ?? 0 });
  const id = `book-${slug}`;
  await env.db.insert(books).values({ id, slug, title: `测试书 ${slug}`, genre: 'xianxia', status: opts.status ?? 'active', headCommit: head, acceptedThrough: opts.accepted ?? 0, ...(opts.meta ? { meta: opts.meta } : {}) });
  return { id, repo, head, dir };
}

export const parsedDefaultConfig = () => zBookConfig.parse({ schema: 'nv.book/1', slug: 'x', title: 'x', genre: 'xianxia' });
export { P };
