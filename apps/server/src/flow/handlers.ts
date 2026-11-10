/**
 * v3 的三个任务：book.open / book.write / book.retro（docs/v3/DESIGN.md §2、§3；p1-plan §2.13，p2-plan §3.1）。
 * 一次任务 = 一次 harness 运行：prepare 写 ORDER.md 与根 AGENTS.md，finalize 把收到的稿归位、检查、做成逐章提交计划。
 * 运行结果（done / waiting、退避、空跑记账）由执行器用 classifyV3Run 判定；pending 收稿的生命周期也在执行器里。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { ErrorClass } from '@novelist/shared';
import { V3_LAUNCH_PROMPT, V3_TITLE_PLACEHOLDER, chapterId } from '@novelist/shared';
import { books, runs, tasks } from '../db/schema.js';
import { readRunChanges } from '../book/harvest.js';
import { V3_CLAUDE_MD, renderAgentsMdV3 } from '../instructions/v3.js';
import { buildManifest, requireBook } from '../runtime/manifest.js';
import type { BookHandle, HarvestedRun, InboxInput, PipelineContext, PrepareResult, RunContext, TaskHandler, TaskResult, TaskRow, TaskSpec } from '../runtime/types.js';
import { loadSystemSettings } from '../orchestrator/routing.js';
import { normaliseChapter } from './checks.js';
import { buildPromote } from './commit.js';
import { V3_STEP_LIMIT } from './contract.js';
import { RETRO_EVERY, decideNext, plannedUpper, runawayBaseOf, type FlowState } from './decide.js';
import { repeatedPhrases } from './feedback.js';
import { chapterNoFromPath, planHarvest, splitChapters, type MapInput } from './map.js';
import { buildOrderSpec, renderOrder, waitingOwnerRequests } from './order.js';
import { markRetro, readV3Meta, setSched } from './state.js';
import { slotsPerDay } from '../orchestrator/publisher.js';
import { dropPublishedRequests } from './owner.js';
import { v3PublishCap } from './publish.js';
import type { OrderMode, OrderSpec, V3BatchEffectArgs, V3BatchNote, V3CommitPlan } from './types.js';

/** v3 任务种类 */
export const V3_KINDS = ['book.open', 'book.write', 'book.retro'] as const;
export const isV3Kind = (kind: string): boolean => (V3_KINDS as readonly string[]).includes(kind);

/** 与 orchestrator/queue.ts LIVE_STATES 相同（flow 不依赖队列模块） */
const LIVE = ['pending', 'ready', 'waiting', 'leased', 'running', 'finalizing'];
const CANCEL_GAP_MS = 10 * 60_000;
const ORDER_FILE = 'order.json';

async function v3Manifest(ctx: PipelineContext, spec: TaskSpec) {
  return buildManifest(ctx, spec, { extra: { flow: 'v3', from: spec.params?.from ?? null, mode: spec.params?.mode ?? null } });
}

const n0Of = (book: BookHandle): number => {
  const cfg = book.config.v3;
  return cfg.planned_chapters_initial ?? cfg.planned_chapters ?? Math.max(1, Math.ceil(cfg.target_cjk / 4000));
};

/** 测试钩子：只在 allowFakeHarness 下读 $RUN/in/fake.json 的 v3 键 */
export async function fakeV3(ctx: PipelineContext, inDir: string): Promise<Record<string, unknown> | null> {
  if (!ctx.deps.config.allowFakeHarness) return null;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(inDir, 'fake.json'), 'utf8')) as unknown;
    const one = (Array.isArray(raw) ? raw[0] : raw) as { v3?: Record<string, unknown> } | undefined;
    return one?.v3 ?? null;
  } catch {
    return null;
  }
}

/**
 * 测试钩子 serverFault：命中时返回 true（并记下次数）。默认只触发一次；`serverFaultTimes: n` 触发 n 次（e2e 的“提交连续失败”）。
 * 计数文件放在 inDir（fault.<name>.done），同一次 run 的重复消化共用。
 */
export async function serverFault(ctx: PipelineContext, inDir: string, name: 'finalize' | 'promote' | 'crashAfterHarvest'): Promise<boolean> {
  const v3 = await fakeV3(ctx, inDir);
  if (!v3 || v3.serverFault !== name) return false;
  const times = typeof v3.serverFaultTimes === 'number' && v3.serverFaultTimes > 0 ? v3.serverFaultTimes : 1;
  const marker = path.join(inDir, `fault.${name}.done`);
  const done = Number((await fs.readFile(marker, 'utf8').catch(() => '0')).trim()) || 0;
  if (done >= times) return false;
  await fs.writeFile(marker, String(done + 1));
  return true;
}

// ───────────────────────── prepare ─────────────────────────

async function popFakeScenario(ctx: PipelineContext, book: BookHandle, run: RunContext): Promise<void> {
  if (!ctx.deps.config.allowFakeHarness || run.harness !== 'fake') return;
  const file = path.join(ctx.deps.paths.tmp, 'fake-v3', `${book.slug}.json`);
  let queue: unknown;
  try {
    queue = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(queue) || queue.length === 0) return;
  const [head, ...rest] = queue;
  await fs.writeFile(path.join(run.inDir, 'fake.json'), JSON.stringify(head));
  await fs.writeFile(file, JSON.stringify(rest));
}

export async function prepareV3(ctx: PipelineContext, task: TaskRow, run: RunContext): Promise<PrepareResult> {
  const book = requireBook(ctx);
  // 1. 跳过规则（stale / 存稿满）
  const built = await buildOrderSpec(ctx, book, task);
  if ('skip' in built) return { kind: 'skip', result: built.skip };
  const { spec, extra } = built;

  // 2. 根 AGENTS.md（从不截断；超过软上限的告警与各 harness 的硬上限由执行器处理）
  const agents = await renderAgentsMdV3({
    globalDir: ctx.deps.paths.instructionsGlobal,
    genreDirs: book.genre.chain.map((g) => ({ id: g.id, dir: g.dir, name: g.pack.name ?? g.id })),
    bookDir: run.snapshotDir,
    length: book.config.v3.length,
  });

  // 3. ORDER.md + order.json（finalize 读回）
  const orderMd = await renderOrder(spec, extra);
  await fs.mkdir(run.inDir, { recursive: true });
  await fs.writeFile(path.join(run.inDir, ORDER_FILE), `${JSON.stringify(spec, null, 2)}\n`);

  // 4. 测试钩子：fake 场景队列
  await popFakeScenario(ctx, book, run);

  // 5. 运行预算随批量放大；结局批“章数不限”，至少给一个普通批的预算
  const settings = await loadSystemSettings(ctx.deps.db);
  // 复盘按要读的章数折成“批”（每 5 章算一批）
  const n = spec.mode === 'retro' && spec.retro ? Math.min(Math.max(1, Math.ceil((spec.retro.to - spec.retro.from + 1) / 5)), 12) : Math.min(spec.finale ? Math.max(spec.count, spec.batch) : spec.count, 12);
  const wallMs = Math.max(settings.wallTimeoutMs, Math.min((15 + 6 * n) * 60_000, 3 * 3600_000));
  return {
    kind: 'run',
    plan: {
      v3: { agentsMd: agents.text, agentsBytes: agents.bytes, claudeMd: V3_CLAUDE_MD, orderMd, launchPrompt: V3_LAUNCH_PROMPT, stackHash: agents.stackHash, layers: agents.layers },
      effort: spec.effort,
      limits: { maxTurns: 30 + 12 * n, wallMs },
    },
  };
}

// ───────────────────────── finalize ─────────────────────────

/** order.json 丢了（run 目录被清理）：按任务参数和当前 DB 重建一份，不走跳过规则 */
async function fallbackOrder(ctx: PipelineContext, book: BookHandle, task: TaskRow): Promise<OrderSpec> {
  const built = await buildOrderSpec(ctx, book, task);
  if (!('skip' in built)) return built.spec;
  const row = (await ctx.deps.db.select().from(books).where(eq(books.id, book.id)).limit(1))[0];
  const cfg = book.config.v3;
  const params = (task.params ?? {}) as Record<string, unknown>;
  const kind = task.kind as OrderSpec['kind'];
  const accepted = row?.acceptedThrough ?? 0;
  const mode = (kind === 'book.retro' ? 'retro' : typeof params.mode === 'string' ? params.mode : kind === 'book.open' ? (cfg.length === 'short' ? 'open-short' : 'open-long') : 'write') as OrderMode;
  const n0 = n0Of(book);
  const plannedMax = plannedUpper(n0, readV3Meta(row?.meta).plannedFloor, (await loadSystemSettings(ctx.deps.db)).v3.runawayFactor, cfg.batch);
  if (kind === 'book.retro') {
    const to = typeof params.to === 'number' ? params.to : accepted;
    return {
      v: 1,
      mode,
      kind,
      from: accepted + 1,
      count: 0,
      finale: false,
      minChars: cfg.min_chapter_cjk,
      targetCjk: cfg.target_cjk,
      planned: cfg.planned_chapters ?? n0,
      plannedMax,
      batch: cfg.batch,
      accepted,
      totalCjk: row?.totalCjk ?? 0,
      publishedThrough: row?.publishedThrough ?? 0,
      locked: readV3Meta(row?.meta).locked,
      allowRewrite: [],
      bibleExisted: true,
      hintsShown: [],
      effort: cfg.effort.retro,
      retro: { from: typeof params.from === 'number' ? params.from : 1, to },
    };
  }
  const from = kind === 'book.open' ? 1 : typeof params.from === 'number' ? params.from : accepted + 1;
  return {
    v: 1,
    mode,
    kind,
    from,
    count: typeof params.count === 'number' ? params.count : cfg.batch,
    finale: mode === 'finale' || mode === 'open-short',
    minChars: cfg.min_chapter_cjk,
    targetCjk: cfg.target_cjk,
    planned: cfg.planned_chapters ?? n0,
    plannedMax,
    batch: cfg.batch,
    accepted: Math.min(accepted, from - 1),
    totalCjk: row?.totalCjk ?? 0,
    publishedThrough: row?.publishedThrough ?? 0,
    locked: readV3Meta(row?.meta).locked,
    allowRewrite: [],
    bibleExisted: true,
    hintsShown: [],
    effort: cfg.effort.write,
  };
}

async function readOrder(ctx: PipelineContext, book: BookHandle, task: TaskRow, h: HarvestedRun): Promise<OrderSpec> {
  try {
    const spec = JSON.parse(await fs.readFile(path.join(h.run.inDir, ORDER_FILE), 'utf8')) as OrderSpec;
    if (spec.v === 1) return spec;
  } catch {
    // 退回重建
  }
  return fallbackOrder(ctx, book, task);
}

async function readAt(book: BookHandle, rels: string[], rev: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rels.length === 0 || !rev) return out;
  const texts = book.repo.readMany ? await book.repo.readMany(rels, rev) : await Promise.all(rels.map((r) => book.repo.readFile(r, rev)));
  rels.forEach((r, i) => {
    const t = texts[i];
    if (t !== null && t !== undefined) out.set(r, t);
  });
  return out;
}

export async function finalizeV3(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult> {
  const book = requireBook(ctx);
  if (await serverFault(ctx, h.run.inDir, 'finalize')) throw new Error('serverFault: finalize');
  const db = ctx.deps.db;
  const v3h = h.v3 ?? { manifestFile: null, lost: false, stderrTail: '', trailerKey: `${task.id}@${h.run.runId}`, ownerCancelled: false };

  // 1. 任务单
  const order = await readOrder(ctx, book, task, h);
  const base = h.run.baseCommit;

  // 2. 改动 + base 上的原文；冻结信息、书名、简介运行期间可能变了，按现在的 DB 读
  const loaded = v3h.manifestFile ? await readRunChanges(v3h.manifestFile) : null;
  const changed = loaded?.changes.files ?? [];
  const texts = await Promise.all(changed.map((f) => (loaded as NonNullable<typeof loaded>).read(f.path)));
  const baseTexts = await readAt(
    book,
    changed.filter((f) => !f.isNew).map((f) => f.path),
    base,
  );
  const files: MapInput['files'] = changed.map((f, i) => ({ path: f.path, text: texts[i] ?? '', isNew: f.isNew, ignored: f.ignored, baseText: f.isNew ? null : (baseTexts.get(f.path) ?? null) }));

  // 旧章正文：最近 30 章 + 允许改写的 + 改动文件里出现的旧章号
  const wanted = new Set<number>();
  for (let k = Math.max(1, order.accepted - 29); k <= order.accepted; k += 1) wanted.add(k);
  for (const k of order.allowRewrite) wanted.add(k);
  for (const f of files) {
    const byPath = chapterNoFromPath(f.path);
    if (byPath !== null) wanted.add(byPath);
    for (const s of splitChapters(f.text)) if (s.headingNo !== null) wanted.add(s.headingNo);
  }
  const nos = [...wanted].filter((k) => k >= 1 && k <= order.accepted).sort((a, b) => a - b);
  const chapterTexts = await readAt(
    book,
    nos.map((k) => `manuscript/${chapterId(k)}.md`),
    base,
  );
  const baseChapters = new Map<number, string>();
  for (const k of nos) {
    const t = chapterTexts.get(`manuscript/${chapterId(k)}.md`);
    if (t !== undefined) baseChapters.set(k, normaliseChapter(k, t).body);
  }
  const heads = await readAt(book, ['bible.md', 'outline.md', 'notes/progress.md', 'notes/cast.md'], base);
  const draftList = base ? await book.repo.list('drafts', { rev: base, recursive: true }).catch(() => [] as string[]) : [];
  // drafts/cNNNNN.md 带原文（入库时移进 drafts/discarded/），其余只占位
  const draftTexts = await readAt(
    book,
    draftList.filter((p) => /^drafts\/c\d{5}\.md$/.test(p)),
    base,
  );
  const draftsAtBase = new Map<string, string>(draftList.map((p) => [p, draftTexts.get(p) ?? '']));

  const row = (await db.select().from(books).where(eq(books.id, book.id)).limit(1))[0];
  const meta = readV3Meta(row?.meta);
  const rawMeta = (row?.meta ?? {}) as { blurb?: unknown };
  const cfg = book.config.v3;
  const nowIso = ctx.deps.now().toISOString();
  const settings = await loadSystemSettings(db);
  const retro = order.kind === 'book.retro';
  const cls: ErrorClass | null = h.outcome?.errorClass ?? null;
  const cleanExit = !v3h.lost && h.outcome?.status !== 'cancelled' && h.outcome?.status !== 'timeout' && cls !== 'timeout_wall' && cls !== 'timeout_idle' && cls !== 'harness_crash';
  const ownerRewrites = retro ? [] : (order.ownerRequests ?? []).map((r) => r.chapter);

  // 3. 归位与检查
  const plan = planHarvest({
    order,
    files,
    baseChapters,
    meta,
    frozen: { publishedThrough: row?.publishedThrough ?? order.publishedThrough, locked: meta.locked },
    bibleAtBase: heads.get('bible.md') ?? null,
    outlineAtBase: heads.get('outline.md') ?? null,
    progressAtBase: heads.get('notes/progress.md') ?? null,
    plannedInitial: n0Of(book),
    autoTitle: cfg.auto_title,
    titleIsPlaceholder: (row?.title ?? '').startsWith(V3_TITLE_PLACEHOLDER),
    hasBlurb: typeof rawMeta.blurb === 'string' && rawMeta.blurb.trim() !== '',
    nowIso,
    runId: h.run.runId,
    length: cfg.length,
    draftsAtBase,
    runawayFactor: settings.v3.runawayFactor,
    runawayBase: runawayBaseOf(n0Of(book), meta.plannedFloor),
    cleanExit,
    ownerRewrites: ownerRewrites,
    ownerRewriteBase: new Map(ownerRewrites.flatMap((k) => {
      const t = chapterTexts.get(`manuscript/${chapterId(k)}.md`);
      return t === undefined ? [] : [[k, t] as [number, string]];
    })),
  });
  const accepted = plan.newChapters.length;
  const noChapterStreak = retro ? meta.noChapterStreak : accepted > 0 || plan.completed ? 0 : plan.changed > 0 ? meta.noChapterStreak + 1 : meta.noChapterStreak;

  // 3b. 工具步数：章数由每批章数决定的运行（普通写作批、中长篇的开书批）超过上限且有改动 → 每批章数减一（不低于 1）。
  // 短篇的每一单、结局批的章数都不由 batch 决定，不减
  const toolSteps = v3h.toolSteps;
  let batchNote: V3BatchNote | undefined;
  const sizedByBatch = !retro && cfg.length !== 'short' && order.mode !== 'finale' && order.mode !== 'open-short' && order.count === cfg.batch;
  if (sizedByBatch && toolSteps !== undefined && toolSteps > V3_STEP_LIMIT && cfg.batch > 1 && !plan.zeroDiff) {
    batchNote = { from: cfg.batch, to: cfg.batch - 1, steps: toolSteps, runId: h.run.runId, at: nowIso };
  }
  // 3c. 零成本统计：这一批的重复说法（设定和人物表里出现过的词不算）
  let feedback: { from: number; to: number; phrases: string[] } | undefined;
  const firstNew = plan.newChapters[0];
  const lastNew = plan.newChapters.at(-1);
  if (firstNew && lastNew) {
    const newText = (p: string) => files.find((f) => f.path === p)?.text;
    const exclude = `${newText('bible.md') ?? heads.get('bible.md') ?? ''}\n${newText('notes/cast.md') ?? heads.get('notes/cast.md') ?? ''}`;
    const bodies = plan.newChapters.map((c) => c.content.replace(/^#[^\n]*\n+/, ''));
    feedback = { from: firstNew.no, to: lastNew.no, phrases: repeatedPhrases(bodies, exclude) };
  }

  // 3d. 主人留言（WP-2）：任务单列过、这次运行真的有正文入库（新章、改写或完结）→ 本批最后一个提交里清空 notes/from-owner.md、原文归档
  // （只在文件还是运行读到的那一版时）。只改了笔记、只留下草稿的运行不算读过：留言留着，下一张任务单照样带
  let serverTail: NonNullable<V3CommitPlan['serverTail']> | undefined;
  let ownerMessageRead: V3BatchEffectArgs['ownerMessageRead'];
  const proseLanded = plan.newChapters.length > 0 || plan.rewrites.length > 0 || plan.completed !== false;
  if (order.ownerMessageSha && !retro && proseLanded && base) {
    const text = (await book.repo.readFile('notes/from-owner.md', base)) ?? '';
    const stamp = (meta.ownerMessage?.setAt || nowIso).replace(/\.\d+Z$|Z$/, '').replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    const taken = new Set(await book.repo.list('notes/archive/from-owner', { rev: base, recursive: true }).catch(() => [] as string[]));
    let archivedPath = `notes/archive/from-owner/${stamp}.md`;
    for (let k = 2; taken.has(archivedPath); k += 1) archivedPath = `notes/archive/from-owner/${stamp}-${k}.md`;
    serverTail = [
      { path: 'notes/from-owner.md', content: '', expectSha: order.ownerMessageSha },
      { path: archivedPath, content: text, expectSha: null },
    ];
    // 回执只写真正入库的章：新章；没有新章时改写的章；都没有时补了标记的那一章（提交时被主人改动顶掉的，v3.batch 效果按落地的章重算）
    const nos = plan.newChapters.length > 0 ? plan.newChapters.map((c) => c.no) : plan.rewrites.length > 0 ? plan.rewrites.map((r) => r.no) : plan.completedOn !== undefined ? [plan.completedOn] : [order.accepted];
    const lo = Math.min(...nos);
    const hi = Math.max(...nos);
    const kind = order.mode === 'finale' ? 'finale' : order.kind === 'book.open' ? 'open' : 'write';
    ownerMessageRead = { sha: order.ownerMessageSha, kind, from: lo, to: hi, at: nowIso, runId: h.run.runId, archivedPath };
  }
  // 主人的改写请求：final = 这次运行正常结束且有章入库（作者看过请求、写完了这一批）。不 final 时（崩溃、超时、lost、没有章入库）
  // 没改成的请求继续等（发布暂扣照旧，下一张任务单再带）；改写入库了的照样记 done
  const requestsFinal = cleanExit && (plan.newChapters.length > 0 || plan.rewrites.length > 0);
  const ownerRequestResults = retro ? [] : (order.ownerRequests ?? []).map((r) => ({ id: r.id, chapter: r.chapter, final: requestsFinal }));

  // 4. 提交计划（幂等键来自 pending 记录，换一个任务消化同一个 pending 时键不变）
  const promote = buildPromote({
    book,
    task,
    run: h.run,
    order,
    plan,
    trailerKey: v3h.trailerKey,
    noChapterStreak,
    nowIso,
    ...(feedback ? { feedback } : {}),
    ...(batchNote ? { batchNote } : {}),
    ...(toolSteps !== undefined ? { toolSteps } : {}),
    ...(serverTail ? { serverTail } : {}),
    ...(ownerMessageRead ? { ownerMessageRead } : {}),
    ...(ownerRequestResults.length ? { ownerRequestResults } : {}),
    ...(order.takeover && plan.newChapters.length > 0 ? { takeoverDone: true } : {}),
  });

  const inbox: InboxInput[] = [];
  const bookTitle = plan.title ?? row?.title ?? book.slug;
  if (plan.completed === 'backstop') {
    inbox.push({
      kind: 'notice',
      bookId: book.id,
      title: `《${bookTitle}》写到第 ${lastNew?.no ?? order.accepted} 章仍未收尾，已按完结处理`,
      body: { detail: `写到计划章数的 ${settings.v3.runawayFactor} 倍后又写了两批，最后一批要求收尾也没有写"（全书完）"。可能没收好尾，请读一下最后几章；需要的话可以回退后重写结局。` },
      actions: [{ id: 'dismiss', label: '知道了' }],
      dedupeKey: `v3_end:${book.id}`,
    });
  } else if (plan.finaleNoMarkerAlert) {
    inbox.push({
      kind: 'notice',
      bookId: book.id,
      title: `《${bookTitle}》连续两次结局批都没有写"（全书完）"`,
      body: { detail: `写到第 ${lastNew?.no ?? order.accepted} 章了。失控兜底已关闭，这本书不会自动完结，会一直按结局批往下写。可能没收好尾，请读一下最后几章；故事已经写完的话，在最后一章末尾补一行"（全书完）"即可，也可以回退后重写结局。` },
      actions: [{ id: 'dismiss', label: '知道了' }],
      dedupeKey: `v3_end:${book.id}`,
    });
  }
  const drafts = plan.tail.filter((t) => t.path.startsWith('drafts/') && t.content !== null).map((t) => t.path);
  return {
    status: retro || accepted > 0 || plan.completed ? 'done' : 'waiting',
    ...(promote ? { promote } : {}),
    summary: {
      v3: {
        accepted,
        acceptedNos: plan.newChapters.map((c) => c.no),
        rewritten: plan.rewrites.map((r) => r.no),
        changed: plan.changed,
        zeroDiff: plan.zeroDiff,
        completed: plan.completed,
        noChapterStreak,
        drafts,
        mode: order.mode,
        from: order.from,
        orderKind: order.kind,
        retro,
        ...(toolSteps !== undefined ? { toolSteps } : {}),
        batchReduced: batchNote ?? null,
      },
    },
    ...(inbox.length ? { inbox } : {}),
  };
}

// ───────────────────────── nextTasks ─────────────────────────

/** v3 书的下一步（scheduler 每个 tick、onTaskDone、门面 start 调用）。自己读 tasks 表与 meta.v3.pending，不信 BookRuntimeState */
export async function nextTasksV3(ctx: PipelineContext, book: BookHandle, row: typeof books.$inferSelect): Promise<TaskSpec[]> {
  const db = ctx.deps.db;
  const flowTasks = await db
    .select({ id: tasks.id, kind: tasks.kind, target: tasks.target, state: tasks.state, params: tasks.params, finishedAt: tasks.finishedAt })
    .from(tasks)
    .where(and(eq(tasks.bookId, book.id), inArray(tasks.kind, [...V3_KINDS])));
  const cfg = book.config.v3;
  const meta = readV3Meta(row.meta);
  // 主人手动发布了要求改写的章：请求作废（已发布的章不能再改写）
  await dropPublishedRequests(db, book.id, row.publishedThrough);
  const ownerRequestWaiting = waitingOwnerRequests(meta, row.publishedThrough, row.acceptedThrough).length > 0;
  // 主人刚取消的任务，它的 run 还在收尾（进程内收稿、提交；run 的 lease 未过期）：先不提议。
  // 此刻提议的是收稿之前的那一步（例如又一个 book.open），收完稿就过时了。lease 过期（进程没了）或 run 判 lost 后照常提议，由新任务消化 pending
  let windingUp = false;
  const pend = meta.pending;
  if (pend && flowTasks.find((t) => t.id === pend.taskId)?.state === 'cancelled') {
    const run = (await db.select({ state: runs.state, lease: runs.leaseExpiresAt }).from(runs).where(eq(runs.id, pend.runId)).limit(1))[0];
    windingUp = !!run && run.state !== 'lost' && !!run.lease && Date.parse(run.lease) > ctx.deps.now().getTime();
  }
  // 复盘（长篇 / 超长）：上次复盘后又入库了 RETRO_EVERY 批；区间 = 上次复盘以来的每一批（至多 RETRO_EVERY + 1），书在那之后被挪动过（采用、回退）就等下一次入库
  const settings = await loadSystemSettings(db);
  // 只数作者写完的批：主人采用草稿记的 adopt 不算（retro.afterBatches 仍是 batchLog 的下标）；区间照样盖住其间采用的章
  const log = meta.batchLog;
  const counted = log.slice(meta.retro.afterBatches).filter((e) => e.kind !== 'adopt');
  const sinceRetro = counted.length;
  let retroDue = (cfg.length === 'long' || cfg.length === 'epic') && sinceRetro >= RETRO_EVERY;
  const lastEntry = log[log.length - 1];
  const firstEntry = counted[Math.max(0, counted.length - (RETRO_EVERY + 1))];
  const retroRange = retroDue && lastEntry && firstEntry && lastEntry.to === row.acceptedThrough ? { from: firstEntry.from, to: lastEntry.to } : null;
  const head10 = book.headCommit.slice(0, 10);
  if (retroDue && retroRange) {
    // 兜底：同一个复盘任务已经结束（失败、被拦、过时、取消，或者完成了却没记下）而 meta 还说该复盘 → 记作做过了，这一轮接着写
    const target = `retro-${chapterId(retroRange.to)}`;
    const dead = flowTasks.find((t) => t.kind === 'book.retro' && t.target === target && String((t.params as Record<string, unknown>).instance ?? '').startsWith(head10) && ['failed', 'blocked', 'stale', 'cancelled', 'done'].includes(t.state));
    if (dead) {
      await markRetro(db, book.id, { status: 'failed', runId: dead.id, at: ctx.deps.now().toISOString() });
      if (dead.state === 'blocked') await db.update(tasks).set({ state: 'stale', waitReason: 'retro_skipped', updatedAt: ctx.deps.now().toISOString() }).where(eq(tasks.id, dead.id));
      retroDue = false;
    }
  }
  // 排班用的存稿状况（WP-3，DESIGN §8.2“先写存稿还能撑的天数最少的”）：变化了才写，避免每个 tick 一次写入
  await updateSched(ctx, book, row, meta);
  const state: FlowState = {
    status: row.status,
    accepted: row.acceptedThrough,
    published: row.publishedThrough,
    planned: cfg.planned_chapters ?? n0Of(book),
    batch: cfg.batch,
    length: cfg.length,
    maxBuffer: book.config.publish.max_buffer,
    productionPaused: row.pausedReason === 'max_buffer',
    activeFlowTask: flowTasks.some((t) => LIVE.includes(t.state)) || windingUp,
    pending: meta.pending !== null,
    factor: settings.v3.runawayFactor,
    runawayBatches: meta.runawayBatches,
    retroDue,
    retroRange,
    ownerRequestWaiting,
    runawayBase: runawayBaseOf(n0Of(book), meta.plannedFloor),
    sinceRetro,
    rewinding: meta.rewinding !== null,
    finaleNoMarker: meta.finaleNoMarker,
    ...(meta.writeNow ? { writeNow: true } : {}),
  };
  const step = decideNext(state);
  if (step.kind === 'none') return [];
  const kind: TaskSpec['kind'] = step.kind === 'open' ? 'book.open' : step.kind === 'retro' ? 'book.retro' : 'book.write';
  const target = step.kind === 'open' ? 'book' : step.kind === 'retro' ? `retro-${chapterId(step.to)}` : `batch-${chapterId(step.from)}`;

  // 实例号 = HEAD 前缀；同一 HEAD 上被主人取消过 c 次 → ".c"，并且 10 分钟后才执行（给主人暂停的时间）
  const cancelled = flowTasks.filter((t) => t.kind === kind && t.target === target && t.state === 'cancelled' && String((t.params as Record<string, unknown>).instance ?? '').startsWith(head10));
  const instance = cancelled.length === 0 ? head10 : `${head10}.${cancelled.length}`;
  const lastCancel = cancelled.reduce((m, t) => Math.max(m, t.finishedAt ? Date.parse(t.finishedAt) : 0), 0);
  // 取消的 run 收下的章节照样提交：HEAD 和下一批的目标因此变了，上面的计数是 0，但 10 分钟的间隔同样要给（任何 v3 任务被取消都算）
  const lastAnyCancel = flowTasks.filter((t) => t.state === 'cancelled').reduce((m, t) => Math.max(m, t.finishedAt ? Date.parse(t.finishedAt) : 0), 0);
  const anyGapUntil = lastAnyCancel > 0 && lastAnyCancel + CANCEL_GAP_MS > ctx.deps.now().getTime() ? lastAnyCancel + CANCEL_GAP_MS : 0;
  const gapUntil = Math.max(cancelled.length > 0 && lastCancel > 0 ? lastCancel + CANCEL_GAP_MS : 0, anyGapUntil);
  const notBefore = gapUntil > 0 ? new Date(gapUntil).toISOString() : undefined;

  const params: Record<string, unknown> =
    step.kind === 'open'
      ? { mode: step.mode, count: step.count, instance }
      : step.kind === 'retro'
        ? { mode: 'retro', from: step.from, to: step.to, instance }
        : { mode: step.mode, from: step.from, count: step.count, phase: step.phase, forced: step.forced, instance };
  return [{ kind, bookId: book.id, target, lane: 'write', params, ...(notBefore ? { notBefore } : {}) }];
}

/**
 * meta.v3.sched：bufferDays = 现在能发布的存稿 / 每天发布章数（不按节奏发布时 null；DESIGN §3.4 的存稿只算可发布的：
 * 被改写请求、early_end 扣着的，最后一批还没满 N 小时的都不算），bufferFull = 已入库未发布 ≥ max_buffer（decideNext 的停写口径）。
 * 是否已满变了、或天数变了 ≥ 0.1 才写
 */
async function updateSched(ctx: PipelineContext, book: BookHandle, row: typeof books.$inferSelect, meta: ReturnType<typeof readV3Meta>): Promise<void> {
  const pub = book.config.publish;
  const now = ctx.deps.now();
  const buffer = Math.max(0, row.acceptedThrough - row.publishedThrough);
  const perDay = slotsPerDay(pub, now) * pub.per_slot;
  const cap = perDay > 0 ? await v3PublishCap(ctx.deps.db, book.id, now, book.config.v3.publish_after_hours) : row.publishedThrough;
  const publishable = Math.max(0, Math.min(cap, row.acceptedThrough) - row.publishedThrough);
  const bufferDays = perDay > 0 ? Math.round((publishable / perDay) * 1000) / 1000 : null;
  const bufferFull = buffer >= pub.max_buffer;
  const prev = meta.sched;
  const changed = !prev || prev.bufferFull !== bufferFull || (prev.bufferDays === null) !== (bufferDays === null) || (prev.bufferDays !== null && bufferDays !== null && Math.abs(prev.bufferDays - bufferDays) >= 0.1);
  if (changed) await setSched(ctx.deps.db, book.id, { bufferDays, bufferFull, at: now.toISOString() });
}

export const bookOpen: TaskHandler = { kind: 'book.open', role: 'writer', lane: 'write', maxAttempts: 50, manifest: v3Manifest, prepare: prepareV3, finalize: finalizeV3 };
export const bookWrite: TaskHandler = { kind: 'book.write', role: 'writer', lane: 'write', maxAttempts: 50, manifest: v3Manifest, prepare: prepareV3, finalize: finalizeV3 };
/** 复盘：只改笔记和大纲，不改正文；从不重试（失败也算做过了，见 executor finishTaskV3 与上面的兜底） */
export const bookRetro: TaskHandler = { kind: 'book.retro', role: 'writer', lane: 'write', maxAttempts: 1, manifest: v3Manifest, prepare: prepareV3, finalize: finalizeV3 };
