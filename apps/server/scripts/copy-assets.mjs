// 构建后把非 TS 资源拷到 dist（迁移 SQL、内置指令、内置题材包、工作单模板）
import { cpSync, existsSync } from 'node:fs';
const pairs = [
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/instructions/builtin', 'dist/instructions/builtin'],
  ['src/genres/builtin', 'dist/genres/builtin'],
  ['src/pipeline/templates', 'dist/pipeline/templates'],
];
for (const [from, to] of pairs) if (existsSync(from)) cpSync(from, to, { recursive: true });
