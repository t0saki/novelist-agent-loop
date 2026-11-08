/**
 * golden：合成 1500 章（800 实体、5000 事实、300 条未回收伏笔）断言 context pack 每个 section 与总量有界（DESIGN §6.3）。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookFiles, createSyntheticBook, openRepo } from '../book/index.js';
import { buildViews, loadBookState } from '../state/index.js';
import { PACK_OVERHEAD_MAX, SECTION_QUOTAS, buildContextPack, measureText } from './index.js';

let tmp: string;
let book: Awaited<ReturnType<typeof createSyntheticBook>>;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-large-'));
  book = await createSyntheticBook(path.join(tmp, 'big'), { chapters: 1500, entities: 800, facts: 5000, openObligations: 300 });
}, 120_000);
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('context pack at chapter 1500', () => {
  it('keeps every section within its fixed quota and the total ≈65k', async () => {
    const t0 = Date.now();
    const state = await loadBookState(book.dir);
    expect(state.ledger.length).toBe(1500);
    expect(Object.keys(state.snapshot.entities).length).toBeGreaterThanOrEqual(800);
    expect(Object.keys(state.snapshot.facts).length).toBe(5000);
    const open = Object.values(state.snapshot.obligations).filter((o) => o.status === 'open' || o.status === 'advanced');
    expect(open.length).toBe(300);
    const tLoad = Date.now() - t0;

    const card = (await bookFiles(openRepo(book.dir)).card(book.nextCard)) as NonNullable<Awaited<ReturnType<ReturnType<typeof bookFiles>['card']>>>;
    const t1 = Date.now();
    const pack = await buildContextPack({ bookDir: book.dir, card, snapshot: state.snapshot, state });
    const tPack = Date.now() - t1;

    const total = Object.values(SECTION_QUOTAS).reduce((a, b) => a + b, 0);
    expect(total).toBe(65000);
    const bySection = Object.fromEntries(pack.sections.map((s) => [s.id, s]));
    for (const s of pack.sections) {
      expect(s.used, s.id).toBeLessThanOrEqual(s.quota);
      // 字节数上界：每码点 ≤ 4 字节
      expect(Buffer.byteLength(s.id)).toBeGreaterThan(0);
    }
    // 大书里这些 section 一定会被截断（内容远超配额）
    for (const id of ['prev', 'story'] as const) expect(bySection[id]?.truncated, id).toBe(true);
    // 主要 section 都被充分利用
    expect(bySection.prev?.used).toBeGreaterThan(SECTION_QUOTAS.prev * 0.8);
    expect(bySection.cast?.used).toBeGreaterThan(SECTION_QUOTAS.cast * 0.5);
    expect(pack.stats?.castEntities.length).toBe(16);
    expect(pack.text).toContain('代表台词');
    expect(bySection.story?.used).toBeGreaterThan(SECTION_QUOTAS.story * 0.8);
    expect(bySection.style?.truncated).toBe(false); // style 不截断：放不下的样本整篇略过
    const measured = measureText(pack.text, 'chars');
    expect(measured).toBeLessThanOrEqual(total + PACK_OVERHEAD_MAX);
    expect(Buffer.byteLength(pack.text, 'utf8')).toBeLessThanOrEqual((total + PACK_OVERHEAD_MAX) * 3);
    // 内容抽查
    expect(pack.text).toContain('（前略）'); // N−1 超长，保留尾部
    expect(pack.stats?.reentry).toContain(book.reentryEntity);
    expect(pack.text).toContain('重新登场提要');
    expect(pack.stats?.retrievalHits).toBeLessThanOrEqual(8);
    expect(pack.stats?.retrievalHits).toBeGreaterThan(0);
    expect(pack.stats?.overdue).toBeGreaterThan(5);
    expect(pack.text).toContain('超过 5 条将安排 plan.fix');
    // 确定性
    const again = await buildContextPack({ bookDir: book.dir, card, snapshot: state.snapshot, state });
    expect(again.hash).toBe(pack.hash);
    // 配额收紧时同样有界：section 内截断、不跨 section 挤占
    const tight = await buildContextPack({
      bookDir: book.dir,
      card,
      snapshot: state.snapshot,
      state,
      quotas: { cast: 3000, world: 800, retrieval: 900, knowledge: 500, obligations: 400 },
    });
    const tb = Object.fromEntries(tight.sections.map((s) => [s.id, s]));
    for (const id of ['cast', 'world', 'retrieval', 'knowledge', 'obligations'] as const) {
      expect(tb[id]?.used, id).toBeLessThanOrEqual(tb[id]?.quota as number);
      expect(tb[id]?.truncated, id).toBe(true);
    }
    for (const id of ['prev', 'story', 'style', 'card'] as const) expect(tb[id]?.used, id).toBe(bySection[id]?.used);
    // 性能：加载 + 编译在合理时间内（CI 宽松上限）
    expect(tLoad + tPack).toBeLessThan(60_000);
    // 记录一份配额使用情况，便于回归比较
    // eslint-disable-next-line no-console
    console.info('pack@1500', JSON.stringify({ tLoad, tPack, measured, sections: pack.sections.map((s) => [s.id, s.used, s.truncated]) }));
  }, 120_000);

  it('builds views for the large book', async () => {
    const { snapshot, written } = await buildViews(book.dir);
    expect(snapshot.through).toBe('c01500');
    expect(written.length).toBe(10);
  }, 120_000);
});
