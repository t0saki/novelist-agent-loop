/**
 * harness 层其余模块的单测：classify、util、isolation、home、login、shim、probe、install。不调真实 CLI。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account, HarnessInstall, NEvent } from '@novelist/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataPaths } from '../config/index.js';
import { detectBin } from './adapters/common.js';
import { buildOutcome, classifyText, rateLimitClass } from './classify.js';
import { accountHome, createMemorySecretStore, resolveAccount, syncBackCredentials } from './home.js';
import { planInstall, writeLockEntry } from './install.js';
import { _resetIsolationCache, isAllowed, mountPlanFor, postRunAudit, probeIsolation, wrapInvocation } from './isolation.js';
import { createLoginManager, type LoginResult } from './login.js';
import { defaultCapabilities, runProbe } from './probe.js';
import { getAdapter } from './registry.js';
import { shimScriptPath } from './runner.js';
import type { ShimExit, ShimSpec } from './shim/spec.js';
import { makeRunFixture } from './testing.js';
import type { ExitInfo, HarnessAdapter, Invocation, LoginCommand, ResolvedAccount, RunSpec } from './types.js';
import { argvPreview, compareSemver, extractUrls, globToRegExp, parseVersion, pidAlive, satisfies, shQuote, sleep, stripAnsi } from './util.js';

const tmpDirs: string[] = [];
async function mkTmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-h-'));
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
});

const EXIT: ExitInfo = { code: 0, signal: null, wallMs: 1, timedOut: null, killed: null };
let seq = 0;
const ev = (b: Record<string, unknown>) => ({ ...b, seq: ++seq, ts: '2026-11-08T00:00:00.000Z', runId: 'r' }) as NEvent;
const okResult = () => ev({ t: 'result', status: 'success' });
const completedWhenSuccess = {
  completed: (x: ExitInfo, es: NEvent[]) => {
    const r = [...es].reverse().find((e) => e.t === 'result');
    return x.code === 0 && r?.t === 'result' && r.status === 'success';
  },
};

describe('classifyText', () => {
  it.each([
    ['Please run /login · Login expired', 'auth'],
    ['HTTP 401 Unauthorized', 'auth'],
    ['Not signed in', 'auth'],
    ['unexpected status 503 Service Unavailable: auth_unavailable: no auth available (providers=codex)', 'auth'],
    ['You exceeded your current quota', 'quota'],
    ['RESOURCE_EXHAUSTED', 'quota'],
    ['429 Too Many Requests', 'rate_limit'],
    ['rate limit exceeded', 'rate_limit'],
    ['529 overloaded_error', 'overloaded'],
    ['502 Bad Gateway', 'overloaded'],
    ['Insufficient Balance', 'billing'],
    ['prompt is too long: 300000 tokens', 'context_overflow'],
    ['context_length_exceeded', 'context_overflow'],
    ['Unknown model: foo', 'model_unavailable'],
    ['model gpt-x does not exist', 'model_unavailable'],
    ['connect ECONNREFUSED 1.2.3.4', 'network'],
    ['blocked by safety filter', 'refusal'],
    ['bwrap: setting up uid map: Permission denied', 'sandbox'],
    ["error: unexpected argument '--nope' found", 'config'],
  ])('%s → %s', (text, cls) => {
    expect(classifyText(text)).toBe(cls);
  });
  it('没有已知特征 → null', () => {
    expect(classifyText('something odd')).toBeNull();
    expect(classifyText('   ')).toBeNull();
  });
  it('rateLimitClass：分钟级 = rate_limit，订阅窗口 = quota', () => {
    expect(rateLimitClass('minute')).toBe('rate_limit');
    expect(rateLimitClass('5h')).toBe('quota');
    expect(rateLimitClass('7d')).toBe('quota');
  });
});

describe('buildOutcome', () => {
  it('completed 只看终止事件与退出码；denial 只作遥测', () => {
    const o = buildOutcome(EXIT, [ev({ t: 'denial', tool: 'Write', path: '/x' }), okResult()], '', completedWhenSuccess);
    expect(o.status).toBe('completed');
    expect(o.denials).toEqual([{ tool: 'Write', path: '/x' }]);
  });
  it('killed 优先于一切 → cancelled', () => {
    expect(buildOutcome({ ...EXIT, killed: 'shutdown' }, [okResult()], '', completedWhenSuccess)).toMatchObject({ status: 'cancelled', message: 'killed: shutdown' });
  });
  it('wall / idle 超时', () => {
    expect(buildOutcome({ ...EXIT, code: null, signal: 'SIGKILL', timedOut: 'wall' }, [], '', completedWhenSuccess)).toMatchObject({ status: 'timeout', errorClass: 'timeout_wall' });
    expect(buildOutcome({ ...EXIT, code: null, signal: 'SIGKILL', timedOut: 'idle' }, [], '', completedWhenSuccess)).toMatchObject({ status: 'timeout', errorClass: 'timeout_idle' });
  });
  it('error 事件优先：具体分类 > 文本推断', () => {
    expect(buildOutcome({ ...EXIT, code: 1 }, [ev({ t: 'error', cls: 'auth', message: 'x', retryable: false }), ev({ t: 'result', status: 'error' })], 'rate limit', completedWhenSuccess).errorClass).toBe('auth');
  });
  it('refusal / max_turns / harness timeout 按终止状态分类', () => {
    expect(buildOutcome(EXIT, [ev({ t: 'result', status: 'refusal' })], '', completedWhenSuccess).errorClass).toBe('refusal');
    expect(buildOutcome(EXIT, [ev({ t: 'result', status: 'max_turns' })], '', completedWhenSuccess).errorClass).toBe('max_turns');
    expect(buildOutcome(EXIT, [ev({ t: 'result', status: 'timeout' })], '', completedWhenSuccess)).toMatchObject({ status: 'timeout', errorClass: 'timeout_wall' });
    expect(buildOutcome(EXIT, [ev({ t: 'result', status: 'cancelled' })], '', completedWhenSuccess).status).toBe('cancelled');
  });
  it('rejected 的分钟窗口 → rate_limit + retryAfter', () => {
    const o = buildOutcome({ ...EXIT, code: 1 }, [ev({ t: 'rate_limit', window: 'minute', status: 'rejected', resetsAt: '2026-11-08T01:00:00.000Z' }), ev({ t: 'result', status: 'error' })], '', completedWhenSuccess);
    expect(o).toMatchObject({ errorClass: 'rate_limit', retryAfter: '2026-11-08T01:00:00.000Z' });
  });
  it('stderr 文本推断；exitCodeClass；崩溃与 drift', () => {
    expect(buildOutcome({ ...EXIT, code: 1 }, [], 'Error: 503 Service Unavailable\n', completedWhenSuccess).errorClass).toBe('overloaded');
    expect(buildOutcome({ ...EXIT, code: 7 }, [], '', { ...completedWhenSuccess, exitCodeClass: () => 'config' }).errorClass).toBe('config');
    expect(buildOutcome({ ...EXIT, code: null, signal: 'SIGSEGV' }, [], '', completedWhenSuccess).errorClass).toBe('harness_crash');
    expect(buildOutcome({ ...EXIT, code: 2 }, [], '', completedWhenSuccess).errorClass).toBe('harness_crash');
    expect(buildOutcome(EXIT, [], '', completedWhenSuccess).errorClass).toBe('drift');
  });
  it('postCheck 能把 completed 判成失败', () => {
    const o = buildOutcome(EXIT, [okResult()], '', { ...completedWhenSuccess, postCheck: () => ({ cls: 'sandbox', message: 'nope' }) });
    expect(o).toMatchObject({ status: 'failed', errorClass: 'sandbox', message: 'nope' });
  });
  it('usage 与 receipt 带进 Outcome', () => {
    const o = buildOutcome(EXIT, [ev({ t: 'usage', input: 5, output: 2, costSource: 'unknown', scope: 'delta' }), ev({ t: 'usage', input: 7, output: 3, costSource: 'unknown', scope: 'delta' }), ev({ t: 'result', status: 'success', structured: { a: 1 } })], '', completedWhenSuccess);
    expect(o.usage).toMatchObject({ input: 12, output: 5 });
    expect(o.receipt).toEqual({ a: 1 });
  });
});

describe('util', () => {
  it('semver 比较与区间', () => {
    expect(compareSemver('2.1.319', '2.1.293')).toBeGreaterThan(0);
    expect(compareSemver('0.2.2-rc.1', '0.2.2')).toBeLessThan(0);
    expect(satisfies('2.1.319', '>=2.1.293')).toBe(true);
    expect(satisfies('2.2.0', '>=2.1.293 <2.2')).toBe(false);
    expect(satisfies('0.2.2-rc.1', '>=0.2.2-rc.1')).toBe(true);
    expect(satisfies('1.0.0', '*')).toBe(true);
    expect(satisfies('1.5.0', '<1 || >=1.5')).toBe(true);
  });
  it('parseVersion', () => {
    expect(parseVersion('2.1.319 (Claude Code)')).toBe('2.1.319');
    expect(parseVersion('codex-cli 0.165.0\n')).toBe('0.165.0');
    expect(parseVersion('dsh 0.2.2-rc.1')).toBe('0.2.2-rc.1');
    expect(parseVersion('none')).toBeNull();
  });
  it('stripAnsi / extractUrls（含 OSC 8）', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m\r\nline\rover')).toBe('red\nline\nover');
    expect(extractUrls('打开 \x1b]8;;https://a.example/x?y=1\x07link\x1b]8;;\x07 或 https://b.example/z.')).toEqual(['https://a.example/x?y=1', 'https://b.example/z']);
  });
  it('argvPreview 打码并截断超长参数', () => {
    const out = argvPreview(['--key', 'sk-abcdefghijkl', 'x'.repeat(500)], ['sk-abcdefghijkl']);
    expect(out[1]).toBe('sk-a***kl');
    expect(out[2]).toContain('(500 bytes)');
  });
  it('globToRegExp', () => {
    expect(globToRegExp('manuscript/*.md').test('manuscript/c1.md')).toBe(true);
    expect(globToRegExp('manuscript/*.md').test('manuscript/a/c1.md')).toBe(false);
    expect(globToRegExp('state/**').test('state/a/b.json')).toBe(true);
    expect(globToRegExp('receipt.json').test('receiptXjson')).toBe(false);
  });
  it('shQuote', () => {
    expect(shQuote('/opt/bin/x')).toBe('/opt/bin/x');
    expect(shQuote("a b'c")).toBe(`'a b'\\''c'`);
  });
});

describe('isolation', () => {
  const spec = {
    runDir: '/data/runs/2026-11/r1',
    bookDir: '/data/runs/2026-11/r1/book',
    outDir: '/data/runs/2026-11/r1/book/work/t/attempt-1/out',
    inDir: '/data/runs/2026-11/r1/in',
    logDir: '/data/runs/2026-11/r1/log',
  } as RunSpec;
  const inv: Invocation = { argv: ['/bin/h', 'x'], env: { A: '1' }, cwd: spec.bookDir, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] };

  it('isAllowed 矩阵（§3.6）', () => {
    expect(isAllowed('disableable', 'claude-code', 'degraded').ok).toBe(true);
    expect(isAllowed('always', 'codex', 'degraded').ok).toBe(false);
    expect(isAllowed('always', 'dsh', 'degraded').ok).toBe(false);
    expect(isAllowed('always', 'codex', 'container').ok).toBe(true);
    expect(isAllowed('disableable', 'pi', 'container').ok).toBe(false);
    expect(isAllowed('disableable', 'pi', 'degraded').ok).toBe(false);
    expect(isAllowed('disableable', 'pi', 'bwrap').ok).toBe(true);
  });

  it('mountPlanFor：book/in 只读，out/log/home 可写，$DATA 被遮蔽', () => {
    const p = mountPlanFor(spec, ['/data/accounts/a/home'], ['/opt/h']);
    expect(p.ro).toEqual(expect.arrayContaining([spec.bookDir, spec.inDir, '/opt/h']));
    expect(p.rw).toEqual(expect.arrayContaining([spec.outDir, spec.logDir, '/data/accounts/a/home']));
    expect(p.mask).toEqual(['/data']);
  });

  it('container 档不改 argv，只并入路径', () => {
    const w = wrapInvocation(inv, 'container', { ro: ['/r'], rw: ['/w'], mask: [] });
    expect(w.argv).toEqual(inv.argv);
    expect(w.readPaths).toContain('/r');
    expect(w.writePaths).toContain('/w');
  });

  it('bwrap 档：挂载顺序 tmpfs 遮蔽 → 只读 → 可写（嵌套的 out 最后），--info-fd 3', () => {
    const w = wrapInvocation(inv, 'bwrap', { ro: [spec.bookDir, spec.inDir], rw: [spec.outDir], mask: ['/data'] });
    const a = w.argv;
    expect(a[0]).toBe('bwrap');
    expect(a).toContain('--unshare-pid');
    expect(a[a.indexOf('--info-fd') + 1]).toBe('3');
    expect(a.slice(-3)).toEqual(['--', '/bin/h', 'x']);
    expect(a[a.indexOf('--chdir') + 1]).toBe(spec.bookDir);
    const mask = a.indexOf('/data');
    const ro = a.indexOf(spec.bookDir);
    const rw = a.indexOf(spec.outDir);
    expect(mask).toBeGreaterThan(0);
    expect(ro).toBeGreaterThan(mask);
    expect(rw).toBeGreaterThan(ro);
    expect(a[rw - 1]).toBe('--bind-try');
  });

  it('probeIsolation：显式 container 档总被选中；结果可缓存/刷新', async () => {
    _resetIsolationCache();
    const p = await probeIsolation('container');
    expect(p.selected).toBe('container');
    expect(p.backends.map((b) => b.backend).sort()).toEqual(['bwrap', 'container', 'degraded', 'landlock']);
    expect(p.backends.find((b) => b.backend === 'landlock')?.available).toBe(false);
    expect(await probeIsolation('container')).toBe(p);
    expect(await probeIsolation('container', { refresh: true })).not.toBe(p);
    _resetIsolationCache();
  });

  it('postRunAudit：多余文件、配置被改', async () => {
    const d = await mkTmp();
    await fs.mkdir(path.join(d, 'out/m'), { recursive: true });
    await fs.writeFile(path.join(d, 'out/m/c1.md'), 'x');
    await fs.writeFile(path.join(d, 'out/stray.txt'), 'x');
    const cfg = path.join(d, 'cfg');
    await fs.writeFile(cfg, 'after');
    const r = await postRunAudit({ outDir: path.join(d, 'out'), declaredGlobs: ['m/*.md', 'receipt.json'], homeConfigHashes: { [cfg]: 'deadbeef', [path.join(d, 'gone')]: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.extraFiles).toEqual(['stray.txt']);
    expect(r.tamperedConfig).toEqual([cfg, path.join(d, 'gone')]);
  });
});

describe('home', () => {
  function account(o: Partial<Account> = {}): Account {
    return {
      id: 'a1',
      harness: 'codex',
      label: '',
      authMode: 'credential_file',
      plan: '',
      enabled: true,
      env: [],
      files: [],
      customModels: [],
      concurrency: 1,
      reservePct: 30,
      windows: [],
      riskAck: [],
      notes: '',
      ...o,
    } as Account;
  }
  async function setup(content = '{"v":1}') {
    const root = await mkTmp();
    const paths = { accounts: root } as DataPaths;
    const secrets = createMemorySecretStore();
    const ref = await secrets.put({ kind: 'file', ownerKind: 'account', ownerId: 'a1', name: '.codex/auth.json', value: content });
    const acct = account({ files: [{ relPath: '.codex/auth.json', part: 'state', secretId: ref.id, sha256: ref.sha256, bytes: ref.bytes }] as Account['files'] });
    return { root, paths, secrets, acct, abs: path.join(accountHome(paths, 'a1'), '.codex/auth.json') };
  }

  it('解密 env 与文件，文件 0600', async () => {
    const { paths, secrets, acct, abs } = await setup();
    const s = await secrets.put({ kind: 'env', ownerKind: 'account', ownerId: 'a1', name: 'K', value: 'sekrit' });
    const r = await resolveAccount({ ...acct, env: [{ name: 'K', secret: true, secretId: s.id }, { name: 'U', secret: false, value: 'plain' }] as Account['env'] }, paths, secrets);
    expect(r.secretEnv).toEqual({ K: 'sekrit', U: 'plain' });
    expect(readFileSync(abs, 'utf8')).toBe('{"v":1}');
    expect(statSync(abs).mode & 0o777).toBe(0o600);
    expect(r.credentialFiles).toEqual([{ relPath: '.codex/auth.json', absPath: abs, part: 'state' }]);
  });

  it('harness 刷新过的 state 文件不被旧 secret 覆盖，且 syncBack 回写', async () => {
    const { paths, secrets, acct, abs } = await setup();
    const r1 = await resolveAccount(acct, paths, secrets);
    writeFileSync(abs, '{"v":2}');
    const r2 = await resolveAccount(acct, paths, secrets);
    expect(readFileSync(abs, 'utf8')).toBe('{"v":2}');
    expect(await syncBackCredentials(r2, secrets)).toEqual(['.codex/auth.json']);
    expect((await secrets.get(r2.files[0]!.secretId)).toString()).toBe('{"v":2}');
    expect(await syncBackCredentials(r2, secrets)).toEqual([]);
    void r1;
  });

  it('用户上传新文件（secret 变了、磁盘未被 harness 改动）→ 覆盖磁盘', async () => {
    const { paths, secrets, acct, abs } = await setup();
    await resolveAccount(acct, paths, secrets);
    const ref = await secrets.put({ kind: 'file', ownerKind: 'account', ownerId: 'a1', name: '.codex/auth.json', value: '{"v":3}' });
    await resolveAccount({ ...acct, files: [{ ...acct.files[0]!, secretId: ref.id, sha256: ref.sha256, bytes: ref.bytes }] }, paths, secrets);
    expect(readFileSync(abs, 'utf8')).toBe('{"v":3}');
  });

  it('config 部分总被 secret 覆盖；路径越界被拒', async () => {
    const { paths, secrets, acct, abs } = await setup();
    const cfg = { ...acct, files: [{ ...acct.files[0]!, part: 'config' as const }] };
    await resolveAccount(cfg, paths, secrets);
    writeFileSync(abs, 'tampered');
    await resolveAccount(cfg, paths, secrets);
    expect(readFileSync(abs, 'utf8')).toBe('{"v":1}');
    await expect(resolveAccount({ ...acct, files: [{ ...acct.files[0]!, relPath: '../../escape' }] }, paths, secrets)).rejects.toThrow('越界');
  });
});

describe('login', () => {
  const INST: HarnessInstall = { id: 'fake', version: '1.0.0', binPath: process.execPath, sha256: '', sha256Source: 'tofu', tier: 'probed', status: 'active' };
  async function acct(): Promise<ResolvedAccount> {
    const f = await makeRunFixture({ dataRoot: await mkTmp() });
    return { ...f.prepared.account };
  }
  function adapterWith(cmd: (a: ResolvedAccount) => LoginCommand): HarnessAdapter {
    return { ...getAdapter('fake'), loginCommand: (a) => cmd(a) };
  }
  const nodeCmd = (a: ResolvedAccount, script: string, extra: Partial<LoginCommand> = {}): LoginCommand => ({ argv: [process.execPath, '-e', script], env: { PATH: process.env.PATH ?? '', HOME: a.home }, cwd: a.home, ...extra });
  async function until(fn: () => boolean, ms = 8000) {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
      await sleep(25);
    }
  }
  const allText = (h: { output(): { text: string; stream: string }[] }) => h.output().map((c) => c.text).join('');

  it('fake 登录：提取 URL/验证码 → 输入 → 成功，凭据文件登记，捕获的 token 在输出中打码', async () => {
    const a = await acct();
    const finished: LoginResult[] = [];
    const m = createLoginManager({ onFinished: async (_s, _a, r) => void finished.push(r) });
    const h = await m.start(getAdapter('fake'), a, INST, 'subscription_login');
    await until(() => h.session().state === 'waiting_user');
    expect(h.session().urls).toEqual(['https://fake.example.invalid/device']);
    expect(h.session().codes).toEqual(['FAKE-1234']);
    await until(() => allText(h).includes('粘贴授权码'));
    h.write('my-code');
    await until(() => h.session().state === 'succeeded');
    expect(h.session().exitCode).toBe(0);
    expect(finished).toHaveLength(1);
    expect(finished[0]!.files).toEqual([{ relPath: '.fake/auth.json', part: 'state', absPath: path.join(a.home, '.fake/auth.json') }]);
    expect(finished[0]!.capturedEnv.FAKE_TOKEN).toBe('fake-oauth-SECRETVALUE123');
    const text = allText(h);
    expect(text).not.toContain('SECRETVALUE123');
    expect(text).toContain('（已捕获）');
    // 用户输入不回显原文
    expect(text).not.toContain('my-code');
    expect(m.get(h.session().id)).toBe(h);
    expect(m.list().map((s) => s.id)).toEqual([h.session().id]);
  });

  it('无效授权码 → failed，不回调', async () => {
    const a = await acct();
    let called = 0;
    const m = createLoginManager({ onFinished: async () => void called++ });
    const h = await m.start(getAdapter('fake'), a, INST, 'subscription_login');
    await until(() => allText(h).includes('粘贴授权码'));
    h.write('bad');
    await until(() => h.session().state === 'failed');
    expect(called).toBe(0);
    expect(existsSync(path.join(a.home, '.fake/auth.json'))).toBe(false);
  });

  it('不支持的模式抛错', async () => {
    await expect(createLoginManager({}).start(getAdapter('fake'), await acct(), INST, 'api_key')).rejects.toThrow('不支持');
  });

  it('cancel 杀掉整个进程组', async () => {
    const a = await acct();
    const m = createLoginManager({});
    const pidFile = path.join(a.home, 'child.pid');
    const script = `const cp=require('child_process');const g=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));console.log('https://x.example/a');setInterval(()=>{},1000)`;
    const h = await m.start(adapterWith((x) => nodeCmd(x, script)), a, INST, 'subscription_login');
    await until(() => h.session().state === 'waiting_user');
    h.cancel();
    expect(h.session().state).toBe('cancelled');
    expect(h.session().endedAt).not.toBeNull();
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => !pidAlive(pid));
    h.write('ignored');
  });

  it('无活动过期 → expired 并终止进程', async () => {
    const a = await acct();
    const m = createLoginManager({ idleMs: 150 });
    const pidFile = path.join(a.home, 'child.pid');
    const h = await m.start(adapterWith((x) => nodeCmd(x, `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`)), a, INST, 'subscription_login');
    await until(() => h.session().state === 'expired');
    expect(allText(h)).toContain('无活动');
    await until(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => !pidAlive(pid));
  });

  it('二进制不存在 → failed，不崩', async () => {
    const a = await acct();
    const m = createLoginManager({});
    const h = await m.start(adapterWith((x) => ({ argv: ['/nonexistent/bin'], env: {}, cwd: x.home })), a, INST, 'subscription_login');
    await until(() => h.session().state === 'failed');
    expect(allText(h)).toContain('进程错误');
  });

  it('跨 chunk 的多字节字符不被破坏；无换行提示也会冲出', async () => {
    const a = await acct();
    const m = createLoginManager({});
    const script = `const b=Buffer.from('请粘贴授权码：');process.stdout.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(1));setTimeout(()=>{},600)},80)`;
    const h = await m.start(adapterWith((x) => nodeCmd(x, script)), a, INST, 'subscription_login');
    await until(() => h.session().endedAt !== null);
    const text = allText(h);
    expect(text).toContain('请粘贴授权码：');
    expect(text).not.toContain('�');
  });

  it('successFiles 缺失时 exit 0 也判失败', async () => {
    const a = await acct();
    const m = createLoginManager({});
    const h = await m.start(adapterWith((x) => nodeCmd(x, 'process.exit(0)', { successFiles: ['nope.json'] })), a, INST, 'subscription_login');
    await until(() => h.session().state === 'failed');
  });

  it('script 伪终端包装（tty=true）能跑通并回传输入', { skip: spawnSync('script', ['--version']).status !== 0 }, async () => {
    const a = await acct();
    const m = createLoginManager({});
    const script = `process.stdin.setEncoding('utf8');console.log('isTTY='+process.stdout.isTTY);process.stdin.once('data',d=>{console.log('got:'+d.trim());process.exit(0)})`;
    const h = await m.start(adapterWith((x) => nodeCmd(x, script, { tty: true })), a, INST, 'subscription_login');
    await until(() => allText(h).includes('isTTY=true'));
    h.write('hello');
    await until(() => h.session().state === 'succeeded');
    expect(allText(h)).toContain('got:hello');
  });
});

describe('nv-shim（独立进程）', () => {
  async function runShimSync(script: string, o: Partial<ShimSpec> = {}) {
    const d = await mkTmp();
    const spec: ShimSpec = {
      schema: 'nv.shim/1',
      runId: 'r',
      argv: [process.execPath, '-e', script],
      env: { PATH: process.env.PATH ?? '' },
      cwd: d,
      stdin: 'devnull',
      stdoutFile: path.join(d, 'stdout.ndjson'),
      stderrFile: path.join(d, 'stderr.log'),
      pidFile: path.join(d, 'pid'),
      exitFile: path.join(d, 'exit.json'),
      heartbeatFile: path.join(d, 'heartbeat'),
      wallMs: 20_000,
      idleMs: 20_000,
      stop: [{ signal: 'SIGTERM', graceMs: 200 }],
      partialSampleMs: 0,
      tickMs: 50,
      ...o,
    };
    const specFile = path.join(d, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    const r = spawnSync(process.execPath, [shimScriptPath(), '--spec', specFile], { timeout: 25_000 });
    expect(r.status).toBe(0);
    return { d, spec, exit: JSON.parse(readFileSync(spec.exitFile, 'utf8')) as ShimExit, stdout: readFileSync(spec.stdoutFile, 'utf8') };
  }

  it('partial 采样：stream_event 被稀疏化；跨 chunk 的中文不损坏', async () => {
    const script = `
      const lines=[];
      for(let i=0;i<20;i++) lines.push(JSON.stringify({type:'stream_event',i}));
      lines.push(JSON.stringify({type:'assistant',text:'第一章·风起云涌'}));
      const b=Buffer.from(lines.join('\\n')+'\\n');
      const cut=b.indexOf(Buffer.from('风'))+1;
      process.stdout.write(b.subarray(0,cut));
      setTimeout(()=>process.stdout.write(b.subarray(cut)),100);`;
    const { stdout, exit } = await runShimSync(script, { partialSampleMs: 60_000 });
    expect(exit.code).toBe(0);
    expect(stdout).toContain('第一章·风起云涌');
    expect(stdout).not.toContain('�');
    expect(stdout.match(/stream_event/g)).toHaveLength(1);
  });

  it('未过滤模式原样落盘；stderr 分开；exit code 透传', async () => {
    const { stdout, exit, spec } = await runShimSync(`console.log('a');console.error('b');process.exitCode=3`);
    expect(stdout).toBe('a\n');
    expect(readFileSync(spec.stderrFile, 'utf8')).toBe('b\n');
    expect(exit).toMatchObject({ code: 3, signal: null, timedOut: null, killed: null });
  });

  it('可执行文件不存在 → exit.json 带 spawnError', async () => {
    const { exit } = await runShimSync('', { argv: ['/nonexistent/harness'] });
    expect(exit.spawnError).toContain('ENOENT');
    expect(exit.code).toBeNull();
  });

  it('secret env 文件被读取后删除', async () => {
    const d = await mkTmp();
    const envFile = path.join(d, 'secret.json');
    writeFileSync(envFile, JSON.stringify({ NV_SECRET: 'v1' }));
    const { stdout } = await runShimSync(`process.stdout.write(process.env.NV_SECRET||'none')`, { envFile });
    expect(stdout).toBe('v1');
    expect(existsSync(envFile)).toBe(false);
  });

  it('wall 超时杀掉整个进程组（孙进程不残留）', async () => {
    const d = await mkTmp();
    const pidFile = path.join(d, 'grandchild.pid');
    const script = `
      const cp=require('child_process');
      const g=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));
      setInterval(()=>{},1000);`;
    const { exit } = await runShimSync(script, { wallMs: 800 });
    expect(exit.timedOut).toBe('wall');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await sleep(100);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe('probe / install', () => {
  it('detectBin 在 harnessDir 中找到并解析版本', async () => {
    const d = await mkTmp();
    const bin = path.join(d, 'mytool');
    writeFileSync(bin, '#!/bin/sh\necho "mytool 3.4.5 (build)"\n');
    chmodSync(bin, 0o755);
    expect(await detectBin(['mytool'], d)).toEqual({ binPath: bin, version: '3.4.5' });
    expect(await detectBin(['definitely-not-a-binary-xyz'], d)).toBeNull();
  });

  it('runProbe(live) 用 fake 跑 canary：写文件 + receipt + 首尾 nonce', async () => {
    const dataRoot = await mkTmp();
    const f = await makeRunFixture({ dataRoot });
    const caps = await runProbe(getAdapter('fake'), f.prepared.install, f.prepared.account, { isolation: 'container', scratchDir: path.join(dataRoot, 'scratch'), live: true, fixturesDir: path.join(dataRoot, 'fx') });
    const step = (n: string) => caps.probeSteps.find((s) => s.step === n);
    expect(step('canary.run')?.ok).toBe(true);
    expect(step('canary.write')?.ok).toBe(true);
    expect(step('canary.receipt')?.ok).toBe(true);
    expect(step('canary.nonce')?.ok).toBe(true);
    expect(step('canary.audit')?.ok).toBe(true);
    expect(caps.tailNonceSurvives).toBe(true);
    expect(caps.eventTypesSeen).toContain('result');
    expect(await fs.readdir(path.join(dataRoot, 'fx'))).toHaveLength(1);
  });

  it('defaultCapabilities 标记 unverified', () => {
    const c = defaultCapabilities('codex', '0.165.0', 'container');
    expect(c.probeSteps[0]?.detail).toContain('unverified');
    expect(c.shellTool).toBe('always');
    expect(c.verifiedAt).toBe('');
  });

  it('planInstall：npm 包 + 软链；agy 用官方 installer；不支持的 harness 抛错', () => {
    const paths = { harness: '/data/harness' } as DataPaths;
    const cc = planInstall(paths, 'claude-code', '2.1.319');
    expect(cc.prefix).toBe('/data/harness/claude-code/2.1.319');
    expect(cc.binLink).toBe('/data/harness/bin/claude');
    expect(cc.source).toBe('npm:@anthropic-ai/claude-code@2.1.319');
    expect(cc.commands[1]).toEqual(expect.arrayContaining(['install', '--prefix', '/data/harness/claude-code/2.1.319', '@anthropic-ai/claude-code@2.1.319']));
    const agy = planInstall(paths, 'agy', '');
    expect(agy.binRel).toBe('home/.local/bin/agy');
    expect(agy.commands[1]!.join(' ')).toContain('antigravity.google/cli/install.sh');
    // 官方 installer 对未知参数直接 exit 1
    expect(agy.commands[1]![2]).toMatch(/\| HOME='?\/data\/harness\/agy\/[^ ]+\/home'? bash -s$/);
    expect(() => planInstall(paths, 'fake', '')).toThrow();
  });

  it('writeLockEntry 合并写入 harness.lock.yaml', async () => {
    const d = await mkTmp();
    const paths = { harness: d } as DataPaths;
    const inst: HarnessInstall = { id: 'codex', version: '0.165.0', binPath: '/x', sha256: 'abc', sha256Source: 'tofu', tier: 'unknown', status: 'active' };
    await writeLockEntry(paths, inst, 'npm:@openai/codex@0.165.0');
    await writeLockEntry(paths, { ...inst, id: 'grok', version: '1.0.77' }, 'npm:x');
    const t = readFileSync(path.join(d, 'harness.lock.yaml'), 'utf8');
    expect(t).toContain('codex:');
    expect(t).toContain('grok:');
  });
});
