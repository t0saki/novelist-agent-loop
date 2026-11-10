import type { AuthMode, BookStatus, InboxItem, RunState, TaskState, V3DraftRow, V3Length, V3OwnerRequestView, V3StatusKind } from '@novelist/shared';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

export const BOOK_STATUS: Record<BookStatus, { label: string; tone: Tone }> = {
  draft: { label: '草稿', tone: 'neutral' },
  planning: { label: '规划中', tone: 'info' },
  active: { label: '写作中', tone: 'ok' },
  paused: { label: '已暂停', tone: 'warn' },
  completed: { label: '已完结', tone: 'accent' },
  archived: { label: '已归档', tone: 'neutral' },
  importing: { label: '导入中', tone: 'info' },
};

export const RUN_STATE: Record<RunState, { label: string; tone: Tone }> = {
  preparing: { label: '准备中', tone: 'info' },
  spawned: { label: '已启动', tone: 'info' },
  running: { label: '运行中', tone: 'accent' },
  exited: { label: '已退出', tone: 'neutral' },
  finalized: { label: '已完成', tone: 'ok' },
  lost: { label: '丢失', tone: 'danger' },
  killed: { label: '已终止', tone: 'warn' },
};
export const ACTIVE_RUN_STATES: RunState[] = ['preparing', 'spawned', 'running'];

export const TASK_STATE: Record<TaskState, { label: string; tone: Tone }> = {
  pending: { label: '等依赖', tone: 'neutral' },
  ready: { label: '就绪', tone: 'info' },
  waiting: { label: '等待', tone: 'warn' },
  leased: { label: '已认领', tone: 'info' },
  running: { label: '运行中', tone: 'accent' },
  finalizing: { label: '收尾中', tone: 'info' },
  done: { label: '完成', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  blocked: { label: '需处理', tone: 'danger' },
  stale: { label: '已作废', tone: 'neutral' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

/** 角色名（键是字符串：运行记录里可能有已删除的旧角色，取不到就原样显示） */
export const ROLE_LABEL: Record<string, string> = {
  planner: '规划',
  showrunner: '总监',
  writer: '主笔',
  checker: '校验',
  confirm: '二次确认',
  extractor: '抽取',
  format_checker: '格式检查',
  summarizer: '摘要',
  auditor: '审计',
  reviewer: '评审',
  continuity: '连续性',
  judge: '评委',
  plan_judge: '规划评委',
  extractor_cross: '交叉抽取',
  heldout: '留出审计',
  editor: '编辑',
  stylist: '文风',
  canary: 'Canary',
};
export const roleLabel = (r: string): string => ROLE_LABEL[r] ?? r;

export const AUTH_MODE_LABEL: Record<AuthMode, string> = {
  subscription_login: '订阅登录',
  oauth_token: 'OAuth Token',
  credential_file: '凭据文件',
  api_key: 'API Key',
  custom_api: '自定义 API',
  adc: 'Google ADC',
  none: '无需认证',
};

export const INBOX_KIND: Record<InboxItem['kind'], { label: string; tone: Tone }> = {
  approval: { label: '审批', tone: 'accent' },
  hold: { label: '章节暂扣', tone: 'warn' },
  block: { label: '需要处理', tone: 'danger' },
  question: { label: '提问', tone: 'info' },
  auth: { label: '认证失效', tone: 'danger' },
  quota: { label: '额度', tone: 'warn' },
  circuit: { label: 'harness 故障', tone: 'danger' },
  model_change: { label: '模型变更', tone: 'warn' },
  format_migration: { label: '格式迁移', tone: 'warn' },
  agents_md_edit: { label: 'AGENTS.md 被改', tone: 'warn' },
  studio_conflict: { label: '冲突', tone: 'warn' },
  notice: { label: '通知', tone: 'neutral' },
};
/** 待办种类：库里可能有已不再产生的旧种类，取不到就原样显示 */
export const inboxKind = (k: string): { label: string; tone: Tone } => (INBOX_KIND as Record<string, { label: string; tone: Tone }>)[k] ?? { label: k, tone: 'neutral' };

export const WINDOW_LABEL: Record<string, string> = { five_hour: '5 小时', '5h': '5 小时', seven_day: '7 天', '7d': '7 天', daily: '每日', minute: '每分钟' };

export const INSTALL_TIER_LABEL: Record<string, string> = { blessed: '官方认证', probed: '已探测', unknown: '未验证' };

// ───────── 新流程（v3）的书 ─────────
export const V3_LENGTH_LABEL: Record<V3Length, string> = { short: '短篇', medium: '中篇', long: '长篇', epic: '超长篇' };

export const V3_STATUS_TONE: Record<V3StatusKind, Tone> = {
  draft: 'neutral',
  opening: 'accent',
  writing: 'accent',
  finale: 'accent',
  retro: 'info',
  harvesting: 'info',
  queued: 'info',
  waiting_quota: 'warn',
  waiting_account: 'warn',
  waiting_retry: 'warn',
  needs_owner: 'danger',
  buffer_full: 'ok',
  paused: 'warn',
  completed: 'accent',
  archived: 'neutral',
  idle: 'neutral',
  rewinding: 'info',
};

export const V3_RUN_KIND_LABEL: Record<string, string> = { 'book.open': '开书', 'book.write': '写作', 'book.retro': '复盘', finale: '结局', publish: '发布' };
/** 任务 / 运行种类：旧流程留下的种类原样显示 */
export const taskKindLabel = (k: string): string => V3_RUN_KIND_LABEL[k] ?? k;

export const V3_DRAFT_KIND_LABEL: Record<V3DraftRow['kind'], string> = {
  unfinished: '没写完的残稿',
  rewrite: '擅自改写的旧章',
  dup: '重复的稿',
  pre: '旧残稿',
  retro: '复盘时改的正文',
  owner_conflict: '和主人冲突的版本',
  rewound: '回退时移走的',
  replaced: '被替换的旧版',
  other: '其他',
};

export const V3_REQUEST_STATUS_LABEL: Record<V3OwnerRequestView['status'], { label: string; tone: Tone }> = {
  waiting: { label: '等待', tone: 'warn' },
  done: { label: '已改写', tone: 'ok' },
  not_done: { label: '没有改', tone: 'neutral' },
  dropped: { label: '已作废', tone: 'neutral' },
};
