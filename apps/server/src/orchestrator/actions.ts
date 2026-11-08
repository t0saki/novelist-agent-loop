/**
 * 错误类 → 动作固定表（DESIGN §7.6）。纯函数，便于表驱动测试。Owner: lane F。
 *
 * 约定：waiting = 不消耗 attempt（配额/限流/瞬时错误/认证）；retry = 消耗一次 attempt；
 * blocked = 需人工（发 Inbox）；failed = 不再重试。
 */
import type { ErrorClass, Outcome, TaskKind } from '@novelist/shared';
import type { InboxInput, TaskResult } from '../pipeline/types.js';
import type { OrchTaskState } from './orch-state.js';

export interface FailureContext {
  taskId: string;
  kind: TaskKind;
  bookId: string | null;
  outcome: Outcome;
  orch: OrchTaskState;
  profile: string;
  accountId: string | null;
  vendor: string;
  /** book.yaml policy.refusal_retry_other_vendor */
  refusalRetryOtherVendor: boolean;
  /** outDir 内是否有 denial（产物缺失时区分 permission_denied / output_contract，§3.3） */
  denialInOutDir: boolean;
  now: Date;
}

export interface FailurePlan {
  result: TaskResult;
  /** 账号进入 sleep_until */
  sleep?: { accountId: string; until: string; reason: string };
  /** 账号认证失效 */
  authBad?: { accountId: string; detail: string };
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

export const INFRA_CLASSES: ReadonlySet<ErrorClass> = new Set(['auth', 'quota', 'rate_limit', 'overloaded', 'billing', 'model_unavailable', 'network']);

function plus(ms: number, now: Date): string {
  return new Date(now.getTime() + ms).toISOString();
}

export function planFailure(cls: ErrorClass, ctx: FailureContext): FailurePlan {
  const { orch, profile, accountId, outcome, now } = ctx;
  const counts = { ...(orch.classCounts ?? {}), [cls]: (orch.classCounts?.[cls] ?? 0) + 1 };
  const n = counts[cls] as number;
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
        orchPatch: { ...patch, avoidProfiles: orch.avoidProfiles ?? [] },
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
    case 'model_unavailable':
      return { result: { ...base, status: 'retry', avoidProfile: profile, retryAfter: now.toISOString() }, orchPatch: patch };
    case 'timeout_wall':
    case 'timeout_idle':
      return { result: { ...base, status: 'retry', ...(n >= 2 ? { avoidProfile: profile } : {}) }, orchPatch: patch };
    case 'refusal': {
      if (!ctx.refusalRetryOtherVendor) {
        return {
          result: { ...base, status: 'blocked' },
          orchPatch: patch,
          inbox: [
            {
              kind: 'block',
              bookId: ctx.bookId,
              title: `任务 ${ctx.kind} 被模型拒绝`,
              body: { taskId: ctx.taskId, detail: msg },
              actions: [
                { id: 'retry', label: '重试' },
                { id: 'dismiss', label: '忽略' },
              ],
              dedupeKey: `refusal:${ctx.taskId}`,
              relatedTaskId: ctx.taskId,
            },
          ],
        };
      }
      return { result: { ...base, status: 'retry', retryAfter: now.toISOString() }, orchPatch: { ...patch, avoidVendors: [...new Set([...(orch.avoidVendors ?? []), ctx.vendor])] } };
    }
    case 'context_overflow':
      return { result: { ...base, status: 'retry', avoidProfile: profile }, orchPatch: patch };
    case 'max_turns':
      return { result: { ...base, status: n >= 2 ? 'failed' : 'retry', ...(n >= 2 ? {} : { avoidProfile: profile }) }, orchPatch: patch };
    case 'budget':
      return {
        result: { ...base, status: 'blocked' },
        orchPatch: patch,
        inbox: [{ kind: 'notice', bookId: ctx.bookId, title: `任务 ${ctx.kind} 超出预算上限`, body: { taskId: ctx.taskId, detail: msg }, actions: [{ id: 'retry', label: '提高上限后重试' }, { id: 'dismiss', label: '忽略' }], dedupeKey: `budget:${ctx.taskId}`, relatedTaskId: ctx.taskId }],
      };
    case 'permission_denied':
    case 'sandbox':
    case 'config':
    case 'drift':
      return { result: { ...base, status: 'retry', avoidProfile: profile }, orchPatch: patch };
    case 'harness_crash':
      return { result: { ...base, status: 'retry', ...(n > 2 ? { avoidProfile: profile } : {}) }, orchPatch: patch };
    case 'output_contract': {
      const failures = { ...(orch.contractFailures ?? {}), [profile]: (orch.contractFailures?.[profile] ?? 0) + 1 };
      return { result: { ...base, status: 'retry', ...((failures[profile] as number) >= 2 ? { avoidProfile: profile } : {}) }, orchPatch: { ...patch, contractFailures: failures } };
    }
    case 'unknown':
    default:
      return { result: { ...base, status: 'retry' }, orchPatch: patch };
  }
}
