/**
 * 规范文件的类型化读取（全部经 @novelist/shared 的 zod 校验）。Owner: lane B。
 * rev 省略 = 工作树；run 内（快照目录）直接 openRepo(snapshotDir) 读取。
 * 解析失败抛 CanonicalParseError（带相对路径与 zod issues），调用方决定是 output_contract 还是 config 错误。
 */
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { z } from 'zod';
import {
  chapterId,
  stripBeatMarkers,
  zArc,
  zArcFingerprint,
  zBookConfig,
  zCard,
  zCharacterArc,
  zCompass,
  zDebt,
  zDelta,
  zEntity,
  zGlossary,
  zLexicon,
  zOverride,
  zSecret,
  zVolume,
  zWorldRules,
} from '@novelist/shared';
import type {
  Arc,
  BookConfig,
  Card,
  CharacterArc,
  Compass,
  Debt,
  Delta,
  Entity,
  Glossary,
  Lexicon,
  ArcFingerprint,
  Override,
  Secret,
  Volume,
  WorldRules,
} from '@novelist/shared';
import { P } from './layout.js';
import type { BookRepo } from './repo.js';

export class CanonicalParseError extends Error {
  constructor(
    public readonly path: string,
    public readonly issues: { path: string; message: string }[],
  ) {
    super(`invalid ${path}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }
}

export interface BookFiles {
  config(rev?: string): Promise<{ raw: string; config: BookConfig }>;
  compass(rev?: string): Promise<Compass | null>;
  volume(id: string, rev?: string): Promise<Volume | null>;
  volumes(rev?: string): Promise<Volume[]>;
  arc(id: string, rev?: string): Promise<Arc | null>;
  arcs(rev?: string): Promise<Arc[]>;
  card(no: number, rev?: string): Promise<Card | null>;
  /** 章号区间内存在的卡（含两端） */
  cards(from: number, to: number, rev?: string): Promise<Card[]>;
  characterArcs(rev?: string): Promise<CharacterArc[]>;
  entities(rev?: string): Promise<{ entity: Entity; body: string; path: string }[]>;
  world(rev?: string): Promise<WorldRules | null>;
  secrets(rev?: string): Promise<{ secret: Secret; body: string; path: string }[]>;
  glossary(rev?: string): Promise<Glossary | null>;
  lexicon(rev?: string): Promise<Lexicon | null>;
  /** 1..through 的账本（缺章即止） */
  ledger(through?: number, rev?: string): Promise<Delta[]>;
  overrides(rev?: string): Promise<Override[]>;
  debts(rev?: string): Promise<Debt[]>;
  arcFingerprints(rev?: string): Promise<ArcFingerprint[]>;
  /** 正文（已剥离 beat 标记的定稿） */
  manuscript(no: number, rev?: string): Promise<string | null>;
  summary(kind: 'arc' | 'volume' | 'book', id?: string, rev?: string): Promise<string | null>;
  premise(rev?: string): Promise<string>;
}

function issuesOf(err: z.ZodError, prefix = ''): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: prefix + i.path.map(String).join('.'), message: i.message }));
}

/** 解析 YAML 文本并用 schema 校验；语法错误也转成 CanonicalParseError */
export function parseYamlAs<T>(rel: string, text: string, schema: z.ZodType<T>): T {
  let data: unknown;
  try {
    data = yamlParse(text);
  } catch (e) {
    throw new CanonicalParseError(rel, [{ path: '', message: `YAML: ${(e as Error).message}` }]);
  }
  const r = schema.safeParse(data);
  if (!r.success) throw new CanonicalParseError(rel, issuesOf(r.error));
  return r.data;
}

export function parseJsonAs<T>(rel: string, text: string, schema: z.ZodType<T>): T {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new CanonicalParseError(rel, [{ path: '', message: `JSON: ${(e as Error).message}` }]);
  }
  const r = schema.safeParse(data);
  if (!r.success) throw new CanonicalParseError(rel, issuesOf(r.error));
  return r.data;
}

export function parseJsonlAs<T>(rel: string, text: string, schema: z.ZodType<T>): T[] {
  const out: T[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch (e) {
      throw new CanonicalParseError(rel, [{ path: `line ${i + 1}`, message: `JSON: ${(e as Error).message}` }]);
    }
    const r = schema.safeParse(data);
    if (!r.success) throw new CanonicalParseError(rel, issuesOf(r.error, `line ${i + 1}: `));
    out.push(r.data);
  }
  return out;
}

/** YAML frontmatter + markdown 正文。没有 frontmatter 时 data=null */
export function parseFrontmatter(md: string): { data: unknown; body: string } {
  const text = md.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n/.exec(text);
  if (!m) return { data: null, body: text };
  const rest = text.slice(m[0].length);
  const end = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!end) return { data: null, body: text };
  const yamlText = rest.slice(0, end.index);
  let body = rest.slice(end.index + end[0].length);
  body = body.replace(/^\r?\n/, '');
  return { data: yamlText.trim() === '' ? {} : yamlParse(yamlText), body };
}

export function formatFrontmatter(data: unknown, body: string): string {
  const y = yamlStringify(data ?? {}, { lineWidth: 0 });
  return `---\n${y}---\n\n${body.replace(/^\r?\n/, '')}`;
}

function parseFrontmatterAs<T>(rel: string, text: string, schema: z.ZodType<T>): { value: T; body: string } {
  let fm: { data: unknown; body: string };
  try {
    fm = parseFrontmatter(text);
  } catch (e) {
    throw new CanonicalParseError(rel, [{ path: 'frontmatter', message: `YAML: ${(e as Error).message}` }]);
  }
  if (fm.data === null) throw new CanonicalParseError(rel, [{ path: 'frontmatter', message: '缺少 YAML frontmatter' }]);
  const r = schema.safeParse(fm.data);
  if (!r.success) throw new CanonicalParseError(rel, issuesOf(r.error));
  return { value: r.data, body: fm.body };
}

const isFileEntry = (p: string) => !p.endsWith('/');

export function bookFiles(repo: BookRepo): BookFiles {
  const readMany = (rels: string[], rev?: string): Promise<(string | null)[]> =>
    repo.readMany ? repo.readMany(rels, rev) : Promise.all(rels.map((r) => repo.readFile(r, rev)));

  async function yamlFile<T>(rel: string, schema: z.ZodType<T>, rev?: string): Promise<T | null> {
    const t = await repo.readFile(rel, rev);
    return t === null ? null : parseYamlAs(rel, t, schema);
  }
  async function yamlDir<T>(dir: string, schema: z.ZodType<T>, rev?: string): Promise<T[]> {
    const files = (await repo.list(dir, rev === undefined ? {} : { rev })).filter((p) => isFileEntry(p) && /\.ya?ml$/.test(p));
    const texts = await readMany(files, rev);
    const out: T[] = [];
    files.forEach((f, i) => {
      const t = texts[i];
      if (t != null) out.push(parseYamlAs(f, t, schema));
    });
    return out;
  }
  async function jsonl<T>(rel: string, schema: z.ZodType<T>, rev?: string): Promise<T[]> {
    const t = await repo.readFile(rel, rev);
    return t === null ? [] : parseJsonlAs(rel, t, schema);
  }
  async function mdDir<T>(dir: string, schema: z.ZodType<T>, recursive: boolean, rev?: string): Promise<{ value: T; body: string; path: string }[]> {
    const opts: { rev?: string; recursive?: boolean } = { recursive };
    if (rev !== undefined) opts.rev = rev;
    const files = (await repo.list(dir, opts)).filter((p) => isFileEntry(p) && p.endsWith('.md'));
    const texts = await readMany(files, rev);
    const out: { value: T; body: string; path: string }[] = [];
    files.forEach((f, i) => {
      const t = texts[i];
      if (t != null) out.push({ ...parseFrontmatterAs(f, t, schema), path: f });
    });
    return out;
  }

  return {
    async config(rev) {
      const raw = await repo.readFile(P.bookYaml, rev);
      if (raw === null) throw new CanonicalParseError(P.bookYaml, [{ path: '', message: 'book.yaml 不存在' }]);
      return { raw, config: parseYamlAs(P.bookYaml, raw, zBookConfig) };
    },
    compass: (rev) => yamlFile(P.compass, zCompass, rev),
    volume: (id, rev) => yamlFile(P.volume(id), zVolume, rev),
    async volumes(rev) {
      return (await yamlDir('plan/volumes', zVolume, rev)).sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    arc: (id, rev) => yamlFile(P.arc(id), zArc, rev),
    async arcs(rev) {
      return (await yamlDir('plan/arcs', zArc, rev)).sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    card: (no, rev) => yamlFile(P.card(no), zCard, rev),
    async cards(from, to, rev) {
      const files = (await repo.list('plan/cards', rev === undefined ? {} : { rev }))
        .filter((p) => /\/c\d{5}\.yaml$/.test(p))
        .filter((p) => {
          const n = Number(/c(\d{5})\.yaml$/.exec(p)?.[1]);
          return n >= from && n <= to;
        })
        .sort();
      const texts = await readMany(files, rev);
      const out: Card[] = [];
      files.forEach((f, i) => {
        const t = texts[i];
        if (t != null) out.push(parseYamlAs(f, t, zCard));
      });
      return out;
    },
    async characterArcs(rev) {
      return yamlDir('plan/character-arcs', zCharacterArc, rev);
    },
    async entities(rev) {
      const r = await mdDir(P.entitiesDir, zEntity, true, rev);
      return r.map((x) => ({ entity: x.value, body: x.body, path: x.path }));
    },
    world: (rev) => yamlFile(P.worldRules, zWorldRules, rev),
    async secrets(rev) {
      const r = await mdDir(P.secretsDir, zSecret, false, rev);
      return r.map((x) => ({ secret: x.value, body: x.body, path: x.path }));
    },
    glossary: (rev) => yamlFile(P.glossary, zGlossary, rev),
    lexicon: (rev) => yamlFile(P.styleLexicon, zLexicon, rev),
    async ledger(through, rev) {
      const files = (await repo.list(P.ledgerDir, rev === undefined ? {} : { rev }))
        .map((p) => /\/c(\d{5})\.json$/.exec(p))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);
      // 缺章即止：只取从 1 起连续的一段
      const nos: number[] = [];
      for (let i = 0; i < files.length; i++) {
        if (files[i] !== i + 1) break;
        if (through !== undefined && i + 1 > through) break;
        nos.push(i + 1);
      }
      const rels = nos.map((n) => P.ledger(n));
      const texts = await readMany(rels, rev);
      const out: Delta[] = [];
      for (let i = 0; i < rels.length; i++) {
        const t = texts[i];
        const rel = rels[i] as string;
        if (t == null) break;
        const d = parseJsonAs(rel, t, zDelta);
        if (d.chapter !== chapterId(nos[i] as number))
          throw new CanonicalParseError(rel, [{ path: 'chapter', message: `应为 ${chapterId(nos[i] as number)}，实际 ${d.chapter}` }]);
        out.push(d);
      }
      return out;
    },
    overrides: (rev) => jsonl(P.overrides, zOverride, rev),
    debts: (rev) => jsonl(P.debt, zDebt, rev),
    arcFingerprints: (rev) => jsonl(P.arcFingerprints, zArcFingerprint, rev),
    async manuscript(no, rev) {
      const t = await repo.readFile(P.manuscript(no), rev);
      return t === null ? null : stripBeatMarkers(t);
    },
    summary(kind, id, rev) {
      if (kind === 'book') return repo.readFile(P.summaryBook, rev);
      if (!id) throw new Error(`summary(${kind}) requires id`);
      return repo.readFile(kind === 'arc' ? P.summaryArc(id) : P.summaryVolume(id), rev);
    },
    async premise(rev) {
      return (await repo.readFile(P.premise, rev)) ?? '';
    },
  };
}
