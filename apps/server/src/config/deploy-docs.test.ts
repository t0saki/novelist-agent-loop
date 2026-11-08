/** README 的部署步骤要和仓库里的 compose/Dockerfile 一致，否则按文档操作首次启动就会失败 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

describe('deployment docs', () => {
  const readme = read('README.md');
  const compose = read('docker-compose.yml');

  it('README mounts and prepares the same data directory as docker-compose.yml', () => {
    expect(compose).toContain('./data2:/data');
    expect(readme).toContain('"./data2:/data"');
    expect(readme).toContain('mkdir -p data2');
    expect(readme).not.toMatch(/"\.\/data:\/data"/);
  });

  it('README uses the same default host port as docker-compose.yml', () => {
    expect(compose).toContain('${NOVELIST_PORT:-8199}:8000');
    expect(readme).toContain('${NOVELIST_PORT:-8199}:8000');
    expect(readme).not.toContain('${NOVELIST_PORT:-8000}');
  });

  it('runtime image has what the default harness installer needs', () => {
    const apt = read('Dockerfile').split('\n').find((l) => l.includes('apt-get install')) ?? '';
    for (const tool of ['curl', 'tar', 'gzip', 'ca-certificates']) expect(apt).toContain(tool);
  });
});
