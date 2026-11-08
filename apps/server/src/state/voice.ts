/** voice 锚点：从近期定稿中自动收集角色的代表性台词（DESIGN §4.3、§6.9）。确定性。Owner: lane B。 */
import type { AliasIndex } from '../context/alias.js';

export interface VoiceQuote {
  ch: string;
  quote: string;
}

const QUOTE_RE = /[“「]([^”」\n]{4,120})[”」]/gu;
const SPEECH_AFTER = /^[^“「\n]{0,4}(道|说|问|答|笑|喝|叫|喊|吼|骂|叹|应|喃喃|低声|冷声|沉声)/u;

/**
 * chapters：按时间倒序（最近的在前）。每个实体最多 perEntity 句（去重），引文长度 6–80 字。
 * 说话人判定：引号前 24 字内最后一个非歧义提及；或引号后紧跟“某某道/说…”。
 */
export function collectVoiceAnchors(
  chapters: { ch: string; text: string }[],
  aliases: AliasIndex,
  targets: Set<string>,
  perEntity = 5,
): Map<string, VoiceQuote[]> {
  const out = new Map<string, VoiceQuote[]>();
  const full = (e: string) => (out.get(e)?.length ?? 0) >= perEntity;
  for (const { ch, text } of chapters) {
    if ([...targets].every(full)) break;
    for (const para of text.split(/\n+/)) {
      if (!para.includes('“') && !para.includes('「')) continue;
      const mentions = aliases.scan(para).filter((m) => !m.ambiguous);
      for (const m of para.matchAll(QUOTE_RE)) {
        const q = (m[1] ?? '').trim();
        if (q.length < 6 || q.length > 80) continue;
        const qs = m.index ?? 0;
        const qe = qs + m[0].length;
        let speaker: string | null = null;
        const before = mentions.filter((x) => x.end <= qs && qs - x.end <= 24);
        if (before.length) speaker = (before[before.length - 1] as { entity: string }).entity;
        if (!speaker) {
          const after = mentions.find((x) => x.start >= qe && x.start - qe <= 2);
          if (after && SPEECH_AFTER.test(para.slice(after.end, after.end + 8))) speaker = after.entity;
        }
        if (!speaker || !targets.has(speaker) || full(speaker)) continue;
        const list = out.get(speaker) ?? [];
        if (!list.some((x) => x.quote === q)) list.push({ ch, quote: q });
        out.set(speaker, list);
      }
    }
  }
  return out;
}
