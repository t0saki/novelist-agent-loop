/**
 * 接手旧书（P3 D16；docs/v3/DESIGN.md §10“想续写某一本时，写作运行以‘接手’方式开始”）。只在主人 POST 时发生，从不自动接手。
 *
 * 顺序：数据库意图 → book.yaml → 数据库提交，整个操作可重入（任何一步之后崩了、出错了，再 POST 一次就做完）：
 *  0. 前提：书是旧书（数据库判定，D1）、book.yaml 读得出来、题材包在、没有在排队或在跑的任务、
 *     已写章数之后没有已入库 / 已发布的章节或正文文件（v1 导入有缺章时从缺的那一章写起会覆盖后面的章：409 chapter_gap）。
 *  1. 按新设置渲染一次根 AGENTS.md（超过 16 KB 拒收），再在内存里改一遍 book.yaml 并校验。什么都还没写。
 *  2. 意图：meta.takeoverIntent（在 meta.v3 之外，所有判定仍说“旧书”，什么都排不上）；顺手回填卷标题。
 *  3. 文件：一个只改 book.yaml 的主人提交（加 flow: v3、v3.*、publish.*；旧键和注释原样保留；已经是这个内容就不提交）。
 *  4. 提交：meta.v3 建好（takeover 记 pending、batchLog 预置一条 adopt 1..已写章数），去掉意图，状态改成 planning（或暂停）；
 *     清掉旧流程的粘性写手 books.writer_profile（接手的书走写作位置，书级覆盖由主人在书页上设）。
 *  5. 同步索引；start 时开写。
 * 旧章节、bible/、plan/、notes/v1/、根 AGENTS.md 都不动；第一次写作的任务单是“先接手”（flow/order.ts），回退不能退到接手之前。
 */
import { and, count, eq, gt, inArray, isNotNull, or } from 'drizzle-orm';
import { parseDocument, parse as yamlParse } from 'yaml';
import type { BookSummary, Takeover, TakeoverDefaults, V3Length } from '@novelist/shared';
import { AUTO_LENGTHS, V3_PUBLISH_DEFAULTS, takeoverPlanned, zBookConfig, zTakeover } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { bookDir, type BookRow } from '../api/helpers.js';
import { HttpProblem } from '../api/problem.js';
import { fillVolumeTitles, isV3Meta, openRepo, P, readFlowTolerant } from '../book/index.js';
import { books, chapters, runs, tasks } from '../db/schema.js';
import { CLOSING_BATCHES } from '../flow/decide.js';
import { emptyV3Meta } from '../flow/state.js';
import type { V3BookMeta } from '../flow/types.js';
import { genreExists, loadGenre } from '../genres/index.js';
import { V3_AGENTS_SOFT_LIMIT, renderAgentsMdV3 } from '../instructions/v3.js';
import { commitOwnerEditIf } from '../orchestrator/committer.js';
import { loadSystemSettings } from '../orchestrator/routing.js';
import { syncBookIndex } from './repo-files.js';

/** 有这些状态的任务时不接手（等它们结束，或先取消） */
const LIVE_STATES = ['pending', 'ready', 'waiting', 'blocked', 'leased', 'running', 'finalizing'] as const;
const ACTIVE_RUNS = ['preparing', 'spawned', 'running'] as const;
const TAKEOVER_MESSAGE = 'owner: take over legacy book (flow v3)';

interface Intent {
  at: string;
  from: number;
  input: Record<string, unknown>;
}

const notLegacy = () => new HttpProblem(409, 'not_legacy', '这本书已经是新流程的书了');

async function assertIdle(deps: Pick<AppDeps, 'db'>, bookId: string): Promise<void> {
  const [t] = await deps.db.select({ n: count() }).from(tasks).where(and(eq(tasks.bookId, bookId), inArray(tasks.state, [...LIVE_STATES])));
  const [r] = await deps.db.select({ n: count() }).from(runs).where(and(eq(runs.bookId, bookId), inArray(runs.state, [...ACTIVE_RUNS])));
  if (Number(t?.n ?? 0) > 0 || Number(r?.n ?? 0) > 0) throw new HttpProblem(409, 'busy', '这本书还有任务在排队或在跑，等它们结束（或先取消）再接手');
}

const GAP_LIST_MAX = 20;

/**
 * 已写章数（acceptedThrough，连续的）之后还有已入库 / 已发布的章节行，或 HEAD 上有更大章号的正文文件：
 * v1 导入时中间缺章就会这样。接手从 acceptedThrough + 1 写起，会把后面那些章（可能已经发布）当新章覆盖掉，所以先拒绝。
 */
export async function chapterGap(deps: Pick<AppDeps, 'db' | 'paths'>, row: Pick<BookRow, 'id' | 'slug' | 'acceptedThrough'>): Promise<{ missing: number[]; extra: number[] } | null> {
  const accepted = row.acceptedThrough;
  const rows = await deps.db
    .select({ no: chapters.no })
    .from(chapters)
    .where(and(eq(chapters.bookId, row.id), gt(chapters.no, accepted), or(eq(chapters.state, 'accepted'), isNotNull(chapters.publishedAt), isNotNull(chapters.acceptedCommit))));
  const files = (await openRepo(bookDir(deps, row.slug)).list(P.manuscriptDir, { rev: 'HEAD' }).catch(() => [] as string[]))
    .map((f) => /^manuscript\/c(\d{5})\.md$/.exec(f)?.[1])
    .filter((x): x is string => !!x)
    .map(Number)
    .filter((n) => n > accepted);
  const extra = [...new Set([...rows.map((r) => r.no), ...files])].sort((a, b) => a - b);
  if (extra.length === 0) return null;
  const have = new Set(extra);
  const missing: number[] = [];
  for (let k = accepted + 1; k < (extra.at(-1) ?? 0) && missing.length < GAP_LIST_MAX; k += 1) if (!have.has(k)) missing.push(k);
  return { missing, extra: extra.slice(0, GAP_LIST_MAX) };
}

const gapProblem = (g: { missing: number[]; extra: number[] }) =>
  new HttpProblem(409, 'chapter_gap', `第 ${g.missing.join('、') || '?'} 章缺失，后面却还有第 ${g.extra.join('、')} 章。接手会从缺的那一章写起并覆盖后面的章：先补上缺的章，或者把后面的章移走（直接编辑 / 删除），再接手`, {
    detail: JSON.stringify(g),
  });

/** 已写的字数 → 建议篇幅：目标字数比已写的多的最小一档；都不够就超长 */
function suggestLength(totalCjk: number, lengths: Record<V3Length, { targetCjk: number }>): V3Length {
  return AUTO_LENGTHS.find((l) => lengths[l].targetCjk > totalCjk) ?? 'epic';
}

const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;

export async function takeoverDefaults(deps: AppDeps, row: BookRow): Promise<TakeoverDefaults> {
  if (isV3Meta(row.meta)) throw notLegacy();
  const settings = await loadSystemSettings(deps.db);
  const length = suggestLength(row.totalCjk, settings.autoStart.lengths);
  const batch = 5;
  const minChapter = 3000;
  const accepted = row.acceptedThrough;
  // 已有章节：目标至少比已写的多出 CLOSING_BATCHES + 2 批（按这本书实际的每章字数），默认值折出的计划就不会一接手就收尾
  const avg = accepted > 0 ? Math.max(row.totalCjk / accepted, minChapter) : minChapter;
  const room = accepted > 0 ? roundUp(Math.round(row.totalCjk + (CLOSING_BATCHES + 2) * batch * avg), 10_000) : 0;
  const target = Math.max(settings.autoStart.lengths[length].targetCjk, roundUp(Math.round(row.totalCjk * 1.2), 10_000), room);
  let agentsBytes = 0;
  try {
    const cfg = await readLegacyConfig(deps, row);
    const genre = await loadGenre(deps.paths, cfg.genre);
    agentsBytes = (await renderAgentsMdV3({ globalDir: deps.paths.instructionsGlobal, genreDirs: genre.chain.map((g) => ({ id: g.id, dir: g.dir, name: g.pack.name ?? g.id })), bookDir: bookDir(deps, row.slug), length })).bytes;
  } catch {
    agentsBytes = 0;
  }
  const planned = takeoverPlanned({ accepted, totalCjk: row.totalCjk, target_cjk: target, batch, min_chapter_cjk: minChapter, length }, CLOSING_BATCHES);
  const gap = await chapterGap(deps, row).catch(() => null);
  return { length, target_cjk: target, batch, min_chapter_cjk: minChapter, accepted, totalCjk: row.totalCjk, agentsBytes, agentsOver: agentsBytes > V3_AGENTS_SOFT_LIMIT, planned, closingBatches: CLOSING_BATCHES, gap };
}

/** book.yaml 的题材（旧书的 book.yaml 可能不合 schema：只取 genre） */
async function readLegacyConfig(deps: AppDeps, row: BookRow): Promise<{ genre: string; raw: string }> {
  const raw = await openRepo(bookDir(deps, row.slug)).readFile(P.bookYaml);
  if (raw === null) throw new HttpProblem(409, 'book_unreadable', '这本书的 book.yaml 不在');
  let doc: unknown;
  try {
    doc = yamlParse(raw);
  } catch {
    throw new HttpProblem(409, 'book_unreadable', 'book.yaml 解析不了');
  }
  const genre = (doc as { genre?: unknown } | null)?.genre;
  return { genre: typeof genre === 'string' && genre ? genre : row.genre, raw };
}

interface Plan {
  input: ReturnType<typeof zTakeover.parse>;
  from: number;
  planned: number;
  maxBuffer: number;
  effort: Record<string, string>;
  publish: Record<string, unknown>;
}

/** 在内存里改 book.yaml（保留注释和旧键）；返回新文本 */
function patchYaml(raw: string, p: Plan): string {
  const doc = parseDocument(raw);
  doc.set('flow', 'v3');
  const v3 = { length: p.input.length, target_cjk: p.input.target_cjk, planned_chapters: p.planned, planned_chapters_initial: p.planned, batch: p.input.batch, min_chapter_cjk: p.input.min_chapter_cjk, auto_title: false };
  for (const [k, v] of Object.entries(v3)) doc.setIn(['v3', k], v);
  for (const [k, v] of Object.entries(p.effort)) doc.setIn(['v3', 'effort', k], v);
  for (const [k, v] of Object.entries(p.publish)) doc.setIn(['publish', k], v);
  return doc.toString({ lineWidth: 0 });
}

const inProcess = new Map<string, Promise<unknown>>();

/** 同一进程里同一本书的接手排队执行（第二个看到的已经是 v3 书，回 409 not_legacy） */
async function serialized<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
  const prev = inProcess.get(bookId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  inProcess.set(bookId, next);
  try {
    return await next;
  } finally {
    if (inProcess.get(bookId) === next) inProcess.delete(bookId);
  }
}

export interface TakeoverTestHooks {
  /** 测试：在这一步之后抛错（模拟崩溃） */
  failAfter?: 'intent' | 'file';
}

/** 见文件头。返回接手后的书摘要 */
export async function takeOverBook(deps: AppDeps, rowIn: BookRow, inputRaw: Takeover, hooks: TakeoverTestHooks = {}): Promise<BookSummary> {
  const input = zTakeover.parse(inputRaw);
  return serialized(rowIn.id, async () => {
    // 0. 前提（数据库是判定的依据）
    const row = (await deps.db.select().from(books).where(eq(books.id, rowIn.id)).limit(1))[0];
    if (!row) throw new HttpProblem(404, 'not_found', '书不存在');
    if (isV3Meta(row.meta)) throw notLegacy();
    const dir = bookDir(deps, row.slug);
    const flow = await readFlowTolerant(dir);
    if (flow === 'missing' || flow === 'invalid') throw new HttpProblem(409, 'book_unreadable', flow === 'missing' ? '书目录或 book.yaml 不在' : 'book.yaml 解析不了');
    const legacy = await readLegacyConfig(deps, row);
    if (!(await genreExists(deps.paths, legacy.genre))) throw new HttpProblem(409, 'unknown_genre', `题材包不存在：${legacy.genre}（先恢复或新建这个题材包）`);
    await assertIdle(deps, row.id);
    const gap = await chapterGap(deps, row);
    if (gap) throw gapProblem(gap);

    const settings = await loadSystemSettings(deps.db);
    const accepted = row.acceptedThrough;
    const intentNow = ((row.meta ?? {}) as { takeoverIntent?: Intent }).takeoverIntent;
    const from = typeof intentNow?.from === 'number' ? intentNow.from : accepted + 1;
    const pd = settings.v3.publishDefaults;
    const maxBuffer = Math.max(pd.max_buffer, 2 * input.batch);
    const plan: Plan = {
      input,
      from,
      planned: takeoverPlanned({ accepted, totalCjk: row.totalCjk, target_cjk: input.target_cjk, batch: input.batch, min_chapter_cjk: input.min_chapter_cjk, length: input.length }, CLOSING_BATCHES),
      maxBuffer,
      effort: { ...settings.v3.effortDefaults },
      // 旧的 require_audited / lag 会卡住新流程的发布：一律换成新流程的值
      publish: { mode: pd.mode, cadence: pd.cadence, timezone: pd.timezone, per_slot: pd.per_slot, max_buffer: maxBuffer, require_audited: false, lag: V3_PUBLISH_DEFAULTS.lag, min_lag: V3_PUBLISH_DEFAULTS.min_lag, resume_buffer: Math.max(1, maxBuffer - 5) },
    };

    // 1. 根 AGENTS.md（书自己的 instructions/AGENTS.md 可能还是旧模板：那只是作者文本）与 book.yaml 的预演
    const genre = await loadGenre(deps.paths, legacy.genre);
    let agents: Awaited<ReturnType<typeof renderAgentsMdV3>>;
    try {
      agents = await renderAgentsMdV3({ globalDir: deps.paths.instructionsGlobal, genreDirs: genre.chain.map((g) => ({ id: g.id, dir: g.dir, name: g.pack.name ?? g.id })), bookDir: dir, length: input.length });
    } catch (e) {
      throw new HttpProblem(409, 'instruction_include', `这本书的 AGENTS.md 渲染失败：${(e as Error).message}`);
    }
    if (agents.bytes > V3_AGENTS_SOFT_LIMIT) {
      throw new HttpProblem(409, 'instructions_too_large', `接手后这本书的 AGENTS.md 有 ${agents.bytes} 字节，超过 ${V3_AGENTS_SOFT_LIMIT} 字节；先把指令缩短`, {
        detail: agents.layers.map((l) => `${l.label}：${l.bytes} 字节`).join('；'),
        errors: agents.layers.map((l) => ({ path: l.id, message: `${l.label}：${l.bytes} 字节` })),
      });
    }
    const preview = zBookConfig.safeParse(yamlParse(patchYaml(legacy.raw, plan)));
    if (!preview.success) {
      throw new HttpProblem(409, 'book_unreadable', '这本书的 book.yaml 改成新流程后仍然不合格式，先修好 book.yaml', { errors: preview.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }

    // 2. 意图（meta.v3 之外：所有判定仍说旧书）
    const at = new Date().toISOString();
    await deps.db.transaction(async (tx) => {
      const cur = (await tx.select({ meta: books.meta }).from(books).where(eq(books.id, row.id)).limit(1).for('update'))[0];
      if (!cur || isV3Meta(cur.meta)) throw notLegacy();
      const meta = (cur.meta ?? {}) as Record<string, unknown>;
      const intent: Intent = { at: intentNow?.at ?? at, from, input: { ...input } };
      await tx.update(books).set({ meta: { ...meta, takeoverIntent: intent } }).where(eq(books.id, row.id));
    });
    await fillVolumeTitles(deps.db, deps.paths, { id: row.id, slug: row.slug }).catch((err: Error) => deps.log.warn({ err: err.message, slug: row.slug }, 'takeover: volume titles not filled'));
    if (hooks.failAfter === 'intent') throw new Error('takeover test hook: after intent');

    // 3. book.yaml（锁里重新读、重新查一遍忙不忙；内容已经是这样就不提交）
    const repo = openRepo(dir);
    const committed = await commitOwnerEditIf(
      deps.db,
      repo,
      row.id,
      async () => {
        await assertIdle(deps, row.id);
        return true;
      },
      async () => {
        const raw = await repo.readFile(P.bookYaml);
        if (raw === null) throw new HttpProblem(409, 'book_unreadable', 'book.yaml 不在');
        const next = patchYaml(raw, plan);
        return next === raw ? null : { files: [{ path: P.bookYaml, content: next }], message: TAKEOVER_MESSAGE, baseSha: null };
      },
    );
    const takeoverCommit = typeof committed === 'object' ? committed.commit : await repo.head();
    if (hooks.failAfter === 'file') throw new Error('takeover test hook: after book.yaml');

    // 4. 数据库提交（锁住书行再查一次：别的请求已经做完了就照样返回）
    await deps.db.transaction(async (tx) => {
      const cur = (await tx.select({ meta: books.meta }).from(books).where(eq(books.id, row.id)).limit(1).for('update'))[0];
      if (!cur || isV3Meta(cur.meta)) return;
      const { takeoverIntent: _intent, ...meta } = (cur.meta ?? {}) as Record<string, unknown>;
      const v3: V3BookMeta = {
        ...emptyV3Meta(),
        plannedFloor: plan.planned,
        // 一章都没有的旧书也记 pending：开书的任务单换成接手单（读旧的 premise / notes，沿用主人的设定），有章入库后记 done
        takeover: { at, from, status: 'pending' },
        // 预置一条 adopt：书页和 reindex 不会按旧的 git 历史回填批次；回退最多退到这里
        batchLog: accepted > 0 ? [{ kind: 'adopt', runId: null, from: 1, to: accepted, baseCommit: takeoverCommit, finalCommit: takeoverCommit, at }] : [],
        retro: { afterBatches: accepted > 0 ? 1 : 0, lastAt: null, lastRunId: null, lastStatus: null },
      };
      await tx
        .update(books)
        .set({
          meta: { ...meta, v3 },
          // 旧流程的粘性写手不是主人为这本新流程的书做的选择：接手后走写作位置（M4b 也不会再把它搬进 book.yaml）
          writerProfile: null,
          headCommit: takeoverCommit,
          status: input.start ? 'planning' : 'paused',
          pausedReason: input.start ? null : 'owner',
          archivedAt: null,
          updatedAt: at,
        })
        .where(eq(books.id, row.id));
    });

    // 5. 索引、开写、通知
    const cfg = zBookConfig.parse(yamlParse((await repo.readFile(P.bookYaml)) ?? ''));
    await syncBookIndex(deps, row.id, cfg);
    if (input.start) await deps.orchestrator.startBook(row.id);
    deps.bus.publish({ type: 'book_changed', book: row.slug });
    const { summarize } = await import('./books.js');
    const fresh = (await deps.db.select().from(books).where(eq(books.id, row.id)).limit(1))[0] as BookRow;
    return (await summarize(deps, [fresh]))[0] as BookSummary;
  });
}
