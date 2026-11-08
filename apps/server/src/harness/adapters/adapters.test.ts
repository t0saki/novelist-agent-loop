/**
 * adapter 单测：fixture 回放（parser + classify）、argv/env 金样、认证模式、登录命令。全部离线，不调真实 CLI。
 */
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthMode, HarnessId, HarnessInstall, NEventBody } from '@novelist/shared';
import { toJsonSchema, zReceipt } from '@novelist/shared';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { MaterializeResult } from '../../instructions/types.js';
import { stamp } from '../events.js';
import { defaultCapabilities } from '../probe.js';
import { listAdapters, getAdapter } from '../registry.js';
import { RunPrepareError } from '../runner.js';
import type { ExitInfo, HomeLayout, Invocation, ResolvedAccount, RunSpec } from '../types.js';
import { agySettings } from './agy.js';
import { codexConfigToml, codexOutputSchema } from './codex.js';
import { filterExtraArgs, parseModelLines, readSchemaFile, toolKindOf } from './common.js';
import { dshAdapterPatch } from './dsh.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const OK_EXIT: ExitInfo = { code: 0, signal: null, wallMs: 1000, timedOut: null, killed: null };
const RUN = '/data/runs/2026-11/RUN';
const REAL: HarnessId[] = ['claude-code', 'codex', 'agy', 'grok', 'dsh', 'pi'];

function specFor(harness: HarnessId, o: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: '11111111-2222-4333-8444-555555555555',
    taskId: 't1',
    attempt: 1,
    role: 'writer',
    taskKind: 'chapter.write',
    harness,
    profileId: 'p',
    accountId: 'a1',
    bookSlug: 'demo',
    runDir: RUN,
    bookDir: `${RUN}/book`,
    outDir: `${RUN}/book/work/t1/attempt-1/out`,
    inDir: `${RUN}/in`,
    logDir: `${RUN}/log`,
    workOrderFile: `${RUN}/in/workorder.md`,
    systemFile: `${RUN}/in/system.md`,
    receiptSchemaFile: `${RUN}/in/receipt.lenient.json`,
    model: 'some-model',
    limits: { wallMs: 600_000, idleMs: 120_000, maxTurns: 30 },
    session: { mode: 'fresh', id: '99999999-2222-4333-8444-555555555555' },
    persistSession: false,
    egress: { allow: [] },
    subagents: false,
    extraArgs: [],
    ...o,
  };
}

function acctFor(harness: HarnessId, o: Partial<ResolvedAccount> = {}): ResolvedAccount {
  return {
    id: 'a1',
    harness,
    label: '',
    authMode: 'none',
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
    home: '/data/accounts/a1/home',
    secretEnv: {},
    credentialFiles: [],
    ...o,
  };
}

const INST = (id: HarnessId): HarnessInstall => ({ id, version: '9.9.9', binPath: `/opt/bin/${id}`, sha256: '', sha256Source: 'tofu', tier: 'probed', status: 'active' });
const MAT = (o: Partial<MaterializeResult> = {}): MaterializeResult => ({ files: [], argv: [], env: {}, budget: { ok: true, bytes: 10, limit: null }, notes: [], ...o });

async function build(harness: HarnessId, a: Partial<ResolvedAccount> = {}, s: Partial<RunSpec> = {}, m: Partial<MaterializeResult> = {}): Promise<{ inv: Invocation; home: HomeLayout }> {
  const adapter = getAdapter(harness);
  const spec = specFor(harness, s);
  const acct = acctFor(harness, a);
  const home = await adapter.prepareHome(acct, INST(harness), spec);
  const caps = { ...defaultCapabilities(harness, '9.9.9', 'container'), structuredOutput: 'none' as const };
  return { inv: adapter.buildInvocation(spec, caps, home, MAT(m), acct, INST(harness)), home };
}

/** 给 authCheck / listModels 用的桩二进制 + 临时账号 home（离线） */
async function withStubBin(script: string, fn: (inst: HarnessInstall, home: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-stub-'));
  try {
    const bin = path.join(dir, 'stub');
    await fs.writeFile(bin, script, { mode: 0o755 });
    const home = path.join(dir, 'home');
    await fs.mkdir(home);
    await fn({ ...INST('agy'), binPath: bin }, home);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function replay(harness: HarnessId, file: string, exit: ExitInfo = OK_EXIT, stderr = '', outDir?: string) {
  const adapter = getAdapter(harness);
  const raw = readFileSync(path.join(FIX, harness, file), 'utf8');
  const parser = adapter.createParser(specFor(harness, outDir ? { outDir } : {}));
  const bodies: NEventBody[] = [...parser.push(raw), ...parser.end()];
  const events = stamp('r', 1, bodies, () => '2026-11-08T00:00:00.000Z');
  return { bodies, outcome: adapter.classify(exit, events, stderr), raw };
}

const byType = <T extends NEventBody['t']>(b: NEventBody[], t: T) => b.filter((e): e is Extract<NEventBody, { t: T }> => e.t === t);

describe('fixture 回放', () => {
  it('claude-code: 成功流', () => {
    const { bodies, outcome } = replay('claude-code', 'success.ndjson');
    expect(byType(bodies, 'init')[0]).toMatchObject({ sessionId: '7b299ea5-9abb-415f-8afe-b5cbd78c5cfe', model: 'claude-haiku-5-5', version: expect.any(String) });
    expect(byType(bodies, 'file_change')[0]).toMatchObject({ op: 'add', ok: true });
    expect(byType(bodies, 'rate_limit')[0]).toMatchObject({ window: '7d', status: 'allowed' });
    expect(bodies.some((e) => e.t === 'unknown')).toBe(false);
    expect(outcome).toMatchObject({ status: 'completed', sessionId: '7b299ea5-9abb-415f-8afe-b5cbd78c5cfe', model: 'claude-haiku-5-5', exitCode: 0 });
    expect(outcome.usage.output).toBeGreaterThan(0);
    expect(outcome.usage.costSource).toBe('harness');
    expect(outcome.usage.costUsd).toBeGreaterThan(0);
  });

  it('agy: 无效 API key 判 auth（不被 exit 3 映射成 overloaded）', () => {
    const { outcome } = replay('agy', 'invalid_key.ndjson', { ...OK_EXIT, code: 3 });
    expect(outcome).toMatchObject({ status: 'failed', errorClass: 'auth' });
  });

  it('claude-code: error_during_execution 的 errors[] 被用于分类（真实形状没有 result 字段）', () => {
    const { bodies, outcome } = replay('claude-code', 'rate_limited.ndjson', { ...OK_EXIT, code: 1 });
    expect(byType(bodies, 'result')[0]).toMatchObject({ status: 'error', text: 'usage limit reached' });
    expect(outcome.errorClass).toBe('quota');
  });

  it('claude-code: 窗口耗尽 → quota + retryAfter', () => {
    const { bodies, outcome } = replay('claude-code', 'rate_limited.ndjson', { ...OK_EXIT, code: 1 });
    expect(byType(bodies, 'retry')[0]).toMatchObject({ attempt: 1, delayMs: 5000, cls: 'rate_limit' });
    expect(outcome.status).toBe('failed');
    expect(outcome.errorClass).toBe('quota');
    expect(outcome.retryAfter).toBe(new Date(1794337200 * 1000).toISOString());
  });

  it('claude-code: subtype=success 但 is_error=true → auth（不是 completed）', () => {
    expect(replay('claude-code', 'auth_expired.ndjson', { ...OK_EXIT, code: 1 }).outcome).toMatchObject({ status: 'failed', errorClass: 'auth' });
    expect(replay('claude-code', 'auth_expired.ndjson').outcome.status).toBe('failed');
  });

  it('codex: 成功流 + usage 为 delta 累加', () => {
    const { bodies, outcome } = replay('codex', 'success.ndjson');
    expect(byType(bodies, 'init')[0]?.sessionId).toBe('01a1b7ae-d6e8-7341-bc47-8a562d356f38');
    expect(outcome).toMatchObject({ status: 'completed', sessionId: '01a1b7ae-d6e8-7341-bc47-8a562d356f38' });
    expect(outcome.usage.input).toBe(24217);
    expect(outcome.usage.cachedInput).toBe(20992);
  });

  it('codex: outDir 内 file_change failed 且 exit 0 → sandbox（#46246）', () => {
    const { outcome } = replay('codex', 'sandbox_fail.ndjson', OK_EXIT, '', '/data/runs/2026-11/RUN/cx');
    expect(outcome).toMatchObject({ status: 'failed', errorClass: 'sandbox' });
  });

  describe('codex: file_change 失败后同路径重试成功', () => {
    const OUT = '/data/runs/2026-11/RUN/out';
    const change = (id: string, status: string) => JSON.stringify({ type: 'item.completed', item: { id, type: 'file_change', changes: [{ path: `${OUT}/a.md`, kind: 'add' }], status } });
    const THREAD = JSON.stringify({ type: 'thread.started', thread_id: 't1' });
    const DONE = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    const classify = (lines: string[], exit: ExitInfo) => {
      const adapter = getAdapter('codex');
      const parser = adapter.createParser(specFor('codex', { outDir: OUT }));
      const bodies = [...parser.push(`${lines.join('\n')}\n`), ...parser.end()];
      return adapter.classify(exit, stamp('r', 1, bodies, () => '2026-11-08T00:00:00.000Z'), '');
    };

    it('run 完成 → completed，不判 sandbox', () => {
      expect(classify([THREAD, change('i1', 'failed'), change('i2', 'completed'), DONE], OK_EXIT)).toMatchObject({ status: 'completed' });
    });

    it('run 因别的原因失败 → 不被已恢复的失败带成 sandbox', () => {
      const o = classify([THREAD, change('i1', 'failed'), change('i2', 'completed')], { ...OK_EXIT, code: 1 });
      expect(o.status).toBe('failed');
      expect(o.errorClass).not.toBe('sandbox');
    });

    it('最后一次仍失败 → sandbox', () => {
      expect(classify([THREAD, change('i1', 'completed'), change('i2', 'failed'), DONE], OK_EXIT)).toMatchObject({ status: 'failed', errorClass: 'sandbox' });
    });
  });

  it('claude-code: errors[] 里的鉴权错误（无 api_error_status）→ auth', () => {
    const adapter = getAdapter('claude-code');
    const parser = adapter.createParser(specFor('claude-code'));
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Invalid API key · Please run /login'], session_id: 's' });
    const bodies = [...parser.push(`${line}\n`), ...parser.end()];
    expect(byType(bodies, 'error')[0]).toMatchObject({ cls: 'auth' });
    expect(adapter.classify({ ...OK_EXIT, code: 1 }, stamp('r', 1, bodies, () => '2026-11-08T00:00:00.000Z'), '')).toMatchObject({ status: 'failed', errorClass: 'auth' });
  });

  it('codex: shell 写文件成功流', () => {
    const { bodies, outcome } = replay('codex', 'shell_write.ndjson');
    expect(byType(bodies, 'tool_call')[0]).toMatchObject({ kind: 'exec', name: 'shell' });
    expect(byType(bodies, 'tool_result')[0]).toMatchObject({ ok: true });
    expect(outcome.status).toBe('completed');
  });

  it('agy: 嵌套形状的 stream-json', () => {
    const { bodies, outcome } = replay('agy', 'success.ndjson');
    expect(byType(bodies, 'init')[0]).toMatchObject({ sessionId: 'df679668-29f0-4115-9a1a-3edd641e5fe6', model: 'gemini-3.8-flash-low' });
    expect(byType(bodies, 'file_change')[0]).toMatchObject({ op: 'add', ok: true });
    expect(byType(bodies, 'text').map((t) => t.delta).join('')).toContain('DONE');
    expect(outcome).toMatchObject({ status: 'completed', sessionId: 'df679668-29f0-4115-9a1a-3edd641e5fe6' });
    expect(outcome.usage.input).toBe(14251);
  });

  it('grok: 成功流；usage 取 end 的 total，不累加 delta', () => {
    const { bodies, outcome } = replay('grok', 'success.ndjson');
    expect(byType(bodies, 'file_change')[0]).toMatchObject({ ok: true });
    expect(outcome).toMatchObject({ status: 'completed', sessionId: '7d1d3c1e-1111-4222-8333-944455556666' });
    expect(outcome.usage.input).toBe(1624);
  });

  it('grok: 未登录 → auth', () => {
    expect(replay('grok', 'auth_error.ndjson').outcome).toMatchObject({ status: 'failed', errorClass: 'auth' });
  });

  it('dsh: 成功流', () => {
    const { bodies, outcome } = replay('dsh', 'success.ndjson');
    expect(byType(bodies, 'file_change')).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'completed', sessionId: 'session-5b7c1f2a-0000-4000-8000-000000000001' });
    expect(outcome.usage.reasoning).toBe(50);
  });

  it('dsh: final.reason=error 且 402 → billing', () => {
    expect(replay('dsh', 'turn_error.ndjson', { ...OK_EXIT, code: 1 }).outcome).toMatchObject({ status: 'failed', errorClass: 'billing' });
  });

  it('pi: 成功流', () => {
    const { bodies, outcome } = replay('pi', 'success.ndjson');
    expect(byType(bodies, 'file_change')[0]).toMatchObject({ op: 'add', ok: true });
    expect(outcome).toMatchObject({ status: 'completed', sessionId: 'nv-run-1' });
    expect(outcome.usage.costUsd).toBeCloseTo(0.003);
  });

  it('pi: 失败也 exit 0 → overloaded', () => {
    expect(replay('pi', 'error_exit0.ndjson').outcome).toMatchObject({ status: 'failed', errorClass: 'overloaded' });
  });

  it.each([
    ['claude-code', 'success.ndjson'],
    ['codex', 'success.ndjson'],
    ['agy', 'success.ndjson'],
    ['grok', 'success.ndjson'],
    ['dsh', 'success.ndjson'],
    ['pi', 'success.ndjson'],
  ] as [HarnessId, string][])('%s: 任意切块与整块解析结果一致', (h, f) => {
    const { bodies, raw } = replay(h, f);
    const parser = getAdapter(h).createParser(specFor(h));
    const out: NEventBody[] = [];
    for (let i = 0; i < raw.length; i += 7) out.push(...parser.push(raw.slice(i, i + 7)));
    out.push(...parser.end());
    expect(out).toEqual(bodies);
  });
});

describe('parser 健壮性（绝不抛异常）', () => {
  const GARBAGE = [
    'not json at all',
    '{"type":',
    '[1,2,3]',
    '{"type":"result","usage":5,"modelUsage":"x"}',
    '{"type":"assistant","message":{"content":"oops"}}',
    '{"type":"user","message":null}',
    '{"type":"rate_limit_event","rate_limit_info":null}',
    '{"type":"item.completed","item":null}',
    '{"type":"item.completed","item":{"type":"file_change","changes":"x","status":"failed"}}',
    '{"event":"step_update","step_update":{"step_type":"tool","tool_info":null}}',
    '{"event":"result","result":{"status":12,"error":{"a":1}}}',
    '{"type":"tool_call","toolCallId":null,"locations":5}',
    '{"type":"tool_result"}',
    '{"type":"final","reason":"x"}',
    '{"type":"agent_settled"}',
    '{"type":"message_end","message":7}',
    '{"type":"brand_new_event"}',
    '{"event":"brand_new_event"}',
    '',
    '\r',
  ];
  it.each(REAL)('%s', (h) => {
    const p = getAdapter(h).createParser(specFor(h));
    const out = [...p.push(`${GARBAGE.join('\n')}\n{"type":"truncated`), ...p.end()];
    expect(out.some((e) => e.t === 'unknown')).toBe(true);
  });
});

describe('claude-code 命令与认证', () => {
  it('订阅模式的核心 argv / env', async () => {
    const { inv } = await build('claude-code', { authMode: 'subscription_login' });
    const a = inv.argv;
    expect(a[0]).toBe('/opt/bin/claude-code');
    expect(a.slice(1, 5)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(flagValue(a, '--session-id')).toBe('99999999-2222-4333-8444-555555555555');
    expect(flagValue(a, '--model')).toBe('some-model');
    expect(flagValue(a, '--permission-mode')).toBe('acceptEdits');
    expect(flagValue(a, '--permission-prompts')).toBe('none');
    expect(flagValue(a, '--setting-sources')).toBe('project');
    expect(flagValue(a, '--tools')).toBe('Read,Write,Edit,Glob,Grep');
    expect(flagValue(a, '--disallowedTools')).toContain('Bash');
    expect(flagValue(a, '--add-dir')).toBe(`${RUN}/in`);
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--no-session-persistence');
    expect(a).toContain('--include-partial-messages');
    expect(a).not.toContain('--bare');
    expect(a).not.toContain('--dangerously-skip-permissions');
    expect(inv.env.CLAUDE_CONFIG_DIR).toBe('/data/accounts/a1/home/.claude');
    expect(inv.env.HOME).toBe('/data/accounts/a1/home');
    expect(inv.stdin).toEqual({ file: `${RUN}/in/workorder.md` });
    expect(inv.cwd).toBe(`${RUN}/book`);
  });

  it('非 writer 角色不开 partial；resume / fork', async () => {
    expect((await build('claude-code', {}, { role: 'checker' })).inv.argv).not.toContain('--include-partial-messages');
    const r = (await build('claude-code', {}, { session: { mode: 'resume', id: 'sid' } })).inv.argv;
    expect(flagValue(r, '--resume')).toBe('sid');
    expect(r).not.toContain('--session-id');
    expect(r).not.toContain('--fork-session');
    expect((await build('claude-code', {}, { session: { mode: 'fork', id: 'sid' } })).inv.argv).toContain('--fork-session');
  });

  it('订阅模式：env 里有 API key → 拒绝（防静默切 API 计费）', async () => {
    const err = await build('claude-code', { authMode: 'subscription_login', secretEnv: { ANTHROPIC_API_KEY: 'sk-xxxxxx' } }).catch((e) => e);
    expect(err).toBeInstanceOf(RunPrepareError);
    expect(err).toMatchObject({ code: 'auth_config', errorClass: 'auth' });
    await expect(build('claude-code', { authMode: 'oauth_token', secretEnv: { ANTHROPIC_AUTH_TOKEN: 'tok-xxxxxx', CLAUDE_CODE_OAUTH_TOKEN: 'x' } })).rejects.toMatchObject({ code: 'auth_config' });
  });

  it('oauth_token：需要 token，并透传；残留的网关地址被剥离', async () => {
    await expect(build('claude-code', { authMode: 'oauth_token' })).rejects.toMatchObject({ code: 'auth_config' });
    const { inv } = await build('claude-code', { authMode: 'oauth_token', secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc', ANTHROPIC_BASE_URL: 'https://gw.example.com' } });
    expect(inv.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-abc');
    expect(inv.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(inv.argv.join(' ')).not.toContain('sk-ant-oat01-abc');
  });

  it('custom_api：BASE_URL + (API_KEY | AUTH_TOKEN)，模型名任意', async () => {
    await expect(build('claude-code', { authMode: 'custom_api', secretEnv: { ANTHROPIC_API_KEY: 'k-xxxxxx' } })).rejects.toMatchObject({ code: 'auth_config' });
    await expect(build('claude-code', { authMode: 'custom_api', secretEnv: { ANTHROPIC_BASE_URL: 'https://gw' } })).rejects.toMatchObject({ code: 'auth_config' });
    const { inv } = await build(
      'claude-code',
      { authMode: 'custom_api', secretEnv: { ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_AUTH_TOKEN: 'bearer-xxxxxx', CLAUDE_CODE_OAUTH_TOKEN: 'stale' } },
      { model: 'my-gateway/whatever-1', limits: { wallMs: 1000, idleMs: 1000, maxTurns: 3, maxBudgetUsd: 2.5 } },
    );
    expect(flagValue(inv.argv, '--model')).toBe('my-gateway/whatever-1');
    expect(flagValue(inv.argv, '--max-budget-usd')).toBe('2.5');
    expect(inv.env.ANTHROPIC_BASE_URL).toBe('https://gw');
    expect(inv.env.ANTHROPIC_AUTH_TOKEN).toBe('bearer-xxxxxx');
    expect(inv.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('订阅模式不传 --max-budget-usd', async () => {
    const { inv } = await build('claude-code', { authMode: 'subscription_login' }, { limits: { wallMs: 1000, idleMs: 1000, maxTurns: 3, maxBudgetUsd: 2.5 } });
    expect(inv.argv).not.toContain('--max-budget-usd');
  });

  it('危险 extra_args 被过滤，账号 env 不能覆盖隔离变量', async () => {
    const { inv } = await build('claude-code', { secretEnv: { CLAUDE_CONFIG_DIR: '/root/.claude', HOME: '/root', FOO: 'bar' } }, { extraArgs: ['--bare', '--add-dir', '/etc', '--foo', '1'] });
    expect(inv.argv).not.toContain('--bare');
    expect(inv.argv).not.toContain('/etc');
    expect(inv.argv.slice(-2)).toEqual(['--foo', '1']);
    expect(inv.env.CLAUDE_CONFIG_DIR).toBe('/data/accounts/a1/home/.claude');
    expect(inv.env.HOME).toBe('/data/accounts/a1/home');
    expect(inv.env.FOO).toBe('bar');
  });

  it('adapter 权限设置并入 lane C 的 settings，只传一个 --settings', async () => {
    const cPath = `${RUN}/in/cc.settings.json`;
    const file = { path: cPath, content: JSON.stringify({ hooks: { Stop: [] }, permissions: { deny: ['X'] } }) };
    const { inv } = await build('claude-code', {}, {}, { files: [file], argv: ['--settings', cPath, '--append-system-prompt-file', `${RUN}/in/system.md`] });
    expect(inv.argv.filter((a) => a === '--settings')).toHaveLength(1);
    expect(flagValue(inv.argv, '--settings')).toBe(cPath);
    expect(flagValue(inv.argv, '--append-system-prompt-file')).toBe(`${RUN}/in/system.md`);
    const merged = JSON.parse(file.content);
    expect(merged.hooks).toBeDefined();
    expect(merged.permissions.blockWritesOutsideWorkingDirectories).toBe(true);
    expect(merged.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(merged.permissions.deny).toContain('X');
    expect(merged.permissions.deny).toContain(`Write(/${RUN}/in/**)`);
  });
});

describe('codex 命令与认证', () => {
  it('fresh：固定 bypass，CODEX_HOME 隔离，prompt 走 stdin', async () => {
    const { inv } = await build('codex', { authMode: 'subscription_login' });
    const a = inv.argv;
    expect(a.slice(0, 2)).toEqual(['/opt/bin/codex', 'exec']);
    expect(a).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(a).not.toContain('--sandbox');
    expect(a).toContain('--ephemeral');
    expect(flagValue(a, '-C')).toBe(`${RUN}/book`);
    expect(flagValue(a, '-o')).toBe(`${RUN}/log/last-message.json`);
    expect(a.at(-1)).toBe('-');
    expect(inv.stdin).toEqual({ file: `${RUN}/in/workorder.md` });
    expect(inv.env.CODEX_HOME).toBe('/data/accounts/a1/home/.codex');
  });

  it('resume / fork：子命令在前、flag 在子命令之后；不带子命令不支持的 --color/-C', async () => {
    for (const mode of ['resume', 'fork'] as const) {
      const a = (await build('codex', {}, { session: { mode, id: 'th-1' }, persistSession: true })).inv.argv;
      expect(a.slice(0, 3)).toEqual(['/opt/bin/codex', 'exec', mode]);
      expect(a.slice(-2)).toEqual(['th-1', '-']);
      expect(a).not.toContain('--color');
      expect(a).not.toContain('-C');
      expect(a).toContain('--json');
      expect(a).toContain('--dangerously-bypass-approvals-and-sandbox');
    }
  });

  it('effort 只接受枚举值', async () => {
    expect((await build('codex', {}, { effort: 'high' })).inv.argv).toContain('model_reasoning_effort="high"');
    expect((await build('codex', {}, { effort: 'bogus' })).inv.argv.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('工作目录信任用内联表传（-c 键路径不识别引号，含点的路径也要生效），且不进账号级 config.toml', async () => {
    const bookDir = '/data.v2/runs/2026-11/RUN/book';
    const { inv, home } = await build('codex', { authMode: 'subscription_login' }, { bookDir });
    const trust = inv.argv.find((a) => a.startsWith('projects'));
    expect(trust).toBeDefined();
    const [key, ...value] = trust!.split('=');
    expect(key).toBe('projects');
    const parsed = parseToml(`projects = ${value.join('=')}`) as Record<string, any>;
    expect(parsed.projects).toEqual({ [bookDir]: { trust_level: 'trusted' } });
    expect(home.configFiles[0]!.content).not.toContain(bookDir);
  });

  it('api_key 账号的 authCheck 只看 key，不调 codex login status（它不认 CODEX_API_KEY）', async () => {
    await withStubBin('#!/bin/sh\necho "Not logged in"\nexit 1\n', async (inst, home) => {
      const adapter = getAdapter('codex');
      expect(await adapter.authCheck!(acctFor('codex', { authMode: 'api_key', home, secretEnv: { CODEX_API_KEY: 'k-123456' } }), inst)).toMatchObject({ ok: true });
      expect(await adapter.authCheck!(acctFor('codex', { authMode: 'api_key', home }), inst)).toMatchObject({ ok: false });
      expect(await adapter.authCheck!(acctFor('codex', { authMode: 'subscription_login', home }), inst)).toMatchObject({ ok: false });
    });
  });

  it('api_key：缺 key 拒绝；非 api_key 模式不带 CODEX_API_KEY', async () => {
    await expect(build('codex', { authMode: 'api_key' })).rejects.toMatchObject({ code: 'auth_config' });
    expect((await build('codex', { authMode: 'api_key', secretEnv: { CODEX_API_KEY: 'k-123456' } })).inv.env.CODEX_API_KEY).toBe('k-123456');
    expect((await build('codex', { authMode: 'credential_file', secretEnv: { CODEX_API_KEY: 'k-123456' } })).inv.env.CODEX_API_KEY).toBeUndefined();
  });

  it('custom_api：需要 base_url 与 key；config.toml 写入 provider', async () => {
    await expect(build('codex', { authMode: 'custom_api', secretEnv: { OPENAI_API_KEY: 'k-123456' } })).rejects.toMatchObject({ code: 'auth_config' });
    const secretEnv = { OPENAI_BASE_URL: 'https://gw.example.com/v1', OPENAI_API_KEY: 'k-123456' };
    const { inv, home } = await build('codex', { authMode: 'custom_api', secretEnv });
    expect(inv.env.OPENAI_API_KEY).toBe('k-123456');
    expect(home.configFiles[0]!.path).toBe('/data/accounts/a1/home/.codex/config.toml');
    const cfg = parseToml(home.configFiles[0]!.content) as Record<string, any>;
    expect(cfg.model_provider).toBe('nv_custom');
    expect(cfg.model_providers.nv_custom).toMatchObject({ base_url: 'https://gw.example.com/v1', wire_api: 'responses', env_key: 'OPENAI_API_KEY' });
    expect(cfg.memories).toBeUndefined();
    // 同账号并发 run 共享 config.toml：内容必须与具体 run 无关，每 run 差异走 -c
    expect(cfg.projects).toBeUndefined();
    expect(cfg.features.multi_agent).toBeUndefined();
    // key 不进 config.toml
    expect(home.configFiles[0]!.content).not.toContain('k-123456');
  });

  it('--output-schema 指向收窄后的 receipt.codex.json：去掉 record 与严格模式不接受的关键字', async () => {
    const strict = JSON.stringify(toJsonSchema(zReceipt, 'strict'));
    expect(strict).toContain('propertyNames');
    const narrowed = JSON.parse(codexOutputSchema(strict)!) as Record<string, any>;
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) {
        n.forEach(walk);
        return;
      }
      if (typeof n !== 'object' || n === null) return;
      const o = n as Record<string, any>;
      expect(o.propertyNames).toBeUndefined();
      expect(o.$schema).toBeUndefined();
      if (o.properties) {
        expect(o.additionalProperties).toBe(false);
        expect(new Set(o.required)).toEqual(new Set(Object.keys(o.properties)));
      }
      Object.entries(o).forEach(([k, v]) => { if (k !== 'properties') walk(v); else Object.values(v as object).forEach(walk); });
    };
    walk(narrowed);
    const selfCount = narrowed.properties.self_count;
    const variants = (selfCount.anyOf ?? [selfCount]) as Record<string, any>[];
    expect(variants.find((v) => v.properties)!.properties.beats).toBeUndefined();
    expect(narrowed.properties.schema).toBeDefined();
    expect(codexOutputSchema('{bad')).toBeNull();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-cx-'));
    try {
      const receiptSchemaFile = path.join(dir, 'receipt.strict.json');
      await fs.writeFile(receiptSchemaFile, strict);
      const adapter = getAdapter('codex');
      const spec = specFor('codex', { receiptSchemaFile, inDir: dir });
      const acct = acctFor('codex');
      const home = await adapter.prepareHome(acct, INST('codex'), spec);
      const caps = defaultCapabilities('codex', '9.9.9', 'container');
      const inv = adapter.buildInvocation(spec, caps, home, MAT(), acct, INST('codex'));
      expect(flagValue(inv.argv, '--output-schema')).toBe(path.join(dir, 'receipt.codex.json'));
      expect(home.configFiles.map((f) => f.path)).toContain(path.join(dir, 'receipt.codex.json'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('readSchemaFile 去掉 $schema（cc 的校验器不认 draft 2020-12）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-cc-'));
    try {
      const receiptSchemaFile = path.join(dir, 'r.json');
      await fs.writeFile(receiptSchemaFile, JSON.stringify(toJsonSchema(zReceipt, 'lenient')));
      const inline = readSchemaFile(specFor('claude-code', { receiptSchemaFile }))!;
      expect(JSON.parse(inline).$schema).toBeUndefined();
      expect(JSON.parse(inline).properties.schema).toBeDefined();
      expect(readSchemaFile(specFor('claude-code', { receiptSchemaFile: path.join(dir, 'none.json') }))).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('非 custom 模式不写 provider；开子代理时不关 agents', () => {
    const cfg = parseToml(codexConfigToml({}, 'subscription_login')) as Record<string, any>;
    expect(cfg.model_provider).toBeUndefined();
    expect(cfg.agents).toBeUndefined();
    expect(cfg.features.multi_agent).toBeUndefined();
  });
});

describe('agy 命令与认证', () => {
  it('workorder 只放路径（argv 上限），stream-json，settings 文件，HOME 隔离', async () => {
    const { inv, home } = await build('agy', { authMode: 'subscription_login' });
    const a = inv.argv;
    expect(flagValue(a, '-p')).toContain(`${RUN}/in/workorder.md`);
    expect(Buffer.byteLength(flagValue(a, '-p')!)).toBeLessThan(1024);
    expect(flagValue(a, '--output-format')).toBe('stream-json');
    expect(flagValue(a, '--settings')).toBe(`${RUN}/in/agy.settings.json`);
    expect(flagValue(a, '--print-timeout')).toBe('570s');
    expect(flagValue(a, '--log-file')).toBe(`${RUN}/log/agy.log`);
    expect(a).toContain('--dangerously-skip-permissions');
    expect(inv.stdin).toBe('devnull');
    expect(inv.env.HOME).toBe('/data/accounts/a1/home');
    expect(JSON.parse(home.configFiles[0]!.content).permissions.deny).toContain('command(*)');
  });

  it('订阅模式丢弃 GEMINI_API_KEY；api_key 模式需要它', async () => {
    expect((await build('agy', { authMode: 'subscription_login', secretEnv: { GEMINI_API_KEY: 'g-123456' } })).inv.env.GEMINI_API_KEY).toBeUndefined();
    await expect(build('agy', { authMode: 'api_key' })).rejects.toMatchObject({ code: 'auth_config' });
    expect((await build('agy', { authMode: 'api_key', secretEnv: { GEMINI_API_KEY: 'g-123456' } })).inv.env.GEMINI_API_KEY).toBe('g-123456');
  });

  describe('modelProvider 与账号 home', () => {
    // 模拟真实 agy：home 的 settings.json 没有 modelProvider=gemini 时报未登录
    const AGY_STUB = '#!/bin/sh\ngrep -q \'"modelProvider": "gemini"\' "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null || { echo "Please sign in to view available models"; exit 1; }\nprintf "gemini-4-argon\\tArgon\\n"\n';
    const settingsOf = (home: string) => path.join(home, '.gemini', 'antigravity-cli', 'settings.json');

    it.each(['api_key', 'custom_api'] as const)('%s：authCheck 前把 modelProvider 写进账号 home', async (authMode) => {
      await withStubBin(AGY_STUB, async (inst, home) => {
        const r = await getAdapter('agy').authCheck!(acctFor('agy', { authMode, home, secretEnv: { GEMINI_API_KEY: 'g-123456', GOOGLE_GEMINI_BASE_URL: 'https://gw.example.com' } }), inst);
        expect(r).toMatchObject({ ok: true });
      });
    });

    it('改回订阅模式后，run 前清掉 home 里残留的 modelProvider，其他设置保留', async () => {
      await withStubBin(AGY_STUB, async (inst, home) => {
        await fs.mkdir(path.dirname(settingsOf(home)), { recursive: true });
        await fs.writeFile(settingsOf(home), JSON.stringify({ modelProvider: 'gemini', keep: 1 }));
        await getAdapter('agy').prepareHome(acctFor('agy', { authMode: 'subscription_login', home }), inst, specFor('agy'));
        expect(JSON.parse(readFileSync(settingsOf(home), 'utf8'))).toEqual({ keep: 1 });
      });
    });
  });

  it('adc 模式写默认凭据路径', async () => {
    const { inv } = await build('agy', { authMode: 'adc' });
    expect(inv.env.AGY_ADC_AUTH).toBe('true');
    expect(inv.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/data/accounts/a1/home/adc.json');
  });

  it('settings 不让 read_file 读主密钥、会话密钥和备份（deny 路径落在 $DATA 根）', () => {
    const deny = (agySettings({ bookDir: `${RUN}/book`, inDir: `${RUN}/in`, runDir: RUN }, 'api_key', {}, []) as { permissions: { deny: string[] } }).permissions.deny;
    for (const rule of ['read_file(/data/.master_key)', 'read_file(/data/.session_secret)', 'read_file(/data/backups/)']) expect(deny).toContain(rule);
  });

  it('custom_api 的自定义模型写入 settings', () => {
    const s = agySettings({ bookDir: '/b', inDir: '/i', runDir: '/data/runs/2026-11/r' }, 'custom_api', { GOOGLE_GEMINI_BASE_URL: 'https://gw/' }, ['m1', 'gemini-api://x/models/m2']) as Record<string, any>;
    expect(s.modelProvider).toBe('gemini');
    expect(s.customModelsConfig.customModels).toEqual([
      { modelName: 'gemini-api://https://gw/models/m1', label: 'm1' },
      { modelName: 'gemini-api://x/models/m2', label: 'gemini-api://x/models/m2' },
    ]);
  });

  it('exit 1/2 → config', () => {
    const o = getAdapter('agy').classify({ ...OK_EXIT, code: 1 }, [], 'unexpected');
    expect(o.errorClass).toBe('config');
  });
});

describe('grok / dsh / pi 命令', () => {
  it('grok：prompt-file、关闭 shell/网页、GROK_HOME 隔离', async () => {
    const { inv } = await build('grok', { authMode: 'subscription_login' });
    const a = inv.argv;
    expect(flagValue(a, '--prompt-file')).toBe(`${RUN}/in/workorder.md`);
    expect(flagValue(a, '--output-format')).toBe('streaming-json');
    expect(flagValue(a, '--disallowed-tools')).toContain('run_terminal_cmd');
    expect(a).toContain('--always-approve');
    expect(a).toContain('--no-subagents');
    expect(flagValue(a, '-s')).toBe('99999999-2222-4333-8444-555555555555');
    expect(inv.env.GROK_HOME).toBe('/data/accounts/a1/home/.grok');
    expect(inv.env.GROK_CLAUDE_HOOKS_ENABLED).toBe('0');
    await expect(build('grok', { authMode: 'api_key' })).rejects.toMatchObject({ code: 'auth_config' });
  });

  it('grok：stderr 的 permission required 视为失败（exit 0）', () => {
    const { bodies } = replay('grok', 'success.ndjson');
    const events = stamp('r', 1, bodies);
    expect(getAdapter('grok').classify(OK_EXIT, events, 'permission required: write').status).toBe('failed');
  });

  it('dsh：启动器 flag 在 app flag 之前，patch 顺序 adapter → lane C', async () => {
    await expect(build('dsh', { authMode: 'api_key' })).rejects.toMatchObject({ code: 'auth_config' });
    const { inv } = await build('dsh', { authMode: 'api_key', secretEnv: { DEEPSEEK_API_KEY: 'd-123456' } }, {}, { argv: ['--patch', `${RUN}/in/dsh.patch.yml`] });
    const a = inv.argv;
    expect(a.slice(1, 7)).toEqual(['--profile', 'headless', '--patch', `${RUN}/in/dsh.adapter.patch.yml`, '--patch', `${RUN}/in/dsh.patch.yml`]);
    expect(a).toContain('--json');
    expect(a.at(-1)).toBe('-');
    expect(inv.env.DSH_HOME).toBe('/data/accounts/a1/home/.dsh');
    expect(inv.env.DSH_TELEMETRY_MODE).toBe('DISABLED');
  });

  it('dsh patch：模型、effort、关闭 session-log 与子代理', () => {
    const rows = parseYaml(dshAdapterPatch({ model: 'deepseek-flash', effort: 'high', subagents: false })) as { id: string; disabled?: boolean; config?: Record<string, unknown> }[];
    expect(rows.find((r) => r.id === 'agent-default-model')?.config).toMatchObject({ model: 'deepseek-flash', reasoningEffort: 'high' });
    expect(rows.find((r) => r.id === 'session-log-deepseek')?.disabled).toBe(true);
    expect(rows.find((r) => r.id === 'tool-subagent')?.disabled).toBe(true);
  });

  it('pi：json 模式、无 MCP、无 bash 工具', async () => {
    const { inv } = await build('pi', { authMode: 'api_key', secretEnv: { OPENROUTER_API_KEY: 'o-123456' } });
    const a = inv.argv;
    expect(flagValue(a, '--mode')).toBe('json');
    expect(flagValue(a, '--tools')).not.toContain('bash');
    expect(a).toContain('--no-mcp');
    expect(flagValue(a, '--session-id')).toMatch(/^nv-/);
    expect(a.at(-1)).toContain(`${RUN}/in/workorder.md`);
    expect(inv.env.PI_CODING_AGENT_DIR).toBe('/data/accounts/a1/home/.pi/agent');
  });
});

describe('所有 adapter 的契约', () => {
  it('每个 harness 都有 adapter 与默认能力', () => {
    expect(new Set(listAdapters().map((a) => a.id))).toEqual(new Set([...REAL, 'fake']));
    for (const a of listAdapters()) {
      expect(a.defaults, a.id).toBeDefined();
      expect(defaultCapabilities(a.id, '1.0.0', 'container').version).toBe('1.0.0');
    }
  });

  it('authMethods 声明的网页登录都有 loginCommand，反之亦然', () => {
    for (const a of listAdapters()) {
      expect(a.authMethods().length, a.id).toBeGreaterThan(0);
      for (const m of a.authMethods()) {
        const mode = m.mode as AuthMode;
        const cmd = a.loginCommand?.(acctFor(a.id, { authMode: mode }), INST(a.id), mode) ?? null;
        if (m.login) {
          expect(cmd, `${a.id}/${m.mode}`).not.toBeNull();
          expect(cmd!.cwd).toBe('/data/accounts/a1/home');
          expect(cmd!.env.HOME).toBe('/data/accounts/a1/home');
        } else {
          expect(cmd, `${a.id}/${m.mode}`).toBeNull();
        }
      }
    }
  });

  it('登录命令按 harness 隔离配置目录', () => {
    const env = (id: HarnessId, mode: 'subscription_login') => getAdapter(id).loginCommand!(acctFor(id), INST(id), mode)!.env;
    expect(env('claude-code', 'subscription_login').CLAUDE_CONFIG_DIR).toBe('/data/accounts/a1/home/.claude');
    expect(env('codex', 'subscription_login').CODEX_HOME).toBe('/data/accounts/a1/home/.codex');
    expect(env('grok', 'subscription_login').GROK_HOME).toBe('/data/accounts/a1/home/.grok');
    expect(env('pi', 'subscription_login').PI_CODING_AGENT_DIR).toBe('/data/accounts/a1/home/.pi/agent');
  });

  it('cc setup-token 用 TTY 并捕获 token', () => {
    const cmd = getAdapter('claude-code').loginCommand!(acctFor('claude-code'), INST('claude-code'), 'oauth_token')!;
    expect(cmd.argv).toEqual(['/opt/bin/claude-code', 'setup-token']);
    expect(cmd.tty).toBe(true);
    expect('sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx'.match(cmd.captureEnv![0]!.pattern)).toBeTruthy();
    expect(getAdapter('claude-code').loginCommand!(acctFor('claude-code'), INST('claude-code'), 'custom_api')).toBeNull();
  });

  it.each(REAL)('%s: writePaths 含 outDir 与 logDir；秘密不进 argv', async (h) => {
    const secretEnv: Record<string, Record<string, string>> = {
      'claude-code': { ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_API_KEY: 'SUPERSECRET123' },
      codex: { OPENAI_BASE_URL: 'https://gw', OPENAI_API_KEY: 'SUPERSECRET123' },
      agy: { GOOGLE_GEMINI_BASE_URL: 'https://gw', GEMINI_API_KEY: 'SUPERSECRET123' },
      grok: { XAI_API_KEY: 'SUPERSECRET123' },
      dsh: { DEEPSEEK_API_KEY: 'SUPERSECRET123' },
      pi: { XAI_API_KEY: 'SUPERSECRET123' },
    };
    const { inv } = await build(h, { authMode: h === 'claude-code' || h === 'codex' || h === 'agy' ? 'custom_api' : 'api_key', secretEnv: secretEnv[h]! });
    expect(inv.writePaths).toEqual(expect.arrayContaining([`${RUN}/book/work/t1/attempt-1/out`, `${RUN}/log`]));
    expect(inv.readPaths).toEqual(expect.arrayContaining([`${RUN}/book`, `${RUN}/in`]));
    expect(inv.argv.join('\n')).not.toContain('SUPERSECRET123');
    expect(Object.values(inv.env)).toContain('SUPERSECRET123');
    expect(inv.env.PATH).toContain('/opt/bin');
    expect(inv.stop.length).toBeGreaterThan(0);
  });

  it('D2：dev 廉价模型不是任何 adapter 的默认能力来源，只作 devModel', () => {
    expect(getAdapter('claude-code').devModel).toBe('claude-haiku-5-5');
    expect(getAdapter('codex').devModel).toBe('gpt-6-luna');
    expect(getAdapter('agy').devModel).toBe('gemini-3.8-flash-low');
  });
});

describe('common 工具', () => {
  it('toolKindOf 跨 harness 映射', () => {
    expect(['Write', 'write_to_file', 'write'].map(toolKindOf)).toEqual(['write', 'write', 'write']);
    expect(['Edit', 'replace_file_content', 'apply_patch', 'search_replace'].map(toolKindOf)).toEqual(['edit', 'edit', 'edit', 'edit']);
    expect(['Bash', 'run_terminal_cmd', 'shell', 'run_command'].map(toolKindOf)).toEqual(['exec', 'exec', 'exec', 'exec']);
    expect(['mcp__nv__x', 'Agent', 'WebFetch', 'mystery'].map(toolKindOf)).toEqual(['mcp', 'subagent', 'web', 'other']);
  });

  it('filterExtraArgs 同时去掉 flag 的值', () => {
    expect(filterExtraArgs(['--a', '--deny', 'v', '--deny=x', '--b', 'w'], [/^--deny/])).toEqual(['--a', '--b', 'w']);
  });

  it('parseModelLines：slug\\tlabel、跳过提示行', () => {
    expect(parseModelLines('Fetching models...\ngemini-4-argon\tGemini 4 Argon\ngemini-3.8-flash-low\tFlash\n\ngemini-4-argon\tdup\n')).toEqual(['gemini-4-argon', 'gemini-3.8-flash-low']);
  });
});
