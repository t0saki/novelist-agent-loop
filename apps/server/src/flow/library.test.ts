/** 开书任务单的书库摘要（p2-plan §2.3、§5.3、§6 WP-3 flow/library）。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { books } from '../db/schema.js';
import { createOrchTestEnv, type OrchTestEnv } from '../orchestrator/testing.js';
import { loadLibrary, parseTags, renderLibraryV3, topTags, type LibraryRow } from './library.js';

const row = (o: Partial<LibraryRow> & { title: string }): LibraryRow => ({ id: o.title, blurb: null, tags: [], genre: 'g', createdAt: '2026-11-01T00:00:00.000Z', ...o });

describe('parseTags', () => {
  it('splits on 、，, ; ； / | ｜, trims, drops empties, keeps the original text, first 8', () => {
    expect(parseTags('标签：a、b，c / d')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseTags('- 标签: 悬疑;；成长 | 校园｜ 群像 ,')).toEqual(['悬疑', '成长', '校园', '群像']);
    expect(parseTags('末世、 废土 、、 求生')).toEqual(['末世', '废土', '求生']);
    expect(parseTags('标签：1、2、3、4、5、6、7、8、9、10')).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(parseTags('标签：')).toEqual([]);
  });
});

describe('topTags', () => {
  it('counts verbatim (a tag once per book), count desc then string asc, first n', () => {
    const rows = [row({ title: 'a', tags: ['悬疑', '校园', '悬疑'] }), row({ title: 'b', tags: ['悬疑', '成长'] }), row({ title: 'c', tags: ['成长', '末世'] }), row({ title: 'd', tags: ['悬疑 '] })];
    expect(topTags(rows)).toEqual(['悬疑', '成长', '悬疑 ', '末世', '校园']);
    expect(topTags(rows, 2)).toEqual(['悬疑', '成长']);
    expect(topTags([])).toEqual([]);
  });
});

describe('renderLibraryV3', () => {
  it('both sections, blurb cut at 60 with …, tags only on same-genre rows, top tags line', () => {
    const long = '一'.repeat(61);
    const out = renderLibraryV3(
      {
        sameGenre: [row({ title: '雨夜来客', blurb: '邮差在暴雨夜收到寄给自己的信。', tags: ['悬疑', '都市'], createdAt: '2026-11-05T00:00:00.000Z' }), row({ title: '无名之书', createdAt: '2026-11-04T00:00:00.000Z' })],
        recent: [row({ title: '长简介', blurb: long, tags: ['悬疑'], genre: 'h', createdAt: '2026-11-06T00:00:00.000Z' })],
      },
      '都市悬疑',
    );
    expect(out).toBe(
      [
        '书库摘要（不要和这些书雷同）：',
        '同题材（都市悬疑）：',
        '- 《雨夜来客》：邮差在暴雨夜收到寄给自己的信。｜标签：悬疑、都市',
        '- 《无名之书》',
        '最近的书：',
        `- 《长简介》：${'一'.repeat(60)}…`,
        '近期用得最多的标签（这本尽量避开）：悬疑、都市',
        '',
      ].join('\n'),
    );
  });

  it('an empty section is left out with its heading; no tags → no tags line; both empty → ""', () => {
    expect(renderLibraryV3({ sameGenre: [], recent: [row({ title: '甲', blurb: '一句话' })] }, 'X')).toBe('书库摘要（不要和这些书雷同）：\n最近的书：\n- 《甲》：一句话\n');
    expect(renderLibraryV3({ sameGenre: [row({ title: '乙' })], recent: [] }, 'X')).toBe('书库摘要（不要和这些书雷同）：\n同题材（X）：\n- 《乙》\n');
    expect(renderLibraryV3({ sameGenre: [], recent: [] }, 'X')).toBe('');
  });
});

describe('loadLibrary (DB)', () => {
  let t: OrchTestEnv;
  beforeEach(async () => {
    t = await createOrchTestEnv();
  });
  afterEach(async () => {
    await t.close();
  });

  it('excludes self and placeholder titles; same genre newest first (cap 100); recent = 20 newest of other genres', async () => {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    const values: (typeof books.$inferInsert)[] = [
      { id: 'self', slug: 'self', title: '自己', genre: 'g', meta: {}, createdAt: at(500) },
      { id: 'ph1', slug: 'ph1', title: '待命名·abc', genre: 'g', meta: {}, createdAt: at(501) },
      { id: 'ph2', slug: 'ph2', title: '未命名·def', genre: 'h', meta: {}, createdAt: at(502) },
      { id: 'blank', slug: 'blank', title: ' ', genre: 'g', meta: {}, createdAt: at(503) },
    ];
    for (let i = 0; i < 105; i += 1) values.push({ id: `g${i}`, slug: `g${i}`, title: `同${i}`, genre: 'g', meta: { blurb: `简介${i}`, tags: ['悬疑', `t${i % 3}`] }, createdAt: at(i) });
    for (let i = 0; i < 25; i += 1) values.push({ id: `h${i}`, slug: `h${i}`, title: `异${i}`, genre: 'h', meta: {}, createdAt: at(200 + i) });
    await t.db.insert(books).values(values);
    const lib = await loadLibrary(t.db, 'self', 'g');
    expect(lib.sameGenre).toHaveLength(100);
    expect(lib.sameGenre[0]).toMatchObject({ id: 'g104', title: '同104', blurb: '简介104', tags: ['悬疑', 't2'], genre: 'g' });
    expect(lib.sameGenre.some((r) => ['self', 'ph1', 'blank'].includes(r.id))).toBe(false);
    expect(lib.recent).toHaveLength(20);
    expect(lib.recent[0]?.id).toBe('h24');
    expect(lib.recent.every((r) => r.genre === 'h')).toBe(true);
    expect(lib.recent.some((r) => r.id === 'ph2')).toBe(false);
  });
});
