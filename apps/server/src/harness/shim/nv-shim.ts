#!/usr/bin/env node
/**
 * nv-shim：进程监管（DESIGN §2.3）。Owner: lane A。
 * 用法：node nv-shim.js --spec $RUN/in/spec.json
 * 职责：spawn harness（新进程组）→ stdout/stderr 落盘 → wall/idle 超时 → 信号序列（发给 harness 进程组）→ 原子写 exit.json。
 * 必须是无依赖的单文件（构建后拷到 /opt/novelist/bin/nv-shim.js），不得 import 项目其他模块（spec 类型除外）。
 * 只用可擦除的 TS 语法：开发/测试时 node 直接以 type-stripping 运行本 .ts 文件。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { ShimExit, ShimPidInfo, ShimSpec } from './spec.js';

const KILL_FILE_NAME = 'kill';

function procStart(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}
function readBootId(): string | null {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return null;
  }
}
function writeAtomic(p: string, content: string): void {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

export async function runShim(spec: ShimSpec): Promise<number> {
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  let killed: ShimExit['killed'] = null;
  let timedOut: ShimExit['timedOut'] = null;
  let exited = false;
  let innerPid: number | null = null;
  const env: Record<string, string> = { ...spec.env };
  if (spec.envFile) {
    try {
      Object.assign(env, JSON.parse(fs.readFileSync(spec.envFile, 'utf8')) as Record<string, string>);
    } catch {
      /* 缺失 = 无秘密 */
    }
    try {
      fs.unlinkSync(spec.envFile);
    } catch {
      /* ignore */
    }
  }
  const logDir = path.dirname(spec.exitFile);
  const killFile = path.join(logDir, KILL_FILE_NAME);
  fs.mkdirSync(path.dirname(spec.stdoutFile), { recursive: true });
  const outFd = fs.openSync(spec.stdoutFile, 'a');
  const errFd = fs.openSync(spec.stderrFile, 'a');
  let inFd: number | 'ignore' = 'ignore';
  if (spec.stdin !== 'devnull') {
    try {
      inFd = fs.openSync(spec.stdin.file, 'r');
    } catch (e) {
      return finish({ code: null, signal: null, spawnError: `stdin: ${(e as Error).message}` });
    }
  }

  function finish(r: { code: number | null; signal: string | null; spawnError?: string }): number {
    const endedAt = new Date().toISOString();
    const exit: ShimExit = {
      code: r.code,
      signal: r.signal,
      startedAt,
      endedAt,
      wallMs: Date.now() - t0,
      timedOut,
      killed,
      ...(r.spawnError ? { spawnError: r.spawnError } : {}),
    };
    try {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    } catch {
      /* ignore */
    }
    writeAtomic(spec.exitFile, JSON.stringify(exit));
    return 0;
  }

  const stdio: ('ignore' | 'pipe' | number)[] = [inFd, 'pipe', 'pipe'];
  if (spec.infoFd) stdio.push('pipe');
  const [cmd, ...args] = spec.argv;
  if (!cmd) return finish({ code: null, signal: null, spawnError: 'empty argv' });

  return await new Promise<number>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: spec.cwd, env, detached: true, stdio: stdio as never });
    } catch (e) {
      resolve(finish({ code: null, signal: null, spawnError: (e as Error).message }));
      return;
    }
    let lastActivity = Date.now();
    let lastBeat = 0;
    let stopping = false;
    let resolved = false;
    const writePid = () => {
      const info: ShimPidInfo = {
        shimPid: process.pid,
        harnessPid: child.pid ?? null,
        innerPid,
        startedAt,
        bootId: readBootId(),
        shimStart: procStart(process.pid),
        harnessStart: child.pid ? procStart(child.pid) : null,
      };
      try {
        writeAtomic(spec.pidFile, JSON.stringify(info));
      } catch {
        /* ignore */
      }
    };

    child.on('error', (e) => {
      if (resolved) return;
      resolved = true;
      clearInterval(timer);
      resolve(finish({ code: null, signal: null, spawnError: e.message }));
    });
    if (child.pid) writePid();

    const activity = () => {
      lastActivity = Date.now();
      if (lastActivity - lastBeat >= 1000) {
        lastBeat = lastActivity;
        try {
          fs.writeFileSync(spec.heartbeatFile, new Date(lastActivity).toISOString());
        } catch {
          /* ignore */
        }
      }
    };

    // stdout：可选的 partial 采样（cc --include-partial-messages 的 stream_event 行）
    let lineBuf = '';
    let lastPartial = 0;
    const decoder = new StringDecoder('utf8');
    const writeOut = (s: string) => {
      if (s) fs.writeSync(outFd, s);
    };
    child.stdout?.on('data', (d: Buffer) => {
      activity();
      if (!spec.partialSampleMs) {
        fs.writeSync(outFd, d);
        return;
      }
      lineBuf += decoder.write(d);
      const parts = lineBuf.split('\n');
      lineBuf = parts.pop() ?? '';
      let out = '';
      for (const line of parts) {
        if (line.includes('"type":"stream_event"')) {
          const now = Date.now();
          if (now - lastPartial < spec.partialSampleMs) continue;
          lastPartial = now;
        }
        out += `${line}\n`;
      }
      writeOut(out);
    });
    child.stderr?.on('data', (d: Buffer) => {
      activity();
      fs.writeSync(errFd, d);
    });
    if (spec.infoFd) {
      const info = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
      let ib = '';
      info?.on('data', (d: Buffer) => {
        ib += d.toString('utf8');
        const m = ib.match(/"child-pid"\s*:\s*(\d+)/);
        if (m && !innerPid) {
          innerPid = Number(m[1]);
          writePid();
        }
      });
      info?.on('error', () => {});
    }

    const signalAll = (sig: NodeJS.Signals) => {
      const targets = [innerPid, child.pid].filter((p): p is number => !!p);
      for (const pid of targets) {
        try {
          process.kill(-pid, sig);
        } catch {
          try {
            process.kill(pid, sig);
          } catch {
            /* gone */
          }
        }
      }
    };
    const waitExit = (ms: number) =>
      new Promise<boolean>((r) => {
        if (exited) return r(true);
        const t = setTimeout(() => r(exited), ms);
        child.once('exit', () => {
          clearTimeout(t);
          r(true);
        });
      });
    const beginStop = async () => {
      if (stopping) return;
      stopping = true;
      for (const step of spec.stop) {
        if (exited) return;
        signalAll(step.signal);
        if (await waitExit(step.graceMs)) return;
      }
      if (!exited) signalAll('SIGKILL');
    };

    const tick = Math.max(20, spec.tickMs ?? 250);
    const timer = setInterval(() => {
      if (stopping || exited) return;
      const now = Date.now();
      if (fs.existsSync(killFile)) {
        let reason = 'user';
        try {
          reason = fs.readFileSync(killFile, 'utf8').trim() || 'user';
        } catch {
          /* ignore */
        }
        killed = reason === 'shutdown' ? 'shutdown' : 'user';
        void beginStop();
      } else if (spec.wallMs > 0 && now - t0 > spec.wallMs) {
        timedOut = 'wall';
        void beginStop();
      } else if (spec.idleMs > 0 && now - lastActivity > spec.idleMs) {
        timedOut = 'idle';
        void beginStop();
      }
    }, tick);

    const onSelfSignal = () => {
      if (!killed && !timedOut) killed = 'shutdown';
      void beginStop();
    };
    process.on('SIGTERM', onSelfSignal);
    process.on('SIGINT', onSelfSignal);
    process.on('SIGHUP', onSelfSignal);

    child.on('exit', (code, signal) => {
      exited = true;
      clearInterval(timer);
      // 等 stdio 排空（最多 2s；残留孙进程占着管道时不无限等）
      let pending = 2;
      const done = () => {
        if (resolved) return;
        resolved = true;
        lineBuf += decoder.end();
        if (lineBuf) writeOut(lineBuf);
        lineBuf = '';
        // 清理进程组里的残留子进程
        for (const pid of [innerPid, child.pid]) {
          if (!pid) continue;
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* none */
          }
        }
        resolve(finish({ code, signal }));
      };
      const t = setTimeout(done, 2000);
      const one = () => {
        pending--;
        if (pending <= 0) {
          clearTimeout(t);
          done();
        }
      };
      if (child.stdout && !child.stdout.readableEnded) child.stdout.once('end', one);
      else one();
      if (child.stderr && !child.stderr.readableEnded) child.stderr.once('end', one);
      else one();
    });
  });
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const i = process.argv.indexOf('--spec');
  const specPath = i >= 0 ? process.argv[i + 1] : undefined;
  if (!specPath) {
    process.stderr.write('usage: nv-shim --spec <spec.json>\n');
    process.exit(64);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as ShimSpec;
  runShim(spec).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`nv-shim: ${(err as Error).stack ?? err}\n`);
      try {
        writeAtomic(
          spec.exitFile,
          JSON.stringify({
            code: null,
            signal: null,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            wallMs: 0,
            timedOut: null,
            killed: null,
            spawnError: `shim crash: ${(err as Error).message}`,
          }),
        );
      } catch {
        /* ignore */
      }
      process.exit(70);
    },
  );
}
