import { describe, expect, it } from 'vitest';
import { createEvidenceMatcher, matchEvidence, verifyQuotes } from './evidence.js';

const draft = '<!-- beat:b1 -->\n“师兄，你又偷懒。”苏婉笑道。\n\n林枫把那枚铜牌收进袖中，抬头看了看灰白的天色，雪还在下。\n';

describe('matchEvidence', () => {
  it('matches exact text with original offsets', () => {
    const m = matchEvidence(draft, '林枫把那枚铜牌收进袖中');
    expect(m.kind).toBe('exact');
    expect(draft.slice(m.start, m.end)).toBe('林枫把那枚铜牌收进袖中');
  });

  it('normalizes whitespace and punctuation before exact matching', () => {
    expect(matchEvidence(draft, '"师兄,你又 偷懒."苏婉笑道').kind).toBe('exact');
    expect(matchEvidence('他说……好吧。', '他说...好吧').kind).toBe('exact');
    expect(matchEvidence('——不！', '—不!').kind).toBe('exact');
  });

  it('never matches inside beat markers', () => {
    expect(matchEvidence(draft, 'beat:b1').kind).toBe('none');
  });

  it('fuzzy-matches near quotes and replaces with verbatim source text', () => {
    const m = matchEvidence(draft, '林枫把那枚铜牌收进袖中，抬头看了看灰白的天色，雪还在上');
    expect(m.kind).toBe('fuzzy');
    expect(m.ratio).toBeGreaterThanOrEqual(0.8);
    expect(m.replacement).toBe('林枫把那枚铜牌收进袖中，抬头看了看灰白的天色，雪还在下');
    expect(draft).toContain(m.replacement as string);
  });

  it('keeps fuzzy replacements within one paragraph', () => {
    const m = matchEvidence('第一段结尾的这句话。\n\n第二段开头的这句话也很长，确实很长很长。', '这句话也很长，确实很长很长了吧');
    if (m.kind === 'fuzzy') expect(m.replacement).not.toContain('\n');
  });

  it('rejects unrelated quotes', () => {
    expect(matchEvidence(draft, '完全不相干的内容在这里').kind).toBe('none');
    expect(matchEvidence(draft, '   ').kind).toBe('none');
  });

  it('honors fuzzyThreshold', () => {
    expect(matchEvidence(draft, '林枫把那枚铜牌收进袖里', { fuzzyThreshold: 0.99 }).kind).toBe('none');
  });
});

describe('verifyQuotes', () => {
  it('reports each quote', () => {
    const rs = verifyQuotes(draft, ['苏婉笑道', '不存在的话语']);
    expect(rs.map((r) => r.ok)).toEqual([true, false]);
  });
  it('matcher reuses one draft', () => {
    const m = createEvidenceMatcher(draft);
    expect(m.match('苏婉笑道').kind).toBe('exact');
    expect(m.match('雪还在下').kind).toBe('exact');
  });
});
