/** 中文名 → 拼音 slug（书、题材包的目录名）。从 state/ids.ts 迁来，内容不变。 */
import { createRequire } from 'node:module';

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
