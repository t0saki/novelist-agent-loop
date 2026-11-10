import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { V3_LAUNCH_PROMPT } from '@novelist/shared';
import { parseOrderText } from '../harness/fake/fake-harness.js';
import { V3_AGENTS_SOFT_LIMIT, V3_CLAUDE_MD, renderAgentsMdV3 } from '../instructions/v3.js';
import { books } from '../db/schema.js';
import { execEnv, type ExecEnv } from '../orchestrator/executor.js';
import { createOrchTestEnv, type OrchTestEnv } from '../orchestrator/testing.js';
import type { PipelineContext, TaskRow } from '../pipeline/types.js';
import { ORDER_TEMPLATES_DIR, buildOrderSpec, fillTemplate, noteBudgetLines, ownerRewriteHint, renderEnding, renderFeedback, renderHints, renderLibrary, renderOrder, selectHints, waitingOwnerRequests } from './order.js';
import { emptyV3Meta } from './state.js';
import { renderLibraryV3 } from './library.js';
import { orderSpec } from './testing.js';
import { addV3Book } from './testing-book.js';
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
  it('open-long with the v3 library digest (same genre, recent, top tags)', async () => {
    const spec = orderSpec({ mode: 'open-long', kind: 'book.open', from: 1, count: 5, planned: 15, plannedMax: 30, accepted: 0, totalCjk: 0, bibleExisted: false });
    const at = (d: number) => `2026-11-0${d}T00:00:00.000Z`;
    const library = renderLibraryV3(
      {
        sameGenre: [
          { id: 'a', title: '雨夜来客', blurb: '一个邮差在暴雨夜收到寄给自己的信。', tags: ['悬疑', '都市', '书信'], genre: 'g', createdAt: at(5) },
          { id: 'b', title: '无名之书', blurb: null, tags: [], genre: 'g', createdAt: at(4) },
        ],
        recent: [
          { id: 'c', title: '旧港', blurb: '退休的领航员最后一次出海。', tags: ['悬疑', '海洋'], genre: 'h', createdAt: at(6) },
          { id: 'd', title: '晚钟', blurb: null, tags: ['都市'], genre: 'h', createdAt: at(3) },
        ],
      },
      '都市悬疑',
    );
    await expect(await renderOrder(spec, { ...noExtra, library })).toMatchFileSnapshot('./__golden__/order.open-long-library.golden.md');
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
  it('write-closing (ending list absent)', async () => {
    const spec = orderSpec({ from: 18, count: 3, batch: 3, accepted: 17, planned: 27, totalCjk: 61000, phase: 'closing', endingListExists: false, effort: 'high' });
    await expect(await renderOrder(spec, { ...noExtra, mustRead: MUST_READ.replace('c00005', 'c00017') })).toMatchFileSnapshot('./__golden__/order.write-closing.golden.md');
  });
  it('write-closing-list (ending list exists)', async () => {
    const spec = orderSpec({ from: 21, count: 3, batch: 3, accepted: 20, planned: 27, totalCjk: 72000, phase: 'closing', endingListExists: true, effort: 'high' });
    await expect(await renderOrder(spec, { ...noExtra, mustRead: MUST_READ.replace('c00005', 'c00020') })).toMatchFileSnapshot('./__golden__/order.write-closing-list.golden.md');
  });
  it('write-runaway (warn line, author raised planned above the base)', async () => {
    const spec = orderSpec({ from: 16, count: 2, batch: 2, accepted: 15, planned: 30, targetCjk: 40000, totalCjk: 52000, runawayWarn: true, runawayBase: 10, phase: 'normal' });
    await expect(await renderOrder(spec, { ...noExtra, mustRead: MUST_READ.replace('c00005', 'c00015') })).toMatchFileSnapshot('./__golden__/order.write-runaway.golden.md');
  });
  it('finale-forced', async () => {
    const spec = orderSpec({ mode: 'finale', from: 21, count: 20, batch: 2, finale: true, accepted: 20, planned: 40, targetCjk: 40000, totalCjk: 70000, forced: true, runawayBase: 10, endingListExists: true, effort: 'high' });
    await expect(await renderOrder(spec, { ...noExtra, mustRead: MUST_READ.replace('c00005', 'c00020') })).toMatchFileSnapshot('./__golden__/order.finale-forced.golden.md');
  });
  it('write-feedback (phrases + short line)', async () => {
    const spec = orderSpec({ feedback: { phrases: ['深吸一口气', '月光洒在青石板上', '嘴角'], range: [1, 5], shortRecent: true } });
    await expect(await renderOrder(spec, { ...noExtra, mustRead: MUST_READ })).toMatchFileSnapshot('./__golden__/order.write-feedback.golden.md');
  });
  it('retro', async () => {
    const spec = orderSpec({ mode: 'retro', kind: 'book.retro', from: 21, count: 0, accepted: 20, planned: 50, totalCjk: 81000, retro: { from: 1, to: 20 }, effort: 'medium' });
    const mustRead = ['- notes/progress.md、outline.md、bible.md、notes/cast.md、notes/threads.md、notes/retro.md；', '- notes/chapters.md 的最后 30 行；'].join('\n');
    await expect(await renderOrder(spec, { ...noExtra, mustRead })).toMatchFileSnapshot('./__golden__/order.retro.golden.md');
  });
});

describe('ORDER.md phase-2 blocks', () => {
  it('retro order has no hints block and no owner line (even with hints and an owner note)', async () => {
    const hint: V3Hint = { kind: 'short', chapter: 4, rewrite: 4, at: AT, text: '第 4 章补一补' };
    const spec = orderSpec({ mode: 'retro', kind: 'book.retro', from: 21, count: 0, accepted: 20, retro: { from: 11, to: 20 }, hintsShown: [hint] });
    const out = await renderOrder(spec, { ...noExtra, mustRead: '- bible.md；', ownerNote: true, budgets: 'bible.md 太长了' });
    expect(out).not.toContain('系统提示');
    expect(out).not.toContain('from-owner');
    expect(out).not.toContain('补一补');
    expect(out).toMatch(/^任务：复盘第 11–20 章（这次不写新章）$/m);
    expect(out).toContain('- 第 11–20 章全文：manuscript/c00011.md 到 manuscript/c00020.md。');
  });
  it('owner line in open/write/finale when from-owner.md is non-empty; not in must_read', async () => {
    for (const spec of [orderSpec(), orderSpec({ mode: 'finale', finale: true }), orderSpec({ mode: 'open-long', kind: 'book.open', from: 1, accepted: 0 })]) {
      const out = await renderOrder(spec, { ...noExtra, mustRead: MUST_READ, ownerNote: true });
      expect(out).toContain('\n主人给你留了话：notes/from-owner.md（只读）。动笔前先读一遍，照着做。\n');
      expect(out).not.toContain('- 主人给你的话');
      expect(await renderOrder(spec, { ...noExtra, mustRead: MUST_READ })).not.toContain('from-owner');
    }
  });
  it('renderEnding branches', () => {
    const base = orderSpec({ from: 18, accepted: 17, planned: 27 });
    expect(renderEnding(base)).toBe('');
    expect(renderEnding({ ...base, phase: 'closing' })).toMatch(/^## 收尾阶段\n全书计划共 27 章，还剩约 10 章。动笔前先在 outline.md 里加一节"## 结局章节清单"：从第 18 章到全书结束/);
    expect(renderEnding({ ...base, phase: 'closing', endingListExists: true })).toBe('## 收尾阶段\n全书计划共 27 章，还剩约 10 章。照 outline.md 的"结局章节清单"往下写；清单要调整就直接改，未收线索的去处同步改在 notes/threads.md。\n');
    expect(renderEnding({ ...base, runawayWarn: true, runawayBase: 12 })).toBe('## 提醒\n这本书已经写了 17 章，比当初计划的 12 章多出很多。按大纲在三批之内收尾，不再开新的支线。\n');
    expect(renderEnding({ ...base, phase: 'closing', endingListExists: true, runawayWarn: true, runawayBase: 12 }).split('\n')).toHaveLength(4);
    expect(renderEnding({ ...base, forced: true })).toBe('## 这是最后一批\n这是最后一批：把剩下的情节在这一批里收束，写完全书，最后一章末尾单独一行写"（全书完）"。\n');
  });
  it('renderFeedback branches', () => {
    expect(renderFeedback(undefined)).toBe('');
    expect(renderFeedback({ phrases: [], range: null, shortRecent: false })).toBe('');
    expect(renderFeedback({ phrases: ['甲乙丙丁'], range: null, shortRecent: false })).toBe('## 上一批的统计（服务器数的，仅供参考）\n- 上一批里重复较多的说法：「甲乙丙丁」。这一批换着写。\n');
    expect(renderFeedback({ phrases: ['甲乙丙丁', '戊己'], range: [6, 10], shortRecent: true })).toBe('## 上一批的统计（服务器数的，仅供参考）\n- 上一批（第 6–10 章）里重复较多的说法：「甲乙丙丁」「戊己」。这一批换着写。\n- 近期的章节偏短，这一批每章写足。\n');
    expect(renderFeedback({ phrases: [], range: [6, 10], shortRecent: true })).toBe('## 上一批的统计（服务器数的，仅供参考）\n- 近期的章节偏短，这一批每章写足。\n');
  });
  it('no new hard numbers: every "N 字" in the templates and the new blocks is min_chars / target_cjk / total_cjk', async () => {
    const allowed = new Set(['{{min_chars}}', '{{target_cjk}}', '{{total_cjk}}']);
    for (const name of await fs.readdir(ORDER_TEMPLATES_DIR)) {
      const tpl = await fs.readFile(path.join(ORDER_TEMPLATES_DIR, name), 'utf8');
      for (const m of tpl.matchAll(/(\{\{[a-z0-9_]+\}\}|\d+)\s*字/g)) expect(allowed.has(m[1] as string), `${name}: ${m[0]}`).toBe(true);
    }
    const base = orderSpec({ from: 18, accepted: 17, planned: 27 });
    const outs = [
      renderEnding({ ...base, phase: 'closing' }),
      renderEnding({ ...base, phase: 'closing', endingListExists: true, runawayWarn: true, runawayBase: 12 }),
      renderEnding({ ...base, forced: true }),
      renderFeedback({ phrases: ['甲乙丙丁'], range: [6, 10], shortRecent: true }),
    ];
    for (const o of outs) expect(o).not.toMatch(/\d+\s*字/);
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
      { spec: orderSpec({ phase: 'closing', feedback: { phrases: ['甲乙丙丁'], range: [1, 5], shortRecent: true } }), want: { mode: 'write', from: 6, count: 5 } },
      { spec: orderSpec({ mode: 'retro', kind: 'book.retro', from: 21, count: 0, accepted: 20, planned: 50, retro: { from: 11, to: 20 } }), want: { mode: 'retro', from: 11, count: 10, planned: 50 } },
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

describe('ORDER.md owner steering (WP-2)', () => {
  it('golden write-owner: owner line, the owner rewrite hint first, the chapter allowed for rewriting', async () => {
    const short: V3Hint = { kind: 'short', chapter: 4, rewrite: 4, at: AT, text: '第 4 章只有 2100 字，不到每章 3000 字的下限。先把第 4 章补到 3000 字以上（只补这一章，直接改 manuscript/c00004.md）。' };
    const owner = ownerRewriteHint({ chapter: 3, note: '主角在雨里那段太软了，让他先动手' }, AT);
    const spec = orderSpec({ hintsShown: [owner, short], allowRewrite: [3, 4], accepted: 5, totalCjk: 18234, ownerMessageSha: 'abc', ownerRequests: [{ id: 'q1', chapter: 3, note: '主角在雨里那段太软了，让他先动手' }] });
    const out = await renderOrder(spec, { ...noExtra, mustRead: MUST_READ, ownerNote: true });
    await expect(out).toMatchFileSnapshot('./__golden__/order.write-owner.golden.md');
    expect(out).toMatch(/^允许改写的旧章：第 3 章、第 4 章（见下面的系统提示）。/m);
    expect(out).toContain('\n1. 主人要求改写第 3 章：主角在雨里那段太软了，让他先动手。直接改 manuscript/c00003.md（整章重写或局部修改都行），改完再写这一批的新章。\n2. 第 4 章只有');
    expect(parseOrderText(out)?.allowRewrite).toEqual([3, 4]);
  });
  it('owner rewrite hint without a note', () => {
    expect(ownerRewriteHint({ chapter: 7, note: '  ' }, AT)).toEqual({ kind: 'owner_rewrite', chapter: 7, rewrite: 7, at: AT, text: '主人要求重写第 7 章。直接改 manuscript/c00007.md，改完再写这一批的新章。' });
  });
  it('waitingOwnerRequests: waiting, unpublished, already written; sorted by chapter; a chapter locked again after the request (owner edit / adopt) is left out', () => {
    const r = (id: string, chapter: number, status: 'waiting' | 'done' = 'waiting') => ({ id, kind: 'rewrite' as const, chapter, note: '', at: AT, status });
    const meta = { ...emptyV3Meta(), locked: [6], ownerRequests: [r('a', 6), r('b', 2), r('c', 9), r('d', 4, 'done'), r('e', 5), r('f', 7)] };
    expect(waitingOwnerRequests(meta, 2, 8).map((x) => x.id)).toEqual(['e', 'f']);
  });
});

describe('buildOrderSpec with owner messages and requests (WP-2, DB)', () => {
  let t: OrchTestEnv;
  let env: ExecEnv;
  beforeEach(async () => {
    t = await createOrchTestEnv();
    env = execEnv(t.deps);
  });
  afterEach(async () => {
    await t.close();
  });
  const req = (id: string, chapter: number, note = '改一改') => ({ id, kind: 'rewrite' as const, chapter, note, at: AT, status: 'waiting' as const });
  async function build(slug: string, o: NonNullable<Parameters<typeof addV3Book>[2]>, params: Record<string, unknown> = {}, kind: 'book.write' | 'book.retro' | 'book.open' = 'book.write') {
    const b = await addV3Book(t, slug, o);
    const book = await env.pipe.openBook(env.pdeps, b.id);
    const ctx: PipelineContext = { deps: env.pdeps, book };
    const accepted = o.chapters ?? 0;
    const task = { id: `t-${slug}`, kind, target: 'x', params: { from: accepted + 1, ...params } } as unknown as TaskRow;
    return { b, out: await buildOrderSpec(ctx, book, task) };
  }

  it('owner request → first hint + allowRewrite + spec.ownerRequests; owner message sha recorded; must_read has no owner line', async () => {
    const { b, out } = await build('ow', { chapters: 6, meta: { ownerRequests: [req('q1', 4, '节奏太慢')], hints: [{ kind: 'short', chapter: 5, rewrite: 5, at: AT, text: '第 5 章补' }] }, files: { 'notes/from-owner.md': '多写对话。\n' } });
    expect('spec' in out).toBe(true);
    if (!('spec' in out)) return;
    expect(out.spec.hintsShown.map((h) => [h.kind, h.chapter])).toEqual([
      ['owner_rewrite', 4],
      ['short', 5],
    ]);
    expect(out.spec.allowRewrite).toEqual([4, 5]);
    expect(out.spec.ownerRequests).toEqual([{ id: 'q1', chapter: 4, note: '节奏太慢' }]);
    expect(out.spec.ownerMessageSha).toBe((await b.repo.blobShas(['notes/from-owner.md']))['notes/from-owner.md']);
    expect(out.extra.ownerNote).toBe(true);
    expect(out.extra.mustRead).not.toContain('from-owner');
  });

  it('a request on a chapter published since → not shown; empty from-owner.md → no sha, no owner line', async () => {
    const { out } = await build('owp', { chapters: 6, published: 4, meta: { ownerRequests: [req('q1', 3), req('q2', 5)] }, files: { 'notes/from-owner.md': '\n' } });
    if (!('spec' in out)) throw new Error('skipped');
    expect(out.spec.ownerRequests?.map((r) => r.chapter)).toEqual([5]);
    expect(out.spec.hintsShown.map((h) => h.chapter)).toEqual([5]);
    expect(out.spec.ownerMessageSha).toBeNull();
    expect(out.extra.ownerNote).toBe(false);
  });

  it('buffer full + waiting request → not skipped (one extra batch); without a request → skipped waiting', async () => {
    const full = await build('owf', { chapters: 15, planned: 30, meta: { ownerRequests: [req('q1', 10)] } });
    expect('spec' in full.out).toBe(true);
    const none = await build('ownf', { chapters: 15, planned: 30 });
    expect('skip' in none.out && none.out.skip.status).toBe('waiting');
    await t.db.update(books).set({ pausedReason: 'max_buffer' }).where(eq(books.id, full.b.id));
    const book = await env.pipe.openBook(env.pdeps, full.b.id);
    expect('spec' in (await buildOrderSpec({ deps: env.pdeps, book }, book, { id: 'x', kind: 'book.write', target: 'x', params: { from: 16 } } as unknown as TaskRow))).toBe(true);
  });

  it('a finale is not held by the buffer cap (pausedReason max_buffer or buffer ≥ max_buffer); after a marker-less finale it is again', async () => {
    // 中篇 planned 16、已写 15：下一批是 1 章的结局批
    const paused = await build('finbuf', { chapters: 15, planned: 16, published: 1 });
    await t.db.update(books).set({ pausedReason: 'max_buffer' }).where(eq(books.id, paused.b.id));
    const book = await env.pipe.openBook(env.pdeps, paused.b.id);
    const out = await buildOrderSpec({ deps: env.pdeps, book }, book, { id: 'x', kind: 'book.write', target: 'x', params: { from: 16, mode: 'write' } } as unknown as TaskRow);
    if (!('spec' in out)) throw new Error('skipped');
    expect([out.spec.mode, out.spec.from, out.spec.count]).toEqual(['finale', 16, 1]);
    // 上一个结局批没写（全书完）：照常受存稿上限约束，等待原因是 buffer_full
    const again = await build('finbuf2', { chapters: 15, planned: 16, published: 0, meta: { finaleNoMarker: 1 } });
    expect('skip' in again.out && again.out.skip).toMatchObject({ status: 'waiting', message: 'buffer_full' });
  });

  it('remaining ≤ 1.5 batches → one merged finale; the count is recomputed from the DB, not from the task params', async () => {
    const { out } = await build('finmerge', { chapters: 10, planned: 16 }, { mode: 'write', count: 5 });
    if (!('spec' in out)) throw new Error('skipped');
    expect([out.spec.mode, out.spec.from, out.spec.count, out.spec.finale]).toEqual(['finale', 11, 6, true]);
  });

  it('retro must-read lists enough lines of notes/chapters.md to cover the whole range (batch 8, 40 chapters)', async () => {
    const batchLog = [1, 2, 3, 4, 5].map((i) => ({ runId: `r${i}`, kind: 'write' as const, from: 8 * i - 7, to: 8 * i, baseCommit: 'b', finalCommit: 'f', at: AT }));
    const { out } = await build('retro40', { chapters: 40, length: 'epic', planned: 120, batch: 8, meta: { batchLog } }, { from: 1, to: 40 }, 'book.retro');
    if (!('spec' in out)) throw new Error('skipped');
    expect(out.extra.mustRead).toContain('- notes/chapters.md 的最后 45 行；');
    // 写作批照旧 30 行
    const w = await build('write30', { chapters: 6, planned: 30 });
    if (!('spec' in w.out)) throw new Error('skipped');
    expect(w.out.extra.mustRead).toContain('- notes/chapters.md 的最后 30 行；');
  });

  it('retro orders carry neither the owner message nor requests', async () => {
    const batchLog = [1, 2, 3, 4].map((i) => ({ runId: `r${i}`, kind: 'write' as const, from: 2 * i - 1, to: 2 * i, baseCommit: 'b', finalCommit: 'f', at: AT }));
    const { out } = await build('owr', { chapters: 8, length: 'long', planned: 30, meta: { batchLog, ownerRequests: [req('q1', 4)] }, files: { 'notes/from-owner.md': '多写对话。\n' } }, { from: 1, to: 8 }, 'book.retro');
    if (!('spec' in out)) throw new Error('skipped');
    expect(out.spec.ownerMessageSha).toBeNull();
    expect(out.spec.ownerRequests).toEqual([]);
    expect(out.spec.hintsShown).toEqual([]);
    expect(out.extra.ownerNote).toBe(false);
  });

  it('open orders carry the v3 library digest (WP-3): other books with blurb and tags, placeholders and self left out', async () => {
    await t.db.insert(books).values([
      { id: 'lib-a', slug: 'lib-a', title: '雨夜来客', genre: 'xianxia', meta: { blurb: '邮差收到寄给自己的信。', tags: ['悬疑', '书信'] } },
      { id: 'lib-b', slug: 'lib-b', title: '待命名·x1', genre: 'xianxia', meta: {} },
      { id: 'lib-c', slug: 'lib-c', title: '旧港', genre: 'other', meta: { tags: ['悬疑'] } },
    ]);
    const { out } = await build('libo', { chapters: 0, status: 'planning' }, { mode: 'open-long', count: 5 }, 'book.open');
    if (!('spec' in out)) throw new Error('skipped');
    expect(out.extra.library).toBe(
      ['书库摘要（不要和这些书雷同）：', '同题材（xianxia）：', '- 《雨夜来客》：邮差收到寄给自己的信。｜标签：悬疑、书信', '最近的书：', '- 《旧港》', '近期用得最多的标签（这本尽量避开）：悬疑、书信', ''].join('\n'),
    );
  });
});
