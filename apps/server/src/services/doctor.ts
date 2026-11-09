/** doctor（§3.6、§9.3）：隔离探测、DB、磁盘、系统工具（git/rg/bwrap）、harness、访问协议、主密钥。Owner: lane G。 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import type { DoctorReport, HarnessId } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { ping } from '../db/client.js';
import { profiles } from '../db/schema.js';
import { detectInstalls, listAdapters, probeIsolation } from '../harness/index.js';
import { loadSystemSettings } from '../orchestrator/index.js';

const execFileAsync = promisify(execFile);
const MIN_FREE_BYTES = 5 * 1024 ** 3;

async function toolVersion(cmd: string, args: string[]): Promise<{ ok: boolean; version: string | null; detail?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 5000, maxBuffer: 1024 * 1024 });
    return { ok: true, version: `${stdout}${stderr}`.split('\n')[0]?.trim() || null };
  } catch (e) {
    return { ok: false, version: null, detail: (e as { code?: string }).code === 'ENOENT' ? '未安装' : (e as Error).message };
  }
}

export async function runDoctor(deps: AppDeps, opts?: { refresh?: boolean; requestProtocol?: 'http' | 'https' }): Promise<DoctorReport> {
  const settings = await loadSystemSettings(deps.db);
  const isolation = await probeIsolation(settings.isolation, opts?.refresh ? { refresh: true } : undefined);
  const hints: string[] = [];

  let db: DoctorReport['db'];
  try {
    const version = await ping(deps.dbh);
    const applied = (await deps.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as { rows?: { n: number }[] } | { n: number }[];
    const n = (Array.isArray(applied) ? applied : (applied.rows ?? []))[0]?.n ?? 0;
    db = { kind: deps.dbh.kind, ok: true, version, migrations: `${n} applied` };
  } catch (e) {
    db = { kind: deps.dbh.kind, ok: false, version: '', migrations: (e as Error).message };
    hints.push('数据库不可用：检查 NOVELIST_DATABASE_URL');
  }

  const disk: DoctorReport['disk'] = [];
  for (const p of [deps.paths.root]) {
    try {
      const s = await fs.statfs(p);
      const freeBytes = s.bavail * s.bsize;
      disk.push({ path: p, freeBytes, ok: freeBytes >= MIN_FREE_BYTES });
      if (freeBytes < MIN_FREE_BYTES) hints.push(`磁盘剩余不足 5GB：${p}`);
    } catch {
      disk.push({ path: p, freeBytes: 0, ok: false });
    }
  }

  const tools: DoctorReport['tools'] = [];
  for (const [name, args] of [
    ['git', ['--version']],
    ['rg', ['--version']],
    ['bwrap', ['--version']],
    ['script', ['--version']],
  ] as const) {
    const r = await toolVersion(name, [...args]);
    tools.push({ name, ...r });
    if (!r.ok && (name === 'git' || name === 'rg')) hints.push(`缺少系统工具：${name}`);
  }

  const installs = await detectInstalls(deps.config.harnessDir);
  const harnesses: DoctorReport['harnesses'] = listAdapters()
    .filter((a) => a.id !== 'fake' || deps.config.allowFakeHarness)
    .map((a) => {
      const inst = installs.find((i) => i.id === a.id);
      return { id: a.id as HarnessId, ok: !!inst, detail: inst ? `${inst.version}（${inst.binPath}）` : '未安装' };
    });
  if (harnesses.every((h) => !h.ok)) hints.push('没有检测到任何 harness：在“Harness 与账号”页安装，或设置 NOVELIST_HARNESS_DIR');

  // 残余风险（DESIGN §10.6 的独立 uid / 分角色 DB 未实现）：明确告知，不做无法兑现的承诺
  if (isolation.selected !== 'bwrap') hints.push('隔离档为 container：harness 与服务同 uid，带 shell 的 agent（codex、dsh）能读 /data 下的主密钥和数据库连接串，且没有出网限制。容器是唯一边界，请只运行你信任的 harness/账号；import.bootstrap 已固定不走带 shell 的 profile。');
  hints.push('未启用 TOTP 二次验证（DESIGN §10.6 的管理面缓解项之一，已记录延后）。管理面暴露到公网时请确保 NPM 走 HTTPS 并使用强密码。');
  if (isolation.selected === 'degraded') hints.push('隔离后端回落到 degraded：检查容器配置（见 isolation.backends 的 fixHint）');

  const protocol = opts?.requestProtocol ?? 'https';
  let warning: string | null = null;
  if (deps.config.insecureCookies) {
    warning = '当前为局域网 http 模式（NOVELIST_INSECURE_COOKIES=1），cookie 不带 Secure。';
    hints.push('仅在可信局域网使用 NOVELIST_INSECURE_COOKIES=1');
  } else if (protocol === 'http') {
    warning = '当前通过 http 访问；反代应设置 X-Forwarded-Proto，否则登录 cookie 不带 Secure。';
    hints.push('检查反向代理是否传 X-Forwarded-Proto，或使用 NOVELIST_INSECURE_COOKIES=1（局域网）');
  }
  return {
    ts: new Date().toISOString(),
    isolation,
    db,
    disk,
    tools,
    harnesses,
    access: { protocol, trustProxy: deps.config.trustProxy !== false, insecureCookies: deps.config.insecureCookies, warning },
    masterKey: { source: deps.masterKeySource, ok: true },
    hints,
  };
}
