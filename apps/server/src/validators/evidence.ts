/** ev 逐字/模糊匹配、quotes.verify（DESIGN §6.6）。Owner: lane D。 */
import { normalizeForMatch } from '@novelist/shared';
import { markerRanges } from './util.js';

export interface EvidenceMatch {
  kind: 'exact' | 'fuzzy' | 'none';
  /** 草稿中的位置 */
  start?: number;
  end?: number;
  /** fuzzy 时由程序替换成的原文片段 */
  replacement?: string;
  /** 最长公共子串占比 */
  ratio?: number;
}

const DEFAULT_THRESHOLD = 0.8;
/** 单条引文长度上限（防止模型把整章当 ev 时 O(n·m) 失控） */
const MAX_EV_LEN = 4000;

interface NormText {
  s: string;
  /** s[i] 对应的原文起点 */
  starts: number[];
  /** s[i] 对应的原文终点（不含） */
  ends: number[];
}

const charCache = new Map<string, string>();

function normChar(ch: string): string {
  let n = charCache.get(ch);
  if (n === undefined) {
    n = normalizeForMatch(ch);
    if (charCache.size < 20000) charCache.set(ch, n);
  }
  return n;
}

/** 逐字符做 normalizeForMatch，保留到原文的位置映射；连续省略号/破折号折叠与整串规范化一致 */
export function normalizeWithMap(text: string, skip: [number, number][] = []): NormText {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let r = 0;
  let i = 0;
  while (i < text.length) {
    const range = skip[r];
    if (range && i >= range[0]) {
      if (i < range[1]) {
        i = range[1];
        r++;
        continue;
      }
      r++;
      continue;
    }
    const cp = String.fromCodePoint(text.codePointAt(i) as number);
    const next = i + cp.length;
    for (const c of normChar(cp)) {
      const prev = chars[chars.length - 1];
      if ((c === '…' || c === '—') && prev === c && ends[ends.length - 1] === i) {
        ends[ends.length - 1] = next;
      } else {
        chars.push(c);
        starts.push(i);
        ends.push(next);
      }
    }
    i = next;
  }
  // 三个及以上连续 . 折叠成 …
  const out: string[] = [];
  const outStarts: number[] = [];
  const outEnds: number[] = [];
  for (let k = 0; k < chars.length; ) {
    if (chars[k] === '.') {
      let e = k;
      while (e + 1 < chars.length && chars[e + 1] === '.') e++;
      if (e - k >= 2) {
        out.push('…');
        outStarts.push(starts[k] as number);
        outEnds.push(ends[e] as number);
        k = e + 1;
        continue;
      }
    }
    out.push(chars[k] as string);
    outStarts.push(starts[k] as number);
    outEnds.push(ends[k] as number);
    k++;
  }
  return { s: out.join(''), starts: outStarts, ends: outEnds };
}

/** 最长公共子串：返回 s 中的结束位置（含）、ev 中的结束位置（含）、长度 */
function longestCommon(s: string, ev: string): { sEnd: number; evEnd: number; len: number } {
  const m = ev.length;
  const dp = new Uint16Array(m + 1);
  let best = { sEnd: -1, evEnd: -1, len: 0 };
  for (let i = 0; i < s.length; i++) {
    for (let j = m; j >= 1; j--) {
      if (s[i] === ev[j - 1]) {
        const v = (dp[j - 1] as number) + 1;
        dp[j] = v;
        if (v > best.len) {
          best = { sEnd: i, evEnd: j - 1, len: v };
          if (v === m) return best;
        }
      } else dp[j] = 0;
    }
  }
  return best;
}

export interface EvidenceMatcher {
  match(ev: string, opts?: { fuzzyThreshold?: number }): EvidenceMatch;
}

/** 同一草稿上多次匹配（delta.check 用）：位置映射只算一次 */
export function createEvidenceMatcher(draft: string): EvidenceMatcher {
  const norm = normalizeWithMap(draft, markerRanges(draft));
  return {
    match(ev, opts = {}) {
      const target = normalizeWithMap(ev).s;
      if (target.length === 0 || norm.s.length === 0) return { kind: 'none' };
      const at = norm.s.indexOf(target);
      if (at >= 0) return { kind: 'exact', start: norm.starts[at] as number, end: norm.ends[at + target.length - 1] as number, ratio: 1 };
      if (target.length > MAX_EV_LEN) return { kind: 'none' };
      const threshold = opts.fuzzyThreshold ?? DEFAULT_THRESHOLD;
      const { sEnd, evEnd, len } = longestCommon(norm.s, target);
      const ratio = len / target.length;
      if (len === 0 || ratio < threshold) return { kind: 'none', ratio };
      // 把最长公共子串按 ev 对齐放大（不跨段），替换文本一定是原文片段
      const lcsStart = sEnd - len + 1;
      const alignedStart = Math.max(0, lcsStart - (evEnd - len + 1));
      const alignedEnd = Math.min(norm.s.length - 1, sEnd + (target.length - 1 - evEnd));
      const coreStart = norm.starts[lcsStart] as number;
      const coreEnd = norm.ends[sEnd] as number;
      const paraStart = draft.lastIndexOf('\n', coreStart - 1) + 1;
      const nextBreak = draft.indexOf('\n', coreEnd);
      const paraEnd = nextBreak < 0 ? draft.length : nextBreak;
      const start = Math.max(norm.starts[alignedStart] as number, paraStart);
      const end = Math.min(norm.ends[alignedEnd] as number, paraEnd);
      return { kind: 'fuzzy', start, end, replacement: draft.slice(start, end).trim(), ratio };
    },
  };
}

/** 先统一空白与标点逐字匹配；失败后最长公共子串 ≥80% 视为 fuzzy */
export function matchEvidence(draft: string, ev: string, opts?: { fuzzyThreshold?: number }): EvidenceMatch {
  return createEvidenceMatcher(draft).match(ev, opts);
}

export function verifyQuotes(text: string, quotes: string[]): { quote: string; ok: boolean; match: EvidenceMatch }[] {
  const matcher = createEvidenceMatcher(text);
  return quotes.map((quote) => {
    const match = matcher.match(quote);
    return { quote, ok: match.kind !== 'none', match };
  });
}
