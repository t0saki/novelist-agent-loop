/**
 * 系统 git 的最小封装（lane B 内部）。不经 shell；固定 -c 选项屏蔽用户全局配置里的签名、hooks、pager。
 */
import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim().slice(0, 500)}`);
  }
}

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

const BASE_ARGS = [
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.quotepath=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'advice.detachedHead=false',
  // 书目录可能由别的 uid 创建（卷挂载、容器切换用户），不让 git 因 dubious ownership 拒绝
  '-c',
  'safe.directory=*',
];

export const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Novelist',
  GIT_AUTHOR_EMAIL: 'novelist@localhost',
  GIT_COMMITTER_NAME: 'Novelist',
  GIT_COMMITTER_EMAIL: 'novelist@localhost',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
  // 不读用户/系统级 git 配置（excludesFile、commit.template 等都会影响提交结果）
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  // 路径一律按字面量：用户上传的文件名可能含 [ ] * 这类 glob 字符
  GIT_LITERAL_PATHSPECS: '1',
};

/** 去掉继承来的 GIT_*（例如 GIT_DIR、GIT_INDEX_FILE：从 git hook 或 worktree 里启动时会把操作带到别的仓库） */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return env;
}

export function gitRaw(cwd: string, args: string[], opts: { input?: string | Buffer; env?: Record<string, string> } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...BASE_ARGS, ...args], {
      cwd,
      env: { ...cleanEnv(), ...GIT_ENV, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** 成功返回 stdout（utf8，去掉末尾换行）；失败抛 GitError */
export async function git(
  cwd: string,
  args: string[],
  opts: { input?: string | Buffer; env?: Record<string, string>; allowCodes?: number[] } = {},
): Promise<string> {
  const r = await gitRaw(cwd, args, opts);
  if (r.code !== 0 && !(opts.allowCodes ?? []).includes(r.code)) throw new GitError(args, r.code, r.stderr);
  return r.stdout.toString('utf8').replace(/\n$/, '');
}

/**
 * `git cat-file --batch`：一次读取多个 `rev:path` 对象。缺失的对象返回 null。
 * 输出格式：`<sha> <type> <size>\n<content>\n` 或 `<name> missing\n`。
 */
export async function catFileBatch(cwd: string, specs: string[]): Promise<(Buffer | null)[]> {
  if (specs.length === 0) return [];
  for (const s of specs) if (/[\r\n]/.test(s)) throw new Error(`invalid object spec: ${s}`);
  const r = await gitRaw(cwd, ['cat-file', '--batch'], { input: `${specs.join('\n')}\n` });
  if (r.code !== 0) throw new GitError(['cat-file', '--batch'], r.code, r.stderr);
  const buf = r.stdout;
  const res: (Buffer | null)[] = [];
  let pos = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new Error('cat-file --batch: truncated output');
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      res.push(null);
      continue;
    }
    const parts = header.split(' ');
    const type = parts[1];
    const size = Number(parts[2]);
    const content = buf.subarray(pos, pos + size);
    pos += size + 1;
    res.push(type === 'blob' ? Buffer.from(content) : null);
  }
  return res;
}
