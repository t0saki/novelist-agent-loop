/**
 * 能力探测与版本管理（DESIGN §3.8）。Owner: lane A。
 * probe 结果写 capabilities 表（harness, version, isolation）；fixtures 录到 $DATA/harness/fixtures/<id>/<ver>/。
 *
 * 实现：
 * - detectInstalls：每个 adapter.detect → HarnessInstall（sha256 TOFU，按 path+size+mtime 缓存；tier/status 取 harness.lock.yaml，
 *   没有锁记录时 tier=unknown，版本落在 supportedVersions 内则 status=active —— IMPL §5：目标主机上不强制先 canary）。
 * - runProbe：adapter.probe（--version / --help flag 扫描 / 列模型）+ ctx.live 时跑目录探测（runDirectoryCanary：照 ORDER.md 写文件、带回 AGENTS.md 的暗号），
 *   并把原始流录成 fixture。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { statSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CanaryResult, Capabilities, HarnessId, HarnessInstall, IsolationBackend } from '@novelist/shared';
import { V3_LAUNCH_PROMPT, zCapabilities, zHarnessInstall } from '@novelist/shared';
import { parse as parseYaml } from 'yaml';
import { V3_CLAUDE_MD } from '../instructions/v3.js';
import { capsFrom } from './adapters/common.js';
import { getAdapter, listAdapters } from './registry.js';
import { startRun } from './runner.js';
import type { HarnessAdapter, ProbeContext, ResolvedAccount, RunSpec } from './types.js';
import { satisfies, sha256FileImpl } from './util.js';

const shaCache = new Map<string, { key: string; sha: string }>();
async function cachedSha(p: string): Promise<string> {
  try {
    const real = realpathSync(p);
    const st = statSync(real);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = shaCache.get(real);
    if (hit && hit.key === key) return hit.sha;
    const sha = await sha256FileImpl(real);
    shaCache.set(real, { key, sha });
    return sha;
  } catch {
    return '';
  }
}

type LockEntry = { version?: string; tier?: HarnessInstall['tier']; status?: HarnessInstall['status']; sha256?: string; sha256_source?: string; node?: string };

/** $DATA/harness/harness.lock.yaml（harnessDir = $DATA/harness/bin 的上一级） */
export async function readHarnessLock(harnessDir: string): Promise<Record<string, LockEntry>> {
  for (const p of [path.join(path.dirname(harnessDir), 'harness.lock.yaml'), path.join(harnessDir, 'harness.lock.yaml')]) {
    try {
      const v = parseYaml(await fs.readFile(p, 'utf8')) as Record<string, LockEntry> | null;
      if (v && typeof v === 'object') return v;
    } catch {
      /* none */
    }
  }
  return {};
}

const NPM_HARNESSES = new Set(['codex', 'dsh', 'pi']);

/** 找到所有已安装 harness（adapter.detect），合并 harness_installs 表 */
export async function detectInstalls(harnessDir: string): Promise<HarnessInstall[]> {
  const lock = await readHarnessLock(harnessDir);
  const out: HarnessInstall[] = [];
  const results = await Promise.all(
    listAdapters().map(async (a) => {
      try {
        return { a, d: await a.detect(harnessDir) };
      } catch {
        return { a, d: null };
      }
    }),
  );
  for (const { a, d } of results) {
    if (!d) continue;
    const l = lock[a.id];
    const lockMatches = l?.version === d.version;
    const sha = a.id === 'fake' ? '' : await cachedSha(d.binPath);
    out.push(
      zHarnessInstall.parse({
        id: a.id,
        version: d.version,
        binPath: d.binPath,
        ...(NPM_HARNESSES.has(a.id) ? { nodeVersion: process.versions.node } : {}),
        sha256: sha,
        sha256Source: l?.sha256_source === 'upstream-lock' && lockMatches ? 'upstream-lock' : 'tofu',
        tier: lockMatches && l?.tier ? l.tier : a.id === 'fake' ? 'probed' : 'unknown',
        status: lockMatches && l?.status ? l.status : satisfies(d.version, a.supportedVersions) ? 'active' : 'candidate',
      }),
    );
  }
  return out;
}

export async function runProbe(adapter: HarnessAdapter, inst: HarnessInstall, acct: ResolvedAccount, ctx: ProbeContext & { effort?: string }): Promise<Capabilities> {
  await fs.mkdir(ctx.scratchDir, { recursive: true });
  let caps = await adapter.probe(inst, acct, ctx);
  if (ctx.live) caps = (await runDirectoryCanary(adapter, inst, acct, ctx, caps)).caps;
  return zCapabilities.parse(caps);
}

/** 没有 probe 记录时使用的默认能力（来自研究文档的已知事实；标记 unverified） */
export function defaultCapabilities(harness: HarnessId, version: string, isolation: IsolationBackend): Capabilities {
  const a = getAdapter(harness);
  if (!a.defaults) throw new Error(`${harness} 没有默认能力表`);
  return { ...capsFrom(a.defaults, version, isolation), probeSteps: [{ step: 'defaults', ok: true, detail: 'unverified：来自调研文档的默认能力，尚未 probe' }] };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function rand12(): string {
  const b = randomBytes(12);
  let s = '';
  for (const x of b) s += B32[x % 32];
  return s;
}

/** 目录探测的任务单第一行（fake harness 认这一行） */
export const CANARY_ORDER_LINE = '在当前目录写一个文件 canary.txt，第一行写';

/**
 * 目录探测（canary，§3.8 第 4 步，按 v3 的目录契约）：临时书房 $scratch/runs/canary/<id>/book 里放
 * AGENTS.md（带一个暗号）、CLAUDE.md（@AGENTS.md）和 ORDER.md（写 canary.txt：第一行标记，第二行暗号），启动语 = V3_LAUNCH_PROMPT。
 * 步骤：canary.run（正常结束）、canary.write（canary.txt 含标记）、canary.agents（canary.txt 含 AGENTS.md 的暗号 = 指令文件真的被读到）。
 * 返回的能力：workspaceDocLoaded = tailNonceSurvives = honouredAgents（后者只为旧 schema 兼容保留）。
 */
export async function runDirectoryCanary(
  adapter: HarnessAdapter,
  inst: HarnessInstall,
  acct: ResolvedAccount,
  ctx: ProbeContext & { model?: string; effort?: string },
  caps: Capabilities,
): Promise<{ caps: Capabilities; result: CanaryResult }> {
  const steps = [...caps.probeSteps];
  const fail = (detail: string): { caps: Capabilities; result: CanaryResult } => {
    steps.push({ step: 'canary', ok: false, detail });
    return { caps: { ...caps, probeSteps: steps }, result: { ok: false, steps, wroteFile: false, honouredAgents: false, toolSteps: 0 } };
  };
  const runId = randomUUID();
  const runDir = path.join(ctx.scratchDir, 'runs', 'canary', runId);
  const inDir = path.join(runDir, 'in');
  const logDir = path.join(runDir, 'log');
  const bookDir = path.join(runDir, 'book');
  const outDir = path.join(bookDir, 'work', 'canary', 'attempt-1', 'out');
  const marker = `NOVELIST-CANARY-${rand12()}`;
  const code = `NV-CANARY-${randomBytes(6).toString('hex')}`;
  let spec: RunSpec;
  try {
    for (const d of [inDir, logDir, outDir]) await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(bookDir, 'AGENTS.md'), `这是探测运行。读 ORDER.md 并照做。\n暗号：${code}\n`);
    await fs.writeFile(path.join(bookDir, 'CLAUDE.md'), V3_CLAUDE_MD);
    await fs.writeFile(path.join(bookDir, 'ORDER.md'), `${CANARY_ORDER_LINE} ${marker}，第二行写 AGENTS.md 里的暗号。不要做别的事。\n`);
    const workOrderFile = path.join(inDir, 'launch.md');
    await fs.writeFile(workOrderFile, V3_LAUNCH_PROMPT);
    spec = {
      runId,
      taskId: `canary-${runId.slice(0, 8)}`,
      attempt: 1,
      role: 'canary',
      taskKind: 'canary',
      harness: adapter.id,
      profileId: `canary-${adapter.id}`,
      accountId: acct.id,
      bookSlug: null,
      runDir,
      bookDir,
      outDir,
      inDir,
      logDir,
      workOrderFile,
      model: ctx.model ?? adapter.devModel ?? caps.models[0] ?? 'default',
      ...(ctx.effort ? { effort: ctx.effort } : {}),
      limits: { wallMs: ctx.timeoutMs ?? 5 * 60_000, idleMs: Math.min(ctx.timeoutMs ?? 5 * 60_000, 3 * 60_000), maxTurns: 12 },
      session: { mode: 'fresh', id: runId },
      persistSession: false,
      egress: { allow: [] },
      extraArgs: [],
    };
  } catch (e) {
    return fail(`准备失败：${(e as Error).message}`);
  }
  const types = new Set<string>(caps.eventTypesSeen);
  try {
    const h = await startRun({ spec, adapter, account: acct, install: inst, caps, isolation: ctx.isolation }, { onEvent: (e) => void types.add(e.t) });
    const res = await h.wait();
    const ran = res.outcome.status === 'completed';
    steps.push({ step: 'canary.run', ok: ran, detail: `${res.outcome.status}${res.outcome.errorClass ? ` / ${res.outcome.errorClass}` : ''}${res.outcome.message ? `：${res.outcome.message.slice(0, 200)}` : ''}` });
    const txt = await fs.readFile(path.join(bookDir, 'canary.txt'), 'utf8').catch(() => '');
    const wroteFile = txt.split('\n')[0]?.includes(marker) ?? false;
    const honouredAgents = txt.includes(code);
    steps.push({ step: 'canary.write', ok: wroteFile, detail: txt ? txt.slice(0, 80) : '未写出 canary.txt' });
    steps.push({ step: 'canary.agents', ok: honouredAgents, detail: honouredAgents ? 'canary.txt 里有 AGENTS.md 的暗号' : 'canary.txt 里没有 AGENTS.md 的暗号（指令文件可能没被读到）' });
    if (ctx.fixturesDir) {
      await fs.mkdir(ctx.fixturesDir, { recursive: true });
      await fs.copyFile(res.stdoutFile, path.join(ctx.fixturesDir, `canary-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`)).catch(() => {});
    }
    return {
      caps: { ...caps, workspaceDocLoaded: honouredAgents, tailNonceSurvives: honouredAgents, eventTypesSeen: [...types], verifiedAt: new Date().toISOString(), probeSteps: steps },
      result: { ok: ran && wroteFile && honouredAgents, steps, wroteFile, honouredAgents, toolSteps: res.toolSteps },
    };
  } catch (e) {
    return fail((e as Error).message.slice(0, 300));
  }
}
