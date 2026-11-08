import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countHan, zEntity } from '@novelist/shared';
import { bookFiles, createFixtureBook, createRunSnapshot, createSyntheticBook, openRepo, P, removeRunSnapshot } from '../book/index.js';
import { buildViews, loadBookState } from '../state/index.js';
import {
  SECTION_QUOTAS,
  buildAliasIndex,
  buildCheckSlice,
  buildContextPack,
  chunkChapter,
  createBm25Index,
  fillBlocks,
  loadBm25Index,
  measureText,
  rebuildIndex,
  syncIndex,
  tokenize,
  truncateCjk,
} from './index.js';

let tmp: string;
let fxDir: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-ctx-'));
  fxDir = path.join(tmp, 'fx');
  await createFixtureBook(fxDir, { accepted: 3, cards: 6 });
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('truncateCjk', () => {
  const text = '第一段一二三四五。\n\n第二段六七八九十。\n\n第三段甲乙丙丁戊。';
  it('keeps whole paragraphs from head or tail', () => {
    expect(truncateCjk(text, 100)).toEqual({ text, truncated: false });
    const h = truncateCjk(text, 20);
    expect(h.truncated).toBe(true);
    expect(h.text.startsWith('第一段')).toBe(true);
    expect(countHan(h.text)).toBeLessThanOrEqual(20);
    const t = truncateCjk(text, 20, 'tail');
    expect(t.text.endsWith('甲乙丙丁戊。')).toBe(true);
    expect(t.text.startsWith('第二段')).toBe(true);
  });
  it('cuts inside an oversized paragraph at sentence ends, then by char', () => {
    const p = '一二三四五。六七八九十。甲乙丙丁戊。';
    expect(truncateCjk(p, 10).text).toBe('一二三四五。六七八九十。');
    expect(truncateCjk(p, 10, 'tail').text).toBe('六七八九十。甲乙丙丁戊。');
    expect(countHan(truncateCjk('一二三四五六七八九十', 4).text)).toBe(4);
    expect(measureText(truncateCjk('abcdefghij', 4, 'head', 'chars').text, 'chars')).toBe(4);
  });
  it('fillBlocks gives short blocks their full length and splits the rest', () => {
    const r = fillBlocks(['短', '长'.repeat(100), '长'.repeat(100)], 60, '\n');
    expect(r.truncated).toBe(true);
    expect(measureText(r.text, 'chars')).toBeLessThanOrEqual(60);
    expect(r.text.startsWith('短\n')).toBe(true);
  });
});

describe('alias index', () => {
  const ents = [
    zEntity.parse({
      id: 'char.lin-feng',
      kind: 'character',
      name: '林枫',
      aliases: [{ text: '枫哥' }, { text: '小林', ambiguous: true }, { text: '师兄', ambiguous: true, scope: { pov: 'char.su-wan' } }],
    }),
    zEntity.parse({ id: 'char.su-wan', kind: 'character', name: '苏婉', aliases: ['婉儿'] }),
    zEntity.parse({ id: 'char.lin-hai', kind: 'character', name: '林海', aliases: [{ text: '师兄', ambiguous: true }] }),
    zEntity.parse({ id: 'loc.qingyun', kind: 'location', name: '青云宗', aliases: ['青云'] }),
  ];
  const idx = buildAliasIndex(ents);
  it('finds two-character names with leftmost-longest matching', () => {
    const ms = idx.scan('林枫来到青云宗，婉儿迎了上来。');
    expect(ms.map((m) => [m.entity, m.alias])).toEqual([
      ['char.lin-feng', '林枫'],
      ['loc.qingyun', '青云宗'],
      ['char.su-wan', '婉儿'],
    ]);
    expect(ms[0]?.start).toBe(0);
    expect(ms[1]?.end).toBe(7);
  });
  it('drops ambiguous mentions unless disambiguated', () => {
    const t1 = '远处有个小林子。';
    expect(idx.resolve(idx.scan(t1), t1, [])).toEqual([]);
    const t2 = '小林笑道：“走吧。”';
    expect(idx.resolve(idx.scan(t2), t2, []).map((m) => m.entity)).toEqual(['char.lin-feng']);
    const t3 = '苏婉身边的小林子。';
    expect(idx.resolve(idx.scan(t3), t3, []).map((m) => m.entity)).toEqual(['char.su-wan', 'char.lin-feng']);
    const t4 = '一片小林子。';
    expect(idx.resolve(idx.scan(t4), t4, ['char.lin-feng']).map((m) => m.entity)).toEqual(['char.lin-feng']);
  });
  it('shared ambiguous aliases need entities_present or a matching pov scope', () => {
    const t = '师兄来了。';
    const ms = idx.scan(t);
    expect(ms.map((m) => m.entity).sort()).toEqual(['char.lin-feng', 'char.lin-hai']);
    expect(idx.resolve(ms, t, [])).toEqual([]);
    expect(idx.resolve(ms, t, ['char.lin-hai']).map((m) => m.entity)).toEqual(['char.lin-hai']);
    expect(idx.resolve(ms, t, [], { pov: 'char.su-wan' }).map((m) => m.entity)).toEqual(['char.lin-feng']);
    expect(idx.names().get('林枫')).toBe('char.lin-feng');
    expect(idx.aliasesOf?.('char.su-wan')).toEqual(['苏婉', '婉儿']);
  });
});

describe('bm25', () => {
  it('tokenizes Chinese with jieba and ranks relevant paragraphs', () => {
    expect(tokenize('林枫夜渡黑水，伤臂换船。')).toEqual(expect.arrayContaining(['林枫', '黑水']));
    expect(tokenize('的了，。')).toEqual([]);
    const idx = createBm25Index();
    idx.add('c00001#p1', '林枫在渡口看见了那枚铜牌。');
    idx.add('c00001#p2', '苏婉在药房里煎药。');
    idx.add('c00002#p1', '雨夜，渡口的船篷被风吹得哗哗作响。');
    const hits = idx.search('渡口 铜牌', 5);
    expect(hits[0]?.docId).toBe('c00001#p1');
    expect(hits.map((h) => h.docId)).toContain('c00002#p1');
    expect(idx.search('渡口', 5, (id) => !id.startsWith('c00001')).map((h) => h.docId)).toEqual(['c00002#p1']);
    const re = loadBm25Index(JSON.parse(JSON.stringify(idx.toJSON())));
    expect(re.search('渡口 铜牌', 5)).toEqual(hits);
    idx.remove('c00001#p1');
    expect(idx.search('铜牌', 5)).toEqual([]);
  });
  it('chunks chapters and syncs the on-disk index incrementally', async () => {
    const chunks = chunkChapter('c00001', '# 标题\n\n短。\n\n也短。\n\n' + '长'.repeat(200) + '\n' + '宽'.repeat(200));
    expect(chunks.map((c) => c[0])).toEqual(['c00001#p1', 'c00001#p2']);
    expect(chunks[0]?.[1].startsWith('短。\n也短。\n长')).toBe(true);
    const dir = path.join(tmp, 'fx');
    const { docs } = await rebuildIndex(dir);
    expect(docs).toBeGreaterThan(3);
    const idx1 = await syncIndex(dir);
    expect(idx1.size()).toBe(docs);
    await fs.writeFile(path.join(dir, P.manuscript(2)), '改写后的第二章，只剩一段铜牌的事情。\n');
    const idx2 = await syncIndex(dir);
    expect(idx2.docIds().filter((d) => d.startsWith('c00002'))).toEqual(['c00002#p1']);
    await openRepo(dir).resetHard();
    await syncIndex(dir);
  });
});

describe('context pack (edge cases)', () => {
  it('compiles the very first chapter of a book with nothing written yet', async () => {
    const dir = path.join(tmp, 'first');
    await createFixtureBook(dir, { accepted: 0, cards: 2 });
    const state = await loadBookState(dir);
    const card = (await bookFiles(openRepo(dir)).card(1)) as NonNullable<Awaited<ReturnType<ReturnType<typeof bookFiles>['card']>>>;
    const pack = await buildContextPack({ bookDir: dir, card, snapshot: state.snapshot, state });
    expect(pack.sections.find((s) => s.id === 'prev')?.used).toBe(0);
    expect(pack.stats?.retrievalHits).toBe(0);
    for (const s of pack.sections) expect(s.used).toBeLessThanOrEqual(s.quota);
  });

  it('annotates retrieval hits with fact corrections and re-entry briefs with the departure state', async () => {
    const dir = path.join(tmp, 'reentry');
    const book = await createSyntheticBook(dir, { chapters: 170, entities: 80, facts: 100, openObligations: 10, chapterChars: 300 });
    const repo = openRepo(dir);
    const files = bookFiles(repo);
    // 离场（c00100）之后才发生的 offscreen.update
    const lastDelta = JSON.parse((await repo.readFile(P.ledger(170))) as string);
    lastDelta.ops.push({ op: 'offscreen.update', ent: book.reentryEntity, set: { loc: 'loc.moved-away' }, declared_by_card: true });
    await fs.writeFile(path.join(dir, P.ledger(170)), JSON.stringify(lastDelta));
    // 让 c00050 第一段成为 fact 的原始出处，并更正该事实
    const chunk = chunkChapter('c00050', (await repo.readFile(P.manuscript(50))) as string)[0]?.[1] as string;
    const ev = chunk.split('\n')[0]?.slice(0, 18) as string;
    const delta50 = JSON.parse((await repo.readFile(P.ledger(50))) as string);
    delta50.ops.push({ op: 'fact.assert', fact: 'fact.fixed', text: '铜牌出自北境', about: [], ev });
    await fs.writeFile(path.join(dir, P.ledger(50)), JSON.stringify(delta50));
    await fs.appendFile(
      path.join(dir, P.overrides),
      `${JSON.stringify({ schema: 'nv.override/1', id: 'o-fact', ts: '2026-01-02T00:00:00Z', effective_from: 'c00120', target: { kind: 'fact', fact: 'fact.fixed' }, action: 'set', value: '铜牌出自南疆', note: '出处写错', author: 'owner' })}\n`,
    );
    const state = await loadBookState(dir, { noCache: true });
    const card = (await files.card(book.nextCard)) as NonNullable<Awaited<ReturnType<typeof files.card>>>;
    const withQuote = { ...card, callbacks: [{ quote: ev, from: 'c00050' }] } as typeof card;
    const pack = await buildContextPack({ bookDir: dir, card: withQuote, snapshot: state.snapshot, state });
    expect(pack.stats?.reentry).toContain(book.reentryEntity);
    const name = state.snapshot.entities[book.reentryEntity]?.name as string;
    const block = pack.text.slice(pack.text.indexOf(`#### ${name}`));
    const newLoc = 'loc.moved-away';
    expect(block.slice(0, block.indexOf('离场时状态'))).toContain(newLoc); // 当前状态是新位置
    const departure = block.slice(block.indexOf('离场时状态')).split('\n')[0] as string;
    expect(departure).not.toContain(newLoc); // 离场时还在旧位置
    expect(pack.text).toContain('［已更正：见 override #o-fact，正确为 铜牌出自南疆；出处写错］');
  }, 60_000);
});

describe('context pack (fixture)', () => {
  it('compiles all sections within quotas, excludes owner notes, is deterministic', async () => {
    await buildViews(fxDir);
    const files = bookFiles(openRepo(fxDir));
    const card =
      (await files.card(4)) ??
      (() => {
        throw new Error('no card');
      })();
    const state = await loadBookState(fxDir);
    const pack = await buildContextPack({ bookDir: fxDir, card, snapshot: state.snapshot });
    expect(pack.sections.map((s) => s.id)).toEqual(Object.keys(SECTION_QUOTAS));
    for (const s of pack.sections) expect(s.used).toBeLessThanOrEqual(s.quota);
    expect(pack.text).toContain('## 1. 本章卡片');
    expect(pack.text).toContain('c00003 全文');
    expect(pack.text).toContain('……原来是她'); // N−1 全文
    expect(pack.text).toContain('林枫（char.lin-feng）');
    expect(pack.text).toContain('左臂骨折');
    expect(pack.text).toContain('F0001');
    expect(pack.text).toContain('叙述克制');
    expect(pack.text).toContain('禁用：不禁、仿佛');
    expect(pack.stats?.castEntities).toEqual(['char.lin-feng', 'char.su-wan']);
    const card3 = (await files.card(3)) as NonNullable<Awaited<ReturnType<typeof files.card>>>;
    const s2 = (await loadBookState(fxDir, { through: 2 })).snapshot;
    const pack3 = await buildContextPack({ bookDir: fxDir, card: card3, snapshot: s2 });
    expect(pack3.text).not.toContain('这一章节奏放慢'); // owner 笔记走 L3.9，不进 pack
    expect(pack3.text).toContain('尚不知');
    expect(pack3.text).toContain('读者尚不知（不得泄露）');
    const again = await buildContextPack({ bookDir: fxDir, card, snapshot: state.snapshot });
    expect(again.hash).toBe(pack.hash);
    expect(pack.cjk).toBe(countHan(pack.text));
  });

  it('works inside a run snapshot (git worktree) and builds a check slice', async () => {
    const repo = openRepo(fxDir);
    const snap = await createRunSnapshot(fxDir, await repo.head(), path.join(tmp, 'runs/r1/book'));
    try {
      const { snapshot } = await buildViews(snap.dir);
      const card = (await bookFiles(openRepo(snap.dir)).card(4)) as NonNullable<Awaited<ReturnType<ReturnType<typeof bookFiles>['card']>>>;
      const pack = await buildContextPack({ bookDir: snap.dir, card, snapshot });
      expect(pack.sections.find((s) => s.id === 'retrieval')?.used).toBeGreaterThanOrEqual(0);
      const slice = await buildCheckSlice({ bookDir: snap.dir, card, snapshot });
      expect(slice).toContain('受控状态词表');
      expect(slice).toContain('injury.arm.left.fracture：左臂骨折');
      expect(slice).toContain('林枫（char.lin-feng）');
      expect(measureText(slice, 'chars')).toBeLessThan(20000);
    } finally {
      await removeRunSnapshot(snap);
    }
  });
});
