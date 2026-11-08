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
