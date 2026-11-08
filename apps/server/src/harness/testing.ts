/**
 * lane A 测试夹具：搭一个最小 $DATA/runs/… 目录 + work order + system.md + fake 账号/安装/能力，
 * 让 E/F/G 的测试能直接 startRun(fake)。Owner: lane A。只在测试中使用。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Capabilities, HarnessId, HarnessInstall, RoleId, TaskKind } from '@novelist/shared';
import { toJsonSchema, zReceipt } from '@novelist/shared';
import { stringify as yamlStringify } from 'yaml';
import type { CompiledInstructions } from '../instructions/types.js';
import { FAKE_VERSION } from './adapters/fake.js';
import type { FakeArtifactDecl, FakeScenario } from './fake/fake-harness.js';
import { defaultCapabilities } from './probe.js';
import { getAdapter } from './registry.js';
import type { PreparedRun } from './runner.js';
import type { ResolvedAccount, RunLimits, RunSpec } from './types.js';

export interface RunFixtureOptions {
  /** $DATA 根（默认 mkdtemp） */
  dataRoot?: string;
  harness?: HarnessId;
  model?: string;
  kind?: TaskKind;
  role?: RoleId;
  target?: string;
  bookSlug?: string | null;
  artifacts?: FakeArtifactDecl[];
  /** 写进 frontmatter.fake */
  fake?: FakeScenario;
  /** 写进 $RUN/in/fake.json（覆盖 frontmatter.fake） */
  scenarioFile?: FakeScenario;
  inputs?: { path: string; kind: string; description?: string }[];
  body?: string;
  systemMd?: string;
  limits?: Partial<RunLimits>;
  account?: Partial<ResolvedAccount>;
  isolation?: Capabilities['isolation'];
}

export interface RunFixture {
  dataRoot: string;
  spec: RunSpec;
  prepared: PreparedRun;
  cleanup(): Promise<void>;
}

const DEFAULT_ARTIFACTS: FakeArtifactDecl[] = [
  { path: 'manuscript/c00001.md', kind: 'chapter_draft', length: { min: 240, target: 300, max: 360, count_mode: 'han' } },
  { path: 'receipt.json', kind: 'receipt', schema: 'nv.receipt/1' },
];

export function compiledFromSystem(systemMd: string): CompiledInstructions {
  return {
    systemMd,
    mirrorMd: systemMd.replace(/NV-[A-Za-z0-9]+-(HEAD|TAIL)-[A-Za-z0-9]+/g, ''),
    layers: [],
    nonces: {},
    stackHash: 'test',
    bytes: Buffer.byteLength(systemMd),
    lastAuthorLayerId: 'L3',
  };
}

export async function makeRunFixture(o: RunFixtureOptions = {}): Promise<RunFixture> {
  const own = !o.dataRoot;
  const dataRoot = o.dataRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'nv-a-')));
  const runId = randomUUID();
  const runDir = path.join(dataRoot, 'runs', '2026-11', runId);
  const inDir = path.join(runDir, 'in');
  const logDir = path.join(runDir, 'log');
  const bookDir = path.join(runDir, 'book');
  const taskId = `task-${runId.slice(0, 8)}`;
  const outDir = path.join(bookDir, 'work', taskId, 'attempt-1', 'out');
  for (const d of [inDir, logDir, outDir]) await fs.mkdir(d, { recursive: true });
  const harness = o.harness ?? 'fake';
  const fm: Record<string, unknown> = {
    schema: 'nv.workorder/1',
    task_id: taskId,
    run_id: runId,
    kind: o.kind ?? 'chapter.write',
    role: o.role ?? 'writer',
    book: o.bookSlug === undefined ? 'demo' : o.bookSlug,
    target: o.target ?? 'c00001',
    out_dir: outDir,
    inputs: o.inputs ?? [],
    artifacts: o.artifacts ?? DEFAULT_ARTIFACTS,
    ...(o.fake ? { fake: o.fake } : {}),
  };
  const workOrderFile = path.join(inDir, 'workorder.md');
  await fs.writeFile(workOrderFile, `---\n${yamlStringify(fm)}---\n\n${o.body ?? '# 测试任务\n\n- id: b1\n- id: b2\n- id: b3\n'}`);
  if (o.scenarioFile) await fs.writeFile(path.join(inDir, 'fake.json'), JSON.stringify(o.scenarioFile));
  const systemMd = o.systemMd ?? 'NV-C-HEAD-AAAAAAAAAAAA\n# 契约\nNV-B-HEAD-BBBBBBBBBBBB\n书层指令\nNV-B-TAIL-CCCCCCCCCCCC\n';
  const systemFile = path.join(inDir, 'system.md');
  await fs.writeFile(systemFile, systemMd);
  const receiptSchemaFile = path.join(inDir, 'receipt.lenient.json');
  await fs.writeFile(receiptSchemaFile, JSON.stringify(toJsonSchema(zReceipt, 'lenient')));
  const spec: RunSpec = {
    runId,
    taskId,
    attempt: 1,
    role: o.role ?? 'writer',
    taskKind: o.kind ?? 'chapter.write',
    harness,
    profileId: `${harness}-test`,
    accountId: 'acc-test',
    bookSlug: o.bookSlug === undefined ? 'demo' : o.bookSlug,
    runDir,
    bookDir,
    outDir,
    inDir,
    logDir,
    workOrderFile,
    systemFile,
    receiptSchemaFile,
    model: o.model ?? 'fake-model',
    limits: { wallMs: 60_000, idleMs: 30_000, maxTurns: 10, ...o.limits },
    session: { mode: 'fresh', id: runId },
    persistSession: false,
    egress: { allow: [] },
    subagents: false,
    extraArgs: [],
  };
  const home = path.join(dataRoot, 'accounts', 'acc-test', 'home');
  await fs.mkdir(home, { recursive: true });
  const account: ResolvedAccount = {
    id: 'acc-test',
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
    ...o.account,
  };
  const adapter = getAdapter(harness);
  const install: HarnessInstall = {
    id: harness,
    version: harness === 'fake' ? FAKE_VERSION : '0.0.0',
    binPath: harness === 'fake' ? process.execPath : `/usr/bin/${harness}`,
    sha256: '',
    sha256Source: 'tofu',
    tier: 'probed',
    status: 'active',
  };
  const caps = defaultCapabilities(harness, install.version, o.isolation ?? 'container');
  const prepared: PreparedRun = { spec, adapter, account, install, caps, isolation: o.isolation ?? 'container', compiled: compiledFromSystem(systemMd) };
  return {
    dataRoot,
    spec,
    prepared,
    async cleanup() {
      if (own) await fs.rm(dataRoot, { recursive: true, force: true });
    },
  };
}
