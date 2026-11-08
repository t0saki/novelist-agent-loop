/** adapter 注册表。Owner: lane A。 */
import type { HarnessId } from '@novelist/shared';
import type { HarnessAdapter } from './types.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { agyAdapter } from './adapters/agy.js';
import { grokAdapter } from './adapters/grok.js';
import { dshAdapter } from './adapters/dsh.js';
import { piAdapter } from './adapters/pi.js';
import { fakeAdapter } from './adapters/fake.js';

export const ADAPTERS: Record<string, HarnessAdapter> = {
  'claude-code': claudeAdapter,
  codex: codexAdapter,
  agy: agyAdapter,
  grok: grokAdapter,
  dsh: dshAdapter,
  pi: piAdapter,
  fake: fakeAdapter,
};

export function getAdapter(id: HarnessId): HarnessAdapter {
  const a = ADAPTERS[id];
  if (!a) throw new Error(`no adapter for harness ${id}`);
  return a;
}

export function listAdapters(): HarnessAdapter[] {
  return Object.values(ADAPTERS);
}
