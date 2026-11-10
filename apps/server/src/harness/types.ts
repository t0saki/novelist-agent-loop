/**
 * HarnessAdapter 契约（DESIGN §3.1、v3 §3.1）。
 * adapter 是纯“翻译层”：账号/规格 → 命令行、stdout → 归一化事件、退出 → Outcome。
 * 约定（目录契约）：cwd = 可写的书快照，指令在快照根的 AGENTS.md（cc 经 CLAUDE.md 的 @AGENTS.md），任务在 ORDER.md，启动语是 V3_LAUNCH_PROMPT；
 * 没有回执、schema、nonce，也没有 system channel。
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
} from '@novelist/shared';

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
  /** 任务种类原样（harness 不需要枚举；已删除的旧种类也能读） */
  taskKind: string;
  harness: HarnessId;
  profileId: string;
  accountId: string | null;
  bookSlug: string | null;
  /** $RUN = $DATA/runs/YYYY-MM/<runId> */
  runDir: string;
  /** $RUN/book：git worktree@base_commit；cwd；作者可写（收割看整个快照的改动） */
  bookDir: string;
  /** $RUN/book/work/<taskId>/attempt-<k>/out：快照里可写的草稿目录 */
  outDir: string;
  inDir: string; // $RUN/in
  logDir: string; // $RUN/log
  /** 启动语文件 $RUN/in/launch.md（名字沿用旧称；stdin 读它的 harness 用它） */
  workOrderFile: string;
  model: string;
  effort?: string;
  limits: RunLimits;
  session: { mode: 'fresh'; id: string } | { mode: 'resume' | 'fork'; id: string };
  persistSession: boolean;
  egress: { proxy?: string; allow: string[] };
  extraArgs: string[];
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
  buildInvocation(spec: RunSpec, caps: Capabilities, home: HomeLayout, acct: ResolvedAccount, inst: HarnessInstall): Invocation;
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
