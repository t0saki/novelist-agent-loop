/**
 * 书仓库 git 操作（DESIGN §4.4、§7.7）。Owner: lane B。
 * 实现直接 spawn 系统 git（不引入 libgit2）。所有写操作只能由 committer（lane F）在持锁状态下调用。
 * 持久性：core.fsync=all；写文件 = 临时文件 + fsync + rename（+ fsync 目录）。
 * 工作树读取（rev 省略）直接走文件系统，因此 openRepo 也可以用在不是 git 仓库的目录上（只读用途，例如合成夹具）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as FS, promises as fs } from 'node:fs';
import path from 'node:path';
import { isSeq, parseDocument, stringify as yamlStringify } from 'yaml';
import { zBookConfig, type BookConfigInput } from '@novelist/shared';
import { catFileBatch, git, gitRaw } from './git.js';
import { BOOK_DIRS, BOOK_GITIGNORE, P } from './layout.js';
import { FS_CONCURRENCY, mapLimit } from './limit.js';
import { TRAILER, formatTrailers, parseTrailers } from './trailers.js';

export interface FileChange {
  /** 相对书根 */
  path: string;
  /** null = 删除 */
  content: string | Buffer | null;
}

export interface CommitInfo {
  sha: string;
  ts: string;
  subject: string;
  body: string;
  trailers: Record<string, string>;
  tags: string[];
}

export class NothingToCommitError extends Error {
  constructor() {
    super('nothing to commit');
  }
}

export interface BookRepo {
  readonly dir: string;
  head(): Promise<string>;
  /** rev 省略 = 工作树；给 rev 时用 git show rev:path。不存在返回 null */
  readFile(rel: string, rev?: string): Promise<string | null>;
  exists(rel: string, rev?: string): Promise<boolean>;
  /**
   * 列目录。recursive=true：返回目录下全部文件（相对书根的路径，排序）。
   * recursive=false：返回直接子项，子目录带结尾 `/`。目录不存在返回 []。
   */
  list(dirRel: string, opts?: { rev?: string; recursive?: boolean }): Promise<string[]>;
  /** path → blob sha（manifest / stale check 用）；不存在的 path 映射为 '' */
  blobShas(rels: string[], rev?: string): Promise<Record<string, string>>;
  /** 原子写入工作树（不提交） */
  writeFiles(changes: FileChange[]): Promise<void>;
  /** git add -A（限定 paths）+ commit（带 trailer）+ 可选 tags；返回新 sha。没有改动且未 allowEmpty → NothingToCommitError */
  commit(input: { message: string; trailers: Record<string, string>; paths?: string[]; tags?: string[]; allowEmpty?: boolean }): Promise<string>;
  /** git log --grep "Novelist-Task: <id>"（崩溃恢复）；返回最新匹配 sha */
  findCommitByTrailer(key: string, value: string): Promise<string | null>;
  log(opts: { limit: number; cursor?: string; path?: string }): Promise<{ items: CommitInfo[]; nextCursor: string | null }>;
  /** 两个提交之间变化的路径（from 为空串 = 从空树起） */
  changedPaths(from: string, to: string): Promise<string[]>;
  /** git reset --hard HEAD && git clean -fd -e work/ -e .index/ -e .cache/ -e views/（§7.7） */
  resetHard(): Promise<void>;
  /** 工作树是否干净（忽略 gitignored） */
  isClean(): Promise<boolean>;
  tag(name: string, rev?: string): Promise<void>;
  tags(pattern?: string): Promise<string[]>;
  fsck(): Promise<{ ok: boolean; detail: string }>;
  /** 批量读取（rev 给出时用一次 cat-file --batch）。lane B 扩展，可选实现 */
  readMany?(rels: string[], rev?: string): Promise<(string | null)[]>;
}

/** 规范化并校验相对路径：禁止绝对路径与 `..` 越界 */
export function safeRel(rel: string): string {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error(`invalid repo path: ${rel}`);
  const norm = path.posix.normalize(p);
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) throw new Error(`path escapes repo: ${rel}`);
  if (norm === '.git' || norm.startsWith('.git/')) throw new Error(`refusing to touch .git: ${rel}`);
  return norm;
}

/** git blob sha1（与 `git hash-object` 一致） */
export function gitBlobSha(content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isFile();
  } catch {
    return false;
  }
}

async function walk(absDir: string, relDir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(path.join(absDir, e.name), rel, out);
    else if (e.isFile() || e.isSymbolicLink()) out.push(rel);
  }
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const h = await fs.open(dir, FS.O_RDONLY);
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch {
    // 某些文件系统不支持目录 fsync
  }
}

/** 原子写一个文件：同目录临时文件 → fsync → rename → fsync 目录 */
export async function atomicWrite(abs: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.nvtmp-${randomBytes(6).toString('hex')}`);
  const h = await fs.open(tmp, 'w', 0o644);
  try {
    await h.writeFile(content);
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  await fsyncDir(dir);
}

class GitBookRepo implements BookRepo {
  constructor(readonly dir: string) {}

  private abs(rel: string): string {
    return path.join(this.dir, safeRel(rel));
  }

  async head(): Promise<string> {
    const r = await gitRaw(this.dir, ['rev-parse', '--verify', '-q', 'HEAD']);
    return r.code === 0 ? r.stdout.toString('utf8').trim() : '';
  }

  async readFile(rel: string, rev?: string): Promise<string | null> {
    if (rev === undefined) {
      try {
        return await fs.readFile(this.abs(rel), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'EISDIR' || (e as NodeJS.ErrnoException).code === 'ENOTDIR')
          return null;
        throw e;
      }
    }
    const [buf] = await catFileBatch(this.dir, [`${rev}:${safeRel(rel)}`]);
    return buf ? buf.toString('utf8') : null;
  }

  async readMany(rels: string[], rev?: string): Promise<(string | null)[]> {
    if (rev === undefined) return mapLimit(rels, FS_CONCURRENCY, (r) => this.readFile(r));
    const out: (string | null)[] = [];
    for (let i = 0; i < rels.length; i += 2000) {
      const chunk = rels.slice(i, i + 2000);
      const bufs = await catFileBatch(
        this.dir,
        chunk.map((r) => `${rev}:${safeRel(r)}`),
      );
      for (const b of bufs) out.push(b ? b.toString('utf8') : null);
    }
    return out;
  }

  async exists(rel: string, rev?: string): Promise<boolean> {
    if (rev === undefined) {
      try {
        await fs.lstat(this.abs(rel));
        return true;
      } catch {
        return false;
      }
    }
    const r = await gitRaw(this.dir, ['cat-file', '-e', `${rev}:${safeRel(rel)}`]);
    return r.code === 0;
  }

  async list(dirRel: string, opts: { rev?: string; recursive?: boolean } = {}): Promise<string[]> {
    const d = dirRel === '' || dirRel === '.' ? '' : safeRel(dirRel).replace(/\/$/, '');
    if (opts.rev === undefined) {
      const absDir = d ? path.join(this.dir, d) : this.dir;
      if (opts.recursive) {
        const out: string[] = [];
        await walk(absDir, d, out);
        return out.sort();
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((e) => e.name !== '.git')
        .map((e) => (d ? `${d}/` : '') + e.name + (e.isDirectory() ? '/' : ''))
        .sort();
    }
    const args = ['ls-tree', '-z', '--full-tree'];
    if (opts.recursive) args.push('-r');
    args.push(opts.rev, '--', d ? `${d}/` : '.');
    const r = await gitRaw(this.dir, args);
    if (r.code !== 0) return [];
    const out: string[] = [];
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const meta = rec.slice(0, tab).split(' ');
      const p = rec.slice(tab + 1);
      out.push(meta[1] === 'tree' ? `${p}/` : p);
    }
    return out.sort();
  }

  async blobShas(rels: string[], rev?: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const r of rels) out[r] = '';
    if (rels.length === 0) return out;
    if (rev === undefined) {
      await mapLimit(rels, FS_CONCURRENCY, async (r) => {
        try {
          const abs = this.abs(r);
          if (await isFile(abs)) out[r] = gitBlobSha(await fs.readFile(abs));
        } catch {
          out[r] = '';
        }
      });
      return out;
    }
    const norm = new Map<string, string[]>();
    for (const r of rels) {
      const n = safeRel(r);
      norm.set(n, [...(norm.get(n) ?? []), r]);
    }
    const keys = [...norm.keys()];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const res = await gitRaw(this.dir, ['ls-tree', '-z', '--full-tree', rev, '--', ...chunk]);
      if (res.code !== 0) continue;
      for (const rec of res.stdout.toString('utf8').split('\0')) {
        if (!rec) continue;
        const tab = rec.indexOf('\t');
        const meta = rec.slice(0, tab).split(' ');
        const p = rec.slice(tab + 1);
        if (meta[1] !== 'blob') continue;
        for (const orig of norm.get(p) ?? []) out[orig] = meta[2] ?? '';
      }
    }
    return out;
  }

  async writeFiles(changes: FileChange[]): Promise<void> {
    for (const c of changes) {
      const abs = this.abs(c.path);
      if (c.content === null) {
        await fs.rm(abs, { force: true });
        await fsyncDir(path.dirname(abs));
      } else {
        await atomicWrite(abs, c.content);
      }
    }
  }

  async commit(input: { message: string; trailers: Record<string, string>; paths?: string[]; tags?: string[]; allowEmpty?: boolean }): Promise<string> {
    if (input.paths && input.paths.length > 0) {
      const ps = await this.addablePaths(input.paths.map(safeRel));
      for (let i = 0; i < ps.length; i += 500) await git(this.dir, ['add', '-A', '--', ...ps.slice(i, i + 500)]);
    } else if (!input.paths) {
      await git(this.dir, ['add', '-A']);
    }
    const staged = await gitRaw(this.dir, ['diff', '--cached', '--quiet']);
    const hasHead = (await this.head()) !== '';
    if (staged.code === 0 && hasHead && !input.allowEmpty) throw new NothingToCommitError();
    const trailers = formatTrailers(input.trailers);
    const msg = `${input.message.replace(/\s+$/, '')}${trailers ? `\n\n${trailers}` : ''}\n`;
    const args = ['commit', '-q', '--no-verify', '-F', '-'];
    if (input.allowEmpty || (staged.code === 0 && !hasHead)) args.push('--allow-empty');
    await git(this.dir, args, { input: msg });
    const sha = await this.head();
    for (const t of input.tags ?? []) await this.tag(t, sha);
    return sha;
  }

  /** git add 对既不在工作树、也未被跟踪的路径会报错；删除一个从未入库的文件时（content:null）要滤掉 */
  private async addablePaths(ps: string[]): Promise<string[]> {
    const missing = new Set<string>();
    await mapLimit(ps, FS_CONCURRENCY, async (p) => {
      try {
        await fs.lstat(path.join(this.dir, p));
      } catch {
        missing.add(p);
      }
    });
    if (missing.size === 0) return ps;
    const list = [...missing];
    const tracked: string[] = [];
    for (let i = 0; i < list.length; i += 500) {
      const out = await git(this.dir, ['ls-files', '-z', '--', ...list.slice(i, i + 500)]);
      tracked.push(...out.split('\0').filter(Boolean));
    }
    const isTracked = (p: string) => tracked.some((t) => t === p || t.startsWith(`${p}/`));
    return ps.filter((p) => !missing.has(p) || isTracked(p));
  }

  async findCommitByTrailer(key: string, value: string): Promise<string | null> {
    if (!(await this.head())) return null;
    // 不限条数：--grep 是子串匹配，task-1 会连带命中 task-10…；限条数可能把真正的目标挤出结果
    const r = await gitRaw(this.dir, ['log', '--fixed-strings', `--grep=${key}: ${value}`, '--format=%H%x1f%B%x1e']);
    if (r.code !== 0) return null;
    for (const rec of r.stdout.toString('utf8').split('\x1e')) {
      const t = rec.replace(/^\n+/, '');
      if (!t) continue;
      const i = t.indexOf('\x1f');
      const sha = t.slice(0, i);
      const tr = parseTrailers(t.slice(i + 1));
      if (tr[key] === value) return sha;
    }
    return null;
  }

  async log(opts: { limit: number; cursor?: string; path?: string }): Promise<{ items: CommitInfo[]; nextCursor: string | null }> {
    if (!(await this.head())) return { items: [], nextCursor: null };
    const limit = Math.max(1, Math.min(opts.limit, 1000));
    const args = ['log', '-n', String(limit + 1 + (opts.cursor ? 1 : 0)), '--format=%H%x1f%cI%x1f%D%x1f%B%x1e', '--decorate=full'];
    args.push(opts.cursor ?? 'HEAD');
    if (opts.path) args.push('--', safeRel(opts.path));
    const r = await gitRaw(this.dir, args);
    if (r.code !== 0) return { items: [], nextCursor: null };
    const items: CommitInfo[] = [];
    for (const rec of r.stdout.toString('utf8').split('\x1e')) {
      const t = rec.replace(/^\n+/, '');
      if (!t) continue;
      const [sha = '', ts = '', refs = '', ...rest] = t.split('\x1f');
      const raw = rest.join('\x1f').replace(/\s+$/, '');
      const nl = raw.indexOf('\n');
      const subject = nl < 0 ? raw : raw.slice(0, nl);
      const body = nl < 0 ? '' : raw.slice(nl + 1).replace(/^\n+/, '');
      const tagList = refs
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('tag: refs/tags/'))
        .map((s) => s.slice('tag: refs/tags/'.length))
        .sort();
      items.push({ sha, ts, subject, body, trailers: parseTrailers(raw), tags: tagList });
    }
    if (opts.cursor && items[0]?.sha === opts.cursor) items.shift();
    const page = items.slice(0, limit);
    const nextCursor = items.length > limit ? (page[page.length - 1]?.sha ?? null) : null;
    return { items: page, nextCursor };
  }

  async changedPaths(from: string, to: string): Promise<string[]> {
    if (!from) {
      const r = await git(this.dir, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', to]);
      return r.split('\0').filter(Boolean).sort();
    }
    const r = await git(this.dir, ['diff', '--name-only', '-z', '--no-renames', from, to]);
    return r.split('\0').filter(Boolean).sort();
  }

  async resetHard(): Promise<void> {
    if (await this.head()) await git(this.dir, ['reset', '-q', '--hard', 'HEAD']);
    await git(this.dir, ['clean', '-fdq', '-e', 'work/', '-e', '.index/', '-e', '.cache/', '-e', 'views/']);
  }

  async isClean(): Promise<boolean> {
    const r = await git(this.dir, ['status', '--porcelain', '-z', '--untracked-files=all']);
    return r === '';
  }

  async tag(name: string, rev = 'HEAD'): Promise<void> {
    await git(this.dir, ['tag', '-f', name, rev]);
  }

  async tags(pattern?: string): Promise<string[]> {
    const r = await git(this.dir, ['tag', '-l', ...(pattern ? [pattern] : [])]);
    return r.split('\n').filter(Boolean).sort();
  }

  async fsck(): Promise<{ ok: boolean; detail: string }> {
    const r = await gitRaw(this.dir, ['fsck', '--no-progress', '--no-dangling']);
    return { ok: r.code === 0, detail: (r.stderr + r.stdout.toString('utf8')).trim() };
  }
}

export function openRepo(dir: string): BookRepo {
  return new GitBookRepo(path.resolve(dir));
}

async function gitInit(dir: string): Promise<void> {
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'core.fsync', 'all']);
  await git(dir, ['config', 'core.quotepath', 'false']);
  await git(dir, ['config', 'user.name', 'Novelist']);
  await git(dir, ['config', 'user.email', 'novelist@localhost']);
  await git(dir, ['config', 'gc.auto', '256']);
}

export const ROOT_AGENTS_PLACEHOLDER = '本文件由 Novelist 生成；你的书层指令在 instructions/AGENTS.md\n';
const INSTRUCTIONS_TEMPLATE = '<!-- 书层指令（归你所有）：在这里写本书专属的要求。Novelist 原样传递、不改写不过滤；书层位于指令栈最后，优先级最高。 -->\n';

/** book.yaml 文本：scale 的区间写成行内序列（设置页表单按单行读写） */
function bookYamlText(config: Record<string, unknown>): string {
  const doc = parseDocument(yamlStringify(config, { lineWidth: 0 }));
  for (const key of ['volumes', 'chapters_per_volume']) {
    const node = doc.getIn(['scale', key], true);
    if (isSeq(node)) node.flow = true;
  }
  return doc.toString({ lineWidth: 0 });
}

/**
 * 初始化书仓库：目录树、.gitignore、book.yaml、bible/premise.md（种子原样写入）、instructions/AGENTS.md（空模板）、
 * .claude/skills → ../.agents/skills 软链；首个 commit 带 Novelist-Task: book.init。
 * book.yaml 只写调用方显式给出的键（加 schema），默认值不固化。
 */
export async function initBookRepo(dir: string, init: { config: BookConfigInput; premise: string }): Promise<{ repo: BookRepo; commit: string }> {
  const parsed = zBookConfig.safeParse(init.config);
  if (!parsed.success) throw new Error(`invalid book config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const abs = path.resolve(dir);
  await fs.mkdir(abs, { recursive: true });
  const existing = (await fs.readdir(abs)).filter((n) => n !== '.' && n !== '..');
  if (existing.length > 0) throw new Error(`book dir not empty: ${abs}`);
  await gitInit(abs);
  for (const d of BOOK_DIRS) await fs.mkdir(path.join(abs, d), { recursive: true });

  const { schema: _schema, ...rest } = init.config as Record<string, unknown>;
  void _schema;
  const yamlDoc = bookYamlText({ schema: 'nv.book/1', ...rest });
  const repo = openRepo(abs);
  await repo.writeFiles([
    { path: P.gitignore, content: `${BOOK_GITIGNORE.join('\n')}\n` },
    { path: P.bookYaml, content: yamlDoc },
    { path: P.premise, content: init.premise },
    { path: P.instructionsAgents, content: INSTRUCTIONS_TEMPLATE },
    { path: P.agentsMd, content: ROOT_AGENTS_PLACEHOLDER },
    { path: `${P.skillsDir}/.gitkeep`, content: '' },
    { path: P.overrides, content: '' },
  ]);
  await fs.mkdir(path.join(abs, '.claude'), { recursive: true });
  await fs.rm(path.join(abs, P.claudeSkillsLink), { force: true, recursive: true });
  await fs.symlink('../.agents/skills', path.join(abs, P.claudeSkillsLink));
  const commit = await repo.commit({ message: `book: init ${parsed.data.slug}`, trailers: { [TRAILER.task]: 'book.init' } });
  return { repo, commit };
}

/** 通用：初始化一个普通 git 仓库（$DATA/instructions/global、$DATA/genres 用）。已存在则不动；无提交时补一个空的初始提交 */
export async function ensureGitRepo(dir: string): Promise<void> {
  const abs = path.resolve(dir);
  await fs.mkdir(abs, { recursive: true });
  let isRepo = false;
  try {
    await fs.stat(path.join(abs, '.git'));
    isRepo = true;
  } catch {
    isRepo = false;
  }
  if (!isRepo) await gitInit(abs);
  const repo = openRepo(abs);
  if (!(await repo.head())) await repo.commit({ message: 'init', trailers: { [TRAILER.task]: 'repo.init' }, allowEmpty: true });
}
