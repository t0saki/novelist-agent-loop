/** Lexicon 分层合并（DESIGN §6.5、§6.8）：高层 allow 压过低层 ban；高层 ban 收回低层 allow；同层 allow 优先。Owner: lane D。 */
import type { Lexicon } from '@novelist/shared';
import { type LexiconEntry, entryParts } from './util.js';

const keyOf = (e: LexiconEntry): string => entryParts(e).pattern;

/**
 * 按层从低到高合并（内置 → 全局 → 模型 → 题材链 → 书）。
 * 运行时只要命中被 allow 覆盖的文本就不计违规，所以书层 allow 永远生效；
 * 这里额外处理“高层重新 ban 一个低层 allow 过的词”，避免低层 allow 永久压过书层 ban。
 */
export function mergeLexiconLayers(layers: Lexicon[]): Lexicon {
  let ban: LexiconEntry[] = [];
  let watch: LexiconEntry[] = [];
  let allow: LexiconEntry[] = [];
  const patterns = new Map<string, Lexicon['patterns'][number]>();
  for (const layer of layers) {
    const allowedHere = new Set(layer.allow.map(keyOf));
    const bannedHere = new Set([...layer.ban, ...layer.watch].map(keyOf).filter((k) => !allowedHere.has(k)));
    allow = allow.filter((e) => !bannedHere.has(keyOf(e)));
    ban = ban.filter((e) => !allowedHere.has(keyOf(e)));
    watch = watch.filter((e) => !allowedHere.has(keyOf(e)));
    ban = [...ban, ...layer.ban.filter((e) => !allowedHere.has(keyOf(e)))];
    watch = [...watch, ...layer.watch.filter((e) => !allowedHere.has(keyOf(e)))];
    allow = [...allow, ...layer.allow];
    for (const p of layer.patterns) patterns.set(p.id, p);
  }
  return { schema: 'nv.lexicon/1', ban, watch, allow, patterns: [...patterns.values()] };
}
