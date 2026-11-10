/**
 * v3 书的一句状态（docs/v3/DESIGN.md §9 首页；p2-plan §2.2、§5.8）。纯函数：输入由 services/v3-view.ts 批量查好。
 * 规则自上而下，第一条命中即用。
 */
import type { V3Status, V3StatusKind } from '@novelist/shared';
import { BUDGET_WAIT_PREFIX, BUFFER_FULL_WAIT, NO_PROSE_WAIT } from './contract.js';
import type { V3BookMeta } from './types.js';

export interface V3StatusInput {
  book: { status: string; pausedReason: string | null; accepted: number; published: number; totalCjk: number; targetCjk: number };
  meta: V3BookMeta;
  publishMode: 'scheduled' | 'immediate' | 'manual' | string;
  maxBuffer: number;
  /** 这本书活着的 v3 任务（open / write / retro） */
  flowTask: { kind: string; state: string; notBefore: string | null; lastErrorClass: string | null; waitReason: string | null; params: Record<string, unknown> } | null;
  /** flowTask 最近的一次 run */
  run: { state: string; startedAt: string | null } | null;
  /** 这本书最近一次 run 的账号，sleepUntil > now 时 */
  accountSleep: { until: string; reason: string | null } | null;
  /** 那个账号 lastAuthCheck.ok === false */
  authBad: boolean;
  /** nextSlots(cfg, now, 1)[0] */
  nextRelease: string | null;
  now: Date;
  tz: string;
}

const DAY_MS = 86_400_000;
const BATCH_NOTE_DAYS = 7;
const RUNNING = ['leased', 'running', 'finalizing'];
const QUEUED = ['ready', 'pending', 'waiting'];
const QUOTA_CLASSES = ['quota', 'rate_limit'];

function parts(d: Date, tz: string): { y: string; m: string; d: string; hh: string; mm: string } {
  let ps: Intl.DateTimeFormatPart[];
  try {
    ps = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  } catch {
    ps = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  }
  const get = (t: string) => ps.find((p) => p.type === t)?.value ?? '';
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour').padStart(2, '0'), mm: get('minute').padStart(2, '0') };
}

/** "今天 14:20" / "明天 08:00" / "11月12日 08:00"（按 tz） */
export function fmtWhen(iso: string, now: Date, tz: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const p = parts(at, tz);
  const day = (x: { y: string; m: string; d: string }) => `${x.y}-${x.m}-${x.d}`;
  const time = `${p.hh}:${p.mm}`;
  if (day(p) === day(parts(now, tz))) return `今天 ${time}`;
  if (day(p) === day(parts(new Date(now.getTime() + DAY_MS), tz))) return `明天 ${time}`;
  return `${p.m}月${p.d}日 ${time}`;
}

/** “约 …”里今天只写时刻 */
const approxWhen = (iso: string, now: Date, tz: string): string => fmtWhen(iso, now, tz).replace(/^今天 /, '');

const minutesSince = (iso: string | null, now: Date): number => (iso ? Math.max(1, Math.floor((now.getTime() - Date.parse(iso)) / 60_000)) : 1);
const wan = (n: number): string => (n / 10_000).toFixed(1);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function notesOf(i: V3StatusInput): string[] {
  const out: string[] = [];
  const n = i.meta.batchNote;
  if (n && i.now.getTime() - Date.parse(n.at) <= BATCH_NOTE_DAYS * DAY_MS) out.push(`上一批用了 ${n.steps} 步，每批章数已从 ${n.from} 减到 ${n.to}。`);
  return out;
}

function make(kind: V3StatusKind, sentence: string, i: V3StatusInput, extra: { since?: string | null; until?: string | null; notes?: string[] } = {}): V3Status {
  return { kind, sentence, since: extra.since ?? null, until: extra.until ?? null, notes: [...(extra.notes ?? []), ...notesOf(i)] };
}

function runningSentence(i: V3StatusInput, t: NonNullable<V3StatusInput['flowTask']>): { kind: V3StatusKind; sentence: string } {
  const m = minutesSince(i.run?.startedAt ?? null, i.now);
  const p = t.params;
  const mode = typeof p.mode === 'string' ? p.mode : '';
  const from = num(p.from) ?? i.book.accepted + 1;
  const count = num(p.count);
  if (t.kind === 'book.retro') {
    const to = num(p.to) ?? i.book.accepted;
    return { kind: 'retro', sentence: `正在复盘第 ${from}–${to} 章，已 ${m} 分钟` };
  }
  if (t.kind === 'book.open') {
    if (mode === 'open-short') return { kind: 'opening', sentence: `正在开书，写整本，已 ${m} 分钟` };
    return { kind: 'opening', sentence: `正在开书，写第 1–${count ?? 1} 章，已 ${m} 分钟` };
  }
  if (mode === 'finale') return { kind: 'finale', sentence: `正在写结局（第 ${from} 章起），已 ${m} 分钟` };
  const to = from + Math.max(1, count ?? 1) - 1;
  return { kind: 'writing', sentence: `正在写第 ${from}–${to} 章，已 ${m} 分钟${p.phase === 'closing' ? '（收尾阶段）' : ''}` };
}

function bufferFullSentence(i: V3StatusInput): string {
  if (i.publishMode === 'manual' || !i.nextRelease) return '存稿已满，等你发布';
  return `存稿已满，下次发布 ${fmtWhen(i.nextRelease, i.now, i.tz)}`;
}

export function v3Status(i: V3StatusInput): V3Status {
  const { book, meta, flowTask: t, now } = i;
  // 1–4. 书的状态
  if (book.status === 'archived') return make('archived', '已归档', i);
  if (book.status === 'completed') {
    let s = `已完结，共 ${book.accepted} 章 ${wan(book.totalCjk)} 万字`;
    if (meta.completedNote === 'short') s += '（篇幅偏短）';
    if (meta.completedReason === 'backstop') s += '（写到上限后强制收尾）';
    const left = book.accepted - book.published;
    if (left > 0) s += i.nextRelease && i.publishMode !== 'manual' ? `，还有 ${left} 章待发布，下次 ${fmtWhen(i.nextRelease, now, i.tz)}` : `，还有 ${left} 章待发布`;
    const notes = meta.completedNote === 'short' ? ['篇幅偏短：完结时不到目标字数的六成。'] : [];
    return make('completed', s, i, { since: meta.completedAt ?? null, until: left > 0 ? i.nextRelease : null, notes });
  }
  if (book.status === 'draft') return make('draft', '还没开始', i);
  if (book.status === 'paused') return make('paused', '已暂停', i);
  // 5. 回退中
  if (meta.rewinding) return make('rewinding', `正在回退到第 ${meta.rewinding.to} 章`, i, { since: meta.rewinding.at || null });
  // 6. 收稿连续出错
  if (meta.pending && meta.pending.failures >= 3) return make('needs_owner', `收稿出错 ${meta.pending.failures} 次，等你处理（重试或放弃）`, i);
  // 6b. 任务被拦下（路由被拦、根 AGENTS.md 被手改）：不会自己恢复
  if (t && t.state === 'blocked') {
    if (t.waitReason === 'agents_md_edit') return make('needs_owner', '根 AGENTS.md 被手动修改，等你处理', i);
    return make('needs_owner', '没有可用的写作账号，等你处理', i, { notes: t.waitReason && t.waitReason !== 'waiting' ? [t.waitReason.slice(0, 200)] : [] });
  }
  // 存稿已满：与 decide.ts 的 bufferStop 同口径（发布器按存稿上限停了生产，要回落到 resume_buffer 才恢复）
  const bufferFull = book.accepted - book.published >= i.maxBuffer || book.pausedReason === 'max_buffer';
  // 7. AGENTS.md 超过 harness 的硬上限，没有启动
  if (meta.agentsSize?.hard && t && t.state === 'waiting' && (t.waitReason ?? '').startsWith('AGENTS.md ')) {
    const a = meta.agentsSize;
    return make('needs_owner', `指令太长：AGENTS.md 有 ${a.bytes} 字节，超过 ${a.harness} 的上限 ${a.limit}，没有启动；请精简全局、题材或本书指令`, i, { until: t.notBefore });
  }
  // 8. 正在跑
  if (t && RUNNING.includes(t.state)) {
    if (t.state === 'finalizing' || !i.run || !i.run.startedAt) return make('harvesting', '正在收稿入库', i);
    const r = runningSentence(i, t);
    return make(r.kind, r.sentence, i, { since: i.run.startedAt });
  }
  // 9. 等到某个时刻
  if (t && t.state === 'waiting' && t.notBefore && Date.parse(t.notBefore) > now.getTime()) {
    const until = t.notBefore;
    if ((t.lastErrorClass && QUOTA_CLASSES.includes(t.lastErrorClass)) || i.accountSleep) {
      const at = i.accountSleep && Date.parse(i.accountSleep.until) > Date.parse(until) ? i.accountSleep.until : until;
      return make('waiting_quota', `等额度，约 ${approxWhen(at, now, i.tz)} 恢复`, i, { until: at });
    }
    if (i.authBad) return make('needs_owner', '账号登录失效，等你处理', i);
    const why = t.waitReason ?? '';
    const when = fmtWhen(until, now, i.tz);
    if (why.startsWith('路由等待')) return make('waiting_account', `等账号空出来，${when} 再看`, i, { until });
    if (why.startsWith('无可用路由')) return make('waiting_account', `没有可用的账号或路由（熔断或 harness 不可用），${when} 再看`, i, { until, notes: [why.slice(0, 200)] });
    if (why === 'budget' || why.startsWith(BUDGET_WAIT_PREFIX)) return make('waiting_retry', `本书预算已到上限，${when} 再看`, i, { until });
    if (why.startsWith('v3：上一次运行还在收尾')) return make('harvesting', '上一次运行还在收尾', i, { until });
    if (why.startsWith('v3：')) return make('waiting_retry', `收稿出错（第 ${meta.pending?.failures ?? 1} 次），${when} 重试`, i, { until, notes: [why.slice('v3：'.length, 200)] });
    if (why === 'run killed before start') return make('waiting_retry', `上一次运行在启动前被中断，${when} 重试`, i, { until });
    if (why === BUFFER_FULL_WAIT || (bufferFull && t.lastErrorClass === null && (t.waitReason === null || t.waitReason === 'waiting'))) return make('buffer_full', bufferFullSentence(i), i, { until: i.nextRelease });
    if (why === NO_PROSE_WAIT) return make('waiting_retry', `上一次没写出合格的新章，${when} 再试`, i, { until });
    // 认不出的原因：只说在等，不说成作者写得不合格
    const shown = why && why !== 'waiting' ? `（${why.length > 40 ? `${why.slice(0, 40)}…` : why}）` : '';
    return make('waiting_retry', `等待中${shown}，${when} 再试`, i, { until });
  }
  // 10. 到点了，排队
  if (t && QUEUED.includes(t.state)) {
    if (i.accountSleep) return make('waiting_quota', `等额度，约 ${approxWhen(i.accountSleep.until, now, i.tz)} 恢复`, i, { until: i.accountSleep.until });
    return make('queued', '排队中，等账号空出来', i);
  }
  // 11. 没有任务
  if (bufferFull) return make('buffer_full', bufferFullSentence(i), i, { until: i.nextRelease });
  return make('idle', '等待排班', i);
}
