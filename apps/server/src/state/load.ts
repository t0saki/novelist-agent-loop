/**
 * 读取书根（live 树或 run 快照）的规范状态并折叠。views 与 context pack 共用。Owner: lane B。
 * 只读工作树（不需要 git）；同一目录在内容未变时复用上次结果（按文件 mtime/size 签名）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Arc, BookConfig, Card, Compass, Delta, Entity, Lexicon, Override, Secret, Snapshot, Volume, WorldRules } from '@novelist/shared';
import { countCjk } from '@novelist/shared';
import { bookFiles, type BookFiles } from '../book/canonical.js';
import { P } from '../book/layout.js';
import { FS_CONCURRENCY, mapLimit } from '../book/limit.js';
import { openRepo } from '../book/repo.js';
import { createFolder } from './fold.js';

export interface BookState {
  dir: string;
  files: BookFiles;
  config: BookConfig | null;
  entities: { entity: Entity; body: string; path: string }[];
  world: WorldRules | null;
  secrets: { secret: Secret; body: string; path: string }[];
  compass: Compass | null;
  volumes: Volume[];
  arcs: Arc[];
  lexicon: Lexicon | null;
  /** 1..through 连续账本 */
  ledger: Delta[];
  overrides: Override[];
  /** chapterId → 汉字数（定稿） */
  chapterCjk: Record<string, number>;
  /** fold 结果（through 截止） */
  snapshot: Snapshot;
  /** 读正文（带缓存） */
  manuscript(no: number): Promise<string | null>;
}

/** LRU。每个 run 快照都是不同目录，大书一条约几十 MB，上限必须小 */
const CACHE_MAX = 4;
const cache = new Map<string, { sig: string; state: BookState }>();

function cachePut(key: string, value: { sig: string; state: BookState }): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

async function dirSig(abs: string): Promise<string> {
  let names: string[];
  try {
    names = await fs.readdir(abs);
  } catch {
    return '-';
  }
  names.sort();
  const parts = await Promise.all(
    names.map(async (n) => {
      try {
        const st = await fs.stat(path.join(abs, n));
        if (st.isDirectory()) return `${n}/${await dirSig(path.join(abs, n))}`;
        return `${n}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${n}:?`;
      }
    }),
  );
  return parts.join('|');
}

async function fileSig(abs: string): Promise<string> {
  try {
    const st = await fs.stat(abs);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '-';
  }
}

async function signature(dir: string, through: number | undefined): Promise<string> {
  const parts = await Promise.all([
    dirSig(path.join(dir, P.ledgerDir)),
    dirSig(path.join(dir, P.entitiesDir)),
    dirSig(path.join(dir, P.secretsDir)),
    dirSig(path.join(dir, 'plan/volumes')),
    dirSig(path.join(dir, 'plan/arcs')),
    dirSig(path.join(dir, P.manuscriptDir)),
    fileSig(path.join(dir, P.overrides)),
    fileSig(path.join(dir, P.worldRules)),
    fileSig(path.join(dir, P.compass)),
    fileSig(path.join(dir, P.bookYaml)),
    fileSig(path.join(dir, P.styleLexicon)),
  ]);
  return `${through ?? '*'}#${parts.join('#')}`;
}

export async function loadBookState(bookDir: string, opts: { through?: number; noCache?: boolean } = {}): Promise<BookState> {
  const dir = path.resolve(bookDir);
  const key = `${dir}@${opts.through ?? '*'}`;
  const sig = opts.noCache ? '' : await signature(dir, opts.through);
  const hit = cache.get(key);
  if (hit && sig && hit.sig === sig) {
    cachePut(key, hit);
    return hit.state;
  }

  const files = bookFiles(openRepo(dir));
  const [rawCfg, entities, world, secrets, compass, volumes, arcs, lexicon, ledger, overrides] = await Promise.all([
    files.config().catch(() => null),
    files.entities(),
    files.world(),
    files.secrets(),
    files.compass(),
    files.volumes(),
    files.arcs(),
    files.lexicon(),
    files.ledger(opts.through),
    files.overrides(),
  ]);
  const config = rawCfg?.config ?? null;
  const mode = config?.scale.chapter_length?.count_mode ?? 'han';
  const msCache = new Map<number, string | null>();
  const manuscript = async (no: number): Promise<string | null> => {
    if (msCache.has(no)) return msCache.get(no) ?? null;
    const t = await files.manuscript(no);
    msCache.set(no, t);
    return t;
  };
  const chapterCjk: Record<string, number> = {};
  // 只计数，不进 manuscript() 的缓存：否则整本书的正文都会常驻内存
  await mapLimit(ledger, FS_CONCURRENCY, async (d) => {
    const t = await files.manuscript(Number(d.chapter.slice(1)));
    if (t !== null) chapterCjk[d.chapter] = countCjk(t, mode);
  });
  const snapshot = createFolder({ entities: entities.map((e) => e.entity), world, ledger, overrides, chapterCjk }).finish();
  const state: BookState = {
    dir,
    files,
    config,
    entities,
    world,
    secrets,
    compass,
    volumes,
    arcs,
    lexicon,
    ledger,
    overrides,
    chapterCjk,
    snapshot,
    manuscript,
  };
  if (sig) cachePut(key, { sig, state });
  return state;
}

/** 别名索引的输入：实体文件 + 账本中新登场、还没写成实体文件的实体 */
export function aliasEntities(state: Pick<BookState, 'entities' | 'ledger'>): Entity[] {
  const out: Entity[] = state.entities.map((e) => e.entity);
  const known = new Set(out.map((e) => e.id));
  for (const d of state.ledger) {
    for (const op of d.ops) {
      if (op.op !== 'entity.create' || known.has(op.ent) || op.ent.startsWith('tmp:')) continue;
      known.add(op.ent);
      out.push({
        id: op.ent,
        kind: op.kind,
        name: op.name,
        aliases: op.aliases ?? [],
        identities: [],
        tier: op.tier ?? 'minor',
        contract_by_stage: {},
        relations: [],
        initial: {},
      } as Entity);
    }
  }
  return out;
}

/** 卡片所在的卷/弧（找不到返回 null） */
export function locateCard(state: Pick<BookState, 'volumes' | 'arcs'>, card: Card): { volume: Volume | null; arc: Arc | null } {
  return {
    volume: state.volumes.find((v) => v.id === card.volume) ?? null,
    arc: state.arcs.find((a) => a.id === card.arc) ?? null,
  };
}
