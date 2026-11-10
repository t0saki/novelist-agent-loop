/**
 * v3 零成本统计（docs/v3/DESIGN.md §6；p2-plan §2.1）。纯函数：服务器自己数，不调模型。
 * 结果只写进下一次任务单的“上一批的统计”一节，仅供参考：不给数字，不要求先处理，什么都不卡。
 */
import { SHORT_RECENT_RATIO } from './contract.js';

/** 模型爱用的词；原样计数，用得多才报 */
export const REPEAT_WATCHLIST: readonly string[] = [
  '仿佛',
  '似乎',
  '不禁',
  '微微',
  '缓缓',
  '淡淡',
  '一丝',
  '深吸一口气',
  '嘴角',
  '眼神',
  '心中',
  '不由得',
  '竟然',
  '宛如',
  '顿时',
  '猛地',
  '轻轻',
  '默默',
  '渐渐',
  '忽然',
  '缓缓地',
  '沉默',
];

export interface RepeatOptions {
  /** n-gram 最短（汉字） */
  minLen?: number;
  /** n-gram 最长（汉字） */
  maxLen?: number;
  /** 至少出现几次 */
  minCount?: number;
  /** 同时至少每万字几次 */
  per10k?: number;
  /** 关注词：每万字几次以上才报 */
  watchPer10k?: number;
  /** 最多报几条 */
  max?: number;
}

const HAN_RUN_RE = /\p{Script=Han}+/gu;
const HAN_RE = /\p{Script=Han}/gu;

function countOccurrences(text: string, word: string): number {
  if (!word) return 0;
  let n = 0;
  let i = text.indexOf(word);
  while (i >= 0) {
    n += 1;
    i = text.indexOf(word, i + word.length);
  }
  return n;
}

/**
 * 一批正文里重复得最多的说法：汉字连续段内的 4–8 字 n-gram，加上关注词。
 * `exclude` = bible.md + notes/cast.md 的文字：在里面出现过的 n-gram（人名、地名、术语）不算。
 * 较短的 n-gram 被一个保留下来的、包含它且次数 ≥ 它的 0.8 倍的较长 n-gram 覆盖时丢掉。按 次数 × 长度 排序，平手按字符串。
 */
export function repeatedPhrases(bodies: string[], exclude: string, opts: RepeatOptions = {}): string[] {
  const minLen = opts.minLen ?? 4;
  const maxLen = opts.maxLen ?? 8;
  const minCount = opts.minCount ?? 4;
  const per10k = opts.per10k ?? 1.25;
  const watchPer10k = opts.watchPer10k ?? 8;
  const max = opts.max ?? 6;
  const text = bodies.join('\n');
  const han = text.match(HAN_RE)?.length ?? 0;
  if (han === 0 || max <= 0) return [];

  // 1. n-gram 计数（只在汉字连续段内，不跨标点）
  const counts = new Map<string, number>();
  for (const m of text.matchAll(HAN_RUN_RE)) {
    const chars = [...m[0]];
    for (let len = minLen; len <= maxLen; len += 1) {
      for (let i = 0; i + len <= chars.length; i += 1) {
        const g = chars.slice(i, i + len).join('');
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
  }
  const need = Math.max(minCount, (per10k * han) / 10_000);
  const cands = [...counts].filter(([g, c]) => c >= need && !exclude.includes(g));
  // 2. 长的先留；短的被留下的长串覆盖（次数相近）就丢
  cands.sort((a, b) => [...b[0]].length - [...a[0]].length || b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const kept: [string, number][] = [];
  for (const [g, c] of cands) {
    if (kept.some(([k, kc]) => k.length > g.length && k.includes(g) && kc >= 0.8 * c)) continue;
    kept.push([g, c]);
  }
  // 3. 关注词
  const watchNeed = Math.max(2, (watchPer10k * han) / 10_000);
  const seen = new Set(kept.map(([g]) => g));
  for (const w of [...REPEAT_WATCHLIST].sort((a, b) => b.length - a.length)) {
    if (seen.has(w) || exclude.includes(w)) continue;
    const c = countOccurrences(text, w);
    if (c >= watchNeed && !kept.some(([k, kc]) => k.length > w.length && k.includes(w) && kc >= 0.8 * c)) {
      kept.push([w, c]);
      seen.add(w);
    }
  }
  // 4. 排序：次数 × 长度，平手按字符串
  const score = ([g, c]: [string, number]) => c * [...g].length;
  kept.sort((a, b) => score(b) - score(a) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return kept.slice(0, max).map(([g]) => g);
}

/** 最近 ≤10 个入库章的平均字数低于下限的 1.2 倍（没有章节时 false） */
export function shortRecent(avg: number | null, minChars: number): boolean {
  if (avg === null || !Number.isFinite(avg) || minChars <= 0) return false;
  return avg < SHORT_RECENT_RATIO * minChars;
}
