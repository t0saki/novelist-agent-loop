/**
 * 单个 run 的执行（spawn shim → tail → 归一化 → 退出 → classify）。Owner: lane A。
 * 调用方是 orchestrator 的 run executor（lane F），它负责认领、lease、写 run_events、收割与 finalize。
 *
 * 文件约定（$RUN = spec.runDir）：
 *   $RUN/in/spec.json      ShimSpec（env 已去除秘密）
 *   $RUN/log/.secret-env.json  0600，shim 读后删除
 *   $RUN/log/run.json      审计输入（home 配置 hash、声明产物 glob、argv 预览）——reattach 用
 *   $RUN/log/{stdout.ndjson,stderr.log,pid,exit.json,heartbeat,kill,shim.log}
 * 事件 seq 从 1 开始、由 stdout 内容确定性地导出：reattach 时重新解析整个 stdout，跳过 seq ≤ fromSeq 的事件。
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { Capabilities, ErrorClass, HarnessInstall, IsolationBackend, NEvent, Outcome } from '@novelist/shared';
import { parse as parseYaml } from 'yaml';
import type { CompiledInstructions } from '../instructions/types.js';
import { stamp } from './events.js';
import { isAllowed, mountPlanFor, postRunAudit, wrapInvocation } from './isolation.js';
import { KILL_FILE, type ShimExit, type ShimPidInfo, type ShimSpec } from './shim/spec.js';
import type { ExitInfo, HarnessAdapter, Invocation, ResolvedAccount, RunSpec, StreamParser } from './types.js';
import { argvPreview as makePreview, atomicWrite, bootId, pidAlive, procStartTicks, readJsonFile, sha256FileImpl, sleep } from './util.js';

export interface PreparedRun {
  spec: RunSpec;
  adapter: HarnessAdapter;
  account: ResolvedAccount;
  install: HarnessInstall;
  caps: Capabilities;
  isolation: IsolationBackend;
  compiled: CompiledInstructions;
}

export interface RunEventSink {
  /** 归一化后的事件（已补 seq/ts/runId），按序回调 */
  onEvent(e: NEvent): void | Promise<void>;
  /** stdout/stderr 有活动（用于续租 lease） */
  onActivity?(): void;
}

export interface RunHandle {
  runId: string;
  shimPid: number;
  harnessPid: number | null;
  startedAt: string;
  /** 最终 argv（秘密打码后，UI 展示） */
  argvPreview: string[];
  wait(): Promise<RunResult>;
  kill(reason: 'user' | 'shutdown'): Promise<void>;
}

export interface RunResult {
  outcome: Outcome;
  exit: ExitInfo;
  eventCount: number;
  /** 归一化事件里 t === 'tool_call' 的个数（整个 stdout，reattach 时也从头数） */
  toolSteps: number;
  /** run 后审计结果（isolation.postRunAudit） */
  audit: { ok: boolean; extraFiles: string[]; tamperedConfig: string[] };
  /** 原始 stdout 文件（zstd 归档由清理任务负责） */
  stdoutFile: string;
  stderrTail: string;
}

/** 启动前就失败（不消耗 attempt 的配置类问题）。code=budget → 该 profile 不可承载，avoidProfile 后重路由 */
export class RunPrepareError extends Error {
  readonly errorClass: ErrorClass;
  readonly code: 'budget' | 'not_allowed' | 'missing_file' | 'auth_config' | 'spawn';
  constructor(errorClass: ErrorClass, code: RunPrepareError['code'], message: string) {
    super(message);
    this.name = 'RunPrepareError';
    this.errorClass = errorClass;
    this.code = code;
  }
}

interface RunMeta {
  schema: 'nv.runmeta/1';
  runId: string;
  harness: string;
  isolation: IsolationBackend;
  outDir: string;
  declaredGlobs: string[];
  homeConfigHashes: Record<string, string>;
  argvPreview: string[];
  startedAt: string;
}

/** binPath 是 $DATA/harness/bin 下的软链，真实安装目录在 $DATA/harness/<id>/<ver>：bwrap 用 tmpfs 遮蔽 $DATA，必须把安装根也只读绑定，否则软链悬空 */
function installRoots(binPath: string): string[] {
  let real: string;
  try {
    real = realpathSync(binPath);
  } catch {
    return [];
  }
  const harnessDir = path.dirname(path.dirname(binPath));
  const rel = path.relative(harnessDir, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [path.dirname(real)];
  const [id, ver] = rel.split(path.sep);
  return id && ver ? [path.join(harnessDir, id, ver)] : [path.dirname(real)];
}

export function logFiles(logDir: string) {
  return {
    stdout: path.join(logDir, 'stdout.ndjson'),
    stderr: path.join(logDir, 'stderr.log'),
    pid: path.join(logDir, 'pid'),
    exit: path.join(logDir, 'exit.json'),
    heartbeat: path.join(logDir, 'heartbeat'),
    kill: path.join(logDir, KILL_FILE),
    shimLog: path.join(logDir, 'shim.log'),
    secretEnv: path.join(logDir, '.secret-env.json'),
    meta: path.join(logDir, 'run.json'),
  };
}

/** nv-shim 脚本位置：构建后为 .js；开发/测试时 node 直接 type-strip 运行 .ts */
export function shimScriptPath(): string {
  if (process.env.NOVELIST_SHIM_PATH) return process.env.NOVELIST_SHIM_PATH;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ['shim/nv-shim.js', 'shim/nv-shim.ts']) {
    const p = path.join(here, f);
    if (existsSync(p)) return p;
  }
  throw new Error('nv-shim script not found');
}

/** 从 work order frontmatter 取声明产物 glob（+ receipt.json 总是允许） */
export async function declaredArtifactGlobs(workOrderFile: string): Promise<string[]> {
  const globs = new Set<string>(['receipt.json']);
  try {
    const text = await fs.readFile(workOrderFile, 'utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      const fm = parseYaml(m[1]!) as { artifacts?: { path?: string }[] } | null;
      for (const a of fm?.artifacts ?? []) if (a?.path) globs.add(a.path);
    }
  } catch {
    /* 没有 frontmatter：只允许 receipt */
  }
  return [...globs];
}

/** 秘密值集合：账号 secretEnv 全部 + invocation env 中名字像秘密的值 */
function secretValues(inv: Invocation, acct: ResolvedAccount): Set<string> {
  const s = new Set<string>();
  for (const v of Object.values(acct.secretEnv ?? {})) if (v && v.length >= 6) s.add(v);
  for (const [k, v] of Object.entries(inv.env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && v && v.length >= 6) s.add(v);
  // 非秘密的账号 env（如 BASE_URL）不打码
  for (const b of acct.env ?? []) if (!b.secret && b.value) s.delete(b.value);
  return s;
}

/** spawn 前再检查一次 argv / stdin 引用的 $RUN/in 文件存在（§3.1：agy --json-schema、pi --append-system-prompt 文件缺失会被当字面文本） */
export function checkReferencedFiles(inv: Invocation, spec: RunSpec): string[] {
  const missing: string[] = [];
  const check = (p: string) => {
    if (p.startsWith(`${spec.inDir}/`) && !existsSync(p)) missing.push(p);
  };
  for (const a of inv.argv) {
    if (a.startsWith('/')) check(a);
    const eq = a.indexOf('=');
    if (eq > 0 && a.slice(eq + 1).startsWith('/')) check(a.slice(eq + 1).replace(/^"|"$/g, ''));
  }
  if (inv.stdin !== 'devnull' && !existsSync(inv.stdin.file)) missing.push(inv.stdin.file);
  return [...new Set(missing)];
}

async function writeFiles(files: { path: string; content: string; mode?: number }[]): Promise<void> {
  for (const f of files) await atomicWrite(f.path, f.content, f.mode ?? 0o644);
}

/**
 * 完整准备并启动：adapter.prepareHome → adapter.materialize → buildInvocation → isolation.wrapInvocation
 * → 写 $RUN/in/spec.json → 再次检查 argv 引用的文件存在（§3.1）→ detached 启动 nv-shim。
 */
export async function startRun(p: PreparedRun, sink: RunEventSink): Promise<RunHandle> {
  const { spec, adapter, account, install, caps, isolation, compiled } = p;
  const lf = logFiles(spec.logDir);
  for (const d of [spec.inDir, spec.logDir, spec.outDir]) await fs.mkdir(d, { recursive: true });

  const gate = isAllowed(caps.shellTool, spec.harness, isolation);
  if (!gate.ok) throw new RunPrepareError('sandbox', 'not_allowed', gate.reason ?? `${spec.harness} 不允许在 ${isolation} 档运行`);

  const home = await adapter.prepareHome(account, install, spec);
  const mat = await adapter.materialize(spec, compiled, caps, { home: account.home });
  if (!mat.budget.ok) throw new RunPrepareError('config', 'budget', mat.budget.reason ?? `指令超出 ${spec.harness} 的承载上限（${mat.budget.bytes}/${mat.budget.limit}）`);
  // buildInvocation 可能调整 mat.files（例：cc 把 adapter 权限设置合并进 lane C 的 settings），所以先构造再落盘
  const inv0 = adapter.buildInvocation(spec, caps, home, mat, account, install);
  await writeFiles(home.configFiles);
  await writeFiles(mat.files);
  const extraRo = [path.dirname(install.binPath), path.dirname(process.execPath), ...installRoots(install.binPath)];
  const plan = mountPlanFor(spec, [account.home, ...home.stateDirs], extraRo);
  const inv = wrapInvocation(inv0, isolation, plan);
  const missing = checkReferencedFiles(inv, spec);
  if (missing.length) throw new RunPrepareError('config', 'missing_file', `argv 引用的文件不存在：${missing.join(', ')}`);

  const homeConfigHashes: Record<string, string> = {};
  for (const f of home.configFiles) homeConfigHashes[f.path] = await sha256FileImpl(f.path);
  const secrets = secretValues(inv, account);
  const preview = makePreview(inv.argv, secrets);
  const publicEnv: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(inv.env)) (secrets.has(v) ? secretEnv : publicEnv)[k] = v;

  const startedAt = new Date().toISOString();
  const meta: RunMeta = {
    schema: 'nv.runmeta/1',
    runId: spec.runId,
    harness: spec.harness,
    isolation,
    outDir: spec.outDir,
    declaredGlobs: await declaredArtifactGlobs(spec.workOrderFile),
    homeConfigHashes,
    argvPreview: preview,
    startedAt,
  };
  await atomicWrite(lf.meta, JSON.stringify(meta, null, 2));
  await atomicWrite(lf.secretEnv, JSON.stringify(secretEnv), 0o600);
  for (const f of [lf.exit, lf.kill, lf.pid]) await fs.rm(f, { force: true });

  const shimSpec: ShimSpec = {
    schema: 'nv.shim/1',
    runId: spec.runId,
    argv: inv.argv,
    env: publicEnv,
    cwd: inv.cwd,
    stdin: inv.stdin,
    stdoutFile: lf.stdout,
    stderrFile: lf.stderr,
    pidFile: lf.pid,
    exitFile: lf.exit,
    heartbeatFile: lf.heartbeat,
    wallMs: spec.limits.wallMs,
    idleMs: spec.limits.idleMs,
    stop: inv.stop,
    partialSampleMs: inv.argv.includes('--include-partial-messages') ? 5000 : 0,
    envFile: lf.secretEnv,
    infoFd: isolation === 'bwrap' && inv.argv.includes('--info-fd'),
    ...(process.env.NOVELIST_SHIM_TICK_MS ? { tickMs: Number(process.env.NOVELIST_SHIM_TICK_MS) } : {}),
  };
  const specPath = path.join(spec.inDir, 'spec.json');
  await atomicWrite(specPath, JSON.stringify({ ...shimSpec, argv: preview }, null, 2));
  // shim 真正读取的 spec（含完整 argv）放在 log 下，不对 harness 可见的 in/ 暴露超长参数之外的东西
  const realSpecPath = path.join(spec.logDir, 'shim.spec.json');
  await atomicWrite(realSpecPath, JSON.stringify(shimSpec), 0o600);

  const logFd = openSync(lf.shimLog, 'a');
  let shimPid: number;
  try {
    const child = spawn(process.execPath, [shimScriptPath(), '--spec', realSpecPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
      cwd: spec.logDir,
    });
    if (!child.pid) throw new Error('shim spawn failed');
    shimPid = child.pid;
    child.on('error', () => {});
    child.unref();
  } catch (e) {
    throw new RunPrepareError('harness_crash', 'spawn', `nv-shim 启动失败：${(e as Error).message}`);
  } finally {
    closeSync(logFd);
  }

  // 等 pid 文件（拿 harnessPid）；spawn 失败时 exit.json 会先出现
  let harnessPid: number | null = null;
  for (let i = 0; i < 100; i++) {
    const info = await readJsonFile<ShimPidInfo>(lf.pid);
    if (info) {
      harnessPid = info.harnessPid;
      break;
    }
    if (existsSync(lf.exit)) break;
    await sleep(50);
  }

  return createHandle({ spec, adapter, sink, fromSeq: 0, shimPid, harnessPid, startedAt, argvPreview: preview, meta });
}

/** serve 重启后接管仍在跑的 shim（$DATA/runs/active/<id>，pid 与启动时间都匹配才接管）；否则 null */
export async function reattachRun(runDir: string, adapter: HarnessAdapter, spec: RunSpec, sink: RunEventSink, fromSeq: number): Promise<RunHandle | null> {
  const logDir = spec.logDir || path.join(runDir, 'log');
  const lf = logFiles(logDir);
  const meta = (await readJsonFile<RunMeta>(lf.meta)) ?? {
    schema: 'nv.runmeta/1' as const,
    runId: spec.runId,
    harness: spec.harness,
    isolation: 'container' as const,
    outDir: spec.outDir,
    declaredGlobs: await declaredArtifactGlobs(spec.workOrderFile),
    homeConfigHashes: {},
    argvPreview: [],
    startedAt: new Date().toISOString(),
  };
  const info = await readJsonFile<ShimPidInfo>(lf.pid);
  const finished = existsSync(lf.exit);
  const base = { spec: { ...spec, logDir }, adapter, sink, fromSeq, startedAt: info?.startedAt ?? meta.startedAt, argvPreview: meta.argvPreview, meta };
  if (finished) return createHandle({ ...base, shimPid: info?.shimPid ?? 0, harnessPid: info?.harnessPid ?? null });
  if (!info) return null;
  const sameBoot = !info.bootId || info.bootId === bootId();
  const shimOk = sameBoot && pidAlive(info.shimPid) && (!info.shimStart || procStartTicks(info.shimPid) === info.shimStart);
  if (shimOk) return createHandle({ ...base, shimPid: info.shimPid, harnessPid: info.harnessPid });
  // shim 已死：若 harness 还活着（且确实是同一个进程），杀掉孤儿进程组，交给调用方判 lost
  for (const pid of [info.innerPid, info.harnessPid]) {
    if (!pid || !sameBoot || !pidAlive(pid)) continue;
    if (pid === info.harnessPid && info.harnessStart && procStartTicks(pid) !== info.harnessStart) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  return null;
}

interface HandleCtx {
  spec: RunSpec;
  adapter: HarnessAdapter;
  sink: RunEventSink;
  fromSeq: number;
  shimPid: number;
  harnessPid: number | null;
  startedAt: string;
  argvPreview: string[];
  meta: RunMeta;
}

const KEEP_FOR_CLASSIFY = (e: NEvent) => e.t !== 'text' && e.t !== 'heartbeat';

function createHandle(ctx: HandleCtx): RunHandle {
  const { spec, adapter, sink } = ctx;
  const lf = logFiles(spec.logDir);
  const parser: StreamParser = adapter.createParser(spec);
  const decoder = new StringDecoder('utf8');
  const kept: NEvent[] = [];
  let seq = 0;
  let toolSteps = 0;
  let offset = 0;
  let lastBeatMtime = 0;
  let lastErrSize = 0;
  let harnessPid = ctx.harnessPid;

  const deliver = async (bodies: ReturnType<StreamParser['push']>) => {
    if (!bodies.length) return;
    const evs = stamp(spec.runId, seq + 1, bodies);
    seq += bodies.length;
    for (const e of evs) {
      if (e.t === 'tool_call') toolSteps += 1;
      if (KEEP_FOR_CLASSIFY(e)) kept.push(e);
      if (e.seq > ctx.fromSeq) {
        try {
          await sink.onEvent(e);
        } catch {
          /* sink 错误不影响 run */
        }
      }
    }
  };

  const readMore = async (): Promise<boolean> => {
    let fh: fs.FileHandle;
    try {
      fh = await fs.open(lf.stdout, 'r');
    } catch {
      return false;
    }
    let grew = false;
    try {
      const buf = Buffer.alloc(256 * 1024);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        grew = true;
        await deliver(parser.push(decoder.write(buf.subarray(0, bytesRead))));
      }
    } finally {
      await fh.close();
    }
    return grew;
  };

  const activityProbe = async (): Promise<boolean> => {
    let active = false;
    try {
      const st = await fs.stat(lf.heartbeat);
      if (st.mtimeMs > lastBeatMtime) {
        lastBeatMtime = st.mtimeMs;
        active = true;
      }
    } catch {
      /* none yet */
    }
    try {
      const st = await fs.stat(lf.stderr);
      if (st.size > lastErrSize) {
        lastErrSize = st.size;
        active = true;
      }
    } catch {
      /* none */
    }
    return active;
  };

  const readStderrTail = async (): Promise<string> => {
    try {
      const fh = await fs.open(lf.stderr, 'r');
      try {
        const st = await fh.stat();
        const len = Math.min(8192, st.size);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        return buf.toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      return '';
    }
  };

  const done: Promise<RunResult> = (async () => {
    let lastShimCheck = Date.now();
    for (;;) {
      const grew = await readMore();
      const active = (await activityProbe()) || grew;
      if (active) sink.onActivity?.();
      if (harnessPid === null) harnessPid = (await readJsonFile<ShimPidInfo>(lf.pid))?.harnessPid ?? null;
      if (existsSync(lf.exit)) break;
      if (Date.now() - lastShimCheck > 2000) {
        lastShimCheck = Date.now();
        if (ctx.shimPid && !pidAlive(ctx.shimPid) && !existsSync(lf.exit)) {
          // shim 意外死亡且没写 exit.json：合成一个
          await sleep(300);
          if (!existsSync(lf.exit)) {
            const synth: ShimExit = {
              code: null,
              signal: null,
              startedAt: ctx.startedAt,
              endedAt: new Date().toISOString(),
              wallMs: Date.now() - Date.parse(ctx.startedAt),
              timedOut: null,
              killed: null,
              spawnError: 'nv-shim 意外退出（未写 exit.json）',
            };
            await atomicWrite(lf.exit, JSON.stringify(synth));
          }
          break;
        }
      }
      await sleep(active ? 50 : 200);
    }
    await readMore();
    await deliver(parser.push(decoder.end()));
    await deliver(parser.end());
    const raw = (await readJsonFile<ShimExit>(lf.exit)) ?? {
      code: null,
      signal: null,
      startedAt: ctx.startedAt,
      endedAt: new Date().toISOString(),
      wallMs: 0,
      timedOut: null,
      killed: null,
      spawnError: 'exit.json 不可读',
    };
    const exit: ExitInfo = { code: raw.code, signal: raw.signal, wallMs: raw.wallMs, timedOut: raw.timedOut, killed: raw.killed };
    const stderrTail = await readStderrTail();
    let outcome: Outcome;
    if (raw.spawnError) {
      outcome = {
        status: 'failed',
        errorClass: /ENOENT|not found|EACCES/i.test(raw.spawnError) ? 'config' : 'harness_crash',
        message: raw.spawnError,
        usage: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costSource: 'unknown' },
        denials: [],
        exitCode: null,
        signal: null,
        rateLimits: [],
      };
    } else {
      outcome = adapter.classify(exit, kept, stderrTail);
    }
    const audit = await postRunAudit({ outDir: ctx.meta.outDir, declaredGlobs: ctx.meta.declaredGlobs, homeConfigHashes: ctx.meta.homeConfigHashes });
    if (audit.tamperedConfig.length && outcome.status === 'completed') {
      outcome = { ...outcome, status: 'failed', errorClass: 'sandbox', message: `home 配置文件被改动：${audit.tamperedConfig.join(', ')}` };
    }
    return { outcome, exit, eventCount: seq, toolSteps, audit, stdoutFile: lf.stdout, stderrTail };
  })();

  return {
    runId: spec.runId,
    shimPid: ctx.shimPid,
    get harnessPid() {
      return harnessPid;
    },
    startedAt: ctx.startedAt,
    argvPreview: ctx.argvPreview,
    wait: () => done,
    async kill(reason) {
      if (existsSync(lf.exit)) return;
      await atomicWrite(lf.kill, reason);
    },
  };
}

/** 不经 shim 的同步执行（probe / listModels / login 以外的短命令） */
export async function runShort(inv: Invocation, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [cmd, ...args] = inv.argv;
  if (!cmd) return { code: null, stdout: '', stderr: 'empty argv' };
  let stdinFd: number | 'ignore' = 'ignore';
  if (inv.stdin !== 'devnull') stdinFd = openSync(inv.stdin.file, 'r');
  return await new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    const CAP = 4 * 1024 * 1024;
    let settled = false;
    const child = spawn(cmd, args, { cwd: inv.cwd, env: inv.env, stdio: [stdinFd, 'pipe', 'pipe'], detached: true });
    const finish = (code: number | null, extraErr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof stdinFd === 'number') closeSync(stdinFd);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + extraErr });
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      finish(null, `\n[timeout after ${timeoutMs}ms]`);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (outLen < CAP) out.push(d);
      outLen += d.length;
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errLen < CAP) err.push(d);
      errLen += d.length;
    });
    child.on('error', (e) => finish(null, `\n${e.message}`));
    child.on('close', (code) => finish(code));
  });
}
