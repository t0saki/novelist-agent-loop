/**
 * v3 启动契约（p1-plan §3 Harness / §6）：contract:'v3' 时不传 schema、启动语统一、指令不走 system channel、书快照可写。
 * 旧契约（无 contract）的 argv 与改动前逐字一致（内联快照）。全部离线，不调真实 CLI。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessId, HarnessInstall } from '@novelist/shared';
import { toJsonSchema, V3_LAUNCH_PROMPT, zReceipt } from '@novelist/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { materializeFor } from '../../instructions/materialize/index.js';
import type { MaterializeResult } from '../../instructions/types.js';
import { mountPlanFor } from '../isolation.js';
import { defaultCapabilities } from '../probe.js';
import { getAdapter } from '../registry.js';
import { compiledFromSystem } from '../testing.js';
import type { Invocation, ResolvedAccount, RunSpec } from '../types.js';
import { launchPrompt, readSchemaFile, wantsSchema } from './common.js';

const REAL: HarnessId[] = ['agy', 'claude-code', 'codex', 'grok', 'pi', 'dsh'];
let ROOT = '';
let RUN = '';

beforeAll(async () => {
  ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-v3a-'));
  RUN = path.join(ROOT, 'runs', '2026-11', 'RUN');
  for (const d of ['in', 'log', 'book']) await fs.mkdir(path.join(RUN, d), { recursive: true });
  await fs.mkdir(path.join(ROOT, 'accounts', 'a1', 'home'), { recursive: true });
  // 旧契约要有真实的 receipt schema，才能看出 v3 把它去掉了
  await fs.writeFile(path.join(RUN, 'in', 'receipt.lenient.json'), JSON.stringify(toJsonSchema(zReceipt, 'lenient')));
  await fs.writeFile(path.join(RUN, 'in', 'launch.md'), `${V3_LAUNCH_PROMPT}\n`);
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

const SECRETS: Partial<Record<HarnessId, Record<string, string>>> = { dsh: { DEEPSEEK_API_KEY: 'd-123456' } };
const AUTH: Partial<Record<HarnessId, string>> = { dsh: 'api_key' };

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
    effort: 'high',
    limits: { wallMs: 600_000, idleMs: 120_000, maxTurns: 90 },
    session: { mode: 'fresh', id: '99999999-2222-4333-8444-555555555555' },
    persistSession: false,
    egress: { allow: [] },
    subagents: false,
    extraArgs: [],
    ...o,
  };
}

/** executor 在 v3 下给出的 RunSpec 形状：workOrderFile = launch.md，receipt schema 指向不存在的文件 */
const v3Spec = (harness: HarnessId, o: Partial<RunSpec> = {}): RunSpec =>
  specFor(harness, { contract: 'v3', taskKind: 'book.write' as RunSpec['taskKind'], workOrderFile: `${RUN}/in/launch.md`, receiptSchemaFile: `${RUN}/in/receipt.none.json`, ...o });

function acctFor(harness: HarnessId): ResolvedAccount {
  return {
    id: 'a1',
    harness,
    label: '',
    authMode: (AUTH[harness] ?? 'none') as ResolvedAccount['authMode'],
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
    home: path.join(ROOT, 'accounts', 'a1', 'home'),
    secretEnv: SECRETS[harness] ?? {},
    credentialFiles: [],
  };
}

const INST = (id: HarnessId): HarnessInstall => ({ id, version: '9.9.9', binPath: `/opt/bin/${id}`, sha256: '', sha256Source: 'tofu', tier: 'probed', status: 'active' });
const COMPILED = compiledFromSystem('NV-C-HEAD-AAAAAAAAAAAA\n# 契约\nNV-B-HEAD-BBBBBBBBBBBB\n书层指令\nNV-B-TAIL-CCCCCCCCCCCC\n');
const capsOf = (harness: HarnessId) => ({ ...defaultCapabilities(harness, '9.9.9', 'container'), structuredOutput: 'native' as const });

/** 全流程：prepareHome → adapter.materialize（v3 下经 materializeFor 返回空）→ buildInvocation */
async function build(harness: HarnessId, spec: RunSpec, mat?: MaterializeResult): Promise<{ inv: Invocation; mat: MaterializeResult; configFiles: string[] }> {
  const adapter = getAdapter(harness);
  const acct = acctFor(harness);
  const caps = capsOf(harness);
  const home = await adapter.prepareHome(acct, INST(harness), spec);
  const m = mat ?? (await adapter.materialize(spec, COMPILED, caps, { home: acct.home }));
  return { inv: adapter.buildInvocation(spec, caps, home, m, acct, INST(harness)), mat: m, configFiles: home.configFiles.map((f) => f.path) };
}

const flagValue = (argv: string[], flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** 快照用：临时目录换成 $ROOT，内联 JSON schema 折成 <schema> */
const norm = (argv: string[]) => argv.map((a) => (a.startsWith('{') && a.length > 200 ? '<schema>' : a.split(ROOT).join('$ROOT')));

describe('v3 启动契约：各 adapter', () => {
  it('common：wantsSchema / launchPrompt / readSchemaFile', () => {
    const caps = capsOf('claude-code');
    expect(wantsSchema(specFor('claude-code'), caps)).toBe(true);
    expect(wantsSchema(specFor('claude-code'), { ...caps, structuredOutput: 'none' })).toBe(false);
    expect(wantsSchema(v3Spec('claude-code'), caps)).toBe(false);
    expect(launchPrompt(specFor('agy'), 'old')).toBe('old');
    expect(launchPrompt(v3Spec('agy'), 'old')).toBe(V3_LAUNCH_PROMPT);
    expect(readSchemaFile(specFor('claude-code'))).toMatch(/^\{/);
    // v3 下即使 receiptSchemaFile 指向一个真实存在的 schema 也不读
    expect(readSchemaFile(v3Spec('claude-code', { receiptSchemaFile: `${RUN}/in/receipt.lenient.json` }))).toBeNull();
  });

  for (const h of REAL) {
    it(`${h}：没有 --json-schema / --output-schema，也没有 system channel 参数`, async () => {
      const { inv, mat, configFiles } = await build(h, v3Spec(h));
      expect(inv.argv).not.toContain('--json-schema');
      expect(inv.argv).not.toContain('--output-schema');
      expect(inv.argv.some((a) => a.includes('receipt.'))).toBe(false);
      for (const f of ['--agent', '--append-system-prompt-file', '--append-system-prompt', '--system-prompt', '--system-prompt-file', '--rules']) expect(inv.argv).not.toContain(f);
      expect(inv.argv.some((a) => a.includes('developer_instructions'))).toBe(false);
      expect(inv.argv.some((a) => a.endsWith('/in/system.md'))).toBe(false);
      expect(mat).toEqual({ files: [], argv: [], env: {}, budget: { ok: true, bytes: 0, limit: null }, notes: ['v3：指令只在工作区 AGENTS.md'] });
      expect(configFiles.some((p) => p.endsWith('receipt.codex.json'))).toBe(false);
      expect(inv.cwd).toBe(`${RUN}/book`);
    });

    it(`${h}：materializeFor 在 v3 下为空`, async () => {
      const spec = v3Spec(h);
      const r = await materializeFor(h, { harness: h, spec, compiled: COMPILED, caps: capsOf(h), personaMode: 'append', home: acctFor(h).home });
      expect(r.files).toEqual([]);
      expect(r.argv).toEqual([]);
      expect(r.env).toEqual({});
      expect(r.budget.ok).toBe(true);
    });
  }

  it('启动语：agy / pi 内联，claude / codex / dsh 走 stdin launch.md，grok 走 --prompt-file', async () => {
    const launch = `${RUN}/in/launch.md`;
    const agy = (await build('agy', v3Spec('agy'))).inv;
    expect(flagValue(agy.argv, '-p')).toBe(V3_LAUNCH_PROMPT);
    expect(agy.stdin).toBe('devnull');
    const pi = (await build('pi', v3Spec('pi'))).inv;
    expect(pi.argv.at(-1)).toBe(V3_LAUNCH_PROMPT);
    for (const h of ['claude-code', 'codex', 'dsh'] as const) expect((await build(h, v3Spec(h))).inv.stdin).toEqual({ file: launch });
    const grok = (await build('grok', v3Spec('grok'))).inv;
    expect(flagValue(grok.argv, '--prompt-file')).toBe(launch);
    expect(grok.argv.join(' ')).not.toContain('workorder.md');
  });

  it('claude --max-turns 取 limits；effort 取 spec.effort', async () => {
    const cc = (await build('claude-code', v3Spec('claude-code', { limits: { wallMs: 3_600_000, idleMs: 120_000, maxTurns: 90 } }))).inv.argv;
    expect(flagValue(cc, '--max-turns')).toBe('90');
    expect(flagValue(cc, '--effort')).toBe('high');
    const agy = (await build('agy', v3Spec('agy', { effort: 'low' }))).inv.argv;
    expect(flagValue(agy, '--effort')).toBe('low');
    // 模型名自带档位时，档位跟着本次 run 的 effort 换；不带档位的模型名不动
    const agyHigh = (await build('agy', v3Spec('agy', { effort: 'high', model: 'gemini-4-argon-medium' }))).inv.argv;
    expect(flagValue(agyHigh, '--model')).toBe('gemini-4-argon-high');
    expect(flagValue(agyHigh, '--effort')).toBe('high');
    const agyPlain = (await build('agy', v3Spec('agy', { effort: 'high', model: 'gpt-oss-120b' }))).inv.argv;
    expect(flagValue(agyPlain, '--model')).toBe('gpt-oss-120b');
    const codex = (await build('codex', v3Spec('codex'))).inv.argv;
    expect(codex).toContain('model_reasoning_effort="high"');
    expect(flagValue((await build('grok', v3Spec('grok'))).inv.argv, '--reasoning-effort')).toBe('high');
    expect(flagValue((await build('pi', v3Spec('pi', { effort: 'medium' }))).inv.argv, '--thinking')).toBe('medium');
  });

  it('fake：v3 目录模式 argv，不传 --system', async () => {
    const adapter = getAdapter('fake');
    const spec = v3Spec('fake');
    const acct = acctFor('fake');
    const caps = defaultCapabilities('fake', '1.0.0', 'container');
    const inst: HarnessInstall = { ...INST('fake'), binPath: process.execPath };
    const home = await adapter.prepareHome(acct, inst, spec);
    const mat = await adapter.materialize(spec, COMPILED, caps, { home: acct.home });
    expect(mat).toEqual({ files: [], argv: [], env: {}, budget: { ok: true, bytes: 0, limit: null }, notes: [] });
    const inv = adapter.buildInvocation(spec, caps, home, mat, acct, inst);
    expect(inv.argv).toContain('--v3');
    expect(flagValue(inv.argv, '--launch')).toBe(`${RUN}/in/launch.md`);
    expect(inv.argv).not.toContain('--workorder');
    expect(inv.argv).not.toContain('--system');
    expect(flagValue(inv.argv, '--session')).toBe(spec.session.id);
  });
});

describe('v3 挂载计划', () => {
  it('mountPlanFor v3：bookDir 可写，live .git 只读，inDir 只读', async () => {
    const live = path.join(ROOT, 'books', 'demo');
    await fs.mkdir(path.join(live, '.git', 'worktrees', 'RUN'), { recursive: true });
    const bookDir = path.join(RUN, 'book');
    await fs.writeFile(path.join(bookDir, '.git'), `gitdir: ${path.join(live, '.git', 'worktrees', 'RUN')}\n`);
    const plan = mountPlanFor(v3Spec('agy'), [], []);
    expect(plan.rw).toContain(bookDir);
    expect(plan.ro).not.toContain(bookDir);
    expect(plan.ro).toContain(path.join(live, '.git'));
    expect(plan.rw).not.toContain(path.join(live, '.git'));
    expect(plan.ro).toContain(`${RUN}/in`);
    expect(plan.rw).not.toContain(`${RUN}/in`);
    // 旧契约：书快照只读
    const old = mountPlanFor(specFor('agy'), [], []);
    expect(old.ro).toContain(bookDir);
    expect(old.rw).not.toContain(bookDir);
  });
});

describe('旧契约 argv 不变', () => {
  const OLD_MAT: Partial<Record<HarnessId, MaterializeResult>> = {
    agy: { files: [], argv: ['--agent', 'nv-writer'], env: {}, budget: { ok: true, bytes: 10, limit: null }, notes: [] },
    'claude-code': { files: [], argv: ['--append-system-prompt-file', '/R/in/system.md'], env: {}, budget: { ok: true, bytes: 10, limit: null }, notes: [] },
    codex: { files: [], argv: ['-c', 'developer_instructions="x"'], env: {}, budget: { ok: true, bytes: 10, limit: null }, notes: [] },
  };
  const argvOf = async (h: HarnessId) =>
    norm((await build(h, specFor(h), OLD_MAT[h] ?? { files: [], argv: [], env: {}, budget: { ok: true, bytes: 10, limit: null }, notes: [] })).inv.argv);

  it('agy', async () => {
    expect(await argvOf('agy')).toMatchInlineSnapshot(`
      [
        "/opt/bin/agy",
        "-p",
        "阅读并执行工作单 $ROOT/runs/2026-11/RUN/in/workorder.md（先完整读取该文件；产物只写入其中声明的 out_dir）。Read $ROOT/runs/2026-11/RUN/in/workorder.md and execute it.",
        "--output-format",
        "stream-json",
        "--json-schema",
        "$ROOT/runs/2026-11/RUN/in/receipt.lenient.json",
        "--model",
        "some-model",
        "--effort",
        "high",
        "--agent",
        "nv-writer",
        "--settings",
        "$ROOT/runs/2026-11/RUN/in/agy.settings.json",
        "--add-dir",
        "$ROOT/runs/2026-11/RUN/in",
        "--print-timeout",
        "570s",
        "--log-file",
        "$ROOT/runs/2026-11/RUN/log/agy.log",
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
      ]
    `);
  });
  it('claude-code', async () => {
    expect(await argvOf('claude-code')).toMatchInlineSnapshot(`
      [
        "/opt/bin/claude-code",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--session-id",
        "99999999-2222-4333-8444-555555555555",
        "--model",
        "some-model",
        "--effort",
        "high",
        "--permission-mode",
        "acceptEdits",
        "--permission-prompts",
        "none",
        "--tools",
        "Read,Write,Edit,Glob,Grep",
        "--disallowedTools",
        "Bash,WebFetch,WebSearch,NotebookEdit,Agent,Task",
        "--setting-sources",
        "project",
        "--strict-mcp-config",
        "--settings",
        "$ROOT/runs/2026-11/RUN/in/cc.adapter.settings.json",
        "--append-system-prompt-file",
        "/R/in/system.md",
        "--json-schema",
        "<schema>",
        "--max-turns",
        "90",
        "--no-session-persistence",
        "--add-dir",
        "$ROOT/runs/2026-11/RUN/in",
      ]
    `);
  });
  it('codex', async () => {
    expect(await argvOf('codex')).toMatchInlineSnapshot(`
      [
        "/opt/bin/codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-m",
        "some-model",
        "--color",
        "never",
        "-C",
        "$ROOT/runs/2026-11/RUN/book",
        "-c",
        "projects={"$ROOT/runs/2026-11/RUN/book"={trust_level="trusted"}}",
        "-c",
        "agents.enabled=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "model_reasoning_effort="high"",
        "-c",
        "developer_instructions="x"",
        "--dangerously-bypass-approvals-and-sandbox",
        "--output-schema",
        "$ROOT/runs/2026-11/RUN/in/receipt.codex.json",
        "-o",
        "$ROOT/runs/2026-11/RUN/log/last-message.json",
        "--ephemeral",
        "-",
      ]
    `);
  });
  it('grok', async () => {
    expect(await argvOf('grok')).toMatchInlineSnapshot(`
      [
        "/opt/bin/grok",
        "--no-auto-update",
        "--prompt-file",
        "$ROOT/runs/2026-11/RUN/in/workorder.md",
        "--cwd",
        "$ROOT/runs/2026-11/RUN/book",
        "--output-format",
        "streaming-json",
        "-m",
        "some-model",
        "--reasoning-effort",
        "high",
        "--always-approve",
        "--disallowed-tools",
        "run_terminal_cmd,web_search,web_fetch,task",
        "--disable-web-search",
        "--no-wait-for-background",
        "--no-subagents",
        "--max-turns",
        "90",
        "-s",
        "99999999-2222-4333-8444-555555555555",
        "--json-schema",
        "<schema>",
      ]
    `);
  });
  it('pi', async () => {
    expect(await argvOf('pi')).toMatchInlineSnapshot(`
      [
        "/opt/bin/pi",
        "--mode",
        "json",
        "--approve",
        "--model",
        "some-model",
        "--thinking",
        "high",
        "--session-id",
        "nv-99999999-2222-4333-8444-555555555555",
        "--tools",
        "read,write,edit,grep,find,ls",
        "--no-mcp",
        "阅读并执行工作单 $ROOT/runs/2026-11/RUN/in/workorder.md（先完整读取该文件）。Read $ROOT/runs/2026-11/RUN/in/workorder.md and execute it.",
      ]
    `);
  });
  it('dsh', async () => {
    expect(await argvOf('dsh')).toMatchInlineSnapshot(`
      [
        "/opt/bin/dsh",
        "--profile",
        "headless",
        "--patch",
        "$ROOT/runs/2026-11/RUN/in/dsh.adapter.patch.yml",
        "--json",
        "--permission-mode",
        "danger-full-access",
        "--approval-policy",
        "never",
        "-",
      ]
    `);
  });
});
