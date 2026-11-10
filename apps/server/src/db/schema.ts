/**
 * 完整 drizzle schema（DESIGN 附录 C + D2/D5 修订）。Owner: lane G。
 * 规则：
 * - 正典在 git 里；所有“与书相关”的表都可由 `novelist reindex` 从书库重建（books/chapters 为索引）。
 * - 时间一律 timestamptz（mode:'string'，ISO 字符串）；JSON 一律 jsonb。
 * - 改表 = 改本文件 + `pnpm --filter @novelist/server db:generate` 生成新迁移（只前进不后退）。
 * - pg 与 PGlite 共用同一 schema / 迁移。
 * - run_events 设计上按月分区；为兼容 PGlite，这里是普通表 + (run_id, seq) 主键 + ts 索引，保留期由清理任务按 ts 删除。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  bigserial,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const now = (name: string) => ts(name).notNull().defaultNow();

// ───────────────────────── 书 / 章节（索引，可重建） ─────────────────────────
export const books = pgTable(
  'books',
  {
    id: text('id').primaryKey(), // nanoid
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    genre: text('genre').notNull(),
    status: text('status').notNull().default('draft'), // BookStatus
    tier: text('tier').notNull().default('standard'),
    priority: integer('priority').notNull().default(0),
    /** 下一章号（写作游标） */
    cursor: integer('cursor').notNull().default(1),
    acceptedThrough: integer('accepted_through').notNull().default(0),
    auditedThrough: integer('audited_through').notNull().default(0),
    publishedThrough: integer('published_through').notNull().default(0),
    cardsThrough: integer('cards_through').notNull().default(0),
    totalCjk: integer('total_cjk').notNull().default(0),
    formatVersion: integer('format_version').notNull().default(1),
    headCommit: text('head_commit'),
    writerProfile: text('writer_profile'),
    /** 生产暂停原因：max_buffer / owner / block / format / quota */
    pausedReason: text('paused_reason'),
    endgame: boolean('endgame').notNull().default(false),
    v1Id: integer('v1_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
    archivedAt: ts('archived_at'),
  },
  (t) => [uniqueIndex('books_slug_uq').on(t.slug), index('books_status_idx').on(t.status)],
);

export const chapters = pgTable(
  'chapters',
  {
    bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
    no: integer('no').notNull(),
    chapterId: text('chapter_id').notNull(), // c00421
    title: text('title').notNull().default(''),
    volume: text('volume').notNull().default(''),
    /** 卷标题（P3：旧书从 plan/volumes/*.yaml 回填；空 = 读者端只显示卷 id） */
    volumeTitle: text('volume_title').notNull().default(''),
    arc: text('arc').notNull().default(''),
    /** ChapterWorkflowState（见 shared/api.ts） */
    state: text('state').notNull().default('planned'),
    /** 章节流水线状态机的持久部分（lane E 定义内容） */
    workflow: jsonb('workflow').$type<Record<string, unknown>>().notNull().default({}),
    cjk: integer('cjk').notNull().default(0),
    acceptedCommit: text('accepted_commit'),
    acceptedAt: ts('accepted_at'),
    audited: boolean('audited').notNull().default(false),
    publishedAt: ts('published_at'),
    revisedAt: ts('revised_at'),
    verdict: text('verdict'),
    revisions: integer('revisions').notNull().default(0),
    degraded: boolean('degraded').notNull().default(false),
    debts: integer('debts').notNull().default(0),
    writerModel: text('writer_model'),
    updatedAt: now('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.no] }), index('chapters_state_idx').on(t.bookId, t.state), index('chapters_pub_idx').on(t.bookId, t.publishedAt)],
);

/** append-only 书级事件（UI 时间线 / 审计） */
export const bookEvents = pgTable(
  'book_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    bookId: text('book_id').notNull(),
    ts: now('ts'),
    kind: text('kind').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('book_events_book_ts_idx').on(t.bookId, t.ts)],
);

// ───────────────────────── 任务 / run ─────────────────────────
export const tasks = pgTable(
  'tasks',
  {
    /** sha256(book, kind, target, hard_manifest_hash, stack_hash, config_hash, pipeline_ver)（§7.2） */
    id: text('id').primaryKey(),
    bookId: text('book_id'),
    kind: text('kind').notNull(), // TaskKind
    target: text('target').notNull(), // c00421 / a0012 / v03 / book / <account>
    lane: text('lane').notNull(), // write | side | system
    role: text('role'), // RoleId；确定性任务为 null
    tier: text('tier'),
    priority: integer('priority').notNull().default(0),
    deps: text('deps').array().notNull().default(sql`'{}'::text[]`),
    state: text('state').notNull().default('ready'), // TaskState
    baseCommit: text('base_commit'),
    hardManifest: jsonb('hard_manifest').$type<Record<string, string>>().notNull().default({}),
    softManifest: jsonb('soft_manifest').$type<Record<string, string>>().notNull().default({}),
    rebaseValidators: text('rebase_validators').array().notNull().default(sql`'{}'::text[]`),
    /** handler 参数（如 revise 的 findings、diff 模式、parent task） */
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(6),
    lastErrorClass: text('last_error_class'),
    lastError: text('last_error'),
    waitReason: text('wait_reason'),
    notBefore: ts('not_before'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    parentTaskId: text('parent_task_id'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('tasks_book_state_prio_idx').on(t.bookId, t.state, t.priority),
    index('tasks_state_notbefore_idx').on(t.state, t.notBefore),
    index('tasks_kind_target_idx').on(t.bookId, t.kind, t.target),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(), // uuid v4（也用作 cc --session-id）
    taskId: text('task_id').notNull(),
    bookId: text('book_id'),
    taskKind: text('task_kind').notNull(),
    attempt: integer('attempt').notNull(),
    role: text('role').notNull(),
    profileId: text('profile_id').notNull(),
    accountId: text('account_id'),
    harness: text('harness').notNull(),
    harnessVersion: text('harness_version').notNull().default(''),
    model: text('model'),
    modelReported: text('model_reported'),
    isolation: text('isolation').notNull(),
    driver: text('driver').notNull().default('spawn'),
    sessionId: text('session_id'),
    state: text('state').notNull().default('preparing'), // RunState
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    heartbeatAt: ts('heartbeat_at'),
    shimPid: integer('shim_pid'),
    shimStart: text('shim_start'),
    harnessPid: integer('harness_pid'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    exitCode: integer('exit_code'),
    errorClass: text('error_class'),
    outcome: jsonb('outcome').$type<Record<string, unknown>>(),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    nonceReport: jsonb('nonce_report').$type<unknown[]>(),
    denials: integer('denials').notNull().default(0),
    runDir: text('run_dir').notNull(),
    baseCommit: text('base_commit'),
    stackHash: text('stack_hash'),
    createdAt: now('created_at'),
  },
  (t) => [index('runs_state_lease_idx').on(t.state, t.leaseExpiresAt), index('runs_task_idx').on(t.taskId), index('runs_book_idx').on(t.bookId, t.createdAt)],
);

export const runEvents = pgTable(
  'run_events',
  {
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    ts: ts('ts').notNull(),
    t: text('t').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] }), index('run_events_ts_idx').on(t.ts)],
);

// ───────────────────────── 账号 / profile / 路由 / 配额 ─────────────────────────
export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  harness: text('harness').notNull(),
  label: text('label').notNull().default(''),
  authMode: text('auth_mode').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** shared Account（去掉 id/harness/authMode/label/enabled 之外的全部字段；秘密只存 secretId） */
  body: jsonb('body').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
});

export const accountsState = pgTable('accounts_state', {
  accountId: text('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  sleepUntil: ts('sleep_until'),
  sleepReason: text('sleep_reason'),
  util: jsonb('util').$type<Record<string, unknown>>().notNull().default({}),
  credExpiresAt: ts('cred_expires_at'),
  lastAuthCheck: jsonb('last_auth_check').$type<Record<string, unknown>>(),
  updatedAt: now('updated_at'),
});

export const profiles = pgTable('profiles', {
  id: text('id').primaryKey(),
  harness: text('harness').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  builtin: boolean('builtin').notNull().default(false),
  body: jsonb('body').$type<Record<string, unknown>>().notNull(), // shared Profile
  updatedAt: now('updated_at'),
});

export const routingPresets = pgTable('routing_presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  builtin: boolean('builtin').notNull().default(false),
  body: jsonb('body').$type<Record<string, unknown>>().notNull(), // shared RoutingPreset
  updatedAt: now('updated_at'),
});

export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: now('ts'),
    accountId: text('account_id'),
    profileId: text('profile_id'),
    harness: text('harness').notNull(),
    model: text('model'),
    taskKind: text('task_kind').notNull(),
    tier: text('tier'),
    bookId: text('book_id'),
    runId: text('run_id'),
    input: integer('input').notNull().default(0),
    cached: integer('cached').notNull().default(0),
    cacheWrite: integer('cache_write').notNull().default(0),
    output: integer('output').notNull().default(0),
    reasoning: integer('reasoning').notNull().default(0),
    /** 各窗口占用率增量（订阅，主口径）{ '5h': 0.4, '7d': 0.05 } */
    utilDelta: jsonb('util_delta').$type<Record<string, number>>().notNull().default({}),
    /** 仅 API key 账号 */
    usd: doublePrecision('usd'),
  },
  (t) => [index('usage_ts_idx').on(t.ts), index('usage_profile_kind_idx').on(t.profileId, t.taskKind), index('usage_book_idx').on(t.bookId)],
);

export const quotaReservations = pgTable(
  'quota_reservations',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    window: text('window').notNull(),
    bookId: text('book_id'),
    taskId: text('task_id'),
    runId: text('run_id'),
    amount: real('amount').notNull(),
    createdAt: now('created_at'),
    settledAt: ts('settled_at'),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('quota_res_open_idx').on(t.accountId, t.window, t.settledAt)],
);

export const quotaSnapshots = pgTable(
  'quota_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: text('account_id').notNull(),
    ts: now('ts'),
    window: text('window').notNull(),
    utilization: real('utilization'),
    resetsAt: ts('resets_at'),
    source: text('source').notNull().default('event'),
  },
  (t) => [index('quota_snap_idx').on(t.accountId, t.window, t.ts)],
);

// ───────────────────────── harness ─────────────────────────
export const harnessInstalls = pgTable(
  'harness_installs',
  {
    harness: text('harness').notNull(),
    version: text('version').notNull(),
    binPath: text('bin_path').notNull(),
    sha256: text('sha256').notNull().default(''),
    sha256Source: text('sha256_source').notNull().default('tofu'),
    tier: text('tier').notNull().default('unknown'),
    status: text('status').notNull().default('candidate'),
    nodeVersion: text('node_version'),
    installedAt: now('installed_at'),
  },
  (t) => [primaryKey({ columns: [t.harness, t.version] })],
);

export const capabilities = pgTable(
  'capabilities',
  {
    harness: text('harness').notNull(),
    version: text('version').notNull(),
    isolation: text('isolation').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    verifiedAt: ts('verified_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.harness, t.version, t.isolation] })],
);

export const circuitBreakers = pgTable(
  'circuit_breakers',
  {
    harness: text('harness').notNull(),
    version: text('version').notNull(),
    isolation: text('isolation').notNull(),
    state: text('state').notNull().default('closed'), // closed | pending_open | open | half_open
    openedAt: ts('opened_at'),
    effectiveAt: ts('effective_at'),
    reason: text('reason'),
    samples: jsonb('samples').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: now('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.harness, t.version, t.isolation] })],
);

export const loginSessions = pgTable('login_sessions', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  harness: text('harness').notNull(),
  state: text('state').notNull(),
  startedAt: now('started_at'),
  endedAt: ts('ended_at'),
  urls: jsonb('urls').$type<string[]>().notNull().default([]),
  codes: jsonb('codes').$type<string[]>().notNull().default([]),
  exitCode: integer('exit_code'),
  /** 最近的输出（环形，最多 ~2000 行）；含秘密的行由 adapter 打码 */
  output: jsonb('output').$type<unknown[]>().notNull().default([]),
});

// ───────────────────────── 发布 / inbox / 通知 ─────────────────────────
export const publishSchedule = pgTable(
  'publish_schedule',
  {
    bookId: text('book_id').notNull(),
    no: integer('no').notNull(),
    notBefore: ts('not_before').notNull(),
    slot: ts('slot'),
    publishedAt: ts('published_at'),
    state: text('state').notNull().default('queued'), // queued | published | skipped | held
  },
  (t) => [primaryKey({ columns: [t.bookId, t.no] }), index('publish_due_idx').on(t.state, t.notBefore)],
);

export const inbox = pgTable(
  'inbox',
  {
    id: text('id').primaryKey(),
    bookId: text('book_id'),
    kind: text('kind').notNull(), // InboxKind
    title: text('title').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull().default({}),
    actions: jsonb('actions').$type<unknown[]>().notNull().default([]),
    state: text('state').notNull().default('open'),
    /** 同一事项去重（如 auth:<accountId>） */
    dedupeKey: text('dedupe_key'),
    relatedTaskId: text('related_task_id'),
    timeoutAt: ts('timeout_at'),
    onTimeout: text('on_timeout').notNull().default('wait'),
    resolution: jsonb('resolution').$type<Record<string, unknown>>(),
    createdAt: now('created_at'),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [index('inbox_state_idx').on(t.state, t.createdAt), uniqueIndex('inbox_dedupe_open_uq').on(t.dedupeKey).where(sql`state = 'open'`)],
);

export const notifications = pgTable('notifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: now('ts'),
  channel: text('channel').notNull(), // ntfy | webhook
  event: text('event').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('pending'), // pending | sent | failed
  error: text('error'),
  /** 签名一次性审批链接 token 的 hash（15 分钟有效） */
  approvalTokenHash: text('approval_token_hash'),
  expiresAt: ts('expires_at'),
});

// ───────────────────────── 读者 / 会话 / PAT ─────────────────────────
export const readers = pgTable(
  'readers',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull().default(''),
    /** HMAC(sessionSecret, password) 前缀，单框登录按它查找，不遍历 hash（§9.6） */
    lookupId: text('lookup_id'),
    /** argon2id；v1 导入的为 'pbkdf2$…'，首次登录成功后重 hash */
    pwHash: text('pw_hash').notNull(),
    tokenVersion: integer('token_version').notNull().default(1),
    allowBooks: jsonb('allow_books').$type<string[] | null>(),
    enabled: boolean('enabled').notNull().default(true),
    legacy: boolean('legacy').notNull().default(false),
    v1Id: integer('v1_id'),
    createdAt: now('created_at'),
    lastSeenAt: ts('last_seen_at'),
  },
  (t) => [index('readers_lookup_idx').on(t.lookupId)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256(cookie token) */
    id: text('id').primaryKey(),
    role: text('role').notNull(), // admin | reader
    readerId: text('reader_id'),
    tokenVersion: integer('token_version').notNull().default(1),
    createdAt: now('created_at'),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at'),
    ip: text('ip'),
    ua: text('ua'),
  },
  (t) => [index('sessions_expires_idx').on(t.expiresAt)],
);

export const readingProgress = pgTable(
  'reading_progress',
  {
    readerId: text('reader_id').notNull(),
    bookId: text('book_id').notNull(),
    no: integer('no').notNull(),
    scroll: real('scroll').notNull().default(0),
    updatedAt: now('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.readerId, t.bookId] })],
);

export const pats = pgTable('pats', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  hash: text('hash').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default(['admin']),
  createdAt: now('created_at'),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});

// ───────────────────────── 设置 / 秘密 / 审计 / 导入 ─────────────────────────
/** key: 'system' → SystemSettings；'routing.active' → {presetId, overrides}；'admin' → {pwHash}；… */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: now('updated_at'),
});

/** AES-256-GCM 加密的秘密（env 值、凭据文件、cc token…）。明文从不入库、从不出 API */
export const secrets = pgTable(
  'secrets',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // env | file | system
    ownerKind: text('owner_kind').notNull().default('account'), // account | system
    ownerId: text('owner_id'),
    name: text('name').notNull(), // env 名或 relPath
    /** base64(iv[12] | ciphertext | tag[16]) */
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [uniqueIndex('secrets_owner_name_uq').on(t.ownerKind, t.ownerId, t.kind, t.name)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: now('ts'),
    actor: text('actor').notNull(), // admin | pat:<id> | reader:<id> | system | cli
    action: text('action').notNull(),
    target: text('target'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
  },
  (t) => [index('audit_ts_idx').on(t.ts)],
);

export const importJobs = pgTable('import_jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull().default('v1'),
  state: text('state').notNull().default('running'),
  request: jsonb('request').$type<Record<string, unknown>>().notNull(),
  log: jsonb('log').$type<string[]>().notNull().default([]),
  report: jsonb('report').$type<Record<string, unknown>>(),
  startedAt: now('started_at'),
  endedAt: ts('ended_at'),
});

/** v1 → v2 id 映射（幂等导入） */
export const v1ImportMap = pgTable(
  'v1_import_map',
  {
    kind: text('kind').notNull(), // novel | chapter | reader | theme
    v1Id: integer('v1_id').notNull(),
    v2Id: text('v2_id').notNull(),
    importedAt: now('imported_at'),
  },
  (t) => [primaryKey({ columns: [t.kind, t.v1Id] })],
);

export const schema = {
  books,
  chapters,
  bookEvents,
  tasks,
  runs,
  runEvents,
  accounts,
  accountsState,
  profiles,
  routingPresets,
  usageLedger,
  quotaReservations,
  quotaSnapshots,
  harnessInstalls,
  capabilities,
  circuitBreakers,
  loginSessions,
  publishSchedule,
  inbox,
  notifications,
  readers,
  sessions,
  readingProgress,
  pats,
  settings,
  secrets,
  auditLog,
  importJobs,
  v1ImportMap,
};
