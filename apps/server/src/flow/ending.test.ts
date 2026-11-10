import { describe, expect, it } from 'vitest';
import { decideNext, endingPhase } from './decide.js';
import { planHarvest } from './map.js';
import { chapterText, file, mapInput, notesFor, orderSpec } from './testing.js';

const finale = orderSpec({ mode: 'finale', from: 11, count: 5, finale: true, accepted: 10, planned: 15 });
const ch = (n: number, marker = false, chars = 3200) => file(`manuscript/c${String(n).padStart(5, '0')}.md`, `${chapterText(n, chars).trimEnd()}${marker ? '\n\n（全书完）\n' : '\n'}`);
const batch = (from: number, to: number, markerOn: number[] = []) => [...Array.from({ length: to - from + 1 }, (_, i) => ch(from + i, markerOn.includes(from + i))), ...notesFor(from, to)];

describe('ending rules (phase 1)', () => {
  it('finale with marker on last chapter → completed \'marker\', marker kept on own line', () => {
    const p = planHarvest(mapInput({ order: finale, files: batch(11, 15, [15]) }));
    expect(p.completed).toBe('marker');
    const last = p.newChapters[p.newChapters.length - 1];
    expect(last?.no).toBe(15);
    expect(last?.content.endsWith('。\n\n（全书完）\n')).toBe(true);
    expect(p.newChapters.slice(0, -1).every((c) => !c.content.includes('全书完'))).toBe(true);
    expect(p.finaleNoMarker).toBe(0);
  });
  it('inline marker at the end of the last paragraph also counts', () => {
    const f = ch(15);
    f.text = f.text.replace(/。\s*$/u, '。（全书完）\n');
    const p = planHarvest(mapInput({ order: orderSpec({ ...finale, from: 15, count: 1, accepted: 14 }), files: [f, ...notesFor(15, 15)] }));
    expect(p.completed).toBe('marker');
    expect(p.newChapters[0]?.content.endsWith('\n\n（全书完）\n')).toBe(true);
  });
  it('finale without marker → not completed, finaleNoMarker 1, decide → finale again', () => {
    const p = planHarvest(mapInput({ order: finale, files: batch(11, 15) }));
    expect(p.completed).toBe(false);
    expect(p.finaleNoMarker).toBe(1);
    const next = decideNext({ status: 'active', accepted: 15, published: 10, planned: 15, batch: 5, length: 'medium', maxBuffer: 15, productionPaused: false, activeFlowTask: false, pending: false });
    expect(next).toEqual({ kind: 'write', mode: 'finale', phase: 'normal', forced: false, from: 16, count: 1 });
    expect(p.hints.find((h) => h.kind === 'finale_no_marker')).toMatchObject({ chapter: 15 });
  });
  it('second finale without marker → not completed, finaleNoMarker 2, finale_no_marker hint (no_marker_twice is gone)', () => {
    const order = orderSpec({ ...finale, from: 16, count: 1, accepted: 15 });
    const p = planHarvest(mapInput({ order, runawayFactor: 2, meta: { finaleNoMarker: 1 }, files: batch(16, 16) }));
    expect(p.completed).toBe(false);
    expect(p.finaleNoMarker).toBe(2);
    expect(p.finaleNoMarkerAlert).toBeUndefined();
    expect(p.newChapters[0]?.content.includes('全书完')).toBe(false);
    const h = p.hints.find((x) => x.kind === 'finale_no_marker');
    expect(h).toMatchObject({ chapter: 16 });
    expect(h?.rewrite).toBeUndefined();
    expect(h?.text).toBe('上一批写到第 16 章，没有写"（全书完）"。故事如果已经写完，只要在第 16 章末尾单独一行补上"（全书完）"；还没写完，就接着写到结局。');
  });
  it('factor 0: second marker-less finale → finaleNoMarkerAlert once, not on the third', () => {
    const order = orderSpec({ ...finale, from: 16, count: 1, accepted: 15 });
    const second = planHarvest(mapInput({ order, runawayFactor: 0, meta: { finaleNoMarker: 1 }, files: batch(16, 16) }));
    expect(second.completed).toBe(false);
    expect(second.finaleNoMarkerAlert).toBe(true);
    const third = planHarvest(mapInput({ order: orderSpec({ ...finale, from: 17, count: 1, accepted: 16 }), runawayFactor: 0, meta: { finaleNoMarker: 2, finaleNoMarkerAlerted: true }, files: batch(17, 17) }));
    expect(third.finaleNoMarker).toBe(3);
    expect(third.finaleNoMarkerAlert).toBeUndefined();
    expect(third.completed).toBe(false);
  });
  it('finale that lands nothing does not advance finaleNoMarker', () => {
    const p = planHarvest(mapInput({ order: finale, meta: { finaleNoMarker: 1 }, files: [file('notes/progress.md', '想了想', { isNew: false, baseText: '旧' })] }));
    expect(p.completed).toBe(false);
    expect(p.finaleNoMarker).toBe(1);
    // 截断的唯一一章：没有入库，也不推进
    const t = ch(11);
    t.text = t.text.replace(/。\s*$/u, '，他');
    const q = planHarvest(mapInput({ order: finale, meta: { finaleNoMarker: 1 }, files: [t] }));
    expect(q.newChapters).toEqual([]);
    expect(q.finaleNoMarker).toBe(1);
  });
  it('marker in non-finale with k < planned → stripped + early_end hint with rewrite', () => {
    const p = planHarvest(mapInput({ files: batch(6, 10, [8]) }));
    expect(p.completed).toBe(false);
    expect(p.newChapters.every((c) => !c.content.includes('全书完'))).toBe(true);
    const h = p.hints.find((x) => x.kind === 'early_end');
    expect(h).toMatchObject({ chapter: 8, rewrite: 8 });
    expect(h?.text).toBe('第 8 章出现了"（全书完）"，但还没到结局批，标记已删除。先改写第 8 章的后半，不收束，接着 outline.md 的下一段往下写。');
    expect(p.finaleNoMarker).toBe(0);
  });
  it('marker in non-finale on last chapter with k ≥ planned → completed \'marker\'', () => {
    const order = orderSpec({ from: 6, count: 5, accepted: 5, planned: 10 });
    const p = planHarvest(mapInput({ order, files: batch(6, 10, [10]) }));
    expect(p.completed).toBe('marker');
    expect(p.newChapters[4]?.content.endsWith('（全书完）\n')).toBe(true);
    expect(p.hints.find((x) => x.kind === 'early_end')).toBeUndefined();
    // planned 由本次 outline.md 更新后再比较：计划改成 20 章，第 10 章的标记就算早收
    const later = planHarvest(mapInput({ order, plannedInitial: 10, files: [...batch(6, 10, [10]), file('outline.md', '计划：共 20 章', { isNew: false, baseText: '计划：共 10 章' })] }));
    expect(later.completed).toBe(false);
    expect(later.plannedChapters).toBe(20);
    expect(later.hints.find((x) => x.kind === 'early_end')).toMatchObject({ chapter: 10 });
  });
  it('marker in a non-last chapter of finale → stripped there', () => {
    const p = planHarvest(mapInput({ order: finale, files: batch(11, 15, [13, 15]) }));
    expect(p.completed).toBe('marker');
    expect(p.newChapters.find((c) => c.no === 13)?.content.includes('全书完')).toBe(false);
    expect(p.hints.find((x) => x.kind === 'early_end')).toBeUndefined();
  });
  it('open-short counts as finale', () => {
    const order = orderSpec({ mode: 'open-short', kind: 'book.open', from: 1, count: 4, finale: true, accepted: 0, planned: 4 });
    const files = [1, 2, 3, 4].map((n) => ch(n, n === 4));
    const p = planHarvest(mapInput({ order, length: 'short', files: [...files, file('notes/progress.md', '写完了')] }));
    expect(p.completed).toBe('marker');
    const miss = planHarvest(mapInput({ order, length: 'short', files: [1, 2].map((n) => ch(n)) }));
    expect(miss.completed).toBe(false);
    expect(miss.finaleNoMarker).toBe(1);
  });
});

describe('ending rules: review fixes', () => {
  const short4 = orderSpec({ mode: 'finale', from: 5, count: 1, finale: true, accepted: 4, planned: 4 });
  const c4 = chapterText(4);
  const marked4 = (base = c4) => file('manuscript/c00004.md', `${base.trimEnd()}\n\n（全书完）\n`, { isNew: false, baseText: base });

  it('finale that only adds （全书完） to the last accepted chapter → completed on that chapter, marker written into it', () => {
    const p = planHarvest(mapInput({ order: short4, files: [marked4(), file('notes/progress.md', '写完了。', { isNew: false, baseText: '旧' })] }));
    expect(p.completed).toBe('marker');
    expect(p.completedOn).toBe(4);
    expect(p.finaleNoMarker).toBe(0);
    expect(p.newChapters).toEqual([]);
    expect(p.rewrites.map((r) => r.no)).toEqual([4]);
    expect(p.rewrites[0]?.content.endsWith('。\n\n（全书完）\n')).toBe(true);
    expect(p.rewrites[0]?.content.startsWith('# 第4章 章名4\n\n')).toBe(true);
    expect(p.hints.map((h) => h.kind)).not.toContain('unauthorized_edit');
  });
  it('same on a published chapter: book completes, the chapter text is not touched', () => {
    const p = planHarvest(mapInput({ order: short4, frozen: { publishedThrough: 4, locked: [] }, files: [marked4()] }));
    expect(p.completed).toBe('marker');
    expect(p.completedOn).toBe(4);
    expect(p.rewrites).toEqual([]);
  });
  it('marker on the old last chapter while new chapters land without one → hint, normal no-marker rule', () => {
    const p = planHarvest(mapInput({ order: short4, files: [marked4(), ch(5), ...notesFor(5, 5)] }));
    expect(p.completed).toBe(false);
    expect(p.completedOn).toBeUndefined();
    expect(p.finaleNoMarker).toBe(1);
    expect(p.hints.find((h) => h.kind === 'end_marker')?.chapter).toBe(4);
  });
  it('finale whose tail was cut into drafts/ keeps finaleNoMarker and the marker in the draft', () => {
    const order = orderSpec({ mode: 'finale', from: 13, count: 3, finale: true, accepted: 12, planned: 15 });
    const c14 = ch(14);
    c14.text = c14.text.replace(/。\s*$/u, '，他推开门\n');
    for (const before of [0, 1]) {
      const p = planHarvest(mapInput({ order, meta: { finaleNoMarker: before }, files: [ch(13), c14, ch(15, true), ...notesFor(13, 15, 12)] }));
      expect(p.newChapters.map((c) => c.no)).toEqual([13]);
      expect(p.completed).toBe(false);
      expect(p.finaleNoMarker).toBe(before);
      expect(p.tail.find((t) => t.path === 'drafts/c00015.md')?.content?.endsWith('\n（全书完）\n')).toBe(true);
    }
  });
  it('other end-of-book spellings are recognised: ——全书完——, （全书终）, and a final （完） in a finale', () => {
    const order = orderSpec({ ...finale, from: 15, count: 1, accepted: 14 });
    for (const end of ['\n\n——全书完——\n', '\n\n（全书终）\n', '\n\n（完）\n', '——全书完——\n']) {
      const f = ch(15);
      f.text = `${f.text.trimEnd()}${end}`;
      const p = planHarvest(mapInput({ order, files: [f, ...notesFor(15, 15)] }));
      expect(p.completed, end).toBe('marker');
      expect(p.newChapters[0]?.content.endsWith('。\n\n（全书完）\n'), end).toBe(true);
      expect(p.newChapters[0]?.content.includes('——'), end).toBe(false);
    }
  });
  it('（完） in a normal batch is still just a chapter tail note', () => {
    const write = orderSpec({ from: 6, count: 1, accepted: 5 });
    const f = ch(6);
    f.text = `${f.text.trimEnd()}\n\n（完）\n`;
    const p = planHarvest(mapInput({ order: write, files: [f, ...notesFor(6, 6)] }));
    expect(p.completed).toBe(false);
    expect(p.hints.map((h) => h.kind)).not.toContain('early_end');
    expect(p.newChapters[0]?.content.includes('完）')).toBe(false);
  });
});

describe('ending rules (phase 2): 60 % floor, backstop, runaway count', () => {
  const total = (p: ReturnType<typeof planHarvest>, before: number) => before + p.newChapters.reduce((s, c) => s + c.cjk, 0);
  const pPrime = (planned: number, last: number, sum: number, o = { target: 60000, batch: 5, min: 3000 }) => Math.max(planned, last + Math.max(o.batch, Math.ceil((o.target - sum) / Math.max(sum / last, o.min))));

  it('finale marker on last, total ≥ 60% → completed marker (long too), no completedNote', () => {
    const p = planHarvest(mapInput({ order: orderSpec({ ...finale, totalCjk: 30000 }), length: 'long', files: batch(11, 15, [15]) }));
    expect(p.completed).toBe('marker');
    expect(p.completedNote).toBeUndefined();
    expect(p.shortEndUsed).toBe(false);
  });
  it('long finale marker, total < 60%, first time → not completed, marker stripped, end_too_short hint with rewrite, shortEndUsed, plannedFloor/plannedChapters = P′', () => {
    const p = planHarvest(mapInput({ order: finale, length: 'long', files: batch(11, 15, [15]) }));
    const sum = total(p, 18000);
    expect(sum).toBeLessThan(36000);
    const want = pPrime(15, 15, sum);
    expect(p.completed).toBe(false);
    expect(p.newChapters.map((c) => c.no)).toEqual([11, 12, 13, 14, 15]);
    expect(p.newChapters.every((c) => !c.content.includes('全书完'))).toBe(true);
    expect(p.shortEndUsed).toBe(true);
    expect(p.plannedFloor).toBe(want);
    expect(p.plannedChapters).toBe(want);
    expect(p.finaleNoMarker).toBe(0);
    const h = p.hints.find((x) => x.kind === 'end_too_short');
    expect(h).toMatchObject({ chapter: 15, rewrite: 15 });
    expect(h?.text).toBe(`第 15 章写了"（全书完）"，但全书篇幅还不到目标的六成，标记已删除。先改写第 15 章的后半，不收束，给后面留出情节；再把 outline.md 里的计划改为"计划：共 ${want} 章"，按大纲接着往下写。`);
    expect(p.hints.map((x) => x.kind)).not.toContain('early_end');
    expect(p.hints.map((x) => x.kind)).not.toContain('finale_no_marker');
  });
  it('long, second short ending (shortEndUsed) → completed marker + completedNote short', () => {
    const p = planHarvest(mapInput({ order: finale, length: 'long', meta: { shortEndUsed: true, plannedFloor: 24 }, files: batch(11, 15, [15]) }));
    expect(p.completed).toBe('marker');
    expect(p.completedNote).toBe('short');
    expect(p.newChapters[4]?.content.endsWith('（全书完）\n')).toBe(true);
    expect(p.shortEndUsed).toBe(true);
    expect(p.plannedFloor).toBe(24);
  });
  it('medium short ending → completed + completedNote short', () => {
    const p = planHarvest(mapInput({ order: finale, length: 'medium', files: batch(11, 15, [15]) }));
    expect(p.completed).toBe('marker');
    expect(p.completedNote).toBe('short');
    expect(p.shortEndUsed).toBe(false);
  });
  it('epic same as long', () => {
    const p = planHarvest(mapInput({ order: finale, length: 'epic', files: batch(11, 15, [15]) }));
    expect(p.completed).toBe(false);
    expect(p.shortEndUsed).toBe(true);
    expect(p.hints.find((x) => x.kind === 'end_too_short')?.chapter).toBe(15);
  });
  it('a non-finale batch that ends on the last planned chapter, long < 60% → end_too_short, not early_end', () => {
    const order = orderSpec({ from: 6, count: 5, accepted: 5, planned: 10 });
    const p = planHarvest(mapInput({ order, length: 'long', plannedInitial: 10, files: batch(6, 10, [10]) }));
    expect(p.completed).toBe(false);
    expect(p.hints.map((x) => x.kind)).toEqual(expect.arrayContaining(['end_too_short']));
    expect(p.hints.map((x) => x.kind)).not.toContain('early_end');
  });
  it('forced finale without marker that lands chapters → completed backstop (completedNote when short)', () => {
    const order = orderSpec({ ...finale, forced: true, totalCjk: 50000 });
    const p = planHarvest(mapInput({ order, length: 'long', runawayFactor: 1, files: batch(11, 15) }));
    expect(p.completed).toBe('backstop');
    expect(p.completedNote).toBeUndefined();
    expect(p.newChapters[4]?.content.includes('全书完')).toBe(false);
    expect(p.hints.map((x) => x.kind)).not.toContain('finale_no_marker');
    const short = planHarvest(mapInput({ order: orderSpec({ ...finale, forced: true }), length: 'long', runawayFactor: 1, files: batch(11, 15) }));
    expect(short).toMatchObject({ completed: 'backstop', completedNote: 'short' });
  });
  it('forced finale with a too-short marker still completes (forced skips the 60% rule)', () => {
    const p = planHarvest(mapInput({ order: orderSpec({ ...finale, forced: true }), length: 'long', runawayFactor: 1, files: batch(11, 15, [15]) }));
    expect(p.completed).toBe('marker');
  });
  it('forced finale that lands nothing → not completed', () => {
    const order = orderSpec({ ...finale, forced: true });
    const p = planHarvest(mapInput({ order, length: 'long', runawayFactor: 1, files: [file('notes/progress.md', '想了想', { isNew: false, baseText: '旧' })] }));
    expect(p.completed).toBe(false);
    const t = ch(11);
    t.text = t.text.replace(/。\s*$/u, '，他');
    const q = planHarvest(mapInput({ order, length: 'long', runawayFactor: 1, files: [t] }));
    expect(q.completed).toBe(false);
  });
  it('finale only marks last accepted chapter, long < 60% → no rewrite, end_too_short with rewrite', () => {
    const order = orderSpec({ mode: 'finale', from: 5, count: 1, finale: true, accepted: 4, planned: 4 });
    const c4 = chapterText(4);
    const f = file('manuscript/c00004.md', `${c4.trimEnd()}\n\n（全书完）\n`, { isNew: false, baseText: c4 });
    const p = planHarvest(mapInput({ order, length: 'long', plannedInitial: 4, files: [f, file('notes/progress.md', '写完了。', { isNew: false, baseText: '旧' })] }));
    expect(p.completed).toBe(false);
    expect(p.completedOn).toBeUndefined();
    expect(p.rewrites).toEqual([]);
    expect(p.hints.find((h) => h.kind === 'end_too_short')).toMatchObject({ chapter: 4, rewrite: 4 });
    expect(p.shortEndUsed).toBe(true);
    expect(p.plannedChapters).toBe(pPrime(4, 4, 18000));
    // 末章已发布：不授权改写
    const pub = planHarvest(mapInput({ order, length: 'long', plannedInitial: 4, frozen: { publishedThrough: 4, locked: [] }, files: [f] }));
    expect(pub.hints.find((h) => h.kind === 'end_too_short')?.rewrite).toBeUndefined();
  });
  it('runawayBatches counts landed batches at ≥ factor·base and resets to 0 below it', () => {
    // 计划 20（作者合法的计划最多到基准的两倍）：20 ≥ 2 × max(10, ⌈20/2⌉)
    const over = orderSpec({ from: 21, count: 2, accepted: 20, planned: 20, batch: 2 });
    expect(planHarvest(mapInput({ order: over, runawayFactor: 2, runawayBase: 10, meta: { runawayBatches: 1 }, files: batch(21, 22) })).runawayBatches).toBe(2);
    // nothing landed: unchanged
    expect(planHarvest(mapInput({ order: over, runawayFactor: 2, runawayBase: 10, meta: { runawayBatches: 1 }, files: [file('notes/progress.md', '想想', { isNew: false, baseText: '旧' })] })).runawayBatches).toBe(1);
    // below the line (owner raised the target → base 15): reset
    expect(planHarvest(mapInput({ order: over, runawayFactor: 2, runawayBase: 15, meta: { runawayBatches: 3 }, files: batch(21, 22) })).runawayBatches).toBe(0);
    // factor 0: always 0
    expect(planHarvest(mapInput({ order: over, runawayFactor: 0, runawayBase: 10, meta: { runawayBatches: 3 }, files: batch(21, 22) })).runawayBatches).toBe(0);
  });
  it('safety net: the backstop line is factor × max(base, ⌈planned/2⌉), so a plan the author was allowed to set is never cut short', () => {
    // 基准 10、计划 40（例如旧数据），factor 2：写到 20 还不算失控（线在 40）
    const o = orderSpec({ from: 21, count: 2, accepted: 20, planned: 40, batch: 2 });
    expect(planHarvest(mapInput({ order: o, runawayFactor: 2, runawayBase: 10, meta: { runawayBatches: 1 }, files: batch(21, 22) })).runawayBatches).toBe(0);
  });
  it('upper clamp of the outline plan: with the backstop on it stays within warn line + three batches (no contradiction with "三批之内收尾")', () => {
    // N0 50、batch 5、factor 2：提醒线 75，上限 min(100, 75 + 15) = 90
    const plan = (n: number, factor: number) => planHarvest(mapInput({ plannedInitial: 50, runawayFactor: factor, order: orderSpec({ batch: 5, planned: 50 }), files: [file('outline.md', `计划：共 ${n} 章\n`, { isNew: false, baseText: '旧' })] })).plannedChapters;
    expect(plan(100, 2)).toBe(90);
    expect(plan(80, 2)).toBe(80);
    // 兜底关闭：照旧 2·N0
    expect(plan(100, 0)).toBe(100);
  });
  it('owner raised the target (N0 15 → 38, plannedFloor 38): an outline still saying 15 chapters keeps planned at 38, and the next order is a normal write', () => {
    const p = planHarvest(mapInput({ plannedInitial: 38, runawayFactor: 2, meta: { plannedFloor: 38 }, order: orderSpec({ batch: 5, planned: 38, accepted: 10, from: 11, count: 5 }), files: [file('outline.md', '计划：共 15 章\n', { isNew: false, baseText: '计划：共 15 章\n' })] }));
    expect(p.plannedChapters ?? 38).toBe(38);
    expect(endingPhase({ length: 'medium', accepted: 10, planned: 38, runawayBase: 38, batch: 5, factor: 2, runawayBatches: 0 })).toMatchObject({ mode: 'write', phase: 'normal' });
  });
  it('outline plan below plannedFloor clamped up; plannedFloor also raises the upper clamp', () => {
    const plan = (n: number, floor: number | null) => planHarvest(mapInput({ plannedInitial: 15, meta: { plannedFloor: floor }, files: [file('outline.md', `计划：共 ${n} 章\n`, { isNew: false, baseText: '旧' })] })).plannedChapters;
    expect(plan(20, 25)).toBe(25);
    expect(plan(40, 25)).toBe(30);
    expect(plan(45, 40)).toBe(40);
    expect(plan(20, null)).toBe(20);
  });
});
