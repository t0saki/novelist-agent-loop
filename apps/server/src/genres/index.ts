/**
 * 题材包（DESIGN §4.1、§6.5、附录 A）。Owner: lane C。
 * $DATA/genres/<id>/{pack.yaml,gates.yaml,pacing.yaml,lexicon.yaml,AGENTS.md,roles/<role>.md,skills/<name>/SKILL.md}
 * extends 链：pack.extends 依次展开（深度优先、去重、检测环），base 在前、自身在后。
 * 内置包在 apps/server/src/genres/builtin/，首次启动 seedBuiltinGenres 拷到 $DATA/genres（已存在则不覆盖，用户可改）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { type GatesFile, type GenrePack, GENRE_FILES, type Lexicon, type Pacing, type PlainObject, mergeLayers, zGatesFile, zGenrePack, zLexicon, zPacing } from '@novelist/shared';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { TRAILER, ensureGitRepo, NothingToCommitError, openRepo } from '../book/index.js';
import type { DataPaths } from '../config/index.js';

export const BUILTIN_GENRES_DIR = new URL('./builtin/', import.meta.url).pathname;

export interface ResolvedGenre {
  id: string;
  pack: GenrePack;
  /** base 在前、自身在后 */
  chain: { id: string; dir: string; pack: GenrePack }[];
  /** 按链顺序的 gates 文件（validators 负责合并） */
  gates: { genre: string; file: GatesFile }[];
  /** 链上合并后的 pacing（后者覆盖前者） */
  pacing: Pacing;
  /** 链上合并后的 lexicon（ban/watch/allow/patterns 追加合并） */
  lexicon: Lexicon;
  /** event_families 合并 */
  eventFamilies: Record<string, string[]>;
}

/** 链上没有任何 pacing.yaml 时的兜底 */
const DEFAULT_PACING: PlainObject = { schema: 'nv.pacing/1', chapter_length: { min: 2000, target: 3000, max: 4000, count_mode: 'han' } };

async function readYaml(file: string): Promise<unknown | null> {
  const text = await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  return text === null ? null : yamlParse(text);
}

async function readPack(dir: string, id: string): Promise<GenrePack> {
  const raw = await readYaml(path.join(dir, GENRE_FILES.pack));
  if (raw === null) throw new Error(`题材包不存在：${id}`);
  const pack = zGenrePack.parse(raw);
  if (pack.id !== id) throw new Error(`题材包 ${id} 的 pack.yaml 声明的 id 是 ${pack.id}`);
  return pack;
}

async function expandChain(paths: DataPaths, id: string): Promise<ResolvedGenre['chain']> {
  const chain: ResolvedGenre['chain'] = [];
  const done = new Set<string>();
  const visiting: string[] = [];
  const visit = async (gid: string): Promise<void> => {
    if (done.has(gid)) return;
    if (visiting.includes(gid)) throw new Error(`题材包 extends 成环：${[...visiting, gid].join(' → ')}`);
    visiting.push(gid);
    const dir = path.join(paths.genres, gid);
    const pack = await readPack(dir, gid);
    for (const parent of pack.extends) await visit(parent);
    visiting.pop();
    done.add(gid);
    chain.push({ id: gid, dir, pack });
  };
  await visit(id);
  return chain;
}

function lexiconKey(entry: Lexicon['ban'][number]): string {
  return typeof entry === 'string' ? entry : entry.pattern;
}

function dedupeByKey<T>(items: T[], key: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const it of items) map.set(key(it), it);
  return [...map.values()];
}

function mergeLexicons(files: Lexicon[]): Lexicon {
  return {
    schema: 'nv.lexicon/1',
    ban: dedupeByKey(files.flatMap((f) => f.ban), lexiconKey),
    watch: dedupeByKey(files.flatMap((f) => f.watch), lexiconKey),
    allow: dedupeByKey(files.flatMap((f) => f.allow), lexiconKey),
    patterns: dedupeByKey(files.flatMap((f) => f.patterns), (p) => p.id),
  };
}

export async function loadGenre(paths: DataPaths, id: string): Promise<ResolvedGenre> {
  const chain = await expandChain(paths, id);
  const gates: ResolvedGenre['gates'] = [];
  const pacingLayers: PlainObject[] = [DEFAULT_PACING];
  const lexicons: Lexicon[] = [];
  const eventFamilies: Record<string, string[]> = {};
  for (const { id: gid, dir, pack } of chain) {
    const g = await readYaml(path.join(dir, GENRE_FILES.gates));
    if (g !== null) gates.push({ genre: gid, file: zGatesFile.parse(g) });
    const p = await readYaml(path.join(dir, GENRE_FILES.pacing));
    if (p !== null) pacingLayers.push(p as PlainObject);
    const l = await readYaml(path.join(dir, GENRE_FILES.lexicon));
    if (l !== null) lexicons.push(zLexicon.parse(l));
    for (const [family, words] of Object.entries(pack.event_families)) eventFamilies[family] = [...new Set([...(eventFamilies[family] ?? []), ...words])];
  }
  const self = chain[chain.length - 1]!;
  return { id, pack: self.pack, chain, gates, pacing: zPacing.parse(mergeLayers(...pacingLayers)), lexicon: mergeLexicons(lexicons), eventFamilies };
}

export async function listGenres(paths: DataPaths): Promise<GenrePack[]> {
  const entries = await fs.readdir(paths.genres, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const packs: GenrePack[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    // 用户手工放进来的目录可能不合法：列表里跳过，不影响其他包
    const pack = await readPack(path.join(paths.genres, e.name), e.name).catch(() => null);
    if (pack) packs.push(pack);
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

/** v1 主题元数据 → v2 题材包字段：继承 generic（拿到通用 gate、事件词族），自动开书配置进 auto。作者写的文本不动。 */
export function v1PackFields(pack: GenrePack): Pick<GenrePack, 'extends' | 'auto'> {
  const v1 = (pack.meta.v1 ?? {}) as { keywords?: unknown; length_hint?: unknown; min_chapters?: unknown; weight?: unknown; nsfw?: unknown; enabled?: unknown };
  const minChapters = Number(v1.min_chapters);
  return {
    extends: pack.extends.length > 0 || pack.id === 'generic' ? pack.extends : ['generic'],
    auto: {
      enabled: v1.enabled === true,
      weight: typeof v1.weight === 'number' && v1.weight >= 0 ? v1.weight : 1,
      keywords: Array.isArray(v1.keywords) ? v1.keywords.map(String) : [],
      length_hint: typeof v1.length_hint === 'string' ? v1.length_hint : '',
      min_chapters: Number.isInteger(minChapters) && minChapters > 0 ? minChapters : null,
      adult_only: v1.nsfw === true,
    },
  };
}

/** 启动时把已导入、还是 meta.v1 形状的包转成 v2 形状；转过的（有 auto）不再动 */
export async function convertV1Packs(paths: DataPaths, log: { info(o: object, m: string): void }): Promise<string[]> {
  const converted: string[] = [];
  for (const pack of await listGenres(paths)) {
    if (pack.auto || !pack.meta.v1) continue;
    await fs.writeFile(path.join(paths.genres, pack.id, GENRE_FILES.pack), yamlStringify({ ...pack, ...v1PackFields(pack) }, { lineWidth: 0 }), 'utf8');
    converted.push(pack.id);
  }
  if (converted.length) {
    await commitGenres(paths, `genres: convert v1 packs (${converted.join(', ')})`, 'convert.v1');
    log.info({ packs: converted }, 'converted v1 genre packs');
  }
  return converted;
}

export async function genreExists(paths: DataPaths, id: string): Promise<boolean> {
  return fs.stat(path.join(paths.genres, id, GENRE_FILES.pack)).then(
    (s) => s.isFile(),
    () => false,
  );
}

async function commitGenres(paths: DataPaths, message: string, task: string): Promise<void> {
  await openRepo(paths.genres)
    .commit({ message, trailers: { [TRAILER.task]: task } })
    .catch((e: unknown) => {
      if (!(e instanceof NothingToCommitError)) throw e;
    });
}

/** 首次启动：拷贝内置包（不覆盖已有）并 git init $DATA/genres；返回新拷贝的包 id */
export async function seedBuiltinGenres(paths: DataPaths): Promise<string[]> {
  await ensureGitRepo(paths.genres);
  const entries = await fs.readdir(BUILTIN_GENRES_DIR, { withFileTypes: true });
  const seeded: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dest = path.join(paths.genres, e.name);
    if (await fs.stat(dest).then(() => true, () => false)) continue;
    await fs.cp(path.join(BUILTIN_GENRES_DIR, e.name), dest, { recursive: true });
    seeded.push(e.name);
  }
  if (seeded.length > 0) await commitGenres(paths, `genres: seed ${seeded.join(', ')}`, 'genres.seed');
  return seeded.sort();
}

/** 新建题材包（可从已有包复制） */
export async function createGenre(paths: DataPaths, input: { id: string; name: string; extends: string[]; copyFrom?: string }): Promise<GenrePack> {
  const pack = zGenrePack.parse({ schema: 'nv.pack/1', id: input.id, name: input.name, extends: input.extends, builtin: false });
  if (await genreExists(paths, pack.id)) throw new Error(`题材包已存在：${pack.id}`);
  await ensureGitRepo(paths.genres);
  const dir = path.join(paths.genres, pack.id);
  for (const parent of pack.extends) await readPack(path.join(paths.genres, parent), parent);
  let packOut = pack;
  if (input.copyFrom) {
    const src = await readPack(path.join(paths.genres, input.copyFrom), input.copyFrom);
    await fs.cp(path.join(paths.genres, input.copyFrom), dir, { recursive: true });
    packOut = zGenrePack.parse({ ...src, id: pack.id, name: pack.name, extends: pack.extends, builtin: false });
  } else {
    await fs.mkdir(path.join(dir, GENRE_FILES.rolesDir), { recursive: true });
    await fs.writeFile(path.join(dir, GENRE_FILES.agents), `<!-- 题材层（${pack.name}）：这里的内容对本题材的所有角色生效。 -->\n`, 'utf8');
  }
  await fs.writeFile(path.join(dir, GENRE_FILES.pack), yamlStringify(packOut, { lineWidth: 0 }), 'utf8');
  await commitGenres(paths, `genres: create ${pack.id}`, 'genres.create');
  return packOut;
}
