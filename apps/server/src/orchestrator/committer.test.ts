import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest, TaskRow } from '../runtime/types.js';
import { TRAILER } from '../book/trailers.js';
import { chapters, tasks } from '../db/schema.js';
import { addV3Book } from '../flow/testing-book.js';
import { commitOwnerEdit, recoverBook, StaleBaseError, withRepoLock } from './committer.js';
import { taskTrailerValue } from './orch-state.js';
import { enqueue, setTaskState } from './queue.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv();
});
afterEach(async () => {
  await t.close();
});

const emptyManifest: Manifest = { hard: {}, soft: {}, configHash: '' };

async function setup(manifest: Manifest = emptyManifest): Promise<{ task: TaskRow; repo: Awaited<ReturnType<typeof addV3Book>>['repo']; bookId: string; head: string; dir: string }> {
  const b = await addV3Book(t, 'b1', { chapters: 2 });
  await enqueue(t.db, { id: 'tk1', baseCommit: b.head, manifest, spec: { kind: 'book.write', bookId: b.id, target: 'book', lane: 'write' } });
  const task = (await t.db.select().from(tasks).where(eq(tasks.id, 'tk1')))[0] as TaskRow;
  return { task, repo: b.repo, bookId: b.id, head: b.head, dir: b.dir };
}

describe('git locks', () => {
  it('崩溃残留的 .git/index.lock 清理后重试一次，主人提交不被卡死', async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.dir, '.git', 'index.lock'), '');
    const r = await commitOwnerEdit(t.db, s.repo, s.bookId, { files: [{ path: 'notes/a.md', content: 'x\n' }], message: 'owner edit', baseSha: null });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await s.repo.readFile('notes/a.md', r.commit)).toBe('x\n');
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
});

describe('crash recovery (v3 tasks)', () => {
  it('finalizing + committed Novelist-Task trailer → ready with a replay marker, tree untouched', async () => {
    const s = await setup();
    await s.repo.writeFiles([{ path: 'manuscript/c00003.md', content: '# 第3章\n\n正文。\n' }]);
    const commit = await s.repo.commit({ message: 'book.write c00003', trailers: { [TRAILER.task]: taskTrailerValue('tk1', undefined) } });
    await setTaskState(t.db, 'tk1', 'finalizing');
    await t.db.update(tasks).set({ leaseOwner: 'dead', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(tasks.id, 'tk1'));
    const out = await recoverBook(t.db, s.repo, s.bookId);
    expect(out).toMatchObject({ replayed: ['tk1'], reset: false });
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'tk1')))[0] as TaskRow;
    expect(row.state).toBe('ready');
    expect((row.params._orch as { recover?: { mode: string; commit?: string } }).recover).toEqual({ mode: 'replay', commit });
    expect(await s.repo.head()).toBe(commit);
  });

  it('finalizing + not committed → reset --hard clears the half-written tree, repromote marker', async () => {
    const s = await setup();
    await setTaskState(t.db, 'tk1', 'finalizing');
    await s.repo.writeFiles([{ path: 'notes/out.md', content: 'partial' }]);
    expect(await s.repo.isClean()).toBe(false);
    const out = await recoverBook(t.db, s.repo, s.bookId);
    expect(out.reset).toBe(true);
    expect(await s.repo.isClean()).toBe(true);
    expect(await s.repo.head()).toBe(s.head);
    const row = (await t.db.select().from(tasks).where(eq(tasks.id, 'tk1')))[0] as TaskRow;
    expect(row.state).toBe('ready');
    expect((row.params._orch as { recover?: { mode: string } }).recover?.mode).toBe('repromote');
  });

  it('nothing finalizing → no lock, no reset', async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.dir, 'dirty.txt'), 'x');
    expect(await recoverBook(t.db, s.repo, s.bookId)).toEqual({ replayed: [], reset: false });
    expect(await fs.readFile(path.join(s.dir, 'dirty.txt'), 'utf8')).toBe('x');
  });

  it('removes stale file lock left by a crashed process', async () => {
    const s = await setup();
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
    const s = await setup({ hard: { 'outline.md': 'old' }, soft: {}, configHash: '' });
    await t.db.insert(chapters).values({ bookId: s.bookId, no: 9, chapterId: 'c00009' });
    const r = await commitOwnerEdit(t.db, s.repo, s.bookId, { files: [{ path: 'outline.md', content: '计划：共 20 章\n' }], message: 'owner edit', baseSha: null });
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
