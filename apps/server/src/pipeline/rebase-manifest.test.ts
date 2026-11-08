/** 规划类任务的 soft deps / rebase validators 声明（DESIGN §7.2、附录 B）：真实 handler 的 manifest。Owner: lane E。 */
import { afterEach, describe, expect, it } from 'vitest';
import { P } from '../book/index.js';
import { cardRepair, planFix } from './handlers/plan.js';
import { createMiniBook, runUntilIdle, startBook, type MiniEnv } from './testing.js';

let env: MiniEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe('rebase manifest', () => {
  it('card.repair / plan.fix 把账本列为 soft deps 并声明校验，账本前进时 promote 才会重跑投影校验', async () => {
    env = await createMiniBook({ chapters: 2 });
    await startBook(env);
    await runUntilIdle(env);
    const ctx = await env.ctx();
    const repair = await cardRepair.manifest(ctx, { kind: 'card.repair', bookId: env.bookId, target: 'c00002', params: { cards: ['c00002'] } });
    const ledgerPath = P.ledger(1).replace(/c\d+\.json$/, '');
    expect(Object.keys(repair.soft).some((p) => p.startsWith(ledgerPath))).toBe(true);
    expect(repair.rebaseValidators).toEqual(['card.projected_pre']);
    const fix = await planFix.manifest(ctx, { kind: 'plan.fix', bookId: env.bookId, target: 'book', params: { instance: 'x' } });
    expect(Object.keys(fix.soft).some((p) => p.startsWith(ledgerPath))).toBe(true);
    expect(fix.rebaseValidators).toEqual(['plan.numbering', 'card.projected_pre']);
  }, 180_000);
});
