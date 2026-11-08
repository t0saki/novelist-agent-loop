/** BM25 + jieba 分词（DESIGN §2.4、§6.3 retrieval）。索引存 .index/bm25.json，可重建。Owner: lane B。 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stripBeatMarkers } from '@novelist/shared';
import { FS_CONCURRENCY, mapLimit } from '../book/limit.js';

interface JiebaLike {
  cutForSearch(sentence: string, hmm?: boolean): string[];
}
let jieba: JiebaLike | null = null;

function getJieba(): JiebaLike {
  if (jieba) return jieba;
  const req = createRequire(import.meta.url);
  const { Jieba } = req('@node-rs/jieba') as { Jieba: { withDict(d: Uint8Array): JiebaLike } };
  const { dict } = req('@node-rs/jieba/dict.js') as { dict: Uint8Array };
  jieba = Jieba.withDict(dict);
  return jieba;
}

/** 检索时不计分的高频虚词（单字为主） */
const STOP = new Set(
  '的 了 是 在 我 你 他 她 它 们 这 那 就 也 都 而 及 与 着 或 一 个 上 下 不 没 有 和 把 被 让 给 从 向 对 又 再 还 很 吗 呢 吧 啊 呀 么 之 其 中 为 以 于 所 地 得 但 却 只 已 便 才 将 要 会 能 可 说 道 来 去 过'.split(
    ' ',
  ),
);
const PUNCT_ONLY = /^[\s\p{P}\p{S}]+$/u;

export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of getJieba().cutForSearch(text, true)) {
    const t = raw.trim().toLowerCase();
    if (!t || PUNCT_ONLY.test(t) || STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

export interface Bm25Hit {
  docId: string;
  score: number;
  text: string;
}

export interface Bm25Index {
  add(docId: string, text: string): void;
  remove(docId: string): void;
  /** filter：只在通过的 docId 中检索（例如排除当前章与 N−1/N−2） */
  search(query: string, k: number, filter?: (docId: string) => boolean): Bm25Hit[];
  toJSON(): unknown;
  /** lane B 扩展 */
  size(): number;
  has(docId: string): boolean;
  docIds(): string[];
  getText(docId: string): string | undefined;
}

interface Doc {
  text: string;
  len: number;
  tf: Map<string, number>;
}

interface SerializedIndex {
  v: 1;
  k1: number;
  b: number;
  docs: [string, string, [string, number][]][];
  /** 章节内容 hash（增量同步用）：chapterId → sha1 */
  chapters?: Record<string, string>;
}

class Index implements Bm25Index {
  readonly docs = new Map<string, Doc>();
  readonly postings = new Map<string, Map<string, number>>();
  totalLen = 0;
  chapters: Record<string, string> = {};

  constructor(
    readonly k1: number,
    readonly b: number,
  ) {}

  private insert(docId: string, text: string, tf: Map<string, number>, len: number): void {
    if (this.docs.has(docId)) this.remove(docId);
    this.docs.set(docId, { text, len, tf });
    this.totalLen += len;
    for (const [t, n] of tf) {
      let p = this.postings.get(t);
      if (!p) {
        p = new Map();
        this.postings.set(t, p);
      }
      p.set(docId, n);
    }
  }

  add(docId: string, text: string): void {
    const toks = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.insert(docId, text, tf, toks.length);
  }

  addTokens(docId: string, text: string, tf: [string, number][]): void {
    const m = new Map(tf);
    let len = 0;
    for (const n of m.values()) len += n;
    this.insert(docId, text, m, len);
  }

  remove(docId: string): void {
    const d = this.docs.get(docId);
    if (!d) return;
    this.docs.delete(docId);
    this.totalLen -= d.len;
    for (const t of d.tf.keys()) {
      const p = this.postings.get(t);
      if (!p) continue;
      p.delete(docId);
      if (p.size === 0) this.postings.delete(t);
    }
  }

  search(query: string, k: number, filter?: (docId: string) => boolean): Bm25Hit[] {
    const N = this.docs.size;
    if (N === 0 || k <= 0) return [];
    const avg = this.totalLen / N || 1;
    const qTerms = [...new Set(tokenize(query))];
    const scores = new Map<string, number>();
    for (const t of qTerms) {
      const p = this.postings.get(t);
      if (!p) continue;
      const idf = Math.log(1 + (N - p.size + 0.5) / (p.size + 0.5));
      for (const [docId, f] of p) {
        if (filter && !filter(docId)) continue;
        const d = this.docs.get(docId);
        if (!d) continue;
        const s = (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avg));
        scores.set(docId, (scores.get(docId) ?? 0) + s);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, k)
      .map(([docId, score]) => ({ docId, score, text: this.docs.get(docId)?.text ?? '' }));
  }

  toJSON(): SerializedIndex {
    const docs: SerializedIndex['docs'] = [];
    for (const id of [...this.docs.keys()].sort()) {
      const d = this.docs.get(id) as Doc;
      docs.push([id, d.text, [...d.tf.entries()]]);
    }
    return { v: 1, k1: this.k1, b: this.b, docs, chapters: this.chapters };
  }

  size(): number {
    return this.docs.size;
  }
  has(docId: string): boolean {
    return this.docs.has(docId);
  }
  docIds(): string[] {
    return [...this.docs.keys()];
  }
  getText(docId: string): string | undefined {
    return this.docs.get(docId)?.text;
  }
}

export function createBm25Index(opts?: { k1?: number; b?: number }): Bm25Index {
  return new Index(opts?.k1 ?? 1.2, opts?.b ?? 0.75);
}

export function loadBm25Index(json: unknown): Bm25Index {
  const j = json as Partial<SerializedIndex> | null;
  if (j?.v !== 1 || !Array.isArray(j.docs)) throw new Error('invalid bm25 index');
  const idx = new Index(j.k1 ?? 1.2, j.b ?? 0.75);
  for (const [id, text, tf] of j.docs) idx.addTokens(id, text, tf);
  idx.chapters = { ...(j.chapters ?? {}) };
  return idx;
}

/** 段落切分：按换行分段，相邻短段合并到 ≥minChars（默认 120 字）的窗口；返回 [docId, text] */
export function chunkChapter(chapter: string, text: string, minChars = 120, maxChars = 700): [string, string][] {
  const lines = stripBeatMarkers(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l));
  const out: [string, string][] = [];
  let buf: string[] = [];
  let n = 0;
  const flush = () => {
    if (buf.length) out.push([`${chapter}#p${out.length + 1}`, buf.join('\n')]);
    buf = [];
    n = 0;
  };
  for (const l of lines) {
    if (n > 0 && n + l.length > maxChars) flush();
    buf.push(l);
    n += l.length;
    if (n >= minChars) flush();
  }
  flush();
  return out;
}

const INDEX_FILE = path.join('.index', 'bm25.json');

async function readManuscripts(bookDir: string): Promise<Map<string, string>> {
  const dir = path.join(bookDir, 'manuscript');
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  const chs = names.filter((n) => /^c\d{5}\.md$/.test(n)).sort();
  const texts = await mapLimit(chs, FS_CONCURRENCY, (n) => fs.readFile(path.join(dir, n), 'utf8'));
  chs.forEach((n, i) => {
    out.set(n.slice(0, 6), texts[i] as string);
  });
  return out;
}

const sha1 = (t: string) => createHash('sha1').update(t).digest('hex');

async function saveIndex(bookDir: string, idx: Bm25Index): Promise<void> {
  const file = path.join(bookDir, INDEX_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(idx.toJSON()));
  await fs.rename(tmp, file);
}

/**
 * 增量同步：加载 .index/bm25.json（不存在或损坏 → 空索引），按章节内容 hash 增删，保存。
 * 返回最新索引。用于 live 树 promote 后的增量刷新与 run 快照内的 context pack。
 */
export async function syncIndex(bookDir: string, opts: { save?: boolean } = {}): Promise<Bm25Index> {
  let idx: Index;
  try {
    idx = loadBm25Index(JSON.parse(await fs.readFile(path.join(bookDir, INDEX_FILE), 'utf8'))) as Index;
  } catch {
    idx = createBm25Index() as Index;
  }
  const texts = await readManuscripts(bookDir);
  let changed = false;
  const byChapter = new Map<string, string[]>();
  for (const id of idx.docIds()) {
    const ch = id.slice(0, 6);
    byChapter.set(ch, [...(byChapter.get(ch) ?? []), id]);
  }
  for (const [ch, ids] of byChapter) {
    const t = texts.get(ch);
    if (t === undefined || idx.chapters[ch] !== sha1(t)) {
      for (const id of ids) idx.remove(id);
      delete idx.chapters[ch];
      changed = true;
    }
  }
  for (const ch of Object.keys(idx.chapters)) if (!texts.has(ch)) delete idx.chapters[ch];
  for (const [ch, t] of [...texts.entries()].sort()) {
    const h = sha1(t);
    if (idx.chapters[ch] === h) continue;
    for (const [id, text] of chunkChapter(ch, t)) idx.add(id, text);
    idx.chapters[ch] = h;
    changed = true;
  }
  if (changed && opts.save !== false) await saveIndex(bookDir, idx);
  return idx;
}

/** 按段落切分 manuscript/*.md 建索引（docId = c00421#p12） */
export async function rebuildIndex(bookDir: string): Promise<{ docs: number }> {
  await fs.rm(path.join(bookDir, INDEX_FILE), { force: true });
  const idx = await syncIndex(bookDir);
  if (idx.size() === 0) await saveIndex(bookDir, idx);
  return { docs: idx.size() };
}
