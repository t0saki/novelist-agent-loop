/**
 * 自动开书默认关闭的护栏（p2-plan 约束 4、§6 WP-3）：schema 默认值是 false，任何测试都不许把 autoStart.enabled 设成 true。
 * 主人没开口之前，没有代码、种子、迁移或测试夹具可以打开它。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { zSystemSettings } from '@novelist/shared';

const SELF = fileURLToPath(import.meta.url);
const SERVER = path.resolve(path.dirname(SELF), '../..');
const PATTERN = /autoStart[^\n]{0,80}enabled:\s*true/;

async function testFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await testFiles(p, out);
    else if (e.isFile() && e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('auto-start stays disabled by default', () => {
  it('zSystemSettings defaults keep autoStart.enabled false', () => {
    expect(zSystemSettings.parse({}).autoStart.enabled).toBe(false);
    expect(zSystemSettings.parse({ autoStart: {} }).autoStart.enabled).toBe(false);
  });

  it('no test under apps/server/src or apps/server/test sets autoStart enabled: true', async () => {
    const files = [...(await testFiles(path.join(SERVER, 'src'))), ...(await testFiles(path.join(SERVER, 'test')))].filter((f) => path.resolve(f) !== path.resolve(SELF));
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const text = await fs.readFile(f, 'utf8');
      if (PATTERN.test(text)) offenders.push(path.relative(SERVER, f));
    }
    expect(offenders).toEqual([]);
  });
});
