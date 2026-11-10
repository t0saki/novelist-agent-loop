/**
 * 通用 fake adapter（DESIGN §3.5 fake、§10.4 第 3 条）。Owner: lane A。
 * - 可执行文件：harness/fake/fake-harness.ts（node 直接跑，或经 tsx）。
 * - 行为：读 workOrderFile 的 frontmatter（nv.workorder/1），按 artifacts 声明在 out_dir 写出“看起来合法”的产物：
 *   chapter_draft → 带 beat 标记、长度落在 length 区间的中文填充；check/delta → 最小合法 nv.check/1（ev 取自草稿逐字）；
 *   receipt → nv.receipt/1，nonces 取自 systemFile 中所有 NV-*-HEAD/TAIL-* 串；其他 kind → schema 最小合法样例。
 * - 场景注入（frontmatter.fake 或 $RUN/in/fake.json）：{ fail?: ErrorClass, exitCode?, sleepMs?, dripMs?, skipArtifacts?: string[],
 *   dropTailNonce?: string, writeOutside?: string, readRunIn?: boolean, ignoreSigterm?: boolean, malformedJson?: boolean,
 *   rateLimit?: {window, utilization, resetsAt} } —— 用于 chaos/故障注入测试。
 *   另有：noResult（无终止事件 → drift）、failAfterWrite、extraFile、draftChars、verdict、content{path:内容}、expand{glob:[ids]}、
 *   start、volume、arc、chapters、genre、title（见 fake/fake-harness.ts 的 FakeScenario）。
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
  async materialize(spec, compiled) {
    // v3：指令只在工作区 AGENTS.md，不传 --system
    if (spec.contract === 'v3') return { files: [], argv: [], env: {}, budget: { ok: true, bytes: 0, limit: null }, notes: [] };
    return { files: [], argv: ['--system', spec.systemFile], env: {}, budget: { ok: true, bytes: compiled.bytes, limit: null }, notes: [] };
  },
  buildInvocation(spec, _caps, home, mat, acct, inst) {
    // v3 “目录模式”：读 cwd 下的 ORDER.md，直接在书目录里写文件（fake-harness.ts dirMain）
    const argv =
      spec.contract === 'v3'
        ? [inst.binPath, fakeScriptPath(), '--v3', '--launch', spec.workOrderFile, '--model', spec.model, '--session', spec.session.id || spec.runId]
        : [inst.binPath, fakeScriptPath(), '--workorder', spec.workOrderFile, ...mat.argv, '--model', spec.model, '--session', spec.session.id || spec.runId];
    const scenario = path.join(spec.inDir, 'fake.json');
    if (existsSync(scenario)) argv.push('--scenario', scenario);
    argv.push(...filterExtraArgs(spec.extraArgs, []));
    const env = buildEnv(spec, inst, acct.secretEnv, home.env, mat.env);
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
