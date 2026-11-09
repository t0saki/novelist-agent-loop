/** 真实 harness 跑《不急》时暴露、fake harness 测不出来的问题 */
import { describe, expect, it } from 'vitest';
import { type Volume, zCompass, zReceipt } from '@novelist/shared';
import { outputBlock, retryHint, schemaBlock } from './common.js';
import { endgameStatus } from './handlers/plan.js';
import type { BookState } from '../state/index.js';
import type { BookHandle, TaskRow } from './types.js';

describe('regressions from the first real run', () => {
  it('工单给出结构化产物的字段，而不只是 schema 名', () => {
    const block = outputBlock([{ path: 'plan/compass.yaml', kind: 'plan_yaml', schema: 'nv.compass/1', required: true }], '/out');
    for (const field of ['logline', 'protagonist_arc', 'final_state', 'main_threads']) expect(block).toContain(field);
    expect(schemaBlock([{ path: 'bible/premise.md', kind: 'markdown', required: true }])).toEqual([]);
  });

  it('所有规划和章节产物的 schema 都能导出且不超限', () => {
    for (const schema of ['nv.compass/1', 'nv.volume/1', 'nv.arc/1', 'nv.card/1', 'nv.entity/1', 'nv.delta/1', 'nv.review/1', 'nv.audit/1']) {
      expect(schemaBlock([{ path: 'x', kind: 'plan_yaml', schema, required: true }]).length, schema).toBeGreaterThan(0);
    }
  });

  it('第二次尝试能收到上一次的错误（tasks.attempts 比 run.attempt 滞后）', () => {
    expect(retryHint({ attempts: 1, lastError: 'compass 不合法' } as TaskRow)).toContain('compass 不合法');
    expect(retryHint({ attempts: 1, lastError: null } as TaskRow)).toBe('');
  });

  it('单卷书开局不算 endgame，没有待收束伏笔时也不按容量触发', () => {
    const book = { config: { scale: { target_cjk: 60000, hard_max_cjk: 90000, chapter_length: { target: 3000 } } }, genre: { pacing: { chapter_length: { target: 3000 } } } } as unknown as BookHandle;
    const state = { snapshot: { total_cjk: 0, obligations: {} }, compass: null } as unknown as BookState;
    expect(endgameStatus(book, state, [{ id: 'v01' } as Volume], 'v01', 0).active).toBe(false);
    expect(endgameStatus(book, state, [{ id: 'v01' } as Volume, { id: 'v02' } as Volume], 'v02', 0).active).toBe(true);
  });

  it('receipt.artifacts 写成路径字符串也接受', () => {
    const r = zReceipt.parse({ schema: 'nv.receipt/1', status: 'done', artifacts: ['plan/compass.yaml', { path: 'b' }] });
    expect(r.artifacts).toEqual([{ path: 'plan/compass.yaml' }, { path: 'b' }]);
  });

  it('模型猜出来的 compass 形状确实被拒绝（文档化当时的失败）', () => {
    expect(zCompass.safeParse({ schema: 'nv.compass/1', protagonist_arc: { stages: [{ id: 's1' }] } }).success).toBe(false);
  });
});
