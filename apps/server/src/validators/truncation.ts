/** 文件末尾完整性（DESIGN §6.5）。纯函数，nv gate --quick 也用它。Owner: lane D。 */
import { stripBeatMarkers } from '@novelist/shared';

/** 句末可接受的结束字符（含收尾引号与括号） */
const SENTENCE_END = /[。．.！!？?…～~—”’」』）)】》〕"'`*_>|\]}]$/u;
const PAIRS: [string, string][] = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['（', '）'],
  ['《', '》'],
  ['【', '】'],
];

export interface TruncationOptions {
  /** 是否要求最后一段以句末符号收尾（章节正文 = true；通用 markdown = false） */
  sentence?: boolean;
}

/** 末尾完整性：未闭合引号/括号、半个 UTF-8 序列、最后一段截断在句中 */
export function checkTruncation(text: string, opts: TruncationOptions = {}): { ok: boolean; detail?: string } {
  const body = stripBeatMarkers(text).replace(/\s+$/u, '');
  if (body.endsWith('�')) return { ok: false, detail: '末尾是半个 UTF-8 序列（U+FFFD）' };
  if (/<!--(?![\s\S]*-->)/.test(body)) return { ok: false, detail: '末尾有未闭合的 HTML 注释' };
  const fences = body.match(/^```/gm)?.length ?? 0;
  if (fences % 2 === 1) return { ok: false, detail: '代码围栏未闭合' };
  const tail = body.replace(/(?:\s*<!--[\s\S]*?-->)+$/u, '').replace(/\s+$/u, '');
  const paragraphs = tail.split(/\n\s*\n|\n/u);
  const last = paragraphs[paragraphs.length - 1] ?? '';
  for (const [open, close] of PAIRS) {
    if (last.split(open).length > last.split(close).length) return { ok: false, detail: `最后一段的 ${open} 未闭合` };
  }
  if ((last.match(/"/g)?.length ?? 0) % 2 === 1) return { ok: false, detail: '最后一段的英文引号未闭合' };
  if (opts.sentence !== false && last.length > 0 && !SENTENCE_END.test(last)) {
    return { ok: false, detail: `最后一段没有以句末标点结束：…${last.slice(-12)}` };
  }
  return { ok: true };
}
