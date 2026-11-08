/** 工艺 gate（DESIGN §6.5；规则由 gates.yaml 驱动，可逐条覆盖）。Owner: lane D。 */
import type { Card, EffectiveGate, GateResult, LengthSpec, Lexicon } from '@novelist/shared';
import { BEAT_MARKER_RE, countByBeat, countCjk, countHan, stripBeatMarkers } from '@novelist/shared';
import { type TextSpan, allowSpans, compileRegex, entryParts, entryRegex, findSpans, spansOverlap, stripForRepeat, withoutAllowed } from './util.js';

export interface CraftInput {
  /** 草稿原文（含 beat 标记） */
  draft: string;
  card: Card;
  length: LengthSpec;
  gates: EffectiveGate[];
  lexicon: Lexicon;
  isFinal: boolean;
  /** repeat.cross 用：近 30 章正文 */
  recent?: { id: string; text: string }[];
  /** 计算重复前替换为占位符的词（glossary、别名） */
  protectedTerms?: string[];
}

interface RuleOut {
  /** 覆盖规则 id（一条规则产出多个结果时） */
  rule?: string;
  /** 覆盖级别（例如逐字复制升 hard、【】默认 soft） */
  level?: 'hard' | 'soft';
  ok: boolean;
  detail?: string;
  spans?: TextSpan[];
  measured?: Record<string, number>;
}

type Rule = (gate: EffectiveGate, input: CraftInput) => RuleOut | RuleOut[];

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const MAX_SPANS = 20;
const trimSpans = (spans: TextSpan[]): TextSpan[] => spans.slice(0, MAX_SPANS);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const listText = (spans: TextSpan[]): string => uniq(spans.map((s) => s.text ?? '')).slice(0, 10).join('、');

function extraRegexes(params: Record<string, unknown>, flags = 'gu'): RegExp[] {
  const p = params.patterns;
  if (!Array.isArray(p)) return [];
  return p.flatMap((x) => {
    const re = typeof x === 'string' ? compileRegex(x, flags) : null;
    return re ? [re] : [];
  });
}

const lengthTotal: Rule = (gate, { draft, length }) => {
  const total = countCjk(stripBeatMarkers(draft), length.count_mode);
  const min = num(gate.params.min, length.min);
  const max = num(gate.params.max, length.max);
  const ok = total >= min && total <= max;
  return { ok, measured: { total, min, max, target: length.target }, ...(ok ? {} : { detail: `字数 ${total} 不在 [${min}, ${max}]（${length.count_mode}）` }) };
};

interface BeatSegment {
  id: string;
  start: number;
  end: number;
}

function beatSegments(draft: string): BeatSegment[] {
  const ms = [...draft.matchAll(new RegExp(BEAT_MARKER_RE.source, 'gm'))];
  return ms.map((m, i) => ({ id: m[1] as string, start: (m.index ?? 0) + m[0].length, end: ms[i + 1]?.index ?? draft.length }));
}

const lengthBeat: Rule = (gate, { draft, card, length }) => {
  const tolerance = num(gate.params.tolerance, 0.4);
  const counts = countByBeat(draft, length.count_mode);
  const segments = beatSegments(draft);
  const measured: Record<string, number> = {};
  const failed: string[] = [];
  const spans: TextSpan[] = [];
  for (const b of card.beats) {
    const n = counts[b.id];
    if (n === undefined) continue;
    measured[b.id] = n;
    if (n < b.cjk * (1 - tolerance) || n > b.cjk * (1 + tolerance)) {
      failed.push(`${b.id}=${n}（预算 ${b.cjk}）`);
      const seg = segments.find((s) => s.id === b.id);
      if (seg) spans.push({ start: seg.start, end: seg.end });
    }
  }
  return { ok: failed.length === 0, measured, spans, ...(failed.length ? { detail: `beat 超出预算 ±${Math.round(tolerance * 100)}%：${failed.join('、')}` } : {}) };
};

const beatMarkers: Rule = (_gate, { draft, card }) => {
  const seen = beatSegments(draft).map((s) => s.id);
  const missing = card.beats.map((b) => b.id).filter((id) => !seen.includes(id));
  const dupes = uniq(seen.filter((id, i) => seen.indexOf(id) !== i));
  const unknown = uniq(seen.filter((id) => !card.beats.some((b) => b.id === id)));
  const notes = [...(missing.length ? [`缺少 beat 标记：${missing.join('、')}`] : []), ...(dupes.length ? [`重复：${dupes.join('、')}`] : []), ...(unknown.length ? [`卡片没有的 beat：${unknown.join('、')}`] : [])];
  return { ok: missing.length === 0, measured: { markers: seen.length, expected: card.beats.length, missing: missing.length }, ...(notes.length ? { detail: notes.join('；') } : {}) };
};

const END_MARKER_SOURCE = '(?:[（(【\\[]\\s*(?:本章完|本卷完|全文完|全书完|完结|完|未完待续|待续|大结局)\\s*[）)】\\]]|本章完|本卷完|全文完|全书完|全剧终|未完待续)[。！!]?$';

const endMarkers: Rule = (gate, { draft, isFinal }) => {
  if (isFinal) return { ok: true, detail: '终章允许结尾标记' };
  const body = stripBeatMarkers(draft).replace(/\s+$/u, '');
  const tail = body.slice(-40);
  const res = [compileRegex(END_MARKER_SOURCE, 'gu'), ...extraRegexes(gate.params, 'gu')].filter((r): r is RegExp => r !== null);
  const hits = res.flatMap((re) => findSpans(re, tail)).filter((s) => s.end === tail.length || s.end > tail.length - 2);
  const allowed = allowSpans(gate.allow, tail);
  const left = withoutAllowed(hits, allowed);
  return left.length ? { ok: false, detail: `非终章出现结尾标记：${listText(left)}`, spans: [] } : { ok: true };
};

const PLACEHOLDER_SOURCES = ['TODO', 'FIXME', 'TBD', 'X{3,}', '此处省略', '此处略去', '待补充', '待填写', '占位符', '\\{\\{[^{}\\n]{0,80}\\}\\}'];
const BRACKET_RE = /【[^】\n]{0,40}】/gu;

const placeholder: Rule = (gate, { draft }) => {
  const res = [compileRegex(`(?:${PLACEHOLDER_SOURCES.join('|')})`, 'gu'), ...extraRegexes(gate.params)].filter((r): r is RegExp => r !== null);
  const allowed = allowSpans(gate.allow, draft);
  const hits = withoutAllowed(
    res.flatMap((re) => findSpans(re, draft)),
    allowed,
  );
  const main: RuleOut = {
    ok: hits.length === 0,
    spans: trimSpans(hits),
    measured: { hits: hits.length },
    ...(hits.length ? { detail: `占位文本：${listText(hits)}` } : {}),
  };
  const mode = gate.params.brackets ?? (gate.params.soft_brackets === false ? 'off' : 'soft');
  if (mode === 'off') return main;
  const brackets = withoutAllowed(findSpans(new RegExp(BRACKET_RE.source, 'gu'), draft), allowed);
  return [
    main,
    {
      rule: 'placeholder.brackets',
      level: mode === 'hard' ? 'hard' : 'soft',
      ok: brackets.length === 0,
      spans: trimSpans(brackets),
      measured: { hits: brackets.length },
      ...(brackets.length ? { detail: `【】片段：${listText(brackets)}` } : {}),
    },
  ];
};

const META_ANY = ['作为(?:一[个名])?(?:AI|ＡＩ|人工智能)', '(?:大)?语言模型', '</?(?:thinking|analysis)>'];
const META_HEAD = ['^\\s*以下是', '^\\s*(?:好的|当然|没问题)[，,！!。]?.{0,30}(?:以下是|这是|为您|如下)', '^\\s*(?:这是|下面是)(?:本章|第.{1,6}章|为您|修改后|完整)'];
const META_TAIL = ['希望(?:这|您|你).{0,16}(?:满意|喜欢|帮助)', '(?:如需|如果需要|需要我).{0,16}(?:修改|调整|继续)', '^\\s*字数统计', '字数[:：]\\s*\\d+', '全文共计?\\s*\\d+\\s*字'];
const META_WINDOW = 240;

const metaText: Rule = (gate, { draft }) => {
  const scan = (sources: string[], text: string, offset: number): TextSpan[] =>
    sources.flatMap((src) => {
      const re = compileRegex(src, 'gmu');
      return re ? findSpans(re, text, offset) : [];
    });
  const body = draft.length;
  const tailStart = Math.max(0, body - META_WINDOW);
  const hits = [
    ...scan(META_ANY, draft, 0),
    ...scan(META_HEAD, draft.slice(0, META_WINDOW), 0),
    ...scan(META_TAIL, draft.slice(tailStart), tailStart),
    ...extraRegexes(gate.params, 'gmu').flatMap((re) => findSpans(re, draft)),
  ];
  const left = withoutAllowed(hits, allowSpans(gate.allow, draft));
  return { ok: left.length === 0, spans: trimSpans(left), measured: { hits: left.length }, ...(left.length ? { detail: `元文本：${listText(left)}` } : {}) };
};

const repeatIntra: Rule = (gate, { draft }) => {
  const minChars = Math.max(8, num(gate.params.min_chars, 50));
  const { s, map } = stripForRepeat(draft);
  const seen = new Map<string, number>();
  const spans: TextSpan[] = [];
  let i = 0;
  while (i + minChars <= s.length) {
    const key = s.slice(i, i + minChars);
    const p = seen.get(key);
    if (p !== undefined && p + minChars <= i) {
      let len = minChars;
      while (i + len < s.length && p + len < i && s[p + len] === s[i + len]) len++;
      const start = map[i] as number;
      const end = (map[i + len - 1] as number) + 1;
      spans.push({ start, end, text: draft.slice(start, end) });
      i += len;
      continue;
    }
    if (p === undefined) seen.set(key, i);
    i++;
  }
  const left = withoutAllowed(spans, allowSpans(gate.allow, draft));
  return { ok: left.length === 0, spans: trimSpans(left), measured: { repeats: left.length, min_chars: minChars }, ...(left.length ? { detail: `章内出现 ${left.length} 处 ≥${minChars} 字的逐字重复` } : {}) };
};

const PUNCT_RE = /[\p{P}\p{S}\s]/gu;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shingles(text: string, n: number): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + n <= text.length; i++) out.add(fnv1a(text.slice(i, i + n)));
  return out;
}

const MINHASH_K = 64;
const PERMS: [number, number][] = Array.from({ length: MINHASH_K }, (_, i) => [Math.imul(2 * i + 3, 0x9e3779b1) | 1, Math.imul(i + 1, 0x85ebca6b)]);

function minhash(set: Set<number>): Uint32Array {
  const sig = new Uint32Array(MINHASH_K).fill(0xffffffff);
  for (const h of set) {
    for (let k = 0; k < MINHASH_K; k++) {
      const [a, b] = PERMS[k] as [number, number];
      const v = (Math.imul(h, a) + b) >>> 0;
      if (v < (sig[k] as number)) sig[k] = v;
    }
  }
  return sig;
}

const similarity = (a: Uint32Array, b: Uint32Array): number => {
  let same = 0;
  for (let i = 0; i < MINHASH_K; i++) if (a[i] === b[i]) same++;
  return same / MINHASH_K;
};

function normalizeCross(text: string, terms: string[]): string {
  let t = stripBeatMarkers(text);
  for (const term of terms) t = t.split(term).join('\u0001');
  return t.replace(PUNCT_RE, '');
}

const repeatCross: Rule = (gate, { draft, card, recent, protectedTerms }) => {
  const window = num(gate.params.window, 30);
  const pool = (recent ?? []).slice(-window);
  if (pool.length === 0) return { ok: true, detail: '无近章样本' };
  const ngram = Math.max(2, num(gate.params.ngram, 8));
  const threshold = num(gate.params.threshold, 0.25);
  const minVerbatim = Math.max(8, num(gate.params.min_verbatim, 50));
  const terms = uniq(protectedTerms ?? [])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const callbacks = card.callbacks.flatMap((c) => ('quote' in c && c.quote ? [c.quote] : []));
  let masked = draft;
  for (const q of callbacks) masked = masked.split(q).join('\n'.repeat(q.length));

  const sig = minhash(shingles(normalizeCross(masked, terms), ngram));
  const similar: { id: string; sim: number }[] = [];
  const windowHashes = new Set<number>();
  const pools = pool.map((p) => ({ id: p.id, text: p.text.replace(/\s+/gu, '') }));
  for (const p of pools) {
    const sim = similarity(sig, minhash(shingles(normalizeCross(p.text, terms), ngram)));
    if (sim >= threshold) similar.push({ id: p.id, sim: Math.round(sim * 1000) / 1000 });
    for (let i = 0; i + minVerbatim <= p.text.length; i++) windowHashes.add(fnv1a(p.text.slice(i, i + minVerbatim)));
  }

  const { s, map } = stripForRepeat(masked);
  const spans: TextSpan[] = [];
  let i = 0;
  while (i + minVerbatim <= s.length) {
    const piece = s.slice(i, i + minVerbatim);
    const source = windowHashes.has(fnv1a(piece)) ? pools.find((p) => p.text.includes(piece)) : undefined;
    if (!source) {
      i++;
      continue;
    }
    let len = minVerbatim;
    while (i + len < s.length && source.text.includes(s.slice(i, i + len + 1))) len++;
    const start = map[i] as number;
    const end = (map[i + len - 1] as number) + 1;
    spans.push({ start, end, text: draft.slice(start, end) });
    i += len;
  }

  const allowed = allowSpans(gate.allow, draft);
  const verbatim = withoutAllowed(spans, allowed);
  const measured = { compared: pool.length, similar: similar.length, verbatim: verbatim.length };
  const out: RuleOut[] = [
    {
      ok: similar.length === 0,
      measured,
      ...(similar.length ? { detail: `与近章相似度过高：${similar.map((x) => `${x.id}(${x.sim})`).join('、')}` } : {}),
    },
  ];
  if (gate.params.verbatim_hard !== false) {
    out.push({
      rule: 'repeat.cross.verbatim',
      level: 'hard',
      ok: verbatim.length === 0,
      spans: trimSpans(verbatim),
      measured: { verbatim: verbatim.length, min_chars: minVerbatim },
      ...(verbatim.length ? { detail: `${verbatim.length} 处 ≥${minVerbatim} 字的段落与近章逐字相同` } : {}),
    });
  }
  return out;
};

const lexiconRule: Rule = (gate, { draft, lexicon }) => {
  const allowed = [...allowSpans(gate.allow, draft), ...lexicon.allow.flatMap((e) => {
    const re = entryRegex(e);
    return re ? findSpans(re, draft) : [];
  })];
  const scan = (entries: Lexicon['ban']) =>
    entries.flatMap((e) => {
      const re = entryRegex(e);
      if (!re) return [];
      const weight = entryParts(e).weight;
      return withoutAllowed(findSpans(re, draft), allowed).map((s) => ({ ...s, weight }));
    });
  const bans = scan(lexicon.ban);
  const watches = scan(lexicon.watch);
  const weight = bans.reduce((a, b) => a + b.weight, 0);
  const watchMax = num(gate.params.watch_max, Number.POSITIVE_INFINITY);
  const watchOver = watches.length > watchMax;
  const ok = bans.length === 0 && !watchOver;
  const notes = [...(bans.length ? [`命中 ban：${listText(bans)}`] : []), ...(watchOver ? [`watch 超限（${watches.length}/${watchMax}）：${listText(watches)}`] : [])];
  return {
    ok,
    spans: trimSpans(bans.map(({ weight: _w, ...s }) => s)),
    measured: { ban: bans.length, watch: watches.length, weight },
    ...(notes.length ? { detail: notes.join('；') } : {}),
  };
};

const QUOTE_RE = /[“「『"][^”」』"\n]*[”」』"]/gu;
const SUMMARY_RE = /数日|几天后|数月|几个月后|转眼|此后|从此|就这样|一连|多年后|不知不觉/gu;

function dialogueShare(text: string): number {
  const han = countHan(text);
  if (han === 0) return 0;
  return (text.match(QUOTE_RE) ?? []).reduce((a, q) => a + countHan(q), 0) / han;
}

const dramatize: Rule = (gate, { draft, card }) => {
  const minDialogue = num(gate.params.min_dialogue, 0.05);
  const maxSummary = num(gate.params.max_summary_markers, 3);
  const segments = beatSegments(draft);
  const failed: string[] = [];
  const spans: TextSpan[] = [];
  for (const b of card.beats.filter((x) => x.mode === 'dramatize')) {
    const seg = segments.find((s) => s.id === b.id);
    if (!seg) continue;
    const text = draft.slice(seg.start, seg.end);
    const markers = text.match(SUMMARY_RE)?.length ?? 0;
    if (dialogueShare(text) < minDialogue && markers >= maxSummary) {
      failed.push(b.id);
      spans.push({ start: seg.start, end: seg.end });
    }
  }
  return { ok: failed.length === 0, spans, measured: { failed: failed.length }, ...(failed.length ? { detail: `这些 dramatize beat 更像概述：${failed.join('、')}` } : {}) };
};

const singleSentence: Rule = (gate, { draft }) => {
  const maxRatio = num(gate.params.max_ratio, 0.6);
  const minParagraphs = num(gate.params.min_paragraphs, 8);
  const paragraphs = stripBeatMarkers(draft)
    .split(/\n+/u)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length < minParagraphs) return { ok: true, measured: { paragraphs: paragraphs.length } } as RuleOut;
  const single = paragraphs.filter((p) => (p.match(/[。！？!?…]+[”’」』）)]*/gu)?.length ?? 0) <= 1).length;
  const ratio = single / paragraphs.length;
  const ok = ratio <= maxRatio;
  return { ok, measured: { ratio, paragraphs: paragraphs.length, single }, ...(ok ? {} : { detail: `单句成段占比 ${ratio.toFixed(2)} > ${maxRatio}` }) };
};

const dialogueRatio: Rule = (gate, { draft }) => {
  const min = num(gate.params.min, 0.1);
  const max = num(gate.params.max, 0.7);
  const ratio = dialogueShare(stripBeatMarkers(draft));
  const ok = ratio >= min && ratio <= max;
  return { ok, measured: { ratio, min, max }, ...(ok ? {} : { detail: `对白占比 ${ratio.toFixed(2)} 不在 [${min}, ${max}]` }) };
};

const openingCliche: Rule = (gate, { draft, lexicon }) => {
  const window = num(gate.params.window, 200);
  const threshold = num(gate.params.max_weight, 1);
  const body = stripBeatMarkers(draft);
  const allowed = allowSpans(gate.allow, body);
  const hits: { id: string; weight: number; text: string }[] = [];
  for (const p of lexicon.patterns) {
    const re = compileRegex(p.regex, 'gmu');
    if (!re) continue;
    const offset = p.where === 'close' ? Math.max(0, body.length - window) : 0;
    const region = p.where === 'open' ? body.slice(0, window) : p.where === 'close' ? body.slice(offset) : body;
    for (const s of findSpans(re, region, offset)) {
      if (!allowed.some((a) => spansOverlap(s, a))) hits.push({ id: p.id, weight: p.weight, text: s.text ?? '' });
    }
  }
  const total = hits.reduce((a, h) => a + h.weight, 0);
  const ok = total < threshold;
  return { ok, measured: { hits: hits.length, weight: total }, ...(ok ? {} : { detail: `套路模式：${uniq(hits.map((h) => h.id)).join('、')}` }) };
};

const RULES: Record<string, Rule> = {
  'length.total': lengthTotal,
  'length.beat': lengthBeat,
  'beat.markers': beatMarkers,
  'end.markers': endMarkers,
  placeholder,
  'meta.text': metaText,
  'repeat.intra': repeatIntra,
  'repeat.cross': repeatCross,
  lexicon: lexiconRule,
  dramatize,
  single_sentence_paragraph: singleSentence,
  dialogue_ratio: dialogueRatio,
  opening_cliche: openingCliche,
};

export function runCraftGates(input: CraftInput): GateResult[] {
  const results: GateResult[] = [];
  for (const gate of input.gates) {
    if (gate.family !== 'craft') continue;
    const base = { family: 'craft' as const, source: gate.source };
    if (gate.level === 'off') {
      results.push({ ...base, rule: gate.rule, level: 'off', ok: true, detail: '已关闭', spans: [] });
      continue;
    }
    const rule = RULES[gate.rule];
    if (!rule) {
      results.push({ ...base, rule: gate.rule, level: gate.level, ok: true, detail: '未知规则，未执行', spans: [] });
      continue;
    }
    const outs = rule(gate, input);
    for (const out of Array.isArray(outs) ? outs : [outs]) {
      const { rule: ruleId, level, spans, ...rest } = out;
      results.push({ ...base, ...rest, rule: ruleId ?? gate.rule, level: level ?? gate.level, spans: spans ?? [] });
    }
  }
  return results;
}

export interface GateVerdict {
  ok: boolean;
  hardFailed: GateResult[];
  softFailed: GateResult[];
  /** 所有 hard 失败都是长度类（耗尽后 accept_with_debt） */
  lengthOnly: boolean;
  /** 修订定向依据：偏短 → expand，偏长 ≤25% → compress，否则 revise */
  suggestion: 'none' | 'expand' | 'compress' | 'revise';
}

const LENGTH_RULES = new Set(['length.total']);

export function gateVerdict(results: GateResult[]): GateVerdict {
  const hardFailed = results.filter((r) => !r.ok && r.level === 'hard');
  const softFailed = results.filter((r) => !r.ok && r.level === 'soft');
  const lengthOnly = hardFailed.length > 0 && hardFailed.every((r) => LENGTH_RULES.has(r.rule));
  let suggestion: GateVerdict['suggestion'] = 'none';
  if (hardFailed.length > 0) {
    suggestion = 'revise';
    if (lengthOnly) {
      const m = hardFailed[0]?.measured;
      if (m && typeof m.total === 'number') {
        if (typeof m.min === 'number' && m.total < m.min) suggestion = 'expand';
        else if (typeof m.max === 'number' && m.total > m.max && (m.total - m.max) / m.max <= 0.25) suggestion = 'compress';
      }
    }
  }
  return { ok: hardFailed.length === 0, hardFailed, softFailed, lengthOnly, suggestion };
}
