/**
 * lane A 内部工具：文件、hash、进程、PATH 查找、ANSI 清洗、秘密打码、semver 区间。Owner: lane A。
 * 不被其他 lane 直接 import（经 index.ts 只导出少量通用函数）。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T = unknown>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 原子写：tmp + rename；mode 默认 0644 */
export async function atomicWrite(p: string, content: string | Buffer, mode = 0o644): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, content, { mode });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, p);
}

export function sha256Buf(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}

export function sha256FileImpl(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** 在 dirs（优先）与 PATH 中查找可执行文件 */
export function whichSync(bin: string, dirs: string[] = [], envPath = process.env.PATH ?? ''): string | null {
  if (path.isAbsolute(bin)) return isExecutable(bin) ? bin : null;
  const candidates = [...dirs, ...envPath.split(path.delimiter)].filter(Boolean);
  for (const d of candidates) {
    const p = path.join(d, bin);
    if (isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** 从任意输出中取第一个 semver 样式版本号（含预发布后缀） */
export function parseVersion(out: string): string | null {
  const m = out.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return m ? m[1]! : null;
}

type SemVer = { major: number; minor: number; patch: number; pre: string[] };
function parseSemver(v: string): SemVer | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ? m[4].split('.') : [] };
}
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return a.localeCompare(b);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
/** 支持 "*"、">=a"、">=a <b"、"<b"、"=a"、"a"（空格分隔为 AND，|| 为 OR） */
export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (!r || r === '*') return true;
  return r.split('||').some((alt) =>
    alt
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((c) => {
        const m = c.match(/^(>=|<=|>|<|=)?(.+)$/);
        if (!m) return false;
        const cmp = compareSemver(version, m[2]!);
        switch (m[1]) {
          case '>=':
            return cmp >= 0;
          case '<=':
            return cmp <= 0;
          case '>':
            return cmp > 0;
          case '<':
            return cmp < 0;
          default:
            return cmp === 0;
        }
      }),
  );
}

// ───────── ANSI / 终端输出清洗 ─────────
// OSC（含 OSC 8 超链接）：ESC ] … (BEL | ESC \)；CSI：ESC [ … final；其他 2 字符 ESC 序列
// biome-ignore lint/suspicious/noControlCharactersInRegex: 终端控制序列
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 终端控制序列
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 终端控制序列
const ESC2_RE = /\x1b[@-Z\\-_=>78]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** 去掉终端控制序列；\r\n → \n；孤立 \r 视为换行（进度条覆盖行） */
export function stripAnsi(s: string): string {
  return s
    .replace(OSC_RE, '')
    .replace(CSI_RE, (m) => (/^.\[\d*G$/.test(m) ? ' ' : ''))
    .replace(ESC2_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CTRL_RE, '');
}

/** 提取 URL（同时看 OSC 8 超链接参数里的 URL） */
export function extractUrls(raw: string): string[] {
  const out = new Set<string>();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8
  for (const m of raw.matchAll(/\x1b\]8;[^;]*;(https?:\/\/[^\x07\x1b]+)/g)) out.add(m[1]!);
  for (const m of stripAnsi(raw).matchAll(/https?:\/\/[^\s"'<>`)\]]+/g)) out.add(m[0].replace(/[.,;:]+$/, ''));
  return [...out];
}

// ───────── 秘密打码 ─────────
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 6) continue;
    out = out.split(s).join(maskSecret(s));
  }
  return out;
}
export function maskSecret(s: string): string {
  return s.length <= 8 ? '***' : `${s.slice(0, 4)}***${s.slice(-2)}`;
}

/** argv 预览：秘密打码 + 长参数截断（developer_instructions 可达 100KB） */
export function argvPreview(argv: string[], secrets: Iterable<string>, maxArg = 240): string[] {
  const list = [...secrets];
  return argv.map((a) => {
    const r = redactSecrets(a, list);
    return r.length > maxArg ? `${r.slice(0, maxArg)}…(${Buffer.byteLength(a)} bytes)` : r;
  });
}

/** POSIX shell 单引号转义（script -c 包装用） */
export function shQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ───────── 进程身份（reattach 用） ─────────
export function procStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 字段可能含空格/括号：取最后一个 ')' 之后
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // rest[0] 是 state（第 3 字段）；starttime 是第 22 字段 → rest[19]
    return rest[19] ?? null;
  } catch {
    return null;
  }
}
export function bootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return null;
  }
}
export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** glob（只支持 * 与 **）→ 正则，用于 out/ 声明集匹配 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** 递归列出目录下所有文件（相对路径，posix 分隔） */
export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  }
  await walk(root, '');
  return out.sort();
}

/** 判断 p 是否在 root 之内（含相等） */
export function isInside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function existsSyncSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
