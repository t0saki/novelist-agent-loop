/**
 * run 快照（DESIGN §4.4）：git worktree add --detach $RUN/book <base_commit>。Owner: lane B。
 * 调用方（lane F）在持仓库锁时调用 create；run 结束后 remove；每晚 prune。
 * 收稿见 book/harvest.ts（比较快照与 base commit，改动复制到 live 树 work/ 下）。
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

/** 收稿的限制：单文件与总量上限（超限文件跳过，不中断收割） */
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
