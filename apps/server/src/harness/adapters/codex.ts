/**
 * Codex CLI adapter。Owner: lane A。
 * 事实来源（flags、事件格式、坑）：docs/v2/research/h_codex.md —— 写代码前先读，不要发明 flag。
 * DESIGN：§3.3（成功判定）、§3.5（命令模板）、§3.6（home 布局与并发）、§3.7（认证模式）。
 * 认证：subscription_login（codex login --device-auth）、credential_file（上传 .codex/auth.json，可刷新=state 部分）、api_key（CODEX_API_KEY）、custom_api（config.toml 自定义 provider，wire_api=responses）。本机 LXC 中 workspace-write 沙箱失败：一律 --dangerously-bypass-approvals-and-sandbox（隔离由外层负责）。developer_instructions 用 smol-toml 序列化。
 *
 * 本机 0.165.0 已核实：exec --json --color --skip-git-repo-check -C -m -c --dangerously-bypass-approvals-and-sandbox --output-schema -o --ephemeral；
 * config.toml 的 `memories.enabled` 是未知字段（--strict-config 报错，不写）；`agents.enabled`、`web_search`、`[features] multi_agent` 合法。
 * 事件：thread.started / turn.started / item.{started,updated,completed} / turn.completed{usage} / turn.failed / error。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthMethodSpec, NEvent, NEventBody } from '@novelist/shared';
import { RISK_NOTES } from '@novelist/shared';
import { stringify as tomlStringify } from 'smol-toml';
import { buildOutcome, classifyText } from '../classify.js';
import { arr, errorEvent, ndjsonParser, num, obj, str } from '../events.js';
import { runShort } from '../runner.js';
import type { CapabilityDefaults, HarnessAdapter, HomeLayout, RunSpec, StreamParser } from '../types.js';
import { isInside } from '../util.js';
import { authConfigError, buildEnv, detectBin, effortOf, filterExtraArgs, invocation, materializeVia, minimalEnv, standardProbe, toolCallEvent, wantsSchema } from './common.js';

const DEFAULTS: CapabilityDefaults = {
  structuredOutput: 'native',
  schemaDialect: 'strict',
  systemChannel: 'developer',
  systemReplace: true,
  shellTool: 'always',
  webTool: 'disableable',
  subagentTool: 'disableable',
  honorsHttpsProxy: true,
  workspaceDocLoaded: true,
  systemChannelLoaded: true,
  tailNonceSurvives: true,
  maxInstructionBytes: 100_000,
  sessionPreassign: false,
  resume: true,
  fork: true,
  stopHook: 'unverified',
  mcpHttp: 'unverified',
  exitZeroOnFailure: true,
  quotaSignal: 'error-only',
};

export const CODEX_KNOWN_MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-luna'];
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DENY_EXTRA = [/^-s$/, /^--sandbox/, /^--full-auto$/, /^-C$/, /^--cd/, /^--add-dir/, /^-p$/, /^--profile/, /^--ignore-user-config$/];
const CUSTOM_PROVIDER_ID = 'nv_custom';
const FILE_CHANGE_FAILED = 'file_change failed: ';

/**
 * 账号级 config.toml（§3.5 codex）：同账号并发 run 共享 $H/.codex，这里的内容必须与具体 run 无关，
 * 否则 run B 启动会改写文件，run A 结束时 postRunAudit 判 tamperedConfig。每 run 的差异走 -c 覆盖。只写本机核实过的键。
 */
export function codexConfigToml(acctEnv: Record<string, string>, authMode: string): string {
  const cfg: Record<string, unknown> = {
    project_doc_max_bytes: 262144,
    project_doc_fallback_filenames: [],
    web_search: 'disabled',
    cli_auth_credentials_store: 'file',
  };
  if (authMode === 'custom_api') {
    cfg.model_provider = CUSTOM_PROVIDER_ID;
    cfg.model_providers = {
      [CUSTOM_PROVIDER_ID]: {
        name: acctEnv.CODEX_PROVIDER_NAME || CUSTOM_PROVIDER_ID,
        base_url: acctEnv.OPENAI_BASE_URL ?? '',
        wire_api: 'responses',
        env_key: 'OPENAI_API_KEY',
      },
    };
  }
  cfg.features = { image_generation: false };
  return `# Novelist 每 run 生成；run 后 hash 校验，请勿手改\n${tomlStringify(cfg)}\n`;
}

/** 严格模式不接受的关键字（本机自定义 provider 实测 propertyNames 报 invalid_json_schema） */
const STRICT_UNSUPPORTED = ['$schema', 'propertyNames', 'patternProperties', 'unevaluatedProperties', 'minProperties', 'maxProperties', 'default'];

function isFreeFormObject(n: Record<string, unknown>): boolean {
  const type = n.type;
  const isObj = type === 'object' || (Array.isArray(type) && type.includes('object'));
  const ap = n.additionalProperties;
  return isObj && n.properties === undefined && (ap === true || (typeof ap === 'object' && ap !== null));
}

function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) if (!STRICT_UNSUPPORTED.includes(k)) out[k] = k === 'properties' ? v : strictNode(v);
  if (isFreeFormObject(out)) return { ...out, properties: {}, required: [], additionalProperties: false };
  if (out.properties && typeof out.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.properties as Record<string, unknown>)) {
      // 自由键的 record 在严格模式下无法表达：从 schema 中去掉（receipt.json 文件才是权威产物，这里只是遥测）
      if (typeof v === 'object' && v !== null && isFreeFormObject(v as Record<string, unknown>)) continue;
      props[k] = strictNode(v);
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/** 把 receipt schema 收窄成 codex --output-schema 能接受的严格子集；非法 JSON 返回 null */
export function codexOutputSchema(raw: string): string | null {
  try {
    return JSON.stringify(strictNode(JSON.parse(raw)), null, 2);
  } catch {
    return null;
  }
}

export function createCodexParser(spec: Pick<RunSpec, 'outDir'>): StreamParser {
  let lastMessage = '';
  let threadId: string | undefined;
  return ndjsonParser((o) => {
    const type = str(o.type);
    switch (type) {
      case 'thread.started':
        threadId = str(o.thread_id);
        return [{ t: 'init', ...(threadId ? { sessionId: threadId } : {}) }];
      case 'turn.started':
        return [{ t: 'heartbeat', source: 'stdout' }];
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const it = obj(o.item);
        const id = String(it.id ?? '');
        const itype = str(it.type);
        const done = type === 'item.completed';
        const started = type === 'item.started';
        switch (itype) {
          case 'agent_message':
            if (!done) return [{ t: 'heartbeat', source: 'stdout' }];
            lastMessage = str(it.text) ?? '';
            return [{ t: 'text', channel: 'assistant', delta: lastMessage }];
          case 'reasoning':
            return done && str(it.text) ? [{ t: 'text', channel: 'thinking', delta: str(it.text)! }] : [{ t: 'heartbeat', source: 'stdout' }];
          case 'command_execution': {
            if (started) return [toolCallEvent(id, 'shell', {}, str(it.command))];
            if (!done) return [{ t: 'heartbeat', source: 'stdout' }];
            const status = str(it.status);
            const out: NEventBody[] = [{ t: 'tool_result', id, ok: status === 'completed' && num(it.exit_code) === 0, ...(status !== 'completed' ? { error: status ?? 'failed' } : {}) }];
            if (status === 'declined') out.push({ t: 'denial', tool: 'shell', detail: str(it.command)?.slice(0, 300) ?? '' });
            return out;
          }
          case 'file_change': {
            const changes = arr(it.changes).map(obj);
            if (started) return [{ t: 'tool_call', id, name: 'apply_patch', kind: 'edit', paths: changes.map((c) => String(c.path ?? '')) }];
            if (!done) return [{ t: 'heartbeat', source: 'stdout' }];
            const ok = str(it.status) === 'completed';
            const out: NEventBody[] = [{ t: 'tool_result', id, ok }];
            for (const c of changes) {
              const p = String(c.path ?? '');
              const kind = str(c.kind);
              out.push({ t: 'file_change', path: p, op: kind === 'add' ? 'add' : kind === 'delete' ? 'delete' : 'update', ok });
              // #46246：沙箱写入失败仍 exit 0 —— outDir 内的失败先记下，最终裁决在 postCheck（同路径后续写成功就不算）
              if (!ok && spec.outDir && isInside(path.resolve(p), spec.outDir)) out.push(errorEvent('sandbox', `${FILE_CHANGE_FAILED}${p}`, false));
            }
            return out;
          }
          case 'mcp_tool_call':
            if (started) return [{ t: 'tool_call', id, name: `${str(it.server) ?? 'mcp'}__${str(it.tool) ?? '?'}`, kind: 'mcp' }];
            return done ? [{ t: 'tool_result', id, ok: str(it.status) !== 'failed' }] : [{ t: 'heartbeat', source: 'stdout' }];
          case 'collab_tool_call':
            if (started) return [{ t: 'subagent', id, phase: 'start', ...(str(it.tool) ? { role: str(it.tool)! } : {}) }];
            return done ? [{ t: 'subagent', id, phase: 'stop' }] : [{ t: 'heartbeat', source: 'stdout' }];
          case 'web_search':
            if (started) return [{ t: 'tool_call', id, name: 'web_search', kind: 'web' }];
            return done ? [{ t: 'tool_result', id, ok: true }] : [{ t: 'heartbeat', source: 'stdout' }];
          case 'todo_list':
            return [{ t: 'heartbeat', source: 'stdout' }];
          case 'error': {
            const msg = str(it.message) ?? 'error';
            return [errorEvent(classifyText(msg) ?? 'unknown', msg, true)];
          }
          default:
            return undefined;
        }
      }
      case 'turn.completed': {
        const u = obj(o.usage);
        let structured: unknown;
        try {
          const t = lastMessage.trim();
          if (t.startsWith('{')) structured = JSON.parse(t);
        } catch {
          /* 非 JSON 回复 */
        }
        return [
          {
            t: 'usage',
            input: num(u.input_tokens),
            cachedInput: num(u.cached_input_tokens),
            cacheWrite: num(u.cache_write_input_tokens),
            output: num(u.output_tokens),
            reasoning: num(u.reasoning_output_tokens),
            costSource: 'unknown',
            scope: 'delta',
          },
          { t: 'result', status: 'success', ...(threadId ? { sessionId: threadId } : {}), ...(structured !== undefined ? { structured } : {}), ...(lastMessage ? { text: lastMessage.slice(0, 4000) } : {}) },
        ];
      }
      case 'turn.failed': {
        const msg = str(obj(o.error).message) ?? 'turn failed';
        return [errorEvent(classifyText(msg) ?? 'unknown', msg), { t: 'result', status: 'error', ...(threadId ? { sessionId: threadId } : {}), text: msg.slice(0, 4000) }];
      }
      case 'error': {
        const msg = str(o.message) ?? 'error';
        const m = msg.match(/(?:reconnecting|retrying)\D*(\d+)\s*\/\s*\d+/i);
        if (m) return [{ t: 'retry', attempt: Number(m[1]), cls: classifyText(msg) ?? 'network' }];
        return [errorEvent(classifyText(msg) ?? 'unknown', msg)];
      }
      default:
        return undefined;
    }
  });
}

/**
 * apply_patch 上下文不匹配后模型通常会重试：该路径最后一次 file_change 成功时，之前的失败不算数。
 * 必须在 buildOutcome 之前去掉：run 因别的原因失败时，这些事件同样不能把错误类带成 sandbox。
 */
function dropRecoveredFileErrors(events: NEvent[]): NEvent[] {
  const lastOk = new Map<string, boolean>();
  for (const e of events) if (e.t === 'file_change') lastOk.set(e.path, e.ok);
  return events.filter((e) => !(e.t === 'error' && e.message.startsWith(FILE_CHANGE_FAILED) && lastOk.get(e.message.slice(FILE_CHANGE_FAILED.length)) === true));
}

function checkAuthEnv(mode: string, env: Record<string, string>): void {
  if (mode === 'api_key' && !env.CODEX_API_KEY) throw authConfigError('api_key 模式需要 CODEX_API_KEY');
  if (mode === 'custom_api') {
    if (!env.OPENAI_BASE_URL) throw authConfigError('custom_api 模式需要 OPENAI_BASE_URL（Responses API 兼容端点）');
    if (!env.OPENAI_API_KEY) throw authConfigError('custom_api 模式需要 OPENAI_API_KEY');
  }
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  vendor: 'openai',
  supportedVersions: '>=0.159.0',
  defaults: DEFAULTS,
  devModel: 'gpt-6-luna',
  authMethods: (): AuthMethodSpec[] => [
    {
      mode: 'subscription_login',
      label: 'ChatGPT 订阅登录（codex login --device-auth）',
      env: [],
      files: [{ relPath: '.codex/auth.json', part: 'state', hint: '登录后自动生成；会被 codex 刷新' }],
      login: { argv: ['codex', 'login', '--device-auth'], hint: '需要先在 ChatGPT 安全设置里开启 device code 登录' },
      riskNote: RISK_NOTES.codex_subscription_automation?.text,
      allowsCustomModels: false,
    },
    {
      mode: 'credential_file',
      label: '上传 auth.json（从已登录机器的 ~/.codex/auth.json 复制）',
      env: [],
      files: [{ relPath: '.codex/auth.json', part: 'state', hint: 'auth.json 等同密码；codex 会刷新它，Novelist 自动回写' }],
      login: null,
      riskNote: RISK_NOTES.codex_subscription_automation?.text,
      allowsCustomModels: false,
    },
    {
      mode: 'api_key',
      label: 'OpenAI API key（CODEX_API_KEY）',
      env: [{ name: 'CODEX_API_KEY', secret: true, required: true }],
      files: [],
      login: null,
      riskNote: RISK_NOTES.api_key_billing?.text,
      allowsCustomModels: false,
    },
    {
      mode: 'custom_api',
      label: '自定义 provider（Responses API 兼容端点）',
      env: [
        { name: 'OPENAI_BASE_URL', secret: false, required: true, hint: '如 https://gateway.example.com/v1；必须兼容 Responses API（wire_api=responses）' },
        { name: 'OPENAI_API_KEY', secret: true, required: true },
        { name: 'CODEX_PROVIDER_NAME', secret: false, required: false, hint: '可选：provider 显示名' },
      ],
      files: [],
      login: null,
      riskNote: RISK_NOTES.api_key_billing?.text,
      allowsCustomModels: true,
    },
  ],
  async detect(harnessDir) {
    return detectBin(['codex'], harnessDir);
  },
  async listModels(acct, inst) {
    const custom = acct.customModels ?? [];
    const env = minimalEnv(inst.binPath, { HOME: acct.home, CODEX_HOME: path.join(acct.home, '.codex'), ...acct.secretEnv });
    const r = await runShort({ argv: [inst.binPath, 'debug', 'models'], env, cwd: acct.home, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 30_000);
    let listed: string[] = [];
    try {
      const j = JSON.parse(r.stdout) as { models?: { slug?: string; visibility?: string }[] };
      listed = (j.models ?? []).filter((m) => m.slug && (m.visibility ?? 'list') === 'list').map((m) => m.slug!);
    } catch {
      /* 旧版本没有 debug models */
    }
    return [...new Set([...(listed.length ? listed : CODEX_KNOWN_MODELS), ...custom])];
  },
  async prepareHome(acct, _inst, spec): Promise<HomeLayout> {
    const H = acct.home;
    const CH = path.join(H, '.codex');
    // v3 没有回执 schema
    const rawSchema = spec.contract === 'v3' ? null : await fs.readFile(spec.receiptSchemaFile, 'utf8').catch(() => null);
    const schema = rawSchema === null ? null : codexOutputSchema(rawSchema);
    return {
      home: H,
      configFiles: [{ path: path.join(CH, 'config.toml'), content: codexConfigToml(acct.secretEnv, acct.authMode) }, ...(schema ? [{ path: path.join(spec.inDir, 'receipt.codex.json'), content: schema }] : [])],
      stateDirs: [CH],
      env: { HOME: H, CODEX_HOME: CH },
    };
  },
  materialize: (spec, compiled, caps, ctx) => materializeVia('codex', spec, compiled, caps, ctx?.home),
  buildInvocation(spec, caps, home, mat, acct, inst) {
    checkAuthEnv(acct.authMode, acct.secretEnv);
    // resume/fork 子命令没有 --color/-C：flag 放在子命令之后（研究文档实测形态），cwd 由 Invocation.cwd 保证
    const sub = spec.session.mode === 'fresh' ? null : spec.session.mode === 'fork' ? 'fork' : 'resume';
    const opts: string[] = ['--json', '--skip-git-repo-check', '-m', spec.model];
    if (!sub) opts.push('--color', 'never', '-C', spec.bookDir);
    // 每 run 的配置差异：工作目录信任 + 子 agent 开关（config.toml 账号级共享，不能放那里）
    // -c 的键路径按 . 切分且不识别引号（实测 0.165.0：projects."<dir>".x 不生效，路径含点时裸写也不生效），只能用内联表
    opts.push('-c', `projects={${JSON.stringify(spec.bookDir)}={trust_level="trusted"}}`);
    if (!spec.subagents) opts.push('-c', 'agents.enabled=false', '-c', 'features.multi_agent=false');
    const eff = effortOf(spec, EFFORTS);
    if (eff) opts.push('-c', `model_reasoning_effort="${eff}"`);
    opts.push(...mat.argv);
    opts.push('--dangerously-bypass-approvals-and-sandbox');
    const outputSchema = home.configFiles.find((f) => f.path.endsWith('receipt.codex.json'));
    if (wantsSchema(spec, caps) && outputSchema) opts.push('--output-schema', outputSchema.path);
    opts.push('-o', path.join(spec.logDir, 'last-message.json'));
    if (!spec.persistSession) opts.push('--ephemeral');
    opts.push(...filterExtraArgs(spec.extraArgs, DENY_EXTRA));
    const argv = [inst.binPath, 'exec', ...(sub ? [sub] : []), ...opts, ...(sub ? [spec.session.id] : []), '-'];
    const acctEnv = { ...acct.secretEnv };
    if (acct.authMode !== 'api_key') delete acctEnv.CODEX_API_KEY;
    const env = buildEnv(spec, inst, acctEnv, home.env, mat.env);
    return invocation(spec, argv, env, { file: spec.workOrderFile }, [
      { signal: 'SIGINT', graceMs: 10_000 },
      { signal: 'SIGTERM', graceMs: 10_000 },
    ], { readPaths: [acct.home], writePaths: home.stateDirs });
  },
  createParser: (spec) => createCodexParser(spec),
  classify(exit, events: NEvent[], stderrTail) {
    return buildOutcome(exit, dropRecoveredFileErrors(events), stderrTail, {
      completed: (x, evs) => {
        const term = [...evs].reverse().find((e) => e.t === 'result');
        return x.code === 0 && term?.t === 'result' && term.status === 'success';
      },
      postCheck: (_x, evs) => {
        const sb = evs.find((e) => e.t === 'error' && e.cls === 'sandbox');
        return sb && sb.t === 'error' ? { cls: 'sandbox', message: sb.message } : null;
      },
    });
  },
  async probe(inst, acct, ctx) {
    return standardProbe(this, inst, acct, ctx, {
      helpArgv: [['exec', '--help']],
      requiredFlags: ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--output-schema', '--output-last-message', '--ephemeral', '--color'],
      env: { CODEX_HOME: path.join(acct.home, '.codex') },
    });
  },
  async authCheck(acct, inst) {
    const env = minimalEnv(inst.binPath, { HOME: acct.home, CODEX_HOME: path.join(acct.home, '.codex'), ...acct.secretEnv });
    if (acct.authMode === 'api_key') {
      // codex login status 不看 CODEX_API_KEY（实测 0.165.0 有 key 无 auth.json 时报 Not logged in）：有 key 即通过，请求时校验
      return acct.secretEnv.CODEX_API_KEY ? { ok: true, detail: 'API key 已配置（请求时校验）' } : { ok: false, detail: '缺少 CODEX_API_KEY' };
    }
    if (acct.authMode === 'custom_api') {
      return acct.secretEnv.OPENAI_BASE_URL && acct.secretEnv.OPENAI_API_KEY ? { ok: true, detail: '自定义 provider：key 与 base_url 已配置（请求时校验）' } : { ok: false, detail: '缺少 OPENAI_BASE_URL 或 OPENAI_API_KEY' };
    }
    const r = await runShort({ argv: [inst.binPath, 'login', 'status'], env, cwd: acct.home, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 20_000);
    const out = `${r.stdout}\n${r.stderr}`.trim();
    const ok = r.code === 0 && !/not logged in/i.test(out);
    return { ok, detail: out.split('\n')[0]?.slice(0, 200) ?? '' };
  },
  loginCommand(acct, inst, mode) {
    if (mode !== 'subscription_login') return null;
    return {
      argv: [inst.binPath, 'login', '--device-auth'],
      env: minimalEnv(inst.binPath, { HOME: acct.home, CODEX_HOME: path.join(acct.home, '.codex') }),
      cwd: acct.home,
      urlPattern: /https:\/\/\S+/,
      codePattern: /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/,
      successFiles: ['.codex/auth.json'],
      credentialFiles: [{ relPath: '.codex/auth.json', part: 'state' }],
    };
  },
};
