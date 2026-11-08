import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, get, openEventStream, put, qs } from '../src/api/client';
import { saveWithImpact } from '../src/components/admin/saveFlow';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('throws ApiError with the problem detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { type: 'about:blank', title: 'Not Found', status: 404, detail: '没有这本书' })));
    await expect(get('/api/admin/books/x')).rejects.toMatchObject({ status: 404, message: '没有这本书' });
  });

  it('exposes an ImpactEstimate carried by a 409', async () => {
    const impact = { invalidatedTasks: 3, estimatedRuns: 30, affectedChapters: [1, 2], affectedDeltas: 1, windowPct: {}, usd: 0, needsConfirm: true, notes: [] };
    vi.stubGlobal('fetch', vi.fn(async () => json(409, impact)));
    const err = await put('/x', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).impact).toEqual(impact);
  });

  it('skips empty query parameters', () => {
    expect(qs({ a: 1, b: '', c: null, d: undefined, e: false })).toBe('?a=1&e=false');
    expect(qs({ a: '' })).toBe('');
  });
});

describe('openEventStream', () => {
  class FakeEventSource {
    static last: FakeEventSource;
    listeners = new Map<string, (m: MessageEvent<string>) => void>();
    onmessage: unknown = null;
    onopen: unknown = null;
    onerror: unknown = null;
    closed = false;
    constructor() {
      FakeEventSource.last = this;
    }
    addEventListener(t: string, fn: (m: MessageEvent<string>) => void) {
      this.listeners.set(t, fn);
    }
    close() {
      this.closed = true;
    }
  }

  it('receives named SSE events, which onmessage alone would miss', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const got: unknown[] = [];
    const close = openEventStream('/s', (e) => got.push(e));
    const event = { type: 'run_exit', runId: 'r', state: 'finalized', errorClass: null };
    FakeEventSource.last.listeners.get('run_exit')?.({ data: JSON.stringify(event) } as MessageEvent<string>);
    expect(got).toEqual([event]);
    close();
    expect(FakeEventSource.last.closed).toBe(true);
  });
});

describe('saveWithImpact', () => {
  it('saves straight through when the server does not ask for confirmation', async () => {
    const doSave = vi.fn(async () => ({ path: 'a' }));
    await expect(saveWithImpact(doSave)).resolves.toEqual({ path: 'a' });
    expect(doSave).toHaveBeenCalledTimes(1);
    expect(doSave).toHaveBeenCalledWith(false);
  });

  it('passes through ordinary errors', async () => {
    const doSave = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(saveWithImpact(doSave)).rejects.toThrow('boom');
  });
});
