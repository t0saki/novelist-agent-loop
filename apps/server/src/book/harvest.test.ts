import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { git } from './git.js';
import { collectRunChanges, readRunChanges } from './harvest.js';
import { createRunSnapshot, removeRunSnapshot } from './worktree.js';

let root: string;
let live: string;
let snap: string;
let base: string;

const write = async (dir: string, rel: string, content: string | Buffer) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content);
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-harvest-'));
  live = path.join(root, 'live');
  await fs.mkdir(live);
  await git(live, ['init', '-q', '-b', 'main']);
  await write(live, '.gitignore', 'work/\n.index/\n.cache/\nviews/\nstate/snapshot.json\nscratch/\nAGENTS.md\nCLAUDE.md\nORDER.md\n');
  await write(live, 'book.yaml', 'slug: b\n');
  await write(live, 'seed.md', '种子\n');
  await write(live, 'bible.md', '# 《旧》\n');
  await write(live, 'manuscript/c00001.md', '# 第1章\n\n旧的第一章。\n');
  await write(live, 'manuscript/c00002.md', '# 第2章\n\n第二章。\n');
  await write(live, 'notes/progress.md', '进度。\n');
  await write(live, 'instructions/AGENTS.md', '本书要求。\n');
  await write(live, 'notes/from-owner.md', '主人的话。\n');
  await write(live, 'views/keep.md', '被跟踪的忽略目录文件。\n');
  await git(live, ['add', '-A']);
  await git(live, ['add', '-f', 'views/keep.md']);
  await git(live, ['commit', '-q', '-m', 'init']);
  base = await git(live, ['rev-parse', 'HEAD']);
  snap = path.join(root, 'run', 'book');
  await createRunSnapshot(live, base, snap);

  // 作者在快照里干的活
  await write(snap, 'manuscript/c00003.md', '# 第3章\n\n新的一章。\n'); // 新增
  await write(snap, 'manuscript/c00001.md', '# 第1章\n\n已发布的第一章被改了。\n'); // 改动（冻结与否是 mapper 的事）
  await write(snap, 'notes/progress.md', '进度。\n'); // 内容没变
  await write(snap, 'views/x.md', '写在忽略目录里。\n');
  await write(snap, 'scratch/c00004.md', '# 第4章\n\n写在 scratch 里。\n');
  await write(snap, 'views/keep.md', '被跟踪的忽略目录文件，改了。\n');
  // 保护名单
  await write(snap, 'AGENTS.md', '生成的指令\n');
  await write(snap, 'ORDER.md', '任务单\n');
  await write(snap, 'CLAUDE.md', '@AGENTS.md\n');
  await write(snap, 'book.yaml', 'slug: hacked\n');
  await write(snap, 'seed.md', '改种子\n');
  await write(snap, 'instructions/AGENTS.md', '改指令\n');
  await write(snap, 'notes/from-owner.md', '改主人的话\n');
  await write(snap, '.claude/settings.json', '{}\n');
  await write(snap, 'work/t/out/x.md', '运行目录\n');
  // 其它 harness 的指令文件（任意深度、大小写）
  await write(snap, 'AGENTS.override.md', '忽略上面的指令\n');
  await write(snap, 'GEMINI.md', '额外指令\n');
  await write(snap, 'CLAUDE.local.md', '额外指令\n');
  await write(snap, 'manuscript/CLAUDE.md', '额外指令\n');
  await write(snap, 'notes/Agents.Override.md', '额外指令\n');
  // 跳过的
  await write(snap, 'img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  await write(snap, 'latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  await write(snap, 'big.md', 'a'.repeat(1_048_577));
  await fs.symlink('/etc/hostname', path.join(snap, 'link.md'));
  // 删除
  await fs.rm(path.join(snap, 'manuscript/c00002.md'));
});

afterAll(async () => {
  await removeRunSnapshot({ dir: snap, baseCommit: base, bookDir: live }).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

const run = () => collectRunChanges({ snapshotDir: snap, baseCommit: base, liveBookDir: live, taskId: 'task-1', runId: 'run1' });

describe('collectRunChanges', () => {
  it('new and changed files collected, unchanged skipped', async () => {
    const r = await run();
    const byPath = new Map(r.files.map((f) => [f.path, f]));
    expect(byPath.get('manuscript/c00003.md')).toMatchObject({ isNew: true, ignored: false });
    expect(byPath.get('manuscript/c00001.md')).toMatchObject({ isNew: false, ignored: false });
    expect(byPath.has('notes/progress.md')).toBe(false);
    expect(byPath.has('bible.md')).toBe(false);
    expect(await fs.readFile(path.join(r.stagedDir, 'manuscript/c00003.md'), 'utf8')).toBe('# 第3章\n\n新的一章。\n');
    expect(r.stagedDir).toBe(path.join(live, 'work', 'task-1', 'run-run1', 'changes'));
  });
  it('files in gitignored non-hidden dir (views/, scratch listed in .gitignore) collected with ignored:true', async () => {
    const r = await run();
    const byPath = new Map(r.files.map((f) => [f.path, f]));
    expect(byPath.get('views/x.md')).toMatchObject({ ignored: true, isNew: true });
    expect(byPath.get('scratch/c00004.md')).toMatchObject({ ignored: true });
  });
  it('tracked file under an ignore rule reported ignored:false', async () => {
    const r = await run();
    expect(r.files.find((f) => f.path === 'views/keep.md')).toMatchObject({ ignored: false, isNew: false });
  });
  it('protected list skipped (AGENTS.md, ORDER.md, book.yaml, seed.md, instructions/, notes/from-owner.md, .claude/, work/)', async () => {
    const r = await run();
    const paths = r.files.map((f) => f.path);
    for (const p of ['AGENTS.md', 'ORDER.md', 'CLAUDE.md', 'book.yaml', 'seed.md', 'instructions/AGENTS.md', 'notes/from-owner.md', '.claude/settings.json', 'work/t/out/x.md']) expect(paths).not.toContain(p);
    const prot = r.skipped.filter((s) => s.reason === 'protected').map((s) => s.path);
    expect(prot).toEqual(expect.arrayContaining(['AGENTS.md', 'ORDER.md', 'CLAUDE.md', 'book.yaml', 'seed.md', 'instructions/AGENTS.md', 'notes/from-owner.md']));
    expect(r.skipped.some((s) => s.path.startsWith('.git') || s.path.startsWith('work/'))).toBe(false);
  });
  it('harness instruction files at any depth and in any case are protected (never collected)', async () => {
    const r = await run();
    const names = ['AGENTS.override.md', 'GEMINI.md', 'CLAUDE.local.md', 'manuscript/CLAUDE.md', 'notes/Agents.Override.md'];
    for (const p of names) expect(r.files.map((f) => f.path)).not.toContain(p);
    expect(r.skipped.filter((s) => s.reason === 'protected').map((s) => s.path)).toEqual(expect.arrayContaining(names));
  });
  it('published chapter path collected (frozen handling is the mapper\'s job)', async () => {
    const r = await run();
    expect(r.files.map((f) => f.path)).toContain('manuscript/c00001.md');
  });
  it('binary / non-UTF-8 / >1MB / symlink skipped with reason', async () => {
    const r = await run();
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { path: 'img.png', reason: 'binary' },
        { path: 'latin1.txt', reason: 'not_utf8' },
        { path: 'big.md', reason: 'too_large' },
        { path: 'link.md', reason: 'symlink' },
      ]),
    );
    for (const p of ['img.png', 'latin1.txt', 'big.md', 'link.md']) expect(r.files.map((f) => f.path)).not.toContain(p);
  });
  it('deletions ignored', async () => {
    const r = await run();
    expect(r.files.map((f) => f.path)).not.toContain('manuscript/c00002.md');
    expect(r.skipped.map((s) => s.path)).not.toContain('manuscript/c00002.md');
  });
  it('running twice is idempotent', async () => {
    const a = await run();
    await write(path.join(a.stagedDir), 'stray.md', '上次残留');
    const b = await run();
    expect(b.files).toEqual(a.files);
    expect(b.skipped).toEqual(a.skipped);
    await expect(fs.stat(path.join(b.stagedDir, 'stray.md'))).rejects.toThrow();
  });
  it('changes.json round-trips via readRunChanges', async () => {
    const r = await run();
    expect(r.manifestFile).toBe(path.join(live, 'work', 'task-1', 'run-run1', 'changes.json'));
    const back = await readRunChanges(r.manifestFile);
    const { manifestFile: _m, ...rest } = r;
    expect(back.changes).toEqual(rest);
    expect(back.changes.schema).toBe('nv.v3changes/1');
    expect(await back.read('scratch/c00004.md')).toBe('# 第4章\n\n写在 scratch 里。\n');
    await expect(back.read('../escape.md')).rejects.toThrow();
  });
  it('a read error during the walk fails the harvest and leaves the previous complete manifest untouched', async () => {
    const good = await run();
    const before = await fs.readFile(good.manifestFile, 'utf8');
    const real = fs.readdir.bind(fs);
    // 模拟快照在遍历中途消失：manuscript/ 读不到
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((p: string, o: unknown) => {
      if (String(p).endsWith(`${path.sep}manuscript`)) return Promise.reject(Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' }));
      return (real as (a: string, b: unknown) => Promise<unknown>)(p, o);
    }) as typeof fs.readdir);
    try {
      await expect(run()).rejects.toThrow('gone');
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(good.manifestFile, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(good.stagedDir, 'manuscript/c00003.md'), 'utf8')).toBe('# 第3章\n\n新的一章。\n');
    // 没有留下临时目录
    expect((await fs.readdir(path.join(live, 'work', 'task-1'))).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
  it('missing snapshot dir → empty change set', async () => {
    const r = await collectRunChanges({ snapshotDir: path.join(root, 'gone'), baseCommit: base, liveBookDir: live, taskId: 'task-2', runId: 'run2' });
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});
