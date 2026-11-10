import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PROFILES,
  DEFAULT_SLOTS,
  ROUTES,
  TASK_KINDS,
  chapterId,
  chapterNo,
  countByBeat,
  countCjk,
  mergeLayers,
  zBookConfig,
  zProfile,
  zRoutingSlots,
  zSystemSettings,
} from '../src/index.js';

describe('ids', () => {
  it('round-trips chapter ids', () => {
    expect(chapterId(421)).toBe('c00421');
    expect(chapterNo('c00421')).toBe(421);
    expect(() => chapterNo('x1')).toThrow();
  });
});

describe('book.yaml', () => {
  it('fills defaults (publish, flow, v3)', () => {
    const b = zBookConfig.parse({ slug: 'demo', title: '演示', genre: 'xianxia' });
    expect(b.publish.mode).toBe('scheduled');
    expect(b.publish.max_buffer).toBe(60);
    expect(b.flow).toBe('v2');
    expect(b.v3.length).toBe('medium');
    expect(Object.keys(b).sort()).toEqual(['budgets', 'flow', 'format_version', 'genre', 'language', 'publish', 'routing', 'schema', 'slug', 'title', 'v3']);
  });
});

describe('task kinds (P3)', () => {
  it('only the v3 kinds and publish remain; the old flow schemas are gone', async () => {
    expect([...TASK_KINDS]).toEqual(['book.open', 'book.write', 'book.retro', 'publish']);
    const mod = (await import('../src/index.js')) as Record<string, unknown>;
    for (const name of ['QUALITY_TIERS', 'zQualityTier', 'normalizeTier', 'zLengthSpec', 'zGateOverride', 'zApprovalGate', 'zExhaustPolicy', 'zPutBookConfig', 'zPutPublish', 'zInstructionPreviewRequest', 'ROUTABLE_ROLES', 'ROUTE_CONSTRAINTS', 'zCard', 'zDelta', 'zVolume', 'zCompass', 'zEntity', 'zSnapshot', 'zCheckOutput', 'zReview', 'zAudit', 'zGatesFile', 'zLexicon', 'zPacing', 'schemaForPath', 'zReceipt', 'zWorkOrderFrontmatter', 'SCHEMAS', 'toJsonSchema', 'zRoutingPreset', 'zRoleRoute', 'zRouteDecision', 'BUILTIN_PRESETS', 'DEFAULT_PRESET_ID', 'zCreatePreset', 'zPutActiveRouting']) expect(mod[name], name).toBeUndefined();
  });
  it("an old book.yaml with every legacy key still parses (the keys are stripped, the file keeps them)", () => {
    const old = {
      slug: 'old',
      title: '旧',
      genre: 'xianxia',
      tier: 'key',
      tiers: { key_chapters: 'standard' },
      scale: { target_cjk: 1_000_000, volumes: [3, 4], chapter_length: { min: 2000, target: 3000, max: 4000 } },
      optin: { bakeoff: true },
      policy: { forward_debt_cap: 5, on_exhausted: { canon_hard: 'hold' } },
      gates: { overrides: { lexicon: { disable: true } } },
      approvals: { compass: { required: false } },
      mcp: 'on',
      persona_mode: 'replace',
      publish: { require_audited: true, lag: 30 },
      budgets: { priority: 3, monthly_usd_cap: 10 },
    };
    const b = zBookConfig.parse(old) as Record<string, unknown>;
    for (const k of ['tier', 'tiers', 'scale', 'optin', 'policy', 'gates', 'approvals', 'mcp', 'persona_mode']) expect(b[k], k).toBeUndefined();
    expect(b).toMatchObject({ flow: 'v2', publish: { require_audited: true, lag: 30 }, budgets: { priority: 3, monthly_usd_cap: 10 } });
  });
  it('an old book.yaml with routing.preset / routing.roles / vendors_allow still parses; only writer_profile is kept', () => {
    const b = zBookConfig.parse({ slug: 'old', title: '旧', genre: 'xianxia', vendors_allow: ['openai'], routing: { preset: 'mixed', roles: { writer: { chain: ['cc-opus'] } }, writer_profile: 'cc-opus' } });
    expect(b.routing).toEqual({ writer_profile: 'cc-opus' });
    expect((b as Record<string, unknown>).vendors_allow).toBeUndefined();
    expect(zBookConfig.parse({ slug: 'n', title: 'n', genre: 'g' }).routing).toEqual({});
  });
});

describe('routing slots', () => {
  it('default slots reference builtin, non-dev profiles', () => {
    const ids = new Set(BUILTIN_PROFILES.map((p) => zProfile.parse(p).id));
    const dev = new Set(BUILTIN_PROFILES.filter((p) => p.tags?.includes('dev')).map((p) => p.id));
    for (const slot of [DEFAULT_SLOTS.writer, DEFAULT_SLOTS.utility]) {
      expect(ids.has(slot.primary as string)).toBe(true);
      expect(dev.has(slot.primary as string)).toBe(false);
    }
    expect(DEFAULT_SLOTS).toEqual({ writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-flash-check', fallback: null } });
  });
  it('zRoutingSlots fills defaults', () => {
    expect(zRoutingSlots.parse({})).toEqual({ schema: 'nv.slots/1', writer: { primary: null, fallback: null }, utility: { primary: null, fallback: null }, droppedProfiles: [] });
    expect(zRoutingSlots.parse({ writer: { primary: 'x' } }).writer).toEqual({ primary: 'x', fallback: null });
  });
  it('zSystemSettings strips the removed keys of an old row and keeps autoStart off', () => {
    const old = { activePreset: 'mixed', defaultTier: 'key', reservePct: 40, workOrderMaxCjk: 50_000, maxConcurrentRuns: 2, autoStart: { maxActiveBooks: 1, maxUnfinishedBooks: 4 } };
    const s = zSystemSettings.parse(old) as Record<string, unknown> & { autoStart: Record<string, unknown> };
    for (const k of ['activePreset', 'defaultTier', 'reservePct', 'workOrderMaxCjk']) expect(s[k], k).toBeUndefined();
    expect(s.autoStart.maxActiveBooks).toBeUndefined();
    expect(s).toMatchObject({ maxConcurrentRuns: 2, autoStart: { enabled: false, maxUnfinishedBooks: 4 } });
  });
  it('zSystemSettings keeps autoStart off and no longer notifies circuit changes by default', () => {
    const s = zSystemSettings.parse({});
    expect(s.autoStart.enabled).toBe(false);
    expect(s.notifications.events).toEqual(['inbox_new', 'quota_wait']);
    // 旧行里存的值不动
    expect(zSystemSettings.parse({ notifications: { events: ['inbox_new', 'circuit_changed', 'quota_wait'] } }).notifications.events).toContain('circuit_changed');
  });
});

describe('text', () => {
  it('counts han and platform', () => {
    expect(countCjk('林枫说：“走！”abc 12')).toBe(4);
    expect(countCjk('林枫说：“走！”abc 12', 'platform')).toBe(4 + 4 + 2);
    expect(countByBeat('<!-- beat:b1 -->\n一二三\n<!-- beat:b2 -->\n四五')).toEqual({ _pre: 0, b1: 3, b2: 2 });
  });
  it('merges layers deeply, arrays replace', () => {
    expect(mergeLayers({ a: { x: 1, y: [1] } }, { a: { y: [2] } }, { a: { z: 3 } })).toEqual({ a: { x: 1, y: [2], z: 3 } });
  });
});

describe('registry', () => {
  it('route table has unique method+path', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
