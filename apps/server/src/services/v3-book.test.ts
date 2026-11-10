/** v3 书的主人操作：给作者的话、草稿采用 / 收起（p2-plan §2.5b、§3.2、§6 services/v3-book.test）。 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countCjk } from '@novelist/shared';
import { gitBlobSha, openRepo, P, type BookRepo } from '../book/index.js';
import { bookDir } from '../api/helpers.js';
import { books, chapters, tasks } from '../db/schema.js';
import { readV3Meta } from '../flow/state.js';
import { chapterText, prose } from '../flow/testing.js';
import { commitOwnerEdit } from '../orchestrator/index.js';
import { createTestApp, TEST_ADMIN_PASSWORD, type TestApp } from '../testing.js';
import { createBook, reindexBook } from './books.js';
import { saveRepoFile } from './repo-files.js';
import { adoptDraft, classifyDraft, discardDraft, listDrafts, setOwnerMessage } from './v3-book.js';

let t: TestApp;
let cookie: string;

const admin = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const rowOf = async (slug: string) => (await t.deps.db.select().from(books).where(eq(books.slug, slug)))[0]!;
const repoOf = (slug: string): BookRepo => openRepo(bookDir(t.deps, slug));
const metaOf = async (slug: string) => readV3Meta((await rowOf(slug)).meta);
const code = async (p: Promise<unknown>): Promise<[number, string]> =>
  p.then(
    () => [200, 'ok'],
    (e: { status?: number; code?: string }) => [e.status ?? 0, e.code ?? ''],
  );

/** v3 书，n 章（主人提交 + reindex），外加 files */
async function v3Book(slug: string, n: number, files: Record<string, string> = {}): Promise<void> {
  await createBook(t.deps, { title: slug, slug, genre: 'xianxia', flow: 'v3', start: false });
  const row = await rowOf(slug);
  const all = [...Array.from({ length: n }, (_, i) => ({ path: P.manuscript(i + 1), content: chapterText(i + 1, 1500) })), ...Object.entries(files).map(([path, content]) => ({ path, content }))];
  await commitOwnerEdit(t.deps.db, repoOf(slug), row.id, { files: all, message: 'test: fixture', baseSha: null });
  await reindexBook(t.deps, slug);
  await t.deps.db.update(books).set({ status: 'active' }).where(eq(books.id, row.id));
}

beforeAll(async () => {
  t = await createTestApp();
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(r.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('setOwnerMessage', () => {
  it('writes notes/from-owner.md and meta.ownerMessage; replacing an unread message archives it (replaced); withdraw archives (withdrawn) and clears; withdraw with nothing → 400', async () => {
    await v3Book('msg', 2);
    const repo = repoOf('msg');
    const r = await setOwnerMessage(t.deps, await rowOf('msg'), '多写对话，少写景。  ');
    expect(r).toEqual({ ok: true, detail: '已存好，下一次写作会先读这段话。' });
    expect(await repo.readFile('notes/from-owner.md')).toBe('多写对话，少写景。\n');
    let m = await metaOf('msg');
    expect(m.ownerMessage).toMatchObject({ text: '多写对话，少写景。', sha: gitBlobSha('多写对话，少写景。\n'), status: 'waiting', readIn: null });
    const firstId = m.ownerMessage?.id;
    // 替换没读过的留言：旧的归档
    await setOwnerMessage(t.deps, await rowOf('msg'), '主角要更狠一点。');
    m = await metaOf('msg');
    expect(m.ownerMessage?.text).toBe('主角要更狠一点。');
    expect(m.ownerMessages[0]).toMatchObject({ id: firstId, status: 'replaced' });
    const replacedPath = m.ownerMessages[0]?.archivedPath as string;
    expect(replacedPath).toMatch(/^notes\/archive\/from-owner\/\d{8}-\d{4}-replaced\.md$/);
    expect(await repo.readFile(replacedPath)).toBe('多写对话，少写景。\n');
    // 撤回
    const w = await setOwnerMessage(t.deps, await rowOf('msg'), '   ');
    expect(w.ok).toBe(true);
    m = await metaOf('msg');
    expect(m.ownerMessage).toBeNull();
    expect(m.ownerMessages.map((x) => x.status)).toEqual(['withdrawn', 'replaced']);
    expect(await repo.readFile(m.ownerMessages[0]?.archivedPath as string)).toBe('主角要更狠一点。\n');
    expect(await repo.readFile('notes/from-owner.md')).toBe('');
    expect(await code(setOwnerMessage(t.deps, await rowOf('msg'), ''))).toEqual([400, 'nothing_to_withdraw']);
  });

  it('completed or archived book → 409 v3_finished', async () => {
    await v3Book('msgdone', 1);
    for (const status of ['completed', 'archived']) {
      await t.deps.db.update(books).set({ status }).where(eq(books.slug, 'msgdone'));
      expect(await code(setOwnerMessage(t.deps, await rowOf('msgdone'), '再改改')), status).toEqual([409, 'v3_finished']);
    }
  });

  it('PUT file notes/from-owner.md goes through setOwnerMessage (one-time semantics from any editor)', async () => {
    await v3Book('msgfile', 1);
    const res = await admin('PUT', '/api/admin/books/msgfile/file', { path: 'notes/from-owner.md', content: '从文件编辑器写的话', baseSha: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe('从文件编辑器写的话\n');
    expect((await metaOf('msgfile')).ownerMessage).toMatchObject({ text: '从文件编辑器写的话', status: 'waiting' });
    await saveRepoFile(t.deps, await rowOf('msgfile'), { path: 'notes/from-owner.md', content: '', baseSha: null, confirm: false });
    expect((await metaOf('msgfile')).ownerMessage).toBeNull();
    expect((await metaOf('msgfile')).ownerMessages[0]?.status).toBe('withdrawn');
  });
});

describe('classifyDraft', () => {
  it.each([
    ['drafts/c00007.md', 'unfinished', 7, 'manuscript/c00007.md', false],
    ['drafts/c00004.rewrite.md', 'rewrite', 4, 'manuscript/c00004.md', false],
    ['drafts/c00004.rewrite-2.md', 'rewrite', 4, 'manuscript/c00004.md', false],
    ['drafts/c00006.dup.md', 'dup', 6, 'manuscript/c00006.md', false],
    ['drafts/c00006.pre.md', 'pre', 6, 'manuscript/c00006.md', false],
    ['drafts/c00003.retro.md', 'retro', 3, 'manuscript/c00003.md', false],
    ['drafts/c00003.retro-2.md', 'retro', 3, 'manuscript/c00003.md', false],
    ['drafts/c00005.discarded.md', 'rewrite', 5, 'manuscript/c00005.md', false],
    ['drafts/rewound-20261110T083000/c00009.md', 'rewound', 9, 'manuscript/c00009.md', false],
    ['drafts/replaced/20261110T083000/c00002.md', 'replaced', 2, 'manuscript/c00002.md', false],
    ['drafts/owner-conflicts/manuscript/c00007.md', 'owner_conflict', 7, 'manuscript/c00007.md', false],
    ['drafts/owner-conflicts/notes/cast.md', 'owner_conflict', null, 'notes/cast.md', false],
    ['drafts/adopted/c00004.rewrite-20261110T083000.md', 'other', 4, null, true],
    ['drafts/discarded/c00007.md', 'other', 7, null, true],
    ['drafts/retro/notes.md', 'other', null, null, false],
    ['drafts/scratch.md', 'other', null, null, false],
  ])('%s → %s', (rel, kind, chapter, target, handled) => {
    expect(classifyDraft(rel)).toEqual({ kind, chapter, target, handled });
  });
});

describe('drafts: list, adopt, discard', () => {
  const body = (no: number, seed: number) => `# 第${no}章 新名${no}\n\n${prose(1800, seed)}\n`;

  it('listDrafts: adoptable for publishedThrough < k ≤ accepted+1 chapter drafts and story-file owner conflicts; false with each reason', async () => {
    await v3Book('ls', 5, {
      'drafts/c00002.rewrite.md': body(2, 1),
      'drafts/c00004.rewrite.md': body(4, 2),
      'drafts/c00006.md': body(6, 3),
      'drafts/c00008.md': body(8, 4),
      'drafts/owner-conflicts/notes/cast.md': '人物\n',
      'drafts/owner-conflicts/seed.md': 'x\n',
      'drafts/adopted/c00003-20261110T000000.md': body(3, 5),
      'drafts/scratch.md': '随手记\n',
    });
    await t.deps.db.update(books).set({ publishedThrough: 2 }).where(eq(books.slug, 'ls'));
    const rows = await listDrafts(t.deps, await rowOf('ls'));
    const by = Object.fromEntries(rows.map((r) => [r.path, [r.adoptable, r.reason]]));
    expect(by).toEqual({
      'drafts/c00002.rewrite.md': [false, '已发布，只能直接改'],
      'drafts/c00004.rewrite.md': [true, null],
      'drafts/c00006.md': [true, null],
      'drafts/c00008.md': [false, '先采用第 6 章'],
      'drafts/owner-conflicts/notes/cast.md': [true, null],
      'drafts/owner-conflicts/seed.md': [false, '不是章节或已知笔记文件'],
      'drafts/adopted/c00003-20261110T000000.md': [false, '已处理'],
      'drafts/scratch.md': [false, '不是章节或已知笔记文件'],
    });
    expect(rows.every((r) => r.size > 0)).toBe(true);
  });

  it('adopt a rewrite draft of an unpublished chapter → manuscript replaced, old version in drafts/replaced/<ts>/, row title/cjk, totalCjk, locked, draft moved to drafts/adopted/', async () => {
    const draft = body(3, 11);
    await v3Book('ad', 4, { 'drafts/c00003.rewrite.md': draft });
    const repo = repoOf('ad');
    const before = await rowOf('ad');
    const old = (await repo.readFile(P.manuscript(3)))!;
    const prev = (await t.deps.db.select().from(chapters).where(eq(chapters.bookId, before.id))).find((c) => c.no === 3)!;
    const r = await adoptDraft(t.deps, before, 'drafts/c00003.rewrite.md');
    expect(r).toEqual({ ok: true, detail: '已采用：第 3 章（原来的版本在 drafts/replaced/）' });
    expect(await repo.readFile(P.manuscript(3))).toBe(draft);
    const all = await repo.list('drafts', { recursive: true });
    const replaced = all.find((p) => /^drafts\/replaced\/\d{8}T\d{6}\/c00003\.md$/.test(p))!;
    expect(await repo.readFile(replaced)).toBe(old);
    expect(all).not.toContain('drafts/c00003.rewrite.md');
    expect(all.some((p) => /^drafts\/adopted\/c00003\.rewrite-\d{8}T\d{6}\.md$/.test(p))).toBe(true);
    const ch = (await t.deps.db.select().from(chapters).where(eq(chapters.bookId, before.id))).find((c) => c.no === 3)!;
    expect(ch).toMatchObject({ title: '新名3', cjk: countCjk(prose(1800, 11)) });
    const after = await rowOf('ad');
    expect(after.totalCjk).toBe(before.totalCjk - (prev.cjk ?? 0) + countCjk(prose(1800, 11)));
    expect(after.headCommit).toBe(await repo.head());
    expect(readV3Meta(after.meta).locked).toContain(3);
    expect(await repo.isClean()).toBe(true);
  });

  it('adopt over a locked (owner-edited) chapter → the owner version goes to drafts/replaced/', async () => {
    await v3Book('adl', 3, { 'drafts/c00002.rewrite.md': body(2, 21) });
    const repo = repoOf('adl');
    const res = await admin('PUT', '/api/admin/books/adl/chapters/2/text', { text: `# 第2章 主人版\n\n${prose(1500, 22)}\n`, baseSha: gitBlobSha((await repo.readFile(P.manuscript(2)))!) });
    expect(res.statusCode).toBe(200);
    expect((await metaOf('adl')).locked).toEqual([2]);
    await adoptDraft(t.deps, await rowOf('adl'), 'drafts/c00002.rewrite.md');
    const replaced = (await repo.list('drafts', { recursive: true })).find((p) => p.startsWith('drafts/replaced/'))!;
    expect(await repo.readFile(replaced)).toContain('# 第2章 主人版');
    expect((await metaOf('adl')).locked).toEqual([2]);
  });

  it('adopt a published chapter → 409; adopt racing a publish of k (publish first) → 409, nothing committed', async () => {
    await v3Book('adp', 4, { 'drafts/c00001.rewrite.md': body(1, 31), 'drafts/c00003.rewrite.md': body(3, 32) });
    await t.deps.db.update(books).set({ publishedThrough: 1 }).where(eq(books.slug, 'adp'));
    expect(await code(adoptDraft(t.deps, await rowOf('adp'), 'drafts/c00001.rewrite.md'))).toEqual([409, 'published']);
    // 调用方手里的 row 还是发布前的；锁内重读看到第 3 章已发布
    const stale = await rowOf('adp');
    await t.deps.db.update(books).set({ publishedThrough: 3 }).where(eq(books.slug, 'adp'));
    const head = await repoOf('adp').head();
    expect(await code(adoptDraft(t.deps, stale, 'drafts/c00003.rewrite.md'))).toEqual([409, 'published']);
    expect(await repoOf('adp').head()).toBe(head);
  });

  it('adopt an unfinished draft k = accepted+1 → accepted with tag ch/k, acceptedThrough k, batchLog adopt, unfinished hint removed', async () => {
    const draft = body(4, 41);
    await v3Book('adn', 3, { 'drafts/c00004.md': draft });
    const row = await rowOf('adn');
    const m = readV3Meta(row.meta);
    await t.deps.db
      .update(books)
      .set({ meta: { ...(row.meta as object), v3: { ...m, hints: [{ kind: 'unfinished', chapter: 4, sticky: true, text: '第 4 章没写完', at: '2026-11-10T00:00:00.000Z' }, { kind: 'short', chapter: 2, text: '补', at: '2026-11-10T00:00:00.000Z' }] } } })
      .where(eq(books.id, row.id));
    const oldHead = await repoOf('adn').head();
    const r = await adoptDraft(t.deps, await rowOf('adn'), 'drafts/c00004.md');
    expect(r.detail).toBe('已采用为第 4 章');
    const repo = repoOf('adn');
    expect(await repo.readFile(P.manuscript(4))).toBe(draft);
    expect(await repo.tags('ch/*')).toEqual(['ch/00004']);
    const after = await rowOf('adn');
    expect(after).toMatchObject({ acceptedThrough: 4, cursor: 5, totalCjk: row.totalCjk + countCjk(prose(1800, 41)) });
    const am = readV3Meta(after.meta);
    expect(am.batchLog).toEqual([{ runId: null, kind: 'adopt', from: 4, to: 4, baseCommit: oldHead, finalCommit: await repo.head(), at: expect.any(String) }]);
    expect(am.hints.map((h) => h.kind)).toEqual(['short']);
    expect(am.locked).toContain(4);
    const ch = (await t.deps.db.select().from(chapters).where(eq(chapters.bookId, row.id))).find((c) => c.no === 4)!;
    expect(ch).toMatchObject({ state: 'accepted', title: '新名4', acceptedCommit: await repo.head() });
  });

  it('adopt k = accepted+1 while busy → 409 v3_busy; truncated → 409 draft_truncated; k > accepted+1 → 409', async () => {
    await v3Book('adb', 3, { 'drafts/c00004.md': body(4, 51), 'drafts/c00004.dup.md': `# 第4章\n\n${prose(1800, 52).replace(/。$/, '')}他转身走向` , 'drafts/c00006.md': body(6, 53) });
    const row = await rowOf('adb');
    await t.deps.db.insert(tasks).values({ id: 'busy-adb', bookId: row.id, kind: 'book.write', target: 'batch-c00004', lane: 'write', state: 'running', params: {} });
    expect(await code(adoptDraft(t.deps, row, 'drafts/c00004.md'))).toEqual([409, 'v3_busy']);
    await t.deps.db.update(tasks).set({ state: 'done' }).where(eq(tasks.id, 'busy-adb'));
    expect(await code(adoptDraft(t.deps, row, 'drafts/c00004.dup.md'))).toEqual([409, 'draft_truncated']);
    expect(await code(adoptDraft(t.deps, row, 'drafts/c00006.md'))).toEqual([409, 'not_adoptable']);
    expect((await rowOf('adb')).acceptedThrough).toBe(3);
  });

  it('adopt while a rewind is claimed (meta.v3.rewinding) → 409 v3_busy for a new chapter, a replacement and a story file; nothing committed', async () => {
    await v3Book('adrw', 3, { 'drafts/c00004.md': body(4, 61), 'drafts/c00002.rewrite.md': body(2, 62), 'drafts/owner-conflicts/notes/cast.md': '# 人物\n- 甲\n' });
    const row = await rowOf('adrw');
    await t.deps.db.update(books).set({ meta: { ...(row.meta as object), v3: { ...readV3Meta(row.meta), rewinding: { to: 1, ts: '20261110T000000', at: new Date().toISOString() } } } }).where(eq(books.id, row.id));
    const head = await repoOf('adrw').head();
    for (const rel of ['drafts/c00004.md', 'drafts/c00002.rewrite.md', 'drafts/owner-conflicts/notes/cast.md']) expect(await code(adoptDraft(t.deps, await rowOf('adrw'), rel)), rel).toEqual([409, 'v3_busy']);
    expect(await repoOf('adrw').head()).toBe(head);
    expect((await rowOf('adrw')).acceptedThrough).toBe(3);
  });

  it('adopting over a chapter with a waiting owner rewrite request drops the request (the owner decided); so does a direct edit', async () => {
    await v3Book('adq', 4, { 'drafts/c00003.rewrite.md': body(3, 71) });
    const req = (id: string, chapter: number) => ({ id, kind: 'rewrite' as const, chapter, note: '改', at: '2026-11-10T00:00:00.000Z', status: 'waiting' as const });
    const row = await rowOf('adq');
    await t.deps.db.update(books).set({ meta: { ...(row.meta as object), v3: { ...readV3Meta(row.meta), ownerRequests: [req('q3', 3), req('q2', 2)] } } }).where(eq(books.id, row.id));
    await adoptDraft(t.deps, await rowOf('adq'), 'drafts/c00003.rewrite.md');
    expect((await metaOf('adq')).ownerRequests.map((r) => [r.id, r.status])).toEqual([
      ['q3', 'dropped'],
      ['q2', 'waiting'],
    ]);
    // 主人直接改第 2 章（lockChapter）：第 2 章的请求也作废，并锁定
    const repo = repoOf('adq');
    const res = await admin('PUT', '/api/admin/books/adq/chapters/2/text', { text: `# 第2章 主人版\n\n${prose(1500, 72)}\n`, baseSha: gitBlobSha((await repo.readFile(P.manuscript(2)))!) });
    expect(res.statusCode).toBe(200);
    const m = await metaOf('adq');
    expect(m.ownerRequests.find((r) => r.id === 'q2')?.status).toBe('dropped');
    expect(m.locked).toEqual(expect.arrayContaining([2, 3]));
  });

  it('adopt an owner-conflict notes file → restored, current version in drafts/replaced/', async () => {
    await v3Book('adc', 2, { 'notes/cast.md': '现在的人物表\n', 'drafts/owner-conflicts/notes/cast.md': '作者写的人物表\n' });
    const r = await adoptDraft(t.deps, await rowOf('adc'), 'drafts/owner-conflicts/notes/cast.md');
    expect(r.detail).toBe('已恢复 notes/cast.md');
    const repo = repoOf('adc');
    expect(await repo.readFile('notes/cast.md')).toBe('作者写的人物表\n');
    const all = await repo.list('drafts', { recursive: true });
    expect(await repo.readFile(all.find((p) => /^drafts\/replaced\/[^/]+\/notes\/cast\.md$/.test(p))!)).toBe('现在的人物表\n');
    expect(all).not.toContain('drafts/owner-conflicts/notes/cast.md');
    expect(all.some((p) => p.startsWith('drafts/adopted/cast-'))).toBe(true);
  });

  it('discard moves to drafts/discarded/; discarding a handled draft → 400', async () => {
    await v3Book('dis', 2, { 'drafts/c00003.md': body(3, 61) });
    const r = await discardDraft(t.deps, await rowOf('dis'), 'drafts/c00003.md');
    expect(r).toEqual({ ok: true, detail: '已收起（移到 drafts/discarded/）' });
    const repo = repoOf('dis');
    expect(await repo.exists('drafts/c00003.md')).toBe(false);
    expect(await repo.readFile('drafts/discarded/c00003.md')).toBe(body(3, 61));
    expect(await code(discardDraft(t.deps, await rowOf('dis'), 'drafts/discarded/c00003.md'))).toEqual([400, 'draft_handled']);
  });
});
