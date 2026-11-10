/**
 * HarnessAdapter 契约（DESIGN §3.1）。Owner: lane A。
 * adapter 是纯“翻译层”：账号/规格 → 命令行、stdout → 归一化事件、退出 → Outcome。
 * 指令物化（system channel / workspace doc 怎么交给 harness）由 lane C 的 instructions/materialize 实现，
 * adapter.materialize() 只是转调 `materializeFor(this.id, …)`。
 */
import type {
  Account,
  AuthMethodSpec,
  AuthMode,
  Capabilities,
  HarnessId,
  HarnessInstall,
  IsolationBackend,
  NEvent,
  NEventBody,
  Outcome,
  QuotaSnapshot,
  RoleId,
  TaskKind,
} from '@novelist/shared';
import type { CompiledInstructions, MaterializeResult } from '../instructions/types.js';

/** 已解密、可直接使用的账号（只在 runner 进程内存在；绝不序列化进日志/DB） */
export interface ResolvedAccount extends Account {
  /** 账号 home 绝对路径：$DATA/accounts/<id>/home */
  home: string;
  /** 解密后的 env（含秘密） */
  secretEnv: Record<string, string>;
  /** 已物化到 home 的凭据文件绝对路径 */
  credentialFiles: { relPath: string; absPath: string; part: 'state' | 'config' }[];
}

export interface RunLimits {
  wallMs: number;
  idleMs: number;
  maxTurns: number;
  maxBudgetUsd?: number;
}

/** §3.1 RunSpec（增加了 harness/profile/account/book 字段） */
export interface RunSpec {
  runId: string; // uuid v4
  taskId: string;
  attempt: number;
  role: RoleId;
  taskKind: TaskKind;
  harness: HarnessId;
  profileId: string;
  accountId: string | null;
  bookSlug: string | null;
  /** $RUN = $DATA/runs/YYYY-MM/<runId> */
  runDir: string;
  /** $RUN/book：git worktree@base_commit；cwd；container 档下 harness 可写但只收割 outDir */
  bookDir: string;
  /** $RUN/book/work/<taskId>/attempt-<k>/out：唯一被收割的目录 */
  outDir: string;
  inDir: string; // $RUN/in
  logDir: string; // $RUN/log
  workOrderFile: string; // $RUN/in/workorder.md（同时复制到 work/<task>/workorder.md）
  systemFile: string; // $RUN/in/system.md（首尾 nonce 只在这里）
  receiptSchemaFile: string; // $RUN/in/receipt.<dialect>.json
  model: string;
  effort?: string;
  limits: RunLimits;
  session: { mode: 'fresh'; id: string } | { mode: 'resume' | 'fork'; id: string };
  persistSession: boolean;
  egress: { proxy?: string; allow: string[] };
  mcp?: { socket: string; token: string };
  subagents: boolean;
  extraArgs: string[];
  /** 作者层通道：append（默认，追加到 harness 自带系统提示）/ replace（整体替换；需 caps.systemReplace） */
  personaMode?: 'append' | 'replace';
  /**
   * 'v3': cwd = writable book snapshot, instructions via root AGENTS.md/CLAUDE.md, no receipt/schema/nonce. Absent = old contract.
   * v3 下 workOrderFile 是启动语文件 $RUN/in/launch.md，systemFile 是空的 $RUN/in/system.md，receiptSchemaFile 指向不会写入的路径。
   */
  contract?: 'v3';
}

/** prepareHome 的产物：home 的配置部分（每 run 重生成）与需要的 env */
export interface HomeLayout {
  home: string;
  /** 本 run 写入 home 的配置文件（绝对路径），run 后做 hash 校验（§3.6） */
  configFiles: { path: string; content: string; mode?: number }[];
  /** 需要保持可写的状态目录 */
  stateDirs: string[];
  env: Record<string, string>;
}

export interface Invocation {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: 'devnull' | { file: string };
  /** 供挂载可见性契约测试 */
  readPaths: string[];
  writePaths: string[];
  stop: { signal: 'SIGINT' | 'SIGTERM'; graceMs: number }[];
}

/** 增量解析器：只按 LF 切行；未知类型 → {t:'unknown'}；绝不抛异常 */
export interface StreamParser {
  push(chunk: string): NEventBody[];
  end(): NEventBody[];
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  wallMs: number;
  timedOut: 'wall' | 'idle' | null;
  killed: 'user' | 'shutdown' | null;
}

export interface ProbeContext {
  isolation: IsolationBackend;
  /** canary 用临时目录 */
  scratchDir: string;
  /** 是否跑真实模型 canary（会消耗额度） */
  live: boolean;
  /** canary 用模型（缺省取 adapter 的 dev 廉价模型） */
  model?: string;
  /** 原始流录制目录：$DATA/harness/fixtures/<id>/<ver>/ */
  fixturesDir?: string;
  /** canary 超时（默认 5 分钟） */
  timeoutMs?: number;
}

export interface LoginCommand {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** 输出行中提取 URL / 验证码的正则（UI 高亮） */
  urlPattern?: RegExp;
  codePattern?: RegExp;
  /** 成功判定：退出码 0 + 可选的文件存在检查（相对 home） */
  successFiles?: string[];
  /** 需要伪终端（Ink 等 TUI）：login manager 用 `script -qfec` 包装，回车发 \r */
  tty?: boolean;
  /** 从输出中捕获秘密写入账号 env（如 claude setup-token → CLAUDE_CODE_OAUTH_TOKEN）；捕获值在输出里打码 */
  captureEnv?: { name: string; pattern: RegExp }[];
  /** 登录成功后应登记为账号凭据文件的路径（相对 home；默认 = successFiles） */
  credentialFiles?: { relPath: string; part: 'state' | 'config' }[];
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly vendor: string;
  /** semver range，如 ">=2.1.293 <2.2" */
  readonly supportedVersions: string;
  /** 该 harness 支持的认证方法（UI 用它渲染账号表单） */
  authMethods(): AuthMethodSpec[];
  /** 在 harnessDir / PATH 中找到可执行文件并读出版本；找不到返回 null */
  detect(harnessDir: string): Promise<{ binPath: string; version: string } | null>;
  /** 列模型（agy models、codex 模型列表、cc 已知列表 + 账号 customModels） */
  listModels(acct: ResolvedAccount, inst: HarnessInstall): Promise<string[]>;
  prepareHome(acct: ResolvedAccount, inst: HarnessInstall, spec: RunSpec): Promise<HomeLayout>;
  /** 转调 instructions.materializeFor(this.id, …)；返回需要追加的 argv/env/文件 */
  materialize(spec: RunSpec, compiled: CompiledInstructions, caps: Capabilities, ctx?: { home: string }): Promise<MaterializeResult>;
  buildInvocation(spec: RunSpec, caps: Capabilities, home: HomeLayout, mat: MaterializeResult, acct: ResolvedAccount, inst: HarnessInstall): Invocation;
  createParser(spec: RunSpec): StreamParser;
  /** §3.3：只看终止事件与退出码；denial 只作遥测 */
  classify(exit: ExitInfo, events: NEvent[], stderrTail: string): Outcome;
  quotaProbe?(acct: ResolvedAccount, inst: HarnessInstall): Promise<QuotaSnapshot | null>;
  probe(inst: HarnessInstall, acct: ResolvedAccount, ctx: ProbeContext): Promise<Capabilities>;
  /** 网页“交互登录”：返回要 spawn 的登录命令（device-code 等）；不支持返回 null */
  loginCommand?(acct: ResolvedAccount, inst: HarnessInstall, mode: AuthMode): LoginCommand | null;
  gcHome?(acct: ResolvedAccount, olderThan: Date, keep: string[]): Promise<void>;
  /** 没有 probe 记录时的保守默认能力（来自研究文档；defaultCapabilities 使用） */
  readonly defaults?: CapabilityDefaults;
  /** 开发测试用廉价模型（D2：只用于测试 / canary，不是默认值） */
  readonly devModel?: string;
  /** 账号认证检查（UI“检查账号”）：不跑模型或只跑最便宜的状态命令 */
  authCheck?(acct: ResolvedAccount, inst: HarnessInstall): Promise<{ ok: boolean; detail: string }>;
}

/** 没有 probe 结果时的保守默认能力（adapter 可覆盖） */
export type CapabilityDefaults = Omit<Capabilities, 'version' | 'verifiedAt' | 'isolation' | 'models' | 'eventTypesSeen' | 'probeSteps'>;
