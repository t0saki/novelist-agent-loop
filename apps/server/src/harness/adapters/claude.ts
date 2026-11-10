/**
 * Claude Code adapter。Owner: lane A。
 * 事实来源（flags、事件格式、坑）：docs/v2/research/h_claude-code.md —— 写代码前先读，不要发明 flag。
 * DESIGN：§3.3（成功判定）、§3.5（命令模板）、§3.6（home 布局与并发）、§3.7（认证模式）。
 * 认证（D5）：subscription_login（claude /login 或 claude setup-token，网页交互登录）、oauth_token（CLAUDE_CODE_OAUTH_TOKEN）、custom_api（ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN，自定义模型名）。订阅模式下断言 env 无 ANTHROPIC_API_KEY；绝不加 --bare。
 *
 * 本机 2.1.319 已核实的 flag：-p --output-format stream-json --verbose --include-partial-messages --session-id --resume --fork-session
 * --model --effort --permission-mode acceptEdits --permission-prompts none --tools --disallowedTools --setting-sources --strict-mcp-config
 * --mcp-config --settings --append-system-prompt-file（隐藏）--system-prompt-file（隐藏）--json-schema --max-turns（隐藏）--max-budget-usd
 * --no-session-persistence --add-dir。登录：`claude auth login --claudeai`（管道可用，凭据写 $CLAUDE_CONFIG_DIR/.credentials.json）；
 * `claude setup-token`（Ink，需要 TTY → script 包装，输出 sk-ant-oat01-… 一年期 token）。
 */
import path from 'node:path';
import type { AuthMethodSpec, NEvent, NEventBody } from '@novelist/shared';
import { RISK_NOTES } from '@novelist/shared';
import { buildOutcome, classifyText } from '../classify.js';
import { arr, errorEvent, ndjsonParser, num, obj, optNum, str, toIso } from '../events.js';
import { runShort } from '../runner.js';
import type { CapabilityDefaults, HarnessAdapter, HomeLayout } from '../types.js';
import {
  authConfigError,
  buildEnv,
  detectBin,
  effortOf,
  filterExtraArgs,
  invocation,
  minimalEnv,
  standardProbe,
  toolCallEvent,
} from './common.js';

const DEFAULTS: CapabilityDefaults = {
  structuredOutput: 'native',
  schemaDialect: 'strict',
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
  stopHook: 'unverified',
  mcpHttp: 'unverified',
  exitZeroOnFailure: false,
  quotaSignal: 'inline',
};

export const CC_KNOWN_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SUBSCRIPTION_MODES = new Set(['subscription_login', 'oauth_token']);

/** run 中禁止透传的 extra_args（会破坏隔离或计费断言） */
const DENY_EXTRA = [/^--bare$/, /^--dangerously-skip-permissions$/, /^--allow-dangerously-skip-permissions$/, /^--setting-sources/, /^--settings/, /^--add-dir/, /^--permission-mode/, /^--mcp-config/];

function mapApiError(e: unknown): import('@novelist/shared').ErrorClass {
  switch (String(e ?? '')) {
    case 'authentication_failed':
      return 'auth';
    case 'rate_limit':
      return 'rate_limit';
    case 'overloaded':
    case 'server_error':
      return 'overloaded';
    case 'billing_error':
      return 'billing';
    case 'model_not_found':
      return 'model_unavailable';
    case 'max_output_tokens':
      return 'context_overflow';
    default:
      return 'unknown';
  }
}

function rateWindow(t: string): '5h' | '7d' | 'daily' | 'minute' | 'other' {
  if (/five_hour|5h/.test(t)) return '5h';
  if (/seven_day|7d|week/.test(t)) return '7d';
  if (/day/.test(t)) return 'daily';
  if (/minute/.test(t)) return 'minute';
  return 'other';
}
function rateStatus(s: string): 'allowed' | 'warning' | 'rejected' {
  if (s === 'rejected') return 'rejected';
  if (/warning/.test(s)) return 'warning';
  return 'allowed';
}

/** cc stream-json → NEvent（parser 在测试中用 fixture 回放） */
export function createClaudeParser(): import('../types.js').StreamParser {
  const toolUses = new Map<string, { name: string; paths: string[] }>();
  let sawResult = false;
  return ndjsonParser((o) => {
    const type = str(o.type);
    switch (type) {
      case 'system': {
        const sub = str(o.subtype);
        if (sub === 'init') {
          const mem = o.memory_paths;
          const memoryPaths = Array.isArray(mem) ? mem.filter((x): x is string => typeof x === 'string') : Object.values(obj(mem)).filter((x): x is string => typeof x === 'string');
          return [
            {
              t: 'init',
              ...(str(o.session_id) ? { sessionId: str(o.session_id)! } : {}),
              ...(str(o.model) ? { model: str(o.model)! } : {}),
              ...(str(o.claude_code_version) ? { version: str(o.claude_code_version)! } : {}),
              tools: arr(o.tools).filter((x): x is string => typeof x === 'string'),
              memoryPaths,
              mcp: arr(o.mcp_servers).map((m) => ({ name: String(obj(m).name ?? ''), ok: obj(m).status === 'connected' })),
              ...(str(o.apiKeySource) ? { authSource: str(o.apiKeySource)! } : {}),
            },
          ];
        }
        if (sub === 'api_retry') {
          return [{ t: 'retry', attempt: num(o.attempt), ...(optNum(o.retry_delay_ms) !== undefined ? { delayMs: optNum(o.retry_delay_ms)! } : {}), cls: mapApiError(o.error) }];
        }
        if (sub === 'compact_boundary') return [{ t: 'compaction' }];
        if (sub === 'permission_denied') {
          const input = obj(o.tool_input);
          const p = str(input.file_path) ?? str(input.path);
          return [{ t: 'denial', tool: str(o.tool_name) ?? str(o.tool) ?? 'unknown', ...(p ? { path: p } : {}), ...(str(o.reason) ? { detail: str(o.reason)! } : {}) }];
        }
        return [{ t: 'heartbeat', source: 'stdout' }];
      }
      case 'assistant': {
        const out: NEventBody[] = [];
        for (const b of arr(obj(o.message).content)) {
          const blk = obj(b);
          if (blk.type === 'text' && str(blk.text)) out.push({ t: 'text', channel: 'assistant', delta: str(blk.text)! });
          else if (blk.type === 'thinking' && str(blk.thinking)) out.push({ t: 'text', channel: 'thinking', delta: str(blk.thinking)! });
          else if (blk.type === 'tool_use') {
            const id = String(blk.id ?? '');
            const name = String(blk.name ?? 'unknown');
            const ev = toolCallEvent(id, name, blk.input);
            toolUses.set(id, { name, paths: ev.t === 'tool_call' ? (ev.paths ?? []) : [] });
            out.push(ev);
            if (name === 'Agent' || name === 'Task') out.push({ t: 'subagent', id, phase: 'start', ...(str(obj(blk.input).subagent_type) ? { role: str(obj(blk.input).subagent_type)! } : {}) });
          }
        }
        return out.length ? out : [{ t: 'heartbeat', source: 'stdout' }];
      }
      case 'user': {
        const out: NEventBody[] = [];
        for (const b of arr(obj(o.message).content)) {
          const blk = obj(b);
          if (blk.type !== 'tool_result') continue;
          const id = String(blk.tool_use_id ?? '');
          const isErr = blk.is_error === true;
          const content = typeof blk.content === 'string' ? blk.content : arr(blk.content).map((c) => str(obj(c).text) ?? '').join('');
          out.push({ t: 'tool_result', id, ok: !isErr, ...(isErr ? { error: content.slice(0, 1000) } : {}) });
          const tu = toolUses.get(id);
          if (tu && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tu.name)) {
            for (const p of tu.paths) out.push({ t: 'file_change', path: p, op: tu.name === 'Write' && /created/i.test(content) ? 'add' : 'update', ok: !isErr });
          }
          if (tu && (tu.name === 'Agent' || tu.name === 'Task')) out.push({ t: 'subagent', id, phase: 'stop' });
          if (isErr && /permission|denied|not allowed/i.test(content) && tu) out.push({ t: 'denial', tool: tu.name, ...(tu.paths[0] ? { path: tu.paths[0] } : {}), detail: content.slice(0, 300) });
        }
        return out.length ? out : [{ t: 'heartbeat', source: 'stdout' }];
      }
      case 'rate_limit_event': {
        const info = obj(o.rate_limit_info);
        const out: NEventBody[] = [];
        const windows = obj(info.unifiedWindows);
        const keys = Object.keys(windows);
        if (keys.length) {
          for (const k of keys) {
            const w = obj(windows[k]);
            const resetsAt = toIso(w.resetsAt ?? info.resetsAt);
            out.push({
              t: 'rate_limit',
              window: rateWindow(k),
              ...(optNum(w.utilization) !== undefined ? { utilization: optNum(w.utilization)! } : {}),
              ...(resetsAt ? { resetsAt } : {}),
              // 窗口自带 status 优先；没有时只有 rateLimitType 指向的那个窗口才继承顶层 status
              status: rateStatus(String(w.status ?? (k === info.rateLimitType ? info.status : undefined) ?? 'allowed')),
            });
          }
        } else {
          const resetsAt = toIso(info.resetsAt);
          out.push({
            t: 'rate_limit',
            window: rateWindow(String(info.rateLimitType ?? '')),
            ...(optNum(info.utilization) !== undefined ? { utilization: optNum(info.utilization)! } : {}),
            ...(resetsAt ? { resetsAt } : {}),
            status: rateStatus(String(info.status ?? 'allowed')),
          });
        }
        return out;
      }
      case 'stream_event':
        return [{ t: 'heartbeat', source: 'partial' }];
      case 'result': {
        sawResult = true;
        const out: NEventBody[] = [];
        const u = obj(o.usage);
        const mu = obj(o.modelUsage);
        const models = Object.values(mu).map(obj);
        const sum = (k: string) => models.reduce((a, m) => a + num(m[k]), 0);
        const usage: NEventBody = models.length
          ? {
              t: 'usage',
              input: sum('inputTokens'),
              cachedInput: sum('cacheReadInputTokens'),
              cacheWrite: sum('cacheCreationInputTokens'),
              output: sum('outputTokens'),
              reasoning: sum('thinkingTokens'),
              ...(optNum(o.total_cost_usd) !== undefined ? { costUsd: optNum(o.total_cost_usd)! } : {}),
              costSource: 'harness',
              scope: 'total',
            }
          : {
              t: 'usage',
              input: num(u.input_tokens),
              cachedInput: num(u.cache_read_input_tokens),
              cacheWrite: num(u.cache_creation_input_tokens),
              output: num(u.output_tokens),
              reasoning: num(obj(u.output_tokens_details).thinking_tokens),
              ...(optNum(o.total_cost_usd) !== undefined ? { costUsd: optNum(o.total_cost_usd)! } : {}),
              costSource: 'harness',
              scope: 'total',
            };
        out.push(usage);
        for (const d of arr(o.permission_denials)) {
          const dd = obj(d);
          const input = obj(dd.tool_input);
          const p = str(input.file_path) ?? str(input.path);
          out.push({ t: 'denial', tool: str(dd.tool_name) ?? 'unknown', ...(p ? { path: p } : {}) });
        }
        const subtype = str(o.subtype) ?? '';
        const stop = str(o.stop_reason);
        // result 字段只在成功时存在；错误时文本在 errors[]（实测 2.1.319 的 error_during_execution）
        const errs = arr(o.errors).filter((x): x is string => typeof x === 'string');
        const text = str(o.result) ?? (errs.length ? errs.join('\n') : undefined);
        let status: Extract<NEventBody, { t: 'result' }>['status'] = 'error';
        if (subtype === 'success' && !o.is_error) status = stop === 'refusal' ? 'refusal' : 'success';
        else if (subtype === 'error_max_turns') status = 'max_turns';
        else if (stop === 'refusal') status = 'refusal';
        if (subtype === 'error_max_budget_usd') out.push(errorEvent('budget', 'max budget exceeded', false));
        if (subtype === 'error_max_structured_output_retries') out.push(errorEvent('output_contract', text ?? 'structured output retries exhausted'));
        const apiStatus = optNum(o.api_error_status);
        if (apiStatus === 401 || /login expired|please run \/login|invalid api key|oauth token/i.test(text ?? '')) out.push(errorEvent('auth', text ?? `HTTP ${apiStatus}`, false));
        else if (apiStatus === 429) out.push(errorEvent('rate_limit', text ?? 'HTTP 429', true));
        else if (apiStatus === 529 || apiStatus === 503) out.push(errorEvent('overloaded', text ?? `HTTP ${apiStatus}`, true));
        else if (apiStatus === 402) out.push(errorEvent('billing', text ?? 'HTTP 402', false));
        else if (apiStatus === undefined && status === 'error' && text) {
          const cls = classifyText(text);
          if (cls) out.push(errorEvent(cls, text, false));
        }
        out.push({
          t: 'result',
          status,
          ...(stop ? { stopReason: stop } : str(o.terminal_reason) ? { stopReason: str(o.terminal_reason)! } : {}),
          ...(str(o.session_id) ? { sessionId: str(o.session_id)! } : {}),
          ...(o.structured_output !== undefined ? { structured: o.structured_output } : {}),
          ...(optNum(o.num_turns) !== undefined ? { turns: optNum(o.num_turns)! } : {}),
          ...(text ? { text: text.slice(0, 4000) } : {}),
        });
        return out;
      }
      case 'prompt_suggestion':
      case 'keep_alive':
      case 'control_response':
        return [{ t: 'heartbeat', source: 'stdout' }];
      default:
        return sawResult ? [{ t: 'heartbeat', source: 'stdout' }] : undefined;
    }
  });
}

/** 账号认证模式 → 需要的 env 校验（D5） */
function checkAuthEnv(mode: string, env: Record<string, string>): void {
  if (SUBSCRIPTION_MODES.has(mode)) {
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)
      throw authConfigError('订阅模式下账号 env 不得包含 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN（-p 模式下它们优先于 OAuth，会静默切到 API 计费）');
    if (mode === 'oauth_token' && !env.CLAUDE_CODE_OAUTH_TOKEN) throw authConfigError('oauth_token 模式需要 CLAUDE_CODE_OAUTH_TOKEN（claude setup-token 生成）');
  } else if (mode === 'custom_api') {
    if (!env.ANTHROPIC_BASE_URL) throw authConfigError('custom_api 模式需要 ANTHROPIC_BASE_URL');
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) throw authConfigError('custom_api 模式需要 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN');
  } else if (mode === 'api_key') {
    if (!env.ANTHROPIC_API_KEY) throw authConfigError('api_key 模式需要 ANTHROPIC_API_KEY');
  }
}

export const claudeAdapter: HarnessAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  vendor: 'anthropic',
  supportedVersions: '>=2.1.293',
  defaults: DEFAULTS,
  devModel: 'claude-haiku-5-5',
  authMethods: (): AuthMethodSpec[] => [
    {
      mode: 'subscription_login',
      label: '订阅登录（claude auth login，网页交互）',
      env: [],
      files: [{ relPath: '.claude/.credentials.json', part: 'state', hint: '也可上传本机 ~/.claude/.credentials.json（不要直接共用 owner 正在用的目录）' }],
      login: { argv: ['claude', 'auth', 'login', '--claudeai'], hint: '打开链接登录后，把页面上的授权码粘贴到输入框' },
      riskNote: RISK_NOTES.cc_subscription_unattended?.text,
      allowsCustomModels: false,
    },
    {
      mode: 'oauth_token',
      label: '订阅长期 token（CLAUDE_CODE_OAUTH_TOKEN，claude setup-token 生成，一年有效）',
      env: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', secret: true, required: true, hint: 'sk-ant-oat01-…；可在网页“交互登录”里运行 setup-token 自动捕获' }],
      files: [],
      login: { argv: ['claude', 'setup-token'], hint: '运行 setup-token，登录后 token 自动加密保存到本账号' },
      riskNote: RISK_NOTES.cc_subscription_unattended?.text,
      allowsCustomModels: false,
    },
    {
      mode: 'custom_api',
      label: '自定义 API 网关（ANTHROPIC_BASE_URL + key/token，自定义模型名）',
      env: [
        { name: 'ANTHROPIC_BASE_URL', secret: false, required: true, hint: '网关需兼容 Anthropic Messages API' },
        { name: 'ANTHROPIC_API_KEY', secret: true, required: false, hint: 'x-api-key 方式（与 AUTH_TOKEN 二选一）' },
        { name: 'ANTHROPIC_AUTH_TOKEN', secret: true, required: false, hint: 'Bearer 方式（与 API_KEY 二选一）' },
        { name: 'ANTHROPIC_CUSTOM_HEADERS', secret: false, required: false, hint: '可选：额外请求头（Name: value，每行一个）' },
        { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', secret: false, required: false, hint: '可选：网关上 haiku 档对应的模型名' },
      ],
      files: [],
      login: null,
      riskNote: RISK_NOTES.api_key_billing?.text,
      allowsCustomModels: true,
      requireOneOf: [['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']],
    },
    {
      mode: 'api_key',
      label: 'Anthropic 官方 API key',
      env: [{ name: 'ANTHROPIC_API_KEY', secret: true, required: true }],
      files: [],
      login: null,
      riskNote: RISK_NOTES.api_key_billing?.text,
      allowsCustomModels: false,
    },
  ],
  async detect(harnessDir) {
    return detectBin(['claude'], harnessDir);
  },
  async listModels(acct) {
    const custom = acct.customModels ?? [];
    if (acct.authMode === 'custom_api') return [...new Set([...custom, ...CC_KNOWN_MODELS])];
    return [...new Set([...CC_KNOWN_MODELS, ...custom])];
  },
  async prepareHome(acct, _inst, spec): Promise<HomeLayout> {
    const H = acct.home;
    const settings = {
      permissions: {
        // 写入只允许工作目录（cwd=$RUN/book 与 --add-dir）；$RUN/in 另加 deny
        blockWritesOutsideWorkingDirectories: true,
        // container 档没有 OS 级读边界：Read/Glob/Grep 限制在工作目录（cwd=$RUN/book 与 --add-dir $RUN/in）内
        blockReadsOutsideWorkingDirectories: true,
        deny: [`Write(/${spec.inDir}/**)`, `Edit(/${spec.inDir}/**)`, 'Write(.git/**)', 'Edit(.git/**)'],
      },
      cleanupPeriodDays: 14,
      includeCoAuthoredBy: false,
    };
    return {
      home: H,
      configFiles: [{ path: path.join(spec.inDir, 'cc.adapter.settings.json'), content: JSON.stringify(settings, null, 2) }],
      stateDirs: [path.join(H, '.claude')],
      env: {
        HOME: H,
        CLAUDE_CONFIG_DIR: path.join(H, '.claude'),
        CLAUDE_CODE_PROJECT_DIR_NAME: spec.bookSlug ?? 'novelist',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_UPDATES: '1',
        CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      },
    };
  },
  buildInvocation(spec, _caps, home, acct, inst) {
    checkAuthEnv(acct.authMode, acct.secretEnv);
    // 指令在 cwd（书快照）的 CLAUDE.md → @AGENTS.md；这里只传 adapter 的权限设置
    const settingsPath = home.configFiles.find((f) => f.path.endsWith('cc.adapter.settings.json'))?.path;
    const argv = [inst.binPath, '-p', '--output-format', 'stream-json', '--verbose'];
    if (spec.role === 'writer') argv.push('--include-partial-messages');
    if (spec.session.mode === 'fresh') argv.push('--session-id', spec.session.id || spec.runId);
    else {
      argv.push('--resume', spec.session.id);
      if (spec.session.mode === 'fork') argv.push('--fork-session');
    }
    argv.push('--model', spec.model);
    const eff = effortOf(spec, EFFORTS);
    if (eff) argv.push('--effort', eff);
    const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
    // 不开子代理
    const disallowed = ['Bash', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent', 'Task'];
    argv.push('--permission-mode', 'acceptEdits', '--permission-prompts', 'none');
    argv.push('--tools', tools.join(','), '--disallowedTools', disallowed.join(','));
    argv.push('--setting-sources', 'project', '--strict-mcp-config');
    if (settingsPath) argv.push('--settings', settingsPath);
    if (spec.limits.maxTurns > 0) argv.push('--max-turns', String(spec.limits.maxTurns));
    if (spec.limits.maxBudgetUsd && !SUBSCRIPTION_MODES.has(acct.authMode)) argv.push('--max-budget-usd', String(spec.limits.maxBudgetUsd));
    if (!spec.persistSession) argv.push('--no-session-persistence');
    argv.push('--add-dir', spec.inDir);
    argv.push(...filterExtraArgs(spec.extraArgs, DENY_EXTRA));
    const env = buildEnv(spec, inst, acct.secretEnv, home.env);
    if (SUBSCRIPTION_MODES.has(acct.authMode)) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      // 切换认证模式后残留的网关地址不能带走订阅 token
      delete env.ANTHROPIC_BASE_URL;
    } else if (acct.authMode === 'custom_api' || acct.authMode === 'api_key') {
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    return invocation(spec, argv, env, { file: spec.workOrderFile }, [
      { signal: 'SIGINT', graceMs: 30_000 },
      { signal: 'SIGTERM', graceMs: 15_000 },
    ], { readPaths: [acct.home], writePaths: home.stateDirs });
  },
  createParser: () => createClaudeParser(),
  classify(exit, events: NEvent[], stderrTail) {
    return buildOutcome(exit, events, stderrTail, {
      completed: (x, evs) => {
        const r = [...evs].reverse().find((e) => e.t === 'result');
        return x.code === 0 && r?.t === 'result' && r.status === 'success' && r.stopReason !== 'refusal';
      },
    });
  },
  async probe(inst, acct, ctx) {
    return standardProbe(this, inst, acct, ctx, {
      helpArgv: [['--help']],
      requiredFlags: ['--output-format', '--session-id', '--permission-mode', '--permission-prompts', '--tools', '--setting-sources', '--strict-mcp-config', '--json-schema', '--effort', '--no-session-persistence'],
      env: { CLAUDE_CONFIG_DIR: path.join(acct.home, '.claude') },
    });
  },
  async authCheck(acct, inst) {
    const env = minimalEnv(inst.binPath, { HOME: acct.home, CLAUDE_CONFIG_DIR: path.join(acct.home, '.claude'), ...acct.secretEnv });
    if (SUBSCRIPTION_MODES.has(acct.authMode)) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    const r = await runShort({ argv: [inst.binPath, 'auth', 'status'], env, cwd: acct.home, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 20_000);
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; loginExpiresAt?: string | null };
      if (j.loggedIn) return { ok: true, detail: `已登录（${j.authMethod ?? '?'}）${j.loginExpiresAt ? `，到期 ${j.loginExpiresAt}` : ''}` };
      if (acct.authMode === 'oauth_token' && acct.secretEnv.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, detail: '已配置 CLAUDE_CODE_OAUTH_TOKEN（auth status 不检查 env token）' };
      if (acct.authMode === 'custom_api' || acct.authMode === 'api_key') return { ok: true, detail: 'API 模式：凭据在 env 中，发送请求时校验' };
      return { ok: false, detail: '未登录' };
    } catch {
      return { ok: false, detail: (r.stderr || r.stdout).slice(0, 300) };
    }
  },
  loginCommand(acct, inst, mode) {
    const env = minimalEnv(inst.binPath, { HOME: acct.home, CLAUDE_CONFIG_DIR: path.join(acct.home, '.claude'), DISABLE_AUTOUPDATER: '1' });
    if (mode === 'oauth_token') {
      return {
        argv: [inst.binPath, 'setup-token'],
        env,
        cwd: acct.home,
        tty: true,
        urlPattern: /https:\/\/claude\.(com|ai)\/\S+/,
        captureEnv: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', pattern: /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/ }],
      };
    }
    if (mode === 'subscription_login') {
      return {
        argv: [inst.binPath, 'auth', 'login', '--claudeai'],
        env,
        cwd: acct.home,
        urlPattern: /https:\/\/claude\.(com|ai)\/\S+/,
        successFiles: ['.claude/.credentials.json'],
        credentialFiles: [{ relPath: '.claude/.credentials.json', part: 'state' }],
      };
    }
    return null;
  },
};
