/**
 * v3 书的主人操作（docs/v3/DESIGN.md §9 书页；p2-plan §2.5b、§3.2）：给作者的话、草稿（采用 / 收起）、收稿失败的重试 / 放弃。
 * 所有替换都是“移走”而不是删除：被替换的正文进 drafts/replaced/<ts>/，处理过的草稿进 drafts/adopted/ 或 drafts/discarded/，留言进 notes/archive/from-owner/。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { V3ActionResult, V3DraftRow } from '@novelist/shared';
import { chapterId, tags as gitTags } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { gitBlobSha, openRepo, P, type FileChange } from '../book/index.js';
import { TRAILER } from '../book/trailers.js';
import { books, chapters, tasks } from '../db/schema.js';
import { HttpProblem, badRequest, notFound } from '../api/problem.js';
import { bookDir, requireRel, type BookRow } from '../api/helpers.js';
import { commitOwnerEdit, withRepoLock } from '../orchestrator/index.js';
import { checkNewChapter, normaliseChapter } from '../flow/checks.js';
import { END_MARKER, END_MARKER_RE } from '../flow/contract.js';
import { compactTs } from '../flow/map.js';
import { notV3, v3Finished } from '../flow/owner.js';
import { dropRequestsFor, readV3Meta, setOwnerMessageMeta } from '../flow/state.js';
import type { V3OwnerMessageMeta } from '../flow/types.js';

const OWNER_FILE = 'notes/from-owner.md';
const ARCHIVE_DIR = 'notes/archive/from-owner';
const ACTIVE = ['leased', 'running', 'finalizing'];
const V3_KINDS = ['book.open', 'book.write', 'book.retro'];

const pad5 = (n: number) => String(n).padStart(5, '0');
const isV3Row = (row: BookRow): boolean => !!row.meta && typeof row.meta === 'object' && (row.meta as { v3?: unknown }).v3 !== undefined && (row.meta as { v3?: unknown }).v3 !== null;
const finished = (row: Pick<BookRow, 'status'>): boolean => row.status === 'completed' || row.status === 'archived';
const freshRow = async (deps: Pick<AppDeps, 'db'>, id: string): Promise<BookRow> => {
  const row = (await deps.db.select().from(books).where(eq(books.id, id)).limit(1))[0];
  if (!row) throw notFound('书');
  return row;
};
/** 2026-11-10T08:30:12Z → 20261110-0830（留言归档的文件名） */
const minuteStamp = (iso: string): string => compactTs(iso).replace('T', '-').slice(0, 13);

function assertV3(row: BookRow): void {
  if (!isV3Row(row)) throw notV3();
}

// ───────────────────────── 给作者的话 ─────────────────────────

/** 归档路径：notes/archive/from-owner/<stamp><suffix>.md，重名加 -2、-3 … */
async function freeArchivePath(repo: ReturnType<typeof openRepo>, stamp: string, suffix: string): Promise<string> {
  const taken = new Set(await repo.list(ARCHIVE_DIR, { recursive: true }).catch(() => [] as string[]));
  let p = `${ARCHIVE_DIR}/${stamp}${suffix}.md`;
  for (let k = 2; taken.has(p); k += 1) p = `${ARCHIVE_DIR}/${stamp}${suffix}-${k}.md`;
  return p;
}

/**
 * 写 notes/from-owner.md（一次性：下一次开书 / 写作 / 结局批读到后归档清空）。'' = 撤回还没被读的那段。
 * 还没被读的旧留言被替换时归档为 <stamp>-replaced.md，撤回时为 <stamp>-withdrawn.md。
 */
export async function setOwnerMessage(deps: AppDeps, rowIn: BookRow, text: string): Promise<V3ActionResult> {
  assertV3(rowIn);
  const row = await freshRow(deps, rowIn.id);
  if (finished(row)) throw v3Finished(row.status);
  const repo = openRepo(bookDir(deps, row.slug));
  const meta = readV3Meta(row.meta);
  const nowIso = new Date().toISOString();
  const current = (await repo.readFile(OWNER_FILE)) ?? '';
  const old = meta.ownerMessage;
  const oldText = current.trim() !== '' ? current : (old?.text ?? '');
  const waiting = oldText.trim() !== '';
  if (text.trim() === '') {
    if (!waiting) throw new HttpProblem(400, 'nothing_to_withdraw', '没有还没被读的留言可以撤回');
    const archivedPath = await freeArchivePath(repo, minuteStamp(old?.setAt || nowIso), '-withdrawn');
    await commitOwnerEdit(deps.db, repo, row.id, { files: [{ path: OWNER_FILE, content: '' }, { path: archivedPath, content: oldText }], message: 'owner: withdraw the message to the author', baseSha: null });
    await setOwnerMessageMeta(deps.db, row.id, null, { ...(old ?? { id: nanoid(8), text: oldText, sha: gitBlobSha(oldText), setAt: nowIso, readIn: null }), archivedPath, status: 'withdrawn' });
    return { ok: true, detail: '已撤回（原话存在 notes/archive/from-owner/）。' };
  }
  const content = `${text.trimEnd()}\n`;
  const files: FileChange[] = [{ path: OWNER_FILE, content }];
  let history: V3OwnerMessageMeta | null = null;
  if (waiting) {
    const archivedPath = await freeArchivePath(repo, minuteStamp(old?.setAt || nowIso), '-replaced');
    files.push({ path: archivedPath, content: oldText });
    history = { ...(old ?? { id: nanoid(8), text: oldText, sha: gitBlobSha(oldText), setAt: nowIso, readIn: null }), archivedPath, status: 'replaced' };
  }
  await commitOwnerEdit(deps.db, repo, row.id, { files: files.map((f) => ({ path: f.path, content: f.content as string })), message: 'owner: message to the author', baseSha: null });
  await setOwnerMessageMeta(deps.db, row.id, { id: nanoid(8), text: text.trimEnd(), sha: gitBlobSha(content), setAt: nowIso, readIn: null, archivedPath: null, status: 'waiting' }, history);
  return { ok: true, detail: '已存好，下一次写作会先读这段话。' };
}

// ───────────────────────── 草稿 ─────────────────────────

export interface DraftClass {
  kind: V3DraftRow['kind'];
  chapter: number | null;
  target: string | null;
  handled: boolean;
}

const KIND_OF_SUFFIX: Record<string, V3DraftRow['kind']> = { dup: 'dup', pre: 'pre', retro: 'retro', discarded: 'rewrite' };

/** drafts/ 下的路径 → 种类、章号、目标（p2-plan §3.2 classifyDraft） */
export function classifyDraft(rel: string): DraftClass {
  const none = { chapter: null, target: null };
  let m = /^drafts\/(adopted|discarded)\//.exec(rel);
  if (m) {
    const c = /\/c(\d{5})[.-]/.exec(rel);
    return { kind: 'other', chapter: c ? Number(c[1]) : null, target: null, handled: true };
  }
  m = /^drafts\/c(\d{5})\.md$/.exec(rel);
  if (m) return { kind: 'unfinished', chapter: Number(m[1]), target: P.manuscript(Number(m[1])), handled: false };
  m = /^drafts\/c(\d{5})\.(rewrite(?:-\d+)?|dup|pre|retro|discarded)(?:-\d+)?\.md$/.exec(rel);
  if (m) {
    const no = Number(m[1]);
    const suffix = (m[2] ?? '').startsWith('rewrite') ? 'rewrite' : (m[2] ?? '');
    return { kind: KIND_OF_SUFFIX[suffix] ?? 'rewrite', chapter: no, target: P.manuscript(no), handled: false };
  }
  m = /^drafts\/rewound-[^/]+\/c(\d{5})\.md$/.exec(rel);
  if (m) return { kind: 'rewound', chapter: Number(m[1]), target: P.manuscript(Number(m[1])), handled: false };
  m = /^drafts\/replaced\/[^/]+\/c(\d{5})\.md$/.exec(rel);
  if (m) return { kind: 'replaced', chapter: Number(m[1]), target: P.manuscript(Number(m[1])), handled: false };
  m = /^drafts\/owner-conflicts\/(.+)$/.exec(rel);
  if (m) {
    const target = m[1] as string;
    const ch = /^manuscript\/c(\d{5})\.md$/.exec(target);
    return { kind: 'owner_conflict', chapter: ch ? Number(ch[1]) : null, target, handled: false };
  }
  return { kind: 'other', ...none, handled: false };
}

/** 能被主人一键恢复的故事资料：bible.md、outline.md、notes/**（archive 和留言除外） */
const isStoryFile = (p: string): boolean => p === 'bible.md' || p === 'outline.md' || (p.startsWith('notes/') && !p.startsWith('notes/archive/') && p !== OWNER_FILE);

/** 采用规则（listDrafts 的 adoptable/reason 与 adoptDraft 的检查同一份） */
function adoptRule(c: DraftClass, b: { published: number; accepted: number; finished: boolean }): { adoptable: boolean; reason: string | null } {
  if (c.handled) return { adoptable: false, reason: '已处理' };
  if (c.chapter !== null && (c.kind !== 'owner_conflict' || c.target === P.manuscript(c.chapter))) {
    const k = c.chapter;
    if (k <= b.published) return { adoptable: false, reason: '已发布，只能直接改' };
    if (k > b.accepted + 1) return { adoptable: false, reason: `先采用第 ${b.accepted + 1} 章` };
    if (k === b.accepted + 1 && b.finished) return { adoptable: false, reason: '这本书已完结，不能再加新章' };
    return { adoptable: true, reason: null };
  }
  if (c.kind === 'owner_conflict' && c.target && isStoryFile(c.target)) return { adoptable: true, reason: null };
  return { adoptable: false, reason: '不是章节或已知笔记文件' };
}

export async function listDrafts(deps: AppDeps, rowIn: BookRow): Promise<V3DraftRow[]> {
  assertV3(rowIn);
  const row = await freshRow(deps, rowIn.id);
  const repo = openRepo(bookDir(deps, row.slug));
  const head = await repo.head();
  if (!head) return [];
  const list = await repo.list('drafts', { rev: head, recursive: true });
  const b = { published: row.publishedThrough, accepted: row.acceptedThrough, finished: finished(row) };
  const out: V3DraftRow[] = [];
  for (const rel of list) {
    if (rel.endsWith('/') || path.posix.basename(rel) === '.gitkeep') continue;
    const c = classifyDraft(rel);
    const size = (await fs.stat(path.join(repo.dir, rel)).catch(() => ({ size: 0 }))).size;
    out.push({ path: rel, size, kind: c.kind, chapter: c.chapter, target: c.target, handled: c.handled, ...adoptRule(c, b) });
  }
  return out;
}

const adoptedPath = (rel: string, ts: string): string => {
  const base = path.posix.basename(rel).replace(/\.md$/, '');
  return `drafts/adopted/${base}-${ts}.md`;
};

/**
 * 采用一份草稿（p2-plan §3.2 adoptDraft）。持仓库锁、并在一个事务里锁住书行再检查（紧挨着的发布不会被覆盖）：
 * - 未发布的已入库章：替换正文，原来的版本进 drafts/replaced/<ts>/，章节锁定；
 * - 第 accepted+1 章：作为新章入库（打 ch/ 标签、batchLog 记一条 adopt），这本书没在写也没在收稿时才行；
 * - 主人冲突里的故事资料：恢复成草稿里的版本，当前版本进 drafts/replaced/<ts>/。
 */
export async function adoptDraft(deps: AppDeps, rowIn: BookRow, rawRel: string): Promise<V3ActionResult> {
  assertV3(rowIn);
  const rel = requireRel(rawRel);
  if (!rel.startsWith('drafts/')) throw badRequest('只能采用 drafts/ 下的草稿');
  const c = classifyDraft(rel);
  if (c.handled) throw badRequest('这份草稿已经处理过了', 'draft_handled');
  const repo = openRepo(bookDir(deps, rowIn.slug));
  const nowIso = new Date().toISOString();
  const ts = compactTs(nowIso);
  const out = await withRepoLock(deps.db, rowIn.id, repo, () =>
    deps.db.transaction(async (tx) => {
      const row = (await tx.select().from(books).where(eq(books.id, rowIn.id)).limit(1).for('update'))[0];
      if (!row) throw notFound('书');
      const meta = readV3Meta(row.meta);
      // 回退进行中：回退按认领时的进度移走章节、把笔记退回批次起点，这时采用的东西会留成孤立文件或被覆盖
      if (meta.rewinding) throw new HttpProblem(409, 'v3_busy', '正在回退，等回退完成再采用');
      const rule = adoptRule(c, { published: row.publishedThrough, accepted: row.acceptedThrough, finished: finished(row) });
      if (!rule.adoptable) throw new HttpProblem(409, c.chapter !== null && c.chapter <= row.publishedThrough ? 'published' : 'not_adoptable', rule.reason ?? '不能采用');
      const head = await repo.head();
      const text = await repo.readFile(rel, head);
      if (text === null) throw notFound(`草稿 ${rel} `);
      const moveDraft: FileChange[] = [
        { path: rel, content: null },
        { path: adoptedPath(rel, ts), content: text },
      ];
      const commit = async (files: FileChange[], message: string, tagList: string[] = []) => {
        try {
          await repo.writeFiles(files);
          return await repo.commit({ message, trailers: { [TRAILER.owner]: 'true' }, paths: files.map((f) => f.path), tags: tagList });
        } catch (e) {
          await repo.resetHard().catch(() => {});
          throw e;
        }
      };

      // 故事资料（主人冲突）：恢复
      if (c.chapter === null) {
        const target = c.target as string;
        const cur = await repo.readFile(target, head);
        const files: FileChange[] = [{ path: target, content: text }, ...(cur !== null ? [{ path: `drafts/replaced/${ts}/${target}`, content: cur }] : []), ...moveDraft];
        const sha = await commit(files, `owner: restore ${target} from ${rel}`);
        await tx.update(books).set({ headCommit: sha, updatedAt: nowIso }).where(eq(books.id, row.id));
        return { detail: `已恢复 ${target}`, chapter: null as number | null, cjk: 0, slug: row.slug };
      }

      const k = c.chapter;
      const norm = normaliseChapter(k, text);
      // 新章
      if (k === row.acceptedThrough + 1) {
        const busy = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, row.id), inArray(tasks.kind, V3_KINDS), inArray(tasks.state, ACTIVE))).limit(1);
        if (busy.length > 0 || meta.pending) throw new HttpProblem(409, 'v3_busy', '正在写或在收稿，等这一批收完再采用为新章');
        const check = checkNewChapter(norm.body, [], 1);
        if (!check.ok && check.reason === 'truncated') throw new HttpProblem(409, 'draft_truncated', '草稿结尾停在半句话，先在文件里改好再采用');
        if (!check.ok && check.reason === 'empty') throw new HttpProblem(409, 'draft_empty', '草稿几乎是空的，先在文件里写好再采用');
        const sha = await commit([{ path: P.manuscript(k), content: norm.content }, ...moveDraft], `owner: adopt ${rel} as c${pad5(k)}`, [gitTags.chapter(k)]);
        const values = { state: 'accepted', title: norm.title, cjk: norm.cjk, acceptedCommit: sha, acceptedAt: nowIso, volume: '', arc: '', workflow: { v3: true }, updatedAt: nowIso };
        await tx
          .insert(chapters)
          .values({ bookId: row.id, no: k, chapterId: chapterId(k), ...values })
          .onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: values });
        const v3 = {
          ...((row.meta as { v3?: Record<string, unknown> }).v3 ?? {}),
          batchLog: [...meta.batchLog, { runId: null, kind: 'adopt', from: k, to: k, baseCommit: head, finalCommit: sha, at: nowIso }],
          hints: meta.hints.filter((h) => !(h.kind === 'unfinished' && h.chapter === k)),
          locked: meta.locked.includes(k) ? meta.locked : [...meta.locked, k],
          lastBatchFrom: k,
          lastBatchAt: nowIso,
        };
        await tx
          .update(books)
          .set({
            acceptedThrough: k,
            cursor: k + 1,
            totalCjk: row.totalCjk + norm.cjk,
            headCommit: sha,
            status: row.status === 'planning' ? 'active' : row.status,
            meta: { ...(row.meta as Record<string, unknown>), v3 },
            updatedAt: nowIso,
          })
          .where(eq(books.id, row.id));
        return { detail: `已采用为第 ${k} 章`, chapter: k, cjk: norm.cjk, slug: row.slug };
      }

      // 已入库、未发布的章：替换
      const cur = (await repo.readFile(P.manuscript(k), head)) ?? '';
      let content = norm.content;
      // 完结的书的末章：（全书完）留在原处
      if (k === row.acceptedThrough && finished(row) && cur.split('\n').some((l) => END_MARKER_RE.test(l))) content = `${content}\n${END_MARKER}\n`;
      const sha = await commit([{ path: P.manuscript(k), content }, { path: `drafts/replaced/${ts}/c${pad5(k)}.md`, content: cur }, ...moveDraft], `owner: adopt ${rel} over c${pad5(k)}`);
      const prev = (await tx.select({ cjk: chapters.cjk }).from(chapters).where(and(eq(chapters.bookId, row.id), eq(chapters.no, k))).limit(1))[0];
      await tx.update(chapters).set({ title: norm.title, cjk: norm.cjk, revisedAt: nowIso, updatedAt: nowIso }).where(and(eq(chapters.bookId, row.id), eq(chapters.no, k)));
      // 主人亲手定了这一章：同一章还在等的改写请求作废（锁定的章作者不能再改）
      const v3 = {
        ...((row.meta as { v3?: Record<string, unknown> }).v3 ?? {}),
        locked: meta.locked.includes(k) ? meta.locked : [...meta.locked, k],
        ownerRequests: dropRequestsFor(meta.ownerRequests, k),
      };
      await tx
        .update(books)
        .set({ totalCjk: row.totalCjk + norm.cjk - (prev?.cjk ?? 0), headCommit: sha, meta: { ...(row.meta as Record<string, unknown>), v3 }, updatedAt: nowIso })
        .where(eq(books.id, row.id));
      return { detail: `已采用：第 ${k} 章（原来的版本在 drafts/replaced/）`, chapter: null as number | null, cjk: 0, slug: row.slug };
    }),
  );
  deps.bus.publish({ type: 'book_changed', book: out.slug });
  if (out.chapter !== null) deps.bus.publish({ type: 'chapter_accepted', book: out.slug, no: out.chapter, cjk: out.cjk });
  return { ok: true, detail: out.detail };
}

/** 收起一份草稿：移到 drafts/discarded/（不删除） */
export async function discardDraft(deps: AppDeps, rowIn: BookRow, rawRel: string): Promise<V3ActionResult> {
  assertV3(rowIn);
  const rel = requireRel(rawRel);
  if (!rel.startsWith('drafts/')) throw badRequest('只能收起 drafts/ 下的草稿');
  if (classifyDraft(rel).handled) throw badRequest('这份草稿已经处理过了', 'draft_handled');
  const repo = openRepo(bookDir(deps, rowIn.slug));
  const text = await repo.readFile(rel, await repo.head());
  if (text === null) throw notFound(`草稿 ${rel} `);
  let to = `drafts/discarded/${rel.slice('drafts/'.length)}`;
  for (let k = 2; await repo.exists(to); k += 1) to = `drafts/discarded/${rel.slice('drafts/'.length).replace(/\.md$/, '')}-${k}.md`;
  await commitOwnerEdit(deps.db, repo, rowIn.id, { files: [{ path: rel, content: null }, { path: to, content: text }], message: `owner: discard ${rel}`, baseSha: null });
  deps.bus.publish({ type: 'book_changed', book: rowIn.slug });
  return { ok: true, detail: '已收起（移到 drafts/discarded/）' };
}

/** 收稿连续失败：重试 / 放弃（逻辑在门面 v3PendingAction） */
export async function pendingAction(deps: AppDeps, rowIn: BookRow, action: 'retry' | 'discard'): Promise<V3ActionResult> {
  assertV3(rowIn);
  return { ok: true, detail: await deps.orchestrator.v3PendingAction(rowIn.id, action) };
}

