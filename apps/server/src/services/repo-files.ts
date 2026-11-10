/** 书库文件浏览 / 编辑（UI 文件树、book.yaml、影响估算）。写操作一律走 lane F 的 commitOwnerEdit。Owner: lane G。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { parse as yamlParse } from 'yaml';
import type { BookConfig, BookConfigDoc, ImpactEstimate, RepoEntry, RepoFile } from '@novelist/shared';
import { stripBeatMarkers, zBookConfig } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { bookFiles, gitBlobSha, openRepo, P, pathOwner, type BookRepo } from '../book/index.js';
import { books, chapters, tasks, usageLedger } from '../db/schema.js';
import { commitOwnerEdit } from '../orchestrator/index.js';
import { lockChapter } from '../flow/state.js';
import { syncBibleMeta } from '../flow/library.js';
import { HttpProblem, badRequest, notFound } from '../api/problem.js';
import { assertPublishConfig } from './publish-config.js';
import { setOwnerMessage } from './v3-book.js';
import { bookDir, requireRel, type BookRow } from '../api/helpers.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export async function listTree(deps: AppDeps, slug: string, dir: string | undefined): Promise<RepoEntry[]> {
  const root = bookDir(deps, slug);
  const rel = dir ? requireRel(dir) : '';
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw notFound(`目录 ${rel} `);
    throw e;
  });
  const out: RepoEntry[] = [];
  for (const e of entries) {
    if (e.name === '.git') continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    const type: RepoEntry['type'] = e.isDirectory() ? 'dir' : 'file';
    const size = type === 'file' ? (await fs.stat(path.join(root, p)).catch(() => ({ size: 0 }))).size : 0;
    out.push({ path: p, type, size, owner: pathOwner(p) });
  }
  return out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
}

export async function readRepoFile(repo: BookRepo, rawRel: string): Promise<RepoFile> {
  const rel = requireRel(rawRel);
  const abs = path.join(repo.dir, rel);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw notFound(`文件 ${rel} `);
  if (stat.size > MAX_FILE_BYTES) throw new HttpProblem(413, 'file_too_large', `文件过大（${stat.size} 字节）`);
  const content = await repo.readFile(rel);
  if (content === null) throw notFound(`文件 ${rel} `);
  return { path: rel, content, sha: gitBlobSha(content), commit: await repo.head() };
}

export async function readBookConfigDoc(repo: BookRepo): Promise<BookConfigDoc> {
  const raw = (await repo.readFile(P.bookYaml)) ?? '';
  return parseBookConfig(raw);
}

export function parseBookConfig(raw: string): BookConfigDoc {
  const sha = gitBlobSha(raw);
  let data: unknown;
  try {
    data = yamlParse(raw);
  } catch (e) {
    return { raw, parsed: null, errors: [{ path: '', message: (e as Error).message }], sha };
  }
  const r = zBookConfig.safeParse(data);
  if (!r.success) return { raw, parsed: null, errors: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })), sha };
  return { raw, parsed: r.data, errors: [], sha };
}

/** 保存 book.yaml：校验 + slug 不可改 + 同步 books 表索引字段 */
export async function saveBookConfig(deps: AppDeps, row: BookRow, repo: BookRepo, raw: string, baseSha: string): Promise<BookConfigDoc> {
  const doc = parseBookConfig(raw);
  if (!doc.parsed) throw new HttpProblem(422, 'invalid_config', 'book.yaml 校验失败', { errors: doc.errors });
  if (doc.parsed.slug !== row.slug) throw badRequest('slug 不能修改');
  assertPublishConfig(doc.parsed.publish, doc.parsed.flow === 'v3' ? { batch: doc.parsed.v3.batch } : undefined);
  await commitOwnerEdit(deps.db, repo, row.id, { files: [{ path: P.bookYaml, content: raw }], message: 'owner: edit book.yaml', baseSha });
  await syncBookIndex(deps, row.id, doc.parsed);
  return doc;
}

export async function syncBookIndex(deps: Pick<AppDeps, 'db'>, bookId: string, cfg: BookConfig): Promise<void> {
  await deps.db.update(books).set({ title: cfg.title, genre: cfg.genre, tier: cfg.tier, priority: cfg.budgets.priority, updatedAt: new Date().toISOString() }).where(eq(books.id, bookId));
}

/** v3 书（book.yaml flow: v3）：没有账本级联，手改正文只提交并锁章 */
const isV3 = (cfg: BookConfig | null): boolean => cfg?.flow === 'v3';

/** 保存前影响估算（§6.10 第 5 条）：作废的待执行任务 + 级联重跑 */
export async function estimateImpact(deps: AppDeps, row: BookRow, repo: BookRepo, rel: string): Promise<ImpactEstimate> {
  const cfg = await bookFiles(repo).config().then((c) => c.config).catch(() => null);
  const v3 = isV3(cfg);
  const liveTasks = await deps.db.select({ id: tasks.id, hard: tasks.hardManifest }).from(tasks).where(and(eq(tasks.bookId, row.id), inArray(tasks.state, ['pending', 'ready', 'waiting'])));
  const invalidated = liveTasks.filter((t) => rel in t.hard).length;
  const ms = /^manuscript\/c(\d{5})\.md$/.exec(rel) ?? /^state\/ledger\/c(\d{5})\.json$/.exec(rel);
  const notes: string[] = [];
  let affected: [number, number] | null = null;
  let affectedDeltas = 0;
  let estimatedRuns = invalidated;
  if (ms) {
    const no = Number(ms[1]);
    // v3 没有账本：不估级联重跑（否则每次保存都会多问一次确认）
    if (!v3 && no <= row.acceptedThrough) {
      affected = [no, row.acceptedThrough];
      affectedDeltas = row.acceptedThrough - no + 1;
      estimatedRuns += affectedDeltas;
      notes.push(`已验收第 ${no}–${row.acceptedThrough} 章的账本需要级联重算`);
    }
    if (no <= row.publishedThrough) notes.push('涉及已发布章节，读者端会显示修订时间');
  }
  // 单次 run 的均值：最近 200 条 run 的实测（无数据时只给 run 数）
  const samples = await deps.db.select({ util: usageLedger.utilDelta, usd: usageLedger.usd }).from(usageLedger).where(and(eq(usageLedger.bookId, row.id), gte(usageLedger.ts, new Date(Date.now() - 30 * 86400_000).toISOString()))).orderBy(desc(usageLedger.ts)).limit(200);
  const windowPct: Record<string, number> = {};
  let usd = 0;
  if (samples.length > 0 && estimatedRuns > 0) {
    const sum: Record<string, number> = {};
    let usdSum = 0;
    for (const s of samples) {
      usdSum += s.usd ?? 0;
      for (const [w, v] of Object.entries(s.util)) sum[w] = (sum[w] ?? 0) + v;
    }
    for (const [w, v] of Object.entries(sum)) windowPct[w] = Math.round((v / samples.length) * estimatedRuns * 1000) / 10;
    usd = Math.round((usdSum / samples.length) * estimatedRuns * 100) / 100;
  }
  const confirmRuns = cfg?.budgets.rerun_confirm_runs ?? 20;
  const confirmPct = cfg?.budgets.rerun_confirm_window_pct ?? 5;
  const needsConfirm = estimatedRuns >= confirmRuns || Object.values(windowPct).some((p) => p >= confirmPct);
  if (invalidated > 0) notes.push(`${invalidated} 个待执行任务将作废并重新派发`);
  return { invalidatedTasks: invalidated, estimatedRuns, affectedChapters: affected, affectedDeltas, windowPct, usd, needsConfirm, notes };
}

export interface SaveFileInput {
  path: string;
  content: string;
  baseSha: string | null;
  message?: string | undefined;
  confirm: boolean;
}

export type SaveFileResult = { kind: 'saved'; file: RepoFile } | { kind: 'needs_confirm'; impact: ImpactEstimate };

/** 写书库文件。产物所有权：generated/derived 拒收；正文走 saveChapterText 的语义（由路由层分派） */
export async function saveRepoFile(deps: AppDeps, row: BookRow, input: SaveFileInput): Promise<SaveFileResult> {
  const rel = requireRel(input.path);
  const owner = pathOwner(rel);
  if (owner === 'derived') throw badRequest(`${rel} 是派生文件，不能手改`, 'derived_path');
  if (owner === 'generated') throw badRequest(`${rel} 由 Novelist 生成，请改 instructions/AGENTS.md`, 'generated_path');
  const repo = openRepo(bookDir(deps, row.slug));
  if (rel === P.bookYaml) {
    if (!input.baseSha) throw badRequest('修改 book.yaml 需要 baseSha');
    await saveBookConfig(deps, row, repo, input.content, input.baseSha);
    return { kind: 'saved', file: await readRepoFile(repo, rel) };
  }
  // v3：给作者的话不管从哪个编辑器改，都按一次性留言处理（归档旧留言、记 meta）
  if (rel === 'notes/from-owner.md' && isV3(await bookFiles(repo).config().then((c) => c.config).catch(() => null))) {
    await setOwnerMessage(deps, row, input.content);
    return { kind: 'saved', file: await readRepoFile(repo, rel) };
  }
  const impact = await estimateImpact(deps, row, repo, rel);
  if (impact.needsConfirm && !input.confirm) return { kind: 'needs_confirm', impact };
  await commitOwnerEdit(deps.db, repo, row.id, { files: [{ path: rel, content: input.content }], message: input.message ?? `owner: edit ${rel}`, baseSha: input.baseSha });
  // v3：主人改过的已验收章节锁定，之后的运行不能再改写它
  const ms = /^manuscript\/c(\d{5})\.md$/.exec(rel);
  if (ms && Number(ms[1]) <= row.acceptedThrough && isV3(await bookFiles(repo).config().then((c) => c.config).catch(() => null))) await lockChapter(deps.db, row.id, Number(ms[1]));
  // v3：主人改了 bible.md → 标签（和还没有的简介）跟着更新，书库摘要按它计数
  if (rel === 'bible.md' && isV3(await bookFiles(repo).config().then((c) => c.config).catch(() => null))) await syncBibleMeta(deps.db, row.id, input.content);
  return { kind: 'saved', file: await readRepoFile(repo, rel) };
}

/** 手改已验收正文：提交 → 更新索引 → 排 reextract（级联由 E 的 chapter.reextract 处理）；v3 书不排 reextract，改为锁章 */
export async function saveChapterText(deps: AppDeps, row: BookRow, no: number, text: string, baseSha: string | null, confirm: boolean): Promise<{ kind: 'saved' } | { kind: 'needs_confirm'; impact: ImpactEstimate }> {
  const rel = P.manuscript(no);
  const repo = openRepo(bookDir(deps, row.slug));
  const impact = await estimateImpact(deps, row, repo, rel);
  const chapterRows = await deps.db.select({ publishedAt: chapters.publishedAt, cjk: chapters.cjk }).from(chapters).where(and(eq(chapters.bookId, row.id), eq(chapters.no, no))).limit(1);
  const cfg = await bookFiles(repo).config().then((c) => c.config).catch(() => null);
  const frozen = !!chapterRows[0]?.publishedAt && (cfg ?? (await bookFiles(repo).config()).config).publish.freeze_on_publish;
  if ((impact.needsConfirm || frozen) && !confirm) return { kind: 'needs_confirm', impact: { ...impact, needsConfirm: true, ...(frozen ? { notes: [...impact.notes, '本章已发布（freeze_on_publish），修改需要二次确认'] } : {}) } };
  const clean = stripBeatMarkers(text);
  await commitOwnerEdit(deps.db, repo, row.id, { files: [{ path: rel, content: clean }], message: `owner: edit manuscript c${String(no).padStart(5, '0')}`, baseSha });
  const { countCjk } = await import('@novelist/shared');
  const nowIso = new Date().toISOString();
  const newCjk = countCjk(clean, 'han');
  await deps.db.update(chapters).set({ cjk: newCjk, revisedAt: nowIso, updatedAt: nowIso }).where(and(eq(chapters.bookId, row.id), eq(chapters.no, no)));
  await deps.db.update(books).set({ totalCjk: sql`${books.totalCjk} + ${newCjk - (chapterRows[0]?.cjk ?? 0)}`, updatedAt: nowIso }).where(eq(books.id, row.id));
  if (isV3(cfg)) {
    // v3 的章名只来自首行标题（与 reindex 一致：有标题行才更新，"# 第七章" 没有章名时记 ''）；阅读端去掉首行、只显示 DB 里的章名
    const { parseChapterHeading } = await import('@novelist/shared');
    const heading = parseChapterHeading(clean.split('\n').find((l) => l.trim() !== '') ?? '');
    if (heading) await deps.db.update(chapters).set({ title: heading.title }).where(and(eq(chapters.bookId, row.id), eq(chapters.no, no)));
    if (no <= row.acceptedThrough) await lockChapter(deps.db, row.id, no);
  } else if (no <= row.acceptedThrough) await deps.orchestrator.chapterAction(row.id, no, { action: 'reextract', confirm: true });
  return { kind: 'saved' };
}

