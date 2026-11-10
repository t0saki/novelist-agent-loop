/**
 * 基础设施错误类 → 动作固定表（DESIGN §8.2）。纯函数，便于表驱动测试。
 * v3 的判定（flow/judge.ts#classifyV3Run）只对 INFRA_CLASSES 调用这里；其余错误类由判定表自己处理。
 *
 * 约定：waiting = 不消耗 attempt（配额/限流/瞬时错误/认证/模型下架）；retry = 消耗一次 attempt。
 */
import type { ErrorClass, Outcome } from '@novelist/shared';
import type { InboxInput, TaskResult } from '../runtime/types.js';
import type { OrchTaskState } from './orch-state.js';

export interface FailureContext {
  taskId: string;
  bookId: string | null;
  outcome: Outcome;
  orch: OrchTaskState;
  profile: string;
  accountId: string | null;
  now: Date;
}

export interface FailurePlan {
  result: TaskResult;
  /** 账号进入 sleep_until */
  sleep?: { accountId: string; until: string; reason: string };
  /** 账号认证失效 */
  authBad?: { accountId: string; detail: string };
  /** profile 冷却（model_unavailable，D8）：到点前路由跳过它，有备用走备用 */
  profileDown?: { profileId: string; until: string; reason: string };
  inbox?: InboxInput[];
  /** 合并进 tasks.params._orch */
  orchPatch: Partial<OrchTaskState>;
  /** 用了 retryAfter/waitUntil 等，需要发 quota_wait */
  quotaWait?: { accountId: string; until: string | null; reason: string };
}

const TRANSIENT_BASE_MS = 60_000;
const TRANSIENT_CAP = 12;
const TRANSIENT_MAX_DELAY_MS = 15 * 60_000;
const WEEKLY_THRESHOLD_MS = 12 * 3600_000;
/** 模型下架 / 不可用：这个 profile 冷却 30 分钟 */
export const MODEL_DOWN_MS = 30 * 60_000;

export const INFRA_CLASSES: ReadonlySet<ErrorClass> = new Set(['auth', 'quota', 'rate_limit', 'overloaded', 'billing', 'model_unavailable', 'network']);

function plus(ms: number, now: Date): string {
  return new Date(now.getTime() + ms).toISOString();
}

export function planFailure(cls: ErrorClass, ctx: FailureContext): FailurePlan {
  const { orch, profile, accountId, outcome, now } = ctx;
  const counts = { ...(orch.classCounts ?? {}), [cls]: (orch.classCounts?.[cls] ?? 0) + 1 };
  const msg = outcome.message ?? cls;
  const base = { errorClass: cls, message: msg } as const;

  const patch: Partial<OrchTaskState> = { classCounts: counts };

  switch (cls) {
    case 'auth': {
      const inbox: InboxInput[] = accountId
        ? [{ kind: 'auth', bookId: null, title: `账号 ${accountId} 认证失效`, body: { accountId, detail: msg }, actions: [{ id: 'dismiss', label: '知道了' }], dedupeKey: `auth:${accountId}` }]
        : [];
      return {
        result: { ...base, status: 'waiting', retryAfter: plus(10 * 60_000, now) },
        orchPatch: patch,
        ...(accountId ? { authBad: { accountId, detail: msg } } : {}),
        inbox,
      };
    }
    case 'billing': {
      const until = plus(3600_000, now);
      const inbox: InboxInput[] = accountId ? [{ kind: 'auth', bookId: null, title: `账号 ${accountId} 账单问题`, body: { accountId, detail: msg }, actions: [{ id: 'dismiss', label: '知道了' }], dedupeKey: `billing:${accountId}` }] : [];
      return { result: { ...base, status: 'waiting', retryAfter: until }, orchPatch: patch, ...(accountId ? { sleep: { accountId, until, reason: 'billing' } } : {}), inbox };
    }
    case 'quota': {
      const until = outcome.retryAfter ?? plus(3600_000, now);
      const weekly = new Date(until).getTime() - now.getTime() > WEEKLY_THRESHOLD_MS;
      const inbox: InboxInput[] = accountId && weekly ? [{ kind: 'quota', bookId: ctx.bookId, title: `账号 ${accountId} 窗口耗尽`, body: { accountId, until }, actions: [{ id: 'dismiss', label: '知道了' }], dedupeKey: `quota:${accountId}` }] : [];
      return {
        result: { ...base, status: 'waiting', retryAfter: until },
        orchPatch: patch,
        ...(accountId ? { sleep: { accountId, until, reason: msg }, quotaWait: { accountId, until, reason: msg } } : {}),
        inbox,
      };
    }
    case 'rate_limit': {
      const until = outcome.retryAfter ?? plus(60_000, now);
      return { result: { ...base, status: 'waiting', retryAfter: until }, orchPatch: patch, ...(accountId ? { sleep: { accountId, until, reason: msg }, quotaWait: { accountId, until, reason: msg } } : {}) };
    }
    case 'overloaded':
    case 'network': {
      const t = (orch.transient ?? 0) + 1;
      if (t > TRANSIENT_CAP) return { result: { ...base, status: 'retry' }, orchPatch: { ...patch, transient: 0 } };
      const delay = Math.min(TRANSIENT_MAX_DELAY_MS, TRANSIENT_BASE_MS * 2 ** (t - 1));
      return { result: { ...base, status: 'waiting', retryAfter: plus(delay, now) }, orchPatch: { ...patch, transient: t } };
    }
    case 'model_unavailable': {
      const until = plus(MODEL_DOWN_MS, now);
      return { result: { ...base, status: 'waiting', retryAfter: until }, orchPatch: patch, profileDown: { profileId: profile, until, reason: msg } };
    }
    default:
      // v3 不会走到这里（judgeRunV3 只对 INFRA_CLASSES 调用）
      return { result: { ...base, status: 'retry' }, orchPatch: patch };
  }
}
