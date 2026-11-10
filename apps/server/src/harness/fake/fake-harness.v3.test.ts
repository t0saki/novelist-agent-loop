/**
 * fake harness v3 目录模式（--v3，dirMain）：按 ORDER.md 的任务行在 cwd 里写书；混沌开关（fake.json 的 v3 键）。
 * 每个用例在临时目录里起一个真实子进程（killAfter 要看到 SIGKILL）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAPTER_HEADING_RE, countCjk, parseChapterHeading, V3_LAUNCH_PROMPT } from '@novelist/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { checkTruncation } from '../../validators/truncation.js';
import { FAKE_END_MARKER, parseOrderText, type FakeScenario } from './fake-harness.js';

const SCRIPT = fileURLToPath(new URL('./fake-harness.ts', import.meta.url));
const MIN = 300;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const ORDER = {
  openShort: `# 任务单\n\n任务：开书，并写完整本（约 4 章）\n\n3. 写 outline.md：一行"计划：共 N 章"（建议 4 章，最多 8 章）。\n6. 全书不少于 1200 字，每章不少于 ${MIN} 字，不设上限。\n`,
  openLong: `# 任务单\n\n任务：开书，并写第 1–5 章（共 5 章）\n\n3. 写 outline.md：一行"计划：共 N 章"（建议 15 章，可以加到 30 章）。\n7. 全书不少于 4500 字，每章不少于 ${MIN} 字，不设上限。\n`,
  write: (rewrite = '不改写旧章：已写好的章节不要动。') =>
    `# 任务单\n\n任务：新写第 6–8 章（共 3 章）\n${rewrite}\n\n进度：已写 5 章，共 2000 字；计划共 15 章，全书不少于 4500 字。每章不少于 ${MIN} 字，不设上限。\n`,
  finale: `# 任务单\n\n任务：结局批，从第 11 章写到全书结束（计划还剩约 2 章，章数不限）\n不改写旧章：已写好的章节不要动。\n\n进度：已写 10 章，共 4000 字；计划共 12 章，全书不少于 4500 字。每章不少于 ${MIN} 字，不设上限。\n`,
};

interface Ran {
  dir: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  events: Record<string, unknown>[];
  read(rel: string): string | null;
  files(): string[];
}

function listFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** 在临时“书快照”里跑一次 dirMain；pre 是运行前已有的文件 */
function run(order: string, scenario?: FakeScenario, pre: Record<string, string> = {}): Ran {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-fake-v3-'));
  roots.push(root);
  const dir = path.join(root, 'book');
  const inDir = path.join(root, 'in');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(inDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ORDER.md'), order);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 写作指令\n');
  for (const [rel, text] of Object.entries(pre)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const launch = path.join(inDir, 'launch.md');
  fs.writeFileSync(launch, `${V3_LAUNCH_PROMPT}\n`);
  if (scenario) fs.writeFileSync(path.join(inDir, 'fake.json'), JSON.stringify(scenario));
  const r = spawnSync(process.execPath, [SCRIPT, '--v3', '--launch', launch, '--model', 'fake-model', '--session', 'sess-1'], { cwd: dir, encoding: 'utf8', timeout: 25_000 });
  const events = r.stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    dir,
    status: r.status,
    signal: r.signal,
    events,
    read: (rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : null),
    files: () => listFiles(dir).filter((f) => f !== 'ORDER.md' && f !== 'AGENTS.md'),
  };
}

const c5 = (k: number) => `manuscript/c${String(k).padStart(5, '0')}.md`;
const bodyOf = (text: string) => text.split('\n').slice(1).join('\n').replace(FAKE_END_MARKER, '');
const lastLine = (text: string) => text.trimEnd().split('\n').at(-1) ?? '';
const resultOf = (r: Ran) => r.events.find((e) => e.t === 'result');
const SHORT_BIBLE = '# 《旧名》\n一句话：旧的一句话。\n标签：旧\n';

function expectChapter(r: Ran, k: number, o: { marker?: boolean } = {}) {
  const text = r.read(c5(k));
  expect(text, c5(k)).not.toBeNull();
  const first = text!.split('\n')[0]!;
  expect(first).toMatch(CHAPTER_HEADING_RE);
  expect(parseChapterHeading(first)?.no).toBe(k);
  expect(parseChapterHeading(first)?.title).not.toBe('');
  expect(text).not.toMatch(/<!--/);
  expect(countCjk(bodyOf(text!))).toBeGreaterThanOrEqual(MIN);
  expect(checkTruncation(bodyOf(text!), { sentence: true }).ok).toBe(true);
  if (o.marker) expect(lastLine(text!)).toBe(FAKE_END_MARKER);
  else expect(text).not.toContain(FAKE_END_MARKER);
}

describe('parseOrderText', () => {
  it('四种任务行 + 下限 + 允许改写', () => {
    expect(parseOrderText(ORDER.openShort)).toMatchObject({ mode: 'open-short', from: 1, count: 4, planned: 4, minChars: MIN, allowRewrite: [] });
    expect(parseOrderText(ORDER.openLong)).toMatchObject({ mode: 'open-long', from: 1, count: 5, planned: 15 });
    expect(parseOrderText(ORDER.write())).toMatchObject({ mode: 'write', from: 6, count: 3, planned: 15 });
    expect(parseOrderText(ORDER.finale)).toMatchObject({ mode: 'finale', from: 11, count: 2, planned: 12 });
    expect(parseOrderText(ORDER.write('允许改写的旧章：第 3 章、第 5 章（见下面的系统提示）。除此之外，已写好的章节不要动。'))?.allowRewrite).toEqual([3, 5]);
    expect(parseOrderText('# 随便写点')).toBeNull();
  });
});

describe('fake harness v3 目录模式', () => {
  it('open-short：bible / outline / progress + c1..cN，最后一章有（全书完）', () => {
    const r = run(ORDER.openShort);
    expect(r.status).toBe(0);
    expect(r.files()).toEqual(['bible.md', c5(1), c5(2), c5(3), c5(4), 'notes/progress.md', 'outline.md']);
    const bible = r.read('bible.md')!.split('\n');
    expect(bible[0]).toMatch(/^# 《假书名·[0-9a-f]{6}》$/);
    expect(bible[1]).toMatch(/^一句话：/);
    expect(bible[2]).toMatch(/^标签：/);
    expect(r.read('outline.md')).toMatch(/计划：共 4 章/);
    for (const k of [1, 2, 3]) expectChapter(r, k);
    expectChapter(r, 4, { marker: true });
    expect(resultOf(r)).toMatchObject({ t: 'result', status: 'success' });
    expect(r.events[0]).toMatchObject({ t: 'init', sessionId: 'sess-1', model: 'fake-model' });
    expect(r.events.filter((e) => e.t === 'file_change').length).toBe(7);
    expect(r.events.some((e) => e.t === 'usage')).toBe(true);
  });

  it('open-long：c1..cB，没有（全书完），四个笔记文件', () => {
    const r = run(ORDER.openLong);
    expect(r.status).toBe(0);
    for (const k of [1, 2, 3, 4, 5]) expectChapter(r, k);
    expect(r.read(c5(6))).toBeNull();
    for (const f of ['notes/progress.md', 'notes/chapters.md', 'notes/cast.md', 'notes/threads.md']) expect(r.read(f), f).not.toBeNull();
    expect(r.read('notes/chapters.md')!.split('\n').filter((l) => l.startsWith('第')).length).toBe(5);
    expect(r.read('outline.md')).toMatch(/计划：共 15 章/);
  });

  it('开书时 bible.md 已存在：不动它', () => {
    const r = run(ORDER.openLong, undefined, { 'bible.md': SHORT_BIBLE });
    expect(r.read('bible.md')).toBe(SHORT_BIBLE);
    expectChapter(r, 1);
  });

  it('write：写 from..to，notes/chapters.md 追加每章一行', () => {
    const pre = { 'notes/chapters.md': `# 每章一行\n\n${[1, 2, 3, 4, 5].map((k) => `第${k}章 旧：旧事。`).join('\n')}\n` };
    const r = run(ORDER.write(), undefined, pre);
    expect(r.status).toBe(0);
    for (const k of [6, 7, 8]) expectChapter(r, k);
    expect(r.read(c5(5))).toBeNull();
    expect(r.read(c5(9))).toBeNull();
    const lines = r.read('notes/chapters.md')!.split('\n').filter((l) => l.startsWith('第'));
    expect(lines.length).toBe(8);
    expect(lines.slice(0, 5)).toEqual([1, 2, 3, 4, 5].map((k) => `第${k}章 旧：旧事。`));
    expect(r.read('notes/progress.md')).toMatch(/写到第 8 章/);
    expect(r.read('bible.md')).toBeNull();
  });

  it('finale：最后一章末尾单独一行（全书完）', () => {
    const r = run(ORDER.finale);
    expectChapter(r, 11);
    expectChapter(r, 12, { marker: true });
  });

  it('允许改写的旧章：补到下限以上，原文保留在前', () => {
    const old = '# 第3章 旧章\n\n他推门进去，屋里没有人。\n';
    const r = run(ORDER.write('允许改写的旧章：第 3 章（见下面的系统提示）。除此之外，已写好的章节不要动。'), undefined, { [c5(3)]: old });
    const text = r.read(c5(3))!;
    expect(text.startsWith(old.trimEnd())).toBe(true);
    expect(countCjk(text)).toBeGreaterThanOrEqual(MIN);
    expect(checkTruncation(bodyOf(text), { sentence: true }).ok).toBe(true);
  });
});

describe('fake harness v3 混沌开关', () => {
  it('zeroOutput：目录不变，照常 success', () => {
    const r = run(ORDER.write(), { v3: { zeroOutput: true } });
    expect(r.status).toBe(0);
    expect(r.files()).toEqual([]);
    expect(resultOf(r)).toMatchObject({ status: 'success' });
  });

  it('shortChapter：本批第 2 章完整但不到下限', () => {
    const r = run(ORDER.write(), { v3: { shortChapter: 2 } });
    expectChapter(r, 6);
    expectChapter(r, 8);
    const t = r.read(c5(7))!;
    expect(countCjk(bodyOf(t))).toBeLessThan(MIN);
    expect(countCjk(bodyOf(t))).toBeGreaterThanOrEqual(100);
    expect(checkTruncation(bodyOf(t), { sentence: true }).ok).toBe(true);
  });

  it('truncateLast：最后一章停在半句话（结局批也不写标记）', () => {
    const r = run(ORDER.finale, { v3: { truncateLast: true } });
    expectChapter(r, 11);
    const t = r.read(c5(12))!;
    expect(t).not.toContain(FAKE_END_MARKER);
    expect(checkTruncation(bodyOf(t), { sentence: true }).ok).toBe(false);
  });

  it('wrongDir：正文在 chapters/00k.md，笔记在根目录 notes.md', () => {
    const r = run(ORDER.write(), { v3: { wrongDir: true } });
    expect(r.files()).toEqual(['chapters/006.md', 'chapters/007.md', 'chapters/008.md', 'notes.md']);
    expect(parseChapterHeading(r.read('chapters/007.md')!.split('\n')[0]!)?.no).toBe(7);
  });

  it('oneFile：全部章节在 manuscript/batch.md', () => {
    const r = run(ORDER.write(), { v3: { oneFile: true } });
    expect(r.files().filter((f) => f.startsWith('manuscript/'))).toEqual(['manuscript/batch.md']);
    const heads = r.read('manuscript/batch.md')!.split('\n').filter((l) => CHAPTER_HEADING_RE.test(l));
    expect(heads.map((l) => parseChapterHeading(l)?.no)).toEqual([6, 7, 8]);
  });

  it('rewriteAccepted：越权改写已入库的章', () => {
    const old = `# 第2章 旧章\n\n${'他推门进去，屋里没有人。'.repeat(30)}\n`;
    const r = run(ORDER.write(), { v3: { rewriteAccepted: 2 } }, { [c5(2)]: old });
    const t = r.read(c5(2))!;
    expect(t).not.toBe(old);
    expect(t.startsWith(old.trimEnd())).toBe(true);
    expectChapter(r, 6);
  });

  it('oldNumberElsewhere：另写 chapters/002.md（旧章号）', () => {
    const r = run(ORDER.write(), { v3: { oldNumberElsewhere: 2 } });
    expect(parseChapterHeading(r.read('chapters/002.md')!.split('\n')[0]!)?.no).toBe(2);
    for (const k of [6, 7, 8]) expectChapter(r, k);
  });

  it('ignoredDir：写 views/scratch.md（不是章节）', () => {
    const r = run(ORDER.write(), { v3: { ignoredDir: true } });
    const t = r.read('views/scratch.md')!;
    expect(t).not.toBeNull();
    expect(CHAPTER_HEADING_RE.test(t.split('\n')[0]!)).toBe(false);
  });

  it('noNotes：不写任何笔记', () => {
    const r = run(ORDER.openLong, { v3: { noNotes: true } });
    expect(r.files().some((f) => f.startsWith('notes/'))).toBe(false);
    expect(r.read('bible.md')).not.toBeNull();
    expectChapter(r, 5);
  });

  it('noMarker：结局批不写（全书完）', () => {
    const r = run(ORDER.finale, { v3: { noMarker: true } });
    expectChapter(r, 12);
  });

  it('endMarkerEarly：普通批也写（全书完）', () => {
    const r = run(ORDER.write(), { v3: { endMarkerEarly: true } });
    expectChapter(r, 7);
    expectChapter(r, 8, { marker: true });
  });

  it('chapters：覆盖本批章数（写多了）', () => {
    const r = run(ORDER.write(), { v3: { chapters: 5 } });
    for (const k of [6, 7, 8, 9, 10]) expectChapter(r, k);
  });

  it('killAfter：写完 k 章后 SIGKILL，前 k 章在，笔记没写', () => {
    const r = run(ORDER.write(), { v3: { killAfter: 2 } });
    expect(r.signal).toBe('SIGKILL');
    expectChapter(r, 6);
    expectChapter(r, 7);
    expect(r.read(c5(8))).toBeNull();
    expect(r.read('notes/progress.md')).toBeNull();
    expect(resultOf(r)).toBeUndefined();
  });

  it("fail:'quota' + failAfterWrite：章节和笔记写完后报额度错误", () => {
    const r = run(ORDER.write(), { fail: 'quota', failAfterWrite: true });
    expect(r.status).toBe(1);
    for (const k of [6, 7, 8]) expectChapter(r, k);
    expect(r.read('notes/progress.md')).not.toBeNull();
    expect(r.events.find((e) => e.t === 'error')).toMatchObject({ cls: 'quota' });
    expect(resultOf(r)).toMatchObject({ status: 'error' });
  });

  it("fail:'quota'（写之前）：什么都不写", () => {
    const r = run(ORDER.write(), { fail: 'quota' });
    expect(r.status).toBe(1);
    expect(r.files()).toEqual([]);
  });

  it('ORDER.md 认不出：config 错误退出', () => {
    const r = run('# 没有任务行\n');
    expect(r.status).toBe(2);
    expect(r.events.find((e) => e.t === 'error')).toMatchObject({ cls: 'config' });
  });
});
