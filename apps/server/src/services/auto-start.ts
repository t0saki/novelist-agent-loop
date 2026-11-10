/**
 * 自动开书（DESIGN §8.1；p2-plan §3.3 D）。Owner: lane G。
 * 调度器 leader 每轮调用（开关默认关闭，见 createAutoStarter）：未完结的书少于上限、写手真的闲着、未超每日上限时，
 * 按“自动开过的书数 / 权重”最小挑题材包，再按目标分布补缺口最大的篇幅，开一本 v3 书；书名由作者在 bible.md 里起。
 * 题材内容归用户所有，这里只拼结构化的种子。v2 的 buildAutoSeed / autoScale 只剩测试在用（phase 3 删除）。
 */
import { and, count, desc, eq, gte, inArray, isNotNull, like, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AutoLength, ErrorClass, GenrePack, LengthMix, SystemSettings } from '@novelist/shared';
import { AUTO_LENGTHS, V3_TITLE_PLACEHOLDER } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { bookBySlug, bookDir } from '../api/helpers.js';
import { bookFiles, openRepo } from '../book/index.js';
import type { Db } from '../db/client.js';
import { accounts, accountsState, bookEvents, books, circuitBreakers, runs, tasks } from '../db/schema.js';
import { readV3Meta } from '../flow/state.js';
import { listGenres } from '../genres/index.js';
import { INFRA_CLASSES } from '../orchestrator/actions.js';
import { ACTIVE_STATES } from '../orchestrator/queue.js';
import { resolveRoute } from '../orchestrator/routing.js';
import type { LeaderHook } from '../orchestrator/scheduler.js';
import { AUTO_CREATED_EVENT, createBook, patchBookYaml } from './books.js';

export const AUTO_TITLE_PREFIX = '待命名·';
const AUTO_SLUG_PREFIX = 'auto-';
const AUTO_EVENT = AUTO_CREATED_EVENT;
const CHECK_INTERVAL_MS = 30_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const DAY_MS = 24 * 3600_000;

/** 加权轮转：“自动开过的书数 / 权重”最小者胜，同分按 id，结果可复现。weights 给出时覆盖 pack.yaml 的 auto.weight（设置里的题材权重） */
export function pickGenre(packs: Pick<GenrePack, 'id' | 'auto'>[], counts: Map<string, number>, weights?: Map<string, number>): string | null {
  const score = (p: Pick<GenrePack, 'id' | 'auto'>) => (counts.get(p.id) ?? 0) / Math.max(weights?.get(p.id) ?? p.auto?.weight ?? 1, 0.01);
  const sorted = [...packs].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
  return sorted[0]?.id ?? null;
}

/** v1 的判定顺序：“超长篇”也包含“长篇”，先判超长；没写篇幅按短篇 */
export function lengthClass(hint: string): AutoLength {
  if (hint.includes('超长')) return 'epic';
  if (hint.includes('长篇')) return 'long';
  if (hint.includes('中篇')) return 'medium';
  return 'short';
}

/** 档位规模 → book.yaml scale；卷数按字数推算，题材包的最少章数是全书下限 */
export function autoScale(size: { targetCjk: number; chaptersMin: number; chaptersMax: number }, minChapters: number | null, chapterTarget: number) {
  // 实际章数 = 目标字数 / 单章字数，所以章数下限要换算成字数才生效
  const targetCjk = Math.max(size.targetCjk, (minChapters ?? 0) * chapterTarget);
  const volumes: [number, number] = [Math.max(1, Math.floor(targetCjk / 200_000)), Math.max(1, Math.ceil(targetCjk / 100_000))];
  const chaptersMin = Math.max(size.chaptersMin, Math.ceil((minChapters ?? 0) / volumes[0]));
  return {
    target_cjk: targetCjk,
    hard_max_cjk: Math.round(targetCjk * 1.5),
    volumes,
    chapters_per_volume: [chaptersMin, Math.max(size.chaptersMax, chaptersMin)] as [number, number],
  };
}

/** 选项数两两互质（3/4/5/7），按序号取模时要 420 本才会重复同一组合，不用记状态也不用随机 */
const DIVERSITY_AXES = [
  { name: '叙事视角', options: ['第一人称', '贴身第三人称', '多视角轮换'] },
  { name: '结构', options: ['线性推进', '倒叙开场', '双线交错', '围绕同一事件多角度回看'] },
  { name: '基调', options: ['轻快', '克制内敛', '悬疑紧张', '荒诞幽默', '沉郁'] },
  { name: '结局', options: ['圆满', '苦乐参半', '开放式', '反转', '代价沉重但留有希望', '主角主动放弃', '回到起点但已不同'] },
];

export function diversityBrief(ordinal: number): string {
  return DIVERSITY_AXES.map((a) => `${a.name}${a.options[ordinal % a.options.length]}`).join('，');
}

/** premise 里的一句话卖点：比书名更能说明两本书是不是在写同一个故事 */
export function premiseDigest(premise: string): string | null {
  const lines = premise.split('\n').map((l) => l.trim());
  const i = lines.findIndex((l) => /一句话|logline/i.test(l));
  if (i < 0) return null;
  const clean = (l: string) => l.replace(/^[#>*\s-]+/, '').replace(/\*\*/g, '').trim();
  const inline = clean(lines[i] ?? '').split(/[:：]/).slice(1).join('：').trim();
  const text = inline || clean(lines.slice(i + 1).find((l) => l && !l.startsWith('#')) ?? '');
  return text ? text.slice(0, 100) : null;
}

export interface AutoSeedContext {
  /** 这个题材包第几本自动开的书（从 0 起） */
  ordinal: number;
  sameGenre: { title: string; digest: string | null }[];
}

export function buildAutoSeed(pack: Pick<GenrePack, 'name' | 'auto'>, recentTitles: string[], ctx: AutoSeedContext = { ordinal: 0, sameGenre: [] }): string {
  const auto = pack.auto;
  const lines = [
    '（自动开书）当前书名只是占位，请为这个故事自拟书名，并把 bible/premise.md 的第一行写成“# 《你拟的名字》”。',
    '',
    `题材：${pack.name}`,
  ];
  if (auto?.keywords.length) lines.push(`灵感关键词（不必全用）：${auto.keywords.join('、')}`);
  if (auto?.length_hint) lines.push(`篇幅提示：${auto.length_hint}`);
  lines.push(`本书写法（与题材要求冲突时以题材为准）：${diversityBrief(ctx.ordinal)}。`);
  if (ctx.sameGenre.length) {
    lines.push('同题材已有作品（主角设定、核心冲突和主线走向都要明显不同）：');
    for (const b of ctx.sameGenre) lines.push(`- 《${b.title}》${b.digest ? `：${b.digest}` : ''}`);
  }
  if (recentTitles.length) lines.push(`近期已写作品（不要撞题）：${recentTitles.join('、')}`);
  if (auto?.adult_only) lines.push('人物年龄：所有角色都是年满 18 岁的成年人，并在人物设定里写明年龄。');
  lines.push('', '请据此原创一个完整的故事设想，不要沿用上面作品的人物和情节。');
  return lines.join('\n');
}

/** 从 premise 里取规划师拟的书名；还没拟（仍是种子）时返回 null */
export function extractAutoTitle(premise: string): string | null {
  for (const line of premise.split('\n').slice(0, 40)) {
    const m = /^#{1,3}\s*《([^《》]{1,40})》/.exec(line.trim()) ?? /^[#*\s-]*书名[:：]\s*\**《?([^《》*\n]{1,40})》?/.exec(line.trim());
    const title = m?.[1]?.trim();
    if (title && title !== '书名' && title !== '你拟的名字' && !title.startsWith(AUTO_TITLE_PREFIX)) return title;
  }
  return null;
}

/** 给还顶着占位名的自动开书改名 */
export async function nameAutoBooks(deps: AppDeps): Promise<void> {
  const rows = await deps.db
    .select({ slug: books.slug })
    .from(books)
    .where(and(like(books.title, `${AUTO_TITLE_PREFIX}%`), inArray(books.status, ['planning', 'active', 'paused'])));
  for (const { slug } of rows) {
    try {
      const repo = openRepo(bookDir(deps, slug));
      const title = extractAutoTitle(await bookFiles(repo).premise());
      if (!title) continue;
      const row = await bookBySlug(deps, slug);
      await patchBookYaml(deps, row, repo, (doc) => doc.setIn(['title'], title), 'auto-start: name book');
      await deps.db.update(books).set({ title, updatedAt: new Date().toISOString() }).where(eq(books.id, row.id));
      deps.bus.publish({ type: 'book_changed', book: slug });
    } catch (err) {
      deps.log.warn({ slug, err: (err as Error).message }, 'auto-start: naming failed');
    }
  }
}

// ───────────────────────── v3 自动开书（DESIGN §8.1；p2-plan §3.3 D） ─────────────────────────

const LENGTH_ORDER: readonly AutoLength[] = ['short', 'medium', 'long', 'epic'];
const RECENT_LENGTHS = 20;

/**
 * 篇幅：看最近 ≤20 本自动书的篇幅分布，补缺口最大的一档。缺口 = 目标占比 ×（n+1）− 已有本数；题材包的篇幅倾向只加 0.5 本。
 * 平手：目标占比大的优先，再按 short、medium、long、epic。
 */
export function pickLength(recent: AutoLength[], mix: LengthMix, hint: AutoLength | null): AutoLength {
  const n = Math.min(recent.length, RECENT_LENGTHS);
  const window = recent.slice(0, RECENT_LENGTHS);
  // 取到 1e-9：0.7 × 2 − 1 与 0.2 × 2 要算作平手
  // 篇幅倾向只给占比 > 0 的档加分：主人设成 0% 的篇幅永远不开
  const score = (c: AutoLength) => Math.round(((mix[c] / 100) * (n + 1) - window.filter((x) => x === c).length + (c === hint && mix[c] > 0 ? 0.5 : 0)) * 1e9) / 1e9;
  const allowed = LENGTH_ORDER.filter((c) => mix[c] > 0);
  const sorted = [...(allowed.length > 0 ? allowed : LENGTH_ORDER)].sort((a, b) => score(b) - score(a) || mix[b] - mix[a] || LENGTH_ORDER.indexOf(a) - LENGTH_ORDER.indexOf(b));
  return sorted[0] as AutoLength;
}

/** 必用关键词：没有 → []；一个 → [它]；多个 → 随机 1 或 2 个（rng() < 0.5 时 2 个），互不相同 */
export function pickKeywords(keywords: string[], rng: () => number): string[] {
  const pool = [...new Set(keywords.map((k) => k.trim()).filter((k) => k !== ''))];
  if (pool.length <= 1) return pool;
  const want = rng() < 0.5 ? 2 : 1;
  const out: string[] = [];
  for (let i = 0; i < want && pool.length > 0; i += 1) {
    const at = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    out.push(...pool.splice(at, 1));
  }
  return out;
}

/** v3 自动开书的种子（写进 seed.md；p2-plan §5.9） */
export function buildAutoSeedV3(pack: Pick<GenrePack, 'name' | 'auto'>, ctx: { ordinal: number; keywords: string[] }): string {
  const lines = ['（自动开书）这本书由系统自动开出，没有主人的具体设想。书名请在 bible.md 第一行自拟。', '', `题材：${pack.name}`];
  if (ctx.keywords.length) lines.push(`必须用上的关键词：${ctx.keywords.join('、')}（写进主线或主角设定）`);
  lines.push(`本书写法（与题材要求冲突时以题材为准）：${diversityBrief(ctx.ordinal)}。`);
  if (pack.auto?.adult_only) lines.push('人物年龄：所有角色都是年满 18 岁的成年人，并在人物设定里写明年龄。');
  lines.push('请据此原创一个完整的故事设想，不要沿用书库摘要里已有作品的人物和情节。');
  return lines.join('\n');
}

/** 未完结的自有书：planning / active / paused，不含导入的书（meta.v1） */
export async function unfinishedOwnBooks(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(books)
    .where(and(inArray(books.status, ['planning', 'active', 'paused']), sql`${books.meta}->'v1' is null`));
  return Number(r?.n ?? 0);
}

/**
 * 写手真的闲着（DESIGN §8.1）：没有账号在等额度或登录失效；写作这一路现在能路由（profile 启用、有账号、熔断没开）；
 * 写手的 harness 没有待定的熔断；没有在跑的写作任务；所有在写的自有书都存稿已满。不闲时 reason 说明是哪一条。
 */
export async function writerIdle(db: Db, now: Date, opts: { allowFakeHarness?: boolean } = {}): Promise<{ idle: boolean; reason: string | null }> {
  // (a) 账号在睡（额度、暂停）或登录失效
  const acct = await db.select({ id: accounts.id, enabled: accounts.enabled, sleepUntil: accountsState.sleepUntil, auth: accountsState.lastAuthCheck }).from(accounts).leftJoin(accountsState, eq(accountsState.accountId, accounts.id));
  for (const a of acct) {
    if (!a.enabled) continue;
    if (a.sleepUntil && Date.parse(a.sleepUntil) > now.getTime()) return { idle: false, reason: `account_sleeping:${a.id}` };
    if ((a.auth as { ok?: unknown } | null)?.ok === false) return { idle: false, reason: `account_auth:${a.id}` };
  }
  // (b) 写作这一路现在路由不到（只读，不占并发）
  const route = await resolveRoute(db, { book: null, role: 'writer', tier: 'standard', ignoreConcurrency: true, now, ...(opts.allowFakeHarness ? { allowFakeHarness: true } : {}) });
  if (!route.profile || !route.harness) return { idle: false, reason: `no_route:${route.cause ?? 'no_route'}` };
  // (c) 写手 harness 的熔断待定（canary 还没出结果）
  const pending = await db.select({ h: circuitBreakers.harness }).from(circuitBreakers).where(and(eq(circuitBreakers.harness, route.harness), eq(circuitBreakers.state, 'pending_open'))).limit(1);
  if (pending[0]) return { idle: false, reason: `circuit_pending:${route.harness}` };
  // (d) 有写作任务在跑
  const [busy] = await db.select({ n: count() }).from(tasks).where(and(eq(tasks.lane, 'write'), inArray(tasks.state, ACTIVE_STATES)));
  if (Number(busy?.n ?? 0) > 0) return { idle: false, reason: 'write_active' };
  // (d2) 有写作任务排着队（复盘、主人要求的改写批、结局批、取消后的 10 分钟间隔……）：写手还有活要干。
  // 只算会被认领的：书在写；等外部事件（not_before 为空）的 waiting 不算；存稿上限暂停拦着的写作批不算（与 claimNext 同口径）
  const [queued] = await db
    .select({ n: count() })
    .from(tasks)
    .innerJoin(books, eq(books.id, tasks.bookId))
    .where(
      and(
        eq(tasks.lane, 'write'),
        or(inArray(tasks.state, ['ready', 'pending']), and(eq(tasks.state, 'waiting'), isNotNull(tasks.notBefore))),
        inArray(books.status, ['planning', 'active']),
        sql`not (coalesce(${books.pausedReason}, '') = 'max_buffer' and ${tasks.kind} in ('chapter.write','book.write')
          and not (${tasks.kind} = 'book.write' and (coalesce(${tasks.params}->>'mode', '') = 'finale'
            or jsonb_path_exists(coalesce(${books.meta}->'v3'->'ownerRequests', '[]'::jsonb), '$[*] ? (@.status == "waiting")'))))`,
      ),
    );
  if (Number(queued?.n ?? 0) > 0) return { idle: false, reason: 'write_pending' };
  // (e) 还有在写的自有书没写满存稿
  const open = await db
    .select({ id: books.id, pausedReason: books.pausedReason, meta: books.meta })
    .from(books)
    .where(and(inArray(books.status, ['planning', 'active']), sql`${books.meta}->'v1' is null`));
  for (const b of open) {
    const v3 = (b.meta as { v3?: unknown } | null)?.v3;
    const full = v3 !== undefined && v3 !== null ? readV3Meta(b.meta).sched?.bufferFull === true : b.pausedReason === 'max_buffer';
    if (!full) return { idle: false, reason: `buffer_room:${b.id}` };
  }
  return { idle: true, reason: null };
}

/**
 * 24 小时内自动开过几本（删掉的书照样算：删书不退名额）。开书运行全都因基础设施原因失败、一章没写成的不算；还没跑过的算。
 */
export async function autoStartsToday(db: Db, now: Date): Promise<number> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const evs = await db
    .select({ bookId: bookEvents.bookId, exists: books.id, accepted: books.acceptedThrough })
    .from(bookEvents)
    .leftJoin(books, eq(books.id, bookEvents.bookId))
    .where(and(eq(bookEvents.kind, AUTO_EVENT), gte(bookEvents.ts, since)));
  let n = 0;
  for (const e of evs) {
    if (!e.exists || (e.accepted ?? 0) > 0) {
      n += 1;
      continue;
    }
    const opens = await db
      .select({ cls: runs.errorClass })
      .from(runs)
      .where(and(eq(runs.bookId, e.bookId), eq(runs.taskKind, 'book.open'), isNotNull(runs.endedAt)));
    const infraOnly = opens.length > 0 && opens.every((r) => r.cls !== null && INFRA_CLASSES.has(r.cls as ErrorClass));
    if (!infraOnly) n += 1;
  }
  return n;
}

/** 条件满足就开一本 v3 书，返回新书 slug；一轮最多开一本。开关由 createAutoStarter 判断，这里从不读 enabled */
export async function maybeStartBook(deps: AppDeps, now: Date, s: SystemSettings, opts: { rng?: () => number } = {}): Promise<string | null> {
  const cfg = s.autoStart;
  if ((await unfinishedOwnBooks(deps.db)) >= cfg.maxUnfinishedBooks) return null;
  const idle = await writerIdle(deps.db, now, { allowFakeHarness: deps.config.allowFakeHarness });
  if (!idle.idle) {
    deps.log.debug({ reason: idle.reason }, 'auto-start: writer not idle');
    return null;
  }
  if (cfg.maxPerDay > 0 && (await autoStartsToday(deps.db, now)) >= cfg.maxPerDay) return null;

  // 上次开书卡在 startBook（比如题材包损坏）：先重试它，不再造新书
  const [orphan] = await deps.db
    .select({ id: books.id, slug: books.slug, genre: books.genre })
    .from(books)
    .where(and(eq(books.status, 'draft'), like(books.slug, `${AUTO_SLUG_PREFIX}%`), or(like(books.title, `${AUTO_TITLE_PREFIX}%`), like(books.title, `${V3_TITLE_PLACEHOLDER}%`))))
    .limit(1);
  if (orphan) {
    await deps.orchestrator.startBook(orphan.id, { interview: false });
    await deps.db.insert(bookEvents).values({ bookId: orphan.id, kind: AUTO_EVENT, body: { genre: orphan.genre } });
    return orphan.slug;
  }

  const weightOf = (p: Pick<GenrePack, 'id' | 'auto'>) => cfg.genreWeights[p.id] ?? p.auto?.weight ?? 1;
  const packs = (await listGenres(deps.paths)).filter((p) => !p.hidden && (cfg.genres ? cfg.genres.includes(p.id) : p.auto?.enabled === true) && weightOf(p) > 0);
  // v1 的教训：没有题材就不开书，避免写出无关内容
  if (packs.length === 0) return null;
  // 分母只算自动开过的书（导入的书没有自动开书记录）
  const events = await deps.db.select({ body: bookEvents.body, ts: bookEvents.ts, id: bookEvents.id }).from(bookEvents).where(eq(bookEvents.kind, AUTO_EVENT)).orderBy(desc(bookEvents.ts), desc(bookEvents.id));
  const counts = new Map<string, number>();
  for (const e of events) {
    const g = typeof e.body.genre === 'string' ? e.body.genre : null;
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const genre = pickGenre(packs, counts, new Map(packs.map((p) => [p.id, weightOf(p)])));
  const pack = packs.find((p) => p.id === genre);
  if (!pack) return null;

  const recent = events
    .map((e) => e.body.length)
    .filter((l): l is AutoLength => typeof l === 'string' && (AUTO_LENGTHS as readonly string[]).includes(l))
    .slice(0, RECENT_LENGTHS);
  const hint = pack.auto?.length_hint ? lengthClass(pack.auto.length_hint) : null;
  const len = pickLength(recent, cfg.lengthMix, hint);
  const keywords = pickKeywords(pack.auto?.keywords ?? [], opts.rng ?? Math.random);
  const id = nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, '0');
  const created = await createBook(deps, {
    title: '',
    slug: `${AUTO_SLUG_PREFIX}${id}`,
    genre: pack.id,
    seed: buildAutoSeedV3(pack, { ordinal: counts.get(pack.id) ?? 0, keywords }),
    flow: 'v3',
    v3: { length: len, target_cjk: cfg.lengths[len].targetCjk },
    start: true,
  });
  const row = await bookBySlug(deps, created.slug);
  await deps.db.insert(bookEvents).values({ bookId: row.id, kind: AUTO_EVENT, body: { genre: pack.id, flow: 'v3', length: len, keywords } });
  deps.log.info({ slug: created.slug, genre: pack.id, length: len }, 'auto-start: v3 book created');
  return created.slug;
}


export function createAutoStarter(deps: AppDeps): LeaderHook {
  let nextAt = 0;
  return async (now, settings) => {
    if (now.getTime() < nextAt) return;
    nextAt = now.getTime() + CHECK_INTERVAL_MS;
    await nameAutoBooks(deps);
    if (!settings.autoStart.enabled) return;
    try {
      await maybeStartBook(deps, now, settings);
    } catch (err) {
      nextAt = now.getTime() + FAILURE_BACKOFF_MS;
      deps.log.error({ err: (err as Error).message }, 'auto-start: create failed, backing off');
    }
  };
}
