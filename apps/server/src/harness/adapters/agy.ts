/**
 * Antigravity CLI adapter。Owner: lane A。
 * 事实来源（flags、事件格式、坑）：docs/v2/research/h_antigravity-cli.md —— 写代码前先读，不要发明 flag。
 * DESIGN：§3.3（成功判定）、§3.5（命令模板）、§3.6（home 布局与并发）、§3.7（认证模式）。
 * 认证：subscription_login（consumer OAuth，每账号持久 home，同账号并发 1；UI 显示 agy_consumer_wrap 风险说明，D5 照常可用）、api_key（GEMINI_API_KEY）、adc、custom_api（GOOGLE_GEMINI_BASE_URL）。listModels = `agy models`（制表符分隔 slug\\tlabel）。-p 是 argv（128KiB 上限）：只传“Read <workorder> and execute it.”。--output-format json 给 {conversation_id,status,response,usage}。
 *
 * 本机 1.5.3 已核实：
 * - `--settings <json|file>`（“Settings for this session only, never saved”）存在 → 每 run 的 trustedWorkspaces/permissions 走它，不改账号 home 的 settings.json；
 * - stream-json 实际是嵌套形状：{"event":"init","conversation_id","init":{model,cwd,tools,permission_mode}}、
 *   {"event":"step_update","step_update":{…}}、{"event":"result","result":{status,response,usage,…}}（parser 同时兼容扁平形状）；
 * - consumer OAuth 凭据是文件 $HOME/.gemini/antigravity-cli/antigravity-oauth-token（不走 keyring）；
 * - 登录：`agy acp --login`（管道可用：打印 Google 授权 URL，等待粘贴授权码）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthMethodSpec, NEvent, NEventBody } from '@novelist/shared';
import { RISK_NOTES } from '@novelist/shared';
import { buildOutcome, classifyText } from '../classify.js';
import { errorEvent, ndjsonParser, num, obj, str } from '../events.js';
import { dataRootOf } from '../isolation.js';
import { runShort } from '../runner.js';
import type { CapabilityDefaults, HarnessAdapter, HomeLayout, RunSpec, StreamParser } from '../types.js';
import { pathExists } from '../util.js';
import { authConfigError, buildEnv, detectBin, effortOf, filterExtraArgs, invocation, materializeVia, minimalEnv, parseModelLines, standardProbe, toolCallEvent, toolKindOf } from './common.js';

const DEFAULTS: CapabilityDefaults = {
  structuredOutput: 'native',
  schemaDialect: 'lenient',
  systemChannel: 'agent-file',
  systemReplace: false,
  shellTool: 'disableable',
  webTool: 'disableable',
  subagentTool: 'disableable',
  honorsHttpsProxy: true,
  workspaceDocLoaded: true,
  systemChannelLoaded: true,
  tailNonceSurvives: true,
  maxInstructionBytes: 20_000,
  sessionPreassign: false,
  resume: false,
  fork: false,
  stopHook: 'unverified',
  mcpHttp: 'unverified',
  exitZeroOnFailure: true,
  quotaSignal: 'error-only',
};

/** D2：默认路由 = agy + Gemini 4 Argon（slug 以 `agy models` 为准，可在 UI 改）；flash-low 只用于开发测试 */
export const AGY_KNOWN_MODELS = ['gemini-4-argon', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'];
export const AGY_TOKEN_FILE = '.gemini/antigravity-cli/antigravity-oauth-token';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DENY_EXTRA = [/^--settings/, /^--add-dir/, /^--remote-agent$/, /^--project/, /^--new-project$/, /^-i$/, /^--prompt-interactive/, /^--sandbox$/];

/** 每 run 的 settings（--settings 文件）：信任工作区 + 拒绝 shell / 网络 / .git 写入 / $RUN/in 写入（纵深防御） */
export function agySettings(spec: Pick<RunSpec, 'bookDir' | 'inDir' | 'runDir'>, authMode: string, acctEnv: Record<string, string>, customModels: string[]): Record<string, unknown> {
  // container 档没有 OS 级读边界：主密钥、会话密钥和备份不给 read_file（账号 home 里有本 run 要读的物化指令，不能整体 deny）
  const data = dataRootOf(spec);
  const s: Record<string, unknown> = {
    trustedWorkspaces: [spec.bookDir, spec.inDir],
    permissions: { deny: ['command(*)', 'write_file(.git/)', `write_file(${spec.inDir}/)`, `read_file(${data}/.master_key)`, `read_file(${data}/.session_secret)`, `read_file(${data}/backups/)`, 'read_url(*)', 'execute_url(*)'] },
  };
  if (authMode === 'api_key' || authMode === 'custom_api') s.modelProvider = 'gemini';
  if (authMode === 'custom_api' && acctEnv.GOOGLE_GEMINI_BASE_URL && customModels.length) {
    const base = acctEnv.GOOGLE_GEMINI_BASE_URL.replace(/\/+$/, '');
    s.customModelsConfig = { customModels: customModels.map((m) => ({ modelName: m.startsWith('gemini-api://') ? m : `gemini-api://${base}/models/${m}`, label: m })) };
  }
  return s;
}

/** agy stream-json → NEvent */
export function createAgyParser(): StreamParser {
  const activeTools = new Set<string>();
  let conversationId: string | undefined;
  return ndjsonParser((o) => {
    const ev = str(o.event) ?? str(o.type);
    switch (ev) {
      case 'init': {
        const i = { ...o, ...obj(o.init) };
        conversationId = str(o.conversation_id) ?? conversationId;
        const tools = Array.isArray(i.tools) ? (i.tools as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
        return [{ t: 'init', ...(conversationId ? { sessionId: conversationId } : {}), ...(str(i.model) ? { model: str(i.model)! } : {}), ...(tools ? { tools } : {}) }];
      }
      case 'step_update': {
        const s = { ...o, ...obj(o.step_update) };
        conversationId = str(s.conversation_id) ?? conversationId;
        const idx = String(s.step_index ?? '?');
        const stepType = str(s.step_type);
        const state = str(s.state);
        const out: NEventBody[] = [];
        const sub = obj(s.subagent_info);
        if (Object.keys(sub).length) {
          const sid = str(sub.conversation_id) ?? idx;
          out.push({ t: 'subagent', id: sid, phase: state === 'DONE' ? 'stop' : 'start', ...(str(sub.role) ? { role: str(sub.role)! } : {}) });
        }
        if (stepType === 'tool') {
          const info = obj(s.tool_info);
          const name = str(s.tool_name) ?? str(info.name) ?? 'unknown';
          const id = `step-${idx}`;
          if (!activeTools.has(id)) {
            activeTools.add(id);
            out.push(toolCallEvent(id, name, info.parameters));
          }
          if (state === 'DONE') {
            const err = obj(info.error);
            const failed = Object.keys(err).length > 0;
            const msg = str(err.message) ?? str(err.type) ?? '';
            out.push({ t: 'tool_result', id, ok: !failed, ...(failed ? { error: msg.slice(0, 1000) } : {}) });
            const kind = toolKindOf(name);
            if (kind === 'write' || kind === 'edit') {
              const ev2 = toolCallEvent(id, name, info.parameters);
              for (const p of ev2.t === 'tool_call' ? (ev2.paths ?? []) : []) out.push({ t: 'file_change', path: p, op: kind === 'write' ? 'add' : 'update', ok: !failed });
            }
            if (failed && /deny|denied|permission|not allowed|review/i.test(`${str(err.type) ?? ''} ${msg}`)) {
              const ev3 = toolCallEvent(id, name, info.parameters);
              const p = ev3.t === 'tool_call' ? ev3.paths?.[0] : undefined;
              out.push({ t: 'denial', tool: name, ...(p ? { path: p } : {}), ...(msg ? { detail: msg.slice(0, 300) } : {}) });
            }
          }
          return out;
        }
        if (stepType === 'agent_response' || stepType === 'planner_response') {
          const td = str(s.text_delta);
          if (td) out.push({ t: 'text', channel: 'assistant', delta: td });
          const th = str(s.thinking_delta) ?? str(s.thought_delta);
          if (th) out.push({ t: 'text', channel: 'thinking', delta: th });
        }
        if (stepType === 'checkpoint') out.push({ t: 'compaction' });
        return out.length ? out : [{ t: 'heartbeat', source: 'stdout' }];
      }
      case 'result': {
        const r = { ...o, ...obj(o.result) };
        conversationId = str(r.conversation_id) ?? conversationId;
        const u = obj(r.usage);
        const out: NEventBody[] = [
          {
            t: 'usage',
            input: num(u.input_tokens),
            cachedInput: num(u.cache_read_tokens),
            output: num(u.output_tokens),
            reasoning: num(u.thinking_tokens),
            costSource: 'unknown',
            scope: 'total',
          },
        ];
        const statusRaw = String(r.status ?? '').toUpperCase();
        const finished = str(r.finished_reason);
        const errObj = r.error;
        const errMsg = typeof errObj === 'string' ? errObj : str(obj(errObj).message) ?? (Object.keys(obj(errObj)).length ? JSON.stringify(errObj) : undefined);
        if (errMsg) out.push(errorEvent(classifyText(errMsg) ?? 'unknown', errMsg));
        let status: Extract<NEventBody, { t: 'result' }>['status'] = 'error';
        if (statusRaw === 'SUCCESS' && !finished) status = 'success';
        else if (finished === 'print_timeout') status = 'timeout';
        else if (statusRaw === 'CANCELED' || statusRaw === 'CANCELLED' || statusRaw === 'INTERRUPTED' || finished === 'interrupted') status = 'cancelled';
        const resp = str(r.response);
        out.push({
          t: 'result',
          status,
          ...(finished ? { stopReason: finished } : statusRaw ? { stopReason: statusRaw } : {}),
          ...(conversationId ? { sessionId: conversationId } : {}),
          ...(r.structured_output !== undefined ? { structured: r.structured_output } : {}),
          ...(typeof r.num_turns === 'number' ? { turns: r.num_turns } : {}),
          ...(resp ? { text: resp.slice(0, 4000) } : {}),
        });
        return out;
      }
      default:
        return undefined;
    }
  });
}

function checkAuthEnv(mode: string, env: Record<string, string>): void {
  if (mode === 'api_key' && !env.GEMINI_API_KEY) throw authConfigError('api_key 模式需要 GEMINI_API_KEY（GOOGLE_API_KEY 与 .env 不会被读取）');
  if (mode === 'custom_api' && !env.GOOGLE_GEMINI_BASE_URL) throw authConfigError('custom_api 模式需要 GOOGLE_GEMINI_BASE_URL');
}

const usesGeminiProvider = (authMode: string) => authMode === 'api_key' || authMode === 'custom_api';

/**
 * `agy models` 不接受 --settings：api_key / custom_api 账号要把 modelProvider 写进账号 home，否则提示未登录（实测 1.5.3）。
 * 其他模式反过来清掉残留：账号改认证模式后，home 里的 gemini 不会被每 run 的 --settings 覆盖（该键只在 API 模式写）。
 */
async function ensureProviderSettings(acct: { authMode: string; home: string }): Promise<void> {
  const want = usesGeminiProvider(acct.authMode);
  const file = path.join(acct.home, '.gemini', 'antigravity-cli', 'settings.json');
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    if (!want) return;
    cur = {};
  }
  if ((cur.modelProvider === 'gemini') === want) return;
  const { modelProvider: _stale, ...rest } = cur;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(want ? { ...cur, modelProvider: 'gemini' } : rest, null, 2));
}

function modeEnv(acct: { authMode: string; home: string; secretEnv: Record<string, string> }): Record<string, string> {
  const env = { ...acct.secretEnv };
  if (acct.authMode === 'adc') {
    env.AGY_ADC_AUTH = 'true';
    if (!env.GOOGLE_APPLICATION_CREDENTIALS) env.GOOGLE_APPLICATION_CREDENTIALS = path.join(acct.home, 'adc.json');
  }
  if (acct.authMode === 'subscription_login' || acct.authMode === 'credential_file') {
    // consumer OAuth：不让 key 意外接管
    delete env.GEMINI_API_KEY;
  }
  return env;
}

export const agyAdapter: HarnessAdapter = {
  id: 'agy',
  displayName: 'Antigravity CLI',
  vendor: 'google',
  supportedVersions: '>=1.5.3',
  defaults: DEFAULTS,
  devModel: 'gemini-3.8-flash-low',
  authMethods: (): AuthMethodSpec[] => [
    {
      mode: 'subscription_login',
      label: 'Google 账号登录（Google AI Pro / Ultra 订阅；agy acp --login）',
      env: [],
      files: [{ relPath: AGY_TOKEN_FILE, part: 'state', hint: '登录后自动生成；也可从已登录机器的 ~/.gemini/antigravity-cli/ 复制' }],
      login: { argv: ['agy', 'acp', '--login'], hint: '打开链接用 Google 账号登录，把授权码（或落地页完整 URL）粘贴到输入框' },
      riskNote: RISK_NOTES.agy_consumer_wrap?.text,
      allowsCustomModels: false,
    },
    {
      mode: 'credential_file',
      label: '上传 OAuth token 文件（antigravity-oauth-token）',
      env: [],
      files: [{ relPath: AGY_TOKEN_FILE, part: 'state' }],
      login: null,
      riskNote: RISK_NOTES.agy_consumer_wrap?.text,
      allowsCustomModels: false,
    },
    {
      mode: 'api_key',
      label: 'Gemini API key（Google AI Studio / Gemini Enterprise）',
      env: [{ name: 'GEMINI_API_KEY', secret: true, required: true }],
      files: [],
      login: null,
      riskNote: RISK_NOTES.api_key_billing?.text,
      allowsCustomModels: false,
    },
    {
      mode: 'adc',
      label: 'Google ADC / Vertex（上传 application_default_credentials.json）',
      env: [
        { name: 'GOOGLE_CLOUD_QUOTA_PROJECT', secret: false, required: false },
        { name: 'GOOGLE_CLOUD_LOCATION', secret: false, required: false },
      ],
      files: [{ relPath: 'adc.json', part: 'config', hint: 'gcloud auth application-default login 生成的 JSON' }],
      login: null,
      riskNote: RISK_NOTES.api_key_billing?.text,
      allowsCustomModels: false,
    },
    {
      mode: 'custom_api',
      label: '自定义 Gemini 兼容端点（GOOGLE_GEMINI_BASE_URL）',
      env: [
        { name: 'GOOGLE_GEMINI_BASE_URL', secret: false, required: true },
        { name: 'GEMINI_API_KEY', secret: true, required: false },
      ],
      files: [],
      login: null,
      riskNote: RISK_NOTES.api_key_billing?.text,
      allowsCustomModels: true,
    },
  ],
  async detect(harnessDir) {
    return detectBin(['agy'], harnessDir);
  },
  async listModels(acct, inst) {
    const custom = acct.customModels ?? [];
    await ensureProviderSettings(acct);
    const env = minimalEnv(inst.binPath, { HOME: acct.home, ...modeEnv(acct) });
    const r = await runShort({ argv: [inst.binPath, 'models'], env, cwd: acct.home, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 45_000);
    const listed = r.code === 0 ? parseModelLines(r.stdout) : [];
    return [...new Set([...(listed.length ? listed : AGY_KNOWN_MODELS), ...custom])];
  },
  async prepareHome(acct, _inst, spec): Promise<HomeLayout> {
    // agy 没有 config-dir flag：HOME 即隔离单位。consumer OAuth / API key 都用每账号持久 home（首次启动会下载运行时组件）
    // API 模式的 modelProvider 走 --settings；其他模式要在 run 前清掉 authCheck 留下的残留
    if (!usesGeminiProvider(acct.authMode)) await ensureProviderSettings(acct);
    const settings = agySettings(spec, acct.authMode, acct.secretEnv, acct.customModels ?? []);
    return {
      home: acct.home,
      configFiles: [{ path: path.join(spec.inDir, 'agy.settings.json'), content: JSON.stringify(settings, null, 2) }],
      stateDirs: [path.join(acct.home, '.gemini')],
      env: { HOME: acct.home },
    };
  },
  materialize: (spec, compiled, caps, ctx) => materializeVia('agy', spec, compiled, caps, ctx?.home),
  buildInvocation(spec, caps, home, mat, acct, inst) {
    checkAuthEnv(acct.authMode, acct.secretEnv);
    const prompt = `阅读并执行工作单 ${spec.workOrderFile}（先完整读取该文件；产物只写入其中声明的 out_dir）。Read ${spec.workOrderFile} and execute it.`;
    const argv = [inst.binPath, '-p', prompt, '--output-format', 'stream-json'];
    if (caps.structuredOutput === 'native') argv.push('--json-schema', spec.receiptSchemaFile);
    argv.push('--model', spec.model);
    const eff = effortOf(spec, EFFORTS);
    if (eff) argv.push('--effort', eff);
    argv.push(...mat.argv);
    const settingsFile = home.configFiles.find((f) => f.path.endsWith('agy.settings.json'));
    if (settingsFile) argv.push('--settings', settingsFile.path);
    argv.push('--add-dir', spec.inDir);
    if (spec.limits.wallMs > 0) argv.push('--print-timeout', `${Math.max(60, Math.floor(spec.limits.wallMs / 1000) - 30)}s`);
    argv.push('--log-file', path.join(spec.logDir, 'agy.log'));
    argv.push('--dangerously-skip-permissions', '--disable-slash-commands');
    // agy 不支持 resume（caps.resume=false）：session 一律 fresh
    argv.push(...filterExtraArgs(spec.extraArgs, DENY_EXTRA));
    const env = buildEnv(spec, inst, modeEnv(acct), home.env, mat.env);
    return invocation(spec, argv, env, 'devnull', [
      { signal: 'SIGINT', graceMs: 10_000 },
      { signal: 'SIGTERM', graceMs: 10_000 },
    ], { readPaths: [acct.home], writePaths: home.stateDirs });
  },
  createParser: () => createAgyParser(),
  classify(exit, events: NEvent[], stderrTail) {
    return buildOutcome(exit, events, stderrTail, {
      completed: (x, evs) => {
        const r = [...evs].reverse().find((e) => e.t === 'result');
        return x.code === 0 && r?.t === 'result' && r.status === 'success';
      },
      exitCodeClass: (code, stderr) => {
        if (code === 1 || code === 2) return 'config';
        if (code === 3) return /print.?timeout|AGY_ERROR.*time/i.test(stderr) ? 'timeout_wall' : 'overloaded';
        return null;
      },
    });
  },
  async probe(inst, acct, ctx) {
    return standardProbe(this, inst, acct, ctx, {
      helpArgv: [['--help']],
      requiredFlags: ['--output-format', '--json-schema', '--model', '--effort', '--print-timeout', '--log-file', '--dangerously-skip-permissions', '--settings', '--add-dir'],
    });
  },
  async authCheck(acct, inst) {
    if ((acct.authMode === 'subscription_login' || acct.authMode === 'credential_file') && !(await pathExists(path.join(acct.home, AGY_TOKEN_FILE)))) {
      return { ok: false, detail: '账号 home 中没有 antigravity-oauth-token：请先交互登录或上传 token 文件' };
    }
    await ensureProviderSettings(acct);
    const env = minimalEnv(inst.binPath, { HOME: acct.home, ...modeEnv(acct) });
    const r = await runShort({ argv: [inst.binPath, 'models'], env, cwd: acct.home, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 45_000);
    const models = parseModelLines(r.stdout);
    if (r.code === 0 && models.length) return { ok: true, detail: `可用模型 ${models.length} 个：${models.slice(0, 6).join(', ')}` };
    return { ok: false, detail: `${r.stderr || r.stdout}`.trim().slice(0, 300) || `exit ${r.code}` };
  },
  loginCommand(acct, inst, mode) {
    if (mode !== 'subscription_login') return null;
    return {
      argv: [inst.binPath, 'acp', '--login'],
      env: minimalEnv(inst.binPath, { HOME: acct.home }),
      cwd: acct.home,
      urlPattern: /https:\/\/accounts\.google\.com\/\S+/,
      successFiles: [AGY_TOKEN_FILE],
      credentialFiles: [{ relPath: AGY_TOKEN_FILE, part: 'state' }],
    };
  },
};
