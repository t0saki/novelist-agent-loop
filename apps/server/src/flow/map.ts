/**
 * v3 收稿归位（docs/v3/DESIGN.md §3.2–§3.3、§5；p1-plan §2.8）。纯函数：输入改动过的文件，输出要入库的新章、改写、尾部文件与系统提示。
 * 原则：正文是唯一的硬产物；任何文件都不因为章号、位置、格式丢失——要么入库，要么进 drafts/，要么原样收下。
 */
import path from 'node:path';
import { type V3Length, countCjk, isChapterHeading, parseChapterHeading, parseCnNumber } from '@novelist/shared';
import { DUP_RUN_CHARS, EMPTY_CJK, checkNewChapter, checkRewrite, longestSharedRun, normaliseChapter } from './checks.js';
import { END_MARKER, isFrozenChapter, noteSize } from './contract.js';
import type { HarvestPlan, OrderSpec, V3BookMeta, V3Hint, V3HintKind } from './types.js';

export interface MapInput {
  order: OrderSpec;
  /** changed files only */
  files: { path: string; text: string; isNew: boolean; ignored: boolean; baseText: string | null }[];
  /** bodies (title line removed) of chapters ≤ accepted (last 30 + rewrite targets + nominal numbers seen) */
  baseChapters: Map<number, string>;
  meta: V3BookMeta;
  /** re-read at finalize time (owner may have locked/published during the run) */
  frozen: { publishedThrough: number; locked: number[] };
  bibleAtBase: string | null;
  outlineAtBase: string | null;
  progressAtBase: string | null;
  plannedInitial: number;
  autoTitle: boolean;
  titleIsPlaceholder: boolean;
  hasBlurb: boolean;
  nowIso: string;
  runId: string;
  /** 书的篇幅档（notes_missing 的短篇规则）；缺省时只有 open-short 按短篇算 */
  length?: V3Length;
  /** base 上 drafts/ 下的文件（入库的新章顺手删掉自己的旧残稿） */
  draftsAtBase?: string[];
}

const pad5 = (n: number) => String(n).padStart(5, '0');
const squash = (s: string) => s.replace(/\s+/gu, '');
const TEXT_EXT_RE = /\.(md|markdown|txt)$/i;
const CN_NUM = '[〇零一二两三四五六七八九十百千万0-9０-９]+';

/** 纯数字文件名（"007.md"）只在根目录和这些章节目录里算章号 */
const CHAPTER_DIRS = new Set(['manuscript', 'chapters', 'chapter', '正文']);

function pathNumber(rel: string, loose: boolean): number | null {
  const norm = rel.replace(/\\/g, '/');
  const base = path.posix.basename(norm);
  const m = /^(.+)\.(md|markdown|txt)$/i.exec(base);
  if (!m) return null;
  const stem = (m[1] ?? '').trim();
  const pick = (s: string | undefined) => {
    const n = s === undefined ? null : parseCnNumber(s);
    return n !== null && n > 0 ? n : null;
  };
  let r = /^c(\d{1,5})$/i.exec(stem);
  if (r) return pick(r[1]);
  r = /^(?:ch|chap|chapter)[-_ .]?(\d{1,5})(?:[-_ .].*)?$/i.exec(stem);
  if (r) return pick(r[1]);
  r = new RegExp(`^第\\s*(${CN_NUM})\\s*[章回]`, 'u').exec(stem);
  if (r) return pick(r[1]);
  r = /^(\d{1,4})(?:[-_ .].*)?$/.exec(stem);
  if (r) {
    if (loose) return pick(r[1]);
    const dir = path.posix.dirname(norm);
    if (dir !== '.' && !CHAPTER_DIRS.has(path.posix.basename(dir))) return null;
    // 四位数、大于 1900：多半是年份（"2026-规划.md"）
    if ((r[1] ?? '').length === 4 && Number.parseInt(r[1] ?? '0', 10) > 1900) return null;
    return pick(r[1]);
  }
  return null;
}

/** manuscript/c00007.md, chapters/007.md, ch7.md, 第七章.md, chapter-07.txt → 7；认不出 null（纯数字只认根目录和章节目录，年份不算） */
export function chapterNoFromPath(rel: string): number | null {
  return pathNumber(rel, false);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
}

/** 规划、笔记一类的字眼（标题或文件名里出现就不当正文归位） */
const PLAN_WORD_RE = /细纲|大纲|提纲|规划|计划|设定|笔记|梗概|(?:^|[^a-z])(?:outlines?|plans?|notes?)(?:[^a-z]|$)/i;
const LIST_LINE_RE = /^\s*(?:[-*+•·]\s+|\d{1,3}(?:[.)．]\s+|、))/u;
const MD_LINE_RE = /^\s*#/;

/** manuscript/ 之外的文件要像正文才归位：文件名和标题里没有规划字眼，多数行不是列表或标题，列表之外至少 100 字 */
function looksLikeProse(rel: string, text: string): boolean {
  const stem = path.posix.basename(rel.replace(/\\/g, '/')).replace(TEXT_EXT_RE, '');
  if (PLAN_WORD_RE.test(stem)) return false;
  const h = parseChapterHeading(firstLine(text));
  if (h && PLAN_WORD_RE.test(h.title)) return false;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const structural = (l: string) => LIST_LINE_RE.test(l) || MD_LINE_RE.test(l);
  const listish = lines.filter(structural).length;
  if (lines.length > 0 && listish * 2 > lines.length) return false;
  return countCjk(lines.filter((l) => !structural(l)).join('\n')) >= EMPTY_CJK;
}

/** 文件名像章号或首行像章节标题（不看内容；用来决定落选的文件要不要提示放错了地方） */
function looksChapterish(rel: string, text: string): boolean {
  return TEXT_EXT_RE.test(rel) && (pathNumber(rel, true) !== null || isChapterHeading(firstLine(text)));
}

/** 文本文件，文件名像章号或首行是章节标题；manuscript/ 之外还要像正文（见 looksLikeProse） */
export function isChapterCandidate(rel: string, text: string): boolean {
  if (!TEXT_EXT_RE.test(rel)) return false;
  if (chapterNoFromPath(rel) === null && !isChapterHeading(firstLine(text))) return false;
  return rel.startsWith('manuscript/') || looksLikeProse(rel, text);
}

export interface ChapterSeg {
  headingNo: number | null;
  headingLine: string | null;
  text: string;
  /** 第一个标题之前、够 100 字的无标题段 */
  pre?: boolean;
}

/**
 * 按 "第X章" 标题行拆分；第一个标题之前不足 100 字的前言丢掉，够长的算一个无标题段（pre）。
 * 标题下面不到 100 字、后面还有段的（标题重复一遍、只有标题的碎片）：不单独成段，剩下的几行并进下一段，下一段没有章名时沿用它的。
 */
export function splitChapters(text: string): ChapterSeg[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const heads: number[] = [];
  lines.forEach((l, i) => {
    if (isChapterHeading(l)) heads.push(i);
  });
  if (heads.length === 0) return [{ headingNo: null, headingLine: null, text }];
  const out: ChapterSeg[] = [];
  const pre = lines.slice(0, heads[0]).join('\n');
  if (countCjk(pre) >= EMPTY_CJK) out.push({ headingNo: null, headingLine: null, text: pre, pre: true });
  const segs = heads.map((h, k) => ({ line: lines[h] ?? '', body: lines.slice(h + 1, heads[k + 1] ?? lines.length) }));
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k] as (typeof segs)[number];
    const next = segs[k + 1];
    const head = parseChapterHeading(s.line);
    if (next && countCjk(s.body.join('\n')) < EMPTY_CJK) {
      const nextHead = parseChapterHeading(next.line);
      if (head?.title && !nextHead?.title && head.no === (nextHead?.no ?? null)) next.line = s.line;
      if (s.body.some((l) => l.trim() !== '')) next.body = [...s.body, ...next.body];
      continue;
    }
    out.push({ headingNo: head?.no ?? null, headingLine: s.line, text: [s.line, ...s.body].join('\n') });
  }
  return out;
}

/** "计划：共 N 章" */
export function parsePlannedChapters(outline: string): number | null {
  const m = /计划[:：]?\s*共\s*(\d+)\s*章/.exec(outline);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** bible.md 第一行 "# 《X》"，前几行里的 "一句话：Y" */
export function parseBibleHead(bible: string): { title: string | null; blurb: string | null } {
  const lines = bible.split(/\r?\n/).filter((l) => l.trim() !== '');
  const t = /^\s*#{1,3}\s*《\s*(.+?)\s*》\s*$/u.exec(lines[0] ?? '');
  let blurb: string | null = null;
  for (const l of lines.slice(1, 5)) {
    const b = /^\s*(?:[-*]\s*)?一句话\s*[:：]\s*(.+?)\s*$/u.exec(l);
    if (b) {
      blurb = (b[1] ?? '').trim() || null;
      break;
    }
  }
  return { title: t ? (t[1] ?? '').trim() || null : null, blurb };
}

interface Cand {
  path: string;
  seg: number;
  nominal: number | null;
  headingNo: number | null;
  text: string;
  inManuscript: boolean;
  relocated: boolean;
  /** 来自拆成多段的文件：从不当改写候选（"第一章…第三章"是这一批自己的编号） */
  multi: boolean;
}

interface RewriteCand {
  no: number;
  text: string;
  baseBody: string | null;
  baseTitle: string;
}

/** 提示在任务单里的先后（越靠前越要紧） */
const HINT_ORDER: V3HintKind[] = ['owner_edit', 'unfinished', 'rewrite_rejected', 'unauthorized_edit', 'early_end', 'end_marker', 'short', 'notes_missing', 'notes_shrunk', 'no_bible', 'renumbered', 'relocated', 'misplaced', 'ignored', 'meta_stripped'];

const nonEmptyLines = (t: string | null) => (t ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').length;
const list = (xs: (string | number)[]) => [...new Set(xs)].join('、');

/**
 * 一个文件拆出来的各段的名义章号：多段时按一个序列编（第一段用了文件名的章号、或标题号不是递增的，就按 base+i）；
 * 单段的第零章不编号；manuscript/ 之外的单段文件，文件名是本批的新章号而标题写成了旧章号（"chapters/c00013.md" 里写 "# 第一章"）时以文件名为准。
 */
function segNominals(segs: ChapterSeg[], fileNo: number | null, inManuscript: boolean, from: number): (number | null)[] {
  const raw = segs.map((s, i) => (inManuscript ? (i === 0 ? (fileNo ?? s.headingNo) : s.headingNo) : (s.headingNo ?? (i === 0 ? fileNo : null))));
  if (segs.length === 1) {
    const h = segs[0]?.headingNo ?? null;
    if (!inManuscript && fileNo !== null && h !== null && h < from && fileNo >= from) return [fileNo];
    return raw[0] === 0 ? [null] : raw;
  }
  const j = raw.findIndex((n) => n !== null);
  if (j < 0) return raw;
  const base = (raw[j] as number) - j;
  const tookFileNo = fileNo !== null && (inManuscript || segs[0]?.headingNo === null);
  const increasing = raw.every((n, i) => i === 0 || (n !== null && raw[i - 1] !== null && n > (raw[i - 1] as number)));
  if (!tookFileNo && increasing) return raw;
  return raw.map((_, i) => (base + i >= 0 ? base + i : null));
}

export function planHarvest(input: MapInput): HarvestPlan {
  const { order } = input;
  const frozen = (k: number) => isFrozenChapter(k, input.frozen);
  const from = order.from;
  const hints: Omit<V3Hint, 'at'>[] = [];
  const tail = new Map<string, string | null>();
  const misplaced: string[] = [];
  const ignoredPaths: string[] = [];
  const cands: Cand[] = [];
  const rewriteCands: RewriteCand[] = [];
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  /** 写进 drafts/ 的稿：同名已被占用时加 -2、-3…（绝不互相覆盖） */
  const putDraft = (p: string, content: string) => {
    let q = p;
    for (let k = 2; tail.has(q); k++) q = p.replace(/\.md$/, `-${k}.md`);
    tail.set(q, content);
  };
  /** 第一个标题之前的无标题长段：标题就是这个文件的章（或文件名没有章号）时，它是夹带的前言/笔记，存进 drafts/；否则它就是文件名那一章的正文 */
  const takeLeadIn = (p: string, segs: ChapterSeg[], fileNo: number | null): ChapterSeg[] => {
    const [s0, s1] = segs;
    if (!s0?.pre || !s1) return segs;
    if (fileNo !== null && s1.headingNo !== fileNo) return segs;
    const no = fileNo ?? s1.headingNo;
    const name = no !== null && no > 0 ? `c${pad5(no)}` : path.posix.basename(p).replace(TEXT_EXT_RE, '');
    putDraft(`drafts/${name}.pre.md`, s0.text);
    return segs.slice(1);
  };

  const pushSegs = (p: string, text: string, inManuscript: boolean, relocated: boolean) => {
    const fileNo = chapterNoFromPath(p);
    const segs = takeLeadIn(p, splitChapters(text), fileNo);
    const nominals = segNominals(segs, fileNo, inManuscript, from);
    segs.forEach((s, i) => {
      cands.push({ path: p, seg: i, nominal: nominals[i] ?? null, headingNo: s.headingNo, text: s.text, inManuscript, relocated, multi: segs.length > 1 });
    });
  };

  /** 结局批：作者只在已入库的末章上补了（全书完） */
  let endOnExisting: { no: number; content: string; title: string; cjk: number } | null = null;
  const endMark = (n: ReturnType<typeof normaliseChapter>) => n.hadEndMarker || (order.finale && n.hadBareEndTail);

  // 1. 逐个文件分类
  for (const f of files) {
    const p = f.path;
    const noteish = p.startsWith('notes/') || p.startsWith('drafts/') || p === 'bible.md' || p === 'outline.md';
    const cand = !noteish && isChapterCandidate(p, f.text);
    if (f.ignored && !cand) {
      ignoredPaths.push(p);
      continue;
    }
    const ms = /^manuscript\/c(\d{5})\.md$/.exec(p);
    const msNo = ms ? Number.parseInt(ms[1] ?? '0', 10) : 0;
    if (!f.ignored && ms && !f.isNew && msNo >= 1 && msNo <= order.accepted) {
      // 已入库的章被改：第一段是改写候选（和旧版一样就不算），其余段是新章候选（"在上一章文件末尾接着写下一章"）
      const segs = takeLeadIn(p, splitChapters(f.text), msNo);
      const base = f.baseText !== null ? normaliseChapter(msNo, f.baseText) : null;
      const baseBody = base ? base.body : (input.baseChapters.get(msNo) ?? null);
      const first = segs[0];
      if (first) {
        const n1 = normaliseChapter(msNo, first.text);
        if (baseBody === null || squash(n1.body) !== squash(baseBody)) rewriteCands.push({ no: msNo, text: first.text, baseBody, baseTitle: base?.title ?? '' });
        if (order.finale && msNo === order.accepted && endMark(n1)) {
          const b = base ?? n1;
          endOnExisting = { no: msNo, content: b.content, title: b.title, cjk: b.cjk };
        }
      }
      const rest = segs.slice(1);
      const increasing = rest.every((s, i) => s.headingNo !== null && s.headingNo > (i === 0 ? msNo : (rest[i - 1]?.headingNo ?? msNo)));
      rest.forEach((s, i) => cands.push({ path: p, seg: i + 1, nominal: increasing ? s.headingNo : msNo + i + 1, headingNo: s.headingNo, text: s.text, inManuscript: true, relocated: false, multi: true }));
      continue;
    }
    if (!f.ignored && p.startsWith('manuscript/')) {
      if (cand) pushSegs(p, f.text, true, false);
      else {
        tail.set(p, f.text);
        misplaced.push(p);
      }
      continue;
    }
    if (noteish) {
      tail.set(p, f.text);
      continue;
    }
    if (cand) {
      pushSegs(p, f.text, false, true);
      continue;
    }
    tail.set(p, f.text);
    // 根目录的 .md，或者看着像章节（文件名、首行）却不像正文的文件（大纲、细纲、规划）：原样收下并提示
    if ((!p.includes('/') && /\.md$/i.test(p)) || looksChapterish(p, f.text)) misplaced.push(p);
  }

  // 2. 编号
  const rank = (c: Cand) => (c.nominal !== null && c.path === `manuscript/c${pad5(c.nominal)}.md` ? 0 : c.inManuscript ? 1 : 2);
  const byNominal = (a: Cand, b: Cand) => {
    if (a.nominal !== null && b.nominal !== null && a.nominal !== b.nominal) return a.nominal - b.nominal;
    if ((a.nominal === null) !== (b.nominal === null)) return a.nominal === null ? 1 : -1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.seg - b.seg;
  };
  // 任务单允许改写的旧章、写在了别的路径上、而且确实像那一章的改写稿：当改写，不当新章（不参与"整批编号偏低"的判断）
  const rewriteLike = (c: Cand): boolean => {
    if (c.multi || c.nominal === null || c.nominal < 1 || c.nominal > order.accepted || !order.allowRewrite.includes(c.nominal)) return false;
    const base = input.baseChapters.get(c.nominal);
    return !!base && longestSharedRun(normaliseChapter(c.nominal, c.text).body, base) >= DUP_RUN_CHARS;
  };
  const rest: Cand[] = [];
  for (const c of cands) {
    if (rewriteLike(c)) rewriteCands.push({ no: c.nominal as number, text: c.text, baseBody: input.baseChapters.get(c.nominal as number) ?? null, baseTitle: '' });
    else rest.push(c);
  }
  const numbered = rest.filter((c) => c.nominal !== null);
  const wholeBatchLow = numbered.length > 0 && numbered.every((c) => (c.nominal ?? 0) < from);
  let pool = rest;
  if (!wholeBatchLow) {
    // 单独成文件、写成旧章号的候选 = 想改写那一章（不当新章）；多段文件里的旧章号只是编号写错了，留在新章里重新编号
    pool = [];
    for (const c of rest) {
      if (c.nominal !== null && c.nominal <= order.accepted) {
        if (c.multi) pool.push({ ...c, nominal: null });
        else rewriteCands.push({ no: c.nominal, text: c.text, baseBody: input.baseChapters.get(c.nominal) ?? null, baseTitle: '' });
      } else pool.push(c);
    }
  }
  pool = [...pool].sort(byNominal);
  // 同一个章号有几份：按上面的先后取第一份，但第一份几乎是空的（只有标题、前言）而后面有正文时取有正文的那份
  const chosen = new Map<number, Cand>();
  const cjkOf = (c: Cand) => countCjk(normaliseChapter(0, c.text).body);
  if (!wholeBatchLow) {
    for (const c of pool) {
      if (c.nominal === null) continue;
      const cur = chosen.get(c.nominal);
      if (!cur || (cjkOf(cur) < EMPTY_CJK && cjkOf(c) >= EMPTY_CJK)) chosen.set(c.nominal, c);
    }
  }
  const seq: Cand[] = [];
  const seenBodies = new Set<string>();
  for (const c of pool) {
    const key = squash(normaliseChapter(0, c.text).body);
    if (seenBodies.has(key)) continue;
    seenBodies.add(key);
    if (!wholeBatchLow && c.nominal !== null && chosen.get(c.nominal) !== c) {
      putDraft(`drafts/c${pad5(c.nominal)}.dup.md`, normaliseChapter(c.nominal, c.text).content);
      continue;
    }
    seq.push(c);
  }
  const finalNo = (i: number) => from + i;
  const renumbered = wholeBatchLow || seq.some((c, i) => (c.nominal !== null && c.nominal !== finalNo(i)) || (c.headingNo !== null && c.headingNo !== finalNo(i)));
  if (renumbered && seq.length > 0) hints.push({ kind: 'renumbered', text: `章号不连续或和文件名对不上，已按顺序改为第 ${from}–${finalNo(seq.length - 1)} 章，并改好了每章第一行。` });

  // 3. 新章：逐章检查，第一处不合格之后全部进 drafts/
  const others = [...input.baseChapters].filter(([no]) => no <= order.accepted).map(([no, text]) => ({ no, text }));
  const newChapters: HarvestPlan['newChapters'] = [];
  const markers = new Map<number, boolean>();
  const strippedNos: number[] = [];
  const hintedShort = [...input.meta.hintedShort];
  let failed = false;
  // 结局批最后一章末尾单独一行的"（完）/（终）"也算全书完
  const markerOf = (n: ReturnType<typeof normaliseChapter>, i: number) => n.hadEndMarker || (order.finale && i === seq.length - 1 && n.hadBareEndTail);
  // 进 drafts/ 的稿保留全书完标记（归位时 normaliseChapter 会再认出来）
  const draftOf = (n: ReturnType<typeof normaliseChapter>, i: number) => (markerOf(n, i) ? `${n.content}\n${END_MARKER}\n` : n.content);
  for (let i = 0; i < seq.length; i++) {
    const c = seq[i] as Cand;
    const no = finalNo(i);
    const n = normaliseChapter(no, c.text);
    if (failed) {
      tail.set(`drafts/c${pad5(no)}.md`, draftOf(n, i));
      continue;
    }
    const r = checkNewChapter(
      n.body,
      others.filter((o) => o.no !== no),
      order.minChars,
    );
    if (!r.ok) {
      failed = true;
      tail.set(`drafts/c${pad5(no)}.md`, draftOf(n, i));
      const more = i < seq.length - 1;
      const where = `残稿在 drafts/c${pad5(no)}.md${more ? '，后面几章的草稿也在 drafts/ 里' : ''}`;
      const putBack = more ? '，再把后面几章的草稿校对后依次归位' : '';
      hints.push({
        kind: 'unfinished',
        chapter: no,
        sticky: true,
        text:
          r.reason === 'duplicate'
            ? `第 ${no} 章和第 ${r.dupOf} 章有一大段逐字相同（${r.detail}），没有入库；${where}。若是有意引用（书信、誓词、歌词），请缩短或改写这一段，存到 manuscript/c${pad5(no)}.md${putBack}。`
            : `第 ${no} 章没写完（${r.reason === 'truncated' ? '结尾停在半句话' : '内容为空'}），没有入库；${where}。先把第 ${no} 章写完整，存到 manuscript/c${pad5(no)}.md${putBack}。笔记里关于第 ${no} 章及之后的内容，以重写后的正文为准。`,
      });
      continue;
    }
    newChapters.push({ no, title: n.title, content: n.content, cjk: n.cjk, sourcePaths: [c.path] });
    others.push({ no, text: n.body });
    markers.set(no, markerOf(n, i));
    if (n.stripped.length) strippedNos.push(no);
    if (r.short && !hintedShort.includes(no)) {
      hintedShort.push(no);
      hints.push({ kind: 'short', chapter: no, rewrite: no, text: `第 ${no} 章只有 ${n.cjk} 字，不到每章 ${order.minChars} 字的下限。先把第 ${no} 章补到 ${order.minChars} 字以上（只补这一章，直接改 manuscript/c${pad5(no)}.md）。` });
    }
  }
  // 写在别处、已经归位入库的章
  const relocated = seq.map((c, i) => ({ c, no: finalNo(i) })).filter((x) => x.c.relocated && newChapters.some((ch) => ch.no === x.no));
  if (relocated.length) hints.push({ kind: 'relocated', text: `第 ${list(relocated.map((x) => x.no))} 章写在了 ${list(relocated.map((x) => x.c.path))}，已移到 manuscript/。正文请直接写在 manuscript/cNNNNN.md。` });

  // 8（先算）. 计划章数：outline.md "计划：共 N 章"，夹在 [ceil(N0/2), 2·N0]
  let planned = order.planned;
  let plannedChapters: number | undefined;
  const outlineText = files.find((f) => f.path === 'outline.md')?.text ?? input.outlineAtBase;
  if (outlineText) {
    const n = parsePlannedChapters(outlineText);
    if (n !== null) {
      const n0 = Math.max(1, input.plannedInitial);
      const clamped = Math.min(2 * n0, Math.max(Math.ceil(n0 / 2), n));
      if (clamped !== order.planned) plannedChapters = clamped;
      planned = clamped;
    }
  }

  // 4. 全书完标记与第一阶段的停止规则
  const last = newChapters[newChapters.length - 1];
  let completed: HarvestPlan['completed'] = false;
  let finaleNoMarker = order.finale ? input.meta.finaleNoMarker : 0;
  if (last && markers.get(last.no) && (order.finale || last.no >= planned)) {
    completed = 'marker';
    last.content = `${last.content}\n${END_MARKER}\n`;
    finaleNoMarker = 0;
  }
  if (!order.finale) {
    for (const ch of newChapters) {
      if (!markers.get(ch.no) || (completed && ch === last) || frozen(ch.no)) continue;
      hints.push({ kind: 'early_end', chapter: ch.no, rewrite: ch.no, text: `第 ${ch.no} 章出现了"（全书完）"，但还没到结局批，标记已删除。先改写第 ${ch.no} 章的后半，不收束，接着 outline.md 的下一段往下写。` });
    }
  } else if (last && !completed && !failed) {
    // 有章被检查截下（进了 drafts/）时不算"写完了却没收尾"：下一个结局批还得先把截下的补回来
    finaleNoMarker = input.meta.finaleNoMarker + 1;
    if (finaleNoMarker >= 2) completed = 'no_marker_twice';
  }

  // 5. 改写旧章：只有任务单点名、且没冻结的章可以改；不合格保留旧版
  const rewrites: HarvestPlan['rewrites'] = [];
  const unauthorized: number[] = [];
  const draftCount = new Map<number, number>();
  const rewriteDraft = (no: number, content: string) => {
    const k = draftCount.get(no) ?? 0;
    draftCount.set(no, k + 1);
    tail.set(k === 0 ? `drafts/c${pad5(no)}.rewrite.md` : `drafts/c${pad5(no)}.rewrite-${k + 1}.md`, content);
  };
  for (const rc of rewriteCands) {
    const n = normaliseChapter(rc.no, rc.text);
    const title = n.title || rc.baseTitle;
    const content = title === n.title ? n.content : `# 第${rc.no}章 ${title}\n\n${n.body}\n`;
    const allowed = order.allowRewrite.includes(rc.no) && !frozen(rc.no);
    if (!allowed) {
      rewriteDraft(rc.no, content);
      unauthorized.push(rc.no);
      continue;
    }
    if (rewrites.some((r) => r.no === rc.no)) {
      rewriteDraft(rc.no, content);
      continue;
    }
    const r = checkRewrite(rc.baseBody ?? '', n.body);
    if (r.ok) {
      rewrites.push({ no: rc.no, title, content, cjk: n.cjk });
      if (n.stripped.length) strippedNos.push(rc.no);
    } else {
      rewriteDraft(rc.no, content);
      hints.push({ kind: 'rewrite_rejected', chapter: rc.no, text: `第 ${rc.no} 章的改写${r.reason === 'shorter' ? '比原版短了三成以上' : '结尾停在半句话'}，保留了原版，改写稿在 drafts/c${pad5(rc.no)}.rewrite.md。` });
    }
  }
  rewrites.sort((a, b) => a.no - b.no);
  if (unauthorized.length) {
    hints.push({ kind: 'unauthorized_edit', text: `你改了已入库的第 ${list([...unauthorized].sort((a, b) => a - b))} 章，这次任务单没有允许改写，改动没有生效，另存在 drafts/。想改的地方写进 notes/progress.md 的"下一步打算"。` });
  }

  // 4b. 结局批没有新章、作者只在已入库的末章末尾补了（全书完）：就以那一章完结（标记补进那一章；已发布或锁定的章不动正文）
  let completedOn: number | undefined;
  const endOn = endOnExisting as { no: number; content: string; title: string; cjk: number } | null;
  if (endOn && !completed) {
    if (seq.length === 0) {
      completed = 'marker';
      finaleNoMarker = 0;
      completedOn = endOn.no;
      const rw = rewrites.find((r) => r.no === endOn.no);
      if (rw) rw.content = `${rw.content}\n${END_MARKER}\n`;
      else if (!frozen(endOn.no)) rewrites.push({ no: endOn.no, title: endOn.title, content: `${endOn.content}\n${END_MARKER}\n`, cjk: endOn.cjk });
      rewrites.sort((a, b) => a.no - b.no);
    } else {
      hints.push({ kind: 'end_marker', chapter: endOn.no, text: `第 ${endOn.no} 章末尾的"（全书完）"没有生效：这一批还写了新章。"（全书完）"只写在全书最后一章的末尾。` });
    }
  }

  // 6. 入库的新章删掉自己的旧残稿
  const draftsAtBase = new Set(input.draftsAtBase ?? []);
  for (const ch of newChapters) {
    const dp = `drafts/c${pad5(ch.no)}.md`;
    tail.delete(dp);
    if (draftsAtBase.has(dp)) ch.extra = [{ path: dp, content: null }];
  }

  // 7. 笔记
  for (const f of files) {
    if (!f.path.startsWith('notes/') || f.path.startsWith('notes/archive/') || !/\.md$/i.test(f.path) || f.baseText === null) continue;
    const b = noteSize(f.baseText);
    const n = noteSize(f.text);
    if (b >= 500 && n < 0.6 * b) {
      const archive = `notes/archive/${f.path.slice('notes/'.length).replace(/\.md$/i, '').replace(/\//g, '-')}-c${pad5(order.accepted)}.md`;
      tail.set(archive, f.baseText);
      hints.push({ kind: 'notes_shrunk', text: `${f.path} 这次缩短了 ${Math.round((1 - n / b) * 100)}%，旧版存在 ${archive}。确认没有丢掉在场人物和未收线索。` });
    }
  }
  const first = newChapters[0];
  if (first && last) {
    const a = first.no;
    const b = last.no;
    const short = (input.length ?? (order.mode === 'open-short' ? 'short' : undefined)) === 'short';
    let missing: boolean;
    if (short) missing = !files.some((f) => f.path === 'notes/progress.md');
    else {
      const cf = files.find((f) => f.path === 'notes/chapters.md');
      const growth = cf ? nonEmptyLines(cf.text) - nonEmptyLines(cf.baseText) : 0;
      missing = !files.some((f) => f.path.startsWith('notes/')) || growth < newChapters.length;
    }
    const already = input.meta.hints.some((h) => h.kind === 'notes_missing' && h.range && h.range[0] <= b && a <= h.range[1]);
    if (missing && !already) {
      hints.push({ kind: 'notes_missing', range: [a, b], text: short ? 'notes/progress.md 没有更新。先补上写到第几章、前情提要和还没收尾的事。' : `notes/chapters.md 没有记全第 ${a}–${b} 章。先补记这几章（每章一行）。` });
    }
  }

  // 8. 书名、简介（每次收稿都试，直到拿到为止）
  let title: string | undefined;
  let blurb: string | undefined;
  const bibleText = files.find((f) => f.path === 'bible.md')?.text ?? input.bibleAtBase;
  const head = bibleText ? parseBibleHead(bibleText) : { title: null, blurb: null };
  if (input.autoTitle && input.titleIsPlaceholder) {
    if (head.title) title = head.title;
    else hints.push({ kind: 'no_bible', text: '没有找到 bible.md，或者前两行格式不对。请按约定补上：第一行"# 《书名》"，第二行"一句话：……"。' });
  }
  if (!input.hasBlurb && head.blurb) blurb = head.blurb;

  // 1（提示）. 放错地方 / 不入库目录
  if (misplaced.length) hints.push({ kind: 'misplaced', text: `这些文件放在了约定位置之外：${list(misplaced)}。已原样收下；以后笔记放 notes/，设定放 bible.md，大纲放 outline.md，manuscript/ 里只放正文。` });
  if (ignoredPaths.length) hints.push({ kind: 'ignored', text: `这些文件放在了不入库的目录里，没有收下：${list(ignoredPaths)}。笔记放 notes/，草稿放 drafts/。` });

  // 9. 夹带清理
  if (strippedNos.length) hints.push({ kind: 'meta_stripped', text: `第 ${list([...strippedNos].sort((a, b) => a - b))} 章里夹带了创作说明、尾标或代码围栏，已删除。正文里只写小说本身。` });

  // 10. 粘性提示：没写完的章，在入库之前一直提
  const acceptedThrough = last ? last.no : order.accepted;
  for (const h of input.meta.hints) {
    if (h.kind !== 'unfinished' || !h.sticky || h.chapter === undefined || h.chapter <= acceptedThrough) continue;
    if (hints.some((x) => x.kind === 'unfinished' && x.chapter === h.chapter)) continue;
    const { at: _at, ...rest } = h;
    hints.push(rest);
  }

  // 11. 结果
  const ordered = hints.map((h, i) => ({ h, i })).sort((x, y) => HINT_ORDER.indexOf(x.h.kind) - HINT_ORDER.indexOf(y.h.kind) || x.i - y.i);
  return {
    newChapters,
    rewrites,
    tail: [...tail.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, content]) => ({ path: p, content })),
    hints: ordered.map(({ h }) => ({ ...h, at: input.nowIso })),
    completed,
    finaleNoMarker,
    ...(completedOn !== undefined ? { completedOn } : {}),
    zeroDiff: input.files.length === 0,
    changed: input.files.length,
    ...(title !== undefined ? { title } : {}),
    ...(blurb !== undefined ? { blurb } : {}),
    ...(plannedChapters !== undefined ? { plannedChapters } : {}),
    hintedShort,
  };
}
