/**
 * 唯一 committer（DESIGN §4.4、§7.7）。
 * 每仓库互斥锁 = 进程内队列 + 文件锁 $BOOK/.git/novelist.lock +（pg 时）pg_advisory_xact_lock(hash(book))。
 * promoteV3：一章一个提交（Novelist-Part trailer），主人在运行期间改过的文件逐个裁决（以主人为准），最后一个提交之后在同一事务里跑 db effect。
 * 幂等：取锁后先按 trailer 查已提交的 commit（崩溃重入、重复认领都走这条）。
 * 崩溃恢复（持锁）：已提交 → 重放 db effect；否则 reset --hard + clean，下次执行从 pending 记录重新收稿。
 * 主人直接改文件走 commitOwnerEdit（Novelist-Owner-Edit trailer）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { parseDocument } from 'yaml';
import { chapterId } from '@novelist/shared';
import { books, tasks } from '../db/schema.js';
import type { Db, Tx } from '../db/client.js';
import type { InboxInput, PromotePlan, TaskRow } from '../runtime/types.js';
import { NothingToCommitError, type BookRepo, type FileChange } from '../book/repo.js';
import { P } from '../book/layout.js';
import { TRAILER, parseTrailers } from '../book/trailers.js';
import { gitRaw } from '../book/git.js';
import { ignoredPaths } from '../book/harvest.js';
import { runDbEffect, type DbEffectExtra } from '../runtime/effects.js';
import { isFrozenChapter } from '../flow/contract.js';
import { clearPending, readV3Meta } from '../flow/state.js';
import type { V3CommitPart, V3CommitPlan } from '../flow/types.js';
import { orchOf, taskTrailerValue, withOrch } from './orch-state.js';

export interface PromoteOutcome {
  status: 'committed' | 'rebased' | 'stale' | 'rejected';
  commit: string | null;
  reason?: string;
  /** 已存在对应 commit（崩溃重入）：db effect 需要重放 */
  replay?: boolean;
}

export interface PromoteMeta {
  harness?: string;
  model?: string;
  isolation?: string;
  instructionsHash?: string;
  snapshotHash?: string;
}

// ───────────────────────── 仓库锁 ─────────────────────────

const localQueues = new Map<string, Promise<unknown>>();
const INCARNATION = randomBytes(8).toString('hex');
const FILE_LOCK_STALE_MS = 10 * 60_000;
const FILE_LOCK_TIMEOUT_MS = 180_000;
const FILE_LOCK_EMPTY_STALE_MS = 5_000;

function lockKey(bookId: string): number {
  return createHash('sha256').update(`nv.repo:${bookId}`).digest().readInt32BE(0);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function acquireFileLock(dir: string): Promise<() => Promise<void>> {
  const file = path.join(dir, '.git', 'novelist.lock');
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const h = await fs.open(file, 'wx', 0o644);
      await h.writeFile(JSON.stringify({ pid: process.pid, inc: INCARNATION, ts: Date.now() }));
      await h.close();
      return async () => {
        await fs.rm(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (await staleLock(file)) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`repo lock timeout: ${file}`);
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 100));
    }
  }
}

async function staleLock(file: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return false; // 刚被释放
  }
  try {
    const raw = JSON.parse(text) as { pid?: number; inc?: string; ts?: number };
    if (!raw.ts || Date.now() - raw.ts > FILE_LOCK_STALE_MS) return true;
    if (raw.pid === process.pid) return raw.inc !== INCARNATION; // 同 pid 不同 incarnation = 上次遗留
    return !raw.pid || !pidAlive(raw.pid);
  } catch {
    // open('wx') 与 writeFile 之间崩溃留下的空文件：刚创建的话等一下，过几秒还是空的就是遗留
    try {
      return Date.now() - (await fs.stat(file)).mtimeMs > FILE_LOCK_EMPTY_STALE_MS;
    } catch {
      return false;
    }
  }
}

/**
 * 删除崩溃残留的 git 锁（SIGKILL/OOM/断电时遗留）。只能在持有仓库锁时调用：此时 Novelist 没有其它 git 写者。
 * 不碰 novelist.lock（它由 withRepoLock 自己判 stale）。
 */
export async function clearStaleGitLocks(dir: string): Promise<string[]> {
  const gitDir = path.join(dir, '.git');
  const removed: string[] = [];
  const rm = async (abs: string): Promise<void> => {
    await fs.rm(abs, { force: true });
    removed.push(path.relative(gitDir, abs));
  };
  for (const name of ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'shallow.lock']) {
    const abs = path.join(gitDir, name);
    if (await fs.stat(abs).then(() => true, () => false)) await rm(abs);
  }
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.name.endsWith('.lock')) await rm(abs);
    }
  };
  await walk(path.join(gitDir, 'refs'));
  return removed;
}

const isGitLockError = (e: unknown): boolean => /\.lock'?:? ?(File exists|exists)|Unable to create .*\.lock|another git process/i.test((e as Error).message ?? '');

/** git 操作撞上残留锁时清理后重试一次（调用方已持有仓库锁） */
async function withGitLockRetry<T>(repo: BookRepo, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isGitLockError(e)) throw e;
    await clearStaleGitLocks(repo.dir);
    return fn();
  }
}

function isPglite(db: Db): boolean {
  const client = (db as unknown as { $client?: unknown }).$client;
  return !!client && typeof client === 'object' && 'waitReady' in (client as object);
}

export async function withRepoLock<T>(db: Db, bookId: string, repo: BookRepo, fn: () => Promise<T>): Promise<T> {
  const prev = localQueues.get(bookId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.catch(() => {}).then(() => mine);
  localQueues.set(bookId, tail);
  await prev.catch(() => {});
  try {
    const unlock = await acquireFileLock(repo.dir);
    try {
      if (isPglite(db)) return await fn();
      // pg：跨进程互斥；事务只持有 advisory 锁，不包含 DB 写（fn 内的 DB 操作走别的连接）
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(bookId)})`);
        return fn();
      });
    } finally {
      await unlock();
    }
  } finally {
    release();
    if (localQueues.get(bookId) === tail) localQueues.delete(bookId);
  }
}

// ───────────────────────── 提交后的 DB 效果 ─────────────────────────

/** §7.7 第 7 步：db effect + books.head_commit + tasks.params._orch.effectsCommit（同一事务，exactly-once） */
export async function applyDbEffects(db: Db, plan: { bookId: string; taskId: string; effect?: PromotePlan['effect'] }, commit: string, extra?: DbEffectExtra): Promise<void> {
  await db.transaction(async (tx: Tx) => {
    const rows = await tx.select({ params: tasks.params }).from(tasks).where(eq(tasks.id, plan.taskId)).limit(1).for('update');
    const row = rows[0];
    const already = row ? orchOf(row).effectsCommit === commit : false;
    if (!already && plan.effect) await runDbEffect(tx, commit, plan.effect, extra);
    await tx.update(books).set({ headCommit: commit, updatedAt: new Date().toISOString() }).where(eq(books.id, plan.bookId));
    if (row && !already) await tx.update(tasks).set({ params: withOrch(row.params, { effectsCommit: commit }), updatedAt: new Date().toISOString() }).where(eq(tasks.id, plan.taskId));
  });
}

// ───────────────────────── v3：一章一个提交 ─────────────────────────

export interface PromoteV3Outcome extends PromoteOutcome {
  /** 已提交的章号（改写 + 新章；含之前崩溃前已提交的部分） */
  landed: number[];
  /** 运行期间主人改过、放弃了作者版本的路径 */
  dropped: string[];
  /** 要发的待办（HEAD 缺上一章等），由 executor 创建 */
  notices: InboxInput[];
}

const splitList = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

async function commitTrailers(repo: BookRepo, sha: string): Promise<Record<string, string>> {
  const r = await gitRaw(repo.dir, ['show', '-s', '--format=%B', sha]);
  return r.code === 0 ? parseTrailers(r.stdout.toString('utf8')) : {};
}

/** 提交；内容与 HEAD 完全一致时写空提交，保证 trailer 可查 */
async function commitOrEmpty(repo: BookRepo, input: { message: string; trailers: Record<string, string>; paths: string[]; tags: string[] }): Promise<string> {
  return withGitLockRetry(repo, async () => {
    try {
      return await repo.commit(input);
    } catch (e) {
      if (!(e instanceof NothingToCommitError)) throw e;
      return repo.commit({ ...input, paths: [], allowEmpty: true });
    }
  });
}

/**
 * v3 一批的提交（p1-plan §2.15）：持仓库锁；幂等键 = pending.trailerKey（Novelist-Task: <taskTrailer>@<runId>，在最后一个提交上），
 * 每章一个提交带 Novelist-Part: <key>#<no>（崩溃后按它续上）。主人在运行期间改过的文件按文件以主人为准，作者版本进 drafts/owner-conflicts/。
 */
export async function promoteV3(db: Db, repo: BookRepo, task: TaskRow, plan: PromotePlan & { v3: V3CommitPlan }, meta: PromoteMeta, log?: { warn: (obj: object, msg: string) => void }): Promise<PromoteV3Outcome> {
  void task;
  const v3 = plan.v3;
  const key = v3.key;
  const partKey = (no: number) => `${key}#${no}`;
  const common: Record<string, string> = {
    ...(plan.runId ? { [TRAILER.run]: plan.runId } : {}),
    ...(meta.harness ? { [TRAILER.harness]: meta.harness } : {}),
    ...(meta.model ? { [TRAILER.model]: meta.model } : {}),
    ...(meta.instructionsHash ? { [TRAILER.instructions]: meta.instructionsHash } : {}),
    ...(meta.isolation ? { [TRAILER.isolation]: meta.isolation } : {}),
  };

  const outcome = await withRepoLock<PromoteV3Outcome>(db, plan.bookId, repo, async () => {
    // 1. 已提交过（重入 / 崩溃在 DB 效果之前）：补打 tag，交给 DB 效果重放
    const final = await repo.findCommitByTrailer(TRAILER.task, key);
    if (final) {
      const tr = await commitTrailers(repo, final);
      const landed = splitList(tr[TRAILER.chapters]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      for (const p of v3.parts) {
        if (!p.tag || !landed.includes(p.no)) continue;
        const sha = await repo.findCommitByTrailer(TRAILER.part, partKey(p.no));
        if (sha) await withGitLockRetry(repo, () => repo.tag(p.tag as string, sha));
      }
      return { status: 'committed', commit: final, replay: true, landed, dropped: splitList(tr[TRAILER.ownerWins]), notices: [] };
    }

    // 2. HEAD 与之前崩溃时已提交的部分
    const head = await repo.head();
    const done = new Map<number, string>();
    for (const p of v3.parts) {
      const sha = await repo.findCommitByTrailer(TRAILER.part, partKey(p.no));
      if (sha) done.set(p.no, sha);
    }

    const tail = new Map<string, string | null>(v3.tail.map((t) => [t.path, t.content]));
    const freePath = (want: string): string => {
      if (!tail.has(want)) return want;
      for (let i = 2; ; i += 1) {
        const alt = want.replace(/\.md$/, `-${i}.md`);
        if (!tail.has(alt)) return alt;
      }
    };

    // 3. 冻结复查（锁内读 DB）：运行期间发布或被主人锁定的章节，改写一律进 drafts/
    const row = (await db.select({ publishedThrough: books.publishedThrough, meta: books.meta }).from(books).where(eq(books.id, plan.bookId)).limit(1))[0];
    const frozen = { publishedThrough: row?.publishedThrough ?? 0, locked: readV3Meta(row?.meta).locked };
    let parts: V3CommitPart[] = [];
    for (const p of v3.parts) {
      if (!done.has(p.no) && p.rewrite && isFrozenChapter(p.no, frozen)) {
        tail.set(freePath(`drafts/${chapterId(p.no)}.rewrite.md`), p.content);
        continue;
      }
      parts.push(p);
    }

    // 4. 按文件“主人为准”：base 与 HEAD 不同、且最后一次改它的提交不是本批的分章提交
    const dropped: string[] = [];
    if (v3.baseCommit && v3.baseCommit !== head) {
      const cands = [...new Set([...parts.filter((p) => !done.has(p.no)).flatMap((p) => [p.path, ...p.extra.map((e) => e.path)]), ...tail.keys()])];
      const [baseShas, headShas] = await Promise.all([repo.blobShas(cands, v3.baseCommit), repo.blobShas(cands, head)]);
      const ownerChanged = new Set<string>();
      for (const p of cands) {
        if ((baseShas[p] ?? '') === (headShas[p] ?? '')) continue;
        const last = (await repo.log({ limit: 1, path: p })).items[0];
        if (!(last?.trailers[TRAILER.part] ?? '').startsWith(`${key}#`)) ownerChanged.add(p);
      }
      if (ownerChanged.size > 0) {
        let cut = false;
        const kept: V3CommitPart[] = [];
        for (const p of parts) {
          if (done.has(p.no)) {
            kept.push(p);
            continue;
          }
          // 新章必须连续：一章被主人顶掉，后面的新章一起进 drafts/
          if (!p.rewrite && cut) {
            tail.set(freePath(`drafts/${chapterId(p.no)}.md`), p.content);
            continue;
          }
          if (ownerChanged.has(p.path)) {
            dropped.push(p.path);
            tail.set(freePath(`drafts/owner-conflicts/${p.path}`), p.content);
            if (!p.rewrite) cut = true;
            continue;
          }
          const extra = p.extra.filter((e) => {
            if (!ownerChanged.has(e.path)) return true;
            dropped.push(e.path);
            return false;
          });
          kept.push({ ...p, extra });
        }
        parts = kept;
        for (const [p, c] of [...tail]) {
          if (!ownerChanged.has(p)) continue;
          tail.delete(p);
          dropped.push(p);
          if (!p.startsWith('drafts/owner-conflicts/')) tail.set(freePath(`drafts/owner-conflicts/${p}`), c);
        }
      }
    }

    // HEAD 缺上一章只可能是手工改 git：照常逐文件落地，只记日志（不进待办）
    const notices: InboxInput[] = [];
    const firstNew = parts.filter((p) => !p.rewrite).reduce((m, p) => Math.min(m, p.no), Number.POSITIVE_INFINITY);
    if (Number.isFinite(firstNew) && firstNew > 1 && !(await repo.exists(P.manuscript(firstNew - 1), head))) {
      log?.warn({ bookId: plan.bookId, missing: P.manuscript(firstNew - 1), from: firstNew, commit: head }, 'v3 batch lands although HEAD misses the previous chapter');
    }

    // 5. 被 .gitignore 忽略的尾部文件（git add 会拒收，留着只会让提交反复失败）
    const ignored = await ignoredPaths(repo.dir, [...tail.keys()]);
    for (const p of ignored) tail.delete(p);

    // 5b. 服务器替主人写的文件（清空读过的留言并归档）：整组只在 HEAD 上每个路径都还是预期的版本时写，
    // 并且这一批还有章落地（计划里的章被主人改动整批顶掉时留言没被消化；只在已冻结的末章上完结时计划里本来就没有章）
    const serverTail = v3.serverTail ?? [];
    if (serverTail.length > 0 && (parts.length > 0 || v3.parts.length === 0)) {
      const now = await repo.blobShas(
        serverTail.map((s) => s.path),
        head,
      );
      if (serverTail.every((s) => (now[s.path] ?? '') === (s.expectSha ?? ''))) for (const s of serverTail) tail.set(s.path, s.content);
    }

    // 6–7. 提交：每章一个；最后一个带尾部文件、book.yaml 补丁和本批的最终 trailer
    const landed = parts.map((p) => p.no);
    const finalTrailers: Record<string, string> = { ...common, [TRAILER.task]: key, [TRAILER.chapters]: landed.join(','), [TRAILER.ownerWins]: dropped.join(',') };
    const tailFiles: FileChange[] = [...tail].map(([p, c]) => ({ path: p, content: c }));
    if (v3.bookYaml.length > 0) {
      const text = (await repo.readFile(P.bookYaml, head)) ?? '';
      const doc = parseDocument(text);
      for (const e of v3.bookYaml) doc.setIn(e.path, e.value);
      tailFiles.push({ path: P.bookYaml, content: doc.toString({ lineWidth: 0 }) });
    }
    let last = head;
    try {
      for (const p of parts) {
        const sha = done.get(p.no);
        // 崩溃前已提交的章：只补 tag
        if (sha && p.tag) await withGitLockRetry(repo, () => repo.tag(p.tag as string, sha));
      }
      const toWrite = parts.filter((p) => !done.has(p.no));
      for (let i = 0; i < toWrite.length; i += 1) {
        const p = toWrite[i] as V3CommitPart;
        const isLast = i === toWrite.length - 1;
        const files: FileChange[] = [{ path: p.path, content: p.content }, ...p.extra, ...(isLast ? tailFiles : [])];
        await repo.writeFiles(files);
        last = await commitOrEmpty(repo, {
          message: isLast && tailFiles.length > 0 ? `${p.message}\n\n${v3.tailMessage}` : p.message,
          trailers: { ...(isLast ? finalTrailers : common), [TRAILER.part]: partKey(p.no) },
          paths: files.map((f) => f.path),
          tags: p.tag ? [p.tag] : [],
        });
      }
      if (toWrite.length === 0) {
        await repo.writeFiles(tailFiles);
        last = await commitOrEmpty(repo, { message: v3.tailMessage, trailers: finalTrailers, paths: tailFiles.map((f) => f.path), tags: [] });
      }
    } catch (e) {
      // 已提交的章节留着（下次按 Novelist-Part 续上）；半途写入清掉
      await repo.resetHard().catch(() => {});
      throw e;
    }
    return { status: 'committed', commit: last, landed, dropped, notices };
  });

  if (outcome.commit) await applyDbEffects(db, plan, outcome.commit, { landed: outcome.landed, dropped: outcome.dropped });
  return outcome;
}

// ───────────────────────── owner 编辑 ─────────────────────────

export class StaleBaseError extends Error {
  constructor(public readonly path: string) {
    super(`file changed since base: ${path}`);
    this.name = 'StaleBaseError';
  }
}

/** owner 在 UI 编辑书库文件：走同一提交协议（Novelist-Owner-Edit trailer），使受影响的待执行任务失效 */
type OwnerEditInput = { files: { path: string; content: string | null }[]; message: string; baseSha: string | null; extraTrailers?: Record<string, string> };

/** 主人编辑的 git 那一步（调用方已持仓库锁） */
async function ownerCommitLocked(repo: BookRepo, input: OwnerEditInput): Promise<string> {
  const paths = input.files.map((f) => f.path);
  if (input.baseSha) {
    const headSha = await repo.head();
    const blobs = paths.length === 1 ? await repo.blobShas(paths, headSha) : {};
    const blob = paths.length === 1 ? blobs[paths[0] as string] : undefined;
    if (input.baseSha !== headSha && input.baseSha !== blob) throw new StaleBaseError(paths.join(','));
  }
  try {
    await repo.writeFiles(input.files);
    return await withGitLockRetry(repo, () => repo.commit({ message: input.message, trailers: { [TRAILER.owner]: 'true', ...input.extraTrailers }, paths }));
  } catch (e) {
    await repo.resetHard().catch(() => {});
    throw e;
  }
}

export async function commitOwnerEdit(db: Db, repo: BookRepo, bookId: string, input: OwnerEditInput): Promise<{ commit: string; invalidated: string[] }> {
  const commit = await withRepoLock(db, bookId, repo, () => ownerCommitLocked(repo, input));
  return afterOwnerCommit(db, bookId, input, commit);
}

/**
 * 同 commitOwnerEdit，但先在仓库锁里跑 guard（例如清残留 git 锁、确认工作树干净、复查书没在忙）；guard 返回 false 时什么都不写、返回 null。
 * input 由 build 在锁里生成（读的是锁内的文件），返回 null 表示不需要提交。开机迁移 M4b 用。
 */
export async function commitOwnerEditIf(db: Db, repo: BookRepo, bookId: string, guard: () => Promise<boolean>, build: () => Promise<OwnerEditInput | null>): Promise<{ commit: string; invalidated: string[] } | 'refused' | 'unchanged'> {
  const out = await withRepoLock(db, bookId, repo, async () => {
    if (!(await guard())) return 'refused' as const;
    const input = await build();
    if (!input) return 'unchanged' as const;
    return { input, commit: await ownerCommitLocked(repo, input) };
  });
  if (typeof out === 'string') return out;
  return afterOwnerCommit(db, bookId, out.input, out.commit);
}

/** 主人编辑提交之后：动到硬清单的排队任务作废，记下 HEAD */
async function afterOwnerCommit(db: Db, bookId: string, input: Pick<OwnerEditInput, 'files'>, commit: string): Promise<{ commit: string; invalidated: string[] }> {
  const live = (await db.select().from(tasks).where(and(eq(tasks.bookId, bookId), inArray(tasks.state, ['pending', 'ready', 'waiting'])))) as TaskRow[];
  const changed = new Set(input.files.map((f) => f.path));
  const invalidated: string[] = [];
  const now = new Date().toISOString();
  for (const t of live) {
    if (!Object.keys(t.hardManifest).some((p) => changed.has(p))) continue;
    await db.update(tasks).set({ state: 'stale', waitReason: 'owner_edit', updatedAt: now }).where(eq(tasks.id, t.id));
    invalidated.push(t.id);
  }
  await db.update(books).set({ headCommit: commit, updatedAt: now }).where(eq(books.id, bookId));
  return { commit, invalidated };
}

// ───────────────────────── 崩溃恢复 ─────────────────────────

/**
 * 启动时 / 获取锁后：恢复中断的 promote。
 * 已提交 → _orch.recover={mode:'replay',commit}（executor 重放 dbEffects）；
 * 未提交 → reset --hard 清掉半途写入，_orch.recover={mode:'repromote'}。两种都把任务放回 ready（attempt 不变）。
 */
export async function recoverBook(db: Db, repo: BookRepo, bookId: string, opts?: { taskIds?: string[] }): Promise<{ replayed: string[]; reset: boolean }> {
  const finalizing = (await db.select().from(tasks).where(and(eq(tasks.bookId, bookId), eq(tasks.state, 'finalizing')))) as TaskRow[];
  const stuck = opts?.taskIds ? finalizing.filter((t) => opts.taskIds?.includes(t.id)) : finalizing;
  if (stuck.length === 0) return { replayed: [], reset: false };
  const replayed: string[] = [];
  const reset = await withRepoLock(db, bookId, repo, async () => {
    let needReset = false;
    await clearStaleGitLocks(repo.dir);
    for (const t of stuck) {
      const value = taskTrailerValue(t.id, orchOf(t).generation);
      const commit = await repo.findCommitByTrailer(TRAILER.task, value);
      const now = new Date().toISOString();
      if (commit) {
        replayed.push(t.id);
        await db.update(tasks).set({ state: 'ready', notBefore: null, leaseOwner: null, leaseExpiresAt: null, params: withOrch(t.params, { recover: { mode: 'replay', commit } }), updatedAt: now }).where(eq(tasks.id, t.id));
      } else {
        needReset = true;
        await db.update(tasks).set({ state: 'ready', notBefore: null, leaseOwner: null, leaseExpiresAt: null, params: withOrch(t.params, { recover: { mode: 'repromote' } }), updatedAt: now }).where(eq(tasks.id, t.id));
      }
    }
    if (needReset && !(await repo.isClean())) {
      await repo.resetHard();
      return true;
    }
    return false;
  });
  return { replayed, reset };
}

/**
 * 放弃一个 v3 pending（主人在 v3_pending 待办里点"放弃"）之前：promoteV3 中途失败时，HEAD 上可能已经有这个 run 的分章提交（Novelist-Part: <key>#N），
 * 而 DB 从没计入它们（v3.batch 效果只在最后一个提交之后执行）。这里用主人提交把这些章恢复成 base 上的版本（base 上没有就删掉），
 * 已提交的正文另存到 drafts/cNNNNN.discarded.md，新章的 ch/NNNNN 标签一并删掉；HEAD 和 DB 重新一致。返回撤回的章号。
 */
/** 放弃收稿被拒：pending 已经不是这一次的了（gone），或者这一批已经整批提交（landed：应该重试，不能放弃） */
export class V3DiscardRefused extends Error {
  constructor(public readonly code: 'gone' | 'landed') {
    super(code === 'gone' ? '这次收稿已经处理过了' : '这一批已经整批提交了，请改用重试');
  }
}

/**
 * 放弃 pending 时撤回这次运行已经提交的分章（Novelist-Part: <key>#<no>）：正文退回 base 版本，提交过的版本进 drafts/cNNNNN.discarded.md。
 * 日志扫描、读文件、提交全在仓库锁内；给了 runId 时还在锁内复查 pending 仍是这一次、这一批的最终提交（Novelist-Task: <key>）不存在，
 * 然后在锁内清掉 pending（与 promoteV3 互斥：重放刚落地的整批不会被撤回）。返回撤回的章号。
 */
export async function revertPartialV3(db: Db, repo: BookRepo, bookId: string, p: { trailerKey: string; baseCommit: string; runId?: string }): Promise<number[]> {
  const out = await withRepoLock(db, bookId, repo, async () => {
    if (p.runId !== undefined) {
      const row = (await db.select({ meta: books.meta }).from(books).where(eq(books.id, bookId)).limit(1))[0];
      if (readV3Meta(row?.meta).pending?.runId !== p.runId) throw new V3DiscardRefused('gone');
      if (await repo.findCommitByTrailer(TRAILER.task, p.trailerKey)) throw new V3DiscardRefused('landed');
    }
    const r = await revertPartsLocked(repo, p);
    if (p.runId !== undefined) await clearPending(db, bookId, p.runId);
    return r;
  });
  if (out.commit) await afterOwnerCommit(db, bookId, { files: out.files }, out.commit);
  return out.nos;
}

async function revertPartsLocked(repo: BookRepo, p: { trailerKey: string; baseCommit: string }): Promise<{ nos: number[]; files: { path: string; content: string | null }[]; commit: string | null }> {
  const prefix = `${p.trailerKey}#`;
  const items = (await repo.log({ limit: 500 })).items;
  const nos = [
    ...new Set(
      items
        .map((c) => c.trailers[TRAILER.part] ?? '')
        .filter((v) => v.startsWith(prefix))
        .map((v) => Number.parseInt(v.slice(prefix.length), 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ].sort((a, b) => a - b);
  if (nos.length === 0) return { nos, files: [], commit: null };
  const files: { path: string; content: string | null }[] = [];
  const fresh: number[] = [];
  for (const no of nos) {
    const rel = P.manuscript(no);
    const now = await repo.readFile(rel);
    const base = p.baseCommit ? await repo.readFile(rel, p.baseCommit).catch(() => null) : null;
    if (now !== null) files.push({ path: `drafts/${chapterId(no)}.discarded.md`, content: now });
    files.push({ path: rel, content: base });
    if (base === null) fresh.push(no);
  }
  const commit = await ownerCommitLocked(repo, { files, message: `owner: discard partial v3 batch (${nos.join(',')})`, baseSha: null });
  for (const no of fresh) await gitRaw(repo.dir, ['tag', '-d', `ch/${String(no).padStart(5, '0')}`]).catch(() => null);
  return { nos, files, commit };
}
