/**
 * 真实事件流回放（离线）：__fixtures__/<harness>/<version>/*.ndjson 由 real.format.test.ts 录制并脱敏。
 * 按任意分块喂给 parser，核对事件种类、usage、终止状态和 Outcome。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessId, NEvent, NEventBody } from '@novelist/shared';
import { describe, expect, it } from 'vitest';
import { stamp } from '../events.js';
import { getAdapter } from '../registry.js';
import type { ExitInfo, RunSpec } from '../types.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const OK_EXIT: ExitInfo = { code: 0, signal: null, wallMs: 1000, timedOut: null, killed: null };
const SPEC = { outDir: '/SCRATCH/out' } as RunSpec;

function versioned(): { harness: HarnessId; version: string; name: string; file: string }[] {
  const out: { harness: HarnessId; version: string; name: string; file: string }[] = [];
  for (const harness of readdirSync(FIX)) {
    const hd = path.join(FIX, harness);
    if (!statSync(hd).isDirectory()) continue;
    for (const version of readdirSync(hd)) {
      const vd = path.join(hd, version);
      if (!statSync(vd).isDirectory()) continue;
      for (const f of readdirSync(vd)) if (f.endsWith('.ndjson')) out.push({ harness: harness as HarnessId, version, name: f.replace('.ndjson', ''), file: path.join(vd, f) });
    }
  }
  return out;
}

function replay(harness: HarnessId, raw: string, chunk: number): NEvent[] {
  const parser = getAdapter(harness).createParser(SPEC);
  const bodies: NEventBody[] = [];
  for (let i = 0; i < raw.length; i += chunk) bodies.push(...parser.push(raw.slice(i, i + chunk)));
  bodies.push(...parser.end());
  return stamp('run', 1, bodies, () => 'T');
}

const cases = versioned();

describe('真实事件流回放', () => {
  it('录制过真实流', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(new Set(cases.map((c) => c.harness))).toEqual(new Set(['agy', 'claude-code', 'codex']));
  });

  describe.each(cases)('$harness/$version/$name', ({ harness, name, file }) => {
    const raw = readFileSync(file, 'utf8');

    it('fixture 已脱敏', () => {
      expect(raw).not.toMatch(/sk-ant-(?!REDACTED)|ya29\.(?!REDACTED)|\/home\/[a-z]|tosaki/);
    });

    it('分块无关：逐块解析与整段解析结果一致', () => {
      expect(replay(harness, raw, 7)).toEqual(replay(harness, raw, raw.length + 1));
    });

    it('事件与 Outcome 符合预期', () => {
      const evs = replay(harness, raw, 64);
      expect(evs.some((e) => e.t === 'unknown'), JSON.stringify(evs.find((e) => e.t === 'unknown'))).toBe(false);
      expect(evs.some((e) => e.t === 'init')).toBe(true);
      const usage = evs.filter((e) => e.t === 'usage');
      const outcome = getAdapter(harness).classify(name === 'auth_unavailable_503' ? { ...OK_EXIT, code: 1 } : OK_EXIT, evs, '');

      if (name === 'auth_unavailable_503') {
        expect(evs.filter((e) => e.t === 'retry')).toHaveLength(5);
        expect(evs.filter((e) => e.t === 'error' && e.cls === 'auth').length).toBeGreaterThan(0);
        const last = [...evs].reverse().find((e) => e.t === 'result');
        expect(last).toMatchObject({ status: 'error' });
        expect(outcome.status).toBe('failed');
        expect(outcome.errorClass).toBe('auth');
        return;
      }

      expect(usage.length).toBeGreaterThan(0);
      expect(outcome.status).toBe('completed');
      expect(outcome.usage.input + (outcome.usage.cachedInput ?? 0)).toBeGreaterThan(0);
      expect(outcome.usage.output).toBeGreaterThan(0);
      const result = [...evs].reverse().find((e) => e.t === 'result');
      expect(result).toMatchObject({ status: 'success' });
      expect(outcome.sessionId).toBeTruthy();

      const writes = evs.filter((e): e is Extract<NEvent, { t: 'tool_call' }> => e.t === 'tool_call' && (e.kind === 'write' || e.kind === 'edit'));
      const written = writes.flatMap((w) => w.paths ?? []);
      expect(written.some((p) => p.endsWith('/receipt.json')), JSON.stringify(written)).toBe(true);
      expect(written.some((p) => p.endsWith(name === 'writer' ? 'manuscript/c00001.md' : 'check.json')), JSON.stringify(written)).toBe(true);
      expect(evs.filter((e) => e.t === 'file_change' && e.ok).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('claude 的 usage 取 modelUsage 合计，rate_limit 事件被解析', () => {
    const c = cases.find((x) => x.harness === 'claude-code' && x.name === 'writer');
    expect(c).toBeTruthy();
    const evs = replay('claude-code', readFileSync(c!.file, 'utf8'), 128);
    const u = [...evs].reverse().find((e) => e.t === 'usage');
    expect(u).toMatchObject({ costSource: 'harness', scope: 'total' });
    expect(evs.some((e) => e.t === 'rate_limit')).toBe(true);
  });
});
