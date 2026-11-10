import { describe, expect, it } from 'vitest';
import { decideNext } from './decide.js';
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
    expect(next).toEqual({ kind: 'write', mode: 'finale', from: 16, count: 1 });
  });
  it('second finale without marker that lands ≥1 chapter → completed \'no_marker_twice\'', () => {
    const order = orderSpec({ ...finale, from: 16, count: 1, accepted: 15 });
    const p = planHarvest(mapInput({ order, meta: { finaleNoMarker: 1 }, files: batch(16, 16) }));
    expect(p.completed).toBe('no_marker_twice');
    expect(p.finaleNoMarker).toBe(2);
    expect(p.newChapters[0]?.content.includes('全书完')).toBe(false);
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
