/**
 * 进程配置（env → AppConfig）与 $DATA 目录约定。Owner: lane G。
 * 所有模块通过 AppConfig / DataPaths 取路径，不得自行拼 /data。
 */
import path from 'node:path';
import type { HarnessId, IsolationPreference } from '@novelist/shared';

export type ProcessRole = 'web' | 'orchestrator' | 'runner';

export interface AppConfig {
  dataDir: string;
  host: string;
  port: number;
  /** postgres://… 走 pg；'pglite:<dir>' 或空 → PGlite（dev/test；生产用 pg） */
  databaseUrl: string | null;
  dbKind: 'pg' | 'pglite';
  pgliteDir: string | null;
  /** v1 导入源（同一 Postgres 上的旧库 "novelist"） */
  v1DatabaseUrl: string | null;
  /** v1 数据目录（只读挂载，用于导入封面）；未设置则跳过封面 */
  v1DataDir: string | null;
  /** 除同源外允许的 Origin（host:port，开发用） */
  allowedOrigins: string[];
  /** AES-256-GCM 主密钥（base64 32 字节 / hex 64 位）；未给则读写 $DATA/.master_key */
  masterKey: string | null;
  adminPassword: string | null;
  sessionSecret: string | null;
  isolation: IsolationPreference;
  roles: ProcessRole[];
  /** runner 只处理这些 harness（拆分 runner 容器用）；空 = 全部 */
  runnerHarnesses: HarnessId[];
  trustProxy: string | false;
  insecureCookies: boolean;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** harness 可执行文件目录（默认 $DATA/harness/bin，内含 <id> 软链）；未找到时退回 PATH 查找 */
  harnessDir: string;
  /** 前端构建产物目录（@fastify/static） */
  webDistDir: string;
  /** 内部监听器（MCP 等，P3+）：unix socket 路径 */
  internalSocket: string;
  schedulerEnabled: boolean;
  /** 调度 tick 周期（毫秒），默认 2000；e2e 调小以缩短用时 */
  schedulerTickMs: number;
  /** 开发：允许 fake harness 出现在路由里 */
  allowFakeHarness: boolean;
  /** NOVELIST_FAKE_HARNESS=1：mock 模式，全部角色强制路由到 fake adapter（含已有书的 book.yaml 路由） */
  fakeHarness: boolean;
  version: string;
}

export interface DataPaths {
  root: string;
  /** 每本书一个独立 git 仓库：books/<slug>/ */
  books: string;
  /** 账号 home：accounts/<accountId>/home（状态部分持久；配置部分每 run 重写） */
  accounts: string;
  /** runs/YYYY-MM/<runId>/{in,log,book}；runs/active/<runId> → 软链 */
  runs: string;
  runsActive: string;
  /** 全局作者指令（L1）：instructions/global/{AGENTS.md,roles/<role>.md,skills/} —— git 仓库 */
  instructionsGlobal: string;
  /** 题材包：genres/<id>/… —— git 仓库（首次启动从内置包种子） */
  genres: string;
  /** harness 相关：harness/{harness.lock.yaml,capabilities/,bin/,fixtures/} */
  harness: string;
  exports: string;
  media: string;
  backups: string;
  tmp: string;
  pglite: string;
  masterKeyFile: string;
  sessionSecretFile: string;
}

export function dataPaths(root: string): DataPaths {
  const p = (...s: string[]) => path.join(root, ...s);
  return {
    root,
    books: p('books'),
    accounts: p('accounts'),
    runs: p('runs'),
    runsActive: p('runs', 'active'),
    instructionsGlobal: p('instructions', 'global'),
    genres: p('genres'),
    harness: p('harness'),
    exports: p('exports'),
    media: p('media'),
    backups: p('backups'),
    tmp: p('tmp'),
    pglite: p('pglite'),
    masterKeyFile: p('.master_key'),
    sessionSecretFile: p('.session_secret'),
  };
}

const DEFAULT_TRUST_PROXY = 'loopback,uniquelocal';

/**
 * 只信任网段（CIDR/别名）。Fastify 的 true 会信任整条 XFF（客户端可伪造 IP 绕过登录限速），数字在 5.12 一律 fail closed。
 * 旧值 1/true 视同默认网段，0/false 关闭。
 */
function trustProxyOf(v: string | undefined): string | false {
  const s = (v ?? '').trim();
  if (!s || /^(1|true|yes|on)$/i.test(s)) return DEFAULT_TRUST_PROXY;
  if (/^(0|false|no|off)$/i.test(s)) return false;
  return s;
}

const bool = (v: string | undefined, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.NOVELIST_DATA_DIR || '/data');
  const rawUrl = env.NOVELIST_DATABASE_URL?.trim() || null;
  const isPg = !!rawUrl && /^postgres(ql)?(\+\w+)?:\/\//.test(rawUrl);
  const pgliteDir = isPg ? null : rawUrl?.startsWith('pglite:') ? rawUrl.slice('pglite:'.length) || null : path.join(dataDir, 'pglite');
  const roles = (env.NOVELIST_ROLES || 'web,orchestrator,runner')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ProcessRole => s === 'web' || s === 'orchestrator' || s === 'runner');
  return {
    dataDir,
    host: env.NOVELIST_HOST || '0.0.0.0',
    port: Number(env.NOVELIST_LISTEN_PORT || 8000),
    // v1 用 postgresql+psycopg:// 前缀；这里统一成 node-postgres 可用的形式
    databaseUrl: isPg ? rawUrl!.replace(/^postgresql\+\w+:/, 'postgresql:') : rawUrl,
    dbKind: isPg ? 'pg' : 'pglite',
    pgliteDir: pgliteDir === 'memory' ? null : pgliteDir,
    v1DatabaseUrl: env.NOVELIST_V1_DATABASE_URL?.replace(/^postgresql\+\w+:/, 'postgresql:') || null,
    v1DataDir: env.NOVELIST_V1_DATA_DIR?.trim() || null,
    allowedOrigins: (env.NOVELIST_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    masterKey: env.NOVELIST_MASTER_KEY || null,
    adminPassword: env.NOVELIST_ADMIN_PASSWORD || null,
    sessionSecret: env.NOVELIST_SESSION_SECRET || null,
    isolation: (env.NOVELIST_ISOLATION as IsolationPreference) || 'auto',
    roles: roles.length ? roles : ['web', 'orchestrator', 'runner'],
    runnerHarnesses: (env.NOVELIST_RUNNER_HARNESS || '').split(',').map((s) => s.trim()).filter(Boolean) as HarnessId[],
    trustProxy: trustProxyOf(env.NOVELIST_TRUST_PROXY),
    insecureCookies: bool(env.NOVELIST_INSECURE_COOKIES, false),
    logLevel: (env.NOVELIST_LOG_LEVEL as AppConfig['logLevel']) || 'info',
    harnessDir: env.NOVELIST_HARNESS_DIR || path.join(dataDir, 'harness', 'bin'),
    webDistDir: env.NOVELIST_WEB_DIST || path.resolve(import.meta.dirname, '../../../web/dist'),
    internalSocket: env.NOVELIST_INTERNAL_SOCKET || path.join(dataDir, 'run', 'internal.sock'),
    schedulerEnabled: bool(env.NOVELIST_SCHEDULER_ENABLED, true),
    schedulerTickMs: Number(env.NOVELIST_SCHEDULER_TICK_MS) || 2000,
    allowFakeHarness: bool(env.NOVELIST_ALLOW_FAKE_HARNESS, false) || bool(env.NOVELIST_FAKE_HARNESS, false),
    fakeHarness: bool(env.NOVELIST_FAKE_HARNESS, false),
    version: env.NOVELIST_VERSION || '2.0.0-alpha.0',
  };
}
