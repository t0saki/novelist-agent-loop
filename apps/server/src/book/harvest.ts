/**
 * v3 收稿：遍历 run 快照目录（不看 git status：被忽略的目录也要看到），和 base 提交的 blob sha 比较，
 * 把新增/改动的 UTF-8 文本文件复制到 live 树 work/<task>/run-<runId>/changes/，并写 changes.json（docs/v3/DESIGN.md §3.2；p1-plan §2.6）。
 * 删除一律忽略；符号链接从不跟随；保护名单（flow/contract.ts）不收。同一快照收两次结果相同。
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HARVEST_MAX_FILE_BYTES, isProtected } from '../flow/contract.js';
import type { ChangedFile, RunChanges } from '../flow/types.js';
import { GitError, gitRaw } from './git.js';
import { gitBlobSha, safeRel } from './repo.js';
import { HARVEST_LIMITS } from './worktree.js';

const SAFE_ID_RE = /^[A-Za-z0-9._:-]+$/;

/** live 树里一次 run 的收稿目录（gitignored 的 work/ 下） */
export function runChangesDir(liveBookDir: string, taskId: string, runId: string): string {
  for (const [k, v] of [
    ['taskId', taskId],
    ['runId', runId],
  ] as const) {
    if (!SAFE_ID_RE.test(v) || v.includes('..')) throw new Error(`invalid ${k}: ${v}`);
  }
  return path.join(path.resolve(liveBookDir), 'work', taskId, `run-${runId}`);
}

/** `git ls-tree -r -z --full-tree <base>` → path → {mode, sha} */
async function baseTree(liveBookDir: string, baseCommit: string): Promise<Map<string, { mode: string; sha: string }>> {
  const args = ['ls-tree', '-r', '-z', '--full-tree', baseCommit];
  const r = await gitRaw(liveBookDir, args);
  if (r.code !== 0) throw new GitError(args, r.code, r.stderr);
  const out = new Map<string, { mode: string; sha: string }>();
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    if (type !== 'blob' || !mode || !sha) continue;
    out.set(rec.slice(tab + 1), { mode, sha });
  }
  return out;
}

/** live 仓库的 .gitignore 会拒收的路径（已跟踪的文件 check-ignore 默认不报）；committer.promoteV3 也用它做最后一道过滤 */
export async function ignoredPaths(liveBookDir: string, rels: string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set();
  const args = ['check-ignore', '-z', '--stdin'];
  // check-ignore 不接受 literal pathspec magic（GIT_ENV 默认打开）；它把参数当路径名匹配忽略规则，不做 glob
  const r = await gitRaw(liveBookDir, args, { input: `${rels.join('\0')}\0`, env: { GIT_LITERAL_PATHSPECS: '0' } });
  // 0 = 有被忽略的，1 = 一个都没有
  if (r.code !== 0 && r.code !== 1) throw new GitError(args, r.code, r.stderr);
  return new Set(r.stdout.toString('utf8').split('\0').filter(Boolean));
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Walk the snapshot FS (not git status: ignored dirs are covered), compare blob shas with `git ls-tree -r <base>` of the live repo,
 *  copy every new/changed UTF-8 text file (≤1MB, no NUL, not isProtected) to <live>/work/<task>/run-<runId>/changes/<path>,
 *  mark each copied file `ignored` when the LIVE repo's .gitignore rules ignore it,
 *  write <live>/work/<task>/run-<runId>/changes.json (RunChanges). Deletions are ignored. Symlinks never followed. */
export async function collectRunChanges(input: { snapshotDir: string; baseCommit: string; liveBookDir: string; taskId: string; runId: string }): Promise<RunChanges & { manifestFile: string }> {
  const live = path.resolve(input.liveBookDir);
  const runDir = runChangesDir(live, input.taskId, input.runId);
  const stagedDir = path.join(runDir, 'changes');
  const manifestFile = path.join(runDir, 'changes.json');
  const base = await baseTree(live, input.baseCommit);
  const snap = path.resolve(input.snapshotDir);

  const files: (ChangedFile & { buf: Buffer })[] = [];
  const skipped: RunChanges['skipped'] = [];
  let total = 0;

  // 根目录存在之后，遍历中的任何读错误（readdir / lstat / readFile / readlink）都是收稿失败，直接抛出：
  // 快照中途消失（例如另一次收稿已经删了它）时绝不能写出一份缺了正文的 changes.json
  const visit = async (absDir: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name === '.git') continue; // worktree 的 .git 指针文件
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        // 隐藏目录（.git .claude .index …）和 work/ 不进去；instructions/ 要进去，改动记为 protected
        if (e.name.startsWith('.') || relPath === 'work') continue;
        await visit(abs, relPath);
        continue;
      }
      const prior = base.get(relPath);
      if (e.isSymbolicLink()) {
        const target = await fs.readlink(abs);
        if (prior?.mode === '120000' && prior.sha === gitBlobSha(target)) continue;
        if (!isProtected(relPath)) skipped.push({ path: relPath, reason: 'symlink' });
        continue;
      }
      if (!e.isFile()) continue;
      const st = await fs.lstat(abs);
      if (!st.isFile()) continue;
      if (st.size > HARVEST_LIMITS.maxFileBytes) {
        if (!isProtected(relPath)) skipped.push({ path: relPath, reason: 'too_large' });
        continue;
      }
      const buf = await fs.readFile(abs);
      const sha = gitBlobSha(buf);
      if (prior && prior.sha === sha) continue;
      if (isProtected(relPath)) {
        skipped.push({ path: relPath, reason: 'protected' });
        continue;
      }
      if (buf.length > HARVEST_MAX_FILE_BYTES) {
        skipped.push({ path: relPath, reason: 'too_large' });
        continue;
      }
      if (buf.includes(0)) {
        skipped.push({ path: relPath, reason: 'binary' });
        continue;
      }
      try {
        utf8.decode(buf);
      } catch {
        skipped.push({ path: relPath, reason: 'not_utf8' });
        continue;
      }
      if (files.length >= HARVEST_LIMITS.maxFiles || total + buf.length > HARVEST_LIMITS.maxTotalBytes) {
        skipped.push({ path: relPath, reason: 'too_large' });
        continue;
      }
      total += buf.length;
      files.push({ path: relPath, sha, bytes: buf.length, isNew: !prior, ignored: false, buf });
    }
  };
  const rootStat = await fs.lstat(snap).catch(() => null);
  if (rootStat?.isDirectory()) await visit(snap, '');

  const ignored = await ignoredPaths(
    live,
    files.map((f) => f.path),
  );
  // 先写到同级的临时目录，写完整了再换上去：同一 run 的两次收稿不会清掉对方写了一半的暂存
  const tmpDir = path.join(path.dirname(runDir), `.run-${input.runId}.tmp-${randomUUID().slice(0, 8)}`);
  const tmpStaged = path.join(tmpDir, 'changes');
  await fs.mkdir(tmpStaged, { recursive: true });
  for (const f of files) {
    f.ignored = ignored.has(f.path);
    const dst = path.join(tmpStaged, safeRel(f.path));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, f.buf);
  }
  const changes: RunChanges = {
    schema: 'nv.v3changes/1',
    runId: input.runId,
    baseCommit: input.baseCommit,
    stagedDir,
    files: files.map(({ buf: _buf, ...rest }) => rest),
    skipped,
  };
  await fs.writeFile(path.join(tmpDir, 'changes.json'), `${JSON.stringify(changes, null, 2)}\n`);
  try {
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.rename(tmpDir, runDir);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { ...changes, manifestFile };
}

export async function readRunChanges(manifestFile: string): Promise<{ changes: RunChanges; read(rel: string): Promise<string> }> {
  const changes = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as RunChanges;
  if (changes.schema !== 'nv.v3changes/1') throw new Error(`unknown changes manifest: ${String((changes as { schema?: unknown }).schema)}`);
  return {
    changes,
    read: async (rel: string) => fs.readFile(path.join(changes.stagedDir, safeRel(rel)), 'utf8'),
  };
}
