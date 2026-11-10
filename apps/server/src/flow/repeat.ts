/** 重复检测用的文本归一化（从旧校验器的 util.ts 迁来，内容不变）：去掉空白与 beat 标记，并保留回原文的位置映射。 */
import { BEAT_MARKER_RE } from '@novelist/shared';


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
