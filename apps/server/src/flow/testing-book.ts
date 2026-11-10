/** v3 测试夹具（只在测试中使用）：在 orchestrator 测试环境里建一本 flow: v3 的书（git 仓库 + books 行 + 章节行）。 */
import path from 'node:path';
import { V3_PUBLISH_DEFAULTS, countCjk } from '@novelist/shared';
import { books, chapters } from '../db/schema.js';
import { initBookRepo, type BookRepo } from '../book/repo.js';
import type { OrchTestEnv } from '../orchestrator/testing.js';
import { emptyV3Meta } from './state.js';
import { chapterText } from './testing.js';
import type { V3BookMeta } from './types.js';

export interface V3BookOpts {
  /** 已入库的章数 */
  chapters?: number;
  published?: number;
  status?: string;
  length?: 'short' | 'medium' | 'long' | 'epic';
  planned?: number;
  batch?: number;
  minChars?: number;
  publish?: Record<string, unknown>;
  meta?: Partial<V3BookMeta>;
  extraMeta?: Record<string, unknown>;
  title?: string;
  autoTitle?: boolean;
  /** 额外写进初始提交的文件 */
  files?: Record<string, string>;
  /** 章节行的 acceptedAt（默认 now） */
  acceptedAt?: (no: number) => string;
}

export async function addV3Book(env: OrchTestEnv, slug = 'v3b', o: V3BookOpts = {}): Promise<{ id: string; dir: string; repo: BookRepo; head: string }> {
  const dir = path.join(env.paths.books, slug);
  const planned = o.planned ?? 15;
  const n = o.chapters ?? 0;
  const { repo } = await initBookRepo(dir, {
    config: {
      slug,
      title: o.title ?? `测试书 ${slug}`,
      genre: 'xianxia',
      flow: 'v3',
      v3: { length: o.length ?? 'medium', target_cjk: planned * 4000, planned_chapters: planned, planned_chapters_initial: planned, batch: o.batch ?? 5, min_chapter_cjk: o.minChars ?? 3000, auto_title: o.autoTitle ?? false },
      publish: { ...V3_PUBLISH_DEFAULTS, ...(o.publish ?? {}) },
    } as never,
    premise: '种子。\n',
  });
  const files: { path: string; content: string }[] = [
    { path: 'bible.md', content: '# 《测试书》\n一句话：一个测试用的故事。\n标签：悬疑\n' },
    { path: 'outline.md', content: `计划：共 ${planned} 章\n` },
    { path: 'notes/progress.md', content: `写到第 ${n} 章。\n` },
    { path: 'notes/chapters.md', content: Array.from({ length: n }, (_, i) => `第${i + 1}章：旧事。`).join('\n') + (n ? '\n' : '') },
    ...Array.from({ length: n }, (_, i) => ({ path: `manuscript/c${String(i + 1).padStart(5, '0')}.md`, content: chapterText(i + 1) })),
    ...Object.entries(o.files ?? {}).map(([p, content]) => ({ path: p, content })),
  ];
  await repo.writeFiles(files);
  const head = await repo.commit({ message: 'fixture: v3 book', trailers: { 'Novelist-Owner-Edit': 'true' } });
  const id = `book-${slug}`;
  const nowIso = new Date().toISOString();
  const cjk = (no: number) => countCjk(chapterText(no));
  let total = 0;
  for (let i = 1; i <= n; i += 1) total += cjk(i);
  await env.db.insert(books).values({
    id,
    slug,
    title: o.title ?? `测试书 ${slug}`,
    genre: 'xianxia',
    status: o.status ?? 'active',
    headCommit: head,
    acceptedThrough: n,
    publishedThrough: o.published ?? 0,
    cursor: n + 1,
    totalCjk: total,
    meta: { ...(o.extraMeta ?? {}), v3: { ...emptyV3Meta(), ...(o.meta ?? {}) } },
  });
  for (let i = 1; i <= n; i += 1) {
    await env.db.insert(chapters).values({ bookId: id, no: i, chapterId: `c${String(i).padStart(5, '0')}`, state: 'accepted', title: `章名${i}`, cjk: cjk(i), acceptedCommit: head, acceptedAt: o.acceptedAt?.(i) ?? nowIso, ...(i <= (o.published ?? 0) ? { publishedAt: nowIso } : {}) });
  }
  return { id, dir, repo, head };
}
