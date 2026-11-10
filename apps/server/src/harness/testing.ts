/**
 * harness 测试夹具：搭一个最小 $DATA/runs/… 目录（目录契约：书快照里有 AGENTS.md / CLAUDE.md / ORDER.md，$RUN/in/launch.md 是启动语）
 * + fake 账号/安装/能力，让测试能直接 startRun(fake)。只在测试中使用。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Capabilities, HarnessId, HarnessInstall, RoleId } from '@novelist/shared';
import { V3_LAUNCH_PROMPT } from '@novelist/shared';
import { V3_CLAUDE_MD } from '../instructions/v3.js';
import { FAKE_VERSION } from './adapters/fake.js';
import type { FakeScenario } from './fake/fake-harness.js';
import { defaultCapabilities } from './probe.js';
import { getAdapter } from './registry.js';
import type { PreparedRun } from './runner.js';
import type { ResolvedAccount, RunLimits, RunSpec } from './types.js';

export interface RunFixtureOptions {
  /** $DATA 根（默认 mkdtemp） */
  dataRoot?: string;
  harness?: HarnessId;
  model?: string;
  kind?: string;
  role?: RoleId;
  bookSlug?: string | null;
  /** 书快照根的 ORDER.md（默认：新写第 1–1 章，每章不少于 300 字） */
  order?: string;
  /** 书快照根的 AGENTS.md */
  agentsMd?: string;
  /** 书快照里另放的文件（相对路径 → 内容） */
  files?: Record<string, string>;
  /** 写进 $RUN/in/fake.json（与 scenarioFile 合并，后者优先） */
  fake?: FakeScenario;
  /** 写进 $RUN/in/fake.json */
  scenarioFile?: FakeScenario;
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

export const DEFAULT_FIXTURE_ORDER = '# 任务单\n\n任务：新写第 1–1 章（共 1 章）\n\n进度：已写 0 章；计划共 3 章。每章不少于 300 字，不设上限。\n';

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
  await fs.writeFile(path.join(bookDir, 'AGENTS.md'), o.agentsMd ?? '# 写作指令\n\n测试用的书房约定。\n');
  await fs.writeFile(path.join(bookDir, 'CLAUDE.md'), V3_CLAUDE_MD);
  await fs.writeFile(path.join(bookDir, 'ORDER.md'), o.order ?? DEFAULT_FIXTURE_ORDER);
  for (const [rel, content] of Object.entries(o.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(bookDir, rel)), { recursive: true });
    await fs.writeFile(path.join(bookDir, rel), content);
  }
  const workOrderFile = path.join(inDir, 'launch.md');
  await fs.writeFile(workOrderFile, V3_LAUNCH_PROMPT);
  const scenario = o.fake || o.scenarioFile ? { ...(o.fake ?? {}), ...(o.scenarioFile ?? {}) } : null;
  if (scenario) await fs.writeFile(path.join(inDir, 'fake.json'), JSON.stringify(scenario));
  const spec: RunSpec = {
    runId,
    taskId,
    attempt: 1,
    role: o.role ?? 'writer',
    taskKind: o.kind ?? 'book.write',
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
    model: o.model ?? 'fake-model',
    limits: { wallMs: 60_000, idleMs: 30_000, maxTurns: 10, ...o.limits },
    session: { mode: 'fresh', id: runId },
    persistSession: false,
    egress: { allow: [] },
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
  const prepared: PreparedRun = { spec, adapter, account, install, caps, isolation: o.isolation ?? 'container' };
  return {
    dataRoot,
    spec,
    prepared,
    async cleanup() {
      if (own) await fs.rm(dataRoot, { recursive: true, force: true });
    },
  };
}
