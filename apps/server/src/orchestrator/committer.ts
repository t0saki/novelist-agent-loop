/**
 * 唯一 committer（DESIGN §4.4、§7.7）。Owner: lane F。
 * 每仓库互斥锁 = 进程内队列 + 文件锁 $BOOK/.git/novelist.lock +（pg 时）pg_advisory_xact_lock(hash(book))。
 * promote：VALIDATED.json 已写 → 取锁 → stale check（hard 变化 → stale；只有 soft 变化 → handler.rebase）→
 *          resolveTmpIds → 写临时文件+fsync+rename → git commit（trailer）+ tag → 释放锁 → dbEffects。
 * 幂等：取锁后先按 Novelist-Task trailer 查已提交的 commit（崩溃重入、重复认领都走这条）。
 * 崩溃恢复（持锁）：git log --grep "Novelist-Task: <id>" 已提交 → 重放第 7 步；否则 reset --hard + clean，再用 VALIDATED.json 重来。
 * 根 AGENTS.md 被手改（非 Novelist 提交）→ 拒收，由 executor 发 Inbox agents_md_edit（一键迁移到 instructions/AGENTS.md）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { books, tasks } from '../db/schema.js';
import type { Db, Tx } from '../db/client.js';
import type { PromotePlan, TaskRow, TaskSpec, Manifest } from '../pipeline/types.js';
import { NothingToCommitError, type BookRepo, type FileChange } from '../book/repo.js';
import { P } from '../book/layout.js';
import { TRAILER } from '../book/trailers.js';
import { buildTmpIdContext, resolveTmpIds } from '../state/index.js';
import { runDbEffect } from '../pipeline/effects.js';
import { REBASE_VALIDATORS } from '../validators/index.js';
import { orchOf, taskTrailerValue, withOrch } from './orch-state.js';

export interface PromoteOutcome {
  status: 'committed' | 'rebased' | 'stale' | 'rejected';
  commit: string | null;
  reason?: string;
  tmpIdMapping?: Record<string, string>;
  /** 已存在对应 commit（崩溃重入）：dbEffects 需要重放 */
  replay?: boolean;
  /** rebase 不通过时 handler 提议的 followups（card.repair 等） */
  followups?: TaskSpec[];
}

export interface PromoteMeta {
  harness?: string;
  model?: string;
  isolation?: string;
  instructionsHash?: string;
  snapshotHash?: string;
}

export interface PromoteOptions {
  /** soft deps 变化时在 HEAD 上重跑确定性 validators（handler.rebase） */
  rebase?: (head: string) => Promise<{ ok: boolean; reason?: string; followups?: TaskSpec[] }>;
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

// ───────────────────────── promote ─────────────────────────

async function agentsMdTampered(repo: BookRepo): Promise<boolean> {
  try {
    const { items } = await repo.log({ limit: 1, path: P.agentsMd });
    const last = items[0];
    if (!last) return false;
    return !Object.keys(last.trailers).some((k) => k === TRAILER.task || k === TRAILER.owner || k === TRAILER.migration);
  } catch {
    return false;
  }
}

function contentString(c: FileChange['content']): string | null {
  return c === null ? null : typeof c === 'string' ? c : c.toString('utf8');
}

/** append-only（*.jsonl）的三方合并：把 plan 相对 base 新增的行追加到 HEAD 内容之后 */
export function mergeAppendOnly(base: string, head: string, ours: string): string {
  const baseLines = new Set(base.split('\n').filter((l) => l.trim() !== ''));
  const headLines = new Set(head.split('\n').filter((l) => l.trim() !== ''));
  const add = ours.split('\n').filter((l) => l.trim() !== '' && !baseLines.has(l) && !headLines.has(l));
  if (add.length === 0) return head;
  return `${head.replace(/\n*$/, '')}${head.trim() ? '\n' : ''}${add.join('\n')}\n`;
}

/** 写写冲突：plan 要写的路径在 base..HEAD 之间被改过。jsonl 三方合并；其余判 stale（重跑比覆盖别人的写入安全） */
async function resolveWriteConflicts(repo: BookRepo, plan: PromotePlan, head: string): Promise<{ files: FileChange[]; conflicts: string[] }> {
  if (!plan.baseCommit || plan.baseCommit === head) return { files: plan.files, conflicts: [] };
  const paths = plan.files.map((f) => f.path);
  const [baseShas, headShas] = await Promise.all([repo.blobShas(paths, plan.baseCommit), repo.blobShas(paths, head)]);
  const conflicts: string[] = [];
  const files: FileChange[] = [];
  for (const f of plan.files) {
    if ((baseShas[f.path] ?? '') === (headShas[f.path] ?? '')) {
      files.push(f);
      continue;
    }
    const text = contentString(f.content);
    if (text !== null && f.path.endsWith('.jsonl')) {
      const [base, cur] = await Promise.all([repo.readFile(f.path, plan.baseCommit), repo.readFile(f.path, head)]);
      files.push({ path: f.path, content: mergeAppendOnly(base ?? '', cur ?? '', text) });
      continue;
    }
    conflicts.push(f.path);
  }
  return { files, conflicts };
}

/** soft deps 变化时在 HEAD（已写入本次产物）上重跑命名 validator；未知名字 = 无法校验，不静默提交 */
async function runRebaseValidators(repo: BookRepo, names: string[], task: TaskRow, plan: PromotePlan): Promise<{ ok: true } | { ok: false; reason: string; followups: TaskSpec[] }> {
  for (const name of names) {
    const validator = REBASE_VALIDATORS[name];
    if (!validator) return { ok: false, reason: `未知的 rebase validator：${name}`, followups: [] };
    const r = await validator(repo.dir, task.target);
    if (r.ok) continue;
    const reason = `${name}: ${r.reason ?? '未通过'}`;
    const stale = name === 'card.projected_pre' ? [...new Set((r.reason ?? '').match(/c\d{5}/g) ?? [])].sort() : [];
    const followups: TaskSpec[] = stale.length ? [{ kind: 'card.repair', bookId: plan.bookId, target: stale[0] as string, params: { cards: stale, reasons: Object.fromEntries(stale.map((id) => [id, [reason]])), instance: `rebase-${task.id.slice(0, 8)}` } }] : [];
    return { ok: false, reason, followups };
  }
  return { ok: true };
}

export async function promote(db: Db, repo: BookRepo, task: TaskRow, manifest: Manifest, plan: PromotePlan, meta: PromoteMeta, opts?: PromoteOptions): Promise<PromoteOutcome> {
  const generation = orchOf(task).generation;
  const trailerValue = taskTrailerValue(plan.taskId, generation);
  const outcome = await withRepoLock<PromoteOutcome>(db, plan.bookId, repo, async () => {
    const existing = await repo.findCommitByTrailer(TRAILER.task, trailerValue);
    if (existing) {
      // commit 成功、tag 前崩溃：幂等补打（tag -f）
      for (const t of plan.tags) await withGitLockRetry(repo, () => repo.tag(t, existing));
      return { status: 'committed', commit: existing, replay: true };
    }
    if (await agentsMdTampered(repo)) return { status: 'rejected', commit: null, reason: 'agents_md_edit' };
    const head = await repo.head();
    const hardNow = await repo.blobShas(Object.keys(manifest.hard), head);
    const hardChanged = Object.keys(manifest.hard).filter((p) => (manifest.hard[p] ?? '') !== (hardNow[p] ?? ''));
    if (hardChanged.length > 0) return { status: 'stale', commit: null, reason: `hard deps changed: ${hardChanged.join(', ')}` };

    const softNow = await repo.blobShas(Object.keys(manifest.soft), head);
    const softChanged = Object.keys(manifest.soft).filter((p) => (manifest.soft[p] ?? '') !== (softNow[p] ?? ''));
    let rebased = false;
    if (softChanged.length > 0 && opts?.rebase) {
      const r = await opts.rebase(head);
      if (!r.ok) return { status: 'rejected', commit: null, reason: r.reason ?? 'rebase validators failed', ...(r.followups?.length ? { followups: r.followups } : {}) };
      rebased = true;
    }
    const validateSoft = softChanged.length > 0 && !opts?.rebase && manifest.rebaseValidators.length > 0;

    const conflict = await resolveWriteConflicts(repo, plan, head);
    if (conflict.conflicts.length > 0) return { status: 'stale', commit: null, reason: `write conflict: ${conflict.conflicts.join(', ')}` };

    let files = conflict.files;
    let tmpIdMapping: Record<string, string> | undefined;
    if (plan.resolveTmpIds) {
      const r = resolveTmpIds(files, await buildTmpIdContext(repo));
      files = r.files;
      tmpIdMapping = r.mapping;
    }

    const trailers: Record<string, string> = {
      ...plan.trailers,
      [TRAILER.task]: trailerValue,
      ...(plan.runId ? { [TRAILER.run]: plan.runId } : {}),
      ...(meta.harness ? { [TRAILER.harness]: meta.harness } : {}),
      ...(meta.model ? { [TRAILER.model]: meta.model } : {}),
      ...(meta.instructionsHash ? { [TRAILER.instructions]: meta.instructionsHash } : {}),
      ...(meta.isolation ? { [TRAILER.isolation]: meta.isolation } : {}),
      ...(meta.snapshotHash ? { [TRAILER.snapshotHash]: meta.snapshotHash } : {}),
    };
    let commit: string;
    try {
      await repo.writeFiles(files);
      if (validateSoft) {
        const r = await runRebaseValidators(repo, manifest.rebaseValidators, task, plan);
        if (!r.ok) {
          await repo.resetHard();
          return { status: 'rejected', commit: null, reason: r.reason, ...(r.followups.length ? { followups: r.followups } : {}) };
        }
        rebased = true;
      }
      commit = await withGitLockRetry(repo, async () => {
        try {
          return await repo.commit({ message: plan.message, trailers, paths: files.map((f) => f.path), tags: plan.tags });
        } catch (e) {
          if (!(e instanceof NothingToCommitError)) throw e;
          // 内容完全一致（崩溃重入或 no-op 重跑）：写一个空提交，保证 trailer 可查
          return repo.commit({ message: plan.message, trailers, paths: [], tags: plan.tags, allowEmpty: true });
        }
      });
    } catch (e) {
      // 半途失败（ENOSPC、git 错误）：清掉工作树和 index，否则下一次提交会夹带这批改动
      await repo.resetHard().catch(() => {});
      throw e;
    }
    return { status: rebased ? 'rebased' : 'committed', commit, ...(tmpIdMapping ? { tmpIdMapping } : {}) };
  });

  if ((outcome.status === 'committed' || outcome.status === 'rebased') && outcome.commit) {
    await applyDbEffects(db, plan, outcome.commit);
  }
  return outcome;
}

/** §7.7 第 7 步：dbEffects + books.head_commit + tasks.params._orch.effectsCommit（同一事务，exactly-once） */
export async function applyDbEffects(db: Db, plan: { bookId: string; taskId: string; effect?: PromotePlan['effect']; dbEffects?: PromotePlan['dbEffects'] }, commit: string): Promise<void> {
  await db.transaction(async (tx: Tx) => {
    const rows = await tx.select({ params: tasks.params }).from(tasks).where(eq(tasks.id, plan.taskId)).limit(1).for('update');
    const row = rows[0];
    const already = row ? orchOf(row).effectsCommit === commit : false;
    if (!already && plan.effect) await runDbEffect(tx, commit, plan.effect);
    else if (!already && plan.dbEffects) await plan.dbEffects(tx, commit);
    await tx.update(books).set({ headCommit: commit, updatedAt: new Date().toISOString() }).where(eq(books.id, plan.bookId));
    if (row && !already) await tx.update(tasks).set({ params: withOrch(row.params, { effectsCommit: commit }), updatedAt: new Date().toISOString() }).where(eq(tasks.id, plan.taskId));
  });
}

// ───────────────────────── owner 编辑 ─────────────────────────

export class StaleBaseError extends Error {
  constructor(public readonly path: string) {
    super(`file changed since base: ${path}`);
    this.name = 'StaleBaseError';
  }
}

/** owner 在 UI 编辑书库文件：走同一提交协议（Novelist-Owner-Edit trailer），使受影响的待执行任务失效 */
export async function commitOwnerEdit(db: Db, repo: BookRepo, bookId: string, input: { files: { path: string; content: string | null }[]; message: string; baseSha: string | null; extraTrailers?: Record<string, string> }): Promise<{ commit: string; invalidated: string[] }> {
  const commit = await withRepoLock(db, bookId, repo, async () => {
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
  });
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
