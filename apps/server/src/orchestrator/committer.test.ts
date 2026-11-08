import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest, PromotePlan, TaskRow } from '../pipeline/types.js';
import { TRAILER } from '../book/trailers.js';
import { books, chapters, tasks } from '../db/schema.js';
import { commitOwnerEdit, mergeAppendOnly, promote, recoverBook, StaleBaseError, withRepoLock } from './committer.js';
import { enqueue, setTaskState } from './queue.js';
import { addFixtureBook, createOrchTestEnv, type OrchTestEnv } from './testing.js';

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv();
});
afterEach(async () => {
  await t.close();
});

const emptyManifest: Manifest = { hard: {}, soft: {}, rebaseValidators: [], configHash: '' };

async function setup(manifest: Manifest = emptyManifest, opts: { cards?: number } = {}): Promise<{ task: TaskRow; repo: Awaited<ReturnType<typeof addFixtureBook>>['repo']; bookId: string; head: string; dir: string }> {
  const b = await addFixtureBook(t, 'b1', opts);
  await enqueue(t.db, { id: 'tk1', baseCommit: b.head, manifest, spec: { kind: 'plan.arc', bookId: b.id, target: 'a0001', lane: 'side' } });
  const task = (await t.db.select().from(tasks).where(eq(tasks.id, 'tk1')))[0] as TaskRow;
  return { task, repo: b.repo, bookId: b.id, head: b.head, dir: b.dir };
}

function plan(s: { bookId: string; head: string }, over: Partial<PromotePlan> = {}): PromotePlan {
  return { bookId: s.bookId, taskId: 'tk1', runId: 'run-1', baseCommit: s.head, files: [{ path: 'notes/out.md', content: 'hello\n' }], resolveTmpIds: false, message: 'plan: test', trailers: {}, tags: [], ...over };
}

describe('promote', () => {
  it('崩溃残留的 .git/index.lock 清理后重试一次，不把书卡死', async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.dir, '.git', 'index.lock'), '');
    const out = await promote(t.db, s.repo, s.task, emptyManifest, plan(s), {});
    expect(out.status).toBe('committed');
  });

  it('recoverBook 在 reset 前清掉 HEAD.lock 和 refs 下的残留锁', async () => {
    const s = await setup();
    await t.db.update(tasks).set({ state: 'finalizing' }).where(eq(tasks.id, 'tk1'));
    await fs.writeFile(path.join(s.dir, '.git', 'HEAD.lock'), '');
    await fs.mkdir(path.join(s.dir, '.git/refs/heads'), { recursive: true });
    await fs.writeFile(path.join(s.dir, '.git/refs/heads/x.lock'), '');
    await fs.writeFile(path.join(s.dir, 'dirty.txt'), 'x');
    const r = await recoverBook(t.db, s.repo, s.bookId);
    expect(r.reset).toBe(true);
    await expect(fs.stat(path.join(s.dir, '.git', 'HEAD.lock'))).rejects.toThrow();
    await expect(fs.stat(path.join(s.dir, '.git/refs/heads/x.lock'))).rejects.toThrow();
  });

  it('soft deps 变化且校验失败：结果拒收，card.projected_pre 失败时提议 card.repair', async () => {
    const s = await setup(emptyManifest, { cards: 3 });
    const shas = await s.repo.blobShas(['book.yaml'], s.head);
    // book.yaml 在 base 之后变化：soft dep 失效
    await s.repo.writeFiles([{ path: 'book.yaml', content: `${(await s.repo.readFile('book.yaml')) ?? ''}\n# changed\n` }]);
    await s.repo.commit({ message: 'owner edit', trailers: {}, paths: ['book.yaml'] });
    const manifest: Manifest = { hard: {}, soft: { 'book.yaml': shas['book.yaml'] ?? '' }, rebaseValidators: ['card.projected_pre'], configHash: '' };
    const bad = `schema: nv.card/1\nid: c00003\ntitle: x\nvolume: v01\narc: a0001\npre:\n  - alive: char.no-such\nbeats:\n  - id: b1\n    cjk: 1000\n    goal: g\nlength: { min: 2400, target: 3000, max: 3600, count_mode: han }\n`;
    const out = await promote(t.db, s.repo, s.task, manifest, plan(s, { files: [{ path: 'plan/cards/c00003.yaml', content: bad }] }), {});
    expect(out.status).toBe('rejected');
    expect(out.followups?.[0]).toMatchObject({ kind: 'card.repair', target: 'c00003' });
    expect(await s.repo.isClean()).toBe(true);
  });

  it('按 trailer 重入时补打缺失的 tag', async () => {
    const s = await setup();
    const p = plan(s, { tags: ['ch/00009'] });
    await promote(t.db, s.repo, s.task, emptyManifest, p, {});
    await s.repo.tag('ch/00009', s.head); // 模拟 tag 指向错误/缺失后重入
    const again = await promote(t.db, s.repo, s.task, emptyManifest, p, {});
    expect(again.replay).toBe(true);
    const log = await s.repo.log({ limit: 1 });
    expect(log.items[0]?.tags).toContain('ch/00009');
  });

  it('commits with trailers, tags, and applies dbEffects once', async () => {
    const s = await setup();
    let effects = 0;
    const p = plan(s, {
      tags: ['ch/00001'],
      dbEffects: async (tx, sha) => {
        effects += 1;
        await tx.update(books).set({ acceptedThrough: 1, headCommit: sha }).where(eq(books.id, s.bookId));
      },
    });
    const out = await promote(t.db, s.repo, s.task, emptyManifest, p, { harness: 'fake', model: 'm', isolation: 'container', instructionsHash: 'h' });
    expect(out.status).toBe('committed');
    expect(effects).toBe(1);
    const log = await s.repo.log({ limit: 1 });
    expect(log.items[0]?.trailers[TRAILER.task]).toBe('tk1');
    expect(log.items[0]?.trailers[TRAILER.harness]).toBe('fake');
    expect(await s.repo.tags('ch/*')).toEqual(['ch/00001']);
    expect((await t.db.select().from(books).where(eq(books.id, s.bookId)))[0]?.acceptedThrough).toBe(1);
    // 重入：按 trailer 判定已提交，只重放 effects（且去重）
    const again = await promote(t.db, s.repo, s.task, emptyManifest, p, {});
    expect(again).toMatchObject({ status: 'committed', replay: true });
    expect(effects).toBe(1);
  });

  it('stale when hard deps changed; rebased (and validators run) when only soft changed', async () => {
    const s = await setup();
    const shas = await s.repo.blobShas(['plan/compass.yaml', 'book.yaml'], s.head);
    const hard = { hard: { 'plan/compass.yaml': shas['plan/compass.yaml'] ?? '' }, soft: { 'book.yaml': shas['book.yaml'] ?? '' }, rebaseValidators: ['card.projected_pre'], configHash: '' };
    await s.repo.writeFiles([{ path: 'book.yaml', content: `${await s.repo.readFile('book.yaml')}\n# soft change\n` }]);
    await s.repo.commit({ message: 'soft', trailers: { [TRAILER.owner]: 'true' } });
    let rebased = 0;
    const r1 = await promote(t.db, s.repo, s.task, hard, plan(s), {}, { rebase: async () => {
      rebased += 1;
      return { ok: true };
    } });
    expect(r1.status).toBe('rebased');
    expect(rebased).toBe(1);

    // hard deps 变了 → stale
    await s.repo.writeFiles([{ path: 'plan/compass.yaml', content: `${await s.repo.readFile('plan/compass.yaml')}\n# hard\n` }]);
    await s.repo.commit({ message: 'hard', trailers: { [TRAILER.owner]: 'true' } });
    await setTaskState(t.db, 'tk1', 'ready');
    const fresh = (await t.db.select().from(tasks).where(eq(tasks.id, 'tk1')))[0] as TaskRow;
    await t.db.update(tasks).set({ params: { _orch: { generation: 2 } } }).where(eq(tasks.id, 'tk1'));
    const staleTask = { ...fresh, params: { _orch: { generation: 2 } } };
    const r2 = await promote(t.db, s.repo, staleTask, hard, plan(s), {});
    expect(r2.status).toBe('stale');
  });

  it('rejected when rebase validators fail, carrying followups', async () => {
    const s = await setup();
    const shas = await s.repo.blobShas(['book.yaml'], s.head);
    await s.repo.writeFiles([{ path: 'book.yaml', content: `${await s.repo.readFile('book.yaml')}\n# x\n` }]);
    await s.repo.commit({ message: 'soft', trailers: { [TRAILER.owner]: 'true' } });
    const r = await promote(t.db, s.repo, s.task, { hard: {}, soft: { 'book.yaml': shas['book.yaml'] ?? '' }, rebaseValidators: ['x'], configHash: '' }, plan(s), {}, { rebase: async () => ({ ok: false, reason: 'no', followups: [{ kind: 'card.repair', bookId: s.bookId, target: 'c00001' }] }) });
    expect(r.status).toBe('rejected');
    expect(r.followups).toHaveLength(1);
  });

  it('write-write conflict: non-jsonl → stale; jsonl → three-way append merge', async () => {
    const s = await setup();
    await s.repo.writeFiles([{ path: 'debt.jsonl', content: '{"a":1}\n' }, { path: 'notes/x.md', content: 'base\n' }]);
    await s.repo.commit({ message: 'seed', trailers: { [TRAILER.owner]: 'true' } });
    const base = await s.repo.head();
    await s.repo.writeFiles([{ path: 'debt.jsonl', content: '{"a":1}\n{"h":2}\n' }, { path: 'notes/x.md', content: 'head\n' }]);
    await s.repo.commit({ message: 'concurrent', trailers: { [TRAILER.owner]: 'true' } });
    const conflict = await promote(t.db, s.repo, s.task, emptyManifest, plan({ bookId: s.bookId, head: base }, { files: [{ path: 'notes/x.md', content: 'mine\n' }] }), {});
    expect(conflict).toMatchObject({ status: 'stale' });
    expect(conflict.reason).toMatch(/write conflict/);
    const merged = await promote(t.db, s.repo, s.task, emptyManifest, plan({ bookId: s.bookId, head: base }, { files: [{ path: 'debt.jsonl', content: '{"a":1}\n{"m":3}\n' }] }), {});
    expect(merged.status).toBe('committed');
    expect((await s.repo.readFile('debt.jsonl'))?.trim().split('\n')).toEqual(['{"a":1}', '{"h":2}', '{"m":3}']);
  });

  it('rejects when root AGENTS.md was edited outside Novelist', async () => {
    const s = await setup();
    await s.repo.writeFiles([{ path: 'AGENTS.md', content: '# hand edit\n' }]);
    await s.repo.commit({ message: 'manual', trailers: {} });
    const out = await promote(t.db, s.repo, s.task, emptyManifest, plan(s), {});
    expect(out).toMatchObject({ status: 'rejected', reason: 'agents_md_edit' });
  });

  it('generation > 1 commits fresh (rewrite with note) instead of replaying', async () => {
    const s = await setup();
    await promote(t.db, s.repo, s.task, emptyManifest, plan(s), {});
    const g2 = { ...s.task, params: { _orch: { generation: 2 } } };
    const out = await promote(t.db, s.repo, g2, emptyManifest, plan({ bookId: s.bookId, head: await s.repo.head() }, { files: [{ path: 'notes/out.md', content: 'rewritten\n' }] }), {});
    expect(out.status).toBe('committed');
    expect(out.replay).toBeUndefined();
    expect(await s.repo.readFile('notes/out.md')).toBe('rewritten\n');
    const log = await s.repo.log({ limit: 1 });
    expect(log.items[0]?.trailers[TRAILER.task]).toBe('tk1.g2');
  });
});

describe('crash recovery', () => {
  it('finalizing + committed → replay marker, effects not double-applied', async () => {
    const s = await setup();
    await promote(t.db, s.repo, s.task, emptyManifest, plan(s), {});
    await setTaskState(t.db, 'tk1', 'finalizing');
    await t.db.update(tasks).set({ leaseOwner: 'dead', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, 'tk1'));
    const out = await recoverBook(t.db, s.repo, s.bookId);
    expect(out).toMatchObject({ replayed: ['tk1'], reset: false });
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'tk1')))[0] as TaskRow;
    expect(row.state).toBe('ready');
    expect((row.params._orch as { recover?: { mode: string } }).recover?.mode).toBe('replay');
  });

  it('finalizing + not committed → reset --hard clears half-written tree, repromote marker', async () => {
    const s = await setup();
    await setTaskState(t.db, 'tk1', 'finalizing');
    await s.repo.writeFiles([{ path: 'notes/out.md', content: 'partial' }]);
    expect(await s.repo.isClean()).toBe(false);
    const out = await recoverBook(t.db, s.repo, s.bookId);
    expect(out.reset).toBe(true);
    expect(await s.repo.isClean()).toBe(true);
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'tk1')))[0] as TaskRow;
    expect(row.state).toBe('ready');
    expect((row.params._orch as { recover?: { mode: string } }).recover?.mode).toBe('repromote');
  });

  it('removes stale file lock left by a crashed process', async () => {
    const s = await setup();
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(path.join(s.dir, '.git', 'novelist.lock'), JSON.stringify({ pid: 999999, inc: 'old', ts: Date.now() }));
    const result = await withRepoLock(t.db, s.bookId, s.repo, async () => 'locked');
    expect(result).toBe('locked');
  });

  it('serializes concurrent lock holders', async () => {
    const s = await setup();
    let active = 0;
    let peak = 0;
    const hold = () =>
      withRepoLock(t.db, s.bookId, s.repo, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
      });
    await Promise.all([hold(), hold(), hold()]);
    expect(peak).toBe(1);
  });
});

describe('owner edit', () => {
  it('commits with owner trailer and invalidates tasks depending on the file', async () => {
    const s = await setup({ hard: { 'plan/compass.yaml': 'old' }, soft: {}, rebaseValidators: [], configHash: '' });
    await t.db.insert(chapters).values({ bookId: s.bookId, no: 1, chapterId: 'c00001' });
    const r = await commitOwnerEdit(t.db, s.repo, s.bookId, { files: [{ path: 'plan/compass.yaml', content: 'schema: x\n' }], message: 'owner edit', baseSha: null });
    expect(r.invalidated).toEqual(['tk1']);
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'tk1')))[0] as TaskRow;
    expect(row.state).toBe('stale');
    const log = await s.repo.log({ limit: 1 });
    expect(log.items[0]?.trailers[TRAILER.owner]).toBe('true');
  });

  it('optimistic concurrency via baseSha', async () => {
    const s = await setup();
    await expect(commitOwnerEdit(t.db, s.repo, s.bookId, { files: [{ path: 'notes/a.md', content: 'x' }], message: 'm', baseSha: 'deadbeef' })).rejects.toBeInstanceOf(StaleBaseError);
    const head = await s.repo.head();
    await expect(commitOwnerEdit(t.db, s.repo, s.bookId, { files: [{ path: 'notes/a.md', content: 'x' }], message: 'm', baseSha: head })).resolves.toBeTruthy();
  });
});

describe('mergeAppendOnly', () => {
  it('appends only lines new relative to base and head', () => {
    expect(mergeAppendOnly('a\n', 'a\nb\n', 'a\nc\n')).toBe('a\nb\nc\n');
    expect(mergeAppendOnly('a\n', 'a\nb\n', 'a\n')).toBe('a\nb\n');
    expect(mergeAppendOnly('', '', 'x\n')).toBe('x\n');
  });
});
