/** CLI（P3 WP-3）：book new 的新请求体；routing check、migrate-book 已删除。不连数据库的用例。 */
import { describe, expect, it, vi } from 'vitest';
import { main, newBookBody } from './cli.js';

describe('cli', () => {
  it('book new builds { genre, length, idea, title, seed?, start }', () => {
    expect(newBookBody({ genre: 'random' })).toEqual({ genre: 'random', length: 'random', idea: '', title: '', start: true });
    expect(newBookBody({ genre: 'xianxia', length: 'long', idea: '一句话想法', title: '书名', slug: 'my-book', 'no-start': true }, '完整种子')).toEqual({
      genre: 'xianxia',
      length: 'long',
      idea: '一句话想法',
      title: '书名',
      slug: 'my-book',
      seed: '完整种子',
      start: false,
    });
    expect(() => newBookBody({})).toThrow(/--genre/);
  });

  it('routing check is gone (usage points at routing slots); migrate-book is an unknown command', async () => {
    await expect(main(['routing', 'check'])).rejects.toThrow(/routing slots/);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['migrate-book', 'x'])).toBe(2);
      expect(String(err.mock.calls[0]?.[0])).not.toContain('migrate-book');
    } finally {
      err.mockRestore();
    }
  });
});
