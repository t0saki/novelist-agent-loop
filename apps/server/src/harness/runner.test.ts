import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NEvent } from '@novelist/shared';
import { countCjk } from '@novelist/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { getAdapter } from './registry.js';
import { logFiles, reattachRun, runShort, startRun } from './runner.js';
import { makeRunFixture, type RunFixture } from './testing.js';
import { sleep } from './util.js';

process.env.NOVELIST_SHIM_TICK_MS = '50';

const fixtures: RunFixture[] = [];
async function fx(o: Parameters<typeof makeRunFixture>[0] = {}) {
  const f = await makeRunFixture(o);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

function collector() {
  const events: NEvent[] = [];
  let activity = 0;
  return { events, sink: { onEvent: (e: NEvent) => void events.push(e), onActivity: () => void activity++ }, activity: () => activity };
}

describe('runner + nv-shim + fake harness', () => {
  it('happy path: writes the chapter into the book snapshot (directory contract), events are sequenced, outcome completed', async () => {
    const f = await fx();
    const c = collector();
    const h = await startRun(f.prepared, c.sink);
    expect(h.shimPid).toBeGreaterThan(0);
    const r = await h.wait();
    expect(r.outcome.status).toBe('completed');
    expect(r.outcome.errorClass).toBeUndefined();
    expect(r.exit.code).toBe(0);
    expect(r.audit).toEqual({ ok: true, extraFiles: [], tamperedConfig: [] });
    expect(c.events.map((e) => e.seq)).toEqual(c.events.map((_, i) => i + 1));
    expect(r.eventCount).toBe(c.events.length);
    expect(c.events[0]!.t).toBe('init');
    expect(c.events.at(-1)!.t).toBe('result');
    const chapter = readFileSync(path.join(f.spec.bookDir, 'manuscript/c00001.md'), 'utf8');
    expect(chapter).toMatch(/^# 第1章 /);
    expect(countCjk(chapter, 'han')).toBeGreaterThanOrEqual(300);
    // 没有回执、没有 out/ 产物
    expect(existsSync(path.join(f.spec.outDir, 'receipt.json'))).toBe(false);
    expect(r.outcome.usage.output).toBeGreaterThan(0);
    // spec.json 在 in/，秘密 env 文件已被 shim 删除
    expect(existsSync(path.join(f.spec.inDir, 'spec.json'))).toBe(true);
    expect(existsSync(logFiles(f.spec.logDir).secretEnv)).toBe(false);
  });

  it('bwrap: binPath 是软链时把真实安装根只读绑定进沙箱，且在 $DATA 遮蔽之后', async () => {
    const f = await fx({ isolation: 'bwrap' });
    const prefix = path.join(f.dataRoot, 'harness', 'fake', '1.0.0');
    const real = path.join(prefix, 'node_modules', '.bin', 'fake');
    const link = path.join(f.dataRoot, 'harness', 'bin', 'fake');
    await fs.mkdir(path.dirname(real), { recursive: true });
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.writeFile(real, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.symlink(real, link);
    f.prepared.install.binPath = link;
    await (await startRun(f.prepared, collector().sink)).wait();
    const argv = (JSON.parse(readFileSync(path.join(f.spec.logDir, 'shim.spec.json'), 'utf8')) as { argv: string[] }).argv;
    const bind = argv.findIndex((a, i) => a === prefix && argv[i - 1] === '--ro-bind-try');
    expect(bind).toBeGreaterThan(argv.findIndex((a, i) => a === f.dataRoot && argv[i - 1] === '--tmpfs'));
    expect(argv.findIndex((a, i) => a === f.dataRoot && argv[i - 1] === '--tmpfs')).toBeGreaterThan(0);
  });

  it('secrets never land in spec.json and are masked in argvPreview', async () => {
    const f = await fx({ account: { secretEnv: { FAKE_API_KEY: 'sk-supersecret-123456' } } });
    const h = await startRun(f.prepared, collector().sink);
    await h.wait();
    const spec = readFileSync(path.join(f.spec.inDir, 'spec.json'), 'utf8');
    expect(spec).not.toContain('sk-supersecret-123456');
    expect(readFileSync(path.join(f.spec.logDir, 'shim.spec.json'), 'utf8')).not.toContain('sk-supersecret-123456');
  });

  it('injected rate_limit → failed/rate_limit with retryAfter', async () => {
    const f = await fx({ fake: { fail: 'rate_limit' } });
    const r = await (await startRun(f.prepared, collector().sink)).wait();
    expect(r.outcome.status).toBe('failed');
    expect(r.outcome.errorClass).toBe('rate_limit');
    expect(r.outcome.retryAfter).toBeTruthy();
  });

  it('no terminal event with exit 0 → drift; with non-zero exit → harness_crash', async () => {
    const a = await fx({ scenarioFile: { noResult: true } });
    expect((await (await startRun(a.prepared, collector().sink)).wait()).outcome.errorClass).toBe('drift');
    const b = await fx({ scenarioFile: { noResult: true, exitCode: 3 } });
    expect((await (await startRun(b.prepared, collector().sink)).wait()).outcome.errorClass).toBe('harness_crash');
  });

  it('idle timeout kills a silent harness', async () => {
    const f = await fx({ fake: { sleepMs: 10_000 }, limits: { idleMs: 600, wallMs: 20_000 } });
    const r = await (await startRun(f.prepared, collector().sink)).wait();
    expect(r.outcome.status).toBe('timeout');
    expect(r.outcome.errorClass).toBe('timeout_idle');
    expect(r.exit.timedOut).toBe('idle');
  });

  it('wall timeout fires even while the harness drips heartbeats', async () => {
    const f = await fx({ fake: { sleepMs: 10_000, dripMs: 100 }, limits: { idleMs: 5_000, wallMs: 900 } });
    const c = collector();
    const r = await (await startRun(f.prepared, c.sink)).wait();
    expect(r.outcome.errorClass).toBe('timeout_wall');
    expect(c.events.some((e) => e.t === 'heartbeat')).toBe(true);
    expect(c.activity()).toBeGreaterThan(0);
  });

  it('home config files changed by the harness are reported by the post-run audit (out/ is not audited any more)', async () => {
    const f = await fx({ fake: { sleepMs: 1500 } });
    const base = getAdapter('fake');
    const cfg = path.join(f.spec.inDir, 'fake.cfg');
    const adapter = { ...base, prepareHome: async () => ({ home: f.prepared.account.home, configFiles: [{ path: cfg, content: 'x' }], stateDirs: [], env: { HOME: f.prepared.account.home } }) };
    const h = await startRun({ ...f.prepared, adapter }, collector().sink);
    await fs.writeFile(cfg, 'tampered');
    await fs.writeFile(path.join(f.spec.outDir, 'stray.txt'), 'x');
    const r = await h.wait();
    expect(r.audit).toEqual({ ok: false, extraFiles: [], tamperedConfig: [cfg] });
    expect(r.outcome).toMatchObject({ status: 'failed', errorClass: 'sandbox' });
  });

  it('kill(user) → cancelled', async () => {
    const f = await fx({ fake: { sleepMs: 10_000, dripMs: 100 } });
    const h = await startRun(f.prepared, collector().sink);
    await sleep(300);
    await h.kill('user');
    const r = await h.wait();
    expect(r.outcome.status).toBe('cancelled');
    expect(r.exit.killed).toBe('user');
  });

  it('signal escalation: a harness ignoring SIGINT/SIGTERM gets SIGKILL', async () => {
    const f = await fx({ fake: { sleepMs: 20_000, dripMs: 100, ignoreSigterm: true } });
    const h = await startRun(f.prepared, collector().sink);
    await sleep(300);
    const t0 = Date.now();
    await h.kill('user');
    const r = await h.wait();
    expect(r.exit.signal).toBe('SIGKILL');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1800); // 1s SIGINT + 1s SIGTERM grace
    expect(r.outcome.status).toBe('cancelled');
  });

  it('malformed stdout lines become unknown events, never crash', async () => {
    const f = await fx({ fake: { malformedJson: true } });
    const c = collector();
    const r = await (await startRun(f.prepared, c.sink)).wait();
    expect(c.events.some((e) => e.t === 'unknown')).toBe(true);
    expect(r.outcome.status).toBe('completed');
  });

  it('reattach: a new handle continues after fromSeq; finished runs resolve immediately', async () => {
    const f = await fx({ fake: { sleepMs: 1500, dripMs: 100 } });
    const first = collector();
    const h = await startRun(f.prepared, first.sink);
    await sleep(500);
    const seen = first.events.length;
    expect(seen).toBeGreaterThan(0);
    // 模拟 serve 重启：另起一个 handle 从 seen 之后接管
    const second = collector();
    const h2 = await reattachRun(f.spec.runDir, getAdapter('fake'), f.spec, second.sink, seen);
    expect(h2).not.toBeNull();
    const r2 = await h2!.wait();
    await h.wait();
    expect(r2.outcome.status).toBe('completed');
    expect(second.events[0]!.seq).toBe(seen + 1);
    expect(second.events.at(-1)!.t).toBe('result');
    // 已结束的 run：reattach 直接返回结果，不重复投递
    const third = collector();
    const h3 = await reattachRun(f.spec.runDir, getAdapter('fake'), f.spec, third.sink, r2.eventCount);
    expect((await h3!.wait()).outcome.status).toBe('completed');
    expect(third.events).toHaveLength(0);
  });

  it('toolSteps counts tool_call events incl. on reattach (fromSeq > 0)', async () => {
    const f = await fx({ fake: { sleepMs: 1200, dripMs: 100 } });
    const first = collector();
    const h = await startRun(f.prepared, first.sink);
    const r = await h.wait();
    const calls = first.events.filter((e) => e.t === 'tool_call').length;
    expect(calls).toBeGreaterThan(0);
    expect(r.toolSteps).toBe(calls);
    // 已结束的 run 从末尾接管：一个事件都不再投递，步数照样从头数
    const late = collector();
    const h2 = await reattachRun(f.spec.runDir, getAdapter('fake'), f.spec, late.sink, r.eventCount);
    const r2 = await h2!.wait();
    expect(late.events).toHaveLength(0);
    expect(r2.toolSteps).toBe(calls);
  });

  it('reattach returns null when the shim is gone and no exit.json exists', async () => {
    const f = await fx();
    const lf = logFiles(f.spec.logDir);
    await fs.writeFile(lf.pid, JSON.stringify({ shimPid: 999_999_9, harnessPid: null, startedAt: new Date().toISOString(), bootId: null, shimStart: '1', harnessStart: null }));
    expect(await reattachRun(f.spec.runDir, getAdapter('fake'), f.spec, collector().sink, 0)).toBeNull();
  });

  it('pi is refused in the container backend (RunPrepareError not_allowed)', async () => {
    const f = await fx();
    const prepared = { ...f.prepared, spec: { ...f.spec, harness: 'pi' as const } };
    await expect(startRun(prepared, collector().sink)).rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('argv referencing a missing $RUN/in file is refused before spawn', async () => {
    const f = await fx();
    const base = getAdapter('fake');
    const adapter = {
      ...base,
      buildInvocation: (...a: Parameters<typeof base.buildInvocation>) => {
        const inv = base.buildInvocation(...a);
        return { ...inv, argv: [...inv.argv, '--json-schema', path.join(f.spec.inDir, 'missing.json')] };
      },
    };
    await expect(startRun({ ...f.prepared, adapter }, collector().sink)).rejects.toMatchObject({ code: 'missing_file' });
  });

  it('runShort captures output and enforces timeout', async () => {
    const ok = await runShort({ argv: [process.execPath, '-e', 'console.log("hi")'], env: { PATH: process.env.PATH ?? '' }, cwd: '/', stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 5000);
    expect(ok).toMatchObject({ code: 0, stdout: 'hi\n' });
    const slow = await runShort({ argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)'], env: {}, cwd: '/', stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 300);
    expect(slow.code).toBeNull();
    expect(slow.stderr).toContain('timeout');
  });
});
