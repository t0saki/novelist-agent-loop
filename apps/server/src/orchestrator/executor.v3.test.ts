import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { books, inbox, tasks } from '../db/schema.js';
import { BUDGET_WAIT_PREFIX } from '../flow/contract.js';
import { bookRetro, bookWrite } from '../flow/handlers.js';
import { readV3Meta } from '../flow/state.js';
import { addV3Book } from '../flow/testing-book.js';
import type { TaskRow, TaskSpec } from '../runtime/types.js';
import { enqueueSpec, execEnv, executeTask, finishTask, v3RunBusy, type ExecEnv } from './executor.js';
import { claimNext } from './queue.js';
import { saveSlots } from './routing.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const row = (p: Partial<{ id: string; state: string; leaseOwner: string | null; leaseExpiresAt: string | null }> = {}) => ({ id: 'r1', state: 'exited', leaseOwner: 'me', leaseExpiresAt: new Date(NOW + 30_000).toISOString(), ...p });
const ctx = (finalizing: string[] = []) => ({ owner: 'me', nowMs: NOW, finalizing: new Set(finalizing) });

describe('v3RunBusy: a pending whose run is still being finalized is not consumed', () => {
  it('active run states are busy', () => {
    for (const state of ['preparing', 'spawned', 'running']) expect(v3RunBusy(row({ state }), ctx())).toBe(true);
  });
  it('a run this process is still finishing (exited, harvest in progress) is busy', () => {
    expect(v3RunBusy(row({ state: 'killed' }), ctx(['r1']))).toBe(true);
    expect(v3RunBusy(row({ state: 'exited' }), ctx(['r1']))).toBe(true);
  });
  it('exited/killed with a live lease held by another process is busy; expired lease (crashed owner) is not', () => {
    expect(v3RunBusy(row({ leaseOwner: 'other' }), ctx())).toBe(true);
    expect(v3RunBusy(row({ leaseOwner: 'other', leaseExpiresAt: new Date(NOW - 1).toISOString() }), ctx())).toBe(false);
  });
  it('own exited run that is not being finished any more (crash hook), finalized, lost or missing rows are consumable', () => {
    expect(v3RunBusy(row(), ctx())).toBe(false);
    expect(v3RunBusy(row({ state: 'finalized', leaseOwner: 'other' }), ctx())).toBe(false);
    expect(v3RunBusy(row({ state: 'lost', leaseOwner: 'other' }), ctx())).toBe(false);
    expect(v3RunBusy(null, ctx())).toBe(false);
  });
});

describe('removeStrayInstructionFiles: committed harness instruction files never reach a v3 run', () => {
  it('removes override / local / nested instruction files, keeps instructions/, hidden dirs and work/', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { removeStrayInstructionFiles } = await import('./executor.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-stray-'));
    const put = async (rel: string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), 'x\n');
    };
    const gone = ['AGENTS.override.md', 'GEMINI.md', 'CLAUDE.local.md', 'manuscript/CLAUDE.md', 'notes/Agents.Override.md'];
    const kept = ['AGENTS.md', 'CLAUDE.md', 'instructions/AGENTS.md', '.claude/CLAUDE.md', 'work/t/AGENTS.md', 'manuscript/c00001.md'];
    for (const p of [...gone, ...kept]) await put(p);
    try {
      expect((await removeStrayInstructionFiles(dir)).sort()).toEqual([...gone].sort());
      for (const p of gone) await expect(fs.stat(path.join(dir, p))).rejects.toThrow();
      for (const p of kept) expect((await fs.stat(path.join(dir, p))).isFile()).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('v3 route failures, budgets and inbox policy (DB)', () => {
  let t: OrchTestEnv;
  let env: ExecEnv;
  beforeEach(async () => {
    t = await createOrchTestEnv({ pipeline: { handlers: { 'book.write': bookWrite, 'book.retro': bookRetro } } });
    env = execEnv(t.deps);
  });
  afterEach(async () => {
    await t.close();
  });

  const openInbox = async () => t.db.select().from(inbox).where(eq(inbox.state, 'open'));
  async function enqueue(bookId: string, spec: Omit<TaskSpec, 'bookId'>): Promise<string> {
    const book = await env.pipe.openBook(env.pdeps, bookId);
    return (await enqueueSpec(env, { deps: env.pdeps, book }, { ...spec, bookId })).id;
  }
  /** 认领 → 执行 → 完成（与调度器的 dispatchOne 相同的顺序） */
  async function runOnce(): Promise<TaskRow | null> {
    const task = await claimNext(t.db, { owner: t.deps.owner, leaseMs: 60_000 });
    if (!task) return null;
    const result = await executeTask(t.deps, task, new AbortController().signal);
    await finishTask(t.deps, task, result);
    return (await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0] as TaskRow;
  }
  const write = (from: number, instance = 'x'): Omit<TaskSpec, 'bookId'> => ({ kind: 'book.write', target: `batch-c${String(from).padStart(5, '0')}`, lane: 'write', params: { mode: 'write', from, count: 2, instance } });
  /** 写作位置指向一个不存在的 profile：没有恢复时刻的“没有可用模型” */
  const noWriter = () => saveSlots(t.db, { writer: { primary: 'gone-profile', fallback: null }, utility: { primary: 'fake', fallback: null } });

  it('no usable profile → waiting 10 min + one no_route:<book> item (merged across tasks, only "知道了"), never blocked', async () => {
    await noWriter();
    const b = await addV3Book(t, 'nr', { chapters: 2, title: '雨夜来客' });
    const t1 = await enqueue(b.id, write(3, 'a'));
    const r1 = await runOnce();
    expect(r1?.state).toBe('waiting');
    expect(r1?.waitReason).toMatch(/^无可用路由（disabled）：写作位置无可用模型：profile gone-profile 不存在/);
    expect(Date.parse(r1?.notBefore ?? '') - Date.now()).toBeGreaterThan(9 * 60_000);
    let items = await openInbox();
    expect(items.map((i) => i.dedupeKey)).toEqual([`no_route:${b.id}`]);
    expect(items[0]).toMatchObject({ kind: 'block', bookId: b.id, title: '《雨夜来客》没有可用的写作账号', relatedTaskId: t1 });
    expect((items[0]?.actions as { id: string }[]).map((a) => a.id)).toEqual(['dismiss']);
    await t.db.update(tasks).set({ state: 'cancelled' }).where(eq(tasks.id, t1));
    const t2 = await enqueue(b.id, write(3, 'b'));
    expect((await runOnce())?.state).toBe('waiting');
    items = await openInbox();
    expect(items).toHaveLength(1);
    expect(items[0]?.relatedTaskId).toBe(t2);
  });

  it('a book.retro without a route just waits: no inbox item, not failed', async () => {
    await noWriter();
    const batchLog = [1, 2, 3, 4].map((i) => ({ runId: `r${i}`, kind: 'write' as const, from: 2 * i - 1, to: 2 * i, baseCommit: 'b', finalCommit: 'f', at: '2026-11-10T00:00:00.000Z' }));
    const b = await addV3Book(t, 'rf', { chapters: 8, length: 'long', planned: 30, meta: { batchLog } });
    await enqueue(b.id, { kind: 'book.retro', target: 'retro-c00008', lane: 'write', params: { mode: 'retro', from: 1, to: 8, instance: 'x' } });
    expect((await runOnce())?.state).toBe('waiting');
    expect(await openInbox()).toEqual([]);
    const meta = readV3Meta((await t.db.select().from(books).where(eq(books.id, b.id)))[0]?.meta);
    expect(meta.retro.lastStatus).toBeNull();
  });

  it('book budget reached → waiting with the budget sentence (book budgets stay enforced for v3)', async () => {
    const b = await addV3Book(t, 'bud', { chapters: 2 });
    const yaml = (await b.repo.readFile('book.yaml')) as string;
    await b.repo.writeFiles([{ path: 'book.yaml', content: `${yaml.trimEnd()}\nbudgets:\n  monthly_usd_cap: 0\n` }]);
    const head = await b.repo.commit({ message: 'owner: budget', trailers: { 'Novelist-Owner-Edit': 'true' } });
    await t.db.update(books).set({ headCommit: head }).where(eq(books.id, b.id));
    await enqueue(b.id, write(3));
    const r = await runOnce();
    expect(r?.state).toBe('waiting');
    expect(r?.waitReason).toBe(`${BUDGET_WAIT_PREFIX}已达月度 USD 上限 0`);
    expect(await openInbox()).toEqual([]);
  });
});
