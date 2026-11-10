import { describe, expect, it } from 'vitest';
import { REPEAT_WATCHLIST, repeatedPhrases, shortRecent } from './feedback.js';
import { prose } from './testing.js';

/** 一章：伪随机正文，每段开头插一次 phrase（共 paras 段） */
const chapter = (seed: number, paras: number, phrase = '', chars = 400) =>
  Array.from({ length: paras }, (_, i) => `${phrase ? `${phrase}，` : ''}${prose(chars, seed * 100 + i).trim()}`).join('\n\n');

describe('repeatedPhrases', () => {
  it('repeated 4–8 char phrase reported', () => {
    const bodies = [chapter(1, 3, '月光洒在青石板上'), chapter(2, 3, '月光洒在青石板上')];
    const out = repeatedPhrases(bodies, '');
    expect(out[0]).toBe('月光洒在青石板上');
  });
  it('names in bible/cast excluded', () => {
    const bodies = [chapter(1, 3, '沈青梧推开窗'), chapter(2, 3, '沈青梧推开窗')];
    expect(repeatedPhrases(bodies, '')).toContain('沈青梧推开窗');
    const out = repeatedPhrases(bodies, '# 人物\n- 沈青梧推开窗：主角的口头禅。');
    expect(out).not.toContain('沈青梧推开窗');
    // 任何在设定里出现过的 n-gram 都不报（人名四字以上时）
    expect(out.some((p) => '沈青梧推开窗'.includes(p))).toBe(false);
  });
  it('substring of a longer repeated phrase suppressed', () => {
    const bodies = [chapter(1, 4, '他深吸一口长气'), chapter(2, 4, '他深吸一口长气')];
    const out = repeatedPhrases(bodies, '');
    expect(out).toContain('他深吸一口长气');
    for (const sub of ['深吸一口长气', '他深吸一口', '一口长气']) expect(out).not.toContain(sub);
  });
  it('a shorter phrase that also repeats on its own is kept', () => {
    const own = Array.from({ length: 10 }, (_, i) => `${prose(40, 900 + i).replace(/。$/, '')}，青灯古卷。`).join('');
    const out = repeatedPhrases([chapter(1, 2, '青灯古卷照夜'), own], '');
    expect(out).toContain('青灯古卷');
  });
  it('watch-list word reported above 8/10k', () => {
    expect(REPEAT_WATCHLIST).toContain('仿佛');
    // 约 2000 字里 6 次 > 1.6 次（8/10k）
    const body = Array.from({ length: 6 }, (_, i) => `仿佛${prose(320, 700 + i)}`).join('\n\n');
    expect(repeatedPhrases([body], '')).toContain('仿佛');
    // 1 次：不报
    expect(repeatedPhrases([`仿佛${prose(2000, 77)}`], '')).not.toContain('仿佛');
  });
  it('below thresholds → []', () => {
    expect(repeatedPhrases([prose(3000, 5), prose(3000, 6)], '')).toEqual([]);
    expect(repeatedPhrases([chapter(1, 3, '月光洒在青石板上')], '')).toEqual([]); // 3 次 < 4
    expect(repeatedPhrases([], '')).toEqual([]);
    expect(repeatedPhrases(['abc def'], '')).toEqual([]);
  });
  it('deterministic order (count × length, then string), at most max', () => {
    const bodies = [chapter(1, 5, '甲乙丙丁戊'), chapter(2, 5, '子丑寅卯'), chapter(3, 5, '天干地支表')];
    const a = repeatedPhrases(bodies, '');
    expect(a).toEqual(repeatedPhrases([...bodies], ''));
    expect(a.slice(0, 3)).toEqual(['天干地支表', '甲乙丙丁戊', '子丑寅卯']);
    expect(repeatedPhrases(bodies, '', { max: 2 })).toHaveLength(2);
  });
  it('phrases never cross punctuation', () => {
    const bodies = [chapter(1, 3, '风起，云涌'), chapter(2, 3, '风起，云涌')];
    expect(repeatedPhrases(bodies, '').some((p) => p.includes('风起云涌'))).toBe(false);
  });
});

describe('shortRecent', () => {
  it('avg < 1.2·floor true, ≥ false, null false', () => {
    expect(shortRecent(3500, 3000)).toBe(true);
    expect(shortRecent(3600, 3000)).toBe(false);
    expect(shortRecent(4000, 3000)).toBe(false);
    expect(shortRecent(null, 3000)).toBe(false);
  });
});
