/**
 * DeepSeek Harness adapter。Owner: lane A。
 * 事实来源（flags、事件格式、坑）：docs/v2/research/h_dsh-and-pi.md —— 写代码前先读，不要发明 flag。
 * DESIGN：§3.3（成功判定）、§3.5（命令模板）、§3.6（home 布局与并发）、§3.7（认证模式）。
 * 认证：api_key（DEEPSEEK_API_KEY，可选 DEEPSEEK_BASE_URL；用户在 UI 配置）。需要 Node ≥24.9。--json 是否存在须先核对研究文档/本地副本（scratchpad/dsh），不存在则走 ACP。session-log-deepseek 必须关闭。
 *
 * 已按源码核实（packages/bundle/headless/src/json-stream.ts，HEAD fcc0ad4）：`--json` 存在；事件
 *   {type:'session',sessionId,cwd} → status{phase:turn_start|step_start|step_end(usage)|turn_end(reason)} / text{text} / thinking{text}
 *   / tool_call{callId,tool,input} / tool_result{callId,status:'completed'|'error',result,error?{name,code,reason}} → final{sessionId,reason,text}
 *   driver 失败：error 事件且没有 final。成功 = exit 0 且 final.reason.kind=='completed'。
 * 启动器 flag（--profile/--patch）必须在 app 参数之前；patch 是整行替换（不深合并）。headless 没有 --model：模型走 agent-default-model 行。
 */
import path from 'node:path';
import type { AuthMethodSpec, ErrorClass, NEvent, NEventBody } from '@novelist/shared';
import { RISK_NOTES } from '@novelist/shared';
import { stringify as yamlStringify } from 'yaml';
import { buildOutcome, classifyText } from '../classify.js';
import { errorEvent, ndjsonParser, num, obj, optNum, str } from '../events.js';
import type { CapabilityDefaults, HarnessAdapter, HomeLayout, RunSpec, StreamParser } from '../types.js';
import { authConfigError, buildEnv, detectBin, effortOf, filterExtraArgs, invocation, standardProbe, toolCallEvent, toolKindOf } from './common.js';

const DEFAULTS: CapabilityDefaults = {
  structuredOutput: 'none',
  schemaDialect: 'none',
  systemChannel: 'persona-patch',
  systemReplace: false,
  shellTool: 'always',
  webTool: 'disableable',
  subagentTool: 'disableable',
  honorsHttpsProxy: true,
  workspaceDocLoaded: true,
  systemChannelLoaded: true,
  tailNonceSurvives: true,
  sessionPreassign: false,
  resume: false,
  fork: false,
  stopHook: 'none',
  mcpHttp: 'unverified',
  exitZeroOnFailure: false,
  quotaSignal: 'error-only',
  templateEscaping: 'braces-escaped',
};
export const DSH_KNOWN_MODELS = ['deepseek-flash', 'deepseek-v4-flash'];
const EFFORTS = ['off', 'low', 'high', 'max'];
const DENY_EXTRA = [/^--permission-mode/, /^--approval-policy/, /^--add-dir/, /^--profile/];

/** adapter 自己的 patch 层：模型、关闭 session-log 上传、关闭子代理/团队/workflow（行名取自 base bundle） */
export function dshAdapterPatch(spec: Pick<RunSpec, 'model' | 'effort'>): string {
  const rows: Record<string, unknown>[] = [];
  const modelCfg: Record<string, unknown> = { provider: 'deepseek-official', model: spec.model };
  const eff = spec.effort && EFFORTS.includes(spec.effort) ? spec.effort : undefined;
  if (eff) modelCfg.reasoningEffort = eff;
  rows.push({ id: 'agent-default-model', config: modelCfg });
  rows.push({ id: 'session-log-deepseek', disabled: true });
  for (const id of ['tool-subagent', 'tool-subagent-fork', 'tool-agent-team', 'tool-workflow']) rows.push({ id, disabled: true });
  return `# Novelist 每 run 生成（dsh adapter 层）\n${yamlStringify(rows)}`;
}

export function createDshParser(): StreamParser {
  const calls = new Map<string, { name: string; paths: string[] }>();
  let sessionId: string | undefined;
  return ndjsonParser((o) => {
    switch (str(o.type)) {
      case 'session':
        sessionId = str(o.sessionId);
        return [{ t: 'init', ...(sessionId ? { sessionId } : {}) }];
      case 'status': {
        const phase = str(o.phase);
        if (phase === 'step_end' && o.usage) {
          const u = obj(o.usage);
          return [
            {
              t: 'usage',
              input: num(u.inputTokens),
              cachedInput: num(u.cacheReadTokens),
              cacheWrite: num(u.cacheWriteTokens),
              output: num(u.outputTokens),
              reasoning: num(u.reasoningTokens),
              costSource: 'unknown',
              scope: 'delta',
            },
          ];
        }
        return [{ t: 'heartbeat', source: 'stdout' }];
      }
      case 'text':
        return str(o.text) ? [{ t: 'text', channel: 'assistant', delta: str(o.text)! }] : [{ t: 'heartbeat', source: 'stdout' }];
      case 'thinking':
        return str(o.text) ? [{ t: 'text', channel: 'thinking', delta: str(o.text)! }] : [{ t: 'heartbeat', source: 'stdout' }];
      case 'tool_call': {
        const id = String(o.callId ?? '');
        const name = str(o.tool) ?? 'unknown';
        const ev = toolCallEvent(id, name, o.input);
        calls.set(id, { name, paths: ev.t === 'tool_call' ? (ev.paths ?? []) : [] });
        return [ev];
      }
      case 'tool_result': {
        const id = String(o.callId ?? '');
        const ok = str(o.status) === 'completed';
        const err = obj(o.error);
        const out: NEventBody[] = [{ t: 'tool_result', id, ok, ...(!ok ? { error: (str(err.reason) ?? str(err.code) ?? str(o.result) ?? 'error').slice(0, 1000) } : {}) }];
        const c = calls.get(id);
        if (c) {
          const kind = toolKindOf(c.name);
          if (kind === 'write' || kind === 'edit') for (const p of c.paths) out.push({ t: 'file_change', path: p, op: kind === 'write' ? 'add' : 'update', ok });
        }
        if (!ok && /DENIED|PERMISSION|SANDBOX/i.test(String(err.code ?? ''))) out.push({ t: 'denial', tool: c?.name ?? 'unknown', ...(c?.paths[0] ? { path: c.paths[0] } : {}), detail: String(err.code ?? '') });
        return out;
      }
      case 'final': {
        sessionId = str(o.sessionId) ?? sessionId;
        const reason = obj(o.reason);
        const kind = str(reason.kind);
        const text = str(o.text);
        const out: NEventBody[] = [];
        if (kind === 'error') {
          // 真实形状：reason = { kind:'error', error: LlmFailure{ message, code, status } }
          const failure = obj(reason.error);
          const msg = str(failure.message) ?? str(failure.code) ?? 'turn error';
          out.push(errorEvent(statusClass(optNum(failure.status)) ?? classifyText(msg) ?? 'unknown', msg));
        }
        out.push({
          t: 'result',
          status: kind === 'completed' ? 'success' : kind === 'aborted' ? 'cancelled' : 'error',
          stopReason: kind ?? 'none',
          ...(sessionId ? { sessionId } : {}),
          ...(text ? { text: text.slice(0, 4000) } : {}),
          ...(optNum(o.turns) !== undefined ? { turns: optNum(o.turns)! } : {}),
        });
        return out;
      }
      case 'error': {
        const msg = str(o.message) ?? str(o.code) ?? 'dsh error';
        return [errorEvent(classifyText(msg) ?? 'unknown', msg)];
      }
      default:
        return undefined;
    }
  });
}

/** LlmFailure.status → 错误类；没有状态码时交给文本分类 */
function statusClass(status: number | undefined): ErrorClass | null {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  if (status !== undefined && status >= 500) return 'overloaded';
  return null;
}

export const dshAdapter: HarnessAdapter = {
  id: 'dsh',
  displayName: 'DeepSeek Harness',
  vendor: 'deepseek',
  supportedVersions: '>=0.2.2-rc.1',
  defaults: DEFAULTS,
  authMethods: (): AuthMethodSpec[] => [
    {
      mode: 'api_key',
      label: 'DeepSeek API key',
      env: [
        { name: 'DEEPSEEK_API_KEY', secret: true, required: true },
        { name: 'DEEPSEEK_BASE_URL', secret: false, required: false, hint: '可选：自建或代理端点' },
      ],
      files: [],
      login: null,
      riskNote: RISK_NOTES.api_key_billing?.text,
      allowsCustomModels: true,
    },
  ],
  async detect(harnessDir) {
    return detectBin(['dsh'], harnessDir);
  },
  async listModels(acct) {
    return [...new Set([...DSH_KNOWN_MODELS, ...(acct.customModels ?? [])])];
  },
  async prepareHome(acct, _inst, spec): Promise<HomeLayout> {
    const DH = path.join(acct.home, '.dsh');
    return {
      home: acct.home,
      configFiles: [{ path: path.join(spec.inDir, 'dsh.adapter.patch.yml'), content: dshAdapterPatch(spec) }],
      stateDirs: [DH],
      env: { HOME: acct.home, DSH_HOME: DH, DSH_TELEMETRY_MODE: 'DISABLED', npm_config_offline: 'true' },
    };
  },
  buildInvocation(spec, _caps, home, acct, inst) {
    if (!acct.secretEnv.DEEPSEEK_API_KEY) throw authConfigError('dsh 需要 DEEPSEEK_API_KEY（在账号页配置）');
    void effortOf;
    const adapterPatch = home.configFiles.find((f) => f.path.endsWith('dsh.adapter.patch.yml'))!;
    // 启动器 flag 在前：--profile、--patch（adapter 层）；指令在 cwd 的 AGENTS.md
    const argv = [inst.binPath, '--profile', 'headless', '--patch', adapterPatch.path];
    argv.push('--json', '--permission-mode', 'danger-full-access', '--approval-policy', 'never');
    if (spec.session.mode === 'resume') argv.push('--session-id', spec.session.id);
    argv.push(...filterExtraArgs(spec.extraArgs, DENY_EXTRA));
    argv.push('-');
    const env = buildEnv(spec, inst, acct.secretEnv, home.env);
    return invocation(spec, argv, env, { file: spec.workOrderFile }, [
      { signal: 'SIGINT', graceMs: 15_000 },
      { signal: 'SIGTERM', graceMs: 15_000 },
    ], { readPaths: [acct.home], writePaths: home.stateDirs });
  },
  createParser: () => createDshParser(),
  classify(exit, events: NEvent[], stderrTail) {
    return buildOutcome(exit, events, stderrTail, {
      completed: (x, evs) => {
        const r = [...evs].reverse().find((e) => e.t === 'result');
        return x.code === 0 && r?.t === 'result' && r.status === 'success' && r.stopReason === 'completed';
      },
    });
  },
  async probe(inst, acct, ctx) {
    return standardProbe(this, inst, acct, ctx, {
      helpArgv: [['--help'], ['--profile', 'headless', '--help']],
      requiredFlags: ['--profile', '--patch', '--json', '--permission-mode', '--approval-policy', '--session-id'],
      env: { DSH_HOME: path.join(acct.home, '.dsh'), DSH_TELEMETRY_MODE: 'DISABLED' },
    });
  },
  async authCheck(acct) {
    return acct.secretEnv.DEEPSEEK_API_KEY ? { ok: true, detail: 'DEEPSEEK_API_KEY 已配置（请求时校验）' } : { ok: false, detail: '缺少 DEEPSEEK_API_KEY' };
  },
};
