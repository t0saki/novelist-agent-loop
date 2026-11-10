import { describe, expect, it } from 'vitest';
import { chapterNoFromPath, isChapterCandidate, parseBibleHead, parsePlannedChapters, planHarvest, splitChapters } from './map.js';
import { bodyOf, chapterText, file, mapInput, notesFor, orderSpec, prose } from './testing.js';

const AT = '2026-11-01T00:00:00.000Z';
const nos = (p: ReturnType<typeof planHarvest>) => p.newChapters.map((c) => c.no);
const tailPaths = (p: ReturnType<typeof planHarvest>) => p.tail.map((t) => t.path);
const kinds = (p: ReturnType<typeof planHarvest>) => p.hints.map((h) => h.kind);

describe('path and heading helpers', () => {
  it('chapterNoFromPath', () => {
    expect(chapterNoFromPath('manuscript/c00007.md')).toBe(7);
    expect(chapterNoFromPath('chapters/007.md')).toBe(7);
    expect(chapterNoFromPath('ch7.md')).toBe(7);
    expect(chapterNoFromPath('第七章.md')).toBe(7);
    expect(chapterNoFromPath('第十二章 雨夜.md')).toBe(12);
    expect(chapterNoFromPath('drafts/chapter-07.txt')).toBe(7);
    expect(chapterNoFromPath('notes/chapters.md')).toBeNull();
    expect(chapterNoFromPath('bible.md')).toBeNull();
    expect(chapterNoFromPath('chapters/007.json')).toBeNull();
  });
  it('isChapterCandidate / splitChapters / parsePlannedChapters / parseBibleHead', () => {
    expect(isChapterCandidate('scratch/x.md', `# 第六章 雨夜\n\n${prose(200, 1)}`)).toBe(true);
    expect(isChapterCandidate('scratch/x.md', `# 雨夜\n\n${prose(200, 1)}`)).toBe(false);
    const segs = splitChapters(`前言\n# 第6章 甲\n${prose(300, 61)}\n# 第七章 乙\n${prose(300, 71)}`);
    expect(segs.map((s) => s.headingNo)).toEqual([6, 7]);
    expect(parsePlannedChapters('一些话\n计划：共 18 章\n')).toBe(18);
    expect(parsePlannedChapters('计划共12章')).toBe(12);
    expect(parsePlannedChapters('没有计划')).toBeNull();
    expect(parseBibleHead('# 《长夜》\n一句话：一个人在长夜里等天亮。\n标签：悬疑')).toEqual({ title: '长夜', blurb: '一个人在长夜里等天亮。' });
    expect(parseBibleHead('# 长夜\n一句话：x')).toEqual({ title: null, blurb: 'x' });
  });
});

describe('planHarvest: classification and numbering', () => {
  it('standard manuscript path accepted', () => {
    const p = planHarvest(mapInput({ files: [6, 7, 8, 9, 10].map((n) => file(`manuscript/c${String(n).padStart(5, '0')}.md`, chapterText(n))).concat(notesFor(6, 10)) }));
    expect(nos(p)).toEqual([6, 7, 8, 9, 10]);
    expect(p.newChapters[0]?.content.startsWith('# 第6章 章名6\n\n')).toBe(true);
    expect(p.hints).toEqual([]);
    expect(tailPaths(p)).toEqual(['notes/chapters.md', 'notes/progress.md']);
    expect(p.zeroDiff).toBe(false);
    expect(p.changed).toBe(7);
  });
  it('chapters/001.md relocated to manuscript and hinted', () => {
    const order = orderSpec({ mode: 'open-long', kind: 'book.open', from: 1, count: 2, accepted: 0 });
    const p = planHarvest(mapInput({ order, files: [file('chapters/001.md', chapterText(1)), file('chapters/002.md', chapterText(2)), ...notesFor(1, 2, 0)] }));
    expect(nos(p)).toEqual([1, 2]);
    expect(tailPaths(p)).not.toContain('chapters/001.md');
    expect(p.hints.find((h) => h.kind === 'relocated')?.text).toBe('第 1、2 章写在了 chapters/001.md、chapters/002.md，已移到 manuscript/。正文请直接写在 manuscript/cNNNNN.md。');
  });
  it('heading-only file recognised', () => {
    const p = planHarvest(mapInput({ files: [file('draft-six.md', `# 第六章 雨夜\n\n${prose(3200, 6)}`), ...notesFor(6, 6)] }));
    expect(nos(p)).toEqual([6]);
    expect(p.newChapters[0]?.title).toBe('雨夜');
    expect(kinds(p)).toContain('relocated');
  });
  it('multi-chapter file split into chapters', () => {
    const text = [6, 7, 8].map((n) => chapterText(n)).join('\n');
    const p = planHarvest(mapInput({ files: [file('manuscript/batch.md', text), ...notesFor(6, 8)] }));
    expect(nos(p)).toEqual([6, 7, 8]);
    expect(p.newChapters.map((c) => c.sourcePaths)).toEqual([['manuscript/batch.md'], ['manuscript/batch.md'], ['manuscript/batch.md']]);
    expect(tailPaths(p)).not.toContain('manuscript/batch.md');
  });
  it('manuscript/c(accepted).md with unchanged first segment + new chapters → new chapters only, no unauthorized_edit', () => {
    const c5 = chapterText(5);
    const p = planHarvest(mapInput({ files: [file('manuscript/c00005.md', `${c5}\n${chapterText(6)}\n${chapterText(7)}`, { isNew: false, baseText: c5 }), ...notesFor(6, 7)], baseChapters: new Map([[5, bodyOf(c5)]]) }));
    expect(nos(p)).toEqual([6, 7]);
    expect(p.rewrites).toEqual([]);
    expect(kinds(p)).not.toContain('unauthorized_edit');
    expect(tailPaths(p).some((t) => t.includes('rewrite'))).toBe(false);
  });
  it('manuscript/plan.md without heading → tail + misplaced, not a chapter', () => {
    const p = planHarvest(mapInput({ files: [file('manuscript/plan.md', '接下来写什么'), file('manuscript/c00006.md', chapterText(6)), ...notesFor(6, 6)] }));
    expect(nos(p)).toEqual([6]);
    expect(p.tail).toContainEqual({ path: 'manuscript/plan.md', content: '接下来写什么' });
    expect(p.hints.find((h) => h.kind === 'misplaced')?.text).toContain('manuscript/plan.md');
  });
  it('gap renumbered sequentially from order.from and headings rewritten', () => {
    const p = planHarvest(mapInput({ files: [file('manuscript/c00006.md', chapterText(6)), file('manuscript/c00008.md', chapterText(8)), file('manuscript/c00009.md', chapterText(9)), ...notesFor(6, 8)] }));
    expect(nos(p)).toEqual([6, 7, 8]);
    expect(p.newChapters.map((c) => c.content.split('\n')[0])).toEqual(['# 第6章 章名6', '# 第7章 章名8', '# 第8章 章名9']);
    expect(p.hints.find((h) => h.kind === 'renumbered')?.text).toBe('章号不连续或和文件名对不上，已按顺序改为第 6–8 章，并改好了每章第一行。');
  });
  it('whole batch numbered from 1 while from=6 → renumbered 6..', () => {
    const p = planHarvest(mapInput({ files: [1, 2, 3].map((n) => file(`chapters/00${n}.md`, chapterText(n, 3200, `新${n}`, 100 + n))).concat(notesFor(6, 8)) }));
    expect(nos(p)).toEqual([6, 7, 8]);
    expect(p.newChapters.map((c) => c.title)).toEqual(['新1', '新2', '新3']);
    expect(kinds(p)).toEqual(expect.arrayContaining(['renumbered', 'relocated']));
    expect(kinds(p)).not.toContain('unauthorized_edit');
  });
  it('chapters/002.md during batch from 6 → drafts/c00002.rewrite.md + unauthorized_edit, real 6–10 accepted', () => {
    const files = [6, 7, 8, 9, 10].map((n) => file(`manuscript/c${String(n).padStart(5, '0')}.md`, chapterText(n)));
    files.push(file('chapters/002.md', chapterText(2, 3200, '改', 202)));
    const p = planHarvest(mapInput({ files: [...files, ...notesFor(6, 10)], baseChapters: new Map([[2, bodyOf(chapterText(2))]]) }));
    expect(nos(p)).toEqual([6, 7, 8, 9, 10]);
    expect(tailPaths(p)).toContain('drafts/c00002.rewrite.md');
    expect(p.rewrites).toEqual([]);
    expect(p.hints.find((h) => h.kind === 'unauthorized_edit')?.text).toBe('你改了已入库的第 2 章，这次任务单没有允许改写，改动没有生效，另存在 drafts/。想改的地方写进 notes/progress.md 的"下一步打算"。');
    expect(kinds(p)).not.toContain('renumbered');
  });
  it('duplicate chapter number: manuscript wins, other to drafts', () => {
    const p = planHarvest(mapInput({ files: [file('chapters/006.md', chapterText(6, 3200, '别处', 66)), file('manuscript/c00006.md', chapterText(6)), file('manuscript/c00007.md', chapterText(7)), ...notesFor(6, 7)] }));
    expect(nos(p)).toEqual([6, 7]);
    expect(p.newChapters[0]?.title).toBe('章名6');
    expect(p.tail.find((t) => t.path === 'drafts/c00006.dup.md')?.content).toContain('# 第6章 别处');
  });
  it('root notes.md accepted as-is + misplaced hint', () => {
    const p = planHarvest(mapInput({ files: [file('notes.md', '随手记'), file('manuscript/c00006.md', chapterText(6)), ...notesFor(6, 6)] }));
    expect(p.tail).toContainEqual({ path: 'notes.md', content: '随手记' });
    expect(p.hints.find((h) => h.kind === 'misplaced')?.text).toBe('这些文件放在了约定位置之外：notes.md。已原样收下；以后笔记放 notes/，设定放 bible.md，大纲放 outline.md，manuscript/ 里只放正文。');
  });
  it('ignored non-chapter (views/x.md) dropped + ignored hint; ignored chapter relocated', () => {
    const p = planHarvest(mapInput({ files: [file('views/x.md', '草草几笔', { ignored: true }), file('views/c00006.md', chapterText(6), { ignored: true }), ...notesFor(6, 6)] }));
    expect(nos(p)).toEqual([6]);
    expect(tailPaths(p).some((t) => t.startsWith('views/'))).toBe(false);
    expect(p.hints.find((h) => h.kind === 'ignored')?.text).toBe('这些文件放在了不入库的目录里，没有收下：views/x.md。笔记放 notes/，草稿放 drafts/。');
    expect(kinds(p)).toContain('relocated');
  });
});

describe('planHarvest: rewrites and frozen chapters', () => {
  const c4 = chapterText(4, 4000);
  const edited = (n: number, chars: number, seed: number) => file(`manuscript/c0000${n}.md`, chapterText(n, chars, `章名${n}`, seed), { isNew: false, baseText: chapterText(n, 4000) });

  it('unauthorised edit of accepted chapter → drafts/cNNNNN.rewrite.md + hint, chapter untouched', () => {
    const p = planHarvest(mapInput({ files: [edited(4, 4200, 44), file('manuscript/c00006.md', chapterText(6)), ...notesFor(6, 6)], baseChapters: new Map([[4, bodyOf(c4)]]) }));
    expect(p.rewrites).toEqual([]);
    expect(nos(p)).toEqual([6]);
    expect(p.tail.find((t) => t.path === 'drafts/c00004.rewrite.md')?.content?.startsWith('# 第4章 章名4')).toBe(true);
    expect(kinds(p)).toContain('unauthorized_edit');
  });
  it('edit of published or locked chapter → drafts even if a hint authorised it', () => {
    for (const frozen of [{ publishedThrough: 4, locked: [] }, { publishedThrough: 0, locked: [4] }]) {
      const p = planHarvest(mapInput({ order: orderSpec({ allowRewrite: [4] }), frozen, files: [edited(4, 4200, 44), ...notesFor(6, 6)], baseChapters: new Map([[4, bodyOf(c4)]]) }));
      expect(p.rewrites).toEqual([]);
      expect(tailPaths(p)).toContain('drafts/c00004.rewrite.md');
      expect(kinds(p)).toContain('unauthorized_edit');
    }
  });
  it('authorised rewrite accepted', () => {
    const p = planHarvest(mapInput({ order: orderSpec({ allowRewrite: [4] }), files: [edited(4, 4200, 44), file('manuscript/c00006.md', chapterText(6)), ...notesFor(6, 6)] }));
    expect(p.rewrites.map((r) => r.no)).toEqual([4]);
    expect(p.rewrites[0]?.content.startsWith('# 第4章 章名4\n\n')).toBe(true);
    expect(kinds(p)).not.toContain('unauthorized_edit');
    expect(nos(p)).toEqual([6]);
  });
  it('authorised rewrite >30% shorter rejected, old kept', () => {
    const p = planHarvest(mapInput({ order: orderSpec({ allowRewrite: [4] }), files: [edited(4, 2000, 44), ...notesFor(6, 6)] }));
    expect(p.rewrites).toEqual([]);
    expect(tailPaths(p)).toContain('drafts/c00004.rewrite.md');
    expect(p.hints.find((h) => h.kind === 'rewrite_rejected')?.text).toBe('第 4 章的改写比原版短了三成以上，保留了原版，改写稿在 drafts/c00004.rewrite.md。');
  });
  it('authorised rewrite truncated rejected', () => {
    const f = edited(4, 4200, 44);
    f.text = f.text.replace(/。\s*$/u, '，然后');
    const p = planHarvest(mapInput({ order: orderSpec({ allowRewrite: [4] }), files: [f] }));
    expect(p.rewrites).toEqual([]);
    expect(p.hints.find((h) => h.kind === 'rewrite_rejected')?.text).toContain('结尾停在半句话');
  });
  it('accepted chapter deletes stale drafts/cNNNNN.md', () => {
    const p = planHarvest(mapInput({ files: [file('manuscript/c00006.md', chapterText(6)), file('drafts/c00006.md', '旧残稿', { isNew: false, baseText: '更旧' }), ...notesFor(6, 6)], draftsAtBase: ['drafts/c00006.md', 'drafts/c00009.md'] }));
    expect(p.newChapters[0]?.extra).toEqual([{ path: 'drafts/c00006.md', content: null }]);
    expect(tailPaths(p)).not.toContain('drafts/c00006.md');
  });
});

describe('planHarvest: bible, outline, sticky hints, notes', () => {
  it('planned chapters parsed and clamped to [N0/2, 2N0]', () => {
    const run = (n: number) => planHarvest(mapInput({ plannedInitial: 15, files: [file('outline.md', `骨架\n计划：共 ${n} 章\n`, { isNew: false, baseText: '旧' })] })).plannedChapters;
    expect(run(18)).toBe(18);
    expect(run(100)).toBe(30);
    expect(run(3)).toBe(8);
    expect(run(15)).toBeUndefined();
  });
  it('title/blurb extracted on a write harvest while the title is still the placeholder', () => {
    const p = planHarvest(mapInput({ autoTitle: true, titleIsPlaceholder: true, hasBlurb: false, bibleAtBase: '# 《长夜》\n一句话：一个人在长夜里等天亮。\n标签：悬疑\n', files: [file('manuscript/c00006.md', chapterText(6)), ...notesFor(6, 6)] }));
    expect(p.title).toBe('长夜');
    expect(p.blurb).toBe('一个人在长夜里等天亮。');
  });
  it('title not extracted when owner typed one', () => {
    const p = planHarvest(mapInput({ autoTitle: false, titleIsPlaceholder: false, hasBlurb: true, files: [file('bible.md', '# 《长夜》\n一句话：新简介。\n', { isNew: false, baseText: '# 《旧》\n' })] }));
    expect(p.title).toBeUndefined();
    expect(p.blurb).toBeUndefined();
    expect(kinds(p)).not.toContain('no_bible');
  });
  it('missing bible while title needed → no_bible hint', () => {
    const p = planHarvest(mapInput({ autoTitle: true, titleIsPlaceholder: true, bibleAtBase: null, files: [file('manuscript/c00006.md', chapterText(6)), ...notesFor(6, 6)] }));
    expect(p.title).toBeUndefined();
    expect(p.hints.find((h) => h.kind === 'no_bible')?.text).toBe('没有找到 bible.md，或者前两行格式不对。请按约定补上：第一行"# 《书名》"，第二行"一句话：……"。');
    const bad = planHarvest(mapInput({ autoTitle: true, titleIsPlaceholder: true, bibleAtBase: '长夜\n', files: [file('notes/progress.md', 'x', { isNew: false, baseText: 'y' })] }));
    expect(kinds(bad)).toContain('no_bible');
  });
  it('sticky unfinished hint carried until accepted', () => {
    const sticky = { kind: 'unfinished' as const, chapter: 6, sticky: true, text: '第 6 章没写完', at: AT };
    // 这次只改了笔记：提示原样带下去（at 换成本次）
    const p1 = planHarvest(mapInput({ meta: { hints: [sticky] }, files: [file('notes/progress.md', 'x', { isNew: false, baseText: 'y' })] }));
    expect(p1.hints).toEqual([{ ...sticky, at: '2026-11-10T00:00:00.000Z' }]);
    // 第 6 章入库：提示消失
    const p2 = planHarvest(mapInput({ meta: { hints: [sticky] }, files: [file('manuscript/c00006.md', chapterText(6)), ...notesFor(6, 6)] }));
    expect(kinds(p2)).not.toContain('unfinished');
  });
  it('notes_missing for short book checks progress.md only', () => {
    const order = orderSpec({ mode: 'open-short', kind: 'book.open', from: 1, count: 2, finale: true, accepted: 0, planned: 2 });
    const chapters = [file('manuscript/c00001.md', chapterText(1)), file('manuscript/c00002.md', chapterText(2))];
    const miss = planHarvest(mapInput({ order, length: 'short', files: chapters }));
    expect(miss.hints.find((h) => h.kind === 'notes_missing')?.text).toBe('notes/progress.md 没有更新。先补上写到第几章、前情提要和还没收尾的事。');
    const ok = planHarvest(mapInput({ order, length: 'short', files: [...chapters, file('notes/progress.md', '写完了')] }));
    expect(kinds(ok)).not.toContain('notes_missing');
  });
  it('notes_missing for long book checks chapters.md lines', () => {
    const chapters = [file('manuscript/c00006.md', chapterText(6)), file('manuscript/c00007.md', chapterText(7))];
    const oneLine = file('notes/chapters.md', '第1章\n第2章\n第3章\n第4章\n第5章\n第6章\n', { isNew: false, baseText: '第1章\n第2章\n第3章\n第4章\n第5章\n' });
    const p = planHarvest(mapInput({ length: 'long', files: [...chapters, oneLine] }));
    expect(p.hints.find((h) => h.kind === 'notes_missing')?.text).toBe('notes/chapters.md 没有记全第 6–7 章。先补记这几章（每章一行）。');
    const ok = planHarvest(mapInput({ length: 'long', files: [...chapters, ...notesFor(6, 7)] }));
    expect(kinds(ok)).not.toContain('notes_missing');
  });
  it('zero-diff run', () => {
    const p = planHarvest(mapInput({ files: [] }));
    expect(p).toMatchObject({ zeroDiff: true, changed: 0, newChapters: [], tail: [], completed: false });
  });
});

describe('planHarvest: robustness of splitting and numbering (review fixes)', () => {
  const at12 = (p: Partial<Parameters<typeof orderSpec>[0]> = {}) => orderSpec({ from: 13, accepted: 12, count: 3, ...p });
  const bodyLines = (c: string) => c.split('\n').slice(1);

  it('a repeated plain heading line does not empty the chapter', () => {
    const text = `# 第十三章 夜雨\n\n第十三章 夜雨\n\n${prose(3200, 13)}\n`;
    const p = planHarvest(mapInput({ order: at12(), files: [file('manuscript/c00013.md', text), ...notesFor(13, 13, 12)] }));
    expect(nos(p)).toEqual([13]);
    expect(p.newChapters[0]?.title).toBe('夜雨');
    expect(bodyLines(p.newChapters[0]?.content ?? '').some((l) => l.includes('第十三章'))).toBe(false);
    expect(tailPaths(p).filter((t) => t.startsWith('drafts/'))).toEqual([]);
    expect(kinds(p)).not.toContain('unfinished');
  });
  it('a long lead-in before the heading of the same chapter goes to drafts/, the real chapter is accepted', () => {
    const lead = prose(300, 99);
    const text = `${lead}\n\n# 第十三章 夜雨\n\n${prose(3200, 13)}\n`;
    const p = planHarvest(mapInput({ order: at12(), files: [file('manuscript/c00013.md', text), ...notesFor(13, 13, 12)] }));
    expect(nos(p)).toEqual([13]);
    expect(p.newChapters[0]?.content).toContain(prose(3200, 13).slice(0, 40));
    expect(p.newChapters[0]?.content).not.toContain(lead.slice(2, 40));
    expect(p.tail.find((t) => t.path === 'drafts/c00013.pre.md')?.content?.trimEnd()).toBe(lead);
    expect(tailPaths(p)).not.toContain('drafts/c00013.dup.md');
  });
  it('a headingless chapter followed by the next headed chapter in one file is still two chapters', () => {
    const text = `${prose(3200, 13)}\n\n# 第十四章 风起\n\n${prose(3200, 14)}\n`;
    const p = planHarvest(mapInput({ order: at12(), files: [file('manuscript/c00013.md', text), ...notesFor(13, 14, 12)] }));
    expect(nos(p)).toEqual([13, 14]);
  });
  it('same number twice: an almost empty copy never beats the one with prose', () => {
    const p = planHarvest(mapInput({ order: at12(), files: [file('manuscript/c00013.md', '# 第十三章 夜雨\n\n短。\n'), file('chapters/013.md', chapterText(13, 3200, '夜雨', 130)), ...notesFor(13, 13, 12)] }));
    expect(nos(p)).toEqual([13]);
    expect(p.newChapters[0]?.cjk).toBeGreaterThan(3000);
    expect(p.tail.find((t) => t.path === 'drafts/c00013.dup.md')?.content).toContain('短。');
  });
  it('planning files outside notes/ stay where they are (misplaced hint), they are never published as chapters', () => {
    const bullets = Array.from({ length: 8 }, (_, i) => `- 第${i + 1}节：主角走进山里，遇见了一个陌生的老人，两人说了很久的话。`).join('\n');
    const files = [
      file('manuscript/c00013.md', chapterText(13)),
      file('outline/ch14.md', `# 第十四章\n\n${bullets}\n`),
      file('notes.md', `# 第十四章 细纲\n\n${prose(400, 141)}\n`),
      file('ideas/2026-规划.md', `${prose(400, 142)}\n`),
      ...notesFor(13, 13, 12),
    ];
    const p = planHarvest(mapInput({ order: at12(), files }));
    expect(nos(p)).toEqual([13]);
    for (const f of ['outline/ch14.md', 'notes.md', 'ideas/2026-规划.md']) {
      expect(tailPaths(p)).toContain(f);
      expect(p.hints.find((h) => h.kind === 'misplaced')?.text).toContain(f);
    }
    expect(kinds(p)).not.toContain('unauthorized_edit');
    expect(chapterNoFromPath('ideas/2026-规划.md')).toBeNull();
    expect(chapterNoFromPath('2026-规划.md')).toBeNull();
    expect(chapterNoFromPath('ideas/3-想法.md')).toBeNull();
    expect(chapterNoFromPath('chapters/007.md')).toBe(7);
    expect(chapterNoFromPath('007.md')).toBe(7);
  });
  it('"第一节" section headings inside a chapter do not split it (accepted 12, and first batch)', () => {
    const text = (no: number, cn: string) => `# 第${cn}章 夜雨\n\n${prose(200, no)}\n\n第一节 山路\n\n${prose(1500, no + 100)}\n\n第二节 夜雨\n\n${prose(1500, no + 200)}\n`;
    const p = planHarvest(mapInput({ order: at12(), files: [file('manuscript/c00013.md', text(13, '十三')), ...notesFor(13, 13, 12)] }));
    expect(nos(p)).toEqual([13]);
    expect(p.newChapters[0]?.content).toContain('\n第一节 山路\n');
    expect(p.newChapters[0]?.content).toContain('\n第二节 夜雨\n');
    expect(tailPaths(p).filter((t) => t.startsWith('drafts/'))).toEqual([]);
    expect(kinds(p)).not.toContain('unauthorized_edit');
    const first = orderSpec({ mode: 'open-long', kind: 'book.open', from: 1, count: 2, accepted: 0 });
    const q = planHarvest(mapInput({ order: first, files: [file('manuscript/c00001.md', text(1, '一')), ...notesFor(1, 1, 0)] }));
    expect(nos(q)).toEqual([1]);
    expect(tailPaths(q).filter((t) => t.startsWith('drafts/'))).toEqual([]);
  });
  it('common heading variants split a batch file and lose their 第X章 prefix; body lines like "第一回合" do not split', () => {
    const text = `# 第十三章（上）\n\n${prose(3200, 131)}\n\n# 第十三章（下）\n\n${prose(3200, 132)}\n\n# 第十四章夜雨\n\n${prose(3200, 141)}\n`;
    const p = planHarvest(mapInput({ order: at12(), files: [file('manuscript/c00013.md', text), ...notesFor(13, 15, 12)] }));
    expect(nos(p)).toEqual([13, 14, 15]);
    expect(p.newChapters.map((c) => c.content.split('\n')[0])).toEqual(['# 第13章 （上）', '# 第14章 （下）', '# 第15章 夜雨']);
    const one = `# 第十三章 夜雨\n\n${prose(1600, 133)}\n\n第一回合，他赢了。\n\n第三节课下课后，他走了。\n\n${prose(1600, 134)}\n`;
    const q = planHarvest(mapInput({ order: at12(), files: [file('manuscript/c00013.md', one), ...notesFor(13, 13, 12)] }));
    expect(nos(q)).toEqual([13]);
    expect(q.newChapters[0]?.content).toContain('第一回合，他赢了。');
    // 已入库章末尾接着写、标题用了变体：新章照样拆出来
    const c12 = chapterText(12);
    const appended = `${c12}\n**第十三章 风起**\n\n${prose(3200, 135)}\n`;
    const r = planHarvest(mapInput({ order: at12(), files: [file('manuscript/c00012.md', appended, { isNew: false, baseText: c12 }), ...notesFor(13, 13, 12)], baseChapters: new Map([[12, bodyOf(c12)]]) }));
    expect(nos(r)).toEqual([13]);
    expect(r.newChapters[0]?.title).toBe('风起');
    expect(kinds(r)).not.toContain('unauthorized_edit');
  });
  it('a batch file numbered per batch (第一章…第三章 in c00013.md) lands as 13–15, not as rewrites of 1–3', () => {
    const text = ['一', '二', '三'].map((cn, i) => `# 第${cn}章 新${i + 1}\n\n${prose(3200, 300 + i)}\n`).join('\n');
    const p = planHarvest(mapInput({ order: at12(), files: [file('manuscript/c00013.md', text), ...notesFor(13, 15, 12)], baseChapters: new Map([[2, bodyOf(chapterText(2))], [3, bodyOf(chapterText(3))]]) }));
    expect(nos(p)).toEqual([13, 14, 15]);
    expect(p.newChapters.map((c) => c.title)).toEqual(['新1', '新2', '新3']);
    expect(kinds(p)).not.toContain('unauthorized_edit');
    expect(tailPaths(p).some((t) => t.includes('rewrite'))).toBe(false);
  });
  it('chapters/c00013.md headed "# 第一章" next to manuscript/c00014.md lands as 13 and 14', () => {
    const p = planHarvest(mapInput({ order: at12(), files: [file('chapters/c00013.md', chapterText(1, 3200, '开端', 313)), file('manuscript/c00014.md', chapterText(14)), ...notesFor(13, 14, 12)] }));
    expect(nos(p)).toEqual([13, 14]);
    expect(p.newChapters.map((c) => c.title)).toEqual(['开端', '章名14']);
    expect(kinds(p)).not.toContain('unauthorized_edit');
  });
  it('a 第零章 prologue on the first batch is chapter 1, not a rewrite of chapter 0', () => {
    const first = orderSpec({ mode: 'open-long', kind: 'book.open', from: 1, count: 3, accepted: 0 });
    const text = `# 第零章 楔子\n\n${prose(3200, 400)}\n\n# 第一章 开端\n\n${prose(3200, 401)}\n`;
    const p = planHarvest(mapInput({ order: first, files: [file('manuscript/c00001.md', text), ...notesFor(1, 2, 0)] }));
    expect(nos(p)).toEqual([1, 2]);
    expect(p.newChapters.map((c) => c.title)).toEqual(['楔子', '开端']);
    expect(kinds(p)).not.toContain('unauthorized_edit');
    expect(tailPaths(p).some((t) => t.includes('c00000'))).toBe(false);
  });
  it('an authorised rewrite saved at a non-canonical path (chapters/4.md) is a rewrite, not new chapter 6', () => {
    const c4 = chapterText(4, 4000);
    const expanded = `${c4.trimEnd()}\n\n${prose(800, 444)}\n`;
    const p = planHarvest(mapInput({ order: orderSpec({ allowRewrite: [4] }), files: [file('chapters/4.md', expanded), file('notes/progress.md', '扩写了第4章。', { isNew: false, baseText: '旧' })], baseChapters: new Map([[4, bodyOf(c4)]]) }));
    expect(p.rewrites.map((r) => r.no)).toEqual([4]);
    expect(p.newChapters).toEqual([]);
    expect(kinds(p)).not.toContain('unfinished');
    // 按批次从 1 编号的新章（和旧第 4 章不像）照旧重新编号，不被当成第 4 章的改写
    const fresh = planHarvest(mapInput({ order: orderSpec({ allowRewrite: [4] }), files: [1, 2, 3, 4, 5].map((n) => file(`chapters/00${n}.md`, chapterText(n, 3200, `新${n}`, 500 + n))).concat(notesFor(6, 10)), baseChapters: new Map([[4, bodyOf(c4)]]) }));
    expect(nos(fresh)).toEqual([6, 7, 8, 9, 10]);
    expect(fresh.rewrites).toEqual([]);
  });
});
