/**
 * 真实 CLI 格式验收（opt-in，NOVELIST_REAL_HARNESS=1）：每个 harness 跑一个写作型、一个校对型任务，
 * 核对 receipt、声明路径下的产物、nonce 回显、事件解析、usage 提取。只用 dev 廉价模型。
 *
 * 凭据只读取，不改用户目录：
 * - claude：把 ~/.claude/.credentials.json 的 access token 作为 CLAUDE_CODE_OAUTH_TOKEN（不触发刷新），home 是临时目录。
 * - agy：把 token 文件复制进临时 home（刷新只影响副本）。
 * - codex：custom_api，base_url 与 key 取自 ~/.codex。
 *
 * 用法（必须经 safe-run，逐个跑）：
 *   NOVELIST_REAL_HARNESS=1 [NOVELIST_RECORD_FIXTURES=1] vitest run src/harness/real.format.test.ts -t agy
 * NOVELIST_RECORD_FIXTURES=1 时把脱敏后的原始流录到 adapters/__fixtures__/<harness>/<version>/。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capabilities, HarnessId, HarnessInstall, NEvent } from '@novelist/shared';
import { toJsonSchema, zCheckOutput, zReceipt } from '@novelist/shared';
import { parse as parseToml } from 'smol-toml';
import { stringify as yamlStringify } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { sanitizeStream } from './adapters/sanitize.js';
import { runProbe } from './probe.js';
import { getAdapter } from './registry.js';
import { startRun } from './runner.js';
import { compiledFromSystem } from './testing.js';
import type { ResolvedAccount, RunSpec } from './types.js';

const ENABLED = process.env.NOVELIST_REAL_HARNESS === '1';
const RECORD = process.env.NOVELIST_RECORD_FIXTURES === '1';
const HOME = process.env.HOME ?? os.homedir();
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'adapters', '__fixtures__');
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});


interface Setup {
  acct: ResolvedAccount;
  scratch: string;
  inst: HarnessInstall;
  caps: Capabilities;
  model: string;
}

function account(harness: HarnessId, home: string, o: Partial<ResolvedAccount>): ResolvedAccount {
  return { id: `real-${harness}`, harness, label: '', authMode: 'none', plan: '', enabled: true, env: [], files: [], customModels: [], concurrency: 1, reservePct: 30, windows: [], riskAck: [], notes: '', home, secretEnv: {}, credentialFiles: [], ...o };
}

async function setup(harness: HarnessId): Promise<Setup> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `nv-fmt-${harness}-`));
  dirs.push(scratch);
  const home = path.join(scratch, 'home');
  await fs.mkdir(home, { recursive: true });
  let acct: ResolvedAccount;
  if (harness === 'claude-code') {
    const raw = JSON.parse(await fs.readFile(path.join(HOME, '.claude/.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string; expiresAt: number } };
    if (raw.claudeAiOauth.expiresAt - Date.now() < 10 * 60_000) throw new Error('本机 claude access token 即将过期，先运行一次 claude 让它刷新');
    acct = account(harness, home, { authMode: 'oauth_token', secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: raw.claudeAiOauth.accessToken } });
  } else if (harness === 'agy') {
    const rel = '.gemini/antigravity-cli/antigravity-oauth-token';
    await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(HOME, rel), path.join(home, rel));
    acct = account(harness, home, { authMode: 'credential_file', credentialFiles: [{ relPath: rel, absPath: path.join(home, rel), part: 'state' }] });
  } else {
    const cfg = parseToml(await fs.readFile(path.join(HOME, '.codex/config.toml'), 'utf8')) as { model_provider?: string; model_providers?: Record<string, { base_url?: string }> };
    const baseUrl = cfg.model_providers?.[cfg.model_provider ?? '']?.base_url;
    const auth = JSON.parse(await fs.readFile(path.join(HOME, '.codex/auth.json'), 'utf8')) as { OPENAI_API_KEY?: string };
    if (!baseUrl || !auth.OPENAI_API_KEY) throw new Error('本机 ~/.codex 没有可用的自定义 provider');
    acct = account(harness, home, { authMode: 'custom_api', secretEnv: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: auth.OPENAI_API_KEY } });
  }
  const adapter = getAdapter(harness);
  const found = await adapter.detect('');
  if (!found) throw new Error(`本机没有 ${harness}`);
  const inst: HarnessInstall = { id: harness, version: found.version, binPath: found.binPath, sha256: '', sha256Source: 'tofu', tier: 'unknown', status: 'active' };
  const caps = await runProbe(adapter, inst, acct, { isolation: 'container', scratchDir: path.join(scratch, 'probe'), live: false, model: adapter.devModel! });
  return { acct, scratch, inst, caps, model: adapter.devModel! };
}

const DRAFT = `陈砚把工具箱放在塔基的石阶上。\n\n“灯语又变了。”阿澄说。\n\n三年前的那场风暴里，陈砚已经死在了灯塔下，全城的人都去送了葬。\n\n陈砚抬起头，朝她笑了笑，拧紧了最后一颗螺丝。\n`;

interface Task {
  name: 'writer' | 'checker';
  kind: RunSpec['taskKind'];
  role: RunSpec['role'];
  artifacts: { path: string; kind: string; schema?: string }[];
  body(outDir: string): string;
}

const TASKS: Task[] = [
  {
    name: 'writer',
    kind: 'chapter.write',
    role: 'writer',
    artifacts: [
      { path: 'manuscript/c00001.md', kind: 'chapter_draft' },
      { path: 'receipt.json', kind: 'receipt', schema: 'nv.receipt/1' },
    ],
    body: (out) => `# 任务：写一小段正文（格式验收）

写一段约 300 字的中文小说片段：退休灯塔修理工陈砚夜里发现灯语异常。正文只写入 \`${out}/manuscript/c00001.md\`，第一行不要写标题。

然后写回执 \`${out}/receipt.json\`：
{"schema":"nv.receipt/1","status":"done","artifacts":[{"path":"manuscript/c00001.md","kind":"chapter_draft"}],"nonces":[…系统提示中出现的所有 NV- 开头的标记，原样…],"self_count":{"total":<正文汉字数>}}

正文不要出现在回复里；回复只用一句话说明完成。只写这两个文件，不要创建其他文件。`,
  },
  {
    name: 'checker',
    kind: 'chapter.check',
    role: 'checker',
    artifacts: [
      { path: 'check.json', kind: 'json', schema: 'nv.check/1' },
      { path: 'receipt.json', kind: 'receipt', schema: 'nv.receipt/1' },
    ],
    body: (out) => `# 任务：校对章节（格式验收）

读取草稿 \`manuscript/c00001.md\`（当前工作目录下），只找能用原文证实的硬矛盾（例如已死的人再次出现）。把结果写入 \`${out}/check.json\`，严格是下面这个 JSON 结构：
{"schema":"nv.check/1","chapter":"c00001","delta":{"schema":"nv.delta/1","chapter":"c00001","ops":[],"summary":[]},"continuity_flags":[{"kind":"dead_reappears","quote":"<草稿中的逐字引文>","message":"<一句话说明>","ents":[]}]}

quote 必须是草稿里逐字出现的一句话。然后写回执 \`${out}/receipt.json\`：
{"schema":"nv.receipt/1","status":"done","artifacts":[{"path":"check.json","kind":"json"}],"nonces":[…系统提示中出现的所有 NV- 开头的标记，原样…]}

只写这两个文件，不要修改草稿，不要运行命令。`,
  },
];

async function runTask(s: Setup, t: Task, harness: HarnessId) {
  const runId = crypto.randomUUID();
  const taskId = `fmt-${t.name}-${runId.slice(0, 6)}`;
  const runDir = path.join(s.scratch, 'runs', runId);
  const inDir = path.join(runDir, 'in');
  const logDir = path.join(runDir, 'log');
  const bookDir = path.join(runDir, 'book');
  const outDir = path.join(bookDir, 'work', taskId, 'attempt-1', 'out');
  for (const d of [inDir, logDir, outDir, path.join(bookDir, 'manuscript')]) await fs.mkdir(d, { recursive: true });
  if (t.name === 'checker') await fs.writeFile(path.join(bookDir, 'manuscript/c00001.md'), DRAFT);
  const head = 'NV-B-HEAD-FMT2CHECK1234';
  const tail = 'NV-B-TAIL-FMT2CHECK5678';
  const systemMd = `NV-C-HEAD-FMT2CONTRACT12\n# 作业契约\n\n所有产物只写入工作单声明的路径；回执的 nonces 只从系统提示抄录。\n\nNV-C-TAIL-FMT2CONTRACT34\n\n${head}\n\n# 书层指令\n\n用中文。文件是唯一交付物。\n\n${tail}\n`;
  const fm = { schema: 'nv.workorder/1', task_id: taskId, run_id: runId, kind: t.kind, role: t.role, book: 'fmt', target: 'c00001', out_dir: outDir, inputs: [], artifacts: t.artifacts.map((a) => ({ ...a, required: true })) };
  const workOrderFile = path.join(inDir, 'workorder.md');
  await fs.writeFile(workOrderFile, `---\n${yamlStringify(fm)}---\n\n${t.body(outDir)}\n`);
  const systemFile = path.join(inDir, 'system.md');
  await fs.writeFile(systemFile, systemMd);
  const dialect = s.caps.schemaDialect === 'strict' ? 'strict' : 'lenient';
  const receiptSchemaFile = path.join(inDir, `receipt.${dialect}.json`);
  await fs.writeFile(receiptSchemaFile, JSON.stringify(toJsonSchema(zReceipt, dialect), null, 2));
  const spec: RunSpec = {
    runId, taskId, attempt: 1, role: t.role, taskKind: t.kind, harness, profileId: `fmt-${harness}`, accountId: s.acct.id, bookSlug: 'fmt',
    runDir, bookDir, outDir, inDir, logDir, workOrderFile, systemFile, receiptSchemaFile, model: s.model,
    limits: { wallMs: 280_000, idleMs: 180_000, maxTurns: 12 }, session: { mode: 'fresh', id: runId }, persistSession: false, egress: { allow: [] }, subagents: false, extraArgs: [],
  };
  const events: NEvent[] = [];
  const h = await startRun({ spec, adapter: getAdapter(harness), account: s.acct, install: s.inst, caps: s.caps, isolation: 'container', compiled: compiledFromSystem(systemMd) }, { onEvent: (e) => void events.push(e) });
  const res = await h.wait();
  const receipt = JSON.parse(await fs.readFile(path.join(outDir, 'receipt.json'), 'utf8').catch(() => 'null')) as unknown;
  return { res, events, outDir, bookDir, receipt, head, tail, spec };
}

async function record(harness: HarnessId, version: string, name: string, stdoutFile: string, redact: string[]): Promise<void> {
  if (!RECORD) return;
  const dir = path.join(FIX, harness, version);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.ndjson`), sanitizeStream(await fs.readFile(stdoutFile, 'utf8'), redact));
}

describe.skipIf(!ENABLED)('真实 harness 格式验收', () => {
  describe.each(['claude-code', 'agy', 'codex'] as HarnessId[])('%s', (harness) => {
    it.each(TASKS)(
      '$name',
      async (t) => {
        const s = await setup(harness);
        const r = await runTask(s, t, harness);
        const textOut = r.events.filter((e) => e.t === 'text' && e.channel === 'assistant').map((e) => (e as { delta: string }).delta).join('');
        const summary = { status: r.res.outcome.status, cls: r.res.outcome.errorClass, msg: r.res.outcome.message?.slice(0, 200), usage: r.res.outcome.usage, audit: r.res.audit, seen: [...new Set(r.events.map((e) => e.t))] };
        console.log(`[format] ${harness}/${t.name}:`, JSON.stringify(summary));
        await record(harness, s.inst.version, t.name, r.res.stdoutFile, Object.values(s.acct.secretEnv));

        expect(r.res.outcome.status, JSON.stringify(summary)).toBe('completed');
        expect(r.res.audit.ok, JSON.stringify(summary)).toBe(true);
        expect(r.events.some((e) => e.t === 'init')).toBe(true);
        const usage = r.res.outcome.usage;
        expect(usage.input + (usage.cachedInput ?? 0)).toBeGreaterThan(0);
        expect(usage.output).toBeGreaterThan(0);

        const rec = zReceipt.parse(r.receipt);
        expect(rec.status).toBe('done');
        expect(rec.nonces, '首尾 nonce').toEqual(expect.arrayContaining([r.head, r.tail]));

        if (t.name === 'writer') {
          const text = await fs.readFile(path.join(r.outDir, 'manuscript/c00001.md'), 'utf8');
          const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
          expect(han, text.slice(0, 80)).toBeGreaterThan(150);
          // 正文不进 stdout（agents ALWAYS write outputs to files）
          expect(textOut.includes(text.trim().slice(20, 60))).toBe(false);
        } else {
          const check = zCheckOutput.parse(JSON.parse(await fs.readFile(path.join(r.outDir, 'check.json'), 'utf8')));
          expect(check.continuity_flags.length).toBeGreaterThan(0);
          for (const f of check.continuity_flags) expect(DRAFT.includes(f.quote), f.quote).toBe(true);
          expect(await fs.readFile(path.join(r.bookDir, 'manuscript/c00001.md'), 'utf8')).toBe(DRAFT);
        }
      },
      300_000,
    );
  });
});
