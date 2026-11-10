import { describe, expect, it } from 'vitest';
import { parseCnNumber, parseChapterHeading } from '@novelist/shared';
import { DUP_RUN_CHARS, checkNewChapter, checkRewrite, cleanChapterText, longestSharedRun, normaliseChapter } from './checks.js';
import { planHarvest } from './map.js';
import { bodyOf, chapterText, file, mapInput, notesFor, orderSpec, prose } from './testing.js';

const truncate = (t: string) => t.replace(/。\s*$/u, '，他推开门');

describe('checkNewChapter', () => {
  it('empty chapter fails', () => {
    expect(checkNewChapter('', [], 3000)).toMatchObject({ ok: false, reason: 'empty' });
    expect(checkNewChapter('只有一句话。', [], 3000)).toMatchObject({ ok: false, reason: 'empty' });
  });
  it('truncated last sentence fails', () => {
    expect(checkNewChapter(truncate(prose(3200, 1)), [], 3000)).toMatchObject({ ok: false, reason: 'truncated' });
    expect(checkNewChapter(`${prose(3200, 1)}\n\n“你来了`, [], 3000)).toMatchObject({ ok: false, reason: 'truncated' });
    expect(checkNewChapter(prose(3200, 1), [], 3000)).toEqual({ ok: true, short: false });
  });
  it('≥300-char verbatim run with another chapter fails', () => {
    const shared = prose(400, 99);
    const a = `${prose(1500, 1)}\n\n${shared}\n\n${prose(1500, 2)}`;
    const b = `${prose(1500, 3)}\n\n${shared}\n\n${prose(1500, 4)}`;
    expect(longestSharedRun(a, b)).toBeGreaterThanOrEqual(DUP_RUN_CHARS);
    expect(checkNewChapter(a, [{ no: 3, text: b }], 3000)).toMatchObject({ ok: false, reason: 'duplicate', dupOf: 3 });
    const short = prose(200, 98);
    const c = `${prose(1500, 5)}\n\n${short}\n\n${prose(1500, 6)}`;
    const d = `${prose(1500, 7)}\n\n${short}\n\n${prose(1500, 8)}`;
    expect(longestSharedRun(c, d)).toBeLessThan(DUP_RUN_CHARS);
    expect(checkNewChapter(c, [{ no: 3, text: d }], 3000)).toMatchObject({ ok: true });
  });
  it('supplementing a chapter vs its own old version does not fail', () => {
    // 第 6 章上次没写完（drafts/ 里有残稿），这次接着写完：残稿不算“别的章节”
    const draft = `# 第6章 雨夜\n\n${prose(1800, 6)}`;
    const full = `${draft}\n\n${prose(1800, 60)}\n`;
    const p = planHarvest(
      mapInput({
        files: [file('manuscript/c00006.md', full), ...notesFor(6, 6)],
        baseChapters: new Map([[5, bodyOf(chapterText(5))]]),
        draftsAtBase: new Map([['drafts/c00006.md', '旧残稿']]),
        meta: { hints: [{ kind: 'unfinished', chapter: 6, sticky: true, text: 'x', at: '2026-11-01T00:00:00.000Z' }] },
      }),
    );
    expect(p.newChapters.map((c) => c.no)).toEqual([6]);
    expect(p.newChapters[0]?.extra).toEqual([
      { path: 'drafts/c00006.md', content: null },
      { path: 'drafts/discarded/c00006.md', content: '旧残稿' },
    ]);
    expect(p.hints.filter((h) => h.kind === 'unfinished')).toEqual([]);
  });
  it('rewrite: shorter than 70% or truncated is rejected', () => {
    const old = prose(4000, 1);
    expect(checkRewrite(old, prose(2600, 2))).toMatchObject({ ok: false, reason: 'shorter' });
    expect(checkRewrite(old, truncate(prose(4200, 2)))).toMatchObject({ ok: false, reason: 'truncated' });
    expect(checkRewrite(old, prose(3000, 2))).toEqual({ ok: true });
  });
  it('owner rewrite (allowShorter): may be shorter, but keeps at least min(floor, half the old text); truncation still fails', () => {
    const old = prose(4000, 1);
    const opts = { allowShorter: true, minChars: 3000 };
    expect(checkRewrite(old, prose(2100, 2), opts)).toEqual({ ok: true });
    expect(checkRewrite(old, prose(1900, 2), opts)).toMatchObject({ ok: false, reason: 'shorter' });
    // 每章下限低于旧版一半时按下限
    expect(checkRewrite(old, prose(900, 2), { allowShorter: true, minChars: 800 })).toEqual({ ok: true });
    expect(checkRewrite(old, prose(60, 2), { allowShorter: true, minChars: 50 })).toMatchObject({ ok: false, reason: 'shorter' });
    expect(checkRewrite(old, truncate(prose(2500, 2)), opts)).toMatchObject({ ok: false, reason: 'truncated' });
  });
});

describe('batch prefix and hints', () => {
  it('prefix accept: chapter 3 of 5 truncated → 1–2 accepted, 3–5 to drafts, unfinished hint for 3', () => {
    const order = orderSpec({ mode: 'open-long', kind: 'book.open', from: 1, count: 5, accepted: 0, totalCjk: 0 });
    const files = [1, 2, 3, 4, 5].map((n) => file(`manuscript/c0000${n}.md`, n === 3 ? truncate(chapterText(n)) : chapterText(n)));
    const p = planHarvest(mapInput({ order, files: [...files, ...notesFor(1, 5, 0)] }));
    expect(p.newChapters.map((c) => c.no)).toEqual([1, 2]);
    expect(p.tail.map((t) => t.path)).toEqual(expect.arrayContaining(['drafts/c00003.md', 'drafts/c00004.md', 'drafts/c00005.md']));
    const u = p.hints.find((h) => h.kind === 'unfinished');
    expect(u).toMatchObject({ chapter: 3, sticky: true });
    expect(u?.text).toBe(
      '第 3 章没写完（结尾停在半句话），没有入库；残稿在 drafts/c00003.md，后面几章的草稿也在 drafts/ 里。先把第 3 章写完整，存到 manuscript/c00003.md，再把后面几章的草稿校对后依次归位。笔记里关于第 3 章及之后的内容，以重写后的正文为准。',
    );
    expect(p.hints[0]?.kind).toBe('unfinished');
  });
  it('short complete chapter accepted with one-time hint', () => {
    const p = planHarvest(mapInput({ files: [file('manuscript/c00006.md', chapterText(6, 2000)), file('manuscript/c00007.md', chapterText(7)), ...notesFor(6, 7)] }));
    expect(p.newChapters.map((c) => c.no)).toEqual([6, 7]);
    const s = p.hints.filter((h) => h.kind === 'short');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ chapter: 6, rewrite: 6 });
    expect(s[0]?.text).toMatch(/^第 6 章只有 \d+ 字，不到每章 3000 字的下限。先把第 6 章补到 3000 字以上（只补这一章，直接改 manuscript\/c00006\.md）。$/);
    expect(p.hintedShort).toEqual([6]);
  });
  it('short hint not repeated when chapter in hintedShort', () => {
    // 第 4 章已提示过：本次授权改写仍然偏短，也不再提示
    const old = bodyOf(chapterText(4, 2000));
    const order = orderSpec({ allowRewrite: [4] });
    const p = planHarvest(
      mapInput({
        order,
        files: [file('manuscript/c00006.md', chapterText(6, 2100)), ...notesFor(6, 6)],
        baseChapters: new Map([[4, old]]),
        meta: { hintedShort: [6] },
      }),
    );
    expect(p.newChapters.map((c) => c.no)).toEqual([6]);
    expect(p.hints.filter((h) => h.kind === 'short')).toEqual([]);
    expect(p.hintedShort).toEqual([6]);
  });
  it('meta stripping removes fences, 本章完, 创作说明 lines, HTML comments, and hints once', () => {
    const body = prose(3200, 6);
    const raw = `# 第6章 雨夜\n\n<!-- beat:b1 -->\n${body}\n\n\`\`\`\n（本章完）\n创作说明：这一章写了雨。\n字数统计：3200\n---\n`;
    const c = cleanChapterText(raw);
    expect(c.text).not.toMatch(/beat|```|本章完|创作说明|字数统计|---/);
    expect(c.stripped.sort()).toEqual(['code_fence', 'html_comment', 'meta_line', 'separator', 'tail_note']);
    const p = planHarvest(mapInput({ files: [file('manuscript/c00006.md', raw), file('manuscript/c00007.md', raw.replace('雨夜', '晴天').replace(body, prose(3200, 7))), ...notesFor(6, 7)] }));
    expect(p.newChapters.map((c) => c.no)).toEqual([6, 7]);
    expect(p.newChapters[0]?.content).toBe(`# 第6章 雨夜\n\n${body}\n`);
    const m = p.hints.filter((h) => h.kind === 'meta_stripped');
    expect(m).toHaveLength(1);
    expect(m[0]?.text).toBe('第 6、7 章里夹带了创作说明、尾标或代码围栏，已删除。正文里只写小说本身。');
  });
  it('title normalisation: "# 第七章：雨夜"→title 雨夜, renumbered heading', () => {
    const n = normaliseChapter(8, `# 第七章：雨夜\n\n${prose(3200, 1)}`);
    expect(n.title).toBe('雨夜');
    expect(n.content.split('\n')[0]).toBe('# 第8章 雨夜');
    expect(parseChapterHeading('第7章 · 雨夜')).toEqual({ no: 7, title: '雨夜' });
    expect(parseChapterHeading('## 第十二回')).toEqual({ no: 12, title: '' });
  });
  it('no heading → title \'\' and heading "# 第N章"', () => {
    const n = normaliseChapter(6, prose(3200, 1));
    expect(n.title).toBe('');
    expect(n.content.startsWith('# 第6章\n\n')).toBe(true);
  });
  it('Chinese numerals 十二/一百零三/两/０７', () => {
    expect(parseCnNumber('十二')).toBe(12);
    expect(parseCnNumber('一百零三')).toBe(103);
    expect(parseCnNumber('两')).toBe(2);
    expect(parseCnNumber('０７')).toBe(7);
    expect(parseChapterHeading('# 第一百零三章 归来')).toEqual({ no: 103, title: '归来' });
  });
  it('notes file shrink >40% → archive copy + hint', () => {
    const old = prose(1200, 50);
    const p = planHarvest(mapInput({ files: [file('manuscript/c00006.md', chapterText(6)), file('notes/cast.md', prose(400, 51), { isNew: false, baseText: old }), ...notesFor(6, 6)] }));
    expect(p.tail).toContainEqual({ path: 'notes/archive/cast-c00005.md', content: old });
    const h = p.hints.find((x) => x.kind === 'notes_shrunk');
    expect(h?.text).toMatch(/^notes\/cast\.md 这次缩短了 \d+%，旧版存在 notes\/archive\/cast-c00005\.md。确认没有丢掉在场人物和未收线索。$/);
  });
  it('chapters.md not extended → notes_missing hint (not repeated)', () => {
    const files = [file('manuscript/c00006.md', chapterText(6)), file('manuscript/c00007.md', chapterText(7)), file('notes/progress.md', '写到第7章。', { isNew: false, baseText: '旧' })];
    const p = planHarvest(mapInput({ files }));
    const h = p.hints.find((x) => x.kind === 'notes_missing');
    expect(h).toMatchObject({ range: [6, 7], text: 'notes/chapters.md 没有记全第 6–7 章。先补记这几章（每章一行）。' });
    // 同一批的提示已经在上一次的 hints 里：不再重复
    const again = planHarvest(mapInput({ files, meta: { hints: p.hints } }));
    expect(again.hints.find((x) => x.kind === 'notes_missing')).toBeUndefined();
    // 记全了就没有提示
    const ok = planHarvest(mapInput({ files: [...files.slice(0, 2), ...notesFor(6, 7)] }));
    expect(ok.hints.find((x) => x.kind === 'notes_missing')).toBeUndefined();
  });
});

describe('checks: review fixes', () => {
  it('a chapter ending on the ellipsis variant ⋯⋯ is not truncated (v3 only; the old-flow gate is unchanged)', async () => {
    const body = `${prose(3200, 21).replace(/。$/u, '')}⋯⋯`;
    expect(checkNewChapter(body, [], 3000)).toEqual({ ok: true, short: false });
    const { checkTruncation } = await import('../validators/truncation.js');
    expect(checkTruncation(body, { sentence: true }).ok).toBe(false);
  });
  it('a chapter that re-quotes a 320-char letter from an earlier chapter is accepted', () => {
    const letter = `「${prose(330, 77).replace(/\s+/gu, '')}」`;
    const old = `${prose(1500, 31)}\n\n${letter}\n\n${prose(1500, 32)}`;
    const now = `${prose(1500, 33)}\n\n${letter}\n\n${prose(1500, 34)}`;
    expect(longestSharedRun(now, old)).toBeGreaterThanOrEqual(DUP_RUN_CHARS);
    expect(checkNewChapter(now, [{ no: 5, text: old }], 3000)).toEqual({ ok: true, short: false });
  });
  it('end-of-book spellings are stripped and recorded', () => {
    for (const t of ['正文。\n\n——全书完——', '正文。\n\n（全书终）', '正文。——全书完——', '正文。\n\n【全书完结】']) {
      const c = cleanChapterText(t);
      expect(c.hadEndMarker, t).toBe(true);
      expect(c.text, t).toBe('正文。');
    }
    expect(cleanChapterText('正文。\n\n（完）')).toMatchObject({ text: '正文。', hadEndMarker: false, hadBareEndTail: true });
    expect(cleanChapterText('（完）\n\n正文。')).toMatchObject({ hadBareEndTail: false });
  });
  it('heading variants', () => {
    expect(parseChapterHeading('# 第十二章（上）')).toEqual({ no: 12, title: '（上）' });
    expect(parseChapterHeading('第十二章「夜雨」')).toEqual({ no: 12, title: '夜雨' });
    expect(parseChapterHeading('# 第十二章夜雨')).toEqual({ no: 12, title: '夜雨' });
    expect(parseChapterHeading('**第十二章 夜雨**')).toEqual({ no: 12, title: '夜雨' });
    expect(parseChapterHeading('# 第一卷 第三章 夜雨')).toEqual({ no: 3, title: '夜雨' });
    expect(parseChapterHeading('#### 第三章')).toEqual({ no: 3, title: '' });
    expect(parseChapterHeading('第一回合，他赢了。')).toBeNull();
    expect(parseChapterHeading('第三节课下课后，他走了。')).toBeNull();
    expect(parseChapterHeading('第一节 山路')).toBeNull();
    expect(normaliseChapter(12, '# 第十二章（上）\n\n正文。').content.split('\n')[0]).toBe('# 第12章 （上）');
  });
});
