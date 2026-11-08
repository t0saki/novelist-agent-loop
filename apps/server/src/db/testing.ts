/** 测试工具：内存 PGlite + 已迁移的 schema。所有 lane 的 DB 测试都用它（IMPL.md §8）。 */
import { migrate, openDb, type DbHandle } from './client.js';

export async function createTestDb(): Promise<DbHandle> {
  const h = await openDb({ url: null, pgliteDir: null });
  await migrate(h);
  return h;
}
