import { describe, expect, it } from 'vitest';
import { getYaml, parseRange, setYaml } from '../src/lib/yamlEdit';

// repo.ts 用 yaml.stringify 写 book.yaml：volumes 等是块式序列
const raw = ['schema: nv.book/1', 'slug: x', 'scale:', '  target_cjk: 1000', '  volumes:', '    - 10', '    - 12', '  chapters_per_volume:', '    - 80', '    - 110', ''].join('\n');

describe('yamlEdit 块式序列', () => {
  it('读取为行内形式', () => {
    expect(parseRange(getYaml(raw, ['scale', 'volumes']))).toEqual([10, 12]);
  });

  it('写入时把块式序列替换成行内序列', () => {
    const next = setYaml(raw, ['scale', 'volumes'], '[8, 9]');
    expect(next).not.toBeNull();
    expect(getYaml(next as string, ['scale', 'volumes'])).toBe('[8, 9]');
    expect(getYaml(next as string, ['scale', 'chapters_per_volume'])).toBe('[80, 110]');
    expect((next as string).match(/- 10/)).toBeNull();
  });
});
