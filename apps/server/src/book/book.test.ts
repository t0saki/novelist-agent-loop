import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE,
  NothingToCommitError,
  P,
  TRAILER,
  bookFiles,
  createFixtureBook,
  createRunSnapshot,
  ensureGitRepo,
  formatFrontmatter,
  formatTrailers,
  gitBlobSha,
  harvestOut,
  initBookRepo,
  openRepo,
  parseFrontmatter,
  parseTrailers,
  pathOwner,
  pruneWorktrees,
  removeRunSnapshot,
} from './index.js';
import { CanonicalParseError } from './canonical.js';

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-book-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('trailers', () => {
  it('formats known keys first and round-trips', () => {
    const t = formatTrailers({ Zeta: 'z', [TRAILER.run]: 'r1', [TRAILER.task]: 't1', [TRAILER.model]: 'm\nx' });
    expect(t.split('\n')).toEqual(['Novelist-Task: t1', 'Novelist-Run: r1', 'Novelist-Model: m x', 'Zeta: z']);
    expect(parseTrailers(`subject\n\nbody text\n\n${t}\n`)).toEqual({ 'Novelist-Task': 't1', 'Novelist-Run': 'r1', 'Novelist-Model': 'm x', Zeta: 'z' });
  });
  it('ignores non-trailer last paragraphs and subject-only messages', () => {
    expect(parseTrailers('Novelist-Task: x')).toEqual({});
    expect(parseTrailers('subj\n\nnot a trailer line\nKey: v')).toEqual({});
  });
});

describe('pathOwner', () => {
  it('classifies paths', () => {
    expect(pathOwner('views/cast.md')).toBe('derived');
    expect(pathOwner('work/t/attempt-1/out/x.md')).toBe('derived');
    expect(pathOwner('state/snapshot.json')).toBe('derived');
    expect(pathOwner('AGENTS.md')).toBe('generated');
    expect(pathOwner('.agents/skills/a/SKILL.md')).toBe('generated');
    expect(pathOwner('instructions/AGENTS.md')).toBe('user');
    expect(pathOwner('book.yaml')).toBe('user');
    expect(pathOwner('style/voice.md')).toBe('user');
    expect(pathOwner('state/ledger/c00001.json')).toBe('canonical');
    expect(pathOwner('plan/cards/c00001.yaml')).toBe('canonical');
    expect(pathOwner('manuscript/c00001.md')).toBe('canonical');
  });
});

describe('frontmatter', () => {
  it('round-trips', () => {
    const md = formatFrontmatter({ id: 'char.a', name: '甲' }, '正文\n');
    const p = parseFrontmatter(md);
    expect(p.data).toEqual({ id: 'char.a', name: '甲' });
    expect(p.body).toBe('正文\n');
    expect(parseFrontmatter('无 frontmatter').data).toBeNull();
  });
});

describe('repo', () => {
  it('initBookRepo writes layout, symlink and first commit', async () => {
    const dir = path.join(tmp, 'init');
    const { repo, commit } = await initBookRepo(dir, { config: { slug: 'demo', title: '演示', genre: 'xianxia', tier: 'lite' }, premise: '种子\n原样' });
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.readFile(P.premise)).toBe('种子\n原样');
    const yaml = (await repo.readFile(P.bookYaml)) ?? '';
    expect(yaml).toContain('schema: nv.book/1');
    expect(yaml).toContain('tier: lite');
    expect(yaml).not.toContain('publish'); // 默认值不固化
    expect(await repo.readFile(P.gitignore)).toBe('work/\n.index/\n.cache/\nviews/\nstate/snapshot.json\n');
    expect(await fs.readlink(path.join(dir, '.claude/skills'))).toBe('../.agents/skills');
    const log = await repo.log({ limit: 5 });
    expect(log.items[0]?.trailers[TRAILER.task]).toBe('book.init');
    expect(await repo.isClean()).toBe(true);
    await expect(initBookRepo(dir, { config: { slug: 'demo', title: 'x', genre: 'g' }, premise: '' })).rejects.toThrow(/not empty/);
  });

  it('向导写入的 scale 区间是行内序列（设置页表单按单行读写）', async () => {
    const dir = path.join(tmp, 'scale');
    const { repo } = await initBookRepo(dir, { config: { slug: 'scaled', title: '规模', genre: 'xianxia', scale: { target_cjk: 1000, hard_max_cjk: 2000, volumes: [3, 5], chapters_per_volume: [10, 12] } }, premise: 'p' });
    const yaml = (await repo.readFile(P.bookYaml)) ?? '';
    expect(yaml).toContain('volumes: [ 3, 5 ]');
    expect(yaml).toContain('chapters_per_volume: [ 10, 12 ]');
  });

  it('commit / read at rev / blobShas / tags / trailers / log paging / reset', async () => {
    const dir = path.join(tmp, 'ops');
    const { repo } = await initBookRepo(dir, { config: { slug: 'ops', title: 'ops', genre: 'xianxia' }, premise: 'p' });
    const c0 = await repo.head();
    await repo.writeFiles([{ path: 'manuscript/c00001.md', content: '第一版' }]);
    const c1 = await repo.commit({ message: 'ch1', trailers: { [TRAILER.task]: 'task-1' }, tags: ['ch/00001'] });
    await repo.writeFiles([
      { path: 'manuscript/c00001.md', content: '第二版' },
      { path: 'notes/inbox.md', content: 'n' },
    ]);
    const c2 = await repo.commit({ message: 'ch1 v2', trailers: { [TRAILER.task]: 'task-10' }, paths: ['manuscript/c00001.md'] });
    expect(await repo.readFile('manuscript/c00001.md', c1)).toBe('第一版');
    expect(await repo.readFile('manuscript/c00001.md')).toBe('第二版');
    expect(await repo.readFile('missing.md', c1)).toBeNull();
    expect(await repo.exists('manuscript/c00001.md', c0)).toBe(false);
    expect(await repo.exists('manuscript/c00001.md', c1)).toBe(true);
    const shas = await repo.blobShas(['manuscript/c00001.md', 'nope'], c2);
    expect(shas['manuscript/c00001.md']).toBe(gitBlobSha('第二版'));
    expect(shas.nope).toBe('');
    const wt = await repo.blobShas(['manuscript/c00001.md', 'nope']);
    expect(wt['manuscript/c00001.md']).toBe(gitBlobSha('第二版'));
    expect(wt.nope).toBe('');
    expect(await repo.tags('ch/*')).toEqual(['ch/00001']);
    expect(await repo.findCommitByTrailer(TRAILER.task, 'task-1')).toBe(c1);
    expect(await repo.findCommitByTrailer(TRAILER.task, 'task-10')).toBe(c2);
    expect(await repo.findCommitByTrailer(TRAILER.task, 'task-2')).toBeNull();
    expect(await repo.changedPaths(c1, c2)).toEqual(['manuscript/c00001.md']);
    expect(await repo.list('manuscript', { rev: c2 })).toEqual(['manuscript/c00001.md']);
    expect(await repo.list('', { rev: c2 })).toContain('manuscript/');
    const p1 = await repo.log({ limit: 1 });
    expect(p1.items[0]?.sha).toBe(c2);
    expect(p1.nextCursor).toBe(c2);
    const p2 = await repo.log({ limit: 1, cursor: p1.nextCursor as string });
    expect(p2.items[0]?.sha).toBe(c1);
    expect(p2.items[0]?.tags).toEqual(['ch/00001']);
    // notes/inbox.md 未提交 → 不干净；resetHard 清掉未跟踪文件但保留 work/
    expect(await repo.isClean()).toBe(false);
    await fs.mkdir(path.join(dir, 'work/t1'), { recursive: true });
    await fs.writeFile(path.join(dir, 'work/t1/keep.txt'), 'k');
    await repo.resetHard();
    expect(await repo.isClean()).toBe(true);
    expect(await repo.exists('notes/inbox.md')).toBe(false);
    expect(await fs.readFile(path.join(dir, 'work/t1/keep.txt'), 'utf8')).toBe('k');
    await expect(repo.commit({ message: 'empty', trailers: {} })).rejects.toBeInstanceOf(NothingToCommitError);
    expect((await repo.fsck()).ok).toBe(true);
  });

  it('rejects paths escaping the repo', async () => {
    const repo = openRepo(path.join(tmp, 'ops'));
    await expect(repo.writeFiles([{ path: '../evil.txt', content: 'x' }])).rejects.toThrow(/escapes/);
    await expect(repo.readFile('/etc/passwd')).rejects.toThrow(/invalid/);
  });

  it('ensureGitRepo is idempotent', async () => {
    const dir = path.join(tmp, 'global');
    await ensureGitRepo(dir);
    const h = await openRepo(dir).head();
    expect(h).toMatch(/^[0-9a-f]{40}$/);
    await ensureGitRepo(dir);
    expect(await openRepo(dir).head()).toBe(h);
  });
});

describe('fixture + canonical files', () => {
  it('createFixtureBook yields a valid typed book', async () => {
    const dir = path.join(tmp, 'fx');
    const { repo, head } = await createFixtureBook(dir, { accepted: 3, cards: 6 });
    expect(head).toBe(await repo.head());
    expect(await repo.tags('ch/*')).toEqual(['ch/00001', 'ch/00002', 'ch/00003']);
    const f = bookFiles(repo);
    const { config } = await f.config();
    expect(config.genre).toBe('xianxia');
    expect(config.tier).toBe('standard');
    expect((await f.entities()).map((e) => e.entity.id).sort()).toEqual(['char.lin-feng', 'char.su-wan', 'loc.qingyun']);
    expect((await f.cards(2, 4)).map((c) => c.id)).toEqual(['c00002', 'c00003', 'c00004']);
    expect((await f.card(3))?.notes).toBe('这一章节奏放慢。');
    expect((await f.ledger()).map((d) => d.chapter)).toEqual(['c00001', 'c00002', 'c00003']);
    expect((await f.ledger(2)).length).toBe(2);
    // 按 rev 读：第一章验收之后的提交里只有 1 章账本
    const log = await repo.log({ limit: 10 });
    const ch1 = log.items.find((c) => c.tags.includes('ch/00001'))?.sha as string;
    expect((await f.ledger(undefined, ch1)).length).toBe(1);
    expect((await f.world())?.vocab.conditions.map((c) => c.id)).toContain(FIXTURE.conds.armFracture);
    expect((await f.secrets())[0]?.secret.leak_signatures.length).toBeGreaterThan(0);
    expect(await f.overrides()).toEqual([]);
    expect(await f.manuscript(1)).toContain('林枫把那枚铜牌收进袖中');
    expect(await f.compass()).not.toBeNull();
    expect((await f.volumes()).map((v) => v.id)).toEqual(['v01']);
    expect((await f.arcs()).map((a) => a.id)).toEqual(['a0001']);
    expect(await f.premise()).toContain('林枫');
    // 坏文件 → CanonicalParseError
    await repo.writeFiles([{ path: P.card(9), content: 'schema: nv.card/1\nid: c00009\n' }]);
    await expect(f.card(9)).rejects.toBeInstanceOf(CanonicalParseError);
    await repo.writeFiles([{ path: P.card(9), content: null }]);
  });
});

describe('git isolation and commit paths', () => {
  it('ignores inherited GIT_DIR, tolerates never-tracked deletions, treats paths literally', async () => {
    const dir = path.join(tmp, 'iso');
    await createFixtureBook(dir, { accepted: 1, cards: 2 });
    const repo = openRepo(dir);
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(tmp, 'no-such-repo');
    try {
      expect(await repo.head()).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    // 只删一个从未入库的文件 → 没东西可提交（而不是 pathspec 报错）
    await repo.writeFiles([{ path: 'notes/never.md', content: null }]);
    await expect(repo.commit({ message: 'x', trailers: {}, paths: ['notes/never.md'] })).rejects.toBeInstanceOf(NothingToCommitError);
    // 混合：一个新文件 + 一个从未入库的删除
    await repo.writeFiles([{ path: 'notes/a.md', content: 'a' }]);
    await repo.commit({ message: 'a', trailers: {}, paths: ['notes/a.md', 'notes/never.md'] });
    // 已入库文件的删除仍然进提交
    await repo.writeFiles([{ path: 'notes/a.md', content: null }]);
    await repo.commit({ message: 'rm a', trailers: {}, paths: ['notes/a.md'] });
    expect(await repo.exists('notes/a.md', 'HEAD')).toBe(false);
    // glob 字符按字面量：[x].md 不能连带提交 x.md
    await repo.writeFiles([
      { path: 'style/samples/[x].md', content: '1' },
      { path: 'style/samples/x.md', content: '2' },
    ]);
    await repo.commit({ message: 'lit', trailers: {}, paths: ['style/samples/[x].md'] });
    expect(await repo.exists('style/samples/[x].md', 'HEAD')).toBe(true);
    expect(await repo.exists('style/samples/x.md', 'HEAD')).toBe(false);
  });

  it('finds a trailer behind many prefix-colliding commits', async () => {
    const dir = path.join(tmp, 'grep');
    await createFixtureBook(dir, { accepted: 1, cards: 1 });
    const repo = openRepo(dir);
    const target = await repo.commit({ message: 't', trailers: { [TRAILER.task]: 'task-1' }, allowEmpty: true });
    for (let i = 0; i < 55; i++) await repo.commit({ message: 'n', trailers: { [TRAILER.task]: `task-1${i}` }, allowEmpty: true });
    expect(await repo.findCommitByTrailer(TRAILER.task, 'task-1')).toBe(target);
  }, 60_000);
});

describe('run snapshot', () => {
  it('creates a detached worktree at base, discards stray writes, harvests only regular files', async () => {
    const dir = path.join(tmp, 'fx');
    const repo = openRepo(dir);
    const base = await repo.head();
    const runDir = path.join(tmp, 'runs', 'r1');
    const snap = await createRunSnapshot(dir, base, path.join(runDir, 'book'));
    expect(await fs.readFile(path.join(snap.dir, P.manuscript(1)), 'utf8')).toContain('铜牌');
    // 越界写：改快照里的规范文件
    await fs.writeFile(path.join(snap.dir, P.manuscript(1)), 'stray');
    const out = path.join(snap.dir, 'work/t-1/attempt-1/out');
    await fs.mkdir(path.join(out, 'sub'), { recursive: true });
    await fs.writeFile(path.join(out, 'receipt.json'), '{}');
    await fs.writeFile(path.join(out, 'sub/draft.md'), '草稿');
    await fs.symlink('/etc/passwd', path.join(out, 'evil'));
    const h = await harvestOut(out, dir, 't-1', 1);
    expect(h.files).toEqual(['receipt.json', 'sub/draft.md']);
    expect(h.stagedDir).toBe(path.join(dir, 'work/t-1/attempt-1/out'));
    expect(await fs.readFile(path.join(h.stagedDir, 'sub/draft.md'), 'utf8')).toBe('草稿');
    await removeRunSnapshot(snap);
    await expect(fs.stat(snap.dir)).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, P.manuscript(1)), 'utf8')).toContain('铜牌');
    expect(await repo.isClean()).toBe(true); // work/ 被忽略
    await pruneWorktrees(dir);
    // 重建同一路径（重试）可以成功
    const again = await createRunSnapshot(dir, base, path.join(runDir, 'book'));
    await removeRunSnapshot(again);
  });

  it('recovers when the run dir vanished but the worktree is still registered', async () => {
    const dir = path.join(tmp, 'fx');
    const base = await openRepo(dir).head();
    const dest = path.join(tmp, 'runs', 'r-gone', 'book');
    await createRunSnapshot(dir, base, dest);
    await fs.rm(path.join(tmp, 'runs', 'r-gone'), { recursive: true, force: true });
    const again = await createRunSnapshot(dir, base, dest);
    expect(await fs.readFile(path.join(again.dir, P.manuscript(1)), 'utf8')).toContain('铜牌');
    await removeRunSnapshot(again);
  });

  it('refuses to harvest when out/ itself is a symlink', async () => {
    const dir = path.join(tmp, 'fx');
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
    const link = path.join(tmp, 'link-out');
    await fs.symlink(outside, link);
    const h = await harvestOut(link, dir, 't-link', 1);
    expect(h.files).toEqual([]);
  });
});
