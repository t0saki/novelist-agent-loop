/**
 * Grok Build adapter。Owner: lane A。
 * 事实来源（flags、事件格式、坑）：docs/v2/research/h_grok-build.md —— 写代码前先读，不要发明 flag。
 * DESIGN：§3.3（成功判定）、§3.5（命令模板）、§3.6（home 布局与并发）、§3.7（认证模式）。
 * 认证：subscription_login（grok login --device-auth）、credential_file（.grok/auth.json）、api_key（XAI_API_KEY；缓存 OAuth 优先于它）。本机未安装：研究副本在 scratchpad/grokhome。
 *
 * streaming-json（内置用户手册 14-headless-mode.md）：text{data} / thought{data} / tool_call{toolCallId,toolName,kind,status,rawInput,locations}
 * / tool_call_update{toolCallId,status,rawOutput} / usage{messageId,stopReason,usage}（每次模型响应一行，不要累加到 end）
 * / plan / available_commands / end{stopReason,sessionId,usage,num_turns,total_cost_usd} / error{message} / max_turns_reached / auto_compact_*。
 * -s/--session-id 必须是 UUID 且只能新建；--rules 追加系统提示（<human_rules>），--system-prompt-override 替换。
 * (verify) 项：--leader-socket、GROK_HOME 下 hooks/config 查找路径、read_file 能否读 gitignored 的 work/ —— 未核实，不使用。
 */
import path from 'node:path';
import type { AuthMethodSpec, NEvent, NEventBody } from '@novelist/shared';
import { buildOutcome, classifyText } from '../classify.js';
import { arr, errorEvent, ndjsonParser, num, obj, optNum, str } from '../events.js';
import { runShort } from '../runner.js';
import type { CapabilityDefaults, HarnessAdapter, HomeLayout, StreamParser } from '../types.js';
import { authConfigError, buildEnv, detectBin, effortOf, filterExtraArgs, invocation, materializeVia, minimalEnv, parseModelLines, readSchemaFile, standardProbe, toolCallEvent, toolKindOf, wantsSchema } from './common.js';

const DEFAULTS: CapabilityDefaults = {
  structuredOutput: 'native',
  schemaDialect: 'lenient',
  systemChannel: 'rules-arg',
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
  stopHook: 'unverified',
  mcpHttp: 'unverified',
  exitZeroOnFailure: true,
  quotaSignal: 'probe',
};
export const GROK_KNOWN_MODELS = ['grok-build', 'grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DENY_EXTRA = [/^--yolo$/, /^--sandbox/, /^--cwd/, /^--add-dir/, /^--trust$/, /^-w$/, /^--worktree/, /^--permission-mode/];

/** 关闭 grok 对 ~/.claude、~/.cursor 的兼容读取与记忆/网页/子代理（研究 §10 坑 3） */
export const GROK_ISOLATION_ENV: Record<string, string> = {
  GROK_DISABLE_AUTOUPDATER: '1',
  GROK_FOLDER_TRUST: '0',
  GROK_MEMORY: '0',
  GROK_WEB_FETCH: '0',
  GROK_SUBAGENTS: '0',
  GROK_EXIT_TIMEOUT_SECS: '20',
  ...Object.fromEntries(['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS'].flatMap((k) => [[`GROK_CLAUDE_${k}_ENABLED`, '0'], [`GROK_CURSOR_${k}_ENABLED`, '0']])),
};

export function createGrokParser(): StreamParser {
  const calls = new Map<string, { name: string; paths: string[] }>();
  let sessionId: string | undefined;
  return ndjsonParser((o) => {
    switch (str(o.type)) {
      case 'text':
        return str(o.data) ? [{ t: 'text', channel: 'assistant', delta: str(o.data)! }] : [{ t: 'heartbeat', source: 'stdout' }];
      case 'thought':
        return str(o.data) ? [{ t: 'text', channel: 'thinking', delta: str(o.data)! }] : [{ t: 'heartbeat', source: 'stdout' }];
      case 'tool_call': {
        const id = String(o.toolCallId ?? '');
        const name = str(o.toolName) ?? str(o.title) ?? 'unknown';
        const ev = toolCallEvent(id, name, { ...obj(o.rawInput), paths: arr(o.locations).map((l) => str(obj(l).path)).filter(Boolean) });
        calls.set(id, { name, paths: ev.t === 'tool_call' ? (ev.paths ?? []) : [] });
        const out: NEventBody[] = [ev];
        if (str(o.status) === 'completed' || str(o.status) === 'failed') out.push(...finishCall(id, str(o.status) === 'completed', o));
        return out;
      }
      case 'tool_call_update': {
        const id = String(o.toolCallId ?? '');
        const st = str(o.status);
        if (st === 'completed' || st === 'failed') return finishCall(id, st === 'completed', o);
        return [{ t: 'heartbeat', source: 'stdout' }];
      }
      case 'usage': {
        const u = obj(o.usage);
        return [
          {
            t: 'usage',
            input: num(u.input_tokens),
            cachedInput: num(u.cache_read_input_tokens),
            cacheWrite: num(u.cache_creation_input_tokens),
            output: num(u.output_tokens),
            reasoning: num(u.reasoning_tokens),
            costSource: 'unknown',
            scope: 'delta',
          },
        ];
      }
      case 'plan':
      case 'available_commands':
        return [{ t: 'heartbeat', source: 'stdout' }];
      case 'max_turns_reached':
        return [{ t: 'heartbeat', source: 'stdout' }];
      case 'end': {
        sessionId = str(o.sessionId) ?? sessionId;
        const u = obj(o.usage);
        const cost = optNum(o.total_cost_usd);
        const partial = o.cost_is_partial === true || o.usage_is_incomplete === true;
        const stop = str(o.stopReason) ?? '';
        const status: Extract<NEventBody, { t: 'result' }>['status'] =
          stop === 'end_turn' ? 'success' : stop === 'refusal' ? 'refusal' : stop === 'max_turn_requests' ? 'max_turns' : stop === 'cancelled' ? 'cancelled' : 'error';
        return [
          {
            t: 'usage',
            input: num(u.input_tokens),
            cachedInput: num(u.cache_read_input_tokens),
            cacheWrite: num(u.cache_creation_input_tokens),
            output: num(u.output_tokens),
            reasoning: num(u.reasoning_tokens),
            ...(cost !== undefined && !partial ? { costUsd: cost } : {}),
            costSource: cost !== undefined && !partial ? 'harness' : 'unknown',
            scope: 'total',
          },
          {
            t: 'result',
            status,
            stopReason: stop,
            ...(sessionId ? { sessionId } : {}),
            ...(o.structured_output !== undefined ? { structured: o.structured_output } : o.structured !== undefined ? { structured: o.structured } : {}),
            ...(optNum(o.num_turns) !== undefined ? { turns: optNum(o.num_turns)! } : {}),
          },
        ];
      }
      case 'error': {
        const msg = str(o.message) ?? 'error';
        sessionId = str(o.sessionId) ?? sessionId;
        return [errorEvent(classifyText(msg) ?? 'unknown', msg), { t: 'result', status: 'error', ...(sessionId ? { sessionId } : {}), text: msg.slice(0, 4000) }];
      }
      default: {
        const t = str(o.type) ?? '';
        if (t.startsWith('auto_compact')) return [{ t: 'compaction' }];
        return undefined;
      }
    }
  });

  function finishCall(id: string, ok: boolean, o: Record<string, unknown>): NEventBody[] {
    const c = calls.get(id);
    const out: NEventBody[] = [{ t: 'tool_result', id, ok, ...(!ok ? { error: JSON.stringify(o.rawOutput ?? '').slice(0, 500) } : {}) }];
    if (c) {
      const kind = toolKindOf(c.name);
      if (kind === 'write' || kind === 'edit') for (const p of c.paths) out.push({ t: 'file_change', path: p, op: kind === 'write' ? 'add' : 'update', ok });
      if (!ok && /permission|denied|not allowed/i.test(JSON.stringify(o.rawOutput ?? ''))) out.push({ t: 'denial', tool: c.name, ...(c.paths[0] ? { path: c.paths[0] } : {}) });
    }
    return out;
  }
}

export const grokAdapter: HarnessAdapter = {
  id: 'grok',
  displayName: 'Grok Build',
  vendor: 'xai',
  supportedVersions: '>=1.0.77',
  defaults: DEFAULTS,
  authMethods: (): AuthMethodSpec[] => [
    {
      mode: 'subscription_login',
      label: 'SuperGrok / X Premium+ 订阅登录（grok login --device-auth）',
      env: [],
      files: [{ relPath: '.grok/auth.json', part: 'state' }],
      login: { argv: ['grok', 'login', '--device-auth'], hint: '打开链接输入验证码；完成后自动登记' },
      allowsCustomModels: false,
    },
    {
      mode: 'credential_file',
      label: '上传 auth.json（已登录机器的 ~/.grok/auth.json）',
      env: [],
      files: [{ relPath: '.grok/auth.json', part: 'state' }],
      login: null,
      allowsCustomModels: false,
    },
    {
      mode: 'api_key',
      label: 'xAI API key（XAI_API_KEY）',
      env: [{ name: 'XAI_API_KEY', secret: true, required: true, hint: '注意：home 里若有缓存的 OAuth 登录，它优先于 API key' }],
      files: [],
      login: null,
      allowsCustomModels: false,
    },
  ],
  async detect(harnessDir) {
    return detectBin(['grok'], harnessDir);
  },
  async listModels(acct, inst) {
    const env = minimalEnv(inst.binPath, { HOME: acct.home, GROK_HOME: path.join(acct.home, '.grok'), ...GROK_ISOLATION_ENV, ...acct.secretEnv });
    const r = await runShort({ argv: [inst.binPath, 'models'], env, cwd: acct.home, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 30_000);
    const listed = r.code === 0 ? parseModelLines(r.stdout).filter((m) => /grok/i.test(m)) : [];
    return [...new Set([...(listed.length ? listed : GROK_KNOWN_MODELS), ...(acct.customModels ?? [])])];
  },
  async prepareHome(acct): Promise<HomeLayout> {
    const GH = path.join(acct.home, '.grok');
    return { home: acct.home, configFiles: [], stateDirs: [GH], env: { HOME: acct.home, GROK_HOME: GH, ...GROK_ISOLATION_ENV } };
  },
  materialize: (spec, compiled, caps, ctx) => materializeVia('grok', spec, compiled, caps, ctx?.home),
  buildInvocation(spec, caps, home, mat, acct, inst) {
    if (acct.authMode === 'api_key' && !acct.secretEnv.XAI_API_KEY) throw authConfigError('api_key 模式需要 XAI_API_KEY');
    const argv = [inst.binPath, '--no-auto-update', '--prompt-file', spec.workOrderFile, '--cwd', spec.bookDir, '--output-format', 'streaming-json', '-m', spec.model];
    const eff = effortOf(spec, EFFORTS);
    if (eff) argv.push('--reasoning-effort', eff);
    const disallowed = ['run_terminal_cmd', 'web_search', 'web_fetch'];
    if (!spec.subagents) disallowed.push('task');
    argv.push('--always-approve', '--disallowed-tools', disallowed.join(','), '--disable-web-search', '--no-wait-for-background');
    if (!spec.subagents) argv.push('--no-subagents');
    if (spec.limits.maxTurns > 0) argv.push('--max-turns', String(spec.limits.maxTurns));
    if (spec.session.mode === 'fresh') argv.push('-s', spec.session.id || spec.runId);
    else {
      argv.push('-r', spec.session.id);
      if (spec.session.mode === 'fork') argv.push('--fork-session');
    }
    if (wantsSchema(spec, caps)) {
      const schema = readSchemaFile(spec);
      if (schema) argv.push('--json-schema', schema);
    }
    argv.push(...mat.argv);
    argv.push(...filterExtraArgs(spec.extraArgs, DENY_EXTRA));
    const env = buildEnv(spec, inst, acct.secretEnv, home.env, mat.env);
    return invocation(spec, argv, env, 'devnull', [
      { signal: 'SIGINT', graceMs: 25_000 },
      { signal: 'SIGTERM', graceMs: 30_000 },
    ], { readPaths: [acct.home], writePaths: home.stateDirs });
  },
  createParser: () => createGrokParser(),
  classify(exit, events: NEvent[], stderrTail) {
    return buildOutcome(exit, events, stderrTail, {
      completed: (x, evs) => {
        const r = [...evs].reverse().find((e) => e.t === 'result');
        // 未授权时 exit 0：stderr 中的 permission required 视为失败
        return x.code === 0 && r?.t === 'result' && r.status === 'success' && !/permission required:/i.test(stderrTail);
      },
      exitCodeClass: (code) => (code === 130 || code === 143 ? 'harness_crash' : null),
    });
  },
  async probe(inst, acct, ctx) {
    return standardProbe(this, inst, acct, ctx, {
      helpArgv: [['--help']],
      requiredFlags: ['--prompt-file', '--output-format', '--always-approve', '--disallowed-tools', '--no-subagents', '--max-turns', '--rules'],
      env: { GROK_HOME: path.join(acct.home, '.grok'), ...GROK_ISOLATION_ENV },
    });
  },
  async quotaProbe(acct, inst) {
    const env = minimalEnv(inst.binPath, { HOME: acct.home, GROK_HOME: path.join(acct.home, '.grok'), ...GROK_ISOLATION_ENV });
    const r = await runShort({ argv: [inst.binPath, 'usage', '--json'], env, cwd: acct.home, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 30_000);
    try {
      const j = JSON.parse(r.stdout) as Record<string, unknown>;
      const pct = optNum(j.utilization) ?? optNum(j.usedPercent) ?? optNum(obj(j.weekly).utilization);
      return { ts: new Date().toISOString(), windows: [{ window: '7d', utilization: pct ?? null, resetsAt: str(j.resetsAt) ?? str(obj(j.weekly).resetsAt) ?? null }], raw: j };
    } catch {
      return null;
    }
  },
  loginCommand(acct, inst, mode) {
    if (mode !== 'subscription_login') return null;
    return {
      argv: [inst.binPath, 'login', '--device-auth'],
      env: minimalEnv(inst.binPath, { HOME: acct.home, GROK_HOME: path.join(acct.home, '.grok'), GROK_DISABLE_AUTOUPDATER: '1' }),
      cwd: acct.home,
      urlPattern: /https:\/\/\S+/,
      successFiles: ['.grok/auth.json'],
      credentialFiles: [{ relPath: '.grok/auth.json', part: 'state' }],
    };
  },
};
