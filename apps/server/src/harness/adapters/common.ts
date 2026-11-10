/**
 * adapter 公共件：可执行文件探测、基础 env 白名单、工具种类映射、标准 probe 骨架、extra_args 过滤。Owner: lane A。
 */
import path from 'node:path';
import type { Capabilities, HarnessInstall, NEventBody } from '@novelist/shared';
import type { TOOL_KINDS } from '@novelist/shared';
import { RunPrepareError, runShort } from '../runner.js';
import type { CapabilityDefaults, HarnessAdapter, Invocation, ProbeContext, ResolvedAccount, RunSpec } from '../types.js';
import { parseVersion, satisfies, whichSync } from '../util.js';

export type ToolKind = (typeof TOOL_KINDS)[number];

/** 在 harnessDir（$DATA/harness/bin）与 PATH 中找到可执行文件并读出版本 */
export async function detectBin(names: string[], harnessDir: string, versionArgs: string[] = ['--version']): Promise<{ binPath: string; version: string } | null> {
  for (const n of names) {
    const bin = whichSync(n, [harnessDir]);
    if (!bin) continue;
    const r = await runShort(
      { argv: [bin, ...versionArgs], env: minimalEnv(bin), cwd: process.cwd(), stdin: 'devnull', readPaths: [], writePaths: [], stop: [] },
      15_000,
    );
    const v = parseVersion(`${r.stdout}\n${r.stderr}`);
    if (v) return { binPath: bin, version: v };
  }
  return null;
}

/** 短命令（--version / models / login status）用的最小 env */
export function minimalEnv(binPath: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: pathFor(binPath),
    LANG: 'C.UTF-8',
    HOME: extra.HOME ?? process.env.HOME ?? '/tmp',
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    ...extra,
  };
}

/** PATH = harness 所在目录 + node 所在目录 + 系统目录（env -i 起步，§3.5） */
export function pathFor(binPath: string): string {
  const dirs = [path.dirname(binPath), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set(dirs)].join(':');
}

/** 不允许账号 env 覆盖的变量（隔离关键项） */
export const PROTECTED_ENV = new Set(['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'DSH_HOME', 'PI_CODING_AGENT_DIR', 'LANG', 'TZ']);

/**
 * 组装 run env：env -i 起步 → 基础白名单 → 账号 env（不得覆盖 PROTECTED_ENV）→ adapter 自己的变量（home.env、extra）。
 * egress 代理：HTTPS_PROXY/HTTP_PROXY/NO_PROXY（§3.5）。
 */
export function buildEnv(
  spec: RunSpec,
  inst: HarnessInstall,
  acctEnv: Record<string, string>,
  ...layers: Record<string, string>[]
): Record<string, string> {
  const env: Record<string, string> = { PATH: pathFor(inst.binPath), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) };
  if (spec.egress?.proxy) {
    env.HTTPS_PROXY = spec.egress.proxy;
    env.HTTP_PROXY = spec.egress.proxy;
    env.https_proxy = spec.egress.proxy;
    env.http_proxy = spec.egress.proxy;
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
    env.no_proxy = env.NO_PROXY;
  }
  for (const [k, v] of Object.entries(acctEnv)) if (!PROTECTED_ENV.has(k)) env[k] = v;
  for (const l of layers) Object.assign(env, l);
  return env;
}

/** 跨 harness 的工具名 → 归一化 kind */
export function toolKindOf(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.startsWith('mcp__') || n.includes('__') || n === 'call_mcp_tool' || n.startsWith('mcp')) return 'mcp';
  if (/^(read|view_file|read_file|cat|notebookread)$/.test(n)) return 'read';
  if (/^(write|write_file|write_to_file|create_file)$/.test(n)) return 'write';
  if (/^(edit|multiedit|notebookedit|notebook_edit|replace_file_content|multi_replace_file_content|search_replace|str_replace|apply_patch|edit_file|sed_file)$/.test(n)) return 'edit';
  if (/^(grep|grep_search|search|rg|codebase_search)$/.test(n)) return 'search';
  if (/^(glob|ls|list|list_dir|find|find_by_name|list_files)$/.test(n)) return 'list';
  if (/^(bash|shell|run_command|run_terminal_cmd|exec|command|send_command_input|powershell)$/.test(n)) return 'exec';
  if (/^(agent|task|invoke_subagent|define_subagent|subagent|browser_subagent|manage_subagents|spawn_agent)$/.test(n)) return 'subagent';
  if (/^(webfetch|websearch|web_search|web_fetch|search_web|read_url_content|fetch)$/.test(n) || n.startsWith('browser_')) return 'web';
  return 'other';
}

/** 从工具参数里取路径（各家字段名不同） */
export function pathsFromInput(input: unknown): string[] {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out: string[] = [];
  for (const k of ['file_path', 'path', 'notebook_path', 'Path', 'AbsolutePath', 'TargetFile', 'filePath', 'target_file', 'DirectoryPath', 'SearchPath', 'filename']) {
    const v = o[k];
    if (typeof v === 'string' && v) out.push(v);
  }
  const ps = o.paths;
  if (Array.isArray(ps)) for (const p of ps) if (typeof p === 'string') out.push(p);
  return [...new Set(out)];
}

export function toolCallEvent(id: string, name: string, input: unknown, command?: string): NEventBody {
  const kind = toolKindOf(name);
  const paths = pathsFromInput(input);
  const cmd = command ?? (input && typeof input === 'object' ? ((input as Record<string, unknown>).command as string | undefined) : undefined);
  return { t: 'tool_call', id, name, kind, ...(paths.length ? { paths } : {}), ...(typeof cmd === 'string' && cmd ? { command: cmd.slice(0, 2000) } : {}) };
}

/** extra_args 过滤：去掉会破坏隔离/契约的 flag（adapter 负责过滤危险项） */
export function filterExtraArgs(args: string[], deny: RegExp[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (deny.some((r) => r.test(a))) {
      // 跳过它的值（下一个非 flag 参数）
      if (!a.includes('=') && args[i + 1] && !args[i + 1]!.startsWith('-')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** 通用 Invocation 骨架 */
export function invocation(
  spec: RunSpec,
  argv: string[],
  env: Record<string, string>,
  stdin: Invocation['stdin'],
  stop: Invocation['stop'],
  extra: { readPaths?: string[]; writePaths?: string[]; cwd?: string } = {},
): Invocation {
  return {
    argv,
    env,
    cwd: extra.cwd ?? spec.bookDir,
    stdin,
    readPaths: [...new Set([spec.bookDir, spec.inDir, ...(extra.readPaths ?? [])])],
    writePaths: [...new Set([spec.outDir, spec.logDir, ...(extra.writePaths ?? [])])],
    stop,
  };
}

/** 没有 probe 记录时的能力 = adapter.defaults + 运行时字段 */
export function capsFrom(defaults: CapabilityDefaults, version: string, isolation: Capabilities['isolation'], models: string[] = []): Capabilities {
  return { ...defaults, version, verifiedAt: '', isolation, models, eventTypesSeen: [], probeSteps: [] };
}

/**
 * 标准 probe（§3.8 第 1–2 步）：--version、扫描 --help 中的必需 flag、列模型。
 * canary（第 4 步）由 probe.runProbe 在 ctx.live 时追加。
 */
export async function standardProbe(
  adapter: HarnessAdapter,
  inst: HarnessInstall,
  acct: ResolvedAccount,
  ctx: ProbeContext,
  o: { helpArgv: string[][]; requiredFlags: string[]; env?: Record<string, string> },
): Promise<Capabilities> {
  const steps: Capabilities['probeSteps'] = [];
  const env = minimalEnv(inst.binPath, { HOME: acct.home, ...(o.env ?? {}) });
  const ver = await runShort({ argv: [inst.binPath, '--version'], env, cwd: ctx.scratchDir, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 20_000);
  const version = parseVersion(`${ver.stdout}\n${ver.stderr}`) ?? inst.version;
  steps.push({ step: 'version', ok: !!version, detail: version ?? (ver.stderr || 'no version').slice(0, 200) });
  steps.push({
    step: 'supported_range',
    ok: satisfies(version, adapter.supportedVersions),
    detail: `${version} vs ${adapter.supportedVersions}`,
  });
  let help = '';
  for (const h of o.helpArgv) {
    const r = await runShort({ argv: [inst.binPath, ...h], env, cwd: ctx.scratchDir, stdin: 'devnull', readPaths: [], writePaths: [], stop: [] }, 20_000);
    help += `\n${r.stdout}\n${r.stderr}`;
  }
  const missing = o.requiredFlags.filter((f) => !help.includes(f));
  steps.push({ step: 'flags', ok: missing.length === 0, detail: missing.length ? `缺少 flag：${missing.join(' ')}` : `${o.requiredFlags.length} 个必需 flag 均存在` });
  let models: string[] = [];
  try {
    models = await adapter.listModels(acct, inst);
    steps.push({ step: 'models', ok: models.length > 0, detail: models.slice(0, 20).join(', ') });
  } catch (e) {
    steps.push({ step: 'models', ok: false, detail: (e as Error).message.slice(0, 300) });
  }
  const defaults = adapter.defaults;
  if (!defaults) throw new Error(`${adapter.id} 没有 defaults`);
  return { ...capsFrom(defaults, version, ctx.isolation, models), verifiedAt: new Date().toISOString(), probeSteps: steps };
}

/** adapter 构造命令时发现的账号配置问题（auth 类，不消耗 attempt） */
export function authConfigError(message: string): RunPrepareError {
  return new RunPrepareError('auth', 'auth_config', message);
}

export function effortOf(spec: RunSpec, allowed: string[]): string | undefined {
  if (!spec.effort) return undefined;
  return allowed.includes(spec.effort) ? spec.effort : undefined;
}

/** 解析 `slug<TAB>label` / 每行一个 slug 的模型列表输出 */
export function parseModelLines(out: string): string[] {
  const models: string[] = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t || /^(fetching|available|loading|warning|error|usage)/i.test(t)) continue;
    const slug = t.split(/\s+/)[0]!;
    if (/^[A-Za-z0-9][\w.:/@-]*$/.test(slug) && /[a-z]/i.test(slug)) models.push(slug);
  }
  return [...new Set(models)];
}
