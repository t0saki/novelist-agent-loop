#!/usr/bin/env node
/**
 * novelist CLI（§9.3）。Owner: lane G。node:util parseArgs，无额外依赖。
 *   novelist serve                      启动 web+orchestrator+runner（按 NOVELIST_ROLES）
 *   novelist supervise -- serve         容器内 tini 唯一子进程：拉起 serve 并在崩溃后重启
 *   novelist migrate                    只跑数据库迁移
 *   novelist doctor [--fix-hints]       隔离探测、DB、工具、harness
 *   novelist book new --genre <id|random> [--length short|medium|long|epic|random] [--idea …] [--title …] [--seed file] [--no-start]
 *   novelist book status [<slug>]
 *   novelist book run <slug> [--until-idle]
 *   novelist book takeover <slug> [--length …] [--target 字数] [--no-start]   接手旧书（缺省值来自 GET /takeover）
 *   novelist import-v1 [--pg url] [--novels all|1,2] [--no-readers]
 *   novelist harness install <id> [--version v]
 *   novelist harness probe <id> [--account id] [--live]
 *   novelist routing slots              写作 / 杂活两个路由位置的主备与当前状态
 *   novelist reindex <slug>
 *   novelist secrets rotate-master-key | export-master-key --yes
 *   novelist backup [--out file]        打包 $DATA 书库 + 数据库逻辑导出（不含 harness/runs/主密钥）
 *   novelist restore <backup.tar.gz> --yes
 * 远程模式：--url + --token（PAT，~/.config/novelist/token）走 HTTP API；默认本地直连 DB（进程内调用同一套路由）。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './app.js';
import { sha256hex } from './api/auth.js';
import { buildServer } from './api/server.js';
import { loadConfig } from './config/index.js';
import { createBackup, restoreBackup } from './services/backup.js';
import { migrate, openDb } from './db/client.js';
import { pats } from './db/schema.js';
import { createLogger, silentLogger } from './log.js';
import { bootstrap, shutdownDeps, startServe } from './main.js';
import { reindexBook } from './services/books.js';
import { loadMasterKey, parseMasterKey } from './services/secrets.js';
import { eq } from 'drizzle-orm';

interface Flags {
  url?: string;
  token?: string;
  title?: string;
  genre?: string;
  seed?: string;
  length?: string;
  idea?: string;
  target?: string;
  slug?: string;
  pg?: string;
  novels?: string;
  account?: string;
  version?: string;
  yes?: boolean;
  live?: boolean;
  'no-readers'?: boolean;
  'no-start'?: boolean;
  'until-idle'?: boolean;
  'fix-hints'?: boolean;
  out?: string;
}

/** book new 的请求体（POST /api/admin/books）。seed 是文件内容（读好了再传进来） */
export function newBookBody(flags: Pick<Flags, 'genre' | 'length' | 'idea' | 'title' | 'slug'> & { 'no-start'?: boolean }, seed?: string): Record<string, unknown> {
  if (!flags.genre) throw new Error('book new 需要 --genre <题材包 id 或 random>');
  return {
    genre: flags.genre,
    length: flags.length ?? 'random',
    idea: flags.idea ?? '',
    title: flags.title ?? '',
    ...(flags.slug ? { slug: flags.slug } : {}),
    ...(seed !== undefined ? { seed } : {}),
    start: !flags['no-start'],
  };
}

interface Api {
  call<T>(method: string, url: string, body?: unknown): Promise<T>;
  close(): Promise<void>;
}

function apiError(status: number, body: string): Error {
  try {
    const p = JSON.parse(body) as { title?: string; detail?: string; errors?: { path: string; message: string }[] };
    const details = p.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
    return new Error(`HTTP ${status}: ${p.title ?? body}${details ? ` (${details})` : ''}${p.detail ? ` — ${p.detail}` : ''}`);
  } catch {
    return new Error(`HTTP ${status}: ${body}`);
  }
}

async function remoteApi(url: string, tokenFlag: string | undefined): Promise<Api> {
  const token = tokenFlag ?? process.env.NOVELIST_TOKEN ?? (await fs.readFile(path.join(os.homedir(), '.config', 'novelist', 'token'), 'utf8').catch(() => '')).trim();
  if (!token) throw new Error('远程模式需要 --token 或 ~/.config/novelist/token');
  return {
    async call<T>(method: string, reqUrl: string, body?: unknown): Promise<T> {
      const res = await fetch(new URL(reqUrl, url), { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      if (!res.ok) throw apiError(res.status, text);
      return (text ? JSON.parse(text) : undefined) as T;
    },
    close: async () => {},
  };
}

/** 本地模式：进程内 inject 同一套路由，用临时 PAT 认证 */
async function localApi(deps: AppDeps): Promise<Api> {
  const app: FastifyInstance = await buildServer(deps);
  const token = `nvpat_${randomBytes(30).toString('base64url')}`;
  const id = `cli-${randomBytes(6).toString('hex')}`;
  await deps.db.insert(pats).values({ id, label: 'cli', hash: sha256hex(token), scopes: ['admin'] });
  return {
    async call<T>(method: string, url: string, body?: unknown): Promise<T> {
      const res = await app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
      if (res.statusCode >= 400) throw apiError(res.statusCode, res.body);
      return (res.body ? JSON.parse(res.body) : undefined) as T;
    },
    async close() {
      await deps.db.delete(pats).where(eq(pats.id, id));
      await app.close();
    },
  };
}

function print(v: unknown): void {
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

async function withApi<T>(flags: Flags, fn: (api: Api, deps: AppDeps | null) => Promise<T>): Promise<T> {
  const url = flags.url ?? process.env.NOVELIST_URL;
  if (url) {
    const api = await remoteApi(url, flags.token);
    return fn(api, null);
  }
  const deps = await bootstrap(loadConfig(), { log: silentLogger });
  const api = await localApi(deps);
  try {
    return await fn(api, deps);
  } finally {
    await api.close();
    await shutdownDeps(deps);
  }
}

async function cmdServe(): Promise<number> {
  const app = await startServe(loadConfig());
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  app.deps.log.info('shutting down');
  await app.close();
  return 0;
}

/** 容器内 PID 1 的唯一子进程：崩溃后重启 serve（指数退避，稳定运行 60s 后重置） */
async function cmdSupervise(rest: string[]): Promise<number> {
  const args = rest[0] === '--' ? rest.slice(1) : rest;
  const child = args.length ? args : ['serve'];
  const script = fileURLToPath(import.meta.url);
  let stopping = false;
  let current: ReturnType<typeof spawn> | null = null;
  const forward = (sig: NodeJS.Signals) => {
    stopping = true;
    current?.kill(sig);
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));
  let backoffMs = 1000;
  for (;;) {
    const startedAt = Date.now();
    const code = await new Promise<number>((resolve) => {
      current = spawn(process.execPath, [...process.execArgv, script, ...child], { stdio: 'inherit' });
      current.on('exit', (c, s) => resolve(c ?? (s ? 128 : 1)));
      current.on('error', () => resolve(1));
    });
    if (stopping || code === 0) return code;
    if (Date.now() - startedAt > 60_000) backoffMs = 1000;
    console.error(`[supervise] ${child.join(' ')} 退出（code=${code}），${backoffMs}ms 后重启`);
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}

async function cmdMigrate(): Promise<number> {
  const config = loadConfig();
  const dbh = await openDb({ url: config.dbKind === 'pg' ? config.databaseUrl : null, pgliteDir: config.pgliteDir });
  await migrate(dbh);
  await dbh.close();
  print('迁移完成');
  return 0;
}

async function cmdDoctor(flags: Flags): Promise<number> {
  return withApi(flags, async (api) => {
    const r = await api.call<{ isolation: { selected: string }; db: { ok: boolean; kind: string; version: string; migrations: string }; disk: { path: string; freeBytes: number; ok: boolean }[]; tools: { name: string; ok: boolean; version: string | null; detail?: string }[]; harnesses: { id: string; ok: boolean; detail: string }[]; access: { protocol: string; warning: string | null }; masterKey: { source: string }; hints: string[] }>('GET', '/api/admin/doctor?refresh=1');
    const mark = (ok: boolean) => (ok ? '[ok]' : '[!!]');
    print(`隔离后端：${r.isolation.selected}`);
    print(`${mark(r.db.ok)} DB ${r.db.kind} ${r.db.version.split(' ').slice(0, 2).join(' ')}（${r.db.migrations}）`);
    for (const d of r.disk) print(`${mark(d.ok)} 磁盘 ${d.path} 可用 ${(d.freeBytes / 1024 ** 3).toFixed(1)}G`);
    for (const t of r.tools) print(`${mark(t.ok)} ${t.name} ${t.version ?? t.detail ?? ''}`);
    for (const h of r.harnesses) print(`${mark(h.ok)} harness ${h.id} ${h.detail}`);
    print(`主密钥来源：${r.masterKey.source}`);
    if (r.access.warning) print(`访问：${r.access.warning}`);
    if (flags['fix-hints'] || r.hints.length) for (const h of r.hints) print(`提示：${h}`);
    return r.db.ok ? 0 : 1;
  });
}

async function cmdBook(sub: string | undefined, positional: string[], flags: Flags): Promise<number> {
  switch (sub) {
    case 'new':
      return withApi(flags, async (api) => {
        const seed = flags.seed ? await fs.readFile(flags.seed, 'utf8') : undefined;
        print(await api.call('POST', '/api/admin/books', newBookBody(flags, seed)));
        return 0;
      });
    case 'takeover': {
      const slug = positional[0];
      if (!slug) throw new Error('book takeover 需要 <slug>');
      return withApi(flags, async (api) => {
        const url = `/api/admin/books/${encodeURIComponent(slug)}/takeover`;
        const d = await api.call<{ length: string; target_cjk: number; batch: number; min_chapter_cjk: number }>('GET', url);
        const target = flags.target ? Number(flags.target) : d.target_cjk;
        if (!Number.isInteger(target) || target <= 0) throw new Error('--target 要是正整数（全书字数下限）');
        print(await api.call('POST', url, { length: flags.length ?? d.length, target_cjk: target, batch: d.batch, min_chapter_cjk: d.min_chapter_cjk, start: !flags['no-start'] }));
        return 0;
      });
    }
    case 'status': {
      const slug = positional[0];
      return withApi(flags, async (api) => {
        print(await api.call('GET', slug ? `/api/admin/books/${encodeURIComponent(slug)}` : '/api/admin/books'));
        return 0;
      });
    }
    case 'run': {
      const slug = positional[0];
      if (!slug) throw new Error('book run 需要 <slug>');
      if (flags.url) throw new Error('book run 只支持本地模式');
      const deps = await bootstrap(loadConfig(), { log: createLogger(process.env.NOVELIST_LOG_LEVEL ?? 'info') });
      try {
        const { bookBySlug } = await import('./api/helpers.js');
        const book = await bookBySlug(deps, slug);
        if (book.status === 'draft') await deps.orchestrator.startBook(book.id);
        else if (book.status === 'paused') await deps.orchestrator.bookAction(book.id, { action: 'resume' });
        if (flags['until-idle']) {
          await deps.orchestrator.runUntilIdle();
          print('空闲（没有更多可执行任务）');
        } else {
          print('已入队；由 novelist serve 中的调度器继续执行（或加 --until-idle 在本进程跑到空闲）');
        }
        return 0;
      } finally {
        await deps.orchestrator.stop();
        await shutdownDeps(deps);
      }
    }
    default:
      throw new Error('用法：novelist book new|status|run|takeover');
  }
}

async function cmdImport(flags: Flags): Promise<number> {
  return withApi(flags, async (api) => {
    const novels = !flags.novels || flags.novels === 'all' ? 'all' : flags.novels.split(',').map(Number);
    const job = await api.call<{ id: string; state: string }>('POST', '/api/admin/import-v1', { ...(flags.pg ? { databaseUrl: flags.pg } : {}), novels, readers: !flags['no-readers'] });
    let printed = 0;
    for (;;) {
      const cur = await api.call<{ state: string; log: string[]; report: unknown }>('GET', `/api/admin/import-v1/jobs/${job.id}`);
      for (const line of cur.log.slice(printed)) print(line);
      printed = cur.log.length;
      if (cur.state !== 'running') {
        if (cur.report) print(cur.report);
        return cur.state === 'done' ? 0 : 1;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  });
}

async function cmdHarness(sub: string | undefined, positional: string[], flags: Flags): Promise<number> {
  const id = positional[0];
  if (!id) throw new Error('需要 harness id');
  if (sub === 'probe') {
    return withApi(flags, async (api) => {
      const qs = new URLSearchParams({ ...(flags.account ? { accountId: flags.account } : {}), ...(flags.live ? { live: '1' } : {}) });
      print(await api.call('POST', `/api/admin/harness/${encodeURIComponent(id)}/probe?${qs}`));
      return 0;
    });
  }
  if (sub === 'install') {
    return withApi(flags, async (api) => {
      const job = await api.call<{ id: string; commands: string[][] }>('POST', `/api/admin/harness/${encodeURIComponent(id)}/install`, flags.version ? { version: flags.version } : {});
      print(job.commands.map((c) => c.join(' ')).join('\n'));
      let printed = 0;
      for (;;) {
        const cur = await api.call<{ state: string; log: string[] }>('GET', `/api/admin/harness/install-jobs/${job.id}`);
        for (const line of cur.log.slice(printed)) print(line);
        printed = cur.log.length;
        if (cur.state !== 'running') return cur.state === 'done' ? 0 : 1;
        await new Promise((r) => setTimeout(r, 2000));
      }
    });
  }
  throw new Error('用法：novelist harness install|probe <id>');
}

async function cmdBackup(flags: Flags): Promise<number> {
  const out = flags.out ?? path.join(loadConfig().dataDir, 'backups', `novelist-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
  const deps = await bootstrap(loadConfig(), { log: silentLogger, migrate: false });
  try {
    print(await createBackup(deps, out));
    return 0;
  } finally {
    await shutdownDeps(deps);
  }
}

async function cmdRestore(file: string | undefined, flags: Flags): Promise<number> {
  if (!file) throw new Error('用法：novelist restore <backup.tar.gz> --yes');
  if (!flags.yes) throw new Error('restore 会覆盖数据库和 $DATA 下的书库，需要 --yes 确认');
  const deps = await bootstrap(loadConfig(), { log: silentLogger });
  try {
    print(await restoreBackup(deps, file));
    return 0;
  } finally {
    await shutdownDeps(deps);
  }
}

async function cmdSecrets(sub: string | undefined, flags: Flags): Promise<number> {
  const config = loadConfig();
  if (sub === 'export-master-key') {
    if (!flags.yes) throw new Error('导出主密钥需要 --yes');
    const { key } = await loadMasterKey({ envValue: config.masterKey, keyFile: path.join(config.dataDir, '.master_key') });
    print(key.toString('base64'));
    return 0;
  }
  if (sub === 'rotate-master-key') {
    const deps = await bootstrap(config, { log: silentLogger });
    try {
      const newKey = randomBytes(32);
      const newB64 = newKey.toString('base64');
      parseMasterKey(newB64);
      if (deps.masterKeySource === 'env') {
        const n = await deps.secrets.rotate(newKey);
        print(`已重新加密 ${n} 条秘密。新主密钥（写入 NOVELIST_MASTER_KEY 后重启）：\n${newB64}`);
        return 0;
      }
      const pending = `${deps.paths.masterKeyFile}.new`;
      await fs.writeFile(pending, `${newB64}\n`, { mode: 0o600 });
      const n = await deps.secrets.rotate(newKey);
      await fs.rename(pending, deps.paths.masterKeyFile);
      print(`已轮换主密钥，重新加密 ${n} 条秘密`);
      return 0;
    } finally {
      await shutdownDeps(deps);
    }
  }
  throw new Error('用法：novelist secrets rotate-master-key | export-master-key --yes');
}

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      title: { type: 'string' },
      genre: { type: 'string' },
      seed: { type: 'string' },
      length: { type: 'string' },
      idea: { type: 'string' },
      target: { type: 'string' },
      slug: { type: 'string' },
      pg: { type: 'string' },
      novels: { type: 'string' },
      account: { type: 'string' },
      version: { type: 'string' },
      yes: { type: 'boolean' },
      live: { type: 'boolean' },
      'no-readers': { type: 'boolean' },
      'no-start': { type: 'boolean' },
      'until-idle': { type: 'boolean' },
      'fix-hints': { type: 'boolean' },
      out: { type: 'string' },
    },
  });
  const flags = values as Flags;
  const [cmd, sub, ...rest] = positionals;
  switch (cmd) {
    case 'serve':
      return cmdServe();
    case 'supervise':
      return cmdSupervise(argv.slice(argv.indexOf('supervise') + 1));
    case 'migrate':
      return cmdMigrate();
    case 'doctor':
      return cmdDoctor(flags);
    case 'book':
      return cmdBook(sub, rest, flags);
    case 'import-v1':
      return cmdImport(flags);
    case 'harness':
      return cmdHarness(sub, rest, flags);
    case 'routing': {
      if (sub !== 'slots') throw new Error('用法：novelist routing slots（旧的 routing check 已删除：路由只剩写作 / 杂活两个位置）');
      return withApi(flags, async (api) => {
        const v = await api.call<{ slots: Record<string, { primary: string | null; fallback: string | null }>; forced: boolean; status: Record<string, { profile: string | null; usedFallback: boolean; waitUntil: string | null; reason: string | null }> }>('GET', '/api/admin/routing/slots');
        for (const id of ['writer', 'utility'] as const) {
          const s = v.slots[id];
          const st = v.status[id];
          const state = st?.profile ? `可用：${st.profile}${st.usedFallback ? '（备用）' : ''}` : `不可用${st?.waitUntil ? `，约 ${st.waitUntil} 恢复` : ''}${st?.reason ? `：${st.reason}` : ''}`;
          print(`${id === 'writer' ? '写作' : '杂活'}  主用 ${s?.primary ?? '（未设）'}  备用 ${s?.fallback ?? '（无）'}  ${state}`);
        }
        if (v.forced) print('fake 模式：两个位置都强制用 fake');
        return 0;
      });
    }
    case 'reindex': {
      if (!sub) throw new Error('reindex 需要 <slug>');
      const deps = await bootstrap(loadConfig(), { log: silentLogger });
      try {
        await reindexBook(deps, sub);
        print(`已重建索引：${sub}`);
        return 0;
      } finally {
        await shutdownDeps(deps);
      }
    }
    case 'secrets':
      return cmdSecrets(sub, flags);
    case 'backup':
      return cmdBackup(flags);
    case 'restore':
      return cmdRestore(sub, flags);
    default:
      console.error('用法：novelist serve|supervise|migrate|doctor|book|import-v1|harness|routing|reindex|secrets|backup|restore');
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
