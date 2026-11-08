/** 中文计数与截断（计数本体在 @novelist/shared/text，所有模块共用）。Owner: lane B。 */
import { countHan } from '@novelist/shared';
export { countCjk, countHan, countByBeat, stripBeatMarkers, normalizeForMatch, BEAT_MARKER_RE } from '@novelist/shared';

/**
 * 截断度量：
 * - han：只计汉字（与 countCjk(han) 一致，章节长度口径）
 * - chars：计所有码点（context pack 的 section 配额用这个——它同时约束字节数）
 */
export type TruncateMeasure = 'han' | 'chars';

export function measureText(text: string, measure: TruncateMeasure): number {
  if (measure === 'han') return countHan(text);
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function cutChars(text: string, max: number, keep: 'head' | 'tail', measure: TruncateMeasure): string {
  const cps = [...text];
  const isUnit = measure === 'han' ? (c: string) => countHan(c) > 0 : () => true;
  let n = 0;
  if (keep === 'head') {
    let i = 0;
    for (; i < cps.length; i++) {
      if (isUnit(cps[i] as string)) {
        if (n >= max) break;
        n++;
      }
    }
    return cps.slice(0, i).join('');
  }
  let i = cps.length;
  for (; i > 0; i--) {
    if (isUnit(cps[i - 1] as string)) {
      if (n >= max) break;
      n++;
    }
  }
  return cps.slice(i).join('');
}

/**
 * 按汉字数截断（keep=tail 保留尾部；在段落边界处切）。
 * 先按整段取舍；第一段（head）或最后一段（tail）本身就超限时在段内按句末标点切，仍不够再按字切。
 * measure 省略 = 'han'。
 */
export function truncateCjk(
  text: string,
  maxCjk: number,
  keep: 'head' | 'tail' = 'head',
  measure: TruncateMeasure = 'han',
): { text: string; truncated: boolean } {
  if (measureText(text, measure) <= maxCjk) return { text, truncated: false };
  if (maxCjk <= 0) return { text: '', truncated: true };
  const paras = text.split(/(\n+)/); // 保留分隔符
  // 组装成 [段落, 分隔符] 对
  const units: string[] = [];
  for (let i = 0; i < paras.length; i += 2) units.push((paras[i] ?? '') + (paras[i + 1] ?? ''));
  const ordered = keep === 'head' ? units : [...units].reverse();
  const kept: string[] = [];
  let used = 0;
  for (const u of ordered) {
    const m = measureText(u, measure);
    if (used + m <= maxCjk) {
      kept.push(u);
      used += m;
      continue;
    }
    if (kept.length === 0 || used < maxCjk * 0.5) {
      // 段内切：优先在句末标点处
      const room = maxCjk - used;
      const sentences = u.split(/(?<=[。！？!?…”」])/u);
      const sOrdered = keep === 'head' ? sentences : [...sentences].reverse();
      const part: string[] = [];
      let pu = 0;
      for (const s of sOrdered) {
        const sm = measureText(s, measure);
        if (pu + sm > room) break;
        part.push(s);
        pu += sm;
      }
      let piece = (keep === 'head' ? part : part.reverse()).join('');
      if (pu === 0) piece = cutChars(u, room, keep, measure);
      kept.push(piece);
    }
    break;
  }
  const out = (keep === 'head' ? kept : kept.reverse()).join('');
  return { text: keep === 'head' ? out.replace(/\n+$/, '\n') : out.replace(/^\n+/, ''), truncated: true };
}
