/**
 * 全系统 e2e（真实进程、真实 HTTP、磁盘 PGlite、fake harness）：
 * novelist serve（NOVELIST_FAKE_HARNESS=1）→ 开书 → 审批 → 规划 → standard 档写作 → SIGKILL 中途崩溃 → 重启恢复 → 完结 →
 * git trailer / 账本 / 发布 / 读者 API / EPUB。
 *
 * 不依赖 dist：用 tsx + `source` 条件直接跑 src/cli.ts。全程约 2–3 分钟；用 safe-run.sh 跑时给够 -t。
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { P, TRAILER } from '../src/book/index.js';
import { ledgerHash, loadBookState } from '../src/state/index.js';

const execFileP = promisify(execFile);
const SERVER_DIR = path.resolve(import.meta.dirname, '..');
const ADMIN_PASSWORD = 'e2e-admin-password';
const SLUG = 'e2e-shilian';
const CHAPTERS = 14;
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

async function startServer(): Promise<void> {
  const out = createWriteStream(serverLog, { flags: 'a' });
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/cli.ts', 'serve'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=768',
      NOVELIST_DATA_DIR: dataDir,
      ...(process.env.NOVELIST_E2E_DATABASE_URL ? { NOVELIST_DATABASE_URL: process.env.NOVELIST_E2E_DATABASE_URL } : {}),
      NOVELIST_FAKE_HARNESS: '1',
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
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${await tailLog()}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* 尚未监听 */
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
    const t = setTimeout(() => {
      child.kill('SIGKILL');
    }, 95_000);
    child.once('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

async function tailLog(n = 4000): Promise<string> {
  return (await fs.readFile(serverLog, 'utf8').catch(() => '')).slice(-n);
}

async function http(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; text: string; buf: Buffer; headers: Headers }> {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie, origin: base },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0] as string;
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, json, text, buf, headers: r.headers };
}

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const r = await http(method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${r.text.slice(0, 500)}`);
  return r.json;
}

async function login(): Promise<void> {
  await api('POST', '/api/auth/login', { password: ADMIN_PASSWORD });
}

async function approveOpen(): Promise<string[]> {
  const page = await api('GET', '/api/admin/inbox?state=open&limit=50');
  const acted: string[] = [];
  for (const it of page.items as { id: string; kind: string; title: string; actions: { id: string }[] }[]) {
    if (it.kind !== 'approval') continue;
    await api('POST', `/api/admin/inbox/${it.id}/act`, { action: 'approve' });
    acted.push(it.title);
  }
  return acted;
}

async function overview(): Promise<any> {
  return api('GET', `/api/admin/books/${SLUG}`);
}

const frontiers = async () => (await overview()).frontiers as { accepted: number; audited: number; published: number; cardsPlanned: number };

async function failedTasks(): Promise<string[]> {
  const page = await api('GET', `/api/admin/tasks?book=${SLUG}&state=failed&limit=20`);
  return (page.items as { kind: string; target: string; lastErrorClass: string | null; lastError: string | null }[]).map((t) => `${t.kind} ${t.target}: ${t.lastErrorClass} ${t.lastError}`);
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await approveOpen();
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) {
      const failed = await failedTasks().catch(() => []);
      const ov = await overview().catch(() => null);
      throw new Error(`timeout waiting for ${label}\noverview=${JSON.stringify(ov)}\nfailed=${failed.join('\n')}\n${await tailLog()}`);
    }
    await sleep(400);
  }
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', path.join(dataDir, 'books', SLUG), ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** fake-harness / nv-shim 残留进程（只看本次 $DATA 下的） */
async function liveShims(): Promise<number> {
  const { stdout } = await execFileP('ps', ['-eo', 'args']);
  return stdout.split('\n').filter((l) => l.includes(dataDir) && /nv-shim|fake-harness/.test(l)).length;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-e2e-'));
  serverLog = path.join(dataDir, 'server.log');
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServer();
  await login();
}, 90_000);

afterAll(async () => {
  await stopServer('SIGKILL').catch(() => {});
  await sleep(300);
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}, 30_000);

describe('全系统 e2e（fake harness）', () => {
  it('开书走到中途 → SIGKILL → 重启恢复 → 完结且数据一致', async () => {
    // ── 开书：14 章、1 卷、standard（默认档）；发布用 D4 的 scheduled 机制，只把周期和 lag 调小 ─────
    const created = await api('POST', '/api/admin/books', {
      title: '试炼录',
      slug: SLUG,
      genre: 'xianxia',
      seed: '一个被逐出师门的少年，追查师父死因。',
      scale: { target_cjk: 3000 * CHAPTERS, hard_max_cjk: 6000 * CHAPTERS, volumes: [1, 1], chapters_per_volume: [CHAPTERS, CHAPTERS], chapter_length: { min: 2400, target: 3000, max: 3800, count_mode: 'han' } },
    });
    expect(created.slug).toBe(SLUG);
    expect(created.tier).toBe('standard');
    await api('PUT', `/api/admin/books/${SLUG}/publish`, { mode: 'scheduled', cadence: '* * * * *', timezone: 'Asia/Shanghai', per_slot: 20, lag: 2, min_lag: 2, require_audited: true, max_buffer: 60, resume_buffer: 45 });

    // ── 跑到第 5 章完成后，趁写作 lane 还在跑时直接杀进程 ─────
    await waitFor('第 5 章验收', async () => (await frontiers()).accepted >= 5, 180_000);
    const running = await waitFor(
      'chapter 任务 running',
      async () => {
        const page = await api('GET', `/api/admin/runs?book=${SLUG}&state=running&limit=5`);
        return (page.items as unknown[]).length > 0 ? page.items : null;
      },
      60_000,
    );
    expect(running).toBeTruthy();
    const beforeCrash = await frontiers();
    expect(await stopServer('SIGKILL')).toBeNull();

    // ── 重启恢复：同一 $DATA，磁盘 PGlite ─────
    await startServer();
    await login();
    const ovAfter = await overview();
    expect(ovAfter.frontiers.accepted).toBeGreaterThanOrEqual(beforeCrash.accepted);

    // ── 跑到全书完结 ─────
    const done = await waitFor(
      '全书完结',
      async () => {
        const ov = await overview();
        return ov.status === 'completed' && ov.frontiers.accepted === CHAPTERS ? ov : null;
      },
      240_000,
    );
    expect(done.frontiers.cardsPlanned).toBe(CHAPTERS);

    // ── 书库 git：每章恰好一次验收提交，带完整 trailer ─────
    const dir = path.join(dataDir, 'books', SLUG);
    const log = await git('log', '--format=%H%x00%B%x01', 'HEAD');
    const commits = log
      .split('\x01')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const [sha, msg] = c.split('\x00') as [string, string];
        return { sha, msg };
      });
    const trailerOf = (msg: string, key: string) => new RegExp(`^${key}: (.+)$`, 'm').exec(msg)?.[1] ?? null;
    const accepted = commits.filter((c) => /^(chapter|accept)[^\n]*c\d{5}/.test(c.msg) && trailerOf(c.msg, TRAILER.snapshotHash));
    expect(accepted.length).toBe(CHAPTERS);
    const chapterIds = new Set(accepted.map((c) => /c\d{5}/.exec(c.msg)?.[0]));
    expect(chapterIds.size).toBe(CHAPTERS);
    // 验收提交是确定性任务（没有 run）：必带 Task + Snapshot-Hash
    for (const c of accepted) expect(trailerOf(c.msg, TRAILER.task)).toBeTruthy();
    // agent 产出的提交（规划、摘要等）带完整来源
    const agentCommits = commits.filter((c) => trailerOf(c.msg, TRAILER.run));
    expect(agentCommits.length).toBeGreaterThanOrEqual(5);
    for (const c of agentCommits) {
      expect(trailerOf(c.msg, TRAILER.harness)).toBe('fake');
      expect(trailerOf(c.msg, TRAILER.model)).toBe('fake-model');
      expect(trailerOf(c.msg, TRAILER.isolation)).toBeTruthy();
    }
    // Novelist-Task 全局唯一：崩溃恢复没有重复提交
    const taskIds = commits.map((c) => trailerOf(c.msg, TRAILER.task)).filter((t): t is string => !!t);
    expect(new Set(taskIds).size).toBe(taskIds.length);
    // 每章都有正文和账本
    for (let no = 1; no <= CHAPTERS; no++) {
      await expect(fs.stat(path.join(dir, P.manuscript(no)))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(dir, P.ledger(no)))).resolves.toBeTruthy();
    }
    expect((await git('status', '--porcelain')).trim()).toBe('');

    // ── 账本 / 快照一致：最新验收提交的 hash = 从 ledger 重新 fold 的结果 ─────
    const state = await loadBookState(dir);
    expect(state.ledger.length).toBe(CHAPTERS);
    expect(state.ledger.map((d) => d.chapter)).toEqual(Array.from({ length: CHAPTERS }, (_, i) => `c${String(i + 1).padStart(5, '0')}`));
    const newest = accepted[0];
    expect(trailerOf(newest?.msg ?? '', TRAILER.snapshotHash)).toBe(ledgerHash(state.ledger, state.overrides));

    // ── 发布：cadence 槽位到点后由 publisher 排期，lag=2 + require_audited ─────
    const published = await waitFor(
      '定时发布',
      async () => {
        const f = await frontiers();
        return f.published >= 1 ? f : null;
      },
      200_000,
    );
    expect(published.published).toBeLessThanOrEqual(published.audited);
    const pub = await api('GET', `/api/admin/books/${SLUG}/publish`);
    expect(pub).toBeTruthy();

    // ── 读者 API：只返回已发布章节 ─────
    const lib = await api('GET', '/api/reader/books');
    expect(lib.map((b: { slug: string }) => b.slug)).toContain(SLUG);
    const detail = await api('GET', `/api/reader/books/${SLUG}`);
    expect(detail.publishedChapters).toBe(published.published);
    expect(detail.volumes[0].chapters[0].no).toBe(1);
    const ch1 = await api('GET', `/api/reader/books/${SLUG}/chapters/1`);
    expect(ch1.text.length).toBeGreaterThan(1000);
    expect(ch1.text).not.toContain('<!-- beat:');
    const unpublishedNo = published.published + 1;
    if (unpublishedNo <= CHAPTERS && (await frontiers()).published < unpublishedNo) {
      expect((await http('GET', `/api/reader/books/${SLUG}/chapters/${unpublishedNo}`)).status).toBe(404);
    }

    // ── 导出 ─────
    const epub = await http('GET', `/api/reader/books/${SLUG}/export.epub`);
    expect(epub.status).toBe(200);
    expect(epub.headers.get('content-type')).toContain('epub');
    const zip = await JSZip.loadAsync(epub.buf);
    expect(await zip.file('mimetype')?.async('string')).toBe('application/epub+zip');
    expect(Object.keys(zip.files).filter((f) => /\.x?html$/.test(f)).length).toBeGreaterThanOrEqual(published.published);
    const txt = await http('GET', `/api/reader/books/${SLUG}/export.txt`);
    expect(txt.status).toBe(200);
    expect(txt.text).toContain(detail.volumes[0].chapters[0].title);

    // ── 收尾：无失败任务、优雅退出、无残留进程 ─────
    expect(await failedTasks()).toEqual([]);
    expect(await stopServer('SIGTERM')).toBe(0);
    await sleep(500);
    expect(await liveShims()).toBe(0);
  }, 560_000);
});
