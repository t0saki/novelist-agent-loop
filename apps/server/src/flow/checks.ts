/**
 * v3 逐章检查（docs/v3/DESIGN.md §3.3；p1-plan §2.7）。纯函数：只做数得出来的检查——空、截断、和别的章大段逐字重复、字数下限。
 */
import { countCjk, parseChapterHeading } from '@novelist/shared';
import { checkTruncation } from '../validators/truncation.js';
import { stripForRepeat } from '../validators/util.js';
import { END_MARKER_RE } from './contract.js';

export type ChapterFail = 'empty' | 'truncated' | 'duplicate';

export const DUP_RUN_CHARS = 300;
export const EMPTY_CJK = 100;

const TAIL_NOTE_RE = /^\s*[（(【[]?\s*(本章完|未完待续|待续|完|终)\s*[）)】\]]?\s*$/u;
const META_LINE_RE = /^\s*(作者注|作者的话|创作说明|写作说明|创作笔记|字数统计|本章字数)\s*[:：]/u;
const FENCE_RE = /^\s*(```|~~~)/u;
const SEPARATOR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/u;
/** 最后一段末尾内嵌的全书完：……他走了。（全书完） / ……他走了。——全书完—— */
const INLINE_END_RE = /\s*(?:[—\-]+\s*[（(【[]?\s*全[书文][完终]结?\s*[）)】\]]?|[（(【[]\s*全[书文][完终]结?\s*[）)】\]])\s*[—\-]*\s*$/u;

/**
 * 去掉夹带：HTML 注释（beat 标记）、代码围栏行、"（本章完）"一类尾标行、作者注/创作说明等行、末尾的 --- 分隔线；
 * 所有全书完标记一律删掉（hadEndMarker 记下有没有），由调用方决定在哪里补回。
 * hadBareEndTail：去掉的尾标里，最后一个非空行恰好是"（完）/（终）"（结局批的末章里调用方把它当全书完）。
 */
export function cleanChapterText(raw: string): { text: string; stripped: string[]; hadEndMarker: boolean; hadBareEndTail: boolean } {
  const stripped = new Set<string>();
  let hadEndMarker = false;
  let hadBareEndTail = false;
  let text = raw.replace(/\r\n?/g, '\n');
  if (/<!--[\s\S]*?-->/.test(text)) {
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    stripped.add('html_comment');
  }
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (END_MARKER_RE.test(line)) {
      hadEndMarker = true;
      continue;
    }
    if (FENCE_RE.test(line)) {
      stripped.add('code_fence');
      continue;
    }
    const tn = TAIL_NOTE_RE.exec(line);
    if (tn) {
      stripped.add('tail_note');
      hadBareEndTail = tn[1] === '完' || tn[1] === '终';
      continue;
    }
    if (META_LINE_RE.test(line)) {
      stripped.add('meta_line');
      continue;
    }
    if (line.trim() !== '' && !SEPARATOR_RE.test(line)) hadBareEndTail = false;
    lines.push(line);
  }
  // 末尾：空行、分隔线、内嵌在最后一段末尾的全书完
  for (;;) {
    while (lines.length && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    const last = lines[lines.length - 1];
    if (last === undefined) break;
    if (SEPARATOR_RE.test(last)) {
      lines.pop();
      stripped.add('separator');
      continue;
    }
    if (INLINE_END_RE.test(last)) {
      lines[lines.length - 1] = last.replace(INLINE_END_RE, '');
      hadEndMarker = true;
      continue;
    }
    break;
  }
  const out = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/u, '');
  return { text: out, stripped: [...stripped], hadEndMarker, hadBareEndTail };
}

/**
 * 规范化一章：清理夹带；首个非空行是标题时去掉并保留章名；输出统一的 "# 第{no}章 章名" 首行。
 * 没有章名时 title = ''（不编造"第N章"）。
 */
export function normaliseChapter(no: number, raw: string): { content: string; title: string; body: string; cjk: number; stripped: string[]; hadEndMarker: boolean; hadBareEndTail: boolean } {
  const c = cleanChapterText(raw);
  const lines = c.text.split('\n');
  const i = lines.findIndex((l) => l.trim() !== '');
  let title = '';
  let bodyLines = lines;
  if (i >= 0) {
    const h = parseChapterHeading(lines[i] ?? '');
    if (h) {
      title = h.title;
      bodyLines = lines.slice(i + 1);
    }
  }
  const body = bodyLines.join('\n').replace(/^\s*\n/, '').replace(/^\n+/, '').replace(/\s+$/u, '');
  const content = `# 第${no}章${title ? ` ${title}` : ''}\n\n${body}\n`;
  return { content, title, body, cjk: countCjk(body), stripped: c.stripped, hadEndMarker: c.hadEndMarker, hadBareEndTail: c.hadBareEndTail };
}

/**
 * 逐字重复检查之前去掉引用：以 > 开头的行、整行被「」『』“”包住的行、以及从一个不含收引号的开引号行到收引号行结束的多段引文（书信、誓词、歌词）。
 * 夹在叙述里的对话（"「你好。」他说。"）不算整行引用，照样比较。
 */
export function stripQuoted(text: string): string {
  const PAIRS: Record<string, string> = { '「': '」', '『': '』', '“': '”' };
  const out: string[] = [];
  let closing: string | null = null;
  for (const line of text.split('\n')) {
    const t = line.trim().replace(/^[　\s]+/u, '');
    if (closing) {
      if (t.endsWith(closing)) closing = null;
      continue;
    }
    if (t.startsWith('>')) continue;
    const open = t.charAt(0);
    const close = PAIRS[open];
    if (close) {
      if (t.endsWith(close) && t.length > 1) continue;
      if (!t.includes(close)) {
        closing = close;
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 两段文字（去掉空白后）共享的最长逐字片段长度（50 字 shingle 起步；短于 shingle 的重复记 0）。
 * 每个 shingle 只记前 8 个出现位置，避免高度重复的文本退化成平方复杂度。
 */
export function longestSharedRun(a: string, b: string, shingle = 50): number {
  const sa = stripForRepeat(a).s;
  const sb = stripForRepeat(b).s;
  if (sa.length < shingle || sb.length < shingle) return 0;
  const idx = new Map<string, number[]>();
  for (let j = 0; j + shingle <= sb.length; j++) {
    const k = sb.slice(j, j + shingle);
    const arr = idx.get(k);
    if (!arr) idx.set(k, [j]);
    else if (arr.length < 8) arr.push(j);
  }
  let best = 0;
  let i = 0;
  while (i + shingle <= sa.length) {
    const js = idx.get(sa.slice(i, i + shingle));
    if (!js) {
      i++;
      continue;
    }
    let forward = shingle;
    for (const j of js) {
      let back = 0;
      while (i - back - 1 >= 0 && j - back - 1 >= 0 && sa[i - back - 1] === sb[j - back - 1]) back++;
      let e = shingle;
      while (i + e < sa.length && j + e < sb.length && sa[i + e] === sb[j + e]) e++;
      best = Math.max(best, back + e);
      forward = Math.max(forward, e);
    }
    i += Math.max(1, forward - shingle + 1);
  }
  return best;
}

/** 新章检查（body = normaliseChapter 的 body，已去掉标题行和全书完）。others = 本批其他新章 + base 上最近 30 章，不含同一章号的旧版 */
export function checkNewChapter(
  body: string,
  others: { no: number; text: string }[],
  minChars: number,
): { ok: true; short: boolean } | { ok: false; reason: ChapterFail; detail: string; dupOf?: number } {
  const cjk = countCjk(body);
  if (cjk < EMPTY_CJK) return { ok: false, reason: 'empty', detail: `只有 ${cjk} 字` };
  const t = checkTruncation(body, { sentence: true, variantEnds: true });
  if (!t.ok) return { ok: false, reason: 'truncated', detail: t.detail ?? '结尾不完整' };
  // 有意的引用（重读一封信、反复出现的誓词或歌词）不算重复：引用段两边都不比
  const mine = stripQuoted(body);
  for (const o of others) {
    const run = longestSharedRun(mine, stripQuoted(o.text));
    if (run >= DUP_RUN_CHARS) return { ok: false, reason: 'duplicate', detail: `和第 ${o.no} 章有 ${run} 字逐字重复`, dupOf: o.no };
  }
  return { ok: true, short: cjk < minChars };
}

/** 改写旧章：比旧版短三成以上或截断就不收 */
export function checkRewrite(oldBody: string, newBody: string): { ok: true } | { ok: false; reason: 'shorter' | 'truncated'; detail: string } {
  const oldCjk = countCjk(oldBody);
  const newCjk = countCjk(newBody);
  if (newCjk < 0.7 * oldCjk) return { ok: false, reason: 'shorter', detail: `${newCjk} 字，旧版 ${oldCjk} 字` };
  const t = checkTruncation(newBody, { sentence: true, variantEnds: true });
  if (!t.ok) return { ok: false, reason: 'truncated', detail: t.detail ?? '结尾不完整' };
  return { ok: true };
}
