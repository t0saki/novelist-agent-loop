import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V3_LAUNCH_PROMPT } from '@novelist/shared';
import { parseOrderText } from '../harness/fake/fake-harness.js';
import { V3_AGENTS_SOFT_LIMIT, V3_CLAUDE_MD, renderAgentsMdV3 } from '../instructions/v3.js';
import { fillTemplate, noteBudgetLines, renderHints, renderLibrary, renderOrder, selectHints } from './order.js';
import { orderSpec } from './testing.js';
import type { V3Hint } from './types.js';

const AT = '2026-11-10T00:00:00.000Z';
const noExtra = { library: '', mustRead: '', budgets: '', ownerNote: false };
const MUST_READ = ['- notes/progress.md、outline.md、bible.md、notes/cast.md、notes/threads.md；', '- notes/chapters.md 的最后 30 行；', '- 上一章全文：manuscript/c00005.md。'].join('\n');

describe('ORDER.md golden files', () => {
  it('open-short', async () => {
    const spec = orderSpec({ mode: 'open-short', kind: 'book.open', from: 1, count: 4, finale: true, planned: 4, plannedMax: 8, targetCjk: 15000, accepted: 0, totalCjk: 0, bibleExisted: false });
    const library = renderLibrary([
      { title: '雨夜来客', blurb: '一个邮差在暴雨夜收到寄给自己的信。' },
      { title: '无名之书', blurb: null },
    ]);
    await expect(await renderOrder(spec, { ...noExtra, library })).toMatchFileSnapshot('./__golden__/order.open-short.golden.md');
  });
  it('open-long', async () => {
    const spec = orderSpec({ mode: 'open-long', kind: 'book.open', from: 1, count: 5, planned: 15, plannedMax: 30, accepted: 0, totalCjk: 0, bibleExisted: false });
    await expect(await renderOrder(spec, noExtra)).toMatchFileSnapshot('./__golden__/order.open-long.golden.md');
  });
  it('open-long resume (bible existed, unfinished hint)', async () => {
    const hint: V3Hint = { kind: 'unfinished', chapter: 1, sticky: true, at: AT, text: '第 1 章没写完（结尾停在半句话），没有入库；残稿在 drafts/c00001.md。先把第 1 章写完整，存到 manuscript/c00001.md。笔记里关于第 1 章及之后的内容，以重写后的正文为准。' };
    const spec = orderSpec({ mode: 'open-long', kind: 'book.open', from: 1, count: 5, accepted: 0, totalCjk: 0, bibleExisted: true, hintsShown: [hint] });
    await expect(await renderOrder(spec, noExtra)).toMatchFileSnapshot('./__golden__/order.open-long-resume.golden.md');
  });
  it('write (hints + rewrite + budget line + from-owner)', async () => {
    const hints: V3Hint[] = [
      { kind: 'short', chapter: 4, rewrite: 4, at: AT, text: '第 4 章只有 2100 字，不到每章 3000 字的下限。先把第 4 章补到 3000 字以上（只补这一章，直接改 manuscript/c00004.md）。' },
      { kind: 'notes_missing', range: [1, 5], at: AT, text: 'notes/chapters.md 没有记全第 1–5 章。先补记这几章（每章一行）。' },
    ];
    const spec = orderSpec({ hintsShown: hints, allowRewrite: [4], accepted: 5, totalCjk: 18234 });
    const budgets = noteBudgetLines({ 'notes/progress.md': 2460, 'bible.md': 3000 }).join('\n');
    await expect(await renderOrder(spec, { library: '', mustRead: MUST_READ, budgets, ownerNote: true })).toMatchFileSnapshot('./__golden__/order.write.golden.md');
  });
  it('finale', async () => {
    const spec = orderSpec({ mode: 'finale', from: 11, count: 5, finale: true, accepted: 10, totalCjk: 41000, effort: 'high' });
    const mustRead = MUST_READ.replace('c00005', 'c00010');
    await expect(await renderOrder(spec, { ...noExtra, mustRead })).toMatchFileSnapshot('./__golden__/order.finale.golden.md');
  });
});

describe('ORDER.md rendering rules', () => {
  it('unknown template var throws', () => {
    expect(() => fillTemplate('任务：{{nope}}', { from: '1' })).toThrow(/nope/);
    expect(fillTemplate('{{a}}\n\n\n\n{{b}}', { a: 'x', b: '{{a}}' })).toBe('x\n\n{{a}}');
  });
  it('empty hints render no header', async () => {
    expect(renderHints([], [])).toBe('');
    const out = await renderOrder(orderSpec(), { ...noExtra, mustRead: MUST_READ });
    expect(out).not.toContain('上一次的系统提示');
    expect(out).not.toMatch(/\n{3,}/);
    expect(renderHints([], ['bible.md 太长了（约 9000 字），顺手压到 8000 字上下，不必精确计数。'])).toContain('## 上一次的系统提示（先处理这些）\n1. bible.md');
  });
  it('library excludes both placeholder prefixes and self', () => {
    const out = renderLibrary(
      [
        { id: 'a', title: '待命名·x1', blurb: 'auto' },
        { id: 'b', title: '未命名·y2', blurb: 'v3' },
        { id: 'self', title: '本书', blurb: '自己' },
        { id: 'c', title: '真书', blurb: '简介' },
      ],
      { selfId: 'self' },
    );
    expect(out).toBe('书库摘要（不要和这些书雷同）：\n- 《真书》：简介\n');
    expect(renderLibrary([{ title: '待命名·z', blurb: null }])).toBe('');
    const many = renderLibrary(Array.from({ length: 30 }, (_, i) => ({ title: `书${i}`, blurb: null })));
    expect(many.trim().split('\n')).toHaveLength(21);
  });
  it('allowRewrite and short/early_end hints drop published and locked chapters', () => {
    const hints: V3Hint[] = [
      { kind: 'short', chapter: 3, rewrite: 3, at: AT, text: 'short 3' },
      { kind: 'early_end', chapter: 7, rewrite: 7, at: AT, text: 'early 7' },
      { kind: 'short', chapter: 9, rewrite: 9, at: AT, text: 'short 9' },
      { kind: 'notes_missing', range: [6, 10], at: AT, text: 'notes' },
    ];
    const { hintsShown, allowRewrite } = selectHints(hints, { publishedThrough: 3, locked: [7] });
    expect(hintsShown.map((h) => h.text)).toEqual(['short 9', 'notes']);
    expect(allowRewrite).toEqual([9]);
  });
  it('the fake harness understands every rendered order', async () => {
    const cases = [
      { spec: orderSpec({ mode: 'open-short', kind: 'book.open', from: 1, count: 4, finale: true, planned: 4, accepted: 0 }), want: { mode: 'open-short', from: 1, count: 4 } },
      { spec: orderSpec({ mode: 'open-long', kind: 'book.open', from: 1, count: 5, accepted: 0 }), want: { mode: 'open-long', from: 1, count: 5 } },
      { spec: orderSpec({ allowRewrite: [4], minChars: 2500 }), want: { mode: 'write', from: 6, count: 5, allowRewrite: [4], minChars: 2500 } },
      { spec: orderSpec({ mode: 'finale', from: 11, count: 3, finale: true, accepted: 10 }), want: { mode: 'finale', from: 11, count: 3 } },
    ];
    for (const c of cases) expect(parseOrderText(await renderOrder(c.spec, noExtra))).toMatchObject(c.want);
  });
  it('rewrite line lists every allowed chapter, or forbids rewrites', async () => {
    expect(await renderOrder(orderSpec({ allowRewrite: [3, 5] }), noExtra)).toContain('允许改写的旧章：第 3 章、第 5 章（见下面的系统提示）。除此之外，已写好的章节不要动。');
    expect(await renderOrder(orderSpec(), noExtra)).toContain('不改写旧章：已写好的章节不要动。');
  });
});

describe('renderAgentsMdV3', () => {
  let dir: string;
  const put = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  };
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-v3-agents-'));
    await put('global/AGENTS.md', 'GLOBAL-AGENTS');
    await put('global/roles/writer.md', 'GLOBAL-WRITER');
    await put('global/roles/planner.md', 'GLOBAL-PLANNER');
    await put('global/tasks/chapter.write.md', 'GLOBAL-TASK');
    await put('genres/base/AGENTS.md', 'BASE-AGENTS');
    await put('genres/self/AGENTS.md', 'SELF-AGENTS');
    await put('genres/self/roles/writer.md', 'SELF-WRITER');
    await put('book/instructions/AGENTS.md', 'BOOK-AGENTS');
    await put('book/instructions/roles/writer.md', 'BOOK-WRITER');
    await put('book/instructions/tasks/book.write.md', 'BOOK-TASK');
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const input = () => ({
    globalDir: path.join(dir, 'global'),
    genreDirs: [
      { id: 'base', dir: path.join(dir, 'genres/base'), name: '基础' },
      { id: 'self', dir: path.join(dir, 'genres/self'), name: '本题材' },
    ],
    bookDir: path.join(dir, 'book'),
    length: 'medium' as const,
  });

  it('orders layers contract→length→global→genre(base→self)→book and drops planner/task files', async () => {
    const r = await renderAgentsMdV3(input());
    const order = ['## 一、书房约定（内置）', '## 二、篇幅要领：中篇', '## 三、全局', 'GLOBAL-AGENTS', 'GLOBAL-WRITER', '## 四、题材：基础', 'BASE-AGENTS', '## 五、题材：本题材', 'SELF-AGENTS', 'SELF-WRITER', '## 六、本书', 'BOOK-AGENTS', 'BOOK-WRITER'];
    const pos = order.map((s) => r.text.indexOf(s));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    for (const gone of ['GLOBAL-PLANNER', 'GLOBAL-TASK', 'BOOK-TASK', 'nonce']) expect(r.text).not.toContain(gone);
    expect(r.text.startsWith('<!-- 本文件由 Novelist 在每次运行前生成')).toBe(true);
    expect(r.text).toContain('全书约 15 章');
  });
  it('AGENTS.md > 16KB is not truncated', async () => {
    const big = `BIG-START\n${'很长的本书要求。'.repeat(3000)}\nBIG-END`;
    await put('book/instructions/AGENTS.md', big);
    const r = await renderAgentsMdV3(input());
    expect(r.bytes).toBeGreaterThan(V3_AGENTS_SOFT_LIMIT);
    expect(r.text).toContain('BIG-START');
    expect(r.text).toContain('BIG-END');
    expect(r.bytes).toBe(Buffer.byteLength(r.text, 'utf8'));
    await put('book/instructions/AGENTS.md', 'BOOK-AGENTS');
  });
  it('V3_CLAUDE_MD === "@AGENTS.md\\n"', () => {
    expect(V3_CLAUDE_MD).toBe('@AGENTS.md\n');
  });
  it('launch prompt constant', () => {
    expect(V3_LAUNCH_PROMPT).toBe('阅读 AGENTS.md 和 ORDER.md 并执行。Read AGENTS.md and ORDER.md and execute.');
  });
});
