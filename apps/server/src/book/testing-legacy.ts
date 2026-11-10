/**
 * 测试用：造一本“旧书”（P3 legacy）。和约 130 本导入书同一个样子：旧布局（initBookRepo layout 'legacy'）、
 * book.yaml 没有 flow、带旧键（tier / scale / approvals）、plan/volumes/vNN.yaml（v1 导入写的骨架）、manuscript/cNNNNN.md、notes/v1/。
 * 数据库：books 行（默认 paused / import，meta.v1），chapters 行带 volume、volume_title 为空。只在测试里用（不从 book/index.ts 导出）。
 */
import path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { countCjk, tags } from '@novelist/shared';
import type { DataPaths } from '../config/index.js';
import type { Db } from '../db/client.js';
import { books, chapters } from '../db/schema.js';
import { P } from './layout.js';
import { initBookRepo } from './repo.js';

export interface LegacyBookOpts {
  /** 正文章数（默认 3） */
  chapters?: number;
  /** 卷：给了 extra 就照 extra 写（不带 schema，可以没有 title）；否则按 v1 导入的骨架写 */
  volumes?: { id: string; title?: string; from: number; to: number; extra?: Record<string, unknown> }[];
  status?: string;
  pausedReason?: string | null;
  /** 已发布到第几章（默认全部） */
  published?: number;
  /** meta.v1（默认 true） */
  v1?: boolean;
  /** 额外的书库文件（原样写入并提交） */
  files?: Record<string, string>;
  /** 追加到 book.yaml 末尾的原文（旧键、坏键都行；不过 zod） */
  bookYamlExtra?: string;
  genre?: string;
  title?: string;
}

export const legacyChapterText = (no: number): string => `第${no}章 旧事\n\n这是第${no}章的正文，从旧系统导入。林枫站在山门前，看着远处的云。\n`;

const cid = (no: number): string => `c${String(no).padStart(5, '0')}`;

export async function createLegacyBook(db: Db, paths: DataPaths, slug: string, opts: LegacyBookOpts = {}): Promise<{ id: string; dir: string }> {
  const dir = path.join(paths.books, slug);
  const n = opts.chapters ?? 3;
  const genre = opts.genre ?? 'xianxia';
  const title = opts.title ?? `旧书 ${slug}`;
  const volumes = opts.volumes ?? [{ id: 'v01', title: '第一卷', from: 1, to: Math.max(1, n) }];
  const { repo } = await initBookRepo(dir, {
    config: { slug, title, genre, tier: 'standard', scale: { target_cjk: 1_000_000, hard_max_cjk: 1_500_000, volumes: [1, 3], chapters_per_volume: [50, 80] }, approvals: { compass: { required: false } } } as never,
    premise: `# 《${title}》\n\n旧系统的设想。\n`,
    layout: 'legacy',
  });
  const files: { path: string; content: string }[] = [];
  for (const v of volumes) {
    const range = [cid(v.from), cid(v.to)];
    const doc = v.extra
      ? { id: v.id, ...(v.title !== undefined ? { title: v.title } : {}), chapters: range, ...v.extra }
      : { schema: 'nv.volume/1', id: v.id, title: v.title ?? '', detail: 'skeleton', goal: '', novelty: [], milestones_due: [], chapters: range, arcs: [] };
    files.push({ path: P.volume(v.id), content: yamlStringify(doc, { lineWidth: 0 }) });
  }
  for (let i = 1; i <= n; i += 1) files.push({ path: P.manuscript(i), content: legacyChapterText(i) });
  files.push({ path: 'notes/v1/bible.json', content: '{\n  "人物": ["林枫"]\n}\n' });
  for (const [p, content] of Object.entries(opts.files ?? {})) files.push({ path: p, content });
  await repo.writeFiles(files);
  if (opts.bookYamlExtra) {
    const raw = (await repo.readFile(P.bookYaml)) ?? '';
    await repo.writeFiles([{ path: P.bookYaml, content: `${raw}${raw.endsWith('\n') ? '' : '\n'}${opts.bookYamlExtra}` }]);
  }
  const head = await repo.commit({ message: `import: legacy fixture (${n} chapters)`, trailers: { 'Novelist-Task': 'import.v1' } });
  const published = opts.published ?? n;
  for (let i = 1; i <= n; i += 1) {
    await repo.tag(tags.chapter(i), head);
    if (i <= published) await repo.tag(tags.published(i), head);
  }
  const id = `book-${slug}`;
  const nowIso = new Date().toISOString();
  const volumeOf = (no: number) => volumes.find((v) => no >= v.from && no <= v.to)?.id ?? '';
  let total = 0;
  for (let i = 1; i <= n; i += 1) total += countCjk(legacyChapterText(i), 'han');
  await db.insert(books).values({
    id,
    slug,
    title,
    genre,
    status: opts.status ?? 'paused',
    pausedReason: opts.pausedReason === undefined ? 'import' : opts.pausedReason,
    headCommit: head,
    acceptedThrough: n,
    auditedThrough: n,
    publishedThrough: published,
    cursor: n + 1,
    totalCjk: total,
    meta: opts.v1 === false ? {} : { v1: { id: 7, slug, status: 'ongoing' }, blurb: '旧系统的简介' },
  });
  for (let i = 1; i <= n; i += 1) {
    await db.insert(chapters).values({
      bookId: id,
      no: i,
      chapterId: cid(i),
      title: `第${i}章`,
      volume: volumeOf(i),
      state: 'accepted',
      cjk: countCjk(legacyChapterText(i), 'han'),
      acceptedCommit: head,
      acceptedAt: nowIso,
      audited: true,
      ...(i <= published ? { publishedAt: nowIso } : {}),
    });
  }
  return { id, dir };
}
