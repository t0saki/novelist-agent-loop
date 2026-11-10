/**
 * v3 书的回退（docs/v3/DESIGN.md §4“回退”、§9；p2-plan §2.6、§3.2 D9）。
 * 不是 reset --hard：一个向前的主人提交把第 to 章之后的正文移到 drafts/rewound-<ts>/，笔记退回到“包含第 to+1 章的那一批”开始前的版本
 * （被替换的版本存进 notes/archive/rewound-<ts>/），旧 HEAD 和被挪走的章节标签保留在 trash/rewind-<ts>/ 下。什么都不会丢。
 *
 * 顺序：1 认领（行锁下检查、设 meta.v3.rewinding；从此发布不越过 to，decideNext 什么都不排）→ 2 找批次起点 →
 * 3 先打 trash 标签 → 4 向前提交、删掉 to 之后的 ch/ 标签 → 5 DB（幂等，同时清 rewinding）。
 * 第 4 步之后失败（DB 出错、进程崩溃）：rewinding 留着，recoverRewinds 按提交上的 trailer 补做第 5 步。
 */
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { chapterId, tags as gitTags } from '@novelist/shared';
import { gitRaw } from '../book/git.js';
import { openRepo, type BookRepo, type FileChange } from '../book/repo.js';
import { TRAILER, parseTrailers } from '../book/trailers.js';
import { books, chapters, inbox, publishSchedule, tasks } from '../db/schema.js';
import { HttpProblem } from '../api/problem.js';
import type { Db } from '../db/client.js';
import { compactTs } from '../flow/map.js';
import { notV3, v3Finished } from '../flow/owner.js';
import { patchV3Meta, readV3Meta } from '../flow/state.js';
import type { V3BatchLogEntry, V3BookMeta, V3Hint } from '../flow/types.js';
import { clearStaleGitLocks, withRepoLock } from './committer.js';
import type { ExecEnv } from './executor.js';
import { ACTIVE_STATES, QUEUED_STATES } from './queue.js';

export const REWIND_TRAILER = 'Novelist-Rewind';
export const REWIND_TS_TRAILER = 'Novelist-Rewind-Ts';
/** 回退落在一批中间：笔记退回到这一章之前（下次任务单要求补记） */
export const REWIND_NOTES_FROM_TRAILER = 'Novelist-Rewind-Notes-From';
/** 回退提交上记笔记有没有退回批次起点：reverted / kept（找不到批次起点，笔记没动）。恢复路径按它写提示，缺这个 trailer 时按 kept */
export const REWIND_NOTES_TRAILER = 'Novelist-Rewind-Notes';

export interface RewindV3Result {
  to: number;
  movedDir: string | null;
  notesFrom: number | null;
  commit: string;
}

/** 测试钩子：第 4 步提交之后、DB 那一步之前（模拟崩溃 / DB 出错） */
export const rewindHooks: { afterCommit: ((bookId: string) => Promise<void>) | null } = { afterCommit: null };

/** 本进程里正在做的回退：恢复扫描不碰它们 */
const inFlight = new Set<string>();
/** 别的进程的回退：rewinding 设上超过这么久还没提交，才当作中途死掉 */
const STALE_CLAIM_MS = 2 * 60_000;

const pad5 = (n: number) => String(n).padStart(5, '0');
/** 与 flow/handlers.ts V3_KINDS 相同（这里不引 handlers，免得 orchestrator ↔ flow 循环） */
const V3_KINDS = ['book.open', 'book.write', 'book.retro'] as const;
const readAll = (repo: BookRepo, rels: string[], rev: string): Promise<(string | null)[]> => (repo.readMany ? repo.readMany(rels, rev) : Promise.all(rels.map((r) => repo.readFile(r, rev))));
const busy = () => new HttpProblem(409, 'v3_busy', '正在写或在收稿，等这一批收完（或先暂停并取消任务）再回退');

/** 回退时笔记跟着退的文件：bible.md、outline.md、notes/**（archive 和主人留言除外） */
const isStoryPath = (p: string): boolean => p === 'bible.md' || p === 'outline.md' || (p.startsWith('notes/') && !p.startsWith('notes/archive/') && p !== 'notes/from-owner.md');

async function revParse(repo: BookRepo, rev: string): Promise<string | null> {
  const r = await gitRaw(repo.dir, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  const sha = r.stdout.toString('utf8').trim();
  return r.code === 0 && sha ? sha : null;
}

interface LoggedCommit {
  sha: string;
  ts: string;
  subject: string;
  trailers: Record<string, string>;
}

/** HEAD 的全部提交，旧的在前（批次回填 / 回退恢复用） */
async function commitsOldestFirst(repo: BookRepo, extra: string[] = []): Promise<LoggedCommit[]> {
  if (!(await repo.head())) return [];
  const r = await gitRaw(repo.dir, ['log', '--reverse', '--format=%H%x1f%cI%x1f%B%x1e', ...extra, 'HEAD']);
  if (r.code !== 0) return [];
  const out: LoggedCommit[] = [];
  for (const rec of r.stdout.toString('utf8').split('\x1e')) {
    const t = rec.replace(/^\n+/, '');
    if (!t) continue;
    const [sha = '', ts = '', ...rest] = t.split('\x1f');
    const body = rest.join('\x1f');
    out.push({ sha, ts, subject: body.split('\n')[0] ?? '', trailers: parseTrailers(body) });
  }
  return out;
}

const partOf = (v: string | undefined): { key: string; no: number } | null => {
  const m = /^(.*)#(\d+)$/.exec(v ?? '');
  return m ? { key: m[1] as string, no: Number(m[2]) } : null;
};

/**
 * phase 1 的书没有 batchLog：按 Novelist-Part / Novelist-Task trailer 从 git 重建（一个 key = 一批）。
 * from / to = 这一批的新章（改写不算）里 ≤ accepted 的最小 / 最大章号；baseCommit = 这一批第一个分章提交的父提交。
 * 回退提交（Novelist-Rewind）把它之前、章号大于回退目标的批次截掉；同一章号后来又写了一批时，以后来的为准。
 */
export async function backfillBatchLog(repo: BookRepo, accepted: number): Promise<V3BatchLogEntry[]> {
  const commits = await commitsOldestFirst(repo);
  type Group = { key: string; first: number; firstSha: string; nos: number[]; finalSha: string | null; lastSha: string; runId: string | null; ts: string };
  const groups = new Map<string, Group>();
  const events: ({ at: number; kind: 'group'; key: string } | { at: number; kind: 'rewind'; to: number })[] = [];
  commits.forEach((c, i) => {
    const part = partOf(c.trailers[TRAILER.part]);
    if (part) {
      let g = groups.get(part.key);
      if (!g) {
        g = { key: part.key, first: i, firstSha: c.sha, nos: [], finalSha: null, lastSha: c.sha, runId: c.trailers[TRAILER.run] ?? null, ts: c.ts };
        groups.set(part.key, g);
        events.push({ at: i, kind: 'group', key: part.key });
      }
      if (!c.subject.startsWith('chapter: rewrite ')) g.nos.push(part.no);
      g.lastSha = c.sha;
      g.ts = c.ts;
    }
    const task = c.trailers[TRAILER.task];
    if (task && groups.has(task)) (groups.get(task) as Group).finalSha = c.sha;
    const rw = c.trailers[REWIND_TRAILER];
    if (rw !== undefined && /^\d+$/.test(rw)) events.push({ at: i, kind: 'rewind', to: Number(rw) });
  });
  let log: V3BatchLogEntry[] = [];
  for (const e of events) {
    if (e.kind === 'rewind') {
      log = cutBatchLog(log, e.to);
      continue;
    }
    const g = groups.get(e.key) as Group;
    if (g.nos.length === 0) continue;
    const from = Math.min(...g.nos);
    const to = Math.max(...g.nos);
    const base = (await revParse(repo, `${g.firstSha}^`)) ?? '';
    // 后写的批次覆盖章号重叠的旧批次
    log = [...log.filter((x) => x.to < from), { runId: g.runId, kind: from === 1 ? 'open' : 'write', from, to, baseCommit: base, finalCommit: g.finalSha ?? g.lastSha, at: g.ts }];
  }
  return cutBatchLog(log, accepted);
}

/** batchLog 截到第 to 章：from > to 的批次丢掉，最后一批的 to 夹到 to */
export function cutBatchLog(log: V3BatchLogEntry[], to: number): V3BatchLogEntry[] {
  return log.filter((e) => e.from <= to).map((e) => (e.to > to ? { ...e, to } : e));
}

/** 写第 no 章的那一批的起点：batchLog 里的记录；没有时按 ch/NNNNN 上的 Novelist-Part 找这一批的第一个提交的父提交；都没有 null */
export async function batchBaseFor(repo: BookRepo, meta: Pick<V3BookMeta, 'batchLog'>, no: number): Promise<{ base: string; from: number } | null> {
  const entry = meta.batchLog.find((e) => e.from <= no && no <= e.to && e.baseCommit);
  if (entry) return { base: entry.baseCommit, from: entry.from };
  const sha = await revParse(repo, gitTags.chapter(no));
  if (!sha) return null;
  const body = (await gitRaw(repo.dir, ['log', '-1', '--format=%B', sha])).stdout.toString('utf8');
  const part = partOf(parseTrailers(body)[TRAILER.part]);
  if (!part) {
    const parent = await revParse(repo, `${sha}^`);
    return parent ? { base: parent, from: no } : null;
  }
  const same = (await commitsOldestFirst(repo, ['--fixed-strings', `--grep=${TRAILER.part}: ${part.key}#`])).filter((c) => partOf(c.trailers[TRAILER.part])?.key === part.key);
  const first = same[0];
  if (!first) return null;
  const base = await revParse(repo, `${first.sha}^`);
  if (!base) return null;
  const nos = same.filter((c) => !c.subject.startsWith('chapter: rewrite ')).map((c) => partOf(c.trailers[TRAILER.part])?.no ?? no);
  return { base, from: Math.min(no, ...nos) };
}

/** 书页给出的回退点：0（还没发布过时）和每一批的结尾（≥ 已发布、< 已写），新的在前 */
export function rewindPoints(meta: Pick<V3BookMeta, 'batchLog'>, publishedThrough: number, accepted: number): { to: number; label: string }[] {
  const out: { to: number; label: string }[] = [];
  const seen = new Set<number>();
  for (const e of [...meta.batchLog].reverse()) {
    if (e.to < publishedThrough || e.to >= accepted || seen.has(e.to)) continue;
    seen.add(e.to);
    out.push({ to: e.to, label: `第 ${e.to} 章（第 ${e.from}–${e.to} 章这一批写完时）` });
  }
  if (publishedThrough === 0 && accepted > 0) out.push({ to: 0, label: '回到开头（设定和大纲保留）' });
  return out;
}

/** p2-plan §5.6 rewound */
export function rewoundHints(r: { to: number; dir: string; notesFrom: number | null; notesKnown: boolean; note?: string | undefined }, at: string): V3Hint[] {
  let text: string;
  if (r.to === 0) text = `主人把书退回到了开头。旧稿移到了 ${r.dir}/，只作参考，不要照抄；设定和大纲保留，从第 1 章重新写。`;
  else if (r.notesFrom !== null)
    text = `主人把书退回到了第 ${r.to} 章。第 ${r.to + 1} 章起的旧稿移到了 ${r.dir}/，只作参考，不要照抄。笔记退回到了第 ${r.notesFrom} 章之前的版本：先读${r.notesFrom === r.to ? `第 ${r.to} 章` : `第 ${r.notesFrom}–${r.to} 章`}，把${r.notesFrom === r.to ? '这一章' : '这几章'}补记进 notes/chapters.md（每章一行），再顺手更新 notes/cast.md、notes/threads.md、notes/progress.md，然后从第 ${r.to + 1} 章接着写。`;
  else text = `主人把书退回到了第 ${r.to} 章。第 ${r.to + 1} 章起的旧稿移到了 ${r.dir}/，只作参考，不要照抄；按 outline.md 从第 ${r.to + 1} 章重新写。${r.notesKnown ? `笔记已是第 ${r.to} 章写完时的版本。` : ''}`;
  const hints: V3Hint[] = [{ kind: 'rewound', text, at }];
  const note = r.note?.trim();
  if (note) hints.push({ kind: 'rewound', text: `主人的意见：${note}`, at });
  return hints;
}

/** 把书的正文退到第 to 章（见文件头）。拒绝时抛 HttpProblem */
export async function rewindV3(env: ExecEnv, bookId: string, to: number, opts: { note?: string; reason: 'rewind' | 'rewrite_from' }): Promise<RewindV3Result> {
  const now = env.nowFn();
  const at = now.toISOString();
  const ts = compactTs(at);
  if (!Number.isInteger(to) || to < 0) throw new HttpProblem(400, 'bad_request', '回退目标不合法');
  // 1. 认领：先锁书行，再查有没有在跑的 v3 任务、再改 meta，全在同一个事务里
  // （任务刚被认领、还没看到 rewinding 的那一下，由 buildOrderSpec 的跳过规则兜住：它读书行时等这把锁）
  const claim = await env.db.transaction(async (tx) => {
    await tx.select({ id: books.id }).from(books).where(eq(books.id, bookId)).limit(1).for('update');
    const activeTask =
      (await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, bookId), inArray(tasks.kind, [...V3_KINDS]), inArray(tasks.state, ACTIVE_STATES))).limit(1)).length > 0;
    return patchV3Meta(tx, bookId, (meta, row) => {
      if (!row.meta || (row.meta as { v3?: unknown }).v3 === undefined) throw notV3();
      if (activeTask || meta.pending || meta.rewinding) throw busy();
      // 归档的书不会再写：退回去的章节进了 drafts/ 却采用不回来（书页也不给这个操作）
      if (row.status === 'archived') throw v3Finished(row.status);
      if (to < row.publishedThrough) throw new HttpProblem(400, 'bad_request', '不能退到已发布的章节之前');
      if (to >= row.acceptedThrough) throw new HttpProblem(400, 'bad_request', `已经在第 ${row.acceptedThrough} 章`);
      return { patch: { rewinding: { to, ts, at, ...(opts.note?.trim() ? { note: opts.note.trim() } : {}) } }, result: { slug: row.slug, accepted: row.acceptedThrough, meta } };
    });
  });
  inFlight.add(bookId);
  const repo = openRepo(`${env.paths.books}/${claim.slug}`);
  let commit: string | null = null;
  try {
    // 2. 包含第 to+1 章的那一批从哪里开始（phase 1 的书按 trailer 回填）
    const log = claim.meta.batchLog.length > 0 ? claim.meta.batchLog : await backfillBatchLog(repo, claim.accepted);
    const b = await batchBaseFor(repo, { batchLog: log }, to + 1);
    const notesFrom = b && b.from <= to ? b.from : null;
    const dir = `drafts/rewound-${ts}`;
    let moved = false;
    commit = await withRepoLock(env.db, bookId, repo, async () => {
      await clearStaleGitLocks(repo.dir);
      const head = await repo.head();
      // 3. 先打标签（指向已有提交，失败时什么都还没动）
      await repo.tag(`trash/rewind-${ts}/head`, head);
      const chTags = (await repo.tags('ch/*')).filter((t) => Number(t.split('/')[1]) > to);
      for (const t of chTags) {
        const sha = await revParse(repo, t);
        if (sha) await repo.tag(`trash/rewind-${ts}/${t}`, sha);
      }
      // 4. 向前提交：正文移进 drafts/rewound-<ts>/，笔记退回到批次起点（被替换的版本进 notes/archive/rewound-<ts>/）
      const files: FileChange[] = [];
      // 认领时的进度，加上锁内 HEAD 上实际存在的、编号 > to 的正文（别的写入路径漏了检查时也不留孤立正文）
      const onHead = (await repo.list('manuscript', { rev: head }).catch(() => [] as string[])).filter((p) => /^manuscript\/c\d{5}\.md$/.test(p) && Number(p.slice('manuscript/c'.length, -3)) > to);
      const manuscripts = [...new Set([...Array.from({ length: Math.max(0, claim.accepted - to) }, (_, i) => `manuscript/${chapterId(to + 1 + i)}.md`), ...onHead])].sort();
      const texts = await readAll(repo, manuscripts, head);
      manuscripts.forEach((p, i) => {
        const t = texts[i];
        if (t === null || t === undefined) return;
        files.push({ path: `${dir}/${p.slice('manuscript/'.length)}`, content: t }, { path: p, content: null });
        moved = true;
      });
      if (b) {
        const atHead = (await repo.list('', { rev: head, recursive: true })).filter(isStoryPath);
        const atBase = (await repo.list('', { rev: b.base, recursive: true })).filter(isStoryPath);
        const cands = [...new Set([...atHead, ...atBase])].filter((p) => !(to === 0 && (p === 'bible.md' || p === 'outline.md')));
        const [hs, bs] = await Promise.all([repo.blobShas(cands, head), repo.blobShas(cands, b.base)]);
        const differ = cands.filter((p) => (hs[p] ?? '') !== (bs[p] ?? '')).sort();
        const [headTexts, baseTexts] = await Promise.all([readAll(repo, differ, head), readAll(repo, differ, b.base)]);
        differ.forEach((p, i) => {
          const cur = headTexts[i];
          if (cur !== null && cur !== undefined) files.push({ path: `notes/archive/rewound-${ts}/${p}`, content: cur });
          files.push({ path: p, content: baseTexts[i] ?? null });
        });
      }
      const trailers: Record<string, string> = { [TRAILER.owner]: 'true', [REWIND_TRAILER]: String(to), [REWIND_TS_TRAILER]: ts, ...(notesFrom !== null ? { [REWIND_NOTES_FROM_TRAILER]: String(notesFrom) } : {}), [REWIND_NOTES_TRAILER]: b !== null ? 'reverted' : 'kept' };
      try {
        await repo.writeFiles(files);
        const sha = await repo.commit({ message: `owner: rewind to c${pad5(to)}`, trailers, paths: files.map((f) => f.path), allowEmpty: files.length === 0 });
        for (const t of chTags) await repo.deleteTag(t);
        return sha;
      } catch (e) {
        await repo.resetHard().catch(() => {});
        throw e;
      }
    });
    if (rewindHooks.afterCommit) await rewindHooks.afterCommit(bookId);
    // 5. DB
    const r = { to, ts, commit, ...(opts.note?.trim() ? { note: opts.note.trim() } : {}), movedDir: dir, notesFrom, notesKnown: b !== null };
    await applyRewindDb(env, bookId, r);
    return { to, movedDir: moved ? dir : null, notesFrom, commit };
  } catch (e) {
    // 还没提交：清掉认领（标签留着，都在 trash/ 下）；已提交：留着 rewinding，由 recoverRewinds 补做 DB 那一步
    if (commit === null) await patchV3Meta(env.db, bookId, (m) => ({ patch: m.rewinding?.ts === ts ? { rewinding: null } : null, result: undefined })).catch(() => {});
    throw e;
  } finally {
    inFlight.delete(bookId);
  }
}

/** 回退的 DB 那一步（幂等：每条语句都是“设成”或带条件的删除，崩溃后重做结果一样）；也是恢复路径 */
export async function applyRewindDb(
  env: ExecEnv,
  bookId: string,
  r: { to: number; ts: string; commit: string; note?: string; movedDir: string; notesFrom: number | null; notesKnown?: boolean },
): Promise<void> {
  const nowIso = env.nowFn().toISOString();
  const row0 = (await env.db.select({ slug: books.slug, meta: books.meta }).from(books).where(eq(books.id, bookId)).limit(1))[0];
  if (!row0) return;
  // phase 1 的书：batchLog 先回填再截
  const m0 = readV3Meta(row0.meta);
  const filled = m0.batchLog.length === 0 && r.to > 0 ? await backfillBatchLog(openRepo(`${env.paths.books}/${row0.slug}`), r.to) : null;
  await env.db.transaction(async (tx) => {
    const row = (await tx.select().from(books).where(eq(books.id, bookId)).limit(1).for('update'))[0];
    if (!row) return;
    await tx.delete(chapters).where(and(eq(chapters.bookId, bookId), gt(chapters.no, r.to)));
    await tx.delete(publishSchedule).where(and(eq(publishSchedule.bookId, bookId), gt(publishSchedule.no, r.to)));
    const sum = await tx.select({ total: sql<number>`coalesce(sum(${chapters.cjk}), 0)` }).from(chapters).where(and(eq(chapters.bookId, bookId), lte(chapters.no, r.to)));
    await tx
      .update(tasks)
      .set({ state: 'stale', waitReason: 'rewind', leaseOwner: null, leaseExpiresAt: null, updatedAt: nowIso })
      .where(and(eq(tasks.bookId, bookId), inArray(tasks.state, [...QUEUED_STATES, 'blocked'])));
    const meta = readV3Meta(row.meta);
    const batchLog = cutBatchLog(filled ?? meta.batchLog, r.to);
    const rawMeta = (row.meta ?? {}) as Record<string, unknown>;
    const { completedAt: _a, completedReason: _b, completedNote: _c, ...oldV3 } = (rawMeta.v3 && typeof rawMeta.v3 === 'object' ? rawMeta.v3 : {}) as Record<string, unknown>;
    const v3: Record<string, unknown> = {
      ...oldV3,
      hints: rewoundHints({ to: r.to, dir: r.movedDir, notesFrom: r.notesFrom, notesKnown: r.notesKnown !== false, note: r.note }, nowIso),
      hintedShort: meta.hintedShort.filter((k) => k <= r.to),
      locked: meta.locked.filter((k) => k <= r.to),
      batchLog,
      lastBatchFrom: batchLog.at(-1)?.from ?? null,
      finaleNoMarker: 0,
      finaleNoMarkerAlerted: false,
      noChapterStreak: 0,
      emptyStreak: 0,
      runawayBatches: 0,
      feedback: null,
      retro: { ...meta.retro, afterBatches: filled ? batchLog.length : Math.min(meta.retro.afterBatches, batchLog.length) },
      ownerRequests: meta.ownerRequests.map((q) => (q.status === 'waiting' && q.chapter > r.to ? { ...q, status: 'dropped' } : q)),
      rewinding: null,
    };
    await tx
      .update(books)
      .set({
        acceptedThrough: r.to,
        cursor: r.to + 1,
        totalCjk: Number(sum[0]?.total ?? 0),
        headCommit: r.commit,
        status: row.status === 'completed' ? 'active' : row.status,
        meta: { ...rawMeta, v3 },
        updatedAt: nowIso,
      })
      .where(eq(books.id, bookId));
    await tx
      .update(inbox)
      .set({ state: 'dismissed', resolvedAt: nowIso })
      .where(and(eq(inbox.state, 'open'), inArray(inbox.dedupeKey, [`v3_end:${bookId}`, `v3_no_prose:${bookId}`])));
  });
}

/**
 * leader，启动时和每分钟一次：rewinding 设着、又没有活着的 v3 任务的书——
 * 提交上带着这次回退的 Novelist-Rewind-Ts → 补删 ch/ 标签、重做 applyRewindDb；没有这个提交（git 那一步没做完）→ 只清掉认领。返回处理的本数。
 */
export async function recoverRewinds(env: ExecEnv): Promise<number> {
  const rows = await env.db
    .select({ id: books.id, slug: books.slug, meta: books.meta })
    .from(books)
    .where(sql`jsonb_typeof(${books.meta}->'v3'->'rewinding') = 'object'`);
  let n = 0;
  const nowMs = env.nowFn().getTime();
  for (const row of rows) {
    const rw = readV3Meta(row.meta).rewinding;
    if (!rw || inFlight.has(row.id)) continue;
    const liveTask = await env.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, row.id), inArray(tasks.kind, [...V3_KINDS]), inArray(tasks.state, ACTIVE_STATES))).limit(1);
    if (liveTask.length > 0) continue;
    try {
      const repo = openRepo(`${env.paths.books}/${row.slug}`);
      const done = await repo.findCommitByTrailer(REWIND_TS_TRAILER, rw.ts);
      if (done) {
        const body = (await gitRaw(repo.dir, ['log', '-1', '--format=%B', done])).stdout.toString('utf8');
        const tr = parseTrailers(body);
        const nf = tr[REWIND_NOTES_FROM_TRAILER];
        await withRepoLock(env.db, row.id, repo, async () => {
          for (const t of (await repo.tags('ch/*')).filter((x) => Number(x.split('/')[1]) > rw.to)) await repo.deleteTag(t);
        });
        await applyRewindDb(env, row.id, { to: rw.to, ts: rw.ts, commit: await repo.head(), ...(rw.note ? { note: rw.note } : {}), movedDir: `drafts/rewound-${rw.ts}`, notesFrom: nf && /^\d+$/.test(nf) ? Number(nf) : null, notesKnown: tr[REWIND_NOTES_TRAILER] === 'reverted' });
        n += 1;
        continue;
      }
      // 别的进程可能正在做这次回退：认领得太新就先不动
      if (rw.at && nowMs - Date.parse(rw.at) < STALE_CLAIM_MS) continue;
      await patchV3Meta(env.db, row.id, (m) => ({ patch: m.rewinding?.ts === rw.ts ? { rewinding: null } : null, result: undefined }));
      n += 1;
    } catch (err) {
      env.log.warn({ err: (err as Error).message, bookId: row.id }, 'recoverRewinds failed');
    }
  }
  return n;
}

/**
 * phase 1 的书第一次被看到时（reindex、书页）：batchLog 为空且已有章节 → 按 trailer 回填并存一次（只在仍为空时写），
 * retro.afterBatches 同时设成回填的批数（回填不会让复盘立刻到期）。返回现在的 batchLog。
 */
export async function ensureBatchLog(db: Db, repo: BookRepo, bookId: string): Promise<V3BatchLogEntry[]> {
  const row = (await db.select({ meta: books.meta, accepted: books.acceptedThrough }).from(books).where(eq(books.id, bookId)).limit(1))[0];
  if (!row || !row.meta || (row.meta as { v3?: unknown }).v3 === undefined) return [];
  const meta = readV3Meta(row.meta);
  if (meta.batchLog.length > 0 || row.accepted <= 0) return meta.batchLog;
  const log = await backfillBatchLog(repo, row.accepted);
  if (log.length === 0) return log;
  const empty = sql`coalesce(jsonb_array_length(case when jsonb_typeof(${books.meta}->'v3'->'batchLog') = 'array' then ${books.meta}->'v3'->'batchLog' else '[]'::jsonb end), 0) = 0`;
  await db
    .update(books)
    .set({ meta: sql`jsonb_set(jsonb_set(${books.meta}, '{v3,batchLog}', ${JSON.stringify(log)}::jsonb, true), '{v3,retro}', coalesce(${books.meta}->'v3'->'retro', '{}'::jsonb) || jsonb_build_object('afterBatches', ${log.length}::int), true)` })
    .where(and(eq(books.id, bookId), empty));
  return log;
}
