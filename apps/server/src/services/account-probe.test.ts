import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeCustomApi, probeTarget } from './account-probe.js';

let server: http.Server;
let base: string;
let lastHeaders: http.IncomingHttpHeaders = {};
let status = 200;
let body: unknown = { data: [{ id: 'gw-model-a' }, { id: 'gw-model-b' }] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('probeCustomApi', () => {
  it('reports verified and returns gateway models on 200', async () => {
    status = 200;
    const r = await probeCustomApi('claude-code', { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'k-1' });
    expect(r).toMatchObject({ kind: 'verified', ok: true, models: ['gw-model-a', 'gw-model-b'] });
    expect(lastHeaders['x-api-key']).toBe('k-1');
    expect(r.detail).not.toContain('k-1');
  });
  it('fails on 401 without leaking the key', async () => {
    status = 401;
    const r = await probeCustomApi('codex', { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: 'secret-key' });
    expect(r).toMatchObject({ kind: 'failed', ok: false });
    expect(r.detail).toContain('401');
    expect(r.detail).not.toContain('secret-key');
    expect(lastHeaders.authorization).toBe('Bearer secret-key');
  });
  it('does not claim the key works when the list endpoint is missing', async () => {
    status = 404;
    const r = await probeCustomApi('claude-code', { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 't' });
    expect(r.kind).toBe('reachable');
    expect(r.detail).toContain('未能验证密钥');
  });
  it('fails when the gateway is down', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>((r) => dead.close(() => r()));
    const r = await probeCustomApi('claude-code', { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'k' });
    expect(r).toMatchObject({ kind: 'failed', ok: false });
    expect(r.detail).toContain('无法连接网关');
  });
  it('labels harnesses without a probeable endpoint as config only', async () => {
    expect(probeTarget('grok', {})).toBeNull();
    const r = await probeCustomApi('grok', {});
    expect(r).toMatchObject({ kind: 'config_only', ok: true });
    expect(r.detail).toContain('仅校验配置，未实际连通');
  });
});
