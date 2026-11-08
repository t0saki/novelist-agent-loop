/**
 * 流水线的最小编排桩（只用于本目录的测试）：按 orchestrator 的生命周期驱动 handler + fake harness。
 * 不做路由、配额、并发；stale check、lease 等属于 lane F 的职责，这里不模拟。
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import type { BookConfigInput, RoleId, TaskKind } from '@novelist/shared';
import { TRAILER, createRunSnapshot, harvestOut, initBookRepo, openRepo, removeRunSnapshot } from '../book/index.js';
import { dataPaths } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import { books, chapters, tasks } from '../db/schema.js';
import { createTestDb } from '../db/testing.js';
import type { DbHandle } from '../db/client.js';
import { seedBuiltinGenres } from '../genres/index.js';
import { silentLogger } from '../log.js';
import { buildViews, loadBookState, resolveTmpIds } from '../state/index.js';
import type { FakeScenario } from '../harness/fake/fake-harness.js';
import { runDbEffect } from './effects.js';
import { computeTaskId } from './ids.js';
import { openBook } from './book.js';
import { initialTasks, nextTasks, onTaskDone } from './next.js';
import type { BookRuntimeState } from './next.js';
import { handlerFor } from './registry.js';
import type { AgentPlan, BookHandle, HarvestedRun, InboxInput, PipelineContext, PipelineDeps, PromotePlan, RunContext, TaskResult, TaskRow, TaskSpec } from './types.js';
import { renderWorkOrder } from './workorder.js';

const FAKE_HARNESS = fileURLToPath(new URL('../harness/fake/fake-harness.ts', import.meta.url));
const execFileP = promisify(execFile);

export interface MiniLogEntry {
  kind: string;
  target: string;
  status: TaskResult['status'];
  message?: string;
}

export interface MiniEnv {
  root: string;
  deps: PipelineDeps;
  dbh: DbHandle;
  bookId: string;
  slug: string;
  bookDir: string;
  log: MiniLogEntry[];
  inbox: InboxInput[];
  /** 待处理任务 id（FIFO） */
  queue: string[];
  /** 开放审批（dedupe key），nextTasks 用 */
  openApprovals: Set<string>;
  scenario: (task: TaskRow, nth: number) => FakeScenario;
  kindCount: Map<string, number>;
  ctx(): Promise<PipelineContext>;
  close(): Promise<void>;
}

export interface MiniBookOptions {
  /** 默认 5 章 */
  chapters?: number;
  config?: Partial<BookConfigInput>;
  scenario?: (task: TaskRow, nth: number) => FakeScenario | undefined;
  premise?: string;
  status?: string;
}

const fakeConfig = (root: string): AppConfig =>
  ({ dataDir: root, harnessDir: path.join(root, 'harness/bin'), allowFakeHarness: true }) as unknown as AppConfig;

export async function createMiniBook(opts: MiniBookOptions = {}): Promise<MiniEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-pipe-'));
  const paths = dataPaths(root);
  for (const d of [paths.books, paths.instructionsGlobal, paths.genres]) await fs.mkdir(d, { recursive: true });
  await seedBuiltinGenres(paths);
  const dbh = await createTestDb();
  const deps: PipelineDeps = { db: dbh.db, config: fakeConfig(root), paths, log: silentLogger, now: () => new Date('2026-11-08T00:00:00Z') };
  const n = opts.chapters ?? 5;
  const length = { min: 2400, target: 3000, max: 3600, count_mode: 'han' as const };
  const slug = 'mini-book';
  const config: BookConfigInput = {
    slug,
    title: '试炼录',
    genre: 'xianxia',
    scale: { target_cjk: 3000 * n, hard_max_cjk: 3000 * n * 2, volumes: [1, 1], chapters_per_volume: [n, n], chapter_length: length },
    approvals: { compass: { required: false }, first_volume: { required: false }, failover: { required: false } },
    // fake 草稿靠随机重复句子凑字数，会命中 repeat.*；这两条规则在测试里关闭，其余 gate 照常生效
    gates: { overrides: { 'repeat.intra': { disable: true }, 'repeat.cross': { disable: true } } },
    ...(opts.config ?? {}),
  };
  const bookDir = path.join(paths.books, slug);
  await fs.mkdir(bookDir, { recursive: true });
  const { commit } = await initBookRepo(bookDir, { config, premise: opts.premise ?? '一个被逐出师门的少年，追查师父死因。' });
  const bookId = `book-${randomUUID()}`;
  await dbh.db.insert(books).values({ id: bookId, slug, title: config.title, genre: config.genre, status: opts.status ?? 'planning', headCommit: commit });
  const scenario = (task: TaskRow, nth: number): FakeScenario => ({ ...defaultScenario(task, n), ...(opts.scenario?.(task, nth) ?? {}) });
  const env: MiniEnv = {
    root,
    deps,
    dbh,
    bookId,
    slug,
    bookDir,
    log: [],
    inbox: [],
    queue: [],
    openApprovals: new Set(),
    scenario,
    kindCount: new Map(),
    async ctx() {
      return { deps, book: await openBook(deps, bookId) };
    },
    async close() {
      await dbh.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
  return env;
}

/** fake 产物默认值：规划产物按书的实际章节范围展开，摘要带锚点 */
function defaultScenario(task: TaskRow, totalCh: number): FakeScenario {
  const ids = Array.from({ length: totalCh }, (_, i) => `c${String(i + 1).padStart(5, '0')}`);
  const anchored = (tag: string) => `主角踏上旅程，收到第一条线索[${tag}]。他决定次日赴约，见到了旧友[${tag}]。\n`;
  switch (task.kind) {
    case 'plan.bible':
      return { skipArtifacts: ['plan/character-arcs/*.yaml'] };
    case 'plan.arc':
      return {
        expand: { 'plan/cards/c*.yaml': ids },
        chapters: [ids[0] as string, ids[ids.length - 1] as string],
        content: { [`plan/cards/${ids[ids.length - 1]}.yaml`]: finalCardYaml(ids[ids.length - 1] as string, totalCh) },
      };
    case 'summary.arc':
      return { content: { 'summaries/arcs/a0001.md': anchored('c00001') } };
    case 'summary.volume':
      return { content: { 'summaries/volumes/v01.md': anchored('c00001') } };
    case 'book.blurb':
      return { content: { 'summaries/book.md': anchored('c00001') } };
    default:
      return {};
  }
}

function finalCardYaml(id: string, no: number): Record<string, unknown> {
  return {
    schema: 'nv.card/1',
    id,
    title: `第${no}章`,
    volume: 'v01',
    arc: 'a0001',
    length: { min: 2400, target: 3000, max: 3600, count_mode: 'han' },
    beats: [
      { id: 'b1', mode: 'dramatize', cjk: 1000, goal: '最后的对决' },
      { id: 'b2', mode: 'dialogue', cjk: 1000, goal: '揭开真相' },
      { id: 'b3', mode: 'action', cjk: 1000, goal: '收束全书' },
    ],
    is_final: true,
  };
}

export async function enqueueSpec(env: MiniEnv, spec: TaskSpec, ctx: PipelineContext): Promise<TaskRow | null> {
  const h = handlerFor(spec.kind);
  const manifest = await h.manifest(ctx, spec);
  const id = computeTaskId(spec, manifest, 'stack0');
  const exists = await env.dbh.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1);
  if (exists[0]) return null;
  const rows = await env.dbh.db
    .insert(tasks)
    .values({
      id,
      bookId: spec.bookId,
      kind: spec.kind,
      target: spec.target,
      lane: spec.lane ?? h.lane,
      role: spec.role ?? h.role,
      tier: spec.tier ?? null,
      state: 'ready',
      baseCommit: ctx.book ? await ctx.book.repo.head() : null,
      hardManifest: manifest.hard,
      softManifest: manifest.soft,
      rebaseValidators: manifest.rebaseValidators,
      params: spec.params ?? {},
      maxAttempts: spec.maxAttempts ?? h.maxAttempts,
    })
    .returning();
  env.queue.push(id);
  return rows[0] ?? null;
}

async function loadTask(env: MiniEnv, id: string): Promise<TaskRow> {
  const r = await env.dbh.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!r[0]) throw new Error(`task not found ${id}`);
  return r[0];
}

async function applyPromote(env: MiniEnv, repo: BookHandle['repo'], plan: PromotePlan, taskId: string): Promise<void> {
  let files = plan.files;
  if (plan.resolveTmpIds) {
    const state = await loadBookState(env.bookDir);
    const entityIds = new Set([...Object.keys(state.snapshot.entities), ...Object.keys(state.snapshot.facts), ...Object.keys(state.snapshot.obligations)]);
    let nextF = 1;
    for (const id of entityIds) {
      const m = /^F(\d+)$/.exec(id);
      if (m) nextF = Math.max(nextF, Number(m[1]) + 1);
    }
    files = resolveTmpIds(files, { existing: entityIds, names: new Map(), nextObligationNo: nextF }).files;
  }
  await repo.writeFiles(files);
  const sha = await repo.commit({ message: plan.message, trailers: { ...plan.trailers, [TRAILER.task]: taskId }, paths: files.map((f) => f.path), tags: plan.tags });
  if (plan.effect) {
    const { effect } = plan;
    await env.dbh.db.transaction(async (tx) => runDbEffect(tx, sha, effect));
  } else if (plan.dbEffects) await env.dbh.db.transaction(async (tx) => plan.dbEffects?.(tx, sha));
}

async function runAgent(env: MiniEnv, task: TaskRow, ctx: PipelineContext, attempt: number): Promise<TaskResult> {
  const h = handlerFor(task.kind as TaskKind);
  const book = ctx.book as BookHandle;
  const runId = randomUUID();
  const runDir = path.join(env.root, 'runs', runId);
  const inDir = path.join(runDir, 'in');
  await fs.mkdir(inDir, { recursive: true });
  const snapshotDir = path.join(runDir, 'book');
  const head = await book.repo.head();
  const snapshot = await createRunSnapshot(book.dir, head, snapshotDir);
  try {
    await buildViews(snapshotDir);
    const workDir = path.join(snapshotDir, 'work', task.id, `attempt-${attempt}`);
    const outDir = path.join(workDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const run: RunContext = {
      runId,
      attempt,
      runDir,
      snapshotDir,
      outDir,
      inDir,
      baseCommit: head,
      profileId: 'fake',
      accountId: null,
      harness: 'fake',
      model: 'fake-model',
      role: (task.role ?? h.role) as RoleId,
      degraded: [],
    };
    const prepared = await h.prepare?.(ctx, task, run);
    if (!prepared) throw new Error(`no prepare for ${task.kind}`);
    if (prepared.kind === 'skip') return prepared.result;
    const plan: AgentPlan = prepared.plan;
    for (const i of plan.inputs) {
      const abs = path.join(inDir, i.to);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.copyFile(i.from, abs);
    }
    const nth = (env.kindCount.get(`${task.kind}:${task.target}`) ?? 0) + 1;
    env.kindCount.set(`${task.kind}:${task.target}`, nth);
    const wo = path.join(inDir, 'workorder.md');
    await fs.writeFile(wo, renderWorkOrder({ ...plan.frontmatter, schema: 'nv.workorder/1', task_id: task.id, run_id: runId, out_dir: outDir }, plan.body));
    const sys = path.join(inDir, 'system.md');
    await fs.writeFile(sys, '');
    const scenarioFile = path.join(inDir, 'fake.json');
    await fs.writeFile(scenarioFile, JSON.stringify(env.scenario(task, nth)));
    await execFileP(process.execPath, [FAKE_HARNESS, '--workorder', wo, '--system', sys, '--scenario', scenarioFile, '--session', runId], { maxBuffer: 16 * 1024 * 1024 });
    const { stagedDir, files } = await harvestOut(outDir, book.dir, task.id, attempt);
    const harvested: HarvestedRun = {
      run,
      outcome: { status: 'success' } as unknown as HarvestedRun['outcome'],
      stagedOutDir: stagedDir,
      files,
      artifacts: plan.frontmatter.artifacts,
      nonce: { layers: [], tainted: false, missingTail: [], ok: true },
      audit: { ok: true, extraFiles: [], tamperedConfig: [] },
    };
    if (!h.finalize) throw new Error(`no finalize for ${task.kind}`);
    return await h.finalize(ctx, task, harvested);
  } finally {
    await removeRunSnapshot(snapshot).catch(() => {});
  }
}

/** 运行队列头部一个任务；返回是否还有任务 */
async function runOne(env: MiniEnv): Promise<boolean> {
  const id = env.queue.shift();
  if (!id) return false;
  const ctx = await env.ctx();
  const task = await loadTask(env, id);
  let attempt = 1;
  let result: TaskResult | null = null;
  const h = handlerFor(task.kind as TaskKind);
  for (; attempt <= task.maxAttempts; attempt++) {
    await env.dbh.db.update(tasks).set({ attempts: attempt }).where(eq(tasks.id, id));
    const fresh = await loadTask(env, id);
    result = h.execute ? await h.execute(await env.ctx(), fresh) : await runAgent(env, fresh, await env.ctx(), attempt);
    if (result.status !== 'retry') break;
    await env.dbh.db.update(tasks).set({ lastError: result.message ?? null, lastErrorClass: result.errorClass ?? null }).where(eq(tasks.id, id));
  }
  const final = result as TaskResult;
  env.log.push({ kind: task.kind, target: task.target, status: final.status, ...(final.message ? { message: final.message } : {}) });
  if (final.promote) await applyPromote(env, ctx.book?.repo ?? openRepo(env.bookDir), final.promote, id);
  if (final.chapter) {
    const { no, state, workflow } = final.chapter;
    const set = { state, ...(workflow ? { workflow } : {}) };
    await env.dbh.db.insert(chapters).values({ bookId: env.bookId, no, chapterId: `c${String(no).padStart(5, '0')}`, ...set }).onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set });
  }
  for (const i of final.inbox ?? []) {
    env.inbox.push(i);
    if (i.dedupeKey) env.openApprovals.add(i.dedupeKey);
  }
  await env.dbh.db.update(tasks).set({ state: final.status === 'retry' ? 'failed' : final.status === 'hold' ? 'blocked' : final.status === 'waiting' ? 'waiting' : final.status }).where(eq(tasks.id, id));
  const after = await env.ctx();
  for (const f of final.followups ?? []) await enqueueSpec(env, f, after);
  for (const f of await onTaskDone(after, await loadTask(env, id), final)) await enqueueSpec(env, f, after);
  return true;
}

async function runtimeState(env: MiniEnv): Promise<BookRuntimeState> {
  const rows = await env.dbh.db.select().from(books).where(eq(books.id, env.bookId)).limit(1);
  const b = rows[0];
  if (!b) throw new Error('book missing');
  const active = (await env.dbh.db.select().from(tasks).where(eq(tasks.bookId, env.bookId))).filter((t) => ['ready', 'leased', 'running', 'finalizing', 'waiting'].includes(t.state));
  return {
    active: active.map((t) => ({ id: t.id, kind: t.kind, target: t.target, lane: t.lane, state: t.state })),
    acceptedThrough: b.acceptedThrough,
    cardsThrough: b.cardsThrough,
    publishedThrough: b.publishedThrough,
    auditedThrough: b.auditedThrough,
    productionPaused: false,
    openApprovals: [...env.openApprovals],
  };
}

export async function startBook(env: MiniEnv, opts: { interview?: boolean } = {}): Promise<void> {
  const ctx = await env.ctx();
  for (const s of initialTasks(ctx.book as BookHandle, { interview: opts.interview ?? false })) await enqueueSpec(env, s, ctx);
}

/** 跑到空闲：把 queue 跑完 → 调 nextTasks → 再跑，直到 nextTasks 也不再产生新任务 */
export async function runUntilIdle(env: MiniEnv, maxSteps = 400): Promise<void> {
  for (let i = 0; i < maxSteps; i++) {
    if (await runOne(env)) continue;
    const ctx = await env.ctx();
    const state = await runtimeState(env);
    let added = 0;
    for (const s of await nextTasks(ctx, state)) if (await enqueueSpec(env, s, ctx)) added += 1;
    if (added === 0) return;
  }
  throw new Error('runUntilIdle: too many steps');
}
