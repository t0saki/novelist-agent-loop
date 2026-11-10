import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLegacyBook } from '../book/testing-legacy.js';
import { addV3Book } from '../flow/testing-book.js';
import { createOrchTestEnv, type OrchTestEnv } from '../orchestrator/testing.js';
import { nextTasks, onTaskDone } from './next.js';
import type { PipelineContext, TaskRow } from './types.js';

let t: OrchTestEnv;
beforeEach(async () => {
  t = await createOrchTestEnv();
});
afterEach(async () => {
  await t.close();
});

const deps = (): PipelineContext['deps'] => ({ db: t.db, config: t.config, paths: t.paths, log: t.deps.log, now: () => new Date() });
const ctxOf = async (id: string): Promise<PipelineContext> => ({ deps: deps(), book: await t.pipeline.openBook(deps(), id) });

describe('runtime nextTasks / onTaskDone', () => {
  it('no book → []; legacy book (even active) → []; archived v3 → []', async () => {
    expect(await nextTasks({ deps: deps(), book: null })).toEqual([]);
    const legacy = await createLegacyBook(t.db, t.paths, 'old', { status: 'active', pausedReason: null });
    expect(await nextTasks({ deps: deps(), book: (await ctxOf(legacy.id)).book })).toEqual([]);
    const archived = await addV3Book(t, 'arch', { chapters: 2, status: 'archived' });
    expect(await nextTasks({ deps: deps(), book: (await ctxOf(archived.id)).book })).toEqual([]);
  });

  it('a v3 book delegates to nextTasksV3 (one book.write for the next batch)', async () => {
    const b = await addV3Book(t, 'v3n', { chapters: 2, batch: 3 });
    const specs = await nextTasks({ deps: deps(), book: (await ctxOf(b.id)).book });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ kind: 'book.write', bookId: b.id, lane: 'write' });
    expect(specs[0]?.params).toMatchObject({ from: 3 });
  });

  it('onTaskDone: v3 kinds that finished done → next batch; removed kinds, other states, no book → []', async () => {
    const b = await addV3Book(t, 'v3d', { chapters: 2 });
    const ctx = { deps: deps(), book: (await ctxOf(b.id)).book };
    const row = (kind: string) => ({ id: 'x', kind, bookId: b.id, target: 'book', params: {} }) as unknown as TaskRow;
    expect(await onTaskDone(ctx, row('book.write'), { status: 'done' })).toHaveLength(1);
    expect(await onTaskDone(ctx, row('book.write'), { status: 'waiting' })).toEqual([]);
    expect(await onTaskDone(ctx, row('chapter.accept'), { status: 'done' })).toEqual([]);
    expect(await onTaskDone({ deps: deps(), book: null }, row('book.write'), { status: 'done' })).toEqual([]);
  });
});
