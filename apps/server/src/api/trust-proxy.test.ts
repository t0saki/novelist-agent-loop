import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { createTestApp, type TestApp } from '../testing.js';

const cfg = (v?: string) => loadConfig({ ...(v === undefined ? {} : { NOVELIST_TRUST_PROXY: v }) } as NodeJS.ProcessEnv).trustProxy;

describe('NOVELIST_TRUST_PROXY', () => {
  it('never hands Fastify a boolean true or a hop count', () => {
    for (const v of [undefined, '', '1', 'true']) expect(cfg(v)).toBe('loopback,uniquelocal');
    for (const v of ['0', 'false']) expect(cfg(v)).toBe(false);
    expect(cfg('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});

describe('login rate limit behind the reverse proxy', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('counts by the address the proxy appended, whatever the client put in X-Forwarded-For', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': `6.6.6.${i}, 203.0.113.9` },
        payload: { password: 'wrong-password' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
