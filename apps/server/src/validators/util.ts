/** validators 内部工具：正则编译、span、去空白映射、Finding 构造。Owner: lane D。 */
import type { Finding, Lexicon } from '@novelist/shared';
import { BEAT_MARKER_RE } from '@novelist/shared';

export interface TextSpan {
  start: number;
  end: number;
  text?: string;
}

/** 不转义 -：u 模式下字符类外的 \- 是语法错误 */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** 用户正则可能非法：不抛错，返回 null。优先 u 模式（CJK 扩展区），失败回退无 u */
export function compileRegex(source: string, flags = 'gu'): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    try {
      return new RegExp(source, flags.replace('u', ''));
    } catch {
      return null;
    }
  }
}

/** allow 项：字面量，或 /regex/flags 形式 */
export function compileAllow(item: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/su.exec(item);
  if (m) return compileRegex(m[1] as string, `g${(m[2] as string).replace('g', '')}`);
  return item ? compileRegex(escapeRegExp(item)) : null;
}

export function findSpans(re: RegExp, text: string, offset = 0, limit = 500): TextSpan[] {
  const out: TextSpan[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    const start = (m.index ?? 0) + offset;
    out.push({ start, end: start + m[0].length, text: m[0] });
    if (out.length >= limit) break;
  }
  return out;
}

export const spansOverlap = (a: TextSpan, b: TextSpan): boolean => a.start < b.end && b.start < a.end;

export function allowSpans(allow: string[], text: string): TextSpan[] {
  const out: TextSpan[] = [];
  for (const item of allow) {
    const re = compileAllow(item);
    if (re) out.push(...findSpans(re, text));
  }
  return out;
}

export const withoutAllowed = (spans: TextSpan[], allowed: TextSpan[]): TextSpan[] => spans.filter((s) => !allowed.some((a) => spansOverlap(s, a)));

export type LexiconEntry = Lexicon['ban'][number];

export function entryParts(e: LexiconEntry): { pattern: string; regex: boolean; weight: number } {
  return typeof e === 'string' ? { pattern: e, regex: false, weight: 1 } : { pattern: e.pattern, regex: !!e.regex, weight: e.weight ?? 1 };
}

export function entryRegex(e: LexiconEntry): RegExp | null {
  const { pattern, regex } = entryParts(e);
  if (!pattern) return null;
  return compileRegex(regex ? pattern : escapeRegExp(pattern));
}

/** beat 标记行的 [start,end) */
export function markerRanges(text: string): [number, number][] {
  return [...text.matchAll(new RegExp(BEAT_MARKER_RE.source, 'gm'))].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/** 去掉空白与 beat 标记后的文本 + 映射回原文的位置 */
export interface StrippedText {
  s: string;
  map: number[];
}

export function stripForRepeat(text: string): StrippedText {
  const ranges = markerRanges(text);
  let r = 0;
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    while (r < ranges.length && i >= (ranges[r] as [number, number])[1]) r++;
    const range = ranges[r];
    if (range && i >= range[0] && i < range[1]) continue;
    const ch = text[i] as string;
    if (/\s/u.test(ch)) continue;
    chars.push(ch);
    map.push(i);
  }
  return { s: chars.join(''), map };
}

export function finding(
  id: string,
  severity: 'hard' | 'soft',
  category: string,
  message: string,
  extra: { quote?: string | undefined; suggestion?: string | undefined } = {},
): Finding {
  return {
    id,
    severity,
    category,
    message,
    conflicts_with_author_layer: false,
    verified: true,
    ...(extra.quote !== undefined ? { quote: extra.quote } : {}),
    ...(extra.suggestion !== undefined ? { suggestion: extra.suggestion } : {}),
  };
}
