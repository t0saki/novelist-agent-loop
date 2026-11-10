/** BookHandle 加载（books 表 + live 仓库 + book.yaml + 题材链）。 */
import path from 'node:path';
import { eq, or } from 'drizzle-orm';
import type { BookConfig } from '@novelist/shared';
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
  const { config } = await bookFiles(repo).config();
  const genre = await loadGenre(deps.paths, config.genre);
  return { id: row.id, slug: row.slug, dir, repo, config, genre, headCommit: await repo.head() };
}

/** book.yaml 不是 v3 流程（旧书）。调度、列表一律以数据库的 meta.v3 为准（book/legacy.ts）；这里只看已打开的配置 */
export const isLegacyConfig = (cfg: Pick<BookConfig, 'flow'>): boolean => cfg.flow !== 'v3';
