/**
 * 成功判定与错误分类（DESIGN §3.3、§7.6）。Owner: lane A。
 * harness 层的 completed 只看终止事件与退出码；denial 只是遥测。产物是否验收由 validators 决定。
 */
import type { ErrorClass, NEvent, Outcome } from '@novelist/shared';
import { lastOf, modelOf, sessionIdOf, summarizeUsage } from './events.js';
import type { ExitInfo } from './types.js';

/** 从任意错误文本（stderr / error 消息 / result 文本）推断错误类；推不出返回 null */
export function classifyText(text: string): ErrorClass | null {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  const has = (re: RegExp) => re.test(t);
  if (has(/context[ _-]?(length|window)[^\n]*(exceed|too|limit)|prompt is too long|maximum context|contextwindowexceeded|context_length_exceeded|input is too long/)) return 'context_overflow';
  if (has(/credit balance|insufficient[_ ](balance|funds|credits?)|payment required|billing|\b402\b|余额不足|arrears|account (is )?suspended for non-payment/)) return 'billing';
  if (
    has(
      /auth_unavailable|no auth available|refresh_token_invalidated|not signed in|not logged in|login expired|please run \/login|authentication[_ ](required|failed|error)|unauthori[sz]ed|\b401\b|invalid[_ ](api[_ ]?key|x-api-key|token)|incorrect api key|oauth token (has )?expired|token (is )?(expired|revoked)|run `?(codex|grok) login|authentication_error|permission_error.*api key|invalid authentication|api key not valid|api_key_invalid|please pass a valid api key/,
    )
  )
    return 'auth';
  if (has(/usage limit|usagelimitexceeded|quota (exceeded|exhausted)|exceeded your current quota|weekly limit|limit reached|resource[_ ]exhausted|out of (credits|quota)|rate_limit_event[^\n]*rejected|plan limit/)) return 'quota';
  if (has(/rate[ _-]?limit|too many requests|\b429\b/)) return 'rate_limit';
  if (has(/overloaded|\b529\b|\b503\b|service unavailable|server_error|internal server error|\b502\b|bad gateway|upstream (connect )?error|capacity/)) return 'overloaded';
  if (
    has(
      /model[^\n]{0,40}(not found|not available|not supported|does not exist|unavailable|is not enabled)|unknown model|model_not_found|invalid model|no such model|unsupported model|model .* has been (retired|deprecated)/,
    )
  )
    return 'model_unavailable';
  if (has(/econnrefused|enotfound|etimedout|econnreset|eai_again|network error|getaddrinfo|socket hang up|fetch failed|connection (refused|reset|closed)|tls handshake|dns|unable to connect|stream disconnected/))
    return 'network';
  if (has(/safety (filter|block)|blocked by safety|content (filter|policy) (block|violation)|stop_reason["':\s]+refusal|refused to/)) return 'refusal';
  if (has(/max[_ ]turns|maximum number of turns|turn limit/)) return 'max_turns';
  if (has(/max[_ ]budget|budget exceeded|error_max_budget/)) return 'budget';
  if (has(/landlock|bwrap|bubblewrap|sandbox (error|denied|failed)|seccomp|operation not permitted \(os error 1\)/)) return 'sandbox';
  if (has(/unknown (option|argument|flag)|unexpected argument|unrecognized (option|argument)|invalid (value|option|flag)|error loading config|failed to parse|configuration error|unknown configuration field|not a valid json schema|usage: /))
    return 'config';
  return null;
}

/** 窗口 → 错误类：订阅窗口（5h / 7d / daily）耗尽 = quota；分钟级 = rate_limit */
export function rateLimitClass(window: string): ErrorClass {
  return window === 'minute' ? 'rate_limit' : 'quota';
}

export interface ClassifyOptions {
  /** §3.3：该 harness 的 completed 条件（只看终止事件与退出码） */
  completed(exit: ExitInfo, events: NEvent[]): boolean;
  /** completed 之后的额外判定（例：codex outDir 下 file_change.failed → sandbox） */
  postCheck?(exit: ExitInfo, events: NEvent[]): { cls: ErrorClass; message: string } | null;
  /** 退出码 → 错误类（例：agy 1/2 → config，3 → overloaded） */
  exitCodeClass?(code: number, stderrTail: string): ErrorClass | null;
}

/** 通用 Outcome 构造（各 adapter.classify 转调） */
export function buildOutcome(exit: ExitInfo, events: NEvent[], stderrTail: string, opts: ClassifyOptions): Outcome {
  const result = lastOf(events, 'result');
  const errors = events.filter((e): e is Extract<NEvent, { t: 'error' }> => e.t === 'error');
  const rateLimits = events
    .filter((e): e is Extract<NEvent, { t: 'rate_limit' }> => e.t === 'rate_limit')
    .map((e) => ({
      window: e.window,
      status: e.status,
      ...(e.utilization !== undefined ? { utilization: e.utilization } : {}),
      ...(e.resetsAt ? { resetsAt: e.resetsAt } : {}),
    }));
  const denials = events
    .filter((e): e is Extract<NEvent, { t: 'denial' }> => e.t === 'denial')
    .map((d) => ({ tool: d.tool, ...(d.path ? { path: d.path } : {}), ...(d.detail ? { detail: d.detail } : {}) }));
  const sessionId = sessionIdOf(events);
  const model = modelOf(events);
  const base: Outcome = {
    status: 'failed',
    usage: summarizeUsage(events),
    denials,
    exitCode: exit.code,
    signal: exit.signal,
    rateLimits,
    ...(sessionId ? { sessionId } : {}),
    ...(model ? { model } : {}),
    ...(result?.structured !== undefined ? { receipt: result.structured } : {}),
  };
  const rejected = [...rateLimits].reverse().find((r) => r.status === 'rejected');
  const retryAfter = rejected?.resetsAt;

  if (exit.killed) return { ...base, status: 'cancelled', message: `killed: ${exit.killed}` };
  if (exit.timedOut) {
    return { ...base, status: 'timeout', errorClass: exit.timedOut === 'wall' ? 'timeout_wall' : 'timeout_idle', message: `${exit.timedOut} timeout after ${exit.wallMs}ms` };
  }

  if (opts.completed(exit, events)) {
    const post = opts.postCheck?.(exit, events) ?? null;
    if (post) return { ...base, status: 'failed', errorClass: post.cls, message: post.message };
    return { ...base, status: 'completed' };
  }

  const lastErr = errors[errors.length - 1];
  const tailLine = lastLine(stderrTail);
  const message = lastErr?.message ?? result?.text ?? tailLine ?? (exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`);
  const withRetry = (o: Outcome): Outcome => (retryAfter && (o.errorClass === 'rate_limit' || o.errorClass === 'quota') ? { ...o, retryAfter } : o);

  if (result?.status === 'cancelled') return { ...base, status: 'cancelled', message };
  // 1. 明确的 error 事件（非 unknown）
  const specific = [...errors].reverse().find((e) => e.cls !== 'unknown');
  // 同时有额度拒绝的窗口时按窗口判：7d/5h 耗尽是 quota（周窗口要进 Inbox），分钟级才是 rate_limit
  if (specific) return withRetry({ ...base, errorClass: specific.cls === 'rate_limit' && rejected ? rateLimitClass(rejected.window) : specific.cls, message: specific.message });
  // 2. 终止事件的状态
  if (result?.status === 'max_turns') return { ...base, errorClass: 'max_turns', message };
  if (result?.status === 'refusal') return { ...base, errorClass: 'refusal', message };
  if (result?.status === 'timeout') return { ...base, status: 'timeout', errorClass: 'timeout_wall', message };
  // 3. 额度拒绝
  if (rejected) return withRetry({ ...base, errorClass: rateLimitClass(rejected.window), message: `rate limit rejected (${rejected.window})` });
  // 4. 文本推断（error 消息 + result 文本 + stderr）
  const textCls = classifyText([lastErr?.message ?? '', result?.text ?? '', stderrTail].join('\n'));
  if (textCls) return withRetry({ ...base, errorClass: textCls, message });
  // 5. 退出码映射
  if (exit.code !== null && exit.code !== 0) {
    const c = opts.exitCodeClass?.(exit.code, stderrTail) ?? null;
    if (c) return { ...base, errorClass: c, message };
  }
  // 6. 没有终止事件
  if (!result && !lastErr) {
    if (exit.signal || (exit.code !== null && exit.code !== 0)) return { ...base, errorClass: 'harness_crash', message };
    return { ...base, errorClass: 'drift', message: '缺少终止事件（drift）' };
  }
  if (exit.signal) return { ...base, errorClass: 'harness_crash', message };
  return { ...base, errorClass: lastErr?.cls ?? 'unknown', message };
}

function lastLine(s: string): string | undefined {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}
