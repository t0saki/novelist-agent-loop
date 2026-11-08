/**
 * import.bootstrap 的输入是不可信的 v1 正文：路由必须跳过 shell 关不掉的 harness（DESIGN §10.6）。
 * 走真实 executeTask → resolveRoute，不 mock 路由。
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accounts, runs, settings } from '../db/schema.js';
import type { PipelineContext, RunContext, TaskHandler, TaskRow } from '../pipeline/types.js';
import { executeTask } from './executor.js';
import { claimNext, enqueue } from './queue.js';
import { createOrchTestEnv, type OrchTestEnv } from './testing.js';

const manifest = { hard: {}, soft: {}, rebaseValidators: [], configHash: 'c' };

let t: OrchTestEnv;
const chosen: string[] = [];

function extractorHandler(kind: 'import.bootstrap' | 'chapter.extract'): TaskHandler {
  return {
    kind,
    role: 'extractor',
    lane: 'side',
    maxAttempts: 1,
    manifest: async () => ({ hard: {}, soft: {}, rebaseValidators: [], configHash: '' }),
    async prepare(_ctx: PipelineContext, _task: TaskRow, run: RunContext) {
      chosen.push(run.profileId);
      return { kind: 'skip', result: { status: 'done' } };
    },
    finalize: async () => ({ status: 'done' }),
  } as unknown as TaskHandler;
}

async function route(chain: string[]): Promise<void> {
  await t.db.update(settings).set({ value: { presetId: 'fake', overrides: { extractor: { chain, degrade_to: [], constraint: 'none' } } } }).where(eq(settings.key, 'routing.active'));
}

async function run(kind: 'import.bootstrap' | 'chapter.extract') {
  await enqueue(t.db, { id: `t-${kind}`, baseCommit: null, manifest, spec: { kind, bookId: null, target: 'c00001-c00005', lane: 'side' } });
  const task = (await claimNext(t.db, { owner: 'o', leaseMs: 60_000 })) as TaskRow;
  return executeTask(t.deps, task, new AbortController().signal);
}

beforeEach(async () => {
  chosen.length = 0;
  t = await createOrchTestEnv({ pipeline: { handlers: { 'import.bootstrap': extractorHandler('import.bootstrap'), 'chapter.extract': extractorHandler('chapter.extract') } } });
  await t.db.insert(accounts).values({ id: 'cx1', harness: 'codex', label: 'cx1', authMode: 'api_key', enabled: true, body: {} });
});
afterEach(async () => {
  await t.close();
});

describe('import.bootstrap routing', () => {
  it('blocks instead of running when only a shell harness is routable', async () => {
    await route(['cx-sol']);
    const result = await run('import.bootstrap');
    expect(result.status).toBe('blocked');
    expect(result.message).toContain('cx-sol');
    expect(chosen).toEqual([]);
    expect(await t.db.select().from(runs)).toEqual([]);
  });

  it('skips the shell profile and uses the next one in the chain', async () => {
    await route(['cx-sol', 'fake']);
    await run('import.bootstrap');
    expect(chosen).toEqual(['fake']);
  });

  it('leaves other extractor tasks on the shell profile', async () => {
    await route(['cx-sol', 'fake']);
    await run('chapter.extract').catch(() => {});
    expect(chosen).not.toEqual(['fake']);
  });
});
