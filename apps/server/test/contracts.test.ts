import { describe, expect, it } from 'vitest';
import { HARNESS_IDS, TASK_KINDS } from '@novelist/shared';
import { HANDLERS } from '../src/pipeline/registry.js';
import { ADAPTERS } from '../src/harness/registry.js';
import { dataPaths, loadConfig } from '../src/config/index.js';
import { KNOWN_LIMITS } from '../src/instructions/budget.js';
import { SECTION_QUOTAS } from '../src/context/pack.js';

describe('skeleton contracts', () => {
  it('every TaskKind has a handler with matching kind', () => {
    for (const k of TASK_KINDS) {
      expect(HANDLERS[k], k).toBeDefined();
      expect(HANDLERS[k].kind).toBe(k);
      const h = HANDLERS[k];
      expect(h.role ? !!(h.prepare && h.finalize) : !!h.execute, `${k} has run hooks`).toBe(true);
    }
  });
  it('every builtin harness has an adapter', () => {
    for (const id of HARNESS_IDS) expect(ADAPTERS[id]?.id, id).toBe(id);
  });
  it('config defaults to PGlite under $DATA when no URL', () => {
    const c = loadConfig({ NOVELIST_DATA_DIR: '/tmp/nvtest' });
    expect(c.dbKind).toBe('pglite');
    expect(c.pgliteDir).toBe('/tmp/nvtest/pglite');
    const pg = loadConfig({ NOVELIST_DATABASE_URL: 'postgresql+psycopg://u:p@h:5432/novelist2' });
    expect(pg.dbKind).toBe('pg');
    expect(pg.databaseUrl).toBe('postgresql://u:p@h:5432/novelist2');
    expect(dataPaths('/data').instructionsGlobal).toBe('/data/instructions/global');
  });
  it('context pack quotas sum to 65k', () => {
    expect(Object.values(SECTION_QUOTAS).reduce((a, b) => a + b, 0)).toBe(65_000);
    expect(KNOWN_LIMITS.agy).toBe(20_000);
  });
});
