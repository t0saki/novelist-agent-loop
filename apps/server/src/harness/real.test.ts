/**
 * 真实 CLI 冒烟测试（opt-in）：NOVELIST_REAL_HARNESS=1 或 NOVELIST_LIVE_TESTS=1 时才运行。
 * 每个 harness 用最便宜的 dev 模型跑一次 canary：写一个文件 + 一个 receipt。
 *
 * 凭据取本机已登录的 CLI，绝不打印：
 * - claude：access token 作为 CLAUDE_CODE_OAUTH_TOKEN 传入临时 home（不刷新、不碰 ~/.claude）；cc 用 --setting-sources project 隔离用户 hooks。
 * - agy：把 token 文件复制进临时 home（不碰 ~/.gemini；刷新只影响副本）。
 * - codex：adapter 每 run 重写 config.toml，所以不能软链 ~/.codex；用 custom_api 模式，
 *   base_url 取自 ~/.codex/config.toml 的当前 provider，key 取自 ~/.codex/auth.json。
 *
 * 走真实的 materializeFor（system.md → 各 harness 的系统通道）。
 * 用法（必须经 safe-run，逐个跑）：NOVELIST_REAL_HARNESS=1 vitest run src/harness/real.test.ts -t claude-code
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Capabilities, HarnessId, HarnessInstall } from '@novelist/shared';
import { parse as parseToml } from 'smol-toml';
import { afterAll, describe, expect, it } from 'vitest';
import { runProbe } from './probe.js';
import { getAdapter } from './registry.js';
import type { ResolvedAccount } from './types.js';

const ENABLED = process.env.NOVELIST_REAL_HARNESS === '1' || process.env.NOVELIST_LIVE_TESTS === '1';
const HOME = process.env.HOME ?? os.homedir();
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

function account(harness: HarnessId, home: string, o: Partial<ResolvedAccount>): ResolvedAccount {
  return {
    id: `real-${harness}`,
    harness,
    label: '',
    authMode: 'none',
    plan: '',
    enabled: true,
    env: [],
    files: [],
    customModels: [],
    concurrency: 1,
    reservePct: 30,
    windows: [],
    riskAck: [],
    notes: '',
    home,
    secretEnv: {},
    credentialFiles: [],
    ...o,
  };
}

async function setupAccount(harness: HarnessId): Promise<{ acct: ResolvedAccount; scratch: string }> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `nv-real-${harness}-`));
  dirs.push(scratch);
  const home = path.join(scratch, 'home');
  await fs.mkdir(home, { recursive: true });
  if (harness === 'claude-code') {
    const raw = JSON.parse(await fs.readFile(path.join(HOME, '.claude/.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string } };
    return { acct: account(harness, home, { authMode: 'oauth_token', secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: raw.claudeAiOauth.accessToken } }), scratch };
  }
  if (harness === 'agy') {
    const rel = '.gemini/antigravity-cli/antigravity-oauth-token';
    await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(HOME, rel), path.join(home, rel));
    return { acct: account(harness, home, { authMode: 'credential_file', credentialFiles: [{ relPath: rel, absPath: path.join(home, rel), part: 'state' }] }), scratch };
  }
  const cfg = parseToml(await fs.readFile(path.join(HOME, '.codex/config.toml'), 'utf8')) as { model_provider?: string; model_providers?: Record<string, { base_url?: string }> };
  const baseUrl = cfg.model_providers?.[cfg.model_provider ?? '']?.base_url;
  const auth = JSON.parse(await fs.readFile(path.join(HOME, '.codex/auth.json'), 'utf8')) as { OPENAI_API_KEY?: string };
  if (!baseUrl || !auth.OPENAI_API_KEY) throw new Error('本机 ~/.codex 没有可用的自定义 provider');
  return { acct: account(harness, home, { authMode: 'custom_api', secretEnv: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: auth.OPENAI_API_KEY } }), scratch };
}

async function canary(harness: HarnessId): Promise<Capabilities> {
  const adapter = getAdapter(harness);
  const base = adapter;
  const found = await base.detect('');
  if (!found) throw new Error(`本机没有 ${harness}`);
  const inst: HarnessInstall = { id: harness, version: found.version, binPath: found.binPath, sha256: '', sha256Source: 'tofu', tier: 'unknown', status: 'active' };
  const { acct, scratch } = await setupAccount(harness);
  return runProbe(adapter, inst, acct, { isolation: 'container', scratchDir: path.join(scratch, 'probe'), live: true, model: base.devModel!, timeoutMs: 180_000 });
}

function report(caps: Capabilities) {
  return caps.probeSteps.map((s) => `${s.ok ? 'ok ' : 'FAIL'} ${s.step}: ${s.detail}`).join('\n');
}

describe.skipIf(!ENABLED)('真实 harness canary', () => {
  it.each([
    ['claude-code', true],
    ['codex', true],
    ['agy', true],
  ] as [HarnessId, boolean][])(
    '%s',
    async (harness, expectNonces) => {
      const caps = await canary(harness);
      const text = report(caps);
      const step = (n: string) => caps.probeSteps.find((s) => s.step === n);
      expect(step('canary.run')?.ok, text).toBe(true);
      expect(step('canary.write')?.ok, text).toBe(true);
      expect(step('canary.receipt')?.ok, text).toBe(true);
      // 真实模型可能多写文件，这里要求 home 配置未被改动
      expect(step('canary.audit')?.detail, text).not.toContain('改动：/');
      if (expectNonces) expect(step('canary.nonce')?.ok, text).toBe(true);
      expect(caps.eventTypesSeen).toEqual(expect.arrayContaining(['init', 'result']));
      expect(caps.models.length).toBeGreaterThan(0);
    },
    240_000,
  );
});
