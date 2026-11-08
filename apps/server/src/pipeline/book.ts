/** BookHandle 加载（books 表 + live 仓库 + book.yaml + 题材链）。Owner: lane E（F/G 也使用）。 */
import path from 'node:path';
import { eq, or } from 'drizzle-orm';
import type { Arc, Card, QualityTier, Volume } from '@novelist/shared';
import { normalizeTier } from '@novelist/shared';
import { bookFiles, openRepo } from '../book/index.js';
import { books } from '../db/schema.js';
import { loadGenre } from '../genres/index.js';
import type { BookHandle, PipelineDeps } from './types.js';

export async function openBook(deps: PipelineDeps, idOrSlug: string): Promise<BookHandle> {
  const rows = await deps.db
    .select()
    .from(books)
    .where(or(eq(books.id, idOrSlug), eq(books.slug, idOrSlug)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`book not found: ${idOrSlug}`);
  const dir = path.join(deps.paths.books, row.slug);
  const repo = openRepo(dir);
  const files = bookFiles(repo);
  const { config } = await files.config();
  const genre = await loadGenre(deps.paths, config.genre);
  return { id: row.id, slug: row.slug, dir, repo, files, config, genre, headCommit: await repo.head() };
}

const TIER_RANK = { lite: 0, standard: 1, key: 2 } as const;
type EffTier = keyof typeof TIER_RANK;

export function maxTier(a: EffTier, b: EffTier): EffTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export interface TierContext {
  card?: Card | null;
  arc?: Arc | null;
  volume?: Volume | null;
}

/** 关键章（§6.4）：第 1–3 章、card.key、最终章、弧高潮、卷首卷末 */
export function isKeyChapter(no: number, c: TierContext = {}): boolean {
  if (no >= 1 && no <= 3) return true;
  const { card, arc, volume } = c;
  if (card?.key || card?.is_final) return true;
  if (card && arc?.climax === card.id) return true;
  if (card && volume?.chapters && (volume.chapters[0] === card.id || volume.chapters[1] === card.id)) return true;
  return false;
}

/**
 * 书配置的有效 tier（卡片 tier > 关键章 tiers.key_chapters > book.tier），lean→lite 归一。
 * 关键章取 max(book.tier, tiers.key_chapters)（书整体开 key 时关键章不应更低）。
 * 不传 card 时只按章号判断关键章（路由估算用）；有 card 时结果精确。
 */
export function effectiveTier(book: BookHandle, chapterNo: number | null, c: TierContext = {}): 'lite' | 'standard' | 'key' {
  const norm = (t: QualityTier): EffTier => normalizeTier(t);
  if (c.card?.tier) return norm(c.card.tier);
  const base = norm(book.config.tier);
  if (chapterNo === null) return base;
  if (isKeyChapter(chapterNo, c)) return maxTier(base, norm(book.config.tiers.key_chapters));
  return base;
}
