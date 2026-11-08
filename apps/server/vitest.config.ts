import { defineConfig } from 'vitest/config';
// 'source' 条件：直接从 packages/shared/src 解析（无需先构建 shared）
export default defineConfig({
  resolve: { conditions: ['source', 'module', 'node', 'default'] },
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'default'] } },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
