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
/**
 * 例外（P3 WP-3）：控制台流程测试要验证“开关”这一个请求能打开、也能关上（在它自己的临时安装里，同一个用例里立刻关回去）。
 * 例外文件必须在同一个文件里把它关回去，并断言最后读回来是 false。
 */
const TOGGLE_ROUND_TRIP = new Set(['src/api/console.flows.test.ts']);

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
      const rel = path.relative(SERVER, f);
      if (!PATTERN.test(text)) continue;
      if (TOGGLE_ROUND_TRIP.has(rel) && /autoStart: \{ enabled: false \}/.test(text) && /autoStart\.enabled\)\.toBe\(false\)/.test(text)) continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
