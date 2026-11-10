/**
 * 开书任务单的书库摘要（docs/v3/DESIGN.md §8.1“多样性”；p2-plan §2.3、§5.3）。
 * 同题材全部、全站最近 20 本，每本一行：书名、一句话、标签；再附“近期用得最多的 5 个标签”。
 * 服务器只按 bible.md 第三行的原文计数，不做理解；占位书名（还没起名的书）和这本书自己不列。
 */
import { and, desc, eq, ne, notLike, sql } from 'drizzle-orm';
import { V3_TITLE_PLACEHOLDER } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { books } from '../db/schema.js';
import { parseBibleHead } from './map.js';

export interface LibraryRow {
  id: string;
  title: string;
  blurb: string | null;
  tags: string[];
  genre: string;
  createdAt: string;
}

/** auto-start 的占位书名前缀（services/auto-start.ts AUTO_TITLE_PREFIX） */
const AUTO_TITLE_PLACEHOLDER = '待命名·';
const SAME_GENRE_CAP = 100;
const RECENT_CAP = 20;
const BLURB_MAX = 60;
const TAG_MAX = 8;

const TAG_PREFIX_RE = /^\s*(?:[-*]\s*)?标签\s*[:：]\s*/u;

/** bible.md 第三行“标签：a、b，c / d” → ['a','b','c','d']（原文、去空白、丢掉空的，最多 8 个） */
export function parseTags(line: string): string[] {
  return line
    .replace(TAG_PREFIX_RE, '')
    .split(/[、，,;；/|｜]+/u)
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .slice(0, TAG_MAX);
}

/** 各行标签的原文计数：次数多的在前，同次数按字符串升序；取前 n 个 */
export function topTags(rows: Pick<LibraryRow, 'tags'>[], n = 5): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of new Set(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([t]) => t);
}

function rowOf(r: { id: string; title: string; genre: string; meta: unknown; createdAt: string }): LibraryRow {
  const meta = (r.meta ?? {}) as { blurb?: unknown; tags?: unknown };
  const blurb = typeof meta.blurb === 'string' && meta.blurb.trim() !== '' ? meta.blurb.trim() : null;
  const tags = Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()) : [];
  return { id: r.id, title: r.title, blurb, tags, genre: r.genre, createdAt: r.createdAt };
}

/** 同题材：全部（去掉占位书名和自己，新的在前，最多 100）；最近：全站最新的 20 本里不在同题材那一组的 */
export async function loadLibrary(db: Db, selfId: string, genre: string): Promise<{ sameGenre: LibraryRow[]; recent: LibraryRow[] }> {
  const named = and(
    ne(books.id, selfId),
    sql`trim(${books.title}) <> ''`,
    notLike(books.title, `${AUTO_TITLE_PLACEHOLDER}%`),
    notLike(books.title, `${V3_TITLE_PLACEHOLDER}%`),
  );
  const cols = { id: books.id, title: books.title, genre: books.genre, meta: books.meta, createdAt: books.createdAt };
  const same = await db.select(cols).from(books).where(and(named, eq(books.genre, genre))).orderBy(desc(books.createdAt), books.id).limit(SAME_GENRE_CAP);
  const latest = await db.select(cols).from(books).where(and(named, ne(books.genre, genre))).orderBy(desc(books.createdAt), books.id).limit(RECENT_CAP);
  return { sameGenre: same.map(rowOf), recent: latest.map(rowOf) };
}

/**
 * 主人存了 bible.md / reindex（v3 书）：标签按第三行更新 books.meta.tags；简介只在还没有时从“一句话”补上。
 * 解析不出标签时不动已有的标签。单条 jsonb 合并，不碰 meta.v3。
 */
export async function syncBibleMeta(db: Db, bookId: string, bible: string): Promise<void> {
  const head = parseBibleHead(bible);
  const patch: Record<string, unknown> = {};
  if (head.tags) patch.tags = head.tags;
  const tagsPatch = sql`${JSON.stringify(patch)}::jsonb`;
  const blurbPatch = head.blurb
    ? sql`case when coalesce(trim(${books.meta}->>'blurb'), '') = '' then jsonb_build_object('blurb', ${head.blurb}::text) else '{}'::jsonb end`
    : sql`'{}'::jsonb`;
  if (!head.tags && !head.blurb) return;
  await db
    .update(books)
    .set({ meta: sql`coalesce(${books.meta}, '{}'::jsonb) || ${tagsPatch} || ${blurbPatch}` })
    .where(eq(books.id, bookId));
}

const cut = (s: string): string => {
  const chars = Array.from(s);
  return chars.length > BLURB_MAX ? `${chars.slice(0, BLURB_MAX).join('')}…` : s;
};

/**
 * p2-plan §5.3。空的一节连标题一起省掉；没有简介不写“：…”，没有标签不写“｜标签：…”；
 * 标签行只在数到至少一个标签时出现（按两组里最新的 20 本计数）；两组都空时整块是 ''。
 */
export function renderLibraryV3(lib: { sameGenre: LibraryRow[]; recent: LibraryRow[] }, genreName: string): string {
  if (lib.sameGenre.length === 0 && lib.recent.length === 0) return '';
  const lines = ['书库摘要（不要和这些书雷同）：'];
  if (lib.sameGenre.length) {
    lines.push(`同题材（${genreName}）：`);
    for (const r of lib.sameGenre) lines.push(`- 《${r.title}》${r.blurb ? `：${cut(r.blurb)}` : ''}${r.tags.length ? `｜标签：${r.tags.join('、')}` : ''}`);
  }
  if (lib.recent.length) {
    lines.push('最近的书：');
    for (const r of lib.recent) lines.push(`- 《${r.title}》${r.blurb ? `：${cut(r.blurb)}` : ''}`);
  }
  const newest = [...lib.sameGenre, ...lib.recent].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, RECENT_CAP);
  const top = topTags(newest);
  if (top.length) lines.push(`近期用得最多的标签（这本尽量避开）：${top.join('、')}`);
  return `${lines.join('\n')}\n`;
}
