import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb } from '../src/db/testing.js';
import { books, settings, tasks } from '../src/db/schema.js';

describe('db (PGlite)', () => {
  it('migrates and round-trips rows', async () => {
    const h = await createTestDb();
    await h.db.insert(books).values({ id: 'b1', slug: 'demo', title: '演示', genre: 'xianxia' });
    await h.db.insert(settings).values({ key: 'system', value: { activePreset: 'agy-argon' } });
    await h.db.insert(tasks).values({ id: 't1', bookId: 'b1', kind: 'chapter.write', target: 'c00001', lane: 'write' });
    const [b] = await h.db.select().from(books).where(eq(books.slug, 'demo'));
    expect(b?.status).toBe('draft');
    const claimed = await h.db.execute(sql`select id from tasks where state = 'ready' order by priority desc limit 1 for update skip locked`);
    expect(JSON.stringify(claimed)).toContain('t1');
    await h.close();
  });
});
