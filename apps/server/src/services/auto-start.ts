/**
 * 自动开书（v1 的 auto_generate）。Owner: lane G。
 * 调度器 leader 每轮调用：有空位时按“已有书数 / 权重”最小挑一个题材包开书，书名先占位，
 * 规划师在 premise 第一行给出书名后改名。默认关闭，题材内容归用户所有，这里只拼结构化的种子。
 */
import { and, count, desc, eq, gte, inArray, like, notLike } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AutoLength, GenrePack, SystemSettings } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { bookBySlug, bookDir } from '../api/helpers.js';
import { bookFiles, openRepo } from '../book/index.js';
import { bookEvents, books } from '../db/schema.js';
import { listGenres, loadGenre } from '../genres/index.js';
import type { LeaderHook } from '../orchestrator/scheduler.js';
import { AUTO_CREATED_EVENT, createBook, patchBookYaml } from './books.js';

export const AUTO_TITLE_PREFIX = '待命名·';
const AUTO_SLUG_PREFIX = 'auto-';
const AUTO_EVENT = AUTO_CREATED_EVENT;
const CHECK_INTERVAL_MS = 30_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const DAY_MS = 24 * 3600_000;
const RECENT_TITLES = 20;
const SAME_GENRE_DIGESTS = 8;

/** 加权轮转：“已有书数 / 权重”最小者胜，同分按 id，结果可复现 */
export function pickGenre(packs: Pick<GenrePack, 'id' | 'auto'>[], counts: Map<string, number>): string | null {
  const score = (p: Pick<GenrePack, 'id' | 'auto'>) => (counts.get(p.id) ?? 0) / Math.max(p.auto?.weight ?? 1, 0.01);
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

async function seedContext(deps: AppDeps, genre: string): Promise<AutoSeedContext> {
  const events = await deps.db.select({ body: bookEvents.body }).from(bookEvents).where(eq(bookEvents.kind, AUTO_EVENT));
  const rows = await deps.db
    .select({ slug: books.slug, title: books.title })
    .from(books)
    .where(and(eq(books.genre, genre), notLike(books.title, `${AUTO_TITLE_PREFIX}%`)))
    .orderBy(desc(books.createdAt))
    .limit(SAME_GENRE_DIGESTS);
  const sameGenre = await Promise.all(
    rows.map(async (r) => ({
      title: r.title,
      digest: premiseDigest(await bookFiles(openRepo(bookDir(deps, r.slug))).premise().catch(() => '')),
    })),
  );
  return { ordinal: events.filter((e) => e.body.genre === genre).length, sameGenre };
}

/** 条件满足就开一本书，返回新书 slug；一轮最多开一本 */
export async function maybeStartBook(deps: AppDeps, now: Date, s: SystemSettings): Promise<string | null> {
  const cfg = s.autoStart;
  const [active] = await deps.db
    .select({ n: count() })
    .from(books)
    .where(inArray(books.status, ['planning', 'active']));
  if (Number(active?.n ?? 0) >= cfg.maxActiveBooks) return null;
  if (cfg.maxPerDay > 0) {
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const [today] = await deps.db.select({ n: count() }).from(bookEvents).where(and(eq(bookEvents.kind, AUTO_EVENT), gte(bookEvents.ts, since)));
    if (Number(today?.n ?? 0) >= cfg.maxPerDay) return null;
  }

  // 上次开书卡在 startBook（比如题材包损坏）：先重试它，不再造新书
  const [orphan] = await deps.db
    .select({ id: books.id, slug: books.slug, genre: books.genre })
    .from(books)
    .where(and(eq(books.status, 'draft'), like(books.slug, `${AUTO_SLUG_PREFIX}%`), like(books.title, `${AUTO_TITLE_PREFIX}%`)))
    .limit(1);
  if (orphan) {
    await deps.orchestrator.startBook(orphan.id, { interview: false });
    await deps.db.insert(bookEvents).values({ bookId: orphan.id, kind: AUTO_EVENT, body: { genre: orphan.genre } });
    return orphan.slug;
  }

  const packs = (await listGenres(deps.paths)).filter((p) => (cfg.genres ? cfg.genres.includes(p.id) : p.auto?.enabled === true) && (p.auto?.weight ?? 1) > 0);
  // v1 的教训：没有题材就不开书，避免写出无关内容
  if (packs.length === 0) return null;
  const counted = await deps.db.select({ genre: books.genre, n: count() }).from(books).groupBy(books.genre);
  const genre = pickGenre(packs, new Map(counted.map((c) => [c.genre, Number(c.n)])));
  const pack = packs.find((p) => p.id === genre);
  if (!pack) return null;

  const recent = await deps.db.select({ title: books.title }).from(books).where(notLike(books.title, `${AUTO_TITLE_PREFIX}%`)).orderBy(desc(books.createdAt)).limit(RECENT_TITLES);
  const chapterTarget = (await loadGenre(deps.paths, pack.id)).pacing.chapter_length.target;
  const size = autoScale(cfg.lengths[lengthClass(pack.auto?.length_hint ?? '')], pack.auto?.min_chapters ?? null, chapterTarget);
  const id = nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, '0');
  const created = await createBook(deps, {
    title: `${AUTO_TITLE_PREFIX}${id.slice(0, 6)}`,
    slug: `${AUTO_SLUG_PREFIX}${id}`,
    genre: pack.id,
    seed: buildAutoSeed(pack, recent.map((r) => r.title), await seedContext(deps, pack.id)),
    tier: s.defaultTier,
    interview: false,
    start: true,
    scale: size,
  });
  const row = await bookBySlug(deps, created.slug);
  await deps.db.insert(bookEvents).values({ bookId: row.id, kind: AUTO_EVENT, body: { genre: pack.id } });
  deps.log.info({ slug: created.slug, genre: pack.id }, 'auto-start: book created');
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
