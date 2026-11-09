/**
 * 单个任务的执行（把 A/B/C/D/E 串起来；见 pipeline/types.ts 顶部的生命周期）。Owner: lane F。
 * 失败映射见 DESIGN §7.6 错误类 → 动作表；output_contract 同 profile 2 次后换 profile；TAIL nonce 缺失重跑一次仍缺 → profile 标“不可承载”。
 *
 * executeTask 返回 TaskResult（可能带 promote）；提交、入队、完成状态由 finishTask 负责。两者都不在事务里跨越模型调用。
 * 恢复（serve 崩溃）：runs/active 下的 run 通过 recovery.ts 接管后也走这里的 finishRun 尾段。
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Capabilities, ErrorClass, HarnessInstall, NEvent, Outcome, QualityTier, RoleId, RunState, TaskKind, WorkOrderFrontmatter } from '@novelist/shared';
import { toJsonSchema, zAccount, zCapabilities, zReceipt } from '@novelist/shared';
import type { AppConfig, DataPaths } from '../config/index.js';
import type { Db } from '../db/client.js';
import { accounts, books, capabilities, chapters, profiles, runEvents, runs, tasks } from '../db/schema.js';
import { compileInstructions, resolveStack, checkNonces, type CompiledInstructions, type NonceCheckReport } from '../instructions/index.js';
import type { Logger } from '../log.js';
import type { SecretStore } from '../services/secrets.js';
import type { AgentPlan, BookHandle, HarvestedRun, PipelineContext, PipelineDeps, PromotePlan, TaskHandler, TaskRow, TaskResult, TaskSpec } from '../pipeline/types.js';
import { P } from '../book/layout.js';
import { createRunSnapshot, harvestOut, removeRunSnapshot } from '../book/worktree.js';
import { buildViews } from '../state/index.js';
import { RunPrepareError, defaultCapabilities, getAdapter, probeIsolation, reattachRun, resolveAccount, startRun, syncBackCredentials, type HarnessAdapter, type ResolvedAccount, type RunEventSink, type RunHandle, type RunResult, type RunSpec } from '../harness/index.js';
import type { EventBus } from './bus.js';
import { planFailure, INFRA_CLASSES, type FailurePlan } from './actions.js';
import { defaultPipeline, type PipelineBinding } from './binding.js';
import { applyCanaryResult, recordRun } from './circuit.js';
import { promote, withRepoLock, type PromoteMeta, type PromoteOutcome } from './committer.js';
import { createInboxItem } from './inbox.js';
import { chapterNoOf, orchOf, withOrch, type OrchTaskState } from './orch-state.js';
import { ACTIVE_STATES, completeTask, enqueue, renewLease, setTaskState } from './queue.js';
import { accountUsdCapReached, checkBookBudget, expectedChapterCost, expectedTaskCost, markAuthBad, recordRateLimit, releaseReservations, reserve, settle, sleepAccount, utilSnapshot } from './quota.js';
import { effectiveRouting, loadSystemSettings, resolveRoute, vendorOf, writerHarnesses, type ResolvedRoute } from './routing.js';

export interface ExecutorDeps {
  db: Db;
  config: AppConfig;
  paths: DataPaths;
  log: Logger;
  bus: EventBus;
  secrets: SecretStore;
  /** runner 标识（lease owner） */
  owner: string;
  /** 测试注入 pipeline（默认 lane E 实现） */
  pipeline?: PipelineBinding;
  now?: () => Date;
  /** 测试：退避基数（默认 30s） */
  backoffBaseMs?: number;
}

/** 内部用的上下文 */
export interface ExecEnv extends ExecutorDeps {
  pipe: PipelineBinding;
  pdeps: PipelineDeps;
  nowFn: () => Date;
}

export function execEnv(deps: ExecutorDeps): ExecEnv {
  const nowFn = deps.now ?? (() => new Date());
  return { ...deps, pipe: deps.pipeline ?? defaultPipeline, nowFn, pdeps: { db: deps.db, config: deps.config, paths: deps.paths, log: deps.log, now: nowFn } };
}

const LEASE_MS = 60_000;
export const leaseMs = LEASE_MS;

/** 提交用的元信息（harness/model/isolation），挂在 TaskResult 上传给 finishTask */
const RESULT_META = new WeakMap<TaskResult, { meta: PromoteMeta; harvested: HarvestedRun | null }>();
function attachMeta(result: TaskResult, meta: PromoteMeta, harvested: HarvestedRun | null): TaskResult {
  RESULT_META.set(result, { meta, harvested });
  return result;
}

const STALE_MARK = 'stale_pre_run';
const staleResult = (reason: string): TaskResult => ({ status: 'failed', message: reason, summary: { [STALE_MARK]: true } });

const ACTIVE_RUN_STATES: RunState[] = ['preparing', 'spawned', 'running'];
export { ACTIVE_RUN_STATES };

function runDirFor(paths: DataPaths, runId: string, now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return path.join(paths.runs, `${yyyy}-${mm}`, runId);
}

// ───────────────────────── 辅助 ─────────────────────────

const installCache = new Map<string, { at: number; inst: HarnessInstall }>();
async function detectInstall(env: ExecEnv, adapter: HarnessAdapter): Promise<HarnessInstall> {
  const cached = installCache.get(adapter.id);
  if (cached && Date.now() - cached.at < 60_000) return cached.inst;
  const found = await adapter.detect(env.config.harnessDir);
  if (!found) throw new RunPrepareError('config', 'spawn', `harness ${adapter.id} 未安装`);
  const inst: HarnessInstall = { id: adapter.id, version: found.version, binPath: found.binPath, sha256: '', sha256Source: 'tofu', tier: 'unknown', status: 'active' };
  installCache.set(adapter.id, { at: Date.now(), inst });
  return inst;
}

async function loadCaps(env: ExecEnv, harness: string, version: string, isolation: Capabilities['isolation']): Promise<Capabilities> {
  const rows = await env.db
    .select()
    .from(capabilities)
    .where(and(eq(capabilities.harness, harness), eq(capabilities.version, version), eq(capabilities.isolation, isolation)))
    .limit(1);
  if (rows[0]) {
    const parsed = zCapabilities.safeParse(rows[0].body);
    if (parsed.success) return parsed.data;
  }
  return defaultCapabilities(harness as RunSpec['harness'], version, isolation);
}

async function resolvedAccountFor(env: ExecEnv, route: ResolvedRoute): Promise<ResolvedAccount> {
  if (route.accountObj) return resolveAccount(route.accountObj, env.paths, env.secrets);
  // fake 无账号：合成一个占位账号（home 在 $DATA/accounts/fake-default）
  const account = zAccount.parse({ id: 'fake-default', harness: 'fake', authMode: 'none' });
  return resolveAccount(account, env.paths, env.secrets);
}

/** shellTool='always' 的 harness 上的 profile（codex / dsh：工具集里的 shell 关不掉） */
async function shellProfiles(env: ExecEnv): Promise<string[]> {
  const rows = await env.db.select({ id: profiles.id, harness: profiles.harness }).from(profiles);
  return rows.filter((p) => { try { return getAdapter(p.harness as RunSpec['harness']).defaults?.shellTool === 'always'; } catch { return false; } }).map((p) => p.id);
}

async function writerVendorFor(env: ExecEnv, book: BookHandle | null): Promise<string | null> {
  if (!book) return null;
  const rows = await env.db.select({ w: books.writerProfile }).from(books).where(eq(books.id, book.id)).limit(1);
  const preset = await effectiveRouting(env.db, book);
  const profileId = book.config.routing.writer_profile ?? rows[0]?.w ?? preset.roles.writer?.chain[0];
  if (!profileId) return null;
  const pRows = await env.db.select({ h: profiles.harness }).from(profiles).where(eq(profiles.id, profileId)).limit(1);
  return pRows[0] ? vendorOf(pRows[0].h) : null;
}

async function routeVendorOf(env: ExecEnv, book: BookHandle | null, role: RoleId): Promise<string | null> {
  const preset = await effectiveRouting(env.db, book);
  const first = preset.roles[role]?.chain[0];
  if (!first) return null;
  const rows = await env.db.select({ h: profiles.harness }).from(profiles).where(eq(profiles.id, first)).limit(1);
  return rows[0] ? vendorOf(rows[0].h) : null;
}

function normalizeTierOrNull(tier: string | null): QualityTier | null {
  return (tier as QualityTier | null) ?? null;
}

// ───────────────────────── 事件落库 ─────────────────────────

class EventLog implements RunEventSink {
  private buf: NEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  readonly events: NEvent[] = [];
  private unknown = 0;
  private total = 0;
  closed = false;

  constructor(
    private readonly env: ExecEnv,
    private readonly runId: string,
    private readonly accountId: string | null,
    private readonly onActivityCb: () => void,
  ) {}

  async onEvent(e: NEvent): Promise<void> {
    if (this.closed) return;
    this.total += 1;
    if (e.t === 'unknown') this.unknown += 1;
    this.events.push(e);
    this.buf.push(e);
    if (e.t !== 'heartbeat') this.env.bus.publish({ type: 'run_event', runId: this.runId, event: e });
    if (e.t === 'rate_limit' && this.accountId) {
      await recordRateLimit(this.env.db, this.accountId, { window: e.window, status: e.status, ...(e.utilization !== undefined ? { utilization: e.utilization } : {}), ...(e.resetsAt ? { resetsAt: e.resetsAt } : {}) }).catch(() => {});
    }
    if (this.buf.length >= 50) await this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 1000);
  }

  onActivity(): void {
    this.onActivityCb();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) await this.flushing;
    const batch = this.buf;
    if (batch.length === 0) return;
    this.buf = [];
    const rows = batch.map(({ seq, ts, runId: _r, ...body }) => ({ runId: this.runId, seq, ts: ts || new Date().toISOString(), t: body.t, body: body as Record<string, unknown> }));
    this.flushing = this.env.db
      .insert(runEvents)
      .values(rows)
      .onConflictDoNothing()
      .then(() => undefined)
      .catch((err) => {
        this.env.log.warn({ err: (err as Error).message, runId: this.runId }, 'run_events flush failed');
      })
      .finally(() => {
        this.flushing = null;
      });
    await this.flushing;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  unknownRatio(): number {
    return this.total ? this.unknown / this.total : 0;
  }
}

// ───────────────────────── run 会话（可持久化，供 reattach） ─────────────────────────

export interface RunSession {
  schema: 'nv.session/1';
  spec: RunSpec;
  runCtx: HarvestedRun['run'];
  reservationIds: string[];
  utilBefore: Record<string, number>;
  harnessVersion: string;
  isolation: Capabilities['isolation'];
  compiled: Pick<CompiledInstructions, 'nonces' | 'stackHash'>;
  artifacts: AgentPlan['frontmatter']['artifacts'];
  billUsd: boolean;
  accountEnvNames: string[];
}

export async function loadSession(runDir: string): Promise<RunSession | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(runDir, 'in', 'session.json'), 'utf8')) as RunSession;
  } catch {
    return null;
  }
}

// ───────────────────────── 主入口 ─────────────────────────

export async function executeTask(deps: ExecutorDeps, task: TaskRow, signal: AbortSignal): Promise<TaskResult> {
  const env = execEnv(deps);
  const handler = env.pipe.handlerFor(task.kind as TaskKind);
  const book = task.bookId ? await env.pipe.openBook(env.pdeps, task.bookId) : null;
  const ctx: PipelineContext = { deps: env.pdeps, book };

  const orch = orchOf(task);
  if (orch.recover) {
    const recovered = await executeRecovery(env, ctx, handler, task, orch.recover);
    if (recovered) return recovered;
    // VALIDATED.json 不存在：退回普通执行
  }

  if (handler.role === null) {
    if (!handler.execute) return { status: 'failed', errorClass: 'config', message: `handler ${task.kind} 没有 execute` };
    await setTaskState(env.db, task.id, 'running');
    if (book) {
      const staleReason = await preRunStale(book, task);
      if (staleReason) return staleResult(staleReason);
    }
    return handler.execute(ctx, task);
  }
  return runAgentTask(env, ctx, handler, task, signal);
}

/** claim 后、昂贵的 run 之前先比 hard manifest；变了直接作废，不浪费模型调用 */
async function preRunStale(book: BookHandle, task: TaskRow): Promise<string | null> {
  const paths = Object.keys(task.hardManifest);
  if (paths.length === 0) return null;
  const head = await book.repo.head();
  const now = await book.repo.blobShas(paths, head);
  const changed = paths.filter((p) => (task.hardManifest[p] ?? '') !== (now[p] ?? ''));
  return changed.length > 0 ? `hard deps changed before run: ${changed.join(', ')}` : null;
}

async function runAgentTask(env: ExecEnv, ctx: PipelineContext, handler: TaskHandler, task: TaskRow, signal: AbortSignal): Promise<TaskResult> {
  const book = ctx.book;
  const orch = orchOf(task);
  const now = env.nowFn();
  const role = (task.role ?? handler.role) as RoleId;
  const tier: QualityTier = normalizeTierOrNull(task.tier) ?? (book ? env.pipe.effectiveTier(book, chapterNoOf(task.target)) : 'standard');

  if (book) {
    const staleReason = await preRunStale(book, task);
    if (staleReason) return staleResult(staleReason);
    const budget = await checkBookBudget(env.db, book, task.kind as TaskKind, now);
    if (!budget.ok) return { status: 'waiting', retryAfter: budget.waitUntil ?? new Date(now.getTime() + 1800_000).toISOString(), message: budget.reason ?? 'budget' };
  }

  // 1. 路由
  const writerVendor = role === 'writer' ? null : await writerVendorFor(env, book);
  const plannerVendor = role === 'plan_judge' ? await routeVendorOf(env, book, 'planner') : null;
  const excludeProfiles = Array.isArray(task.params.excludeProfiles) ? (task.params.excludeProfiles as string[]) : [];
  // 不可信输入（v1 导入正文）不走带 shell 的 harness（DESIGN §10.6）。必须走 avoidProfiles：excludeProfiles 只在 not_in_judges 约束下生效
  const noShell = task.kind === 'import.bootstrap' ? await shellProfiles(env) : [];
  const avoidProfiles = [...(orch.avoidProfiles ?? []), ...noShell];
  const resolveAvoiding = (avoid: string[]) =>
    resolveRoute(env.db, {
      role,
      book,
      tier,
      writerVendor,
      plannerVendor,
      ...(excludeProfiles.length ? { excludeProfiles } : {}),
      ...(avoid.length ? { avoidProfiles: avoid } : {}),
      ...(orch.avoidVendors?.length ? { avoidVendors: orch.avoidVendors } : {}),
      now,
      allowFakeHarness: env.config.allowFakeHarness,
    });
  let route = await resolveAvoiding(avoidProfiles);
  // 产物不合格时换 profile 只是优化：没有别的 profile 可换就继续用原来的，次数上限由 handler 兜底。noShell 是安全约束，始终保留
  const keepAvoiding = (orch.avoidProfiles ?? []).filter((p) => !orch.contractFailures?.[p]);
  if (!route.profile && !route.waitUntil && keepAvoiding.length < (orch.avoidProfiles?.length ?? 0)) route = await resolveAvoiding([...keepAvoiding, ...noShell]);
  if (!route.profile || !route.profileObj) return routeFailure(env, task, route, book);
  if (role === 'writer' && book) await rememberWriter(env, book, route);

  // 2. 配额
  if (route.accountObj) {
    const capUntil = await accountUsdCapReached(env.db, route.accountObj, now);
    if (capUntil) {
      await sleepAccount(env.db, route.accountObj.id, capUntil, '账号月度 USD 上限');
      return { status: 'waiting', retryAfter: capUntil, message: '账号月度 USD 上限' };
    }
  }
  let reservationIds: string[] = [];
  if (route.account) {
    const costs =
      task.kind === 'chapter.write' && book
        ? await expectedChapterCost(env.db, { bookId: book.id, tier, book, writer: { profileId: route.profile, accountId: route.account }, allowFakeHarness: env.config.allowFakeHarness })
        : await expectedTaskCost(env.db, { profileId: route.profile, accountId: route.account, kind: task.kind as TaskKind, tier });
    const res = await reserve(env.db, { taskId: task.id, bookId: task.bookId, costs, now });
    if (!res.ok) {
      env.bus.publish({ type: 'quota_wait', accountId: route.account, until: res.waitUntil, reason: res.reason });
      return { status: 'waiting', retryAfter: res.waitUntil ?? new Date(now.getTime() + 1800_000).toISOString(), message: `配额：${res.reason}` };
    }
    reservationIds = res.ids;
  }

  // 3. run 行与目录
  const runId = randomUUID();
  const attempt = task.attempts + 1;
  const runDir = runDirFor(env.paths, runId, now);
  const inDir = path.join(runDir, 'in');
  const logDir = path.join(runDir, 'log');
  const snapshotDir = path.join(runDir, 'book');
  await fs.mkdir(inDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(env.paths.runsActive, { recursive: true });
  const activeLink = path.join(env.paths.runsActive, runId);
  await fs.symlink(path.relative(env.paths.runsActive, runDir), activeLink).catch(() => {});

  const adapter = getAdapter(route.harness as RunSpec['harness']);
  const settings = await loadSystemSettings(env.db);
  let installInfo: HarnessInstall;
  let snapshot: Awaited<ReturnType<typeof createRunSnapshot>> | null = null;
  let resolved: ResolvedAccount | null = null;
  const cleanupRun = async (state: RunState, errorClass: ErrorClass | null): Promise<void> => {
    await releaseReservations(env.db, reservationIds);
    await env.db.update(runs).set({ state, errorClass, endedAt: new Date().toISOString() }).where(eq(runs.id, runId));
    await fs.rm(activeLink, { force: true });
    if (snapshot) await removeRunSnapshot(snapshot).catch(() => {});
    env.bus.publish({ type: 'run_exit', runId, state, errorClass });
  };

  try {
    installInfo = await detectInstall(env, adapter);
    const isolationPref = settings.isolation !== 'auto' ? settings.isolation : env.config.isolation;
    const isolation = (await probeIsolation(isolationPref)).selected;
    const caps = await loadCaps(env, route.harness as string, installInfo.version, isolation);

    await env.db.insert(runs).values({
      id: runId,
      taskId: task.id,
      bookId: task.bookId,
      taskKind: task.kind,
      attempt,
      role,
      profileId: route.profile,
      accountId: route.account,
      harness: route.harness as string,
      harnessVersion: installInfo.version,
      model: route.model,
      isolation,
      state: 'preparing',
      leaseOwner: env.owner,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      runDir,
    });
    await setTaskState(env.db, task.id, 'running');
    env.bus.publish({ type: 'run_started', runId, taskId: task.id, book: book?.slug ?? null, role, profile: route.profile });

    // 4. 快照（持锁建 worktree，然后释放）
    let baseCommit = '';
    if (book) {
      baseCommit = await withRepoLock(env.db, book.id, book.repo, async () => {
        const head = await book.repo.head();
        snapshot = await createRunSnapshot(book.dir, head, snapshotDir);
        return head;
      });
      try {
        await buildViews(snapshotDir);
      } catch (err) {
        env.log.warn({ err: (err as Error).message, taskId: task.id }, 'buildViews failed (继续执行)');
      }
    } else {
      await fs.mkdir(snapshotDir, { recursive: true });
    }
    const outDir = path.join(snapshotDir, P.workOut(task.id, attempt));
    await fs.mkdir(outDir, { recursive: true });

    const runCtx: HarvestedRun['run'] = {
      runId,
      attempt,
      runDir,
      snapshotDir,
      outDir,
      inDir,
      baseCommit,
      profileId: route.profile,
      accountId: route.account,
      harness: route.harness as string,
      model: route.model as string,
      role,
      degraded: route.degraded,
    };

    // 5. prepare
    const prepared = handler.prepare ? await handler.prepare(ctx, task, runCtx) : ({ kind: 'skip', result: { status: 'failed', errorClass: 'config', message: `handler ${task.kind} 没有 prepare` } } as const);
    if (prepared.kind === 'skip') {
      await cleanupRun('finalized', null);
      return prepared.result;
    }
    const plan = prepared.plan;

    // 6. 工作单 + 指令
    const fm: WorkOrderFrontmatter = { schema: 'nv.workorder/1', task_id: task.id, run_id: runId, out_dir: outDir, ...plan.frontmatter };
    const workOrderText = env.pipe.renderWorkOrder(fm, plan.body);
    const workOrderFile = path.join(inDir, 'workorder.md');
    await fs.writeFile(workOrderFile, workOrderText);
    const snapWorkOrder = path.join(snapshotDir, P.workOrder(task.id));
    await fs.mkdir(path.dirname(snapWorkOrder), { recursive: true });
    await fs.writeFile(snapWorkOrder, workOrderText);
    for (const input of plan.inputs) {
      const dest = path.join(inDir, input.to);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(input.from, dest);
    }
    const dialect = caps.schemaDialect === 'none' ? 'lenient' : caps.schemaDialect;
    const receiptSchemaFile = path.join(inDir, `receipt.${dialect}.json`);
    await fs.writeFile(receiptSchemaFile, JSON.stringify(toJsonSchema(zReceipt, dialect)));

    const stack = await resolveStack({
      globalDir: env.paths.instructionsGlobal,
      genreDirs: book ? book.genre.chain.map((g) => ({ id: g.id, dir: g.dir })) : [],
      bookDir: book ? snapshotDir : null,
      role,
      taskKind: task.kind as TaskKind,
      ownerNotes: [...plan.ownerNotes, ...(orch.ownerNotes ?? [])],
    });
    const compiled = compileInstructions(stack, { nonces: 'random' });
    const systemFile = path.join(inDir, 'system.md');
    await fs.writeFile(systemFile, compiled.systemMd);

    // 7. RunSpec + 启动
    const limits = {
      wallMs: plan.limits?.wallMs ?? route.profileObj.limits.wallMs ?? settings.wallTimeoutMs,
      idleMs: plan.limits?.idleMs ?? route.profileObj.limits.idleMs ?? (role === 'writer' ? settings.idleTimeouts.writerMs : route.harness === 'dsh' ? settings.idleTimeouts.dshMs : settings.idleTimeouts.otherMs),
      maxTurns: plan.limits?.maxTurns ?? route.profileObj.limits.maxTurns ?? 60,
      ...(plan.limits?.maxBudgetUsd !== undefined ? { maxBudgetUsd: plan.limits.maxBudgetUsd } : route.profileObj.limits.maxBudgetUsd !== undefined ? { maxBudgetUsd: route.profileObj.limits.maxBudgetUsd } : {}),
    };
    const spec: RunSpec = {
      runId,
      taskId: task.id,
      attempt,
      role,
      taskKind: task.kind as TaskKind,
      harness: route.harness as RunSpec['harness'],
      profileId: route.profile,
      accountId: route.account,
      bookSlug: book?.slug ?? null,
      runDir,
      bookDir: snapshotDir,
      outDir,
      inDir,
      logDir,
      workOrderFile,
      systemFile,
      receiptSchemaFile,
      model: route.model as string,
      ...(route.profileObj.effort ? { effort: route.profileObj.effort } : {}),
      limits,
      session: plan.resume?.sessionId && caps.resume ? { mode: 'resume', id: plan.resume.sessionId } : { mode: 'fresh', id: runId },
      persistSession: false,
      egress: { allow: [] },
      subagents: /^(plan|audit)\./.test(task.kind),
      extraArgs: route.profileObj.extra_args,
    };

    resolved = await resolvedAccountFor(env, route);
    const utilBefore = route.account ? await utilSnapshot(env.db, route.account) : {};
    const session: RunSession = {
      schema: 'nv.session/1',
      spec,
      runCtx,
      reservationIds,
      utilBefore,
      harnessVersion: installInfo.version,
      isolation,
      compiled: { nonces: compiled.nonces, stackHash: compiled.stackHash },
      artifacts: plan.frontmatter.artifacts,
      billUsd: route.accountObj ? ['api_key', 'custom_api'].includes(route.accountObj.authMode) : false,
      accountEnvNames: resolved ? Object.keys(resolved.secretEnv) : [],
    };
    await fs.writeFile(path.join(inDir, 'session.json'), JSON.stringify(session));
    await env.db.update(runs).set({ baseCommit, stackHash: compiled.stackHash }).where(eq(runs.id, runId));

    let handle: RunHandle;
    const log = new EventLog(env, runId, route.account, () => undefined);
    try {
      handle = await startRun({ spec, adapter, account: resolved, install: installInfo, caps, isolation, compiled }, log);
    } catch (err) {
      await log.close();
      const cls: ErrorClass = err instanceof RunPrepareError ? err.errorClass : 'config';
      const code = err instanceof RunPrepareError ? err.code : 'spawn';
      await cleanupRun('killed', cls);
      if (code === 'budget' || code === 'not_allowed') return { status: 'retry', errorClass: cls, message: (err as Error).message, retryAfter: now.toISOString(), avoidProfile: route.profile };
      return { status: 'retry', errorClass: cls, message: (err as Error).message };
    }
    await env.db.update(runs).set({ state: 'running', shimPid: handle.shimPid, harnessPid: handle.harnessPid, startedAt: handle.startedAt }).where(eq(runs.id, runId));

    return finishRun(env, ctx, handler, task, { handle, log, session, activeLink, snapshot, route, resolved, signal, adapter, tier });
  } catch (err) {
    await cleanupRun('killed', 'unknown').catch(() => {});
    env.log.warn({ err: (err as Error).message, taskId: task.id }, 'agent task failed before run');
    return { status: 'retry', errorClass: 'unknown', message: (err as Error).message };
  }
}

/** run 进行中：等待、收割、finalize（也是 reattach 的入口） */
export async function finishRun(
  env: ExecEnv,
  ctx: PipelineContext,
  handler: TaskHandler,
  task: TaskRow,
  r: {
    handle: RunHandle;
    log: EventLog;
    session: RunSession;
    activeLink: string;
    snapshot: Awaited<ReturnType<typeof createRunSnapshot>> | null;
    route: Pick<ResolvedRoute, 'profile' | 'account' | 'harness' | 'model'>;
    resolved: ResolvedAccount | null;
    signal: AbortSignal;
    adapter: HarnessAdapter;
    tier: QualityTier | null;
  },
): Promise<TaskResult> {
  const { handle, log, session } = r;
  const book = ctx.book;
  let timer: NodeJS.Timeout | null = setInterval(() => {
    void renewRunLease(env, task.id, session.spec.runId).catch(() => {});
  }, LEASE_MS / 3);
  timer.unref();

  const onAbort = (): void => {
    void handle.kill('user').catch(() => {});
  };
  let result: RunResult;
  const detach = new Promise<null>((resolve) => {
    if (r.signal.aborted && r.signal.reason === 'detach') resolve(null);
    r.signal.addEventListener('abort', () => {
      if (r.signal.reason === 'detach') resolve(null);
      else onAbort();
    });
  });
  try {
    const waited = await Promise.race([handle.wait(), detach]);
    if (waited === null) {
      // 进程优雅退出：shim 继续跑，下次启动 reattach
      await log.close();
      return { status: 'waiting', message: 'detached', summary: { detached: true } };
    }
    result = waited;
  } finally {
    if (timer) clearInterval(timer);
    timer = null;
  }
  await log.close();

  const finalState: RunState = result.outcome.status === 'cancelled' ? 'killed' : 'exited';
  await env.db
    .update(runs)
    .set({ state: finalState, endedAt: new Date().toISOString(), exitCode: result.exit.code, errorClass: result.outcome.errorClass ?? null, outcome: { status: result.outcome.status, message: result.outcome.message }, usage: result.outcome.usage as unknown as Record<string, unknown>, denials: result.outcome.denials.length, sessionId: result.outcome.sessionId ?? null, modelReported: result.outcome.model ?? null })
    .where(eq(runs.id, session.spec.runId));

  // 8. 收割
  let stagedOutDir = '';
  let files: string[] = [];
  if (book) {
    const harvested = await harvestOut(session.spec.outDir, book.dir, task.id, session.spec.attempt).catch(() => ({ stagedDir: '', files: [] as string[] }));
    stagedOutDir = harvested.stagedDir;
    files = harvested.files;
    if (r.snapshot) await removeRunSnapshot(r.snapshot).catch(() => {});
  } else {
    stagedOutDir = session.spec.outDir;
    files = await listOut(stagedOutDir);
  }
  if (r.resolved) {
    await syncBack(env, r.resolved).catch((err) => env.log.warn({ err: (err as Error).message }, 'syncBackCredentials failed'));
  }

  // 9. nonce + 组装
  const echoed = await readEchoedNonces(stagedOutDir, result.outcome);
  const nonce: NonceCheckReport = checkNonces({ nonces: session.compiled.nonces, echoed, events: log.events, inDir: session.spec.inDir, role: session.spec.role });
  await env.db.update(runs).set({ nonceReport: nonce.layers as unknown[] }).where(eq(runs.id, session.spec.runId));
  const harvested: HarvestedRun = { run: session.runCtx, outcome: result.outcome, stagedOutDir, files, artifacts: session.artifacts, nonce, audit: result.audit };

  // 10. 结算配额、熔断
  await settle(env.db, {
    reservationIds: session.reservationIds,
    runId: session.spec.runId,
    accountId: r.route.account ?? null,
    profileId: r.route.profile as string,
    harness: r.route.harness as string,
    model: (r.route.model as string | null) ?? null,
    kind: task.kind as TaskKind,
    tier: r.tier,
    bookId: task.bookId,
    outcome: result.outcome,
    utilBefore: session.utilBefore,
    billUsd: session.billUsd,
  }).catch((err) => env.log.warn({ err: (err as Error).message }, 'settle failed'));
  await recordRun(env.db, {
    harness: r.route.harness as string,
    version: session.harnessVersion,
    isolation: session.isolation,
    errorClass: result.outcome.status === 'completed' ? null : (result.outcome.errorClass ?? 'unknown'),
    unknownEventRatio: log.unknownRatio(),
    tailNonceMissing: !nonce.ok && nonce.missingTail.length > 0,
    contractViolations: result.audit.ok ? 0 : 1,
  }).catch(() => {});
  await env.db.update(runs).set({ state: 'finalized' }).where(eq(runs.id, session.spec.runId));
  await fs.rm(r.activeLink, { force: true });
  env.bus.publish({ type: 'run_exit', runId: session.spec.runId, state: 'finalized', errorClass: result.outcome.errorClass ?? null });

  // 11. 判定
  const res = await judgeRun(env, ctx, handler, task, harvested, r.route.profile as string, r.route.harness as string, result.outcome);
  return attachMeta(res, { harness: r.route.harness as string, model: (r.route.model as string | null) ?? undefined, isolation: session.isolation, instructionsHash: session.compiled.stackHash }, harvested);
}

async function renewRunLease(env: ExecEnv, taskId: string, runId: string): Promise<void> {
  const expires = new Date(Date.now() + LEASE_MS).toISOString();
  const now = new Date().toISOString();
  await env.db.update(tasks).set({ leaseExpiresAt: expires, updatedAt: now }).where(and(eq(tasks.id, taskId), eq(tasks.leaseOwner, env.owner)));
  await env.db.update(runs).set({ leaseExpiresAt: expires, heartbeatAt: now }).where(eq(runs.id, runId));
}

async function listOut(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(abs, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  await walk(dir, '');
  return out.sort();
}

async function readEchoedNonces(dir: string, outcome: Outcome): Promise<string[]> {
  const fromOutcome = (outcome.receipt as { nonces?: unknown } | undefined)?.nonces;
  if (Array.isArray(fromOutcome)) return fromOutcome.filter((x): x is string => typeof x === 'string');
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'receipt.json'), 'utf8')) as { nonces?: unknown };
    return Array.isArray(raw.nonces) ? raw.nonces.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function syncBack(env: ExecEnv, acct: ResolvedAccount): Promise<void> {
  if (acct.id === 'fake-default') return;
  const changed = await syncBackCredentials(acct, env.secrets);
  if (changed.length === 0) return;
  const rows = await env.db.select().from(accounts).where(eq(accounts.id, acct.id)).limit(1);
  const row = rows[0];
  if (!row) return;
  await env.db.update(accounts).set({ body: { ...row.body, files: acct.files }, updatedAt: new Date().toISOString() }).where(eq(accounts.id, acct.id));
}

async function judgeRun(env: ExecEnv, ctx: PipelineContext, handler: TaskHandler, task: TaskRow, harvested: HarvestedRun, profile: string, harness: string, outcome: Outcome): Promise<TaskResult> {
  const orch = orchOf(task);
  const cls: ErrorClass = outcome.errorClass ?? (outcome.status === 'completed' ? 'unknown' : outcome.status === 'timeout' ? 'timeout_wall' : 'harness_crash');
  const failed = outcome.status !== 'completed';

  if (outcome.status === 'cancelled') return { status: 'failed', message: outcome.message ?? 'run killed' };

  const denialInOutDir = outcome.denials.some((d) => d.path && d.path.startsWith(harvested.run.outDir));
  const failCtx = {
    taskId: task.id,
    kind: task.kind as TaskKind,
    bookId: task.bookId,
    outcome,
    orch,
    profile,
    accountId: harvested.run.accountId,
    vendor: vendorOf(harness),
    refusalRetryOtherVendor: ctx.book?.config.policy.refusal_retry_other_vendor ?? true,
    denialInOutDir,
    now: env.nowFn(),
  };

  if (failed && (INFRA_CLASSES.has(cls) || harvested.files.length === 0)) {
    return applyFailurePlan(env, task, planFailure(cls, failCtx));
  }
  if (!handler.finalize) return applyFailurePlan(env, task, planFailure('config', failCtx));

  let result: TaskResult;
  try {
    result = await handler.finalize(ctx, task, harvested);
  } catch (err) {
    env.log.warn({ err: (err as Error).message, taskId: task.id }, 'finalize threw');
    return { status: 'retry', errorClass: 'unknown', message: `finalize: ${(err as Error).message}` };
  }

  if (result.status === 'retry' && result.errorClass) {
    // §3.3 产物缺失 + outDir 内 denial → permission_denied；并计入 output_contract 的 profile 计数
    const cls2: ErrorClass = result.errorClass === 'output_contract' && denialInOutDir ? 'permission_denied' : result.errorClass;
    const plan = planFailure(cls2, failCtx);
    return applyFailurePlan(env, task, { ...plan, result: { ...result, errorClass: cls2, ...(plan.result.avoidProfile ? { avoidProfile: plan.result.avoidProfile } : {}), ...(result.avoidProfile ? { avoidProfile: result.avoidProfile } : {}) } });
  }

  // TAIL nonce：重跑一次仍缺 → profile 标“不可承载”（§5.6）
  if (!harvested.nonce.ok && harvested.nonce.missingTail.length > 0) {
    const counts = { ...(orch.tailMissing ?? {}), [profile]: (orch.tailMissing?.[profile] ?? 0) + 1 };
    await patchOrch(env, task, { tailMissing: counts });
    if ((counts[profile] as number) >= 2) {
      await createInboxItem(env.db, env.bus, {
        kind: 'notice',
        bookId: task.bookId,
        title: `profile ${profile} 不可承载该书指令层`,
        body: { profile, taskId: task.id, missingTail: harvested.nonce.missingTail },
        actions: [{ id: 'dismiss', label: '知道了' }],
        dedupeKey: `nonce:${profile}:${task.bookId ?? 'global'}`,
      });
    }
  }
  return result;
}

async function patchOrch(env: ExecEnv, task: TaskRow, patch: Partial<OrchTaskState>): Promise<void> {
  const rows = (await env.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1)) as TaskRow[];
  const row = rows[0];
  if (!row) return;
  await env.db.update(tasks).set({ params: withOrch(row.params, patch), updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id));
}

async function applyFailurePlan(env: ExecEnv, task: TaskRow, plan: FailurePlan): Promise<TaskResult> {
  await patchOrch(env, task, plan.orchPatch);
  if (plan.authBad) await markAuthBad(env.db, plan.authBad.accountId, plan.authBad.detail);
  if (plan.sleep) await sleepAccount(env.db, plan.sleep.accountId, plan.sleep.until, plan.sleep.reason);
  for (const i of plan.inbox ?? []) await createInboxItem(env.db, env.bus, i);
  if (plan.quotaWait) env.bus.publish({ type: 'quota_wait', accountId: plan.quotaWait.accountId, until: plan.quotaWait.until, reason: plan.quotaWait.reason });
  return plan.result;
}

async function routeFailure(env: ExecEnv, task: TaskRow, route: ResolvedRoute, book: BookHandle | null): Promise<TaskResult> {
  const now = env.nowFn();
  await maybeFailover(env, task, route, book, now);
  if (route.waitUntil) return { status: 'waiting', retryAfter: route.waitUntil, message: `路由等待：${route.reason ?? ''}` };
  const cause = route.cause ?? 'no_route';
  if (cause === 'avoided' || cause === 'constraint' || cause === 'vendor') {
    await createInboxItem(env.db, env.bus, {
      kind: 'block',
      bookId: task.bookId,
      title: `任务 ${task.kind}（${task.target}）没有可用路由`,
      body: { taskId: task.id, reason: route.reason },
      actions: [
        { id: 'retry', label: '重试' },
        { id: 'dismiss', label: '忽略' },
      ],
      dedupeKey: `no_route:task:${task.id}`,
      relatedTaskId: task.id,
    });
    return { status: 'blocked', errorClass: 'config', message: route.reason ?? 'no route' };
  }
  await createInboxItem(env.db, env.bus, {
    kind: 'notice',
    bookId: task.bookId,
    title: `角色 ${task.role} 暂无可用路由`,
    body: { taskId: task.id, reason: route.reason, cause },
    actions: [{ id: 'dismiss', label: '知道了' }],
    dedupeKey: `no_route:${task.bookId ?? 'global'}:${task.role}`,
  });
  return { status: 'waiting', retryAfter: new Date(now.getTime() + 10 * 60_000).toISOString(), message: `无可用路由（${cause}）：${route.reason ?? ''}` };
}

/** 写手不可用（auth/熔断/模型下架）持续超过 failover_after → 发 failover 提案（额度窗口不触发） */
async function maybeFailover(env: ExecEnv, task: TaskRow, route: ResolvedRoute, book: BookHandle | null, now: Date): Promise<void> {
  if (!book || task.role !== 'writer') return;
  const preset = await effectiveRouting(env.db, book);
  const writer = preset.roles.writer;
  if (!writer?.failover_chain.length || writer.failover_on.length === 0 || !writer.failover_after_ms) return;
  const cause = route.cause ?? '';
  const eligible = (writer.failover_on as string[]).includes(cause);
  const rows = await env.db.select({ meta: books.meta }).from(books).where(eq(books.id, book.id)).limit(1);
  const meta = (rows[0]?.meta ?? {}) as { writerUnavailableSince?: string | null };
  if (!eligible) {
    if (meta.writerUnavailableSince) await env.db.update(books).set({ meta: sql`${books.meta} || ${JSON.stringify({ writerUnavailableSince: null })}::jsonb` }).where(eq(books.id, book.id));
    return;
  }
  const since = meta.writerUnavailableSince ?? now.toISOString();
  if (!meta.writerUnavailableSince) await env.db.update(books).set({ meta: sql`${books.meta} || ${JSON.stringify({ writerUnavailableSince: since })}::jsonb` }).where(eq(books.id, book.id));
  if (now.getTime() - new Date(since).getTime() < writer.failover_after_ms) return;
  const to = writer.failover_chain[0] as string;
  if (!writer.failover_requires_approval) {
    await env.db.update(books).set({ writerProfile: to, meta: sql`${books.meta} || ${JSON.stringify({ writerUnavailableSince: null })}::jsonb`, updatedAt: now.toISOString() }).where(eq(books.id, book.id));
    return;
  }
  await createInboxItem(env.db, env.bus, {
    kind: 'approval',
    bookId: book.id,
    title: `主笔不可用（${cause}），建议切换到 ${to}`,
    body: { failover: { to, cause }, reason: route.reason },
    actions: [
      { id: 'approve', label: `切换到 ${to}` },
      { id: 'dismiss', label: '继续等待' },
    ],
    dedupeKey: `failover:${book.id}`,
  });
}

async function rememberWriter(env: ExecEnv, book: BookHandle, route: ResolvedRoute): Promise<void> {
  const preset = await effectiveRouting(env.db, book);
  if (preset.roles.writer?.sticky !== 'book') return;
  await env.db
    .update(books)
    .set({ writerProfile: route.profile, updatedAt: new Date().toISOString() })
    .where(and(eq(books.id, book.id), sql`${books.writerProfile} is null`));
}

// ───────────────────────── VALIDATED.json + 恢复 ─────────────────────────

/** PromotePlan 的可序列化形式（dbEffects 闭包除外；Buffer 用 base64） */
type SerializedPlan = Omit<PromotePlan, 'files' | 'dbEffects'> & { files: { path: string; content: string | { b64: string } | null }[] };
type PersistedResult = Omit<TaskResult, 'promote'>;

interface ValidatedFile {
  schema: 'nv.validated/1';
  taskId: string;
  attempt: number;
  generation: number;
  meta: PromoteMeta;
  harvested: HarvestedRun | null;
  /** §7.7：恢复时只重放这份已验证的提交计划，不再重跑 handler（缺失 = 该结果带闭包，退回重跑） */
  plan?: SerializedPlan;
  result?: PersistedResult;
}

function serializePlan(plan: PromotePlan): SerializedPlan | null {
  if (plan.dbEffects && !plan.effect) return null;
  const { dbEffects: _closure, files, ...rest } = plan;
  return { ...rest, files: files.map((f) => ({ path: f.path, content: Buffer.isBuffer(f.content) ? { b64: f.content.toString('base64') } : f.content })) };
}

function deserializePlan(doc: SerializedPlan): PromotePlan {
  return { ...doc, files: doc.files.map((f) => ({ path: f.path, content: f.content !== null && typeof f.content === 'object' ? Buffer.from(f.content.b64, 'base64') : f.content })) };
}

function validatedPath(book: BookHandle, task: TaskRow): string {
  return path.join(book.dir, P.validated(task.id, task.attempts + 1));
}

async function writeValidated(book: BookHandle, task: TaskRow, meta: PromoteMeta, harvested: HarvestedRun | null, result: TaskResult): Promise<void> {
  const file = validatedPath(book, task);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const { promote: plan, ...persisted } = result;
  const serialized = plan ? serializePlan(plan) : null;
  const doc: ValidatedFile = { schema: 'nv.validated/1', taskId: task.id, attempt: task.attempts + 1, generation: orchOf(task).generation ?? 1, meta, harvested, ...(serialized ? { plan: serialized, result: persisted } : {}) };
  await fs.writeFile(file, JSON.stringify(doc));
}

async function executeRecovery(env: ExecEnv, ctx: PipelineContext, handler: TaskHandler, task: TaskRow, recover: NonNullable<OrchTaskState['recover']>): Promise<TaskResult | null> {
  if (!ctx.book) return null;
  let doc: ValidatedFile;
  try {
    doc = JSON.parse(await fs.readFile(validatedPath(ctx.book, task), 'utf8')) as ValidatedFile;
  } catch {
    await patchOrch(env, task, { recover: undefined });
    return null;
  }
  await setTaskState(env.db, task.id, 'finalizing');
  void recover; // mode 不改变流程：promote 按 trailer 幂等，已提交时只补 tag + 重放 dbEffects（effectsCommit 去重）
  if (doc.plan && doc.result) {
    // 正常路径：重放已验证的提交计划与 followups，不调用 handler（handler 基于已变化的 HEAD/workflow，不可重入）
    return attachMeta({ ...doc.result, promote: deserializePlan(doc.plan) }, doc.meta, doc.harvested);
  }
  let result: TaskResult;
  if (handler.role === null) {
    if (!handler.execute) return null;
    result = await handler.execute(ctx, task);
  } else {
    if (!doc.harvested || !handler.finalize) return null;
    result = await handler.finalize(ctx, task, doc.harvested);
  }
  return attachMeta(result, doc.meta, doc.harvested);
}

// ───────────────────────── 完成：提交、入队、outbox ─────────────────────────

/** 把一个 TaskResult 变成持久状态（promote → completeTask → outbox 投递）。executeTask 之后调用。 */
export async function finishTask(deps: ExecutorDeps, task: TaskRow, result: TaskResult): Promise<void> {
  const env = execEnv(deps);
  const latest = ((await env.db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1)) as TaskRow[])[0];
  if (!latest) return;
  if (latest.state === 'cancelled') return;
  if (result.summary?.detached) return; // 进程退出：lease 过期后由 recovery 接管
  // fencing：lease 过期被别的 runner 接走后，这里的旧结果不能再提交
  if (!ACTIVE_STATES.includes(latest.state as (typeof ACTIVE_STATES)[number]) || (latest.leaseOwner && latest.leaseOwner !== env.owner)) {
    env.log.warn({ taskId: task.id, state: latest.state, leaseOwner: latest.leaseOwner }, 'finishTask: 已失去 lease，丢弃结果');
    return;
  }
  const bookId = task.bookId;

  if (result.summary?.[STALE_MARK]) {
    await setTaskState(env.db, task.id, 'stale', { waitReason: 'stale', error: result.message ?? 'stale' });
    env.bus.publish({ type: 'task_changed', taskId: task.id, book: bookId, state: 'stale' });
    return;
  }

  const attached = RESULT_META.get(result);
  let promoted: PromoteOutcome | null = null;
  if (result.promote && (result.status === 'done' || result.status === 'hold')) {
    const book = await env.pipe.openBook(env.pdeps, bookId as string);
    const handler = env.pipe.handlerFor(task.kind as TaskKind);
    await writeValidated(book, latest, attached?.meta ?? {}, attached?.harvested ?? null, result);
    await setTaskState(env.db, task.id, 'finalizing');
    const ctx: PipelineContext = { deps: env.pdeps, book };
    const manifest = { hard: task.hardManifest, soft: task.softManifest, rebaseValidators: task.rebaseValidators, configHash: '' };
    promoted = await promote(env.db, book.repo, latest, manifest, result.promote, attached?.meta ?? {}, handler.rebase ? { rebase: (head) => (handler.rebase as NonNullable<TaskHandler['rebase']>)(ctx, latest, head) } : {});

    if (promoted.status === 'stale') {
      await setTaskState(env.db, task.id, 'stale', { waitReason: 'stale', error: promoted.reason ?? 'stale' });
      env.bus.publish({ type: 'task_changed', taskId: task.id, book: bookId, state: 'stale' });
      return;
    }
    if (promoted.status === 'rejected') {
      if (promoted.reason === 'agents_md_edit') {
        await createInboxItem(env.db, env.bus, {
          kind: 'agents_md_edit',
          bookId,
          title: '根 AGENTS.md 被手动修改',
          body: { detail: 'Novelist 管理的根 AGENTS.md 有非 Novelist 提交；请把内容迁移到 instructions/AGENTS.md。', on: { migrate: { task: 'ready' } } },
          actions: [
            { id: 'migrate', label: '一键迁移到 instructions/AGENTS.md' },
            { id: 'dismiss', label: '忽略' },
          ],
          dedupeKey: `agents_md:${bookId}`,
          relatedTaskId: task.id,
        });
        await completeTask(env.db, task.id, { status: 'blocked', errorClass: 'config', message: 'agents_md_edit' }, completeOpts(env));
        env.bus.publish({ type: 'task_changed', taskId: task.id, book: bookId, state: 'blocked' });
        return;
      }
      // rebase validators 失败：结果作废，转 followups（card.repair 等），由后续任务修复
      for (const f of promoted.followups ?? []) await enqueueSpec(env, ctx, { ...f, parentTaskId: task.id });
      await setTaskState(env.db, task.id, 'stale', { waitReason: 'rebase_failed', error: promoted.reason ?? 'rebase failed' });
      env.bus.publish({ type: 'task_changed', taskId: task.id, book: bookId, state: 'stale' });
      return;
    }
  }

  // 依赖崩溃恢复重放：dbEffects 已在 promote 内执行（或 replay 时 applyDbEffects 去重）
  const { promote: _p, ...persisted } = result;
  const state = await completeTask(env.db, task.id, persisted as TaskResult, completeOpts(env));
  env.bus.publish({ type: 'task_changed', taskId: task.id, book: bookId, state });

  if (state === 'failed') {
    await createInboxItem(env.db, env.bus, {
      kind: 'block',
      bookId,
      title: `任务失败：${task.kind}（${task.target}）`,
      body: { taskId: task.id, errorClass: result.errorClass ?? latest.lastErrorClass, message: result.message },
      actions: [
        { id: 'retry', label: '重试' },
        { id: 'dismiss', label: '忽略' },
      ],
      dedupeKey: `failed:${task.id}`,
      relatedTaskId: task.id,
    });
  }

  await drainOutbox(env, task.id);

  if (promoted && (promoted.status === 'committed' || promoted.status === 'rebased') && result.chapter?.state === 'accepted' && bookId) {
    await publishAccepted(env, bookId, result.chapter.no);
  }
}

function completeOpts(env: ExecEnv): { now?: Date; backoffBaseMs?: number } {
  return { now: env.nowFn(), ...(env.backoffBaseMs !== undefined ? { backoffBaseMs: env.backoffBaseMs } : {}) };
}

async function publishAccepted(env: ExecEnv, bookId: string, no: number): Promise<void> {
  const rows = await env.db.select({ slug: books.slug }).from(books).where(eq(books.id, bookId)).limit(1);
  const ch = await env.db.select({ cjk: chapters.cjk }).from(chapters).where(and(eq(chapters.bookId, bookId), eq(chapters.no, no))).limit(1);
  if (rows[0]) env.bus.publish({ type: 'chapter_accepted', book: rows[0].slug, no, cjk: ch[0]?.cjk ?? 0 });
}

/** 按 spec 计算 task id（manifest + stack hash）并入队（幂等） */
export async function enqueueSpec(env: ExecEnv, ctx: PipelineContext, spec: TaskSpec): Promise<{ id: string; created: boolean }> {
  const handler = env.pipe.handlerFor(spec.kind);
  const manifest = await handler.manifest(ctx, spec);
  const stackHash = handler.role ? await computeStackHash(env, ctx.book, spec.role ?? handler.role, spec.kind) : '';
  const id = env.pipe.computeTaskId(spec, manifest, stackHash);
  const full: TaskSpec = { ...spec, lane: spec.lane ?? handler.lane, role: spec.role ?? handler.role, maxAttempts: spec.maxAttempts ?? handler.maxAttempts };
  return enqueue(env.db, { spec: full, id, manifest, baseCommit: ctx.book?.headCommit ?? null });
}

async function computeStackHash(env: ExecEnv, book: BookHandle | null, role: RoleId, kind: TaskKind): Promise<string> {
  try {
    const stack = await resolveStack({
      globalDir: env.paths.instructionsGlobal,
      genreDirs: book ? book.genre.chain.map((g) => ({ id: g.id, dir: g.dir })) : [],
      bookDir: book?.dir ?? null,
      role,
      taskKind: kind,
      ownerNotes: [],
    });
    return compileInstructions(stack, { nonces: 'placeholder' }).stackHash;
  } catch {
    return '';
  }
}

/** outbox 投递（幂等）：followups + onTaskDone → enqueue；inbox；chapter 索引 */
export async function drainOutbox(env: ExecEnv, taskId: string): Promise<boolean> {
  const rows = (await env.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)) as TaskRow[];
  const task = rows[0];
  if (!task || !orchOf(task).outbox) return false;
  const res = (task.result ?? {}) as { status?: string; followups?: TaskSpec[]; inbox?: Parameters<typeof createInboxItem>[2][]; chapter?: TaskResult['chapter']; summary?: Record<string, unknown> };
  const orch = orchOf(task);
  try {
    const book = task.bookId ? await env.pipe.openBook(env.pdeps, task.bookId) : null;
    const ctx: PipelineContext = { deps: env.pdeps, book };
    const followups: TaskSpec[] = [...(res.followups ?? [])];
    if (res.status === 'done') followups.push(...(await env.pipe.onTaskDone(ctx, task, { status: 'done', ...(res.summary ? { summary: res.summary } : {}), ...(res.followups ? { followups: res.followups } : {}), ...(res.chapter ? { chapter: res.chapter } : {}) })));
    for (const f of followups) await enqueueSpec(env, ctx, { ...f, parentTaskId: f.parentTaskId ?? task.id });
    for (const i of res.inbox ?? []) await createInboxItem(env.db, env.bus, { ...i, bookId: i.bookId ?? task.bookId, relatedTaskId: i.relatedTaskId ?? task.id });
    if (task.kind === 'harness.canary' && ['done', 'failed', 'blocked'].includes(task.state)) await finishCanary(env, task, task.state === 'done');
    if (task.kind === 'publish' && res.status === 'done') await publishChapterEvents(env, task);
    await env.db.update(tasks).set({ params: withOrch(task.params, { outbox: undefined }), updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId));
    return true;
  } catch (err) {
    env.log.warn({ err: (err as Error).message, taskId }, 'outbox drain failed');
    const errors = ((orch as unknown as { outboxErrors?: number }).outboxErrors ?? 0) + 1;
    await env.db.update(tasks).set({ params: withOrch(task.params, errors >= 10 ? { outbox: undefined } : ({ outboxErrors: errors } as unknown as Partial<OrchTaskState>)), updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId));
    return false;
  }
}

async function finishCanary(env: ExecEnv, task: TaskRow, ok: boolean): Promise<void> {
  const m = /^(.+)@(.*?):(.+)$/.exec(task.target);
  if (!m) return;
  const [, harness, version, isolation] = m as unknown as [string, string, string, string];
  const writer = await writerHarnesses(env.db);
  const applied = await applyCanaryResult(env.db, { harness, version, isolation, ok, writerHarness: writer.has(harness), now: env.nowFn() });
  env.bus.publish({ type: 'circuit_changed', harness: harness as never, version, state: applied.state, reason: applied.reason });
  if (applied.needsInbox) {
    await createInboxItem(env.db, env.bus, {
      kind: 'circuit',
      bookId: null,
      title: `主笔 harness ${harness}@${version} 建议熔断（30 分钟后生效）`,
      body: { harness, version, isolation, reason: applied.reason, effectiveAt: applied.effectiveAt },
      actions: [
        { id: 'veto', label: '否决（继续运行）', danger: true },
        { id: 'approve', label: '立即熔断' },
      ],
      dedupeKey: `circuit:${harness}:${version}:${isolation}`,
    });
  }
}

async function publishChapterEvents(env: ExecEnv, task: TaskRow): Promise<void> {
  if (!task.bookId) return;
  const rows = await env.db.select({ slug: books.slug, publishedThrough: books.publishedThrough }).from(books).where(eq(books.id, task.bookId)).limit(1);
  const b = rows[0];
  if (b) env.bus.publish({ type: 'chapter_published', book: b.slug, no: b.publishedThrough });
}

/** tick 用：投递所有残留 outbox（崩溃恢复） */
export async function drainAllOutbox(env: ExecEnv): Promise<number> {
  const rows = (await env.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(sql`${tasks.params}->'_orch'->>'outbox' = 'true'`)
    .limit(100)) as { id: string }[];
  let n = 0;
  for (const r of rows) if (await drainOutbox(env, r.id)) n += 1;
  return n;
}

// ───────────────────────── reattach（供 recovery.ts） ─────────────────────────

/** 本进程正在接管的任务（housekeeping 不得回收它们的 lease） */
export const reattachedTaskIds = new Set<string>();

export async function reattach(env: ExecEnv, runRow: typeof runs.$inferSelect): Promise<{ task: TaskRow; finished: Promise<void> } | null> {
  const rows = (await env.db.select().from(tasks).where(eq(tasks.id, runRow.taskId)).limit(1)) as TaskRow[];
  const task = rows[0];
  const session = await loadSession(runRow.runDir);
  if (!task || !session) return null;
  const adapter = getAdapter(runRow.harness as RunSpec['harness']);
  const maxSeqRows = await env.db.select({ m: sql<number>`coalesce(max(${runEvents.seq}), 0)` }).from(runEvents).where(eq(runEvents.runId, runRow.id));
  const fromSeq = Number(maxSeqRows[0]?.m ?? 0);
  const log = new EventLog(env, runRow.id, runRow.accountId, () => undefined);
  const handle = await reattachRun(runRow.runDir, adapter, session.spec, log, fromSeq).catch(() => null);
  if (!handle) return null;
  if (!ACTIVE_STATES.includes(task.state as (typeof ACTIVE_STATES)[number])) {
    // 任务已被取消/完成：不复活，直接终止 harness，run 按 lost 收尾
    await handle.kill('user').catch(() => {});
    await log.close().catch(() => {});
    return null;
  }
  await env.db.update(tasks).set({ state: 'running', leaseOwner: env.owner, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(), updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id));
  await env.db.update(runs).set({ state: 'running', leaseOwner: env.owner, heartbeatAt: new Date().toISOString() }).where(eq(runs.id, runRow.id));
  reattachedTaskIds.add(task.id);
  // 全程续租：run 结束后的收割、finalize、等仓库锁都可能超过一个 lease
  const renew = setInterval(() => {
    void renewLease(env.db, task.id, env.owner, LEASE_MS).catch(() => {});
  }, LEASE_MS / 3);
  renew.unref();
  const finished = (async () => {
    const book = task.bookId ? await env.pipe.openBook(env.pdeps, task.bookId) : null;
    const ctx: PipelineContext = { deps: env.pdeps, book };
    const handler = env.pipe.handlerFor(task.kind as TaskKind);
    const activeLink = path.join(env.paths.runsActive, runRow.id);
    const snapshot = book ? { dir: session.spec.bookDir, baseCommit: session.runCtx.baseCommit, bookDir: book.dir } : null;
    const result = await finishRun(env, ctx, handler, task, {
      handle,
      log,
      session,
      activeLink,
      snapshot,
      route: { profile: runRow.profileId, account: runRow.accountId, harness: runRow.harness, model: runRow.model },
      resolved: null,
      signal: new AbortController().signal,
      adapter,
      tier: normalizeTierOrNull(task.tier),
    });
    await finishTask(env, task, result);
  })()
    .catch((err) => {
      env.log.warn({ err: (err as Error).message, runId: runRow.id }, 'reattached run failed');
    })
    .finally(() => {
      clearInterval(renew);
      reattachedTaskIds.delete(task.id);
    });
  return { task, finished };
}

/** 标记 run lost：任务回 ready，attempt 不加 */
export async function markRunLost(env: ExecEnv, runRow: typeof runs.$inferSelect): Promise<void> {
  const now = new Date().toISOString();
  await env.db.update(runs).set({ state: 'lost', endedAt: now }).where(eq(runs.id, runRow.id));
  const session = await loadSession(runRow.runDir);
  if (session) {
    await releaseReservations(env.db, session.reservationIds);
    if (session.spec.bookDir) {
      const rows = await env.db.select({ dir: books.slug }).from(books).where(eq(books.id, runRow.bookId ?? '')).limit(1);
      if (rows[0]) await removeRunSnapshot({ dir: session.spec.bookDir, baseCommit: session.runCtx.baseCommit, bookDir: path.join(env.paths.books, rows[0].dir) }).catch(() => {});
    }
  }
  await fs.rm(path.join(env.paths.runsActive, runRow.id), { force: true });
  await env.db
    .update(tasks)
    .set({ state: 'ready', leaseOwner: null, leaseExpiresAt: null, waitReason: 'run lost', updatedAt: now })
    .where(and(eq(tasks.id, runRow.taskId), inArray(tasks.state, ['leased', 'running'])));
  env.bus.publish({ type: 'run_exit', runId: runRow.id, state: 'lost', errorClass: null });
}

