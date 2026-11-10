/** v3 flow 测试夹具（只在测试中使用）：OrderSpec / MapInput 工厂与确定性的中文假正文。 */
import type { MapInput } from './map.js';
import { emptyV3Meta } from './state.js';
import type { OrderSpec, V3BookMeta } from './types.js';

const POOL = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国有虞陶唐吊民伐罪周发殷汤坐朝问道垂拱平章爱育黎首臣伏戎羌遐迩一体率宾归王鸣凤在竹白驹食场化被草木赖及万方';

/** 确定性伪随机中文：同一个 seed 得到同一段文字，不同 seed 之间没有长逐字重复。以句号结尾 */
export function prose(chars: number, seed: number): string {
  let x = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  const paras: string[] = [];
  let n = 0;
  let para = '';
  while (n < chars) {
    const len = 8 + (next() % 12);
    let s = '';
    for (let i = 0; i < len; i++) s += POOL[next() % POOL.length];
    n += len;
    para += `${s}${n >= chars || next() % 3 === 0 ? '。' : '，'}`;
    if (para.endsWith('。') && (next() % 4 === 0 || n >= chars)) {
      paras.push(`　　${para}`);
      para = '';
    }
  }
  if (para) paras.push(`　　${para.replace(/，$/, '。')}`);
  return paras.join('\n\n');
}

/** "# 第N章 标题\n\n正文\n" */
export function chapterText(no: number, chars = 3200, title = `章名${no}`, seed = no): string {
  return `# 第${no}章${title ? ` ${title}` : ''}\n\n${prose(chars, seed)}\n`;
}

export function orderSpec(p: Partial<OrderSpec> = {}): OrderSpec {
  return {
    v: 1,
    mode: 'write',
    kind: 'book.write',
    from: 6,
    count: 5,
    finale: false,
    minChars: 3000,
    targetCjk: 60000,
    planned: 15,
    plannedMax: 30,
    batch: 5,
    accepted: 5,
    totalCjk: 18000,
    publishedThrough: 0,
    locked: [],
    allowRewrite: [],
    bibleExisted: true,
    hintsShown: [],
    effort: 'medium',
    ...p,
  };
}

export type FileIn = MapInput['files'][number];

export function file(path: string, text: string, p: Partial<FileIn> = {}): FileIn {
  return { path, text, isNew: true, ignored: false, baseText: null, ...p };
}

/** 一批普通写作批的笔记改动（chapters.md 每章一行、progress.md 更新），让 notes_missing 不出现 */
export function notesFor(from: number, to: number, baseLines = from - 1): FileIn[] {
  const base = Array.from({ length: baseLines }, (_, i) => `第${i + 1}章：旧事。`).join('\n');
  const add = Array.from({ length: to - from + 1 }, (_, i) => `第${from + i}章：新事。`).join('\n');
  return [file('notes/chapters.md', `${base}\n${add}\n`, { isNew: false, baseText: `${base}\n` }), file('notes/progress.md', `写到第${to}章。\n`, { isNew: false, baseText: '旧进度。\n' })];
}

export function mapInput(p: Partial<Omit<MapInput, 'meta'>> & { meta?: Partial<V3BookMeta> } = {}): MapInput {
  const { meta, ...rest } = p;
  return {
    order: orderSpec(),
    files: [],
    baseChapters: new Map(),
    frozen: { publishedThrough: 0, locked: [] },
    bibleAtBase: '# 《旧书》\n一句话：旧简介。\n标签：悬疑\n',
    outlineAtBase: null,
    progressAtBase: null,
    plannedInitial: 15,
    autoTitle: false,
    titleIsPlaceholder: false,
    hasBlurb: true,
    nowIso: '2026-11-10T00:00:00.000Z',
    runId: 'run12345abcdef',
    length: 'medium',
    ...rest,
    meta: { ...emptyV3Meta(), ...(meta ?? {}) },
  };
}

/** 去掉标题行后的正文（与 MapInput.baseChapters 的约定一致） */
export function bodyOf(text: string): string {
  return text.replace(/^#[^\n]*\n+/, '').replace(/\s+$/u, '');
}
