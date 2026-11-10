/**
 * 中文计数（DESIGN §6.5 count_mode）。纯函数，web 与 server 共用；validators、context、nv count 都用它。
 * - han：只计汉字（CJK 统一表意文字 + 扩展区 + 兼容区）
 * - platform：平台口径 = 汉字 + 全角标点 + 字母数字串（每个连续串计 1）——近似起点/番茄的“字数”
 */
import type { CountMode } from './enums.js';

const HAN_RE = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2ebef}\u{30000}-\u{3134f}]/gu;
const CJK_PUNCT_RE = /[　-〿＀-￯—…“”‘’]/gu;
const ALNUM_RUN_RE = /[A-Za-z0-9]+/g;

export function countHan(text: string): number {
  return text.match(HAN_RE)?.length ?? 0;
}

export function countCjk(text: string, mode: CountMode = 'han'): number {
  const han = countHan(text);
  if (mode === 'han') return han;
  const punct = text.match(CJK_PUNCT_RE)?.length ?? 0;
  const alnum = text.match(ALNUM_RUN_RE)?.length ?? 0;
  return han + punct + alnum;
}

/** beat 锚点：独占一行的 `<!-- beat:b3 -->`（promote 时剥离；§6.5 beat.markers） */
export const BEAT_MARKER_RE = /^<!--\s*beat:(b\d+)\s*-->\s*$/gm;

export function stripBeatMarkers(text: string): string {
  return text.replace(BEAT_MARKER_RE, '').replace(/\n{3,}/g, '\n\n');
}

/** 按 beat 锚点切分并计数；锚点之前的文字计入 key '_pre' */
export function countByBeat(text: string, mode: CountMode = 'han'): Record<string, number> {
  const out: Record<string, number> = {};
  const re = new RegExp(BEAT_MARKER_RE.source, 'gm');
  let last = 0;
  let cur = '_pre';
  for (const m of text.matchAll(re)) {
    out[cur] = (out[cur] ?? 0) + countCjk(text.slice(last, m.index), mode);
    cur = m[1] ?? '_pre';
    last = (m.index ?? 0) + m[0].length;
  }
  out[cur] = (out[cur] ?? 0) + countCjk(text.slice(last), mode);
  return out;
}

/** 统一空白与标点（ev 逐字匹配前的规范化；§6.6） */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[“”"「」『』]/g, '"')
    .replace(/[‘’'']/g, "'")
    .replace(/[，,]/g, ',')
    .replace(/[。．.]/g, '.')
    .replace(/[！!]/g, '!')
    .replace(/[？?]/g, '?')
    .replace(/[：:]/g, ':')
    .replace(/[；;]/g, ';')
    .replace(/……|…|\.{3,}/g, '…')
    .replace(/——|—/g, '—');
}

// ───────────────────────── v3：章节标题（harvest 与阅读器共用） ─────────────────────────

const CN_DIGITS: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** Chinese or Arabic numeral → int ("十二"→12, "一百零三"→103, "０７"→7); null if not a number */
export function parseCnNumber(s: string): number | null {
  const t = s.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (t === '') return null;
  if (/^[0-9]+$/.test(t)) return Number.parseInt(t, 10);
  const chars = [...t];
  if (!chars.every((c) => c in CN_DIGITS || c in CN_UNITS || c === '万')) return null;
  // 没有单位（"一〇三"）：逐位拼
  if (!chars.some((c) => c in CN_UNITS || c === '万')) return Number.parseInt(chars.map((c) => String(CN_DIGITS[c])).join(''), 10);
  let total = 0;
  let section = 0;
  let num = 0;
  let seenDigit = false;
  for (const c of chars) {
    if (c in CN_DIGITS) {
      num = CN_DIGITS[c] ?? 0;
      seenDigit = true;
    } else if (c === '万') {
      total += (section + num || 1) * 10_000;
      section = 0;
      num = 0;
    } else {
      section += (seenDigit ? num : 1) * (CN_UNITS[c] ?? 1);
      num = 0;
      seenDigit = false;
    }
  }
  return total + section + num;
}

const CN_NUM_SRC = '[〇零一二两三四五六七八九十百千万0-9０-９]+';
/**
 * Strict heading line (also the only form accepted on a bare line, without "#" or "**"):
 * "# 第七章 雨夜", "第7章：雨夜", "## 第十二回", "第十二章（上）". Only 章/回 — "第一节" is a section inside a chapter.
 */
export const CHAPTER_HEADING_RE = new RegExp(`^\\s*(?:#{1,6}\\s*)?第\\s*(${CN_NUM_SRC})\\s*[章回](?:(?:[\\s:：·、．.\\-—]+|(?=[（(「『【]))(.{0,60}?))?\\s*$`, 'u');
/** Inside a markdown heading or a **bold** line: optional "第X卷/部/集" prefix, any separator or none ("# 第十二章夜雨") */
const LOOSE_HEADING_RE = new RegExp(`^(?:第\\s*${CN_NUM_SRC}\\s*[卷部集]\\s*[\\s:：·、．.\\-—]*)?第\\s*(${CN_NUM_SRC})\\s*[章回]\\s*[\\s:：·、．.\\-—]*(.{0,60}?)\\s*$`, 'u');
const MD_HEADING_RE = /^\s*#{1,6}\s*(.*?)\s*#*\s*$/u;
const BOLD_LINE_RE = /^\s*\*\*\s*(.+?)\s*\*\*\s*$/u;
const TITLE_EDGE_RE = /^[\s:：·、．.\-—]+|[\s:：·、．.\-—#]+$/gu;
const WRAPPED_TITLE_RE = /^[「『【《](.+)[」』】》]$/u;

function cleanTitle(raw: string): string {
  const t = raw.replace(TITLE_EDGE_RE, '');
  const w = WRAPPED_TITLE_RE.exec(t);
  return w ? (w[1] ?? '').trim() : t;
}

/** The text inside a markdown heading ("# …") and/or a bold wrapper ("**…**"); null for a bare line */
function headingInner(line: string): string | null {
  let inner: string | null = null;
  let s = line;
  const h = /^\s*#/.test(s) ? MD_HEADING_RE.exec(s) : null;
  if (h) {
    inner = h[1] ?? '';
    s = inner;
  }
  const b = BOLD_LINE_RE.exec(s);
  if (b) inner = b[1] ?? '';
  return inner;
}

/** {no, title} from a heading line; title has the "第X章" prefix and surrounding punctuation removed; '' when none */
export function parseChapterHeading(line: string): { no: number | null; title: string } | null {
  const inner = headingInner(line);
  if (inner !== null) {
    const l = LOOSE_HEADING_RE.exec(inner);
    if (l) return { no: parseCnNumber(l[1] ?? ''), title: cleanTitle(l[2] ?? '') };
  }
  const m = CHAPTER_HEADING_RE.exec(line);
  if (m) return { no: parseCnNumber(m[1] ?? ''), title: cleanTitle(m[2] ?? '') };
  if (inner !== null && /^\s*#/.test(line)) {
    // 很长的章名之类：仍然去掉开头的 "第X章"，免得阅读器里出现两遍
    const pre = new RegExp(`^(?:第\\s*${CN_NUM_SRC}\\s*[卷部集]\\s*[\\s:：·、．.\\-—]*)?第\\s*(${CN_NUM_SRC})\\s*[章回]`, 'u').exec(inner);
    const title = cleanTitle(pre ? inner.slice(pre[0].length) : inner);
    if (pre) return { no: parseCnNumber(pre[1] ?? ''), title };
    return title === '' ? null : { no: null, title };
  }
  return null;
}

/** A line that starts a chapter: a "#"/"**" line holding "第X章…" (loose), or a bare line in the strict form */
export function isChapterHeading(line: string): boolean {
  const inner = headingInner(line);
  if (inner !== null && LOOSE_HEADING_RE.test(inner)) return true;
  return CHAPTER_HEADING_RE.test(line);
}

/** Drop the first non-empty line when it is a markdown heading (# …); used by the reader for v3 books */
export function stripTitleLine(text: string): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() !== '');
  if (i < 0 || !/^\s*#{1,6}(\s|$)/.test(lines[i] ?? '')) return text;
  let j = i + 1;
  while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
  return lines.slice(j).join('\n');
}
