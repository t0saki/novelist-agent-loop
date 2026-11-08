/**
 * 能力探测与版本管理（DESIGN §3.8）。Owner: lane A。
 * probe 结果写 capabilities 表（harness, version, isolation）；fixtures 录到 $DATA/harness/fixtures/<id>/<ver>/。
 *
 * 实现：
 * - detectInstalls：每个 adapter.detect → HarnessInstall（sha256 TOFU，按 path+size+mtime 缓存；tier/status 取 harness.lock.yaml，
 *   没有锁记录时 tier=unknown，版本落在 supportedVersions 内则 status=active —— IMPL §5：目标主机上不强制先 canary）。
 * - runProbe：adapter.probe（--version / --help flag 扫描 / 列模型）+ ctx.live 时跑 canary（写文件 + receipt + 回显首尾 nonce），
 *   并把原始流录成 fixture。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { statSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Capabilities, HarnessId, HarnessInstall, IsolationBackend } from '@novelist/shared';
import { toJsonSchema, zCapabilities, zHarnessInstall, zReceipt } from '@novelist/shared';
import { parse as parseYaml } from 'yaml';
import type { CompiledInstructions } from '../instructions/types.js';
import { capsFrom } from './adapters/common.js';
import { getAdapter, listAdapters } from './registry.js';
import { startRun } from './runner.js';
import type { HarnessAdapter, ProbeContext, ResolvedAccount, RunSpec } from './types.js';
import { readJsonFile, satisfies, sha256FileImpl } from './util.js';

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

export async function runProbe(adapter: HarnessAdapter, inst: HarnessInstall, acct: ResolvedAccount, ctx: ProbeContext): Promise<Capabilities> {
  await fs.mkdir(ctx.scratchDir, { recursive: true });
  let caps = await adapter.probe(inst, acct, ctx);
  if (ctx.live) caps = await runCanary(adapter, inst, acct, ctx, caps);
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

/** canary 用的最小 RunSpec + 文件（§3.8 第 4 步：写文件、写 receipt、回显首尾 nonce） */
export async function prepareCanary(
  adapter: HarnessAdapter,
  caps: Capabilities,
  acct: ResolvedAccount,
  ctx: ProbeContext,
): Promise<{ spec: RunSpec; compiled: CompiledInstructions; head: string; tail: string; marker: string }> {
  const runId = randomUUID();
  const runDir = path.join(ctx.scratchDir, 'runs', 'canary', runId);
  const inDir = path.join(runDir, 'in');
  const logDir = path.join(runDir, 'log');
  const bookDir = path.join(runDir, 'book');
  const outDir = path.join(bookDir, 'work', 'canary', 'attempt-1', 'out');
  for (const d of [inDir, logDir, outDir]) await fs.mkdir(d, { recursive: true });
  const head = `NV-B-HEAD-${rand12()}`;
  const tail = `NV-B-TAIL-${rand12()}`;
  const marker = `NOVELIST-CANARY-${rand12()}`;
  const systemMd = `${head}\n\n# 书层指令（canary）\n\n你是 Novelist 的探测代理。完成工作单后，在 receipt.json 的 nonces 数组里原样列出本系统提示中出现的所有以 NV- 开头的标记。不要读取 ${inDir} 下的 system.md。\n\n${tail}\n`;
  const compiled: CompiledInstructions = {
    systemMd,
    mirrorMd: systemMd.replace(head, '').replace(tail, ''),
    layers: [],
    nonces: { L3: { head, tail } },
    stackHash: 'canary',
    bytes: Buffer.byteLength(systemMd),
    lastAuthorLayerId: 'L3',
  };
  const dialect = caps.schemaDialect === 'strict' ? 'strict' : 'lenient';
  const receiptSchemaFile = path.join(inDir, `receipt.${dialect}.json`);
  await fs.writeFile(receiptSchemaFile, JSON.stringify(toJsonSchema(zReceipt, dialect), null, 2));
  const systemFile = path.join(inDir, 'system.md');
  await fs.writeFile(systemFile, systemMd);
  const workOrderFile = path.join(inDir, 'workorder.md');
  const wo = `---
schema: nv.workorder/1
task_id: canary-${runId.slice(0, 8)}
run_id: ${runId}
kind: harness.canary
role: canary
book: null
target: canary
out_dir: ${outDir}
inputs: []
artifacts:
  - path: canary.txt
    kind: markdown
  - path: receipt.json
    kind: receipt
    schema: nv.receipt/1
---

# 探测任务（canary）

1. 在 \`${outDir}/canary.txt\` 写入一行：${marker}
2. 在 \`${outDir}/receipt.json\` 写入 JSON 回执：{"schema":"nv.receipt/1","status":"done","artifacts":[{"path":"canary.txt"}],"nonces":[…系统提示中所有 NV- 标记…]}
3. 只写这两个文件，不要创建其他文件，不要运行命令。
`;
  await fs.writeFile(workOrderFile, wo);
  const spec: RunSpec = {
    runId,
    taskId: `canary-${runId.slice(0, 8)}`,
    attempt: 1,
    role: 'canary',
    taskKind: 'harness.canary',
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
    systemFile,
    receiptSchemaFile,
    model: ctx.model ?? adapter.devModel ?? caps.models[0] ?? 'default',
    limits: { wallMs: ctx.timeoutMs ?? 5 * 60_000, idleMs: Math.min(ctx.timeoutMs ?? 5 * 60_000, 3 * 60_000), maxTurns: 12 },
    session: { mode: 'fresh', id: runId },
    persistSession: false,
    egress: { allow: [] },
    subagents: false,
    extraArgs: [],
  };
  return { spec, compiled, head, tail, marker };
}

async function runCanary(adapter: HarnessAdapter, inst: HarnessInstall, acct: ResolvedAccount, ctx: ProbeContext, caps: Capabilities): Promise<Capabilities> {
  const steps = [...caps.probeSteps];
  let prepared: Awaited<ReturnType<typeof prepareCanary>>;
  try {
    prepared = await prepareCanary(adapter, caps, acct, ctx);
  } catch (e) {
    steps.push({ step: 'canary', ok: false, detail: `准备失败：${(e as Error).message}` });
    return { ...caps, probeSteps: steps };
  }
  const { spec, compiled, head, tail, marker } = prepared;
  const types = new Set<string>(caps.eventTypesSeen);
  try {
    const h = await startRun({ spec, adapter, account: acct, install: inst, caps, isolation: ctx.isolation, compiled }, { onEvent: (e) => void types.add(e.t) });
    const res = await h.wait();
    steps.push({ step: 'canary.run', ok: res.outcome.status === 'completed', detail: `${res.outcome.status}${res.outcome.errorClass ? ` / ${res.outcome.errorClass}` : ''}${res.outcome.message ? `：${res.outcome.message.slice(0, 200)}` : ''}` });
    const txt = await fs.readFile(path.join(spec.outDir, 'canary.txt'), 'utf8').catch(() => '');
    steps.push({ step: 'canary.write', ok: txt.includes(marker), detail: txt ? txt.slice(0, 80) : '未写出 canary.txt' });
    const receipt = (await readJsonFile<{ nonces?: string[] }>(path.join(spec.outDir, 'receipt.json'))) ?? (res.outcome.receipt as { nonces?: string[] } | undefined) ?? null;
    const parsed = zReceipt.safeParse(receipt);
    steps.push({ step: 'canary.receipt', ok: parsed.success, detail: parsed.success ? 'receipt 合法' : '缺少或不合法的 receipt.json' });
    const echoed = new Set(receipt?.nonces ?? []);
    const headOk = echoed.has(head);
    const tailOk = echoed.has(tail);
    steps.push({ step: 'canary.nonce', ok: headOk && tailOk, detail: `head ${headOk ? '✓' : '✗'} tail ${tailOk ? '✓' : '✗'}` });
    steps.push({ step: 'canary.audit', ok: res.audit.ok, detail: res.audit.ok ? 'out/ 清单与 home 配置均正常' : `多余：${res.audit.extraFiles.join(',')} 改动：${res.audit.tamperedConfig.join(',')}` });
    if (ctx.fixturesDir) {
      await fs.mkdir(ctx.fixturesDir, { recursive: true });
      await fs.copyFile(res.stdoutFile, path.join(ctx.fixturesDir, `canary-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`)).catch(() => {});
    }
    return {
      ...caps,
      systemChannelLoaded: headOk || caps.systemChannelLoaded,
      tailNonceSurvives: tailOk,
      eventTypesSeen: [...types],
      verifiedAt: new Date().toISOString(),
      probeSteps: steps,
    };
  } catch (e) {
    steps.push({ step: 'canary', ok: false, detail: (e as Error).message.slice(0, 300) });
    return { ...caps, probeSteps: steps };
  }
}
