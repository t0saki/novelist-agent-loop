/**
 * 题材包（DESIGN §4.1、§6.5、附录 A）。Owner: lane C。
 * $DATA/genres/<id>/{pack.yaml,AGENTS.md,roles/<role>.md,skills/<name>/SKILL.md}
 * 旧包里只有旧流程读过的 gates.yaml / pacing.yaml / lexicon.yaml 原样留在磁盘上，不再读取（写坏了也不影响开书）。
 * extends 链：pack.extends 依次展开（深度优先、去重、检测环），base 在前、自身在后。
 * 内置包在 apps/server/src/genres/builtin/，首次启动 seedBuiltinGenres 拷到 $DATA/genres（已存在则不覆盖，用户可改）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { type GenrePack, GENRE_FILES, zGenrePack } from '@novelist/shared';
import { parse as yamlParse, parseDocument, stringify as yamlStringify } from 'yaml';
import { TRAILER, ensureGitRepo, NothingToCommitError, openRepo } from '../book/index.js';
import type { DataPaths } from '../config/index.js';

export const BUILTIN_GENRES_DIR = new URL('./builtin/', import.meta.url).pathname;

export interface ResolvedGenre {
  id: string;
  pack: GenrePack;
  /** base 在前、自身在后 */
  chain: { id: string; dir: string; pack: GenrePack }[];
}

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

export async function loadGenre(paths: DataPaths, id: string): Promise<ResolvedGenre> {
  const chain = await expandChain(paths, id);
  const self = chain[chain.length - 1]!;
  return { id, pack: self.pack, chain };
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

/** 主人删掉的内置包 id（一行一个，随删除一起提交）；seedBuiltinGenres 不再拷回 */
export const REMOVED_BUILTIN_FILE = '.removed-builtin';

export async function removedBuiltinIds(paths: DataPaths): Promise<Set<string>> {
  const text = await fs.readFile(path.join(paths.genres, REMOVED_BUILTIN_FILE), 'utf8').catch(() => '');
  return new Set(text.split('\n').map((l) => l.trim()).filter(Boolean));
}

/** 删除的题材包移到这里（$DATA/trash/genres/<id>-<时间>），不做不可恢复的删除；genres 仓库的历史里也还在 */
export function genreTrashDir(paths: DataPaths): string {
  return path.join(paths.root, 'trash', 'genres');
}

/** 题材包 id 只能是 genres/ 下的一层目录名：不含 / \，不是 . 或 ..（删除、停用这类写操作的最后一道防线） */
export function assertPlainGenreId(id: string): void {
  if (id === '' || id === '.' || id === '..' || /[/\\]/.test(id) || id.startsWith('.')) throw new Error(`题材包 id 不合法：${id}`);
}

/**
 * 删除题材包（调用方先确认没有书在用、没有包继承它）：目录移进回收站，内置包另记墓碑，然后在 genres 仓库提交。
 * 返回回收站里的位置。
 */
export async function trashGenre(paths: DataPaths, id: string, opts: { builtin: boolean }): Promise<string> {
  assertPlainGenreId(id);
  await ensureGitRepo(paths.genres);
  const trash = genreTrashDir(paths);
  await fs.mkdir(trash, { recursive: true });
  const dest = path.join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.rename(path.join(paths.genres, id), dest).catch(async (e: NodeJS.ErrnoException) => {
    // 回收站和数据目录不在同一个文件系统：复制后再移走原目录
    if (e.code !== 'EXDEV') throw e;
    await fs.cp(path.join(paths.genres, id), dest, { recursive: true });
    await fs.rm(path.join(paths.genres, id), { recursive: true, force: true });
  });
  if (opts.builtin) {
    const removed = await removedBuiltinIds(paths);
    if (!removed.has(id)) await fs.appendFile(path.join(paths.genres, REMOVED_BUILTIN_FILE), `${id}\n`, 'utf8');
  }
  await openRepo(paths.genres)
    .commit({ message: `genres: delete ${id}`, trailers: { [TRAILER.owner]: 'true' } })
    .catch((e: unknown) => {
      if (!(e instanceof NothingToCommitError)) throw e;
    });
  return dest;
}

/** 停用 / 恢复：把 hidden 写进 pack.yaml（保留注释）并以 owner 身份提交 */
export async function setGenreHidden(paths: DataPaths, id: string, hidden: boolean): Promise<GenrePack> {
  assertPlainGenreId(id);
  await readPack(path.join(paths.genres, id), id);
  const file = path.join(paths.genres, id, GENRE_FILES.pack);
  const doc = parseDocument(await fs.readFile(file, 'utf8'));
  if (hidden) doc.set('hidden', true);
  else doc.delete('hidden');
  await fs.writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8');
  await ensureGitRepo(paths.genres);
  await openRepo(paths.genres)
    .commit({ message: `genres: ${hidden ? 'hide' : 'unhide'} ${id}`, trailers: { [TRAILER.owner]: 'true' }, paths: [`${id}/${GENRE_FILES.pack}`] })
    .catch((e: unknown) => {
      if (!(e instanceof NothingToCommitError)) throw e;
    });
  return readPack(path.join(paths.genres, id), id);
}

/** pack.yaml 改完后不合 zGenrePack（PATCH /genres/:id/auto 回 400 invalid_pack，文件不动） */
export class InvalidPackError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`pack.yaml 不合格式：${issues.map((i) => `${i.path}: ${i.message}`).join('；')}`);
  }
}

/**
 * 题材包的自动开书配置（P3 D31：参与与权重只有 pack.yaml 这一个来源）。parseDocument 改 auto.<键>（保留注释；null = 删掉这个键），
 * 整份重新按 zGenrePack 校验，不合格就什么都不写；合格则以 owner 身份提交到题材包仓库。
 */
export async function patchGenreAuto(paths: DataPaths, id: string, patch: Partial<Record<'enabled' | 'weight' | 'keywords' | 'length_hint', unknown>>): Promise<GenrePack> {
  assertPlainGenreId(id);
  await readPack(path.join(paths.genres, id), id);
  const file = path.join(paths.genres, id, GENRE_FILES.pack);
  const raw = await fs.readFile(file, 'utf8');
  const doc = parseDocument(raw);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) {
      if (doc.hasIn(['auto', k])) doc.deleteIn(['auto', k]);
    } else doc.setIn(['auto', k], v);
  }
  const next = doc.toString({ lineWidth: 0 });
  const checked = zGenrePack.safeParse(yamlParse(next));
  if (!checked.success) throw new InvalidPackError(checked.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  if (next === raw) return checked.data;
  await fs.writeFile(file, next, 'utf8');
  await ensureGitRepo(paths.genres);
  await openRepo(paths.genres)
    .commit({ message: `genres: edit ${id} auto`, trailers: { [TRAILER.owner]: 'true' }, paths: [`${id}/${GENRE_FILES.pack}`] })
    .catch((e: unknown) => {
      if (!(e instanceof NothingToCommitError)) throw e;
    });
  return readPack(path.join(paths.genres, id), id);
}

/** 首次启动：拷贝内置包（不覆盖已有，因此也不动已有包的 hidden；主人删过的内置包不拷回）并 git init $DATA/genres；返回新拷贝的包 id */
export async function seedBuiltinGenres(paths: DataPaths): Promise<string[]> {
  await ensureGitRepo(paths.genres);
  const entries = await fs.readdir(BUILTIN_GENRES_DIR, { withFileTypes: true });
  const removed = await removedBuiltinIds(paths);
  const seeded: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || removed.has(e.name)) continue;
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
