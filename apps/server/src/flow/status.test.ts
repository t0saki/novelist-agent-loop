/** p2-plan §6 WP-4：状态句（§5.8 每一行一个用例）与 fmtWhen */
import { describe, expect, it } from 'vitest';
import { BUDGET_WAIT_PREFIX, BUFFER_FULL_WAIT, NO_PROSE_WAIT } from './contract.js';
import { emptyV3Meta } from './state.js';
import { fmtWhen, v3Status, type V3StatusInput } from './status.js';
import type { V3BookMeta } from './types.js';

const TZ = 'Asia/Shanghai';
// 2026-11-10 10:00 北京时间
const NOW = new Date('2026-11-10T02:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const later = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

type Task = NonNullable<V3StatusInput['flowTask']>;
function input(o: { book?: Partial<V3StatusInput['book']>; meta?: Partial<V3BookMeta>; task?: Partial<Task> | null; run?: V3StatusInput['run']; rest?: Partial<V3StatusInput> } = {}): V3StatusInput {
  return {
    book: { status: 'active', pausedReason: null, accepted: 10, published: 4, totalCjk: 45_000, targetCjk: 60_000, ...o.book },
    meta: { ...emptyV3Meta(), ...o.meta },
    publishMode: 'scheduled',
    maxBuffer: 15,
    flowTask: o.task === undefined || o.task === null ? null : { kind: 'book.write', state: 'running', notBefore: null, lastErrorClass: null, waitReason: null, params: {}, ...o.task },
    run: o.run ?? null,
    accountSleep: null,
    authBad: false,
    nextRelease: later(22 * 60), // 明天 08:00
    now: NOW,
    tz: TZ,
    ...o.rest,
  };
}
const s = (o: Parameters<typeof input>[0]) => v3Status(input(o));

describe('fmtWhen', () => {
  it('today / tomorrow / a date in Asia/Shanghai', () => {
    expect(fmtWhen('2026-11-10T06:20:00.000Z', NOW, TZ)).toBe('今天 14:20');
    expect(fmtWhen('2026-11-11T00:00:00.000Z', NOW, TZ)).toBe('明天 08:00');
    expect(fmtWhen('2026-11-12T00:00:00.000Z', NOW, TZ)).toBe('11月12日 08:00');
    // 北京时间已是第二天凌晨：按 tz 算“今天”
    expect(fmtWhen('2026-11-10T16:30:00.000Z', new Date('2026-11-10T16:00:00.000Z'), TZ)).toBe('今天 00:30');
  });
});

describe('v3Status (§5.8)', () => {
  it('opening (long and short)', () => {
    expect(s({ book: { accepted: 0, published: 0 }, task: { kind: 'book.open', params: { mode: 'open-long', count: 5 } }, run: { state: 'running', startedAt: ago(9) } })).toMatchObject({ kind: 'opening', sentence: '正在开书，写第 1–5 章，已 9 分钟' });
    expect(s({ book: { accepted: 0, published: 0 }, task: { kind: 'book.open', params: { mode: 'open-short', count: 4 } }, run: { state: 'running', startedAt: ago(0.2) } }).sentence).toBe('正在开书，写整本，已 1 分钟');
  });

  it('writing, closing appends （收尾阶段）', () => {
    expect(s({ task: { params: { mode: 'write', from: 13, count: 5, phase: 'normal' } }, run: { state: 'running', startedAt: ago(9) } })).toMatchObject({ kind: 'writing', sentence: '正在写第 13–17 章，已 9 分钟', since: ago(9) });
    expect(s({ task: { params: { mode: 'write', from: 13, count: 5, phase: 'closing' } }, run: { state: 'running', startedAt: ago(9) } }).sentence).toBe('正在写第 13–17 章，已 9 分钟（收尾阶段）');
  });

  it('finale', () => {
    expect(s({ task: { params: { mode: 'finale', from: 16, count: 2 } }, run: { state: 'running', startedAt: ago(3) } })).toMatchObject({ kind: 'finale', sentence: '正在写结局（第 16 章起），已 3 分钟' });
  });

  it('retro', () => {
    expect(s({ task: { kind: 'book.retro', params: { mode: 'retro', from: 1, to: 10 } }, run: { state: 'running', startedAt: ago(12) } })).toMatchObject({ kind: 'retro', sentence: '正在复盘第 1–10 章，已 12 分钟' });
  });

  it('harvesting: finalizing, or leased without a run yet', () => {
    expect(s({ task: { state: 'finalizing', params: { mode: 'write', from: 1, count: 2 } }, run: { state: 'running', startedAt: ago(3) } })).toMatchObject({ kind: 'harvesting', sentence: '正在收稿入库' });
    expect(s({ task: { state: 'leased' }, run: null }).kind).toBe('harvesting');
  });

  it('queued', () => {
    expect(s({ task: { state: 'ready' } })).toMatchObject({ kind: 'queued', sentence: '排队中，等账号空出来' });
    expect(s({ task: { state: 'waiting', notBefore: ago(1) } }).kind).toBe('queued');
  });

  it('waiting_quota: today shows only the time inside 约 …', () => {
    expect(s({ task: { state: 'waiting', notBefore: '2026-11-10T06:20:00.000Z', lastErrorClass: 'quota' } })).toMatchObject({ kind: 'waiting_quota', sentence: '等额度，约 14:20 恢复' });
    expect(s({ task: { state: 'waiting', notBefore: later(30) }, rest: { accountSleep: { until: '2026-11-11T00:00:00.000Z', reason: 'quota' } } }).sentence).toBe('等额度，约 明天 08:00 恢复');
    expect(s({ task: { state: 'ready' }, rest: { accountSleep: { until: '2026-11-10T06:20:00.000Z', reason: 'rate_limit' } } }).kind).toBe('waiting_quota');
  });

  it('waiting_account', () => {
    expect(s({ task: { state: 'waiting', notBefore: '2026-11-10T06:20:00.000Z', waitReason: '路由等待：账号已满' } })).toMatchObject({ kind: 'waiting_account', sentence: '等账号空出来，今天 14:20 再看' });
  });

  it('waiting_retry: only the judge ladder says "没写出合格的新章"', () => {
    expect(s({ task: { state: 'waiting', notBefore: '2026-11-10T06:20:00.000Z', lastErrorClass: null, waitReason: NO_PROSE_WAIT } })).toMatchObject({ kind: 'waiting_retry', sentence: '上一次没写出合格的新章，今天 14:20 再试' });
  });

  it('waiting reasons that are not about the prose get their own sentence; unknown ones a neutral one', () => {
    const w = (waitReason: string, extra: Record<string, unknown> = {}) => s({ task: { state: 'waiting', notBefore: '2026-11-10T06:20:00.000Z', lastErrorClass: null, waitReason }, ...extra });
    expect(w('无可用路由（circuit）：熔断')).toMatchObject({ kind: 'waiting_account', sentence: '没有可用的账号或路由（熔断或 harness 不可用），今天 14:20 再看' });
    expect(w(`${BUDGET_WAIT_PREFIX}本书今天的预算用完了`)).toMatchObject({ kind: 'waiting_retry', sentence: '本书预算已到上限，今天 14:20 再看' });
    expect(w('budget').sentence).toBe('本书预算已到上限，今天 14:20 再看');
    expect(w('v3：上一次运行还在收尾')).toMatchObject({ kind: 'harvesting', sentence: '上一次运行还在收尾' });
    const pending = { taskId: 't', runId: 'r', stage: 'harvested', snapshotDir: '/x', failures: 2, lastError: 'boom' } as unknown as V3BookMeta['pending'];
    expect(w('v3：git 锁超时', { meta: { pending } })).toMatchObject({ kind: 'waiting_retry', sentence: '收稿出错（第 2 次），今天 14:20 重试' });
    expect(w('run killed before start').sentence).toBe('上一次运行在启动前被中断，今天 14:20 重试');
    expect(w('something else')).toMatchObject({ kind: 'waiting_retry', sentence: '等待中（something else），今天 14:20 再试' });
    expect(w('waiting').sentence).toBe('等待中，今天 14:20 再试');
    // 存稿满了跳过（order.ts 的 buffer_full）：哪怕存稿已回落到上限以下（pausedReason 还在）
    expect(w(BUFFER_FULL_WAIT, { book: { accepted: 14, published: 5 } }).kind).toBe('buffer_full');
  });

  it('pausedReason max_buffer inside the resume band (buffer < max_buffer, no task) → buffer_full, not idle', () => {
    expect(s({ book: { accepted: 19, published: 5, pausedReason: 'max_buffer' }, task: null }).kind).toBe('buffer_full');
    expect(s({ book: { accepted: 19, published: 5 }, task: null }).kind).toBe('idle');
  });

  it('blocked task (routing blocked, root AGENTS.md hand-edited) → needs_owner', () => {
    expect(s({ task: { state: 'blocked', waitReason: 'agents_md_edit' } })).toMatchObject({ kind: 'needs_owner', sentence: '根 AGENTS.md 被手动修改，等你处理' });
    expect(s({ task: { state: 'blocked', waitReason: '账号 a 被避开' } })).toMatchObject({ kind: 'needs_owner', sentence: '没有可用的写作账号，等你处理', notes: ['账号 a 被避开'] });
  });

  it('needs_owner: pending failures, bad login, AGENTS.md over the hard limit', () => {
    const pending = { taskId: 't', runId: 'r', stage: 'harvested', snapshotDir: '/x', failures: 3, lastError: 'boom' } as unknown as V3BookMeta['pending'];
    expect(s({ meta: { pending }, task: { state: 'blocked' } })).toMatchObject({ kind: 'needs_owner', sentence: '收稿出错 3 次，等你处理（重试或放弃）' });
    expect(s({ task: { state: 'waiting', notBefore: later(60) }, rest: { authBad: true } })).toMatchObject({ kind: 'needs_owner', sentence: '账号登录失效，等你处理' });
    const agentsSize = { bytes: 40_000, hard: true, limit: 32_768, harness: 'agy', at: ago(5), layers: [{ layer: '全局', bytes: 30_000 }] };
    expect(s({ meta: { agentsSize }, task: { state: 'waiting', notBefore: later(55), waitReason: 'AGENTS.md 40000 字节，超过 agy 的上限 32768' } })).toMatchObject({
      kind: 'needs_owner',
      sentence: '指令太长：AGENTS.md 有 40000 字节，超过 agy 的上限 32768，没有启动；请精简全局、题材或本书指令',
    });
    // 只是超过 16 KB（没超硬上限）：照常显示等待
    expect(s({ meta: { agentsSize: { ...agentsSize, hard: false } }, task: { state: 'waiting', notBefore: later(55), waitReason: 'AGENTS.md 40000 字节' } }).kind).toBe('waiting_retry');
  });

  it('rewinding', () => {
    expect(s({ meta: { rewinding: { to: 8, ts: '20261110T020000', at: ago(1) } }, task: null })).toMatchObject({ kind: 'rewinding', sentence: '正在回退到第 8 章' });
  });

  it('buffer_full: with the next release, manual mode, and the stale buffer_full wait', () => {
    expect(s({ book: { accepted: 20, published: 5 } })).toMatchObject({ kind: 'buffer_full', sentence: '存稿已满，下次发布 明天 08:00' });
    expect(s({ book: { accepted: 20, published: 5 }, rest: { publishMode: 'manual', nextRelease: null } }).sentence).toBe('存稿已满，等你发布');
    expect(s({ book: { accepted: 20, published: 5 }, task: { state: 'waiting', notBefore: later(30), waitReason: 'waiting' } }).kind).toBe('buffer_full');
  });

  it('paused / archived / draft / idle', () => {
    expect(s({ book: { status: 'paused' } })).toMatchObject({ kind: 'paused', sentence: '已暂停' });
    expect(s({ book: { status: 'archived' } })).toMatchObject({ kind: 'archived', sentence: '已归档' });
    expect(s({ book: { status: 'draft', accepted: 0, published: 0 } })).toMatchObject({ kind: 'draft', sentence: '还没开始' });
    expect(s({})).toMatchObject({ kind: 'idle', sentence: '等待排班' });
  });

  it('completed: plain, short, backstop, unpublished remainder', () => {
    expect(s({ book: { status: 'completed', accepted: 16, published: 16, totalCjk: 78_000 } }).sentence).toBe('已完结，共 16 章 7.8 万字');
    const r = s({ book: { status: 'completed', accepted: 30, published: 20, totalCjk: 31_000 }, meta: { completedNote: 'short', completedReason: 'backstop' } });
    expect(r.sentence).toBe('已完结，共 30 章 3.1 万字（篇幅偏短）（写到上限后强制收尾），还有 10 章待发布，下次 明天 08:00');
    expect(r.notes.length).toBeGreaterThan(0);
    expect(s({ book: { status: 'completed', accepted: 4, published: 0, totalCjk: 20_800 }, rest: { publishMode: 'manual', nextRelease: null } }).sentence).toBe('已完结，共 4 章 2.1 万字，还有 4 章待发布');
  });

  it('batchNote note within 7 days only', () => {
    const note = { from: 5, to: 4, steps: 230, runId: 'r', at: ago(60) };
    expect(s({ meta: { batchNote: note } }).notes).toEqual(['上一批用了 230 步，每批章数已从 5 减到 4。']);
    expect(s({ meta: { batchNote: { ...note, at: ago(8 * 24 * 60) } } }).notes).toEqual([]);
  });
});
