/**
 * v3 书的读模型（首页一行、书页）与书页设置（p2-plan §2.7、§3.4）。
 * 列表按批查询：活着的 flow 任务、每个任务最近的 run、每本书的 run 汇总、账号的睡眠 / 登录状态，各一次。
 */
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { BookConfig, V3BookSummary, V3BookView, V3Cost, V3RunCostRow, V3Settings, V3StoryFile } from '@novelist/shared';
import { zPublishConfig } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { bookFiles, isV3Meta, openRepo } from '../book/index.js';
import type { Db } from '../db/client.js';
import { accountsState, books, profiles, runs, tasks } from '../db/schema.js';
import { HttpProblem } from '../api/problem.js';
import { NOTE_BUDGETS, noteSize } from '../flow/contract.js';
import { RETRO_EVERY, plannedUpper } from '../flow/decide.js';
import { loadSystemSettings } from '../orchestrator/routing.js';
import { selectHints } from '../flow/order.js';
import { patchV3Meta, readV3Meta } from '../flow/state.js';
import { v3Status, type V3StatusInput } from '../flow/status.js';
import type { V3BookMeta, V3OwnerMessageMeta } from '../flow/types.js';
import { ensureBatchLog, rewindFloor, rewindPoints } from '../orchestrator/rewind-v3.js';
import { nextSlots } from '../orchestrator/publisher.js';
import { bookDir, type BookRow } from '../api/helpers.js';
import { assertPublishConfig } from './publish-config.js';
import { listDrafts } from './v3-book.js';

const V3_KINDS = ['book.open', 'book.write', 'book.retro'];
/** 活着的任务，加上被拦下的（blocked：路由被拦、根 AGENTS.md 被手改，要主人处理；状态句要看到它） */
const SHOWN = ['pending', 'ready', 'waiting', 'leased', 'running', 'finalizing', 'blocked'];
/** 同一本书有多个任务时，先看在跑的；blocked 排最后（有活着的任务时以活着的为准） */
const LIVE_RANK: Record<string, number> = { finalizing: 0, running: 1, leased: 2, waiting: 3, ready: 4, pending: 5, blocked: 6 };
const DEFAULT_TZ = 'Asia/Shanghai';

/** v3 书 = meta.v3 是 JSON 对象（book/legacy.ts 的唯一判定，P3 D1） */
export const isV3Row = (row: Pick<BookRow, 'meta'>): boolean => isV3Meta(row.meta);

export function costOf(agg: { runs: number; ms: number; output: number }, totalCjk: number): V3Cost {
  return {
    runs: agg.runs,
    hours: Math.round((agg.ms / 3_600_000) * 100) / 100,
    outputTokens: agg.output,
    tokensPer1kChars: totalCjk > 0 && agg.output > 0 ? Math.round(agg.output / (totalCjk / 1000)) : null,
  };
}

async function readConfig(deps: Pick<AppDeps, 'paths'>, slug: string): Promise<BookConfig | null> {
  return bookFiles(openRepo(bookDir(deps, slug)))
    .config()
    .then((c) => c.config)
    .catch(() => null);
}

function nextReleaseOf(cfg: BookConfig | null, now: Date): string | null {
  if (!cfg || cfg.publish.mode === 'manual') return null;
  try {
    return nextSlots(cfg.publish, now, 1)[0] ?? null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

/** 列表用：每本 v3 书一份摘要（状态句 + 花费）。旧流程书不在结果里 */
export async function v3Summaries(deps: Pick<AppDeps, 'db' | 'paths'>, rowsIn: BookRow[], now: Date): Promise<Map<string, V3BookSummary>> {
  const out = new Map<string, V3BookSummary>();
  const rows = rowsIn.filter(isV3Row);
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const db = deps.db;
  const [liveTasks, aggs, lastRuns, configs] = await Promise.all([
    // (1) 活着的（和被拦下的）flow 任务
    db
      .select({ id: tasks.id, bookId: tasks.bookId, kind: tasks.kind, state: tasks.state, notBefore: tasks.notBefore, lastErrorClass: tasks.lastErrorClass, waitReason: tasks.waitReason, params: tasks.params, updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(and(inArray(tasks.bookId, ids), inArray(tasks.kind, V3_KINDS), inArray(tasks.state, SHOWN))),
    // (3) 每本书的 run 汇总（只算启动过 harness 的：prepare 就跳过的任务也留一行 run，见 runCostRows）
    db
      .select({
        bookId: runs.bookId,
        runs: sql<number>`count(*) filter (where ${runs.endedAt} is not null and ${runs.startedAt} is not null)`,
        ms: sql<number>`coalesce(sum(extract(epoch from (${runs.endedAt}::timestamptz - ${runs.startedAt}::timestamptz)) * 1000) filter (where ${runs.endedAt} is not null and ${runs.startedAt} is not null), 0)`,
        output: sql<number>`coalesce(sum(coalesce((${runs.usage}->>'output')::bigint, 0)), 0)`,
      })
      .from(runs)
      .where(inArray(runs.bookId, ids))
      .groupBy(runs.bookId),
    // (4 的前一半) 每本书最近一次 run 的账号
    db
      .selectDistinctOn([runs.bookId], { bookId: runs.bookId, accountId: runs.accountId })
      .from(runs)
      .where(inArray(runs.bookId, ids))
      .orderBy(runs.bookId, desc(runs.createdAt)),
    Promise.all(rows.map(async (r) => [r.id, await readConfig(deps, r.slug)] as const)),
  ]);
  const taskOf = new Map<string, (typeof liveTasks)[number]>();
  for (const t of [...liveTasks].sort((a, b) => (LIVE_RANK[a.state] ?? 9) - (LIVE_RANK[b.state] ?? 9) || b.updatedAt.localeCompare(a.updatedAt))) {
    if (t.bookId && !taskOf.has(t.bookId)) taskOf.set(t.bookId, t);
  }
  const taskIds = [...taskOf.values()].map((t) => t.id);
  const accountIds = [...new Set(lastRuns.map((r) => r.accountId).filter((a): a is string => !!a))];
  const [taskRuns, accts] = await Promise.all([
    // (2) 每个 flow 任务最近的 run
    taskIds.length
      ? db.selectDistinctOn([runs.taskId], { taskId: runs.taskId, state: runs.state, startedAt: runs.startedAt }).from(runs).where(inArray(runs.taskId, taskIds)).orderBy(runs.taskId, desc(runs.createdAt))
      : Promise.resolve([] as { taskId: string; state: string; startedAt: string | null }[]),
    // (4) 账号的睡眠 / 登录状态
    accountIds.length ? db.select().from(accountsState).where(inArray(accountsState.accountId, accountIds)) : Promise.resolve([] as (typeof accountsState.$inferSelect)[]),
  ]);
  const runOfTask = new Map(taskRuns.map((r) => [r.taskId, r]));
  const aggOf = new Map(aggs.map((a) => [a.bookId, a]));
  const accountOf = new Map(lastRuns.map((r) => [r.bookId, r.accountId]));
  const acctOf = new Map(accts.map((a) => [a.accountId, a]));
  const cfgOf = new Map(configs);

  for (const row of rows) {
    const cfg = cfgOf.get(row.id) ?? null;
    const meta = readV3Meta(row.meta);
    const t = taskOf.get(row.id) ?? null;
    const run = t ? runOfTask.get(t.id) ?? null : null;
    const acctId = accountOf.get(row.id) ?? null;
    const st = acctId ? acctOf.get(acctId) : undefined;
    const sleeping = st?.sleepUntil && Date.parse(st.sleepUntil) > now.getTime() ? { until: st.sleepUntil, reason: st.sleepReason } : null;
    const authBad = (st?.lastAuthCheck as { ok?: unknown } | null | undefined)?.ok === false;
    const target = cfg?.v3.target_cjk ?? 0;
    const input: V3StatusInput = {
      book: { status: row.status, pausedReason: row.pausedReason, accepted: row.acceptedThrough, published: row.publishedThrough, totalCjk: row.totalCjk, targetCjk: target },
      meta,
      publishMode: cfg?.publish.mode ?? 'scheduled',
      maxBuffer: cfg?.publish.max_buffer ?? Number.POSITIVE_INFINITY,
      flowTask: t ? { kind: t.kind, state: t.state, notBefore: t.notBefore, lastErrorClass: t.lastErrorClass, waitReason: t.waitReason, params: t.params ?? {} } : null,
      run: run ? { state: run.state, startedAt: run.startedAt } : null,
      accountSleep: sleeping,
      authBad,
      nextRelease: nextReleaseOf(cfg, now),
      now,
      tz: cfg?.publish.timezone || DEFAULT_TZ,
    };
    const agg = aggOf.get(row.id);
    out.set(row.id, {
      length: cfg?.v3.length ?? 'medium',
      targetCjk: target,
      plannedChapters: cfg?.v3.planned_chapters ?? Math.max(1, Math.ceil(target / 4000)),
      status: v3Status(input),
      cost: costOf({ runs: num(agg?.runs), ms: num(agg?.ms), output: num(agg?.output) }, row.totalCjk),
    });
  }
  return out;
}

/**
 * 书页“花费”：每次运行一行（新的在前）。只列真的启动过 harness 的（started_at 非空）：
 * prepare 就跳过的任务（过时、存稿满了、回退中）也会留一行 run，但没有花费，不算一次运行。
 */
export async function runCostRows(db: Db, bookId: string, limit = 200): Promise<V3RunCostRow[]> {
  const rows = await db
    .select({ run: runs, params: tasks.params })
    .from(runs)
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(runs.bookId, bookId), isNotNull(runs.startedAt)))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows.map(({ run: r, params }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const mode = typeof p.mode === 'string' ? p.mode : null;
    const from = typeof p.from === 'number' ? p.from : r.taskKind === 'book.open' ? 1 : null;
    let chapters: [number, number] | null = null;
    if (r.taskKind === 'book.retro' && typeof p.from === 'number' && typeof p.to === 'number') chapters = [p.from, p.to];
    else if (from !== null && typeof p.count === 'number') chapters = [from, from + Math.max(1, p.count) - 1];
    const usage = (r.usage ?? {}) as { input?: number; output?: number; cachedInput?: number };
    return {
      runId: r.id,
      taskKind: r.taskKind as V3RunCostRow['taskKind'],
      mode,
      chapters,
      startedAt: r.startedAt,
      minutes: r.startedAt && r.endedAt ? Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 6000) / 10 : null,
      outputTokens: usage.output ?? 0,
      inputTokens: usage.input ?? 0,
      cachedTokens: usage.cachedInput ?? 0,
      model: r.modelReported ?? r.model,
      state: r.state as V3RunCostRow['state'],
      errorClass: r.errorClass as V3RunCostRow['errorClass'],
      toolSteps: typeof r.outcome?.toolSteps === 'number' ? r.outcome.toolSteps : null,
    };
  });
}

/** 上次复盘以来写完的批数（主人采用草稿记的 adopt 不算；与 flow/handlers.ts nextTasksV3 同口径） */
const retroBatchesSince = (meta: V3BookMeta): number => meta.batchLog.slice(meta.retro.afterBatches).filter((e) => e.kind !== 'adopt').length;

const messageView = (m: V3OwnerMessageMeta) => ({
  text: m.text,
  setAt: m.setAt,
  readIn: m.readIn ? { kind: m.readIn.kind, from: m.readIn.from, to: m.readIn.to, at: m.readIn.at } : null,
  archivedPath: m.archivedPath,
});

function settingsOf(cfg: BookConfig): V3Settings {
  return {
    target_cjk: cfg.v3.target_cjk,
    min_chapter_cjk: cfg.v3.min_chapter_cjk,
    batch: cfg.v3.batch,
    effort: { open: cfg.v3.effort.open, write: cfg.v3.effort.write, closing: cfg.v3.effort.closing ?? cfg.v3.effort.finale, finale: cfg.v3.effort.finale, retro: cfg.v3.effort.retro },
    publish: { mode: cfg.publish.mode, cadence: cfg.publish.cadence, timezone: cfg.publish.timezone, per_slot: cfg.publish.per_slot, max_buffer: cfg.publish.max_buffer },
    writer_profile: cfg.routing.writer_profile ?? null,
    budgets: { priority: cfg.budgets.priority, monthly_usd_cap: cfg.budgets.monthly_usd_cap ?? null, max_window_util_pct: cfg.budgets.max_window_util_pct ?? null },
  };
}

/** 故事资料：bible.md、outline.md 和 notes/ 下（不含 archive/）的每个 .md，带体积和预算 */
async function storyFiles(repo: ReturnType<typeof openRepo>, head: string): Promise<V3StoryFile[]> {
  const notes = (await repo.list('notes', { rev: head }).catch(() => [] as string[])).filter((p) => p.endsWith('.md') && !p.includes('/archive/') && !p.endsWith('/'));
  const paths = ['bible.md', 'outline.md', ...notes.sort()];
  const texts = repo.readMany ? await repo.readMany(paths, head) : await Promise.all(paths.map((p) => repo.readFile(p, head)));
  const out: V3StoryFile[] = [];
  paths.forEach((p, i) => {
    const text = texts[i];
    if (text === null || text === undefined) return;
    const size = noteSize(text);
    const budget = NOTE_BUDGETS[p] ?? null;
    out.push({ path: p, size, budget, over: budget !== null && size > budget });
  });
  return out;
}

export async function v3BookView(deps: AppDeps, rowIn: BookRow): Promise<V3BookView> {
  const repo = openRepo(bookDir(deps, rowIn.slug));
  let row = rowIn;
  // phase 1 写的书没有 batchLog：第一次打开书页时按提交 trailer 回填一次（回退点、复盘用）
  if (row.acceptedThrough > 0 && readV3Meta(row.meta).batchLog.length === 0) {
    await ensureBatchLog(deps.db, repo, row.id);
    row = (await deps.db.select().from(books).where(eq(books.id, row.id)).limit(1))[0] ?? row;
  }
  const now = new Date();
  const [summaries, cfgDoc, drafts, runRows, head] = await Promise.all([
    v3Summaries(deps, [row], now),
    bookFiles(repo).config(),
    listDrafts(deps, row),
    runCostRows(deps.db, row.id),
    repo.head(),
  ]);
  const cfg = cfgDoc.config;
  const summary = summaries.get(row.id);
  const meta: V3BookMeta = readV3Meta(row.meta);
  const story = head ? await storyFiles(repo, head) : [];
  const flowTask = (await deps.db.select({ state: tasks.state }).from(tasks).where(and(eq(tasks.bookId, row.id), inArray(tasks.kind, V3_KINDS), eq(tasks.state, 'blocked'))).limit(1))[0];
  const frozen = { publishedThrough: row.publishedThrough, locked: meta.locked };
  return {
    slug: row.slug,
    length: cfg.v3.length,
    planned: cfg.v3.planned_chapters ?? Math.max(1, Math.ceil(cfg.v3.target_cjk / 4000)),
    accepted: row.acceptedThrough,
    published: row.publishedThrough,
    totalCjk: row.totalCjk,
    status: summary?.status ?? { kind: 'idle', sentence: '等待排班', since: null, until: null, notes: [] },
    settings: settingsOf(cfg),
    ownerMessage: meta.ownerMessage ? messageView(meta.ownerMessage) : null,
    ownerHistory: meta.ownerMessages.map(messageView),
    ownerRequests: meta.ownerRequests.map((r) => ({ id: r.id, chapter: r.chapter, note: r.note, at: r.at, status: r.status })),
    batches: [...meta.batchLog]
      .reverse()
      .slice(0, 100)
      .map((e) => ({ kind: e.kind, from: e.from, to: e.to, at: e.at, runId: e.runId })),
    drafts,
    story,
    runs: runRows,
    cost: summary?.cost ?? costOf({ runs: 0, ms: 0, output: 0 }, row.totalCjk),
    retro: { enabled: cfg.v3.length === 'long' || cfg.v3.length === 'epic', batchesSince: retroBatchesSince(meta), every: RETRO_EVERY, lastAt: meta.retro.lastAt },
    hints: selectHints(meta.hints, frozen).hintsShown.map((h) => ({ kind: h.kind, text: h.text })),
    pending: meta.pending ? { failures: meta.pending.failures, lastError: meta.pending.lastError ?? null, blocked: meta.pending.failures >= 3 || flowTask !== undefined } : null,
    rewindPoints: rewindPoints(meta, row.publishedThrough, row.acceptedThrough, rewindFloor(meta)),
    locked: [...meta.locked].sort((a, b) => a - b),
    agentsSize: meta.agentsSize,
  };
}

/**
 * 书页设置（写回 book.yaml）。改了目标字数：N0' = ⌈目标 / 4000⌉，失控计数清零（基准跟着目标走，抬高目标不会提前强制收尾）。
 * 抬高目标：计划章数至少到 N0'，plannedFloor 也抬到 N0'（否则下一次收稿按 outline.md 里旧的“计划：共 N 章”又夹回去，
 * 结局控制立刻进收尾），六成保护重新给一次（shortEndUsed 清掉）。降低目标：计划章数夹到 [⌈N0'/2⌉, 上限]，plannedFloor 降到不超过 N0'。
 * 上限与开书任务单、收稿夹取同一个（decide.ts plannedUpper）。
 */
export async function saveV3Settings(deps: AppDeps, row: BookRow, s: V3Settings): Promise<void> {
  // services/books.ts 依赖本文件（summarize），这里动态引入避免循环
  const { patchBookYaml } = await import('./books.js');
  const { syncBookIndex } = await import('./repo-files.js');
  const repo = openRepo(bookDir(deps, row.slug));
  const cfg = (await bookFiles(repo).config()).config;
  // 写作模型覆盖：只认已有的 profile（没改的旧值照收，profile 后来被删了也不挡别的设置）
  if (s.writer_profile !== null && s.writer_profile !== (cfg.routing.writer_profile ?? null)) {
    const found = await deps.db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, s.writer_profile)).limit(1);
    if (!found[0]) throw new HttpProblem(400, 'unknown_profile', `没有这个 profile：${s.writer_profile}`);
  }
  const resume = Math.max(1, s.publish.max_buffer - 5);
  const nextPublish = zPublishConfig.parse({ ...cfg.publish, ...s.publish, resume_buffer: resume });
  assertPublishConfig(nextPublish, { batch: s.batch });
  const meta = readV3Meta(row.meta);
  const targetChanged = s.target_cjk !== cfg.v3.target_cjk;
  const raised = s.target_cjk > cfg.v3.target_cjk;
  const n0 = Math.max(1, Math.ceil(s.target_cjk / 4000));
  const planned = cfg.v3.planned_chapters ?? Math.max(1, Math.ceil(cfg.v3.target_cjk / 4000));
  const floorNext = raised ? Math.max(meta.plannedFloor ?? 0, n0) : meta.plannedFloor !== null && meta.plannedFloor > n0 ? n0 : meta.plannedFloor;
  const factor = (await loadSystemSettings(deps.db)).v3.runawayFactor;
  const plannedNext = Math.min(Math.max(planned, raised ? n0 : Math.ceil(n0 / 2)), plannedUpper(n0, floorNext, factor, s.batch));
  await patchBookYaml(
    deps,
    row,
    repo,
    (doc) => {
      doc.setIn(['v3', 'target_cjk'], s.target_cjk);
      doc.setIn(['v3', 'min_chapter_cjk'], s.min_chapter_cjk);
      doc.setIn(['v3', 'batch'], s.batch);
      for (const k of ['open', 'write', 'finale', 'retro'] as const) doc.setIn(['v3', 'effort', k], s.effort[k]);
      // closing 没写过、又和 finale 一样：不写（这本书照旧用 finale，P3 之前的书不多出一个键）
      if (cfg.v3.effort.closing !== undefined || s.effort.closing !== s.effort.finale) doc.setIn(['v3', 'effort', 'closing'], s.effort.closing);
      // null = 删掉这个键（没有这个键时什么也不写）
      const unset = (p: string[]) => {
        if (doc.hasIn(p)) doc.deleteIn(p);
      };
      if (s.writer_profile === null) unset(['routing', 'writer_profile']);
      else doc.setIn(['routing', 'writer_profile'], s.writer_profile);
      if (doc.hasIn(['budgets', 'priority']) || s.budgets.priority !== cfg.budgets.priority) doc.setIn(['budgets', 'priority'], s.budgets.priority);
      for (const k of ['monthly_usd_cap', 'max_window_util_pct'] as const) {
        const v = s.budgets[k];
        if (v === null) unset(['budgets', k]);
        else doc.setIn(['budgets', k], v);
      }
      if (targetChanged) {
        doc.setIn(['v3', 'planned_chapters_initial'], n0);
        doc.setIn(['v3', 'planned_chapters'], plannedNext);
      }
      for (const k of ['mode', 'cadence', 'timezone', 'per_slot', 'max_buffer'] as const) doc.setIn(['publish', k], s.publish[k]);
      doc.setIn(['publish', 'resume_buffer'], resume);
    },
    'owner: edit v3 settings',
  );
  if (targetChanged) await patchV3Meta(deps.db, row.id, () => ({ patch: { runawayBatches: 0, plannedFloor: floorNext, ...(raised ? { shortEndUsed: false } : {}) }, result: undefined }));
  const fresh = await bookFiles(repo).config();
  await syncBookIndex(deps, row.id, fresh.config);
}
