/**
 * 旧书（P3 D1）：导入的、或旧流程写的书。判定只有一个：books.meta.v3 是 JSON 对象 = v3 书，否则是旧书。
 * 调度、列表、筛选一律按数据库判定；book.yaml 的 flow 只用于开机报告和“接手”的前提检查。
 * 另外：旧书的卷标题从 plan/volumes/*.yaml 回填到 chapters.volume_title（读者端、导出不再读 YAML）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { parse as yamlParse } from 'yaml';
import type { DataPaths } from '../config/index.js';
import type { Db } from '../db/client.js';
import { books, chapters } from '../db/schema.js';
import { P } from './layout.js';
import { openRepo, type BookRepo } from './repo.js';

/** meta.v3 是 JSON 对象（不是 null、不是数组） */
export const isV3Meta = (meta: unknown): boolean => {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const v3 = (meta as { v3?: unknown }).v3;
  return !!v3 && typeof v3 === 'object' && !Array.isArray(v3);
};

/** 同一条规则的 SQL 写法（tick、claimNext、自动开书、开机迁移、筛选用） */
export const V3_BOOK_SQL: SQL = sql`jsonb_typeof(${books.meta}->'v3') = 'object'`;

/** 只读 book.yaml 的 flow（yaml.parse，不过 zod）。'invalid' = 文件在但解析不了；'missing' = 目录或文件不在 */
export async function readFlowTolerant(bookDir: string): Promise<'v3' | 'legacy' | 'invalid' | 'missing'> {
  let text: string;
  try {
    text = await fs.readFile(path.join(bookDir, P.bookYaml), 'utf8');
  } catch {
    return 'missing';
  }
  let doc: unknown;
  try {
    doc = yamlParse(text);
  } catch {
    return 'invalid';
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'invalid';
  return (doc as { flow?: unknown }).flow === 'v3' ? 'v3' : 'legacy';
}

export interface VolumeIndexEntry {
  id: string;
  title: string;
  from: number | null;
  to: number | null;
}

const chapterNumber = (v: unknown): number | null => {
  const m = /c?(\d+)/.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
};

/**
 * live 仓库 HEAD 上的 plan/volumes/*.yaml。每个文件单独解析（坏的、不是对象的跳过）；id = doc.id ?? 文件名；
 * title 可能为空；chapters: [cA, cB] → 章号区间，别的写法 → null。仓库读不了（目录不在、没有 HEAD、git 出错）就抛错，调用方下次再试。
 */
export async function readVolumeIndex(repo: BookRepo): Promise<VolumeIndexEntry[]> {
  const head = await repo.head();
  if (!head) throw new Error('书仓库没有 HEAD（目录不在或 git 不可读）');
  const files = (await repo.list('plan/volumes', { rev: head })).filter((p) => !p.endsWith('/') && /\.ya?ml$/.test(p)).sort();
  if (files.length === 0) return [];
  const texts = repo.readMany ? await repo.readMany(files, head) : await Promise.all(files.map((f) => repo.readFile(f, head)));
  const out: VolumeIndexEntry[] = [];
  files.forEach((f, i) => {
    const text = texts[i];
    if (text == null) return;
    let doc: unknown;
    try {
      doc = yamlParse(text);
    } catch {
      return;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return;
    const d = doc as { id?: unknown; title?: unknown; chapters?: unknown };
    const stem = path.posix.basename(f).replace(/\.ya?ml$/, '');
    const id = typeof d.id === 'string' && d.id.trim() ? d.id.trim() : stem;
    const title = String(d.title ?? '').trim();
    const range = Array.isArray(d.chapters) && d.chapters.length === 2 ? [chapterNumber(d.chapters[0]), chapterNumber(d.chapters[1])] : [null, null];
    out.push({ id, title, from: range[0] ?? null, to: range[1] ?? null });
  });
  return out;
}

/**
 * 按行回填本书 volume_title = '' 的章节（不看流程，接手过的旧书也算）：
 *  - volume 非空 → 用同 id 卷的标题（标题非空才写）；
 *  - volume 为空 → 章号落在某卷 [from,to] 内：volume = 卷 id，volume_title = 卷标题（标题可能为空，读者端就显示 id）；
 *  - 都对不上 → 不动（从不把 id 当标题写进去）。
 * 仓库出错时抛错（readVolumeIndex）。返回改动的行数；可重复执行。
 */
export async function fillVolumeTitles(db: Db, paths: DataPaths, book: { id: string; slug: string }): Promise<number> {
  const pending = await db
    .select({ no: chapters.no })
    .from(chapters)
    .where(and(eq(chapters.bookId, book.id), eq(chapters.volumeTitle, '')))
    .limit(1);
  if (pending.length === 0) return 0;
  const entries = await readVolumeIndex(openRepo(path.join(paths.books, book.slug)));
  if (entries.length === 0) return 0;
  const nowIso = new Date().toISOString();
  let n = 0;
  await db.transaction(async (tx) => {
    // 先按区间补 volume（排在前面的卷优先），再按 volume 补标题
    for (const e of entries) {
      if (e.from === null || e.to === null) continue;
      const rows = await tx
        .update(chapters)
        .set({ volume: e.id, volumeTitle: e.title, updatedAt: nowIso })
        .where(and(eq(chapters.bookId, book.id), eq(chapters.volume, ''), eq(chapters.volumeTitle, ''), gte(chapters.no, e.from), lte(chapters.no, e.to)))
        .returning({ no: chapters.no });
      n += rows.length;
    }
    for (const e of entries) {
      if (!e.title) continue;
      const rows = await tx
        .update(chapters)
        .set({ volumeTitle: e.title, updatedAt: nowIso })
        .where(and(eq(chapters.bookId, book.id), eq(chapters.volume, e.id), eq(chapters.volumeTitle, '')))
        .returning({ no: chapters.no });
      n += rows.length;
    }
  });
  return n;
}
