/**
 * 全系统 e2e，崩溃恢复（P3 WP-4，§7）：真实 `novelist serve` 子进程、真实 HTTP、磁盘 PGlite、fake harness（目录模式）。
 * 开一本中篇（新流程）→ 第一次运行（开书）写到一半时 SIGKILL serve → 同一个 $DATA 重启 →
 * 运行要么接回来、要么记为丢失，没收完的稿都被收掉（pending 清空）→ 书至少写完两批 →
 * 每章恰好一个提交（带 Novelist-Task / Novelist-Part）、工作区干净、没有残留的 nv-shim / fake 进程。
 *
 * 不依赖 dist：用 tsx + `source` 条件直接跑 src/cli.ts。全程一到两分钟。
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRAILER } from '../src/book/index.js';

const execFileP = promisify(execFile);
const SERVER_DIR = path.resolve(import.meta.dirname, '..');
const ADMIN_PASSWORD = 'e2e-admin-password';
const SLUG = 'e2e-restart';
const TICK_MS = 250;

let dataDir: string;
let port: number;
let base: string;
let serverLog: string;
let proc: ChildProcess | null = null;
let cookie = '';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function tailLog(n = 4000): Promise<string> {
  return (await fs.readFile(serverLog, 'utf8').catch(() => '')).slice(-n);
}

async function startServer(): Promise<void> {
  const out = createWriteStream(serverLog, { flags: 'a' });
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/cli.ts', 'serve'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=768',
      NOVELIST_DATA_DIR: dataDir,
      // CI 的真实 Postgres 步骤设置它；没设时用 $DATA 下的 PGlite
      ...(process.env.NOVELIST_E2E_DATABASE_URL ? { NOVELIST_DATABASE_URL: process.env.NOVELIST_E2E_DATABASE_URL } : {}),
      NOVELIST_FAKE_HARNESS: '1',
      NOVELIST_ISOLATION: 'container',
      NOVELIST_ADMIN_PASSWORD: ADMIN_PASSWORD,
      NOVELIST_HOST: '127.0.0.1',
      NOVELIST_LISTEN_PORT: String(port),
      NOVELIST_INSECURE_COOKIES: '1',
      NOVELIST_LOG_LEVEL: 'warn',
      NOVELIST_SCHEDULER_TICK_MS: String(TICK_MS),
      NOVELIST_WEB_DIST: path.join(dataDir, 'no-web'),
    },
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  proc = child;
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${await tailLog()}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* 还没监听 */
    }
    await sleep(200);
  }
  throw new Error(`server did not start: ${await tailLog()}`);
}

async function stopServer(signal: NodeJS.Signals): Promise<number | null> {
  const child = proc;
  proc = null;
  if (!child || child.exitCode !== null) return child?.exitCode ?? null;
  child.kill(signal);
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 95_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// biome-ignore lint/suspicious/noExplicitAny: e2e 读任意 JSON
async function http(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie, origin: base },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0] as string;
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 不是 JSON */
  }
  return { status: r.status, json, text };
}

// biome-ignore lint/suspicious/noExplicitAny: e2e 读任意 JSON
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await http(method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${r.text.slice(0, 500)}`);
  return r.json;
}

const login = () => api('POST', '/api/auth/login', { password: ADMIN_PASSWORD });
const bookView = () => api('GET', `/api/admin/books/${SLUG}/v3`);

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > until) {
      const view = await bookView().catch((e: Error) => e.message);
      throw new Error(`timeout waiting for ${label}\nview=${JSON.stringify(view).slice(0, 3000)}\n${await tailLog()}`);
    }
    await sleep(400);
  }
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', path.join(dataDir, 'books', SLUG), ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** 本次 $DATA 下还活着的 nv-shim / fake harness 进程 */
async function liveShims(): Promise<number> {
  const { stdout } = await execFileP('ps', ['-eo', 'args']);
  return stdout.split('\n').filter((l) => l.includes(dataDir) && /nv-shim|fake-harness/.test(l)).length;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-e2e-restart-'));
  serverLog = path.join(dataDir, 'server.log');
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServer();
  await login();
}, 120_000);

afterAll(async () => {
  await stopServer('SIGKILL').catch(() => {});
  await sleep(300);
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}, 30_000);

describe('crash recovery end to end (real serve, fake harness)', () => {
  it('SIGKILL during the first run → restart → the run is reattached or lost and its work is harvested → the book writes on; one commit per chapter, clean tree, no stray processes', async () => {
    // 第一次运行：正文写完后、写笔记之前睡 20 秒（这段时间里杀掉 serve）；之后的运行照常
    const queue = path.join(dataDir, 'tmp', 'fake-v3');
    await fs.mkdir(queue, { recursive: true });
    await fs.writeFile(path.join(queue, `${SLUG}.json`), JSON.stringify([{ sleepMs: 20_000 }]));

    const created = await api('POST', '/api/admin/books', { genre: 'xianxia', length: 'medium', idea: '一封迟到二十年的信', title: '迟信', slug: SLUG, target_cjk: 40_000, batch: 3, min_chapter_cjk: 500 });
    expect(created).toMatchObject({ slug: SLUG, legacy: false, flow: 'v3' });

    await waitFor(
      '开书运行在跑',
      async () => {
        const page = await api('GET', `/api/admin/runs?book=${SLUG}&state=running&limit=5`);
        return page.items.length > 0 ? page.items : null;
      },
      60_000,
    );
    await sleep(2_000);
    expect(await stopServer('SIGKILL')).toBeNull();

    // ── 同一个 $DATA 重启 ─────
    await startServer();
    await login();

    // 至少两批入库（开书 + 写作），没收完的稿都收掉了
    const view = await waitFor(
      '两批入库',
      async () => {
        const v = await bookView();
        return v.batches.length >= 2 && v.pending === null ? v : null;
      },
      180_000,
    );
    expect(view.accepted).toBeGreaterThanOrEqual(6);
    const runs = (await api('GET', `/api/admin/runs?book=${SLUG}&limit=50`)).items as { state: string }[];
    expect(runs.some((r) => ['finalized', 'lost', 'exited'].includes(r.state))).toBe(true);
    expect(runs.filter((r) => ['preparing', 'spawned', 'running'].includes(r.state)).length).toBeLessThanOrEqual(1);

    // 先停调度，免得后面数提交时又落新的一批
    const cur = await api('GET', '/api/admin/settings');
    await api('PUT', '/api/admin/settings', { baseUpdatedAt: cur.updatedAt, schedulerEnabled: false });
    await waitFor('没有在跑的运行', async () => ((await api('GET', `/api/admin/runs?book=${SLUG}&state=running&limit=5`)).items.length === 0 ? true : null), 120_000);
    const accepted = (await bookView()).accepted as number;

    // ── 每章恰好一个提交，带 Novelist-Task / Novelist-Part ─────
    const log = await git('log', '--format=%H%x00%B%x01', 'HEAD');
    const commits = log
      .split('\x01')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => c.split('\x00')[1] ?? '');
    const trailer = (msg: string, key: string) => new RegExp(`^${key}: (.+)$`, 'm').exec(msg)?.[1] ?? null;
    // 每章一个 Novelist-Part（`<任务键>#<章号>`）；任务键就是这一批收尾提交上的 Novelist-Task
    const parts = commits.filter((m) => trailer(m, TRAILER.part)).map((m) => {
      const v = trailer(m, TRAILER.part) as string;
      return { no: Number(v.replace(/^.*#/, '')), key: v.replace(/#\d+$/, '') };
    });
    expect(parts.map((p) => p.no).sort((a, b) => a - b)).toEqual(Array.from({ length: accepted }, (_, i) => i + 1));
    const taskKeys = new Set(commits.map((m) => trailer(m, TRAILER.task)).filter((k): k is string => k !== null));
    for (const p of parts) expect(taskKeys.has(p.key), `第 ${p.no} 章的 ${p.key}`).toBe(true);
    // 崩溃恢复没有重复落同一批：每个任务键只出现在一个收尾提交上
    const tails = commits.map((m) => trailer(m, TRAILER.task)).filter((k): k is string => k !== null && [...parts].some((p) => p.key === k));
    expect(new Set(tails).size).toBe(tails.length);
    expect((await git('status', '--porcelain')).trim()).toBe('');

    // ── 优雅退出，没有残留进程 ─────
    expect(await stopServer('SIGTERM')).toBe(0);
    await sleep(500);
    expect(await liveShims()).toBe(0);
  }, 420_000);
});
