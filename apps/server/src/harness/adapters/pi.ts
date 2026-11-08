/**
 * pi adapter。Owner: lane A。
 * 事实来源（flags、事件格式、坑）：docs/v2/research/h_dsh-and-pi.md —— 写代码前先读，不要发明 flag。
 * DESIGN：§3.3（成功判定）、§3.5（命令模板）、§3.6（home 布局与并发）、§3.7（认证模式）。
 * 认证：subscription_login（/login，auth.json）、api_key。pi 没有自带沙箱：degraded 档拒绝运行。P4，可先只做 detect/authMethods/parser。
 *
 * JSON 模式（docs/json.md，1.5.0）：session 头 → agent_start/turn_start/message_start/message_update{usage,assistantMessageEvent}
 * /message_end{message}/turn_end/agent_end{willRetry}/agent_settled{aborted}；tool_execution_start|update|end{toolCallId,toolName,args,isError}；
 * compaction_start|end；auto_retry_start|end。失败也 exit 0：以 agent_settled.aborted 与最后一条 assistant stopReason 判定。
 * /login 只有交互式 TUI：网页登录在 script 伪终端里跑 pi，用户在输入框键入 /login（本机未安装，未实测）；也可上传已登录机器的 auth.json。isolation.isAllowed：只在 bwrap/landlock 档运行。
 */
import path from 'node:path';
import type { AuthMethodSpec, NEvent, NEventBody } from '@novelist/shared';
import { RISK_NOTES } from '@novelist/shared';
import { buildOutcome, classifyText } from '../classify.js';
import { arr, errorEvent, ndjsonParser, num, obj, optNum, str } from '../events.js';
import { runShort } from '../runner.js';
import type { CapabilityDefaults, HarnessAdapter, HomeLayout, StreamParser } from '../types.js';
import { buildEnv, detectBin, effortOf, filterExtraArgs, invocation, materializeVia, minimalEnv, standardProbe, toolCallEvent, toolKindOf } from './common.js';

const DEFAULTS: CapabilityDefaults = {
  structuredOutput: 'none',
  schemaDialect: 'none',
  systemChannel: 'append-arg',
  systemReplace: true,
  shellTool: 'disableable',
  webTool: 'disableable',
  subagentTool: 'disableable',
  honorsHttpsProxy: true,
  workspaceDocLoaded: true,
  systemChannelLoaded: true,
  tailNonceSurvives: true,
  sessionPreassign: true,
  resume: false,
  fork: true,
  stopHook: 'none',
  mcpHttp: 'none',
  exitZeroOnFailure: true,
  quotaSignal: 'none',
};
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DENY_EXTRA = [/^--tools/, /^-xt$/, /^--no-tools$/, /^-e$/, /^--extension/];

export function createPiParser(): StreamParser {
  const calls = new Map<string, { name: string; paths: string[] }>();
  let sessionId: string | undefined;
  let lastStop: string | undefined;
  let lastErr: string | undefined;
  return ndjsonParser((o) => {
    switch (str(o.type)) {
      case 'session':
        sessionId = str(o.id);
        return [{ t: 'init', ...(sessionId ? { sessionId } : {}) }];
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'queue_update':
      case 'entry_appended':
      case 'session_info_changed':
      case 'thinking_level_changed':
      case 'agent_end':
      case 'auto_retry_end':
      case 'tool_execution_update':
        return [{ t: 'heartbeat', source: 'stdout' }];
      case 'message_update': {
        const ev = obj(o.assistantMessageEvent);
        const et = str(ev.type);
        if (et === 'text_delta' && str(ev.delta)) return [{ t: 'text', channel: 'assistant', delta: str(ev.delta)! }];
        if (et === 'thinking_delta' && str(ev.delta)) return [{ t: 'text', channel: 'thinking', delta: str(ev.delta)! }];
        if (et === 'error') lastErr = str(ev.error) ?? str(obj(ev.error).message) ?? 'provider error';
        return [{ t: 'heartbeat', source: 'partial' }];
      }
      case 'message_end': {
        const m = obj(o.message);
        if (m.role === 'assistant') {
          lastStop = str(m.stopReason) ?? lastStop;
          if (str(m.errorMessage)) lastErr = str(m.errorMessage);
          // usage 是“这条 assistant 回复”的值，不是全 run 累计：逐条记 delta
          if (m.usage) {
            const u = obj(m.usage);
            const cost = obj(u.cost);
            return [
              {
                t: 'usage',
                input: num(u.input),
                cachedInput: num(u.cacheRead),
                cacheWrite: num(u.cacheWrite),
                output: num(u.output),
                ...(optNum(cost.total) !== undefined ? { costUsd: optNum(cost.total)! } : {}),
                costSource: optNum(cost.totalFromProvider) !== undefined ? 'harness' : 'computed',
                scope: 'delta',
              },
            ];
          }
        }
        return [{ t: 'heartbeat', source: 'stdout' }];
      }
      case 'tool_execution_start': {
        const id = String(o.toolCallId ?? '');
        const name = str(o.toolName) ?? 'unknown';
        const ev = toolCallEvent(id, name, o.args);
        calls.set(id, { name, paths: ev.t === 'tool_call' ? (ev.paths ?? []) : [] });
        return [ev];
      }
      case 'tool_execution_end': {
        const id = String(o.toolCallId ?? '');
        const ok = o.isError !== true;
        const out: NEventBody[] = [{ t: 'tool_result', id, ok }];
        const c = calls.get(id);
        if (c) {
          const kind = toolKindOf(c.name);
          if (kind === 'write' || kind === 'edit') for (const p of c.paths) out.push({ t: 'file_change', path: p, op: kind === 'write' ? 'add' : 'update', ok });
        }
        return out;
      }
      case 'compaction_start':
        return [{ t: 'compaction' }];
      case 'compaction_end':
        return [{ t: 'heartbeat', source: 'stdout' }];
      case 'auto_retry_start':
        return [{ t: 'retry', attempt: num(o.attempt), ...(optNum(o.delayMs) !== undefined ? { delayMs: optNum(o.delayMs)! } : {}), cls: classifyText(str(o.errorMessage) ?? '') ?? 'unknown' }];
      case 'agent_settled': {
        const out: NEventBody[] = [];
        const aborted = o.aborted === true;
        if (lastErr) out.push(errorEvent(classifyText(lastErr) ?? 'unknown', lastErr));
        const bad = lastStop === 'error' || lastStop === 'aborted' || lastStop === 'length';
        out.push({
          t: 'result',
          status: aborted ? 'cancelled' : bad ? (lastStop === 'length' ? 'error' : 'error') : 'success',
          ...(lastStop ? { stopReason: lastStop } : {}),
          ...(sessionId ? { sessionId } : {}),
        });
        if (lastStop === 'length') out.splice(out.length - 1, 0, errorEvent('context_overflow', 'stopReason=length'));
        return out;
      }
      default:
        return arr(o.messages).length ? [{ t: 'heartbeat', source: 'stdout' }] : undefined;
    }
  });
}

/** `pi --list-models`：表头 + 列 provider / model / context …，取前两列拼 provider/model */
export function parsePiModels(out: string): string[] {
  const models: string[] = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    const [provider, model] = cols;
    if (!provider || !model || /^provider$/i.test(provider) || /^(fetching|available|loading|warning|error|usage)/i.test(provider)) continue;
    models.push(`${provider}/${model}`);
  }
  return [...new Set(models)];
}

export const piAdapter: HarnessAdapter = {
  id: 'pi',
  displayName: 'pi',
  vendor: 'mixed',
  supportedVersions: '>=1.5.0',
  defaults: DEFAULTS,
  authMethods: (): AuthMethodSpec[] => [
    {
      mode: 'api_key',
      label: 'Provider API key（ANTHROPIC/OPENAI/DEEPSEEK/XAI/GEMINI/OPENROUTER… 任选）',
      env: [
        { name: 'OPENROUTER_API_KEY', secret: true, required: false },
        { name: 'DEEPSEEK_API_KEY', secret: true, required: false },
        { name: 'OPENAI_API_KEY', secret: true, required: false },
        { name: 'ANTHROPIC_API_KEY', secret: true, required: false },
        { name: 'GEMINI_API_KEY', secret: true, required: false },
        { name: 'XAI_API_KEY', secret: true, required: false },
      ],
      files: [{ relPath: '.pi/agent/models.json', part: 'config', hint: '可选：自定义 provider（baseUrl / api / models）' }],
      login: null,
      riskNote: RISK_NOTES.api_key_billing?.text,
      allowsCustomModels: true,
    },
    {
      mode: 'subscription_login',
      label: '网页交互登录（pi TUI 的 /login；未在本机实测）',
      env: [],
      files: [{ relPath: '.pi/agent/auth.json', part: 'state' }],
      login: { argv: ['pi'], hint: '在输入框依次输入 /login 并按提示选择 provider；无头环境需粘贴回调 URL；完成后输入 /quit' },
      riskNote: '订阅凭据经第三方 harness 使用的条款依据未核实（高风险），默认不建议。',
      allowsCustomModels: true,
    },
    {
      mode: 'credential_file',
      label: '上传 auth.json（在 CLI 中 /login 一次后复用；Anthropic 订阅不可用于第三方 harness）',
      env: [],
      files: [{ relPath: '.pi/agent/auth.json', part: 'state' }],
      login: null,
      riskNote: '订阅凭据经第三方 harness 使用的条款依据未核实（高风险），默认不建议。',
      allowsCustomModels: true,
    },
  ],
  async detect(harnessDir) {
    return detectBin(['pi'], harnessDir);
  },
  async listModels(acct, inst) {
    const env = minimalEnv(inst.binPath, { HOME: acct.home, PI_CODING_AGENT_DIR: path.join(acct.home, '.pi', 'agent'), PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', ...acct.secretEnv });
    const r = await runShort({ argv: [inst.binPath, '--list-models'], env, cwd: acct.home, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 30_000);
    const listed = r.code === 0 ? parsePiModels(r.stdout) : [];
    return [...new Set([...listed, ...(acct.customModels ?? [])])];
  },
  async prepareHome(acct): Promise<HomeLayout> {
    const AD = path.join(acct.home, '.pi', 'agent');
    return {
      home: acct.home,
      configFiles: [],
      stateDirs: [path.join(acct.home, '.pi')],
      env: { HOME: acct.home, PI_CODING_AGENT_DIR: AD, PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' },
    };
  },
  materialize: (spec, compiled, caps, ctx) => materializeVia('pi', spec, compiled, caps, ctx?.home),
  buildInvocation(spec, _caps, home, mat, acct, inst) {
    const argv = [inst.binPath, '--mode', 'json', '--approve', '--model', spec.model];
    const eff = effortOf(spec, EFFORTS);
    if (eff) argv.push('--thinking', eff);
    if (spec.session.mode === 'fork') argv.push('--fork', spec.session.id, '--session-id', `nv-${spec.runId}`);
    else argv.push('--session-id', spec.session.mode === 'resume' ? spec.session.id : `nv-${spec.session.id || spec.runId}`);
    argv.push('--tools', 'read,write,edit,grep,find,ls', '--no-mcp');
    argv.push(...mat.argv);
    argv.push(...filterExtraArgs(spec.extraArgs, DENY_EXTRA));
    argv.push(`阅读并执行工作单 ${spec.workOrderFile}（先完整读取该文件）。Read ${spec.workOrderFile} and execute it.`);
    const env = buildEnv(spec, inst, acct.secretEnv, home.env, mat.env);
    return invocation(spec, argv, env, 'devnull', [
      { signal: 'SIGINT', graceMs: 10_000 },
      { signal: 'SIGTERM', graceMs: 10_000 },
    ], { readPaths: [acct.home], writePaths: home.stateDirs });
  },
  createParser: () => createPiParser(),
  classify(exit, events: NEvent[], stderrTail) {
    return buildOutcome(exit, events, stderrTail, {
      completed: (x, evs) => {
        const r = [...evs].reverse().find((e) => e.t === 'result');
        return x.code === 0 && r?.t === 'result' && r.status === 'success';
      },
    });
  },
  loginCommand(acct, inst, mode) {
    if (mode !== 'subscription_login') return null;
    return {
      argv: [inst.binPath, '--no-mcp'],
      env: minimalEnv(inst.binPath, { HOME: acct.home, PI_CODING_AGENT_DIR: path.join(acct.home, '.pi', 'agent'), PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' }),
      cwd: acct.home,
      tty: true,
      urlPattern: /https:\/\/\S+/,
      successFiles: ['.pi/agent/auth.json'],
      credentialFiles: [{ relPath: '.pi/agent/auth.json', part: 'state' }],
    };
  },
  async probe(inst, acct, ctx) {
    return standardProbe(this, inst, acct, ctx, {
      helpArgv: [['--help']],
      requiredFlags: ['--mode', '--approve', '--model', '--session-id', '--tools', '--no-mcp', '--append-system-prompt'],
      env: { PI_CODING_AGENT_DIR: path.join(acct.home, '.pi', 'agent'), PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
    });
  },
};
