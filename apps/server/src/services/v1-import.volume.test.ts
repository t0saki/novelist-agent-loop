/**
 * v1 导入写的卷骨架 plan/volumes/vNN.yaml：zVolume 删掉之后，输出必须与旧代码逐字节相同。
 * __golden__/v1-volume.golden.yaml 是在基线提交（db19762）上用 yamlStringify(zVolume.parse(…), { lineWidth: 0 }) 生成的。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { v1VolumeYaml } from './v1-import.js';

const GOLDEN = path.join(import.meta.dirname, '__golden__', 'v1-volume.golden.yaml');

describe('v1 import volume skeleton', () => {
  it('equals the golden captured from the old zVolume.parse output (key order and defaults)', async () => {
    expect(v1VolumeYaml({ id: 'v02', title: '第二卷 风起', from: 31, to: 60 })).toBe(await fs.readFile(GOLDEN, 'utf8'));
  });

  it('skips an id that is not vNN (the only input the old safeParse refused); the title round-trips', () => {
    expect(v1VolumeYaml({ id: 'vol-1', title: 'x', from: 1, to: 2 })).toBeNull();
    expect(v1VolumeYaml({ id: 'v1', title: 'x', from: 1, to: 2 })).toBeNull();
    const doc = yamlParse(v1VolumeYaml({ id: 'v100', title: '正文', from: 1, to: 1 }) as string) as Record<string, unknown>;
    expect(doc).toMatchObject({ schema: 'nv.volume/1', id: 'v100', title: '正文', chapters: ['c00001', 'c00001'] });
  });
});
