/** tmp: id 分配（DESIGN §4.2）：committer promote 时映射为正式 id 并回写所有引用。Owner: lane B。 */
import { createRequire } from 'node:module';
import { parse as yamlParse } from 'yaml';
import { ENTITY_KINDS, ENTITY_PREFIX, type EntityKind, obligationId } from '@novelist/shared';
import type { FileChange } from '../book/repo.js';
import { parseFrontmatter } from '../book/canonical.js';
import { ENTITY_DIRS, ENTITY_KIND_BY_DIR, P } from '../book/layout.js';

export interface IdContext {
  /** 已存在的正式 id（实体、事实、伏笔 F-id） */
  existing: Set<string>;
  /** 别名索引里的名字（拼音冲突检查） */
  names: Map<string, string>;
  nextObligationNo: number;
}

export interface ResolveTmpResult {
  mapping: Record<string, string>;
  files: FileChange[];
  /** 新实体名与别名索引中已有实体重名等提示（不阻断） */
  warnings?: string[];
  /** 无法判定类型的 tmp id（原样保留） */
  unresolved?: string[];
}

// ---------------------------------------------------------------------------------------------
// 拼音
// ---------------------------------------------------------------------------------------------

type PinyinFn = (text: string, opts: Record<string, unknown>) => unknown;
let pinyinFn: PinyinFn | null | undefined;

function loadPinyin(): PinyinFn | null {
  if (pinyinFn !== undefined) return pinyinFn;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('pinyin-pro') as { pinyin?: PinyinFn };
    pinyinFn = typeof mod.pinyin === 'function' ? mod.pinyin : null;
  } catch {
    pinyinFn = null; // 依赖未安装（见 DEPS_REQUESTS.md）：退回码点编码
  }
  return pinyinFn;
}

const HAN_CHAR = /[㐀-鿿豈-﫿]/u;

/** 单个汉字 → 拼音音节（无声调）；没有拼音库时返回 u<码点16进制> */
function syllables(name: string): string[] {
  const py = loadPinyin();
  const out: string[] = [];
  let ascii = '';
  const flush = () => {
    if (ascii) out.push(ascii);
    ascii = '';
  };
  for (const ch of name) {
    if (/[A-Za-z0-9]/.test(ch)) {
      ascii += ch.toLowerCase();
      continue;
    }
    flush();
    if (HAN_CHAR.test(ch)) {
      let s: string | null = null;
      if (py) {
        const r = py(ch, { toneType: 'none', type: 'array', v: true });
        const first = Array.isArray(r) ? r[0] : typeof r === 'string' ? r : null;
        if (typeof first === 'string' && /^[a-zü]+$/i.test(first)) s = first.toLowerCase().replace(/ü/g, 'v');
      }
      out.push(s ?? `u${(ch.codePointAt(0) ?? 0).toString(16)}`);
    }
    // 其余字符（标点、空白）作为分隔
  }
  flush();
  return out;
}

/** 中文名 → 拼音 slug（冲突加 -2、-3）。taken 中的 slug 视为已占用；返回值不会自动加入 taken */
export function slugifyName(name: string, taken: Set<string>): string {
  let base = syllables(name.normalize('NFKC'))
    .join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!base) base = 'x';
  if (!/^[a-z0-9]/.test(base)) base = `x-${base}`;
  base = base.slice(0, 48).replace(/-$/, '');
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const s = `${base}-${i}`;
    if (!taken.has(s)) return s;
  }
}

// ---------------------------------------------------------------------------------------------
// tmp id 收集
// ---------------------------------------------------------------------------------------------

/** tmp:<局部名>，局部名由字母数字、汉字、_ - . 组成；结尾的 . 不计入 */
const TMP_SCAN_RE = /tmp:[\p{L}\p{N}_.-]+/gu;

type TmpClass = 'entity' | 'obligation' | 'fact' | 'event';
interface TmpInfo {
  id: string;
  order: number;
  cls?: TmpClass;
  /** 0 = 明确声明（entity.create / 实体文件 / obligation.open / fact.assert），1 = 由引用位置推断 */
  strength: number;
  kind?: EntityKind;
  name?: string;
  chapter?: string;
  /** 实体文件路径（需要改名） */
  entityFile?: { path: string; dir: string };
}

const ENTITY_KEYS: Record<string, EntityKind | undefined> = {
  ent: undefined,
  who: 'character',
  a: undefined,
  b: undefined,
  item: 'item',
  to: undefined,
  from: undefined,
  loc: 'location',
  pov: 'character',
  about: undefined,
  entities_present: undefined,
};
const OBLIGATION_KEYS = new Set(['obligation', 'pays', 'advances', 'may_open', 'required_closures', 'opens']);

function textOf(c: FileChange): string | null {
  if (c.content === null) return null;
  if (typeof c.content === 'string') return c.content;
  if (/\.(json|jsonl|ya?ml|md|txt)$/.test(c.path)) return c.content.toString('utf8');
  return null;
}

function cleanTmp(raw: string): string {
  return raw.replace(/\.+$/, '');
}

class Collector {
  readonly infos = new Map<string, TmpInfo>();
  private order = 0;

  touch(id: string): TmpInfo {
    let i = this.infos.get(id);
    if (!i) {
      i = { id, order: this.order++, strength: 9 };
      this.infos.set(id, i);
    }
    return i;
  }

  hint(id: string, cls: TmpClass, strength: number, extra: Partial<TmpInfo> = {}): void {
    if (!id.startsWith('tmp:')) return;
    const i = this.touch(cleanTmp(id));
    if (strength < i.strength || (strength === i.strength && !i.cls)) {
      i.cls = cls;
      i.strength = strength;
      Object.assign(i, extra);
    } else if (strength === i.strength && i.cls === cls) {
      for (const [k, v] of Object.entries(extra))
        if ((i as unknown as Record<string, unknown>)[k] === undefined) (i as unknown as Record<string, unknown>)[k] = v;
    }
  }

  walk(node: unknown, ctx: { chapter?: string; parentKey?: string }): void {
    if (Array.isArray(node)) {
      for (const x of node) this.walk(x, ctx);
      return;
    }
    if (typeof node === 'string') {
      if (!node.startsWith('tmp:')) return;
      const k = ctx.parentKey;
      if (k && k in ENTITY_KEYS) this.hint(node, 'entity', 2, ENTITY_KEYS[k] ? { kind: ENTITY_KEYS[k] } : {});
      else if (k === 'fact') this.hint(node, 'fact', 2);
      else if (k && OBLIGATION_KEYS.has(k)) this.hint(node, 'obligation', 2);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const chapter = typeof o.chapter === 'string' && /^c\d{5}$/.test(o.chapter) ? o.chapter : ctx.chapter;
    // 明确声明
    if (o.op === 'entity.create' && typeof o.ent === 'string') {
      this.hint(o.ent, 'entity', 0, {
        ...(ENTITY_KINDS.includes(o.kind as EntityKind) ? { kind: o.kind as EntityKind } : {}),
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
      });
    }
    if (o.op === 'obligation.open' && typeof o.id === 'string') this.hint(o.id, 'obligation', 0);
    if (typeof o.op === 'string' && o.op.startsWith('obligation.') && typeof o.id === 'string') this.hint(o.id, 'obligation', 1);
    if (o.op === 'fact.assert' && typeof o.fact === 'string') this.hint(o.fact, 'fact', 0, typeof o.text === 'string' ? { name: o.text } : {});
    if (o.op === 'event' && typeof o.id === 'string') this.hint(o.id, 'event', 0, chapter ? { chapter } : {});
    // 谓词位置
    for (const key of ['knows', 'knows_not'] as const) {
      const v = o[key];
      if (Array.isArray(v)) {
        if (typeof v[0] === 'string') this.hint(v[0], 'entity', 1, { kind: 'character' });
        if (typeof v[1] === 'string') this.hint(v[1], 'fact', 1);
      }
    }
    if (Array.isArray(o.at_loc)) {
      if (typeof o.at_loc[0] === 'string') this.hint(o.at_loc[0], 'entity', 1);
      if (typeof o.at_loc[1] === 'string') this.hint(o.at_loc[1], 'entity', 1, { kind: 'location' });
    }
    for (const key of ['stage', 'has_cond'] as const) {
      const v = o[key];
      if (Array.isArray(v) && typeof v[0] === 'string') this.hint(v[0], 'entity', 1);
    }
    for (const key of ['alive', 'dead'] as const) if (typeof o[key] === 'string') this.hint(o[key] as string, 'entity', 1);
    if (Array.isArray(o.attr) && typeof o.attr[0] === 'string') this.hint(o.attr[0], 'entity', 1);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'attr' || k === 'knows' || k === 'knows_not' || k === 'at_loc') continue;
      if (k === 'id' && typeof v === 'string') continue; // id 只在上面的 op 语境中有意义
      this.walk(v, chapter ? { chapter, parentKey: k } : { parentKey: k });
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 返回 tmp→正式 id 映射，以及回写过的文件（yaml/json/md 中所有 tmp:x 引用）。会把新分配的 id 加入 ctx.existing、推进 ctx.nextObligationNo */
export function resolveTmpIds(files: FileChange[], ctx: IdContext): ResolveTmpResult {
  const col = new Collector();
  const texts = files.map(textOf);
  files.forEach((f, idx) => {
    const t = texts[idx];
    if (t == null) return;
    for (const m of t.matchAll(TMP_SCAN_RE)) col.touch(cleanTmp(m[0]));
    try {
      if (f.path.endsWith('.json')) col.walk(JSON.parse(t), {});
      else if (f.path.endsWith('.jsonl')) {
        for (const line of t.split('\n')) if (line.trim()) col.walk(JSON.parse(line), {});
      } else if (/\.ya?ml$/.test(f.path)) col.walk(yamlParse(t), {});
      else if (f.path.endsWith('.md')) {
        const fm = parseFrontmatter(t);
        if (fm.data && typeof fm.data === 'object') {
          const d = fm.data as Record<string, unknown>;
          const m = /^bible\/entities\/([^/]+)\/[^/]+\.md$/.exec(f.path);
          if (typeof d.id === 'string' && d.id.startsWith('tmp:')) {
            const kind = ENTITY_KINDS.includes(d.kind as EntityKind) ? (d.kind as EntityKind) : m ? ENTITY_KIND_BY_DIR[m[1] as string] : undefined;
            col.hint(d.id, 'entity', 0, {
              ...(kind ? { kind } : {}),
              ...(typeof d.name === 'string' ? { name: d.name } : {}),
              ...(m ? { entityFile: { path: f.path, dir: m[1] as string } } : {}),
            });
          }
          col.walk(d, {});
        }
      }
    } catch {
      // 解析失败：只做文本替换（下游 schema 校验会报错）
    }
  });

  const infos = [...col.infos.values()].sort((a, b) => a.order - b.order);
  const mapping: Record<string, string> = {};
  const warnings: string[] = [];
  const unresolved: string[] = [];
  const takenFor = (prefix: string): Set<string> => {
    const s = new Set<string>();
    for (const id of ctx.existing) if (id.startsWith(`${prefix}.`)) s.add(id.slice(prefix.length + 1));
    return s;
  };
  const localName = (tmp: string) => tmp.slice(4);
  for (const i of infos) {
    switch (i.cls) {
      case 'entity': {
        const kind: EntityKind = i.kind ?? 'concept';
        const prefix = ENTITY_PREFIX[kind];
        const name = i.name ?? localName(i.id);
        const slug = slugifyName(/^[a-z0-9-]+$/.test(localName(i.id)) && !i.name ? localName(i.id) : name, takenFor(prefix));
        const id = `${prefix}.${slug}`;
        mapping[i.id] = id;
        ctx.existing.add(id);
        if (i.name) {
          const prev = ctx.names.get(i.name);
          if (prev && prev !== id) warnings.push(`新实体「${i.name}」(${id}) 与已有实体 ${prev} 同名`);
          ctx.names.set(i.name, id);
        }
        break;
      }
      case 'obligation': {
        let id = obligationId(ctx.nextObligationNo++);
        while (ctx.existing.has(id)) id = obligationId(ctx.nextObligationNo++);
        mapping[i.id] = id;
        ctx.existing.add(id);
        break;
      }
      case 'fact': {
        const ln = localName(i.id);
        const slug = slugifyName(/^[a-z0-9.-]+$/.test(ln) ? ln.replace(/\./g, '-') : (i.name ?? ln), takenFor('fact'));
        const id = `fact.${slug}`;
        mapping[i.id] = id;
        ctx.existing.add(id);
        break;
      }
      case 'event': {
        const ln = slugifyName(localName(i.id), new Set());
        let id = i.chapter ? `ev.${i.chapter}.${ln}` : `ev.${ln}`;
        for (let n = 2; ctx.existing.has(id); n++) id = `${i.chapter ? `ev.${i.chapter}.${ln}` : `ev.${ln}`}-${n}`;
        mapping[i.id] = id;
        ctx.existing.add(id);
        break;
      }
      default:
        unresolved.push(i.id);
    }
  }

  const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
  const re = keys.length ? new RegExp(`(?:${keys.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])`, 'gu') : null;
  const entityRenames = new Map<string, string>();
  for (const i of infos) {
    if (i.entityFile && mapping[i.id]) {
      const slug = (mapping[i.id] as string).split('.').slice(1).join('.');
      const dir = i.entityFile.dir in ENTITY_KIND_BY_DIR ? i.entityFile.dir : ENTITY_DIRS[i.kind ?? 'concept'];
      entityRenames.set(i.entityFile.path, P.entity(dir, slug));
    }
  }
  const out: FileChange[] = files.map((f, idx) => {
    const t = texts[idx];
    const newPath = entityRenames.get(f.path) ?? f.path;
    if (t == null || !re) return newPath === f.path ? f : { path: newPath, content: f.content };
    const replaced = t.replace(re, (m) => mapping[m] ?? m);
    if (replaced === t && newPath === f.path) return f;
    return { path: newPath, content: replaced };
  });
  // 改名的实体文件：旧路径删除（若旧路径在仓库中存在，committer 会一并提交删除）
  for (const [from, to] of entityRenames) if (from !== to) out.push({ path: from, content: null });

  const res: ResolveTmpResult = { mapping, files: out };
  if (warnings.length) res.warnings = warnings;
  if (unresolved.length) res.unresolved = unresolved;
  return res;
}
