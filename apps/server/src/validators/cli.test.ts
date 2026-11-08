import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nvMain } from './cli.js';

let root: string;
const logs: string[] = [];
const errs: string[] = [];
const io = () => ({ out: (l: string) => logs.push(l), err: (l: string) => errs.push(l), cwd: path.join(root, 'book') });
const draft = '<!-- beat:b1 -->\n林枫走了。\n\n<!-- beat:b2 -->\n苏婉笑了。\n';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-cli-'));
  logs.length = 0;
  errs.length = 0;
  await fs.mkdir(path.join(root, 'book', 'plan', 'cards'), { recursive: true });
  await fs.mkdir(path.join(root, 'in'), { recursive: true });
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.writeFile(path.join(root, 'book', 'd.md'), draft);
  await fs.writeFile(path.join(root, 'out', 'draft.md'), draft);
  await fs.writeFile(path.join(root, 'book', 'plan', 'cards', 'c00003.yaml'), 'beats:\n  - { id: b1, cjk: 100 }\n  - { id: b3, cjk: 100 }\n');
  await fs.writeFile(
    path.join(root, 'in', 'workorder.md'),
    `---\nschema: nv.workorder/1\ntarget: c00003\nout_dir: ${path.join(root, 'out')}\nartifacts:\n  - path: draft.md\n    kind: chapter_draft\n    length: { min: 3, target: 6, max: 7, count_mode: han }\n---\n正文\n`,
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('nv count', () => {
  it('prints totals and per-beat counts', () => {
    expect(nvMain(['count', 'd.md'], io())).toBe(0);
    expect(logs[0]).toContain('8');
    expect(logs.join('\n')).toContain('b2: 4');
  });
  it('--json is machine-readable; supports platform mode', () => {
    expect(nvMain(['count', 'd.md', '--json', '--mode', 'platform'], io())).toBe(0);
    const r = JSON.parse(logs[0] as string);
    expect(r).toMatchObject({ mode: 'platform', han: 8, beats: { b1: 5, b2: 5 } });
  });
  it('fails clearly on missing files and usage', () => {
    expect(nvMain(['count', 'nope.md'], io())).toBe(66);
    expect(nvMain(['count'], io())).toBe(64);
    expect(nvMain([], io())).toBe(64);
  });
});

describe('nv gate --quick', () => {
  it('finds the work order from the book cwd and reports count, missing beats, truncation', () => {
    expect(nvMain(['gate', '--quick', '--json'], io())).toBe(1);
    const r = JSON.parse(logs[0] as string);
    expect(r).toMatchObject({ total: 8, missing_beats: ['b3'], truncation: null, passed: false, range: { max: 7 } });
  });
  it('--report always exits 0 and prints a human summary', () => {
    expect(nvMain(['gate', '--quick', '--report'], io())).toBe(0);
    expect(logs.join('\n')).toContain('缺少 beat 标记：b3');
  });
  it('skips cleanly when no draft is around', async () => {
    await fs.rm(path.join(root, 'out', 'draft.md'));
    expect(nvMain(['gate', '--quick', '--report'], io())).toBe(0);
    expect(logs[0]).toContain('跳过');
  });
  it('accepts an explicit draft', async () => {
    await fs.writeFile(path.join(root, 'book', 'x.md'), '他说：“我这就');
    expect(nvMain(['gate', '--quick', '--draft', 'x.md', '--json'], io())).toBe(1);
    expect(JSON.parse(logs[0] as string).truncation).toContain('未闭合');
  });
  it('--report never fails even on bad args', () => {
    expect(nvMain(['gate', '--report'], io())).toBe(0);
    expect(nvMain(['gate', '--quick', '--report', '--nope'], io())).toBe(0);
  });
});
