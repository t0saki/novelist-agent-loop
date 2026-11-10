/**
 * 通用 fake adapter（DESIGN §10 测试用的假 harness）。
 * - 可执行文件：harness/fake/fake-harness.ts（node 直接跑，或经 tsx）。
 * - 行为：“目录模式”——读 cwd（书快照）下的 ORDER.md，照任务单在书目录里写文件；故障开关见 fake-harness.ts 的 dirMain / $RUN/in/fake.json。
 *   ORDER.md 是目录探测（canary）时只写 canary.txt。
 * - stdout：每行一个已经是 NEvent 形状的 JSON（{t:'init'…}…{t:'result'}），parser 只需补 seq/ts/runId。
 * 认证：none。另提供 subscription_login 的演示登录（fake-harness --login），供登录 UI 的 e2e 测试。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthMethodSpec, NEvent, NEventBody } from '@novelist/shared';
import { zNEvent } from '@novelist/shared';
import { buildOutcome } from '../classify.js';
import { ndjsonParser } from '../events.js';
import type { CapabilityDefaults, HarnessAdapter, HomeLayout } from '../types.js';
import { buildEnv, capsFrom, filterExtraArgs, invocation, minimalEnv } from './common.js';

const DEFAULTS: CapabilityDefaults = {
  structuredOutput: 'native',
  schemaDialect: 'lenient',
  systemChannel: 'append-file',
  systemReplace: true,
  shellTool: 'disableable',
  webTool: 'disableable',
  subagentTool: 'disableable',
  honorsHttpsProxy: true,
  workspaceDocLoaded: true,
  systemChannelLoaded: true,
  tailNonceSurvives: true,
  sessionPreassign: true,
  resume: true,
  fork: true,
  stopHook: 'none',
  mcpHttp: 'none',
  exitZeroOnFailure: false,
  quotaSignal: 'inline',
};

export const FAKE_VERSION = '1.0.0';

/** fake-harness 脚本位置：构建后 .js；开发/测试 .ts（node type-strip） */
export function fakeScriptPath(): string {
  if (process.env.NOVELIST_FAKE_HARNESS_PATH) return process.env.NOVELIST_FAKE_HARNESS_PATH;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ['../fake/fake-harness.js', '../fake/fake-harness.ts']) {
    const p = path.resolve(here, f);
    if (existsSync(p)) return p;
  }
  throw new Error('fake-harness script not found');
}

export function createFakeParser() {
  return ndjsonParser((o) => {
    if (typeof o.t !== 'string') return undefined;
    const r = zNEvent.safeParse({ ...o, seq: 0, ts: '', runId: '' });
    if (!r.success) return [{ t: 'unknown', rawType: String(o.t) }];
    const { seq: _s, ts: _t, runId: _r, ...body } = r.data;
    return [body as NEventBody];
  });
}

export const fakeAdapter: HarnessAdapter = {
  id: 'fake',
  displayName: 'Fake harness（测试）',
  vendor: 'fake',
  supportedVersions: '*',
  defaults: DEFAULTS,
  devModel: 'fake-model',
  authMethods: (): AuthMethodSpec[] => [
    { mode: 'none', label: '无需认证（测试 / 演示）', env: [], files: [], login: null, allowsCustomModels: true },
    {
      mode: 'subscription_login',
      label: '演示交互登录（fake-harness --login）',
      env: [],
      files: [{ relPath: '.fake/auth.json', part: 'state' }],
      login: { argv: ['fake-harness', '--login'], hint: '任意非空授权码即成功；输入 bad 模拟失败' },
      allowsCustomModels: true,
    },
  ],
  async detect() {
    try {
      fakeScriptPath();
    } catch {
      return null;
    }
    return { binPath: process.execPath, version: FAKE_VERSION };
  },
  async listModels(acct) {
    return [...new Set(['fake-model', ...(acct.customModels ?? [])])];
  },
  async prepareHome(acct): Promise<HomeLayout> {
    return { home: acct.home, configFiles: [], stateDirs: [], env: { HOME: acct.home } };
  },
  buildInvocation(spec, _caps, home, acct, inst) {
    // “目录模式”：读 cwd 下的 ORDER.md，直接在书目录里写文件（fake-harness.ts dirMain）
    const argv = [inst.binPath, fakeScriptPath(), '--v3', '--launch', spec.workOrderFile, '--model', spec.model, '--session', spec.session.id || spec.runId];
    const scenario = path.join(spec.inDir, 'fake.json');
    if (existsSync(scenario)) argv.push('--scenario', scenario);
    argv.push(...filterExtraArgs(spec.extraArgs, []));
    const env = buildEnv(spec, inst, acct.secretEnv, home.env);
    return invocation(spec, argv, env, 'devnull', [
      { signal: 'SIGINT', graceMs: 1000 },
      { signal: 'SIGTERM', graceMs: 1000 },
    ]);
  },
  createParser: () => createFakeParser(),
  classify(exit, events: NEvent[], stderrTail) {
    return buildOutcome(exit, events, stderrTail, {
      completed: (x, evs) => {
        const r = [...evs].reverse().find((e) => e.t === 'result');
        return x.code === 0 && r?.t === 'result' && r.status === 'success';
      },
    });
  },
  async probe(_inst, _acct, ctx) {
    return {
      ...capsFrom(DEFAULTS, FAKE_VERSION, ctx.isolation, ['fake-model']),
      verifiedAt: new Date().toISOString(),
      eventTypesSeen: ['init', 'tool_call', 'tool_result', 'file_change', 'usage', 'result'],
      probeSteps: [{ step: 'version', ok: true, detail: FAKE_VERSION }],
    };
  },
  async authCheck() {
    return { ok: true, detail: 'fake：无需认证' };
  },
  loginCommand(acct, inst, mode) {
    if (mode !== 'subscription_login') return null;
    return {
      argv: [inst.binPath, fakeScriptPath(), '--login'],
      env: minimalEnv(inst.binPath, { HOME: acct.home }),
      cwd: acct.home,
      successFiles: ['.fake/auth.json'],
      credentialFiles: [{ relPath: '.fake/auth.json', part: 'state' }],
      captureEnv: [{ name: 'FAKE_TOKEN', pattern: /fake-oauth-[A-Z0-9]+/ }],
    };
  },
};
