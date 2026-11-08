import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runEvents, runs } from '../db/schema.js';
import { TEST_ADMIN_PASSWORD, createTestApp, type TestApp } from '../testing.js';

let t: TestApp;
let cookie: string;

beforeAll(async () => {
  t = await createTestApp({ http: true });
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_ADMIN_PASSWORD } });
  cookie = String(res.headers['set-cookie']).split(';')[0] as string;
});

afterAll(async () => {
  await t.close();
});

/** 读 SSE 直到拿到 want 条事件 */
async function readEvents(url: string, want: number, trigger?: () => void): Promise<{ event: string; data: Record<string, unknown>; id?: string }[]> {
  const ac = new AbortController();
  const res = await fetch(`${t.url}${url}`, { headers: { cookie }, signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const out: { event: string; data: Record<string, unknown>; id?: string }[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  trigger?.();
  try {
    while (out.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        idx = buf.indexOf('\n\n');
        const lines = block.split('\n');
        const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
        const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
        const id = lines.find((l) => l.startsWith('id: '))?.slice(4);
        if (event && data) out.push({ event, data: JSON.parse(data), ...(id ? { id } : {}) });
      }
    }
  } finally {
    ac.abort();
  }
  return out;
}

describe('SSE', () => {
  it('streams bus events and hides high-volume ones by default', async () => {
    const events = await readEvents('/api/admin/events', 2, () => {
      setTimeout(() => {
        t.deps.bus.publish({ type: 'run_event', runId: 'r', event: { seq: 1, ts: 'x', runId: 'r', t: 'tool', name: 'ignored' } as never });
        t.deps.bus.publish({ type: 'book_changed', book: 'x' });
      }, 50);
    });
    expect(events.map((e) => e.event)).toEqual(['hello', 'book_changed']);
  });

  it('run stream replays persisted events then ends on terminal state', async () => {
    const id = 'run-1';
    await t.deps.db.insert(runs).values({ id, taskId: 't', taskKind: 'chapter.write', attempt: 1, role: 'writer', profileId: 'fake', harness: 'fake', isolation: 'container', state: 'running', runDir: '/tmp/none' });
    for (let seq = 0; seq < 3; seq += 1) await t.deps.db.insert(runEvents).values({ runId: id, seq, ts: new Date().toISOString(), t: 'tool', body: { t: 'tool' } });
    await t.deps.db.update(runs).set({ state: 'finalized' }).where(eq(runs.id, id));
    const events = await readEvents(`/api/admin/runs/${id}/stream?after=0`, 4);
    expect(events.map((e) => e.event)).toEqual(['hello', 'run_event', 'run_event', 'run_exit']);
    expect(events[1]?.id).toBe('1');
  });

  it('run event history carries seq/ts/runId from the row columns, not the jsonb body', async () => {
    const id = 'run-2';
    await t.deps.db.insert(runs).values({ id, taskId: 't', taskKind: 'chapter.write', attempt: 1, role: 'writer', profileId: 'fake', harness: 'fake', isolation: 'container', state: 'running', runDir: '/tmp/none' });
    for (const seq of [1, 2]) await t.deps.db.insert(runEvents).values({ runId: id, seq, ts: new Date().toISOString(), t: 'text', body: { t: 'text', channel: 'assistant', delta: `d${seq}` } });
    const res = await t.app.inject({ url: `/api/admin/runs/${id}/events?after=-1`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const page = res.json() as { seq: number; runId: string; ts: string; delta: string }[];
    expect(page.map((e) => e.seq)).toEqual([1, 2]);
    expect(page.every((e) => e.runId === id && !Number.isNaN(Date.parse(e.ts)))).toBe(true);
    expect(page[1]?.delta).toBe('d2');
  });

});

describe('web serving and rate limit', () => {
  it('serves the SPA with fallback and keeps /api 404s as problem json', async () => {
    const web = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-web-'));
    await fs.writeFile(path.join(web, 'index.html'), '<!doctype html><title>Novelist</title>');
    await fs.mkdir(path.join(web, 'assets'));
    await fs.writeFile(path.join(web, 'assets', 'app.js'), 'console.log(1)');
    const w = await createTestApp({ web });
    try {
      const root = await w.app.inject({ url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain('Novelist');
      const asset = await w.app.inject({ url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
      const spa = await w.app.inject({ url: '/read/book/1' });
      expect(spa.statusCode).toBe(200);
      expect(spa.headers['content-type']).toContain('text/html');
      expect(spa.body).toContain('Novelist');
      const api = await w.app.inject({ url: '/api/none' });
      expect(api.statusCode).toBe(404);
      expect(api.headers['content-type']).toContain('application/problem+json');
    } finally {
      await w.close();
      await fs.rm(web, { recursive: true, force: true });
    }
  });

  it('rate-limits repeated logins', async () => {
    let last = 0;
    for (let i = 0; i < 25; i += 1) last = (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'x' } })).statusCode;
    expect(last).toBe(429);
  });
});
