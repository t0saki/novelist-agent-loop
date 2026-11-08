/**
 * run 快照（DESIGN §4.4）：git worktree add --detach $RUN/book <base_commit>。Owner: lane B。
 * 调用方（lane F）在持仓库锁时调用 create；run 结束后 remove；每晚 prune。
 * container 档：快照内任何越界写都随 remove 丢弃，只收割 outDir（harvestOut）。
 */
import { constants as FS, promises as fs } from 'node:fs';
import path from 'node:path';
import { GitError, git, gitRaw } from './git.js';
import { P } from './layout.js';

export interface RunSnapshot {
  /** $RUN/book */
  dir: string;
  baseCommit: string;
  bookDir: string;
}

/** harvestOut 的限制：单文件与总量上限（超限文件跳过，不中断收割） */
export const HARVEST_LIMITS = { maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxFiles: 2000 } as const;

export async function createRunSnapshot(bookDir: string, baseCommit: string, dest: string): Promise<RunSnapshot> {
  const book = path.resolve(bookDir);
  const dst = path.resolve(dest);
  if (!baseCommit) throw new Error('createRunSnapshot: baseCommit required');
  await fs.mkdir(path.dirname(dst), { recursive: true });
  // 残留（同一 run 目录重试）：先移除旧 worktree 登记与目录
  try {
    await fs.lstat(dst);
    await removeRunSnapshot({ dir: dst, baseCommit, bookDir: book });
  } catch {
    // 不存在
  }
  const args = ['worktree', 'add', '--detach', '-q', dst, baseCommit];
  let added = await gitRaw(book, args);
  if (added.code !== 0 && /already registered/.test(added.stderr)) {
    // 目录已被删除、登记还留着（崩溃后 run 目录被清理）：清掉登记后重试
    await git(book, ['worktree', 'prune']);
    added = await gitRaw(book, args);
  }
  if (added.code !== 0) throw new GitError(args, added.code, added.stderr);
  // 复用 live 树的 BM25 索引（gitignored；context 会按章节内容 hash 增量校正）
  // 优先 reflink（同一文件系统上几乎零成本），不支持时退回普通复制
  try {
    const names = await fs.readdir(path.join(book, P.indexDir));
    await fs.mkdir(path.join(dst, P.indexDir), { recursive: true });
    for (const n of names) {
      const src = path.join(book, P.indexDir, n);
      if (!(await fs.lstat(src)).isFile()) continue;
      await fs.copyFile(src, path.join(dst, P.indexDir, n), FS.COPYFILE_FICLONE);
    }
  } catch {
    // 没有索引也可以，pack 会重建
  }
  return { dir: dst, baseCommit, bookDir: book };
}

export async function removeRunSnapshot(s: RunSnapshot): Promise<void> {
  const r = await gitRaw(s.bookDir, ['worktree', 'remove', '--force', '--force', s.dir]);
  if (r.code !== 0) {
    await fs.rm(s.dir, { recursive: true, force: true });
    await gitRaw(s.bookDir, ['worktree', 'prune']);
  }
}

export async function pruneWorktrees(bookDir: string): Promise<void> {
  await git(path.resolve(bookDir), ['worktree', 'prune']);
}

/**
 * 把快照里的 outDir 复制到 live 树 work/<task>/attempt-<k>/out（gitignored），返回复制的相对文件列表（POSIX、排序）。
 * 只复制普通文件：符号链接、设备文件等一律跳过（防止指向快照外）；目标目录先清空（重复收割幂等）。
 */
export async function harvestOut(outDirAbs: string, liveBookDir: string, taskId: string, attempt: number): Promise<{ stagedDir: string; files: string[] }> {
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId) || taskId.includes('..')) throw new Error(`invalid taskId: ${taskId}`);
  const stagedDir = path.join(path.resolve(liveBookDir), P.workOut(taskId, attempt));
  await fs.rm(stagedDir, { recursive: true, force: true });
  await fs.mkdir(stagedDir, { recursive: true });
  const files: string[] = [];
  let total = 0;
  const src = path.resolve(outDirAbs);
  // readdir 会跟随符号链接：out 本身被换成链接时直接视为空，否则会把快照外的目录收割进来
  const rootStat = await fs.lstat(src).catch(() => null);
  if (!rootStat?.isDirectory()) return { stagedDir, files };
  const visit = async (absDir: string, rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        await visit(abs, relPath);
        continue;
      }
      if (!e.isFile()) continue;
      if (files.length >= HARVEST_LIMITS.maxFiles) continue;
      const st = await fs.lstat(abs);
      if (!st.isFile() || st.size > HARVEST_LIMITS.maxFileBytes || total + st.size > HARVEST_LIMITS.maxTotalBytes) continue;
      total += st.size;
      const dst = path.join(stagedDir, relPath);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(abs, dst);
      files.push(relPath);
    }
  };
  await visit(src, '');
  return { stagedDir, files: files.sort() };
}
