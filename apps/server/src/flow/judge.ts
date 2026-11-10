/**
 * v3 运行结果判定（docs/v3/DESIGN.md §8.2；p1-plan §2.10）。纯函数。
 * 先收稿再判定：有新章就算成功；只有改动没章节按书的阶梯退避；目录一点没动时，
 * 正常结束的只记在书头上（模型拒绝或只回了话没动笔，是这本书的事），没正常结束的才算空跑（账号和书都记一次）。
 * 运行从不返回 retry / blocked：额度、限流、超时、空跑都变成 waiting。
 */
import type { ErrorClass, Outcome } from '@novelist/shared';
import { INFRA_CLASSES } from '../orchestrator/actions.js';
import type { TaskResult } from '../pipeline/types.js';

export interface V3RunFacts {
  outcome: Pick<Outcome, 'status' | 'errorClass' | 'retryAfter' | 'message'>;
  /** the TASK is in state cancelled (cancelTask); a plain killRun leaves it false */
  ownerCancelled: boolean;
  lost: boolean;
  accepted: number;
  /** the harvest completed the book without a new chapter (finale marked the last accepted chapter) */
  completed?: boolean;
  changed: number;
  /** value AFTER this run, computed by finalize */
  noChapterStreak: number;
  /** book empty streak BEFORE this run */
  emptyStreak: number;
  /** account zero-diff streak BEFORE this run */
  accountStreak: number;
  /** planFailure(infraClass) result, when infraClass */
  planFailure: { status: TaskResult['status']; retryAfter?: string; avoidProfile?: string } | null;
  now: Date;
  /** book.retro（来自任务行）：从不重试，不记账号和书的账 */
  retro?: boolean;
}

export interface V3Verdict {
  status: 'done' | 'waiting' | 'keep_cancelled';
  retryAfter?: string;
  /** planFailure 要求换 profile（model_unavailable 等），executor 照旧处理 */
  avoidProfile?: string;
  /** executor applies planFailure(infraClass) side effects (sleep/authBad/inbox/avoidProfile) */
  infraClass: ErrorClass | null;
  /** count against the account */
  zeroDiff: boolean;
  bookEmpty: 'inc' | 'reset' | 'keep';
  /** zeroDiff && accountStreak+1 >= 2 */
  pauseAccount: boolean;
  /** noChapterStreak === 5 / emptyStreak+1 === 5 */
  bookInbox: 'no_prose' | 'empty' | null;
}

/** 有改动但没有合格章节：30 分钟、2 小时、6 小时，之后每天一次 */
export const BOOK_LADDER_MS = [30 * 60_000, 2 * 3600_000, 6 * 3600_000, 24 * 3600_000];
/** 目录没有任何改动：10 分钟起 */
export const EMPTY_LADDER_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 24 * 3600_000];
const KILLED_WAIT_MS = 10 * 60_000;
const LOST_FIRST_MS = 60_000;
const INBOX_AT = 5;

const at = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();
const ladder = (steps: number[], i: number) => steps[Math.max(0, Math.min(i, steps.length - 1))] as number;

export function classifyV3Run(f: V3RunFacts): V3Verdict {
  const cls = f.outcome.errorClass ?? null;
  const infraClass = cls && INFRA_CLASSES.has(cls) && f.outcome.status !== 'completed' ? cls : null;
  const base = { infraClass, zeroDiff: false, pauseAccount: false, bookInbox: null } as const;
  // 1. 有新章：成功（基础设施的副作用照样执行，例如额度用完让账号睡下）
  if (f.accepted > 0 || f.completed) return { ...base, status: 'done', bookEmpty: 'reset' };
  // 2. 主人取消：收下的东西照提交，任务保持 cancelled，不计数
  if (f.ownerCancelled) return { ...base, status: 'keep_cancelled', bookEmpty: 'keep' };
  // 2b. 复盘：不管结果如何都算做过了（不重试、不记空跑、不进待办）；基础设施的副作用照样由执行器执行
  if (f.retro) return { ...base, status: 'done', bookEmpty: 'keep' };
  // 3. killRun（任务本身没取消）
  if (f.outcome.status === 'cancelled') return { ...base, status: 'waiting', retryAfter: at(f.now, KILLED_WAIT_MS), bookEmpty: 'keep' };
  // 4. 有改动但没有合格章节：书的阶梯
  if (f.changed > 0) {
    const wait = at(f.now, ladder(BOOK_LADDER_MS, f.noChapterStreak - 1));
    const fp = f.planFailure?.retryAfter;
    return { ...base, status: 'waiting', retryAfter: fp && Date.parse(fp) > Date.parse(wait) ? new Date(fp).toISOString() : wait, bookEmpty: 'reset', bookInbox: f.noChapterStreak === INBOX_AT ? 'no_prose' : null };
  }
  const emptyInbox = f.emptyStreak + 1 === INBOX_AT ? ('empty' as const) : null;
  // 5. 没改动、基础设施原因：照 planFailure 等待（retry 一律变 waiting），不计数
  if (infraClass) {
    return {
      ...base,
      status: 'waiting',
      retryAfter: f.planFailure?.retryAfter ?? at(f.now, KILLED_WAIT_MS),
      ...(f.planFailure?.avoidProfile ? { avoidProfile: f.planFailure.avoidProfile } : {}),
      bookEmpty: 'keep',
    };
  }
  // 6. 没改动、run 丢了（宿主重启等）：只记在书头上
  if (f.lost) {
    const ms = f.emptyStreak === 0 ? LOST_FIRST_MS : ladder(EMPTY_LADDER_MS, f.emptyStreak);
    return { ...base, status: 'waiting', retryAfter: at(f.now, ms), bookEmpty: 'inc', bookInbox: emptyInbox };
  }
  // 6b. 正常结束却什么都没写，或者模型明确拒绝（errorClass refusal）：是这本书的事，不算账号故障
  if (f.outcome.status === 'completed' || cls === 'refusal') {
    return { ...base, status: 'waiting', retryAfter: at(f.now, ladder(EMPTY_LADDER_MS, f.emptyStreak)), bookEmpty: 'inc', bookInbox: emptyInbox };
  }
  // 7. 空跑（没正常结束：崩溃、超时、出错……）：账号和书都记一次
  return {
    ...base,
    status: 'waiting',
    retryAfter: at(f.now, ladder(EMPTY_LADDER_MS, f.emptyStreak)),
    zeroDiff: true,
    pauseAccount: f.accountStreak + 1 >= 2,
    bookEmpty: 'inc',
    bookInbox: emptyInbox,
  };
}
