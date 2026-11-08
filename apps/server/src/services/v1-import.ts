/**
 * v1 导入（DESIGN §11；D3）：从 NOVELIST_V1_DATABASE_URL（同一 Postgres 上的旧库 "novelist"）读取 v1 表，写入 v2。
 * v1 schema 见 legacy/v1/server/app/db/models.py：themes、novels、chapters、reader_passwords、reading_progress、settings、llm_profiles…
 * 映射：
 * - themes → 题材包（$DATA/genres/<pinyin-slug>，style_prompt 进 AGENTS.md，原 nsfw/关键词等元数据原样进 pack.meta）
 * - novels → 书仓库（book.yaml、bible/premise.md ← premise+synopsis、plan/volumes 从 v1 volumes 转换，其余半结构化数据保留到 notes/v1/）
 * - chapters(status=done) → manuscript/cNNNNN.md + chapters 索引；其余状态默认丢弃（报告列出），includeDrafts 时存到 notes/v1/drafts/
 * - 已完结书 archived 只读、未完结 paused
 * - reader_passwords → readers（pw_hash 原样保留 pbkdf2$…，legacy=true；首次登录重 hash 并建立 lookup_id）
 * - reading_progress → reading_progress（reader_id "reader:<id>" → 新读者；chapter_index → no）
 * 幂等：v1_import_map 记录映射，重复导入跳过已导入项；未写入映射的半成品（上次中断）先清理再重来。Owner: lane G。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { V1ImportJob, V1ImportPreview } from '@novelist/shared';
import { countCjk, tags, volumeId, zGenrePack, zVolume } from '@novelist/shared';
import type { z } from 'zod';
import type { zV1ImportRequest } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { initBookRepo, openRepo, P, TRAILER } from '../book/index.js';
import { books, chapters, importJobs, readers, readingProgress, v1ImportMap } from '../db/schema.js';
import { createGenre, genreExists } from '../genres/index.js';
import { bookDir } from '../api/helpers.js';
import { HttpProblem, badRequest, conflict } from '../api/problem.js';
import { enqueueSpec, execEnv } from '../orchestrator/index.js';
import { openBook } from '../pipeline/index.js';
import { makeSlug } from './books.js';

export type V1ImportRequest = z.infer<typeof zV1ImportRequest>;

interface V1Theme {
  id: number;
  name: string;
  keywords: unknown;
  style_prompt: string;
  length_hint: string;
  min_chapters: number | null;
  weight: number;
  nsfw: boolean;
  enabled: boolean;
}

interface V1Novel {
  id: number;
  slug: string;
  title: string;
  status: string;
  theme_id: number | null;
  theme_name: string;
  language: string;
  nsfw: boolean;
  premise: string;
  synopsis: string;
  tone: string;
  target_audience: string;
  planned_chapters: number;
  target_chapter_words: number;
  volumes: unknown;
  bible: unknown;
  outline: unknown;
  rolling_summary: string;
  quality_debt: unknown;
  word_count: number;
  cover_path: string | null;
  updated_at: Date;
  completed_at: Date | null;
}

interface V1Chapter {
  id: number;
  novel_id: number;
  index: number;
  title: string;
  content: string;
  word_count: number;
  summary: string;
  status: string;
  updated_at: Date;
}

function normalizeV1Url(url: string): string {
  return url.replace(/^postgresql\+\w+:/, 'postgresql:');
}

/** v1 库的最小客户端接口（pg.Client 满足；测试注入 PGlite） */
export interface V1Client {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export type V1Connect = (url: string) => Promise<V1Client>;

const connectPg: V1Connect = async (url) => {
  // 机制上保证只读：连接级 default_transaction_read_only + 断言（v1 是生产库）
  const client = new pg.Client({ connectionString: normalizeV1Url(url), options: '-c default_transaction_read_only=on' });
  await client.connect();
  const show = await client.query<{ transaction_read_only: string }>('show transaction_read_only');
  if (show.rows[0]?.transaction_read_only !== 'on') {
    await client.end().catch(() => {});
    throw new Error('v1 数据库连接未能进入只读模式，已拒绝导入');
  }
  return client as unknown as V1Client;
};

async function withV1<T>(url: string, connect: V1Connect, fn: (c: V1Client) => Promise<T>): Promise<T> {
  const client = await connect(url);
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function redactUrl(url: string): string {
  try {
    const u = new URL(normalizeV1Url(url));
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid url>';
  }
}

export async function previewV1(url: string, opts?: { connect?: V1Connect }): Promise<V1ImportPreview> {
  const source = redactUrl(url);
  try {
    return await withV1(url, opts?.connect ?? connectPg, async (c) => {
      const novels = await c.query<{ id: number; slug: string; title: string; status: string; word_count: number; theme_name: string; total: string; done: string }>(
        `select n.id, n.slug, n.title, n.status, n.word_count, n.theme_name,
                count(c.id) as total, count(c.id) filter (where c.status = 'done') as done
         from novels n left join chapters c on c.novel_id = n.id
         group by n.id order by n.id`,
      );
      const themes = await c.query<{ id: number; name: string }>('select id, name from themes order by id');
      const readerCount = await c.query<{ n: string }>('select count(*) as n from reader_passwords');
      const progress = await c.query<{ n: string }>('select count(*) as n from reading_progress');
      return {
        source,
        ok: true,
        novels: novels.rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, status: r.status, chapters: Number(r.total), doneChapters: Number(r.done), words: r.word_count, theme: r.theme_name })),
        themes: themes.rows,
        readers: Number(readerCount.rows[0]?.n ?? 0),
        progressRows: Number(progress.rows[0]?.n ?? 0),
      };
    });
  } catch (e) {
    return { source, ok: false, error: (e as Error).message, novels: [], themes: [], readers: 0, progressRows: 0 };
  }
}

const jobView = (row: typeof importJobs.$inferSelect): V1ImportJob => ({
  id: row.id,
  state: row.state as V1ImportJob['state'],
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  log: row.log,
  report: row.report as V1ImportJob['report'],
});

export async function getV1Job(deps: AppDeps, id: string): Promise<V1ImportJob> {
  const rows = await deps.db.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
  if (!rows[0]) throw new HttpProblem(404, 'not_found', '导入任务不存在');
  return jobView(rows[0]);
}

export async function startV1Import(deps: AppDeps, req: V1ImportRequest, opts?: { wait?: boolean; connect?: V1Connect }): Promise<V1ImportJob> {
  const url = req.databaseUrl ?? deps.config.v1DatabaseUrl;
  if (!url) throw badRequest('缺少 v1 数据库地址（NOVELIST_V1_DATABASE_URL 或 databaseUrl）');
  const running = await deps.db.select({ id: importJobs.id }).from(importJobs).where(and(eq(importJobs.kind, 'v1'), eq(importJobs.state, 'running'))).limit(1);
  if (running[0]) throw conflict('已有导入任务在进行', 'import_running');
  const id = randomUUID();
  const { databaseUrl: _omit, ...safeRequest } = req;
  void _omit;
  await deps.db.insert(importJobs).values({ id, kind: 'v1', state: 'running', request: { ...safeRequest, source: redactUrl(url) } });
  const run = runImport(deps, id, url, req, opts?.connect ?? connectPg)
    .then(async (report) => {
      await deps.db.update(importJobs).set({ state: 'done', report, endedAt: new Date().toISOString() }).where(eq(importJobs.id, id));
    })
    .catch(async (e: Error) => {
      deps.log.error({ err: e.message, job: id }, 'v1 import failed');
      await appendLog(deps, id, `导入失败：${e.message}`);
      await deps.db.update(importJobs).set({ state: 'failed', endedAt: new Date().toISOString() }).where(eq(importJobs.id, id));
    });
  if (opts?.wait) await run;
  return getV1Job(deps, id);
}

async function appendLog(deps: Pick<AppDeps, 'db'>, jobId: string, line: string): Promise<void> {
  const rows = await deps.db.select({ log: importJobs.log }).from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
  await deps.db.update(importJobs).set({ log: [...(rows[0]?.log ?? []), `${new Date().toISOString()} ${line}`] }).where(eq(importJobs.id, jobId));
}

const jsonOf = <T>(v: unknown, fallback: T): T => {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return (v ?? fallback) as T;
};

async function mapped(deps: Pick<AppDeps, 'db'>, kind: string, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await deps.db.select().from(v1ImportMap).where(and(eq(v1ImportMap.kind, kind), inArray(v1ImportMap.v1Id, ids)));
  return new Map(rows.map((r) => [r.v1Id, r.v2Id]));
}

async function setMapped(deps: Pick<AppDeps, 'db'>, kind: string, v1Id: number, v2Id: string): Promise<void> {
  await deps.db.insert(v1ImportMap).values({ kind, v1Id, v2Id }).onConflictDoUpdate({ target: [v1ImportMap.kind, v1ImportMap.v1Id], set: { v2Id } });
}

async function importThemes(deps: AppDeps, jobId: string, c: V1Client, usedIds: Set<number>, all: boolean): Promise<{ themeGenre: Map<number, string>; created: string[] }> {
  const rows = (await c.query<V1Theme>('select * from themes order by id')).rows;
  const already = await mapped(deps, 'theme', rows.map((r) => r.id));
  const themeGenre = new Map(already);
  const created: string[] = [];
  const taken = new Set<string>();
  const { slugifyName } = await import('../state/ids.js');
  for (const theme of rows) {
    if (themeGenre.has(theme.id) || (!all && !usedIds.has(theme.id))) continue;
    let id = slugifyName(theme.name, taken).replace(/[^a-z0-9-]/g, '-');
    if (!/^[a-z0-9]/.test(id)) id = `v1-${id}`;
    while (await genreExists(deps.paths, id)) id = `${id}-${nanoid(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    taken.add(id);
    await createGenre(deps.paths, { id, name: theme.name, extends: [] });
    const dir = path.join(deps.paths.genres, id);
    const pack = zGenrePack.parse(yamlParse(await fs.readFile(path.join(dir, 'pack.yaml'), 'utf8')));
    pack.meta = { v1: { id: theme.id, keywords: jsonOf(theme.keywords, []), length_hint: theme.length_hint, min_chapters: theme.min_chapters, weight: theme.weight, nsfw: theme.nsfw, enabled: theme.enabled } };
    await fs.writeFile(path.join(dir, 'pack.yaml'), yamlStringify(pack, { lineWidth: 0 }), 'utf8');
    if (theme.style_prompt) await fs.appendFile(path.join(dir, 'AGENTS.md'), `\n${theme.style_prompt}\n`, 'utf8');
    themeGenre.set(theme.id, id);
    await setMapped(deps, 'theme', theme.id, id);
    created.push(id);
  }
  if (created.length) {
    const repo = openRepo(deps.paths.genres);
    await repo.commit({ message: `genres: import v1 themes (${created.join(', ')})`, trailers: { [TRAILER.task]: 'import.v1' } }).catch(() => {});
    await appendLog(deps, jobId, `题材包：新增 ${created.join('、')}`);
  }
  return { themeGenre, created };
}

/** 兜底题材包（v1 书没有主题时用，保证“无题材不立项”不被导入绕开） */
async function fallbackGenre(deps: AppDeps): Promise<string> {
  const id = 'v1-imported';
  if (!(await genreExists(deps.paths, id))) await createGenre(deps.paths, { id, name: 'v1 导入（未分类）', extends: [] });
  return id;
}

interface VolumePlan {
  id: string;
  title: string;
  from: number;
  to: number;
}

function planVolumes(raw: unknown, totalChapters: number): VolumePlan[] {
  const entries = jsonOf<{ title?: unknown; chapter_count?: unknown }[]>(raw, []);
  const out: VolumePlan[] = [];
  let next = 1;
  if (Array.isArray(entries)) {
    entries.forEach((v, i) => {
      const n = Number(v?.chapter_count ?? 0);
      if (!Number.isFinite(n) || n <= 0 || next > totalChapters) return;
      out.push({ id: volumeId(i + 1), title: String(v?.title ?? `第${i + 1}卷`), from: next, to: Math.min(totalChapters, next + n - 1) });
      next += n;
    });
  }
  if (out.length === 0) return [{ id: volumeId(1), title: '正文', from: 1, to: Math.max(1, totalChapters) }];
  const last = out[out.length - 1] as VolumePlan;
  if (last.to < totalChapters) last.to = totalChapters;
  return out;
}

async function copyCover(deps: AppDeps, slug: string, coverPath: string | null): Promise<boolean> {
  if (!coverPath || !deps.config.v1DataDir) return false;
  const rel = coverPath.replace(/^\/+/, '').replace(/^data\//, '');
  const candidates = [path.join(deps.config.v1DataDir, rel), path.join(deps.config.v1DataDir, path.basename(coverPath))];
  for (const src of candidates) {
    if (!path.resolve(src).startsWith(path.resolve(deps.config.v1DataDir))) continue;
    const bytes = await fs.readFile(src).catch(() => null);
    if (!bytes) continue;
    const ext = path.extname(coverPath).toLowerCase() || '.png';
    await fs.mkdir(path.join(deps.paths.media, slug), { recursive: true });
    await fs.writeFile(path.join(deps.paths.media, slug, `cover${ext}`), bytes);
    return true;
  }
  return false;
}

async function importNovel(deps: AppDeps, jobId: string, c: V1Client, novel: V1Novel, genre: string, req: V1ImportRequest): Promise<{ slug: string; chapters: number; dropped: number }> {
  const chapterRows = (await c.query<V1Chapter>('select id, novel_id, index, title, content, word_count, summary, status, updated_at from chapters where novel_id = $1 order by index', [novel.id])).rows;
  const done = chapterRows.filter((r) => r.status === 'done' && r.content.trim() !== '');
  const others = chapterRows.filter((r) => r.status !== 'done' && r.content.trim() !== '');

  // 上次中断的半成品：v1_id 指向它但映射未落
  const stale = await deps.db.select().from(books).where(eq(books.v1Id, novel.id)).limit(1);
  if (stale[0]) {
    await appendLog(deps, jobId, `《${novel.title}》上次导入未完成，清理后重来`);
    await deps.db.delete(books).where(eq(books.id, stale[0].id));
    await fs.rm(bookDir(deps, stale[0].slug), { recursive: true, force: true });
  }

  const wanted = novel.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const slugTaken = !/^[a-z0-9]/.test(wanted) || (await deps.db.select({ id: books.id }).from(books).where(eq(books.slug, wanted)).limit(1))[0] || (await fs.stat(bookDir(deps, wanted)).then(() => true, () => false));
  const slug = slugTaken ? await makeSlug(deps, novel.title || wanted || 'v1-book') : wanted;

  const totalChapters = Math.max(novel.planned_chapters ?? 0, chapterRows.length ? (chapterRows[chapterRows.length - 1] as V1Chapter).index : 0, 1);
  const premise = [novel.premise, novel.synopsis && `## 简介\n\n${novel.synopsis}`, novel.tone && `基调：${novel.tone}`, novel.target_audience && `读者：${novel.target_audience}`].filter(Boolean).join('\n\n');
  const { repo } = await initBookRepo(bookDir(deps, slug), { config: { slug, title: novel.title || slug, genre, ...(novel.synopsis ? { blurb: novel.synopsis.slice(0, 500) } : {}) } as never, premise });

  const volumes = planVolumes(novel.volumes, totalChapters);
  const volumeOf = (no: number) => volumes.find((v) => no >= v.from && no <= v.to) ?? (volumes[volumes.length - 1] as VolumePlan);
  const files: { path: string; content: string }[] = [];
  for (const v of volumes) {
    const parsed = zVolume.safeParse({ schema: 'nv.volume/1', id: v.id, title: v.title, detail: 'skeleton', chapters: [`c${String(v.from).padStart(5, '0')}`, `c${String(v.to).padStart(5, '0')}`] });
    if (parsed.success) files.push({ path: P.volume(v.id), content: yamlStringify(parsed.data, { lineWidth: 0 }) });
  }
  for (const ch of done) files.push({ path: P.manuscript(ch.index), content: ch.content });
  files.push({ path: 'notes/v1/bible.json', content: `${JSON.stringify(jsonOf(novel.bible, {}), null, 2)}\n` });
  files.push({ path: 'notes/v1/outline.json', content: `${JSON.stringify(jsonOf(novel.outline, {}), null, 2)}\n` });
  files.push({ path: 'notes/v1/quality_debt.json', content: `${JSON.stringify(jsonOf(novel.quality_debt, []), null, 2)}\n` });
  files.push({ path: 'notes/v1/volumes.json', content: `${JSON.stringify(jsonOf(novel.volumes, []), null, 2)}\n` });
  if (novel.rolling_summary) files.push({ path: 'notes/v1/rolling_summary.md', content: novel.rolling_summary });
  files.push({ path: 'notes/v1/chapter-summaries.json', content: `${JSON.stringify(Object.fromEntries(done.map((c) => [c.index, c.summary])), null, 2)}\n` });
  if (req.includeDrafts) for (const ch of others) files.push({ path: `notes/v1/drafts/c${String(ch.index).padStart(5, '0')}.md`, content: ch.content });

  await repo.writeFiles(files);
  const commit = await repo.commit({ message: `import: v1 novel #${novel.id} (${done.length} chapters)`, trailers: { [TRAILER.task]: 'import.v1' } });

  const bookId = randomUUID();
  const archived = novel.status === 'completed' || novel.status === 'archived';
  const nowIso = new Date().toISOString();
  let acceptedThrough = 0;
  for (const ch of done) {
    if (ch.index === acceptedThrough + 1) acceptedThrough = ch.index;
  }
  const publishedAt = (d: Date) => new Date(d).toISOString();
  const cjkOf = new Map(done.map((c) => [c.index, countCjk(c.content, 'han')]));
  const totalCjk = [...cjkOf.values()].reduce((a, b) => a + b, 0);
  const coverCopied = await copyCover(deps, slug, novel.cover_path).catch(() => false);

  await deps.db.transaction(async (tx) => {
    await tx.insert(books).values({
      id: bookId,
      slug,
      title: novel.title || slug,
      genre,
      status: archived ? 'archived' : 'paused',
      pausedReason: archived ? null : 'import',
      cursor: acceptedThrough + 1,
      acceptedThrough,
      auditedThrough: acceptedThrough,
      publishedThrough: acceptedThrough,
      totalCjk,
      headCommit: commit,
      v1Id: novel.id,
      archivedAt: archived ? nowIso : null,
      meta: { v1: { id: novel.id, slug: novel.slug, status: novel.status, nsfw: novel.nsfw, theme: novel.theme_name, language: novel.language, cover: coverCopied }, blurb: novel.synopsis.slice(0, 500) },
    });
    for (const ch of done) {
      await tx.insert(chapters).values({
        bookId,
        no: ch.index,
        chapterId: `c${String(ch.index).padStart(5, '0')}`,
        title: ch.title || `第${ch.index}章`,
        volume: volumeOf(ch.index).id,
        state: 'accepted',
        cjk: cjkOf.get(ch.index) ?? 0,
        acceptedCommit: commit,
        acceptedAt: publishedAt(ch.updated_at),
        audited: true,
        publishedAt: publishedAt(ch.updated_at),
      });
    }
  });
  for (const ch of done) {
    await repo.tag(tags.chapter(ch.index), commit);
    await repo.tag(tags.published(ch.index), commit);
  }
  await setMapped(deps, 'novel', novel.id, bookId);
  await appendLog(deps, jobId, `《${novel.title}》→ ${slug}：${done.length} 章（丢弃未完成 ${others.length} 章）`);

  if (req.bootstrapExtract && !archived && done.length > 0) {
    await enqueueBootstrap(deps, bookId, done.map((d) => d.index));
    await appendLog(deps, jobId, `《${novel.title}》已排入 import.bootstrap（每批 5 章）`);
  }
  return { slug, chapters: done.length, dropped: req.includeDrafts ? 0 : others.length };
}

async function enqueueBootstrap(deps: AppDeps, bookId: string, nos: number[]): Promise<void> {
  const env = execEnv({ db: deps.db, config: deps.config, paths: deps.paths, log: deps.log, bus: deps.bus, secrets: deps.secrets, owner: 'v1-import' });
  const book = await openBook(env.pdeps, bookId);
  const ctx = { deps: env.pdeps, book };
  for (let i = 0; i < nos.length; i += 5) {
    const batch = nos.slice(i, i + 5);
    const from = batch[0] as number;
    const to = batch[batch.length - 1] as number;
    await enqueueSpec(env, ctx, { kind: 'import.bootstrap', bookId, target: `c${String(from).padStart(5, '0')}-c${String(to).padStart(5, '0')}`, lane: 'side', params: { from, to, chapters: batch } });
  }
}

async function importReaders(deps: AppDeps, jobId: string, c: V1Client): Promise<number> {
  const rows = (await c.query<{ id: number; label: string; password_hash: string; enabled: boolean }>('select id, label, password_hash, enabled from reader_passwords order by id')).rows;
  const already = await mapped(deps, 'reader', rows.map((r) => r.id));
  let n = 0;
  for (const r of rows) {
    if (already.has(r.id)) continue;
    const id = randomUUID();
    await deps.db.insert(readers).values({ id, label: r.label, lookupId: null, pwHash: r.password_hash, enabled: r.enabled, legacy: true, v1Id: r.id });
    await setMapped(deps, 'reader', r.id, id);
    n += 1;
  }
  await appendLog(deps, jobId, `读者：新增 ${n}，跳过 ${rows.length - n}`);
  return n;
}

async function importProgress(deps: AppDeps, jobId: string, c: V1Client, novelIds: number[]): Promise<void> {
  if (novelIds.length === 0) return;
  const rows = (await c.query<{ reader_id: string; novel_id: number; chapter_index: number; scroll: number; updated_at: Date }>('select reader_id, novel_id, chapter_index, scroll, updated_at from reading_progress where novel_id = any($1)', [novelIds])).rows;
  const readerMap = new Map((await deps.db.select().from(v1ImportMap).where(eq(v1ImportMap.kind, 'reader'))).map((r) => [r.v1Id, r.v2Id]));
  const bookMap = await mapped(deps, 'novel', novelIds);
  let n = 0;
  for (const r of rows) {
    const bookId = bookMap.get(r.novel_id);
    const m = /^reader:(\d+)$/.exec(r.reader_id);
    const readerId = m ? readerMap.get(Number(m[1])) : r.reader_id === 'admin' ? 'admin' : undefined;
    if (!bookId || !readerId) continue;
    await deps.db.insert(readingProgress).values({ readerId, bookId, no: r.chapter_index, scroll: r.scroll, updatedAt: new Date(r.updated_at).toISOString() }).onConflictDoNothing();
    n += 1;
  }
  await appendLog(deps, jobId, `阅读进度：写入 ${n} 条`);
}

async function runImport(deps: AppDeps, jobId: string, url: string, req: V1ImportRequest, connect: V1Connect): Promise<NonNullable<V1ImportJob['report']>> {
  return withV1(url, connect, async (c) => {
    const novels = (await c.query<V1Novel>('select * from novels order by id')).rows.filter((n) => req.novels === 'all' || req.novels.includes(n.id));
    await appendLog(deps, jobId, `开始导入：${novels.length} 本书`);
    const genres = new Set<string>();
    const themeIds = new Set(novels.map((n) => n.theme_id).filter((t): t is number => t !== null));
    const { themeGenre, created } = await importThemes(deps, jobId, c, themeIds, req.themes);
    for (const g of created) genres.add(g);
    const done = await mapped(deps, 'novel', novels.map((n) => n.id));
    const report: NonNullable<V1ImportJob['report']> = { books: [], readers: 0, genres: [] };
    for (const novel of novels) {
      if (done.has(novel.id)) {
        await appendLog(deps, jobId, `《${novel.title}》已导入，跳过`);
        continue;
      }
      const genre = (novel.theme_id !== null ? themeGenre.get(novel.theme_id) : undefined) ?? (await fallbackGenre(deps));
      genres.add(genre);
      report.books.push(await importNovel(deps, jobId, c, novel, genre, req));
    }
    if (req.readers) report.readers = await importReaders(deps, jobId, c);
    await importProgress(deps, jobId, c, novels.map((n) => n.id));
    report.genres = [...genres];
    await appendLog(deps, jobId, `导入完成：${report.books.length} 本书，${report.readers} 位读者`);
    return report;
  });
}
