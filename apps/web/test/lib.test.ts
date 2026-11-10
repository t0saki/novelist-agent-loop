import { describe, expect, it } from 'vitest';
import type { NEvent, RepoEntry } from '@novelist/shared';
import { zPatchAccount } from '@novelist/shared';
import { accountPatch } from '../src/lib/accounts';
import { invalidationsFor } from '../src/lib/invalidation';
import { buildAlerts } from '../src/lib/alerts';
import { inboxKind, roleLabel, taskKindLabel } from '../src/lib/labels';
import { stripAnsi } from '../src/lib/ansi';
import { fmtCjk, fmtRel, toRatio } from '../src/lib/format';
import { parseChapterNo } from '../src/lib/chapterId';
import { coverGradient, scrollRatio, splitParagraphs, stepPrefs } from '../src/lib/reader';
import { childrenOf } from '../src/lib/repoTree';
import { backfillAfter, buildTimeline, totalUsage } from '../src/lib/runEvents';
import { getYaml, parseRange, setYaml } from '../src/lib/yamlEdit';

const base = { ts: '2026-11-08T00:00:00Z', runId: 'r1' };

describe('yamlEdit', () => {
  const doc = ['# 书配置', 'slug: demo', 'tier: standard  # 档位', 'scale:', '  target_cjk: 3000000', '  volumes: [10, 12]', '  chapter_length:', '    min: 2600', '', 'publish:', '  mode: scheduled', ''].join('\n');

  it('reads nested scalars and ignores comments', () => {
    expect(getYaml(doc, ['tier'])).toBe('standard');
    expect(getYaml(doc, ['scale', 'chapter_length', 'min'])).toBe('2600');
    expect(getYaml(doc, ['scale', 'missing'])).toBeNull();
    expect(parseRange(getYaml(doc, ['scale', 'volumes']))).toEqual([10, 12]);
  });

  it('replaces a value and keeps the trailing comment', () => {
    const out = setYaml(doc, ['tier'], 'key') as string;
    expect(out).toContain('tier: key # 档位');
    expect(out).toContain('slug: demo');
  });

  it('inserts into an existing block at the right indent', () => {
    const out = setYaml(doc, ['scale', 'hard_max_cjk'], '3500000') as string;
    expect(getYaml(out, ['scale', 'hard_max_cjk'])).toBe('3500000');
    expect(getYaml(out, ['scale', 'target_cjk'])).toBe('3000000');
    expect(getYaml(out, ['publish', 'mode'])).toBe('scheduled');
  });

  it('creates missing parents', () => {
    const out = setYaml(doc, ['routing', 'preset'], 'mixed') as string;
    expect(out).toContain('routing:\n  preset: mixed');
    expect(getYaml(out, ['routing', 'preset'])).toBe('mixed');
  });

  it('adds a deep leaf under a nested block without disturbing siblings', () => {
    const out = setYaml(doc, ['scale', 'chapter_length', 'max'], '3800') as string;
    expect(getYaml(out, ['scale', 'chapter_length', 'max'])).toBe('3800');
    expect(getYaml(out, ['scale', 'chapter_length', 'min'])).toBe('2600');
  });

  it('removes a leaf and its emptied parent', () => {
    const once = setYaml(doc, ['publish', 'mode'], null) as string;
    expect(once).not.toContain('publish:');
    expect(getYaml(once, ['tier'])).toBe('standard');
    expect(setYaml(doc, ['nope', 'x'], null)).toBe(doc);
  });

  it('refuses shapes it cannot edit safely', () => {
    expect(setYaml('budgets: {priority: 1}\n', ['budgets', 'priority'], '2')).toBeNull();
    expect(setYaml(doc, ['scale'], '1')).toBeNull();
  });
});

describe('run timeline', () => {
  const events: NEvent[] = [
    { ...base, seq: 0, t: 'text', channel: 'assistant', delta: '你' },
    { ...base, seq: 1, t: 'heartbeat', source: 'stdout' },
    { ...base, seq: 2, t: 'text', channel: 'assistant', delta: '好' },
    { ...base, seq: 3, t: 'text', channel: 'thinking', delta: '想' },
    { ...base, seq: 4, t: 'tool_call', id: 'a', name: 'Write', kind: 'write', paths: ['out/x.md'] },
    { ...base, seq: 5, t: 'tool_result', id: 'a', ok: true },
    { ...base, seq: 6, t: 'file_change', path: 'out/x.md', op: 'add', ok: true },
  ];

  it('coalesces text across heartbeats and pairs tool results', () => {
    const t = buildTimeline(events);
    expect(t.map((i) => i.kind)).toEqual(['text', 'text', 'tool', 'event']);
    expect(t[0]).toMatchObject({ text: '你好', channel: 'assistant' });
    expect(t[2]).toMatchObject({ result: { ok: true } });
  });

  it('adds delta usage and lets a total replace it', () => {
    const usage = (seq: number, scope: 'delta' | 'total', input: number, output: number): NEvent => ({ ...base, seq, t: 'usage', input, output, costSource: 'unknown', scope });
    expect(totalUsage([usage(0, 'delta', 10, 1), usage(1, 'delta', 5, 2)])).toMatchObject({ input: 15, output: 3 });
    expect(totalUsage([usage(0, 'delta', 10, 1), usage(1, 'total', 100, 40)])).toMatchObject({ input: 100, output: 40 });
  });
});

describe('repo tree', () => {
  const e = (path: string, type: 'file' | 'dir' = 'file'): RepoEntry => ({ path, type, size: 1, owner: 'canonical' });

  it('lists direct children, directories first', () => {
    const list = childrenOf([e('bible/premise.md'), e('bible/world', 'dir')], 'bible');
    expect(list.map((n) => [n.name, n.type])).toEqual([
      ['world', 'dir'],
      ['premise.md', 'file'],
    ]);
  });

  it('derives implied directories from a recursive listing', () => {
    const list = childrenOf([e('bible/world/rules.yaml'), e('bible/world/geo.md'), e('other/x.md')], 'bible');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'world', path: 'bible/world', type: 'dir' });
  });
});

describe('reader helpers', () => {
  it('splits paragraphs and drops a repeated title heading', () => {
    expect(splitParagraphs('# 第一章 风起\n\n  第一段\n第二段\r\n\r\n第三段', '第一章 风起')).toEqual(['第一段', '第二段', '第三段']);
  });

  it('keeps a heading that is not the title', () => {
    expect(splitParagraphs('# 楔子\n正文', '风起')).toEqual(['楔子', '正文']);
  });

  it('computes a clamped scroll ratio', () => {
    expect(scrollRatio(500, 2000, 1000)).toBe(0.5);
    expect(scrollRatio(5000, 2000, 1000)).toBe(1);
    expect(scrollRatio(10, 500, 1000)).toBe(0);
  });

  it('clamps font and line height steps', () => {
    expect(stepPrefs.font(32, 1)).toBe(32);
    expect(stepPrefs.lineHeight(1.9, 0.1)).toBe(2);
    expect(stepPrefs.lineHeight(1.4, -0.1)).toBe(1.4);
  });

  it('generates a stable placeholder cover', () => {
    expect(coverGradient('abc')).toBe(coverGradient('abc'));
  });
});

describe('formatters', () => {
  it('formats counts in 万字', () => {
    expect(fmtCjk(3000)).toBe('3,000 字');
    expect(fmtCjk(35000)).toBe('3.5 万字');
    expect(fmtCjk(3_000_000)).toBe('300 万字');
  });

  it('formats relative time on both sides of now', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    expect(fmtRel('2026-11-08T11:30:00Z', now)).toBe('30 分钟前');
    expect(fmtRel('2026-11-08T14:00:00Z', now)).toBe('2 小时后');
    expect(fmtRel(null, now)).toBe('—');
  });

  it('normalizes utilization given as percent or ratio', () => {
    expect(toRatio(0.4)).toBe(0.4);
    expect(toRatio(40)).toBe(0.4);
    expect(toRatio(null)).toBeNull();
  });

  it('parses chapter ids', () => {
    expect(parseChapterNo('c00421')).toBe(421);
    expect(parseChapterNo('v01')).toBeNull();
  });

  it('strips terminal escapes from login output', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m\r\nworld')).toBe('hello\nworld');
  });
});

describe('accountPatch', () => {
  it('survives the server schema without resetting untouched fields', () => {
    const a = { id: 'x', harness: 'codex', authMode: 'api_key', label: '主号', plan: 'max', enabled: false, files: [], customModels: ['m1'], concurrency: 3, reservePct: 10, windows: [{ window: '7d', capacity: null, unit: 'pct' }], riskAck: ['a'], notes: '备注', env: [], state: null, riskNotes: [] } as never;
    const parsed = zPatchAccount.parse(accountPatch(a, { riskAck: ['a', 'b'] }));
    expect(parsed).toMatchObject({ label: '主号', plan: 'max', enabled: false, concurrency: 3, reservePct: 10, customModels: ['m1'], notes: '备注', riskAck: ['a', 'b'] });
    expect(parsed.windows).toHaveLength(1);
  });

  it('carries the removed reservation fields through unchanged (not editable, not reset to the default)', () => {
    const a = { id: 'x', harness: 'codex', authMode: 'api_key', label: '主号', plan: 'max', enabled: true, files: [], customModels: [], concurrency: 1, reservePct: 10, maxWeeklyUtilPct: 70, windows: [], riskAck: [], notes: '', env: [], state: null, riskNotes: [] } as never;
    const parsed = zPatchAccount.parse(accountPatch(a, { label: '改名' }));
    expect(parsed).toMatchObject({ label: '改名', reservePct: 10, maxWeeklyUtilPct: 70 });
  });
});

describe('sse invalidation', () => {
  it('refreshes the right prefixes and skips high-frequency events', () => {
    expect(invalidationsFor({ type: 'inbox_new', item: {} as never })).toEqual(['/api/admin/inbox']);
    expect(invalidationsFor({ type: 'run_event', runId: 'r', event: {} as never })).toEqual([]);
    expect(invalidationsFor({ type: 'circuit_changed', harness: 'codex', version: '1', state: 'open', reason: null })).toEqual(['/api/admin/harness']);
  });
});

describe('alerts', () => {
  it('flags low buffers and sleeping accounts; legacy books and harness state never alert', () => {
    const alerts = buildAlerts({
      books: [
        { slug: 'a', title: 'A', status: 'active', legacy: false, frontiers: { bufferDays: 1 }, waiting: null } as never,
        { slug: 'old', title: '旧', status: 'active', legacy: true, frontiers: { bufferDays: 0 }, waiting: null } as never,
      ],
      quota: [{ accountId: 'acc', sleepUntil: '2026-11-11T10:00:00Z', sleepReason: null, windows: [] } as never],
    });
    expect(alerts.map((x) => x.id).sort()).toEqual(['b-a', 's-acc']);
    expect(alerts.find((x) => x.id === 'b-a')?.text).toContain('存稿仅够 1.0 天');
    expect(alerts.find((x) => x.id === 's-acc')?.to).toBe('/admin/models');
  });
});

describe('labels', () => {
  it('fall back to the raw string for removed roles, kinds and inbox kinds', () => {
    expect(roleLabel('writer')).toBe('主笔');
    expect(roleLabel('extractor_v9')).toBe('extractor_v9');
    expect(taskKindLabel('book.write')).toBe('写作');
    expect(taskKindLabel('chapter.extract')).toBe('chapter.extract');
    expect(inboxKind('auth').label).toBe('认证失效');
    expect(inboxKind('gone_kind')).toEqual({ label: 'gone_kind', tone: 'neutral' });
  });
});

describe('backfillAfter', () => {
  const m = (...seqs: number[]) => new Map(seqs.map((s) => [s, { seq: s } as never]));
  it('uses the end of the contiguous prefix so gaps get refetched', () => {
    expect(backfillAfter(m())).toBe(-1);
    expect(backfillAfter(m(1, 2, 3))).toBe(3);
    expect(backfillAfter(m(1, 2, 7, 8))).toBe(2);
  });
});
