/**
 * 网页交互登录（D5）。Owner: lane A。
 * spawn adapter.loginCommand()（device-code 流程，HOME=账号 home），stdout/stderr 实时推给 UI，
 * UI 输入框经 write() 写入子进程 stdin（管道，非 PTY；需要 TTY 的 CLI 用 `script -qfc` 包装，由 adapter 决定）。
 * 输出中提取 URL/验证码；退出码 0 且 successFiles 存在 → succeeded，并把 home 里新产生的凭据文件登记为账号 state 文件。
 * 会话 10 分钟无活动过期。输出行持久化到 login_sessions.output（环形）。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AuthMode, LoginOutputChunk, LoginSession } from '@novelist/shared';
import type { HarnessInstall } from '@novelist/shared';
import { snapshotFiles } from './home.js';
import type { HarnessAdapter, LoginCommand, ResolvedAccount } from './types.js';
import { extractUrls, maskSecret, pathExists, shQuote, stripAnsi } from './util.js';

export interface LoginHandle {
  session(): LoginSession;
  output(sinceSeq?: number): LoginOutputChunk[];
  write(text: string, newline?: boolean): void;
  cancel(): void;
  subscribe(cb: (e: { chunk?: LoginOutputChunk; session?: LoginSession }) => void): () => void;
}

export interface LoginManager {
  start(adapter: HarnessAdapter, acct: ResolvedAccount, inst: HarnessInstall, mode: AuthMode): Promise<LoginHandle>;
  get(sessionId: string): LoginHandle | null;
  list(): LoginSession[];
}

/** 登录结果（onFinished 第三个参数）：新增/变化的凭据文件 + 从输出捕获的 env 秘密 */
export interface LoginResult {
  /** 需要加密登记到账号的凭据文件（absPath 在账号 home 内） */
  files: { relPath: string; absPath: string; part: 'state' | 'config' }[];
  /** 捕获的秘密 env（如 CLAUDE_CODE_OAUTH_TOKEN）；只在内存里交给回调 */
  capturedEnv: Record<string, string>;
}

export interface LoginManagerOptions {
  onFinished?: (s: LoginSession, acct: ResolvedAccount, result: LoginResult) => Promise<void>;
  /** 无活动过期（默认 10 分钟） */
  idleMs?: number;
  /** 输出环形缓冲条数（默认 2000） */
  maxChunks?: number;
  /** 结束后保留多久（默认 30 分钟），之后从 list() 中清除 */
  retainMs?: number;
}

const CODE_RE_DEFAULT = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/g;

export function createLoginManager(opts: LoginManagerOptions): LoginManager {
  const sessions = new Map<string, LoginHandle & { endedAtMs(): number | null }>();
  const idleMs = opts.idleMs ?? 10 * 60_000;
  const maxChunks = opts.maxChunks ?? 2000;
  const retainMs = opts.retainMs ?? 30 * 60_000;

  const gc = () => {
    const now = Date.now();
    for (const [id, h] of sessions) {
      const e = h.endedAtMs();
      if (e !== null && now - e > retainMs) sessions.delete(id);
    }
  };

  return {
    async start(adapter, acct, inst, mode) {
      gc();
      const cmd = adapter.loginCommand?.(acct, inst, mode) ?? null;
      if (!cmd) throw new Error(`${adapter.id} 的 ${mode} 模式不支持网页交互登录`);
      await fs.mkdir(acct.home, { recursive: true, mode: 0o700 });
      const credRel = cmd.credentialFiles ?? (cmd.successFiles ?? []).map((relPath) => ({ relPath, part: 'state' as const }));
      const before = await snapshotFiles(acct.home, credRel.map((c) => c.relPath));
      const h = startSession(cmd, adapter, acct, mode, { idleMs, maxChunks }, async (s, captured) => {
        const after = await snapshotFiles(acct.home, credRel.map((c) => c.relPath));
        const files = credRel
          .filter((c) => after[c.relPath] !== null && after[c.relPath] !== before[c.relPath])
          .map((c) => ({ ...c, absPath: path.join(acct.home, c.relPath) }));
        if (s.state === 'succeeded') await opts.onFinished?.(s, acct, { files, capturedEnv: captured });
      });
      sessions.set(h.session().id, h);
      return h;
    },
    get(id) {
      return sessions.get(id) ?? null;
    },
    list() {
      gc();
      return [...sessions.values()].map((h) => h.session());
    },
  };
}

function startSession(
  cmd: LoginCommand,
  adapter: HarnessAdapter,
  acct: ResolvedAccount,
  _mode: AuthMode,
  o: { idleMs: number; maxChunks: number },
  finished: (s: LoginSession, captured: Record<string, string>) => Promise<void>,
): LoginHandle & { endedAtMs(): number | null } {
  const id = randomUUID();
  const session: LoginSession = {
    id,
    accountId: acct.id,
    harness: adapter.id,
    state: 'starting',
    startedAt: new Date().toISOString(),
    endedAt: null,
    urls: [],
    codes: [],
    exitCode: null,
  };
  const chunks: LoginOutputChunk[] = [];
  const subs = new Set<(e: { chunk?: LoginOutputChunk; session?: LoginSession }) => void>();
  let seq = 0;
  let endedAt: number | null = null;
  let lastActivity = Date.now();
  const captured: Record<string, string> = {};
  let rawAll = '';

  const emitSession = () => {
    const s = { ...session };
    for (const cb of subs) cb({ session: s });
  };
  const push = (stream: LoginOutputChunk['stream'], text: string) => {
    if (!text) return;
    const chunk: LoginOutputChunk = { seq: ++seq, ts: new Date().toISOString(), stream, text };
    chunks.push(chunk);
    if (chunks.length > o.maxChunks) chunks.splice(0, chunks.length - o.maxChunks);
    for (const cb of subs) cb({ chunk });
  };
  const setState = (st: LoginSession['state']) => {
    if (session.state === st) return;
    session.state = st;
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(st)) {
      session.endedAt = new Date().toISOString();
      endedAt = Date.now();
    }
    emitSession();
  };

  // 进程
  let argv = cmd.argv;
  if (cmd.tty) {
    const inner = `stty cols 1000 rows 50 2>/dev/null; exec ${cmd.argv.map(shQuote).join(' ')}`;
    argv = ['script', '-qfec', inner, '/dev/null'];
  }
  const env = { TERM: cmd.tty ? 'xterm-256color' : 'dumb', COLUMNS: '1000', NO_COLOR: '1', ...cmd.env };
  let child: ChildProcess;
  try {
    child = spawn(argv[0]!, argv.slice(1), { cwd: cmd.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  } catch (e) {
    push('system', `启动失败：${(e as Error).message}\n`);
    setState('failed');
    return makeHandle();
  }
  push('system', `$ ${cmd.argv.join(' ')}\n`);

  const redact = (s: string): string => {
    let out = s;
    for (const v of Object.values(captured)) out = out.split(v).join(`${maskSecret(v)}（已捕获）`);
    return out;
  };
  const scan = (raw: string) => {
    rawAll = (rawAll + raw).slice(-512 * 1024);
    const clean = stripAnsi(rawAll);
    for (const ce of cmd.captureEnv ?? []) {
      const re = new RegExp(ce.pattern.source, ce.pattern.flags.replace('g', ''));
      const m = clean.match(re);
      if (m && !captured[ce.name]) captured[ce.name] = m[0];
    }
    let changed = false;
    for (const u of extractUrls(raw)) {
      if (!session.urls.includes(u)) {
        session.urls.push(u);
        changed = true;
      }
    }
    const codeRe = cmd.codePattern ? new RegExp(cmd.codePattern.source, cmd.codePattern.flags.includes('g') ? cmd.codePattern.flags : `${cmd.codePattern.flags}g`) : CODE_RE_DEFAULT;
    for (const m of stripAnsi(raw).matchAll(codeRe)) {
      const c = m[1] ?? m[0];
      if (!session.codes.includes(c) && !session.urls.some((u) => u.includes(c))) {
        session.codes.push(c);
        changed = true;
      }
    }
    if (session.state === 'starting' && (session.urls.length || session.codes.length)) {
      session.state = 'waiting_user';
      changed = true;
    }
    if (changed) emitSession();
  };

  // 行缓冲：完整行立即发出；不带换行的提示（“Paste code here >”）300ms 后冲出
  const mkStream = (name: 'stdout' | 'stderr') => {
    let buf = '';
    let timer: NodeJS.Timeout | null = null;
    const decoder = new StringDecoder('utf8');
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (buf) push(name, redact(stripAnsi(buf)));
      buf = '';
    };
    return {
      data(d: Buffer) {
        lastActivity = Date.now();
        const raw = decoder.write(d);
        scan(raw);
        buf += raw;
        const i = buf.lastIndexOf('\n');
        if (i >= 0) {
          const head = buf.slice(0, i + 1);
          buf = buf.slice(i + 1);
          push(name, redact(stripAnsi(head)));
        }
        if (timer) clearTimeout(timer);
        if (buf) timer = setTimeout(flush, 300);
      },
      flush,
    };
  };
  const so = mkStream('stdout');
  const se = mkStream('stderr');
  child.stdout?.on('data', so.data);
  child.stderr?.on('data', se.data);
  child.stdin?.on('error', () => {});

  const idleTimer = setInterval(() => {
    if (endedAt !== null) return;
    if (Date.now() - lastActivity > o.idleMs) {
      push('system', `会话超时（${Math.round(o.idleMs / 60_000)} 分钟无活动），已终止。\n`);
      killTree('SIGKILL');
      setState('expired');
    }
  }, Math.min(5000, Math.max(50, o.idleMs / 4)));

  function killTree(sig: NodeJS.Signals) {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    }
  }

  child.on('error', (e) => {
    push('system', `进程错误：${e.message}\n`);
  });
  const finalize = (st: LoginSession['state']) => {
    session.state = st;
    session.endedAt = new Date().toISOString();
    endedAt = Date.now();
    emitSession();
  };
  child.on('close', async (code) => {
    clearInterval(idleTimer);
    so.flush();
    se.flush();
    session.exitCode = code;
    if (session.state === 'cancelled' || session.state === 'expired') {
      emitSession();
      return;
    }
    let ok = code === 0;
    if (ok && cmd.successFiles?.length) {
      for (const f of cmd.successFiles) if (!(await pathExists(path.join(acct.home, f)))) ok = false;
    }
    if (ok && cmd.captureEnv?.length) ok = cmd.captureEnv.every((c) => !!captured[c.name]);
    if (ok) {
      try {
        await finished({ ...session, state: 'succeeded' }, captured);
        push('system', '登录成功，凭据已登记到账号。\n');
      } catch (e) {
        ok = false;
        push('system', `登录成功但登记凭据失败：${(e as Error).message}\n`);
      }
    } else push('system', `登录未完成（退出码 ${code}）。\n`);
    finalize(ok ? 'succeeded' : 'failed');
  });
  if (session.state === 'starting') emitSession();

  function makeHandle(): LoginHandle & { endedAtMs(): number | null } {
    return {
      session: () => ({ ...session, urls: [...session.urls], codes: [...session.codes] }),
      output: (sinceSeq = 0) => chunks.filter((c) => c.seq > sinceSeq),
      write(text: string, newline = true) {
        if (endedAt !== null || !child?.stdin || child.stdin.destroyed) return;
        lastActivity = Date.now();
        const eol = newline ? (cmd.tty ? '\r' : '\n') : '';
        child.stdin.write(text + eol);
        push('input', `${text.length > 12 ? `${text.slice(0, 4)}…（${text.length} 字符）` : '***'}\n`);
      },
      cancel() {
        if (endedAt !== null) return;
        push('system', '已取消。\n');
        setState('cancelled');
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), 2000).unref();
      },
      subscribe(cb) {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      endedAtMs: () => endedAt,
    };
  }
  return makeHandle();
}
