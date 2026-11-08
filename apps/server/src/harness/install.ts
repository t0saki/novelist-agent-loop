/**
 * harness 安装（DESIGN §3.8；D1 务实替代）。Owner: lane A。
 * 安装到持久卷：$DATA/harness/<id>/<version>/（npm 分发的用 `npm i --prefix`，agy 用官方 installer 下载的单二进制），
 * 再把可执行文件软链到 $DATA/harness/bin/<bin>；版本与 sha256（TOFU）写 harness_installs 表与 $DATA/harness/harness.lock.yaml。
 * 关闭自动更新（DISABLE_AUTOUPDATER=1、GROK_DISABLE_AUTOUPDATER=1 等）。UI“安装”按钮调用它（后台任务，输出流式给 UI）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessId, HarnessInstall } from '@novelist/shared';
import { zHarnessInstall } from '@novelist/shared';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import type { DataPaths } from '../config/index.js';
import { getAdapter } from './registry.js';
import { atomicWrite, parseVersion, satisfies, sha256FileImpl, shQuote, whichSync } from './util.js';

export interface InstallPlan {
  harness: HarnessId;
  version: string;
  /** 将要执行的命令（UI 先展示） */
  commands: string[][];
  /** 安装目录 $DATA/harness/<id>/<version> */
  prefix?: string;
  /** 安装后可执行文件位置（相对 prefix） */
  binRel?: string;
  /** 软链目标 $DATA/harness/bin/<bin> */
  binLink?: string;
  /** 安装来源（写入 lock） */
  source?: string;
}

/** npm 包与可执行文件（§3.8 harness.lock.yaml 的 source） */
export const HARNESS_PACKAGES: Partial<Record<HarnessId, { pkg?: string; bin: string; installer?: string }>> = {
  'claude-code': { pkg: '@anthropic-ai/claude-code', bin: 'claude' },
  codex: { pkg: '@openai/codex', bin: 'codex' },
  grok: { pkg: '@xai-official/grok', bin: 'grok' },
  dsh: { pkg: '@deepseek-ai/dsh', bin: 'dsh' },
  pi: { pkg: '@earendil-works/pi-coding-agent', bin: 'pi' },
  agy: { bin: 'agy', installer: 'https://antigravity.google/cli/install.sh' },
};

/** 默认锁定版本（DESIGN §3.5/§3.8） */
export const PINNED_VERSIONS: Partial<Record<HarnessId, string>> = {
  'claude-code': '2.1.319',
  codex: '0.167.0',
  agy: '1.5.3',
  grok: '1.0.77',
  dsh: '0.2.2-rc.1',
  pi: '1.5.0',
};

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/** 版本号只允许 npm 版本字符（拒绝 ../、$()、npm:alias 等） */
export function isValidHarnessVersion(v: string): boolean {
  return VERSION_RE.test(v);
}

export function planInstall(paths: DataPaths, harness: HarnessId, version: string): InstallPlan {
  const meta = HARNESS_PACKAGES[harness];
  if (!meta) throw new Error(`${harness} 不支持自动安装`);
  const ver = version || PINNED_VERSIONS[harness] || 'latest';
  if (!isValidHarnessVersion(ver)) throw new Error(`非法的版本号：${ver}`);
  const prefix = path.join(paths.harness, harness, ver);
  const binLink = path.join(paths.harness, 'bin', meta.bin);
  if (meta.pkg) {
    const npm = whichSync('npm') ?? 'npm';
    return {
      harness,
      version: ver,
      prefix,
      binRel: path.join('node_modules', '.bin', meta.bin),
      binLink,
      source: `npm:${meta.pkg}@${ver}`,
      commands: [
        ['mkdir', '-p', prefix],
        [npm, 'install', '--prefix', prefix, '--no-fund', '--no-audit', '--omit=dev', `${meta.pkg}@${ver}`],
      ],
    };
  }
  // agy：官方 installer 装到隔离 HOME（不改 PATH、不建别名），二进制在 <prefix>/home/.local/bin/agy
  return {
    harness,
    version: ver,
    prefix,
    binRel: path.join('home', '.local', 'bin', meta.bin),
    binLink,
    source: `installer:${meta.installer}`,
    commands: [
      ['mkdir', '-p', path.join(prefix, 'home')],
      ['bash', '-c', `set -euo pipefail; curl -fsSL ${shQuote(meta.installer ?? '')} | HOME=${shQuote(path.join(prefix, 'home'))} bash -s -- --skip-aliases --skip-path`],
    ],
  };
}

function pickEnv(keys: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of keys) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}

function runCmd(argv: string[], env: NodeJS.ProcessEnv, onOutput: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) return resolve(1);
    if (cmd === 'mkdir') {
      fs.mkdir(args[args.length - 1]!, { recursive: true }).then(
        () => resolve(0),
        (e) => {
          onOutput(`mkdir 失败：${(e as Error).message}`);
          resolve(1);
        },
      );
      return;
    }
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const pipe = (d: Buffer) => {
      for (const l of d.toString('utf8').split('\n')) if (l.trim()) onOutput(l);
    };
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    child.on('error', (e) => {
      onOutput(`启动失败：${e.message}`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function installHarness(paths: DataPaths, plan: InstallPlan, onOutput: (line: string) => void): Promise<HarnessInstall> {
  // 白名单 env：npm postinstall 和 curl|bash 是第三方代码，绝不能拿到 NOVELIST_MASTER_KEY / DATABASE_URL 等
  const env: NodeJS.ProcessEnv = {
    ...pickEnv(['PATH', 'LANG', 'LC_ALL', 'TZ', 'http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']),
    HOME: path.join(plan.prefix ?? paths.harness, 'home'),
    npm_config_cache: path.join(plan.prefix ?? paths.harness, '.npm-cache'),
    DISABLE_AUTOUPDATER: '1',
    GROK_DISABLE_AUTOUPDATER: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
  };
  for (const c of plan.commands) {
    onOutput(`$ ${c.join(' ')}`);
    const code = await runCmd(c, env, onOutput);
    if (code !== 0) throw new Error(`安装命令失败（exit ${code}）：${c.join(' ')}`);
  }
  if (!plan.prefix || !plan.binRel || !plan.binLink) throw new Error('安装计划缺少 prefix/binRel/binLink');
  const bin = path.join(plan.prefix, plan.binRel);
  if (!existsSync(bin)) throw new Error(`安装完成但找不到可执行文件：${bin}`);
  await fs.mkdir(path.dirname(plan.binLink), { recursive: true });
  await fs.rm(plan.binLink, { force: true });
  await fs.symlink(bin, plan.binLink);
  onOutput(`已链接 ${plan.binLink} → ${bin}`);
  const adapter = getAdapter(plan.harness);
  const detected = await adapter.detect(path.dirname(plan.binLink));
  const version = detected?.version ?? parseVersion(plan.version) ?? plan.version;
  const sha = await sha256FileImpl(await fs.realpath(bin));
  const inst = zHarnessInstall.parse({
    id: plan.harness,
    version,
    binPath: plan.binLink,
    ...(plan.source?.startsWith('npm:') ? { nodeVersion: process.versions.node } : {}),
    sha256: sha,
    sha256Source: 'tofu',
    tier: 'unknown',
    status: satisfies(version, adapter.supportedVersions) ? 'active' : 'candidate',
  });
  await writeLockEntry(paths, inst, plan.source ?? '');
  onOutput(`${plan.harness} ${version} 安装完成（sha256 ${sha.slice(0, 12)}…，TOFU）`);
  return inst;
}

/** 更新 $DATA/harness/harness.lock.yaml 中一条记录 */
export async function writeLockEntry(paths: DataPaths, inst: HarnessInstall, source: string): Promise<void> {
  const file = path.join(paths.harness, 'harness.lock.yaml');
  let cur: Record<string, unknown> = {};
  try {
    cur = (parseYaml(await fs.readFile(file, 'utf8')) as Record<string, unknown>) ?? {};
  } catch {
    /* new */
  }
  cur[inst.id] = {
    version: inst.version,
    node: inst.nodeVersion ?? null,
    source,
    sha256: inst.sha256,
    sha256_source: inst.sha256Source,
    tier: inst.tier,
    status: inst.status,
    installed_at: new Date().toISOString(),
  };
  await atomicWrite(file, `# Novelist harness 锁定表（DESIGN §3.8）\n${yamlStringify(cur)}`);
}
