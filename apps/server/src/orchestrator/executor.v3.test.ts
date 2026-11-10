import { describe, expect, it } from 'vitest';
import { v3RunBusy } from './executor.js';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const row = (p: Partial<{ id: string; state: string; leaseOwner: string | null; leaseExpiresAt: string | null }> = {}) => ({ id: 'r1', state: 'exited', leaseOwner: 'me', leaseExpiresAt: new Date(NOW + 30_000).toISOString(), ...p });
const ctx = (finalizing: string[] = []) => ({ owner: 'me', nowMs: NOW, finalizing: new Set(finalizing) });

describe('v3RunBusy: a pending whose run is still being finalized is not consumed', () => {
  it('active run states are busy', () => {
    for (const state of ['preparing', 'spawned', 'running']) expect(v3RunBusy(row({ state }), ctx())).toBe(true);
  });
  it('a run this process is still finishing (exited, harvest in progress) is busy', () => {
    expect(v3RunBusy(row({ state: 'killed' }), ctx(['r1']))).toBe(true);
    expect(v3RunBusy(row({ state: 'exited' }), ctx(['r1']))).toBe(true);
  });
  it('exited/killed with a live lease held by another process is busy; expired lease (crashed owner) is not', () => {
    expect(v3RunBusy(row({ leaseOwner: 'other' }), ctx())).toBe(true);
    expect(v3RunBusy(row({ leaseOwner: 'other', leaseExpiresAt: new Date(NOW - 1).toISOString() }), ctx())).toBe(false);
  });
  it('own exited run that is not being finished any more (crash hook), finalized, lost or missing rows are consumable', () => {
    expect(v3RunBusy(row(), ctx())).toBe(false);
    expect(v3RunBusy(row({ state: 'finalized', leaseOwner: 'other' }), ctx())).toBe(false);
    expect(v3RunBusy(row({ state: 'lost', leaseOwner: 'other' }), ctx())).toBe(false);
    expect(v3RunBusy(null, ctx())).toBe(false);
  });
});

describe('removeStrayInstructionFiles: committed harness instruction files never reach a v3 run', () => {
  it('removes override / local / nested instruction files, keeps instructions/, hidden dirs and work/', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { removeStrayInstructionFiles } = await import('./executor.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-stray-'));
    const put = async (rel: string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), 'x\n');
    };
    const gone = ['AGENTS.override.md', 'GEMINI.md', 'CLAUDE.local.md', 'manuscript/CLAUDE.md', 'notes/Agents.Override.md'];
    const kept = ['AGENTS.md', 'CLAUDE.md', 'instructions/AGENTS.md', '.claude/CLAUDE.md', 'work/t/AGENTS.md', 'manuscript/c00001.md'];
    for (const p of [...gone, ...kept]) await put(p);
    try {
      expect((await removeStrayInstructionFiles(dir)).sort()).toEqual([...gone].sort());
      for (const p of gone) await expect(fs.stat(path.join(dir, p))).rejects.toThrow();
      for (const p of kept) expect((await fs.stat(path.join(dir, p))).isFile()).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
