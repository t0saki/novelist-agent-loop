/**
 * 隔离后端（DESIGN §3.6；D1 替代见 IMPL.md）。Owner: lane A。
 * 实现的后端：
 * - container（默认）：Novelist 容器本身是边界。harness 在 run 的 git worktree 快照里跑，最宽松非交互模式；
 *   run 结束只收割 outDir，快照整个丢弃（越界写自然被丢弃）；home 配置文件 run 后 hash 校验。
 * - bwrap：仅当启动探测 `bwrap --unshare-all --ro-bind / / true` 成功才用；选择性绑定见 DESIGN §3.6 模板。
 * - landlock：只做探测（/sys/kernel/security/lsm + ABI 查询），不实现 nv-jail；探测成功也不选它，doctor 里显示“可用但未实现”。
 * - degraded：兜底；只允许 shellTool=disableable 的 harness。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IsolationBackend, IsolationPreference, IsolationProbe } from '@novelist/shared';
import type { Invocation, RunSpec } from './types.js';
import { sha256FileImpl } from './util.js';

export interface MountPlan {
  /** 只读绑定（bwrap）/ 只读集合 */
  ro: string[];
  /** 可写绑定 */
  rw: string[];
  /** 用 tmpfs 遮蔽的目录（如 $DATA） */
  mask: string[];
}

let cached: { pref: IsolationPreference; probe: IsolationProbe } | null = null;

/** 是否运行在容器内（docker / podman / lxc / k8s） */
export function detectContainer(): boolean {
  if (process.env.NOVELIST_IN_CONTAINER === '1') return true;
  for (const f of ['/.dockerenv', '/run/.containerenv', '/dev/.lxc-boot-id']) if (existsSync(f)) return true;
  try {
    if (readFileSync('/run/systemd/container', 'utf8').trim()) return true;
  } catch {
    /* none */
  }
  try {
    if (/docker|kubepods|containerd|lxc|libpod/.test(readFileSync('/proc/1/cgroup', 'utf8'))) return true;
  } catch {
    /* none */
  }
  return !!process.env.container;
}

function probeBwrap(): { ok: boolean; detail: string } {
  const bin = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find((p) => existsSync(p));
  if (!bin) return { ok: false, detail: '未安装 bubblewrap' };
  const r = spawnSync(
    bin,
    ['--die-with-parent', '--new-session', '--unshare-all', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', 'true'],
    { timeout: 5000, encoding: 'utf8' },
  );
  if (r.status === 0) return { ok: true, detail: `${bin} 可创建用户命名空间` };
  return { ok: false, detail: (r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 300) };
}

function readLsm(): string[] {
  try {
    return readFileSync('/sys/kernel/security/lsm', 'utf8')
      .trim()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 探测各后端可用性并按偏好选出一个（结果缓存在内存，doctor 可强制刷新） */
export async function probeIsolation(pref: IsolationPreference, opts?: { refresh?: boolean }): Promise<IsolationProbe> {
  if (cached && cached.pref === pref && !opts?.refresh) return cached.probe;
  const inContainer = detectContainer();
  const bw = probeBwrap();
  const lsm = readLsm();
  const landlockOn = lsm.includes('landlock');
  const backends: IsolationProbe['backends'] = [
    {
      backend: 'bwrap',
      available: bw.ok,
      detail: bw.detail,
      ...(bw.ok
        ? {}
        : { fixHint: inContainer ? '容器内通常需要 security_opt: [systempaths=unconfined] + 放行 unshare 的 seccomp/apparmor；目标主机上预期不可用' : '确认 kernel.unprivileged_userns_clone=1' }),
    },
    {
      backend: 'landlock',
      available: false,
      detail: landlockOn ? 'LSM 已启用 landlock，但 nv-jail 未实现（D1：只做探测）' : lsm.length ? `LSM 列表未含 landlock（${lsm.join(',')}）` : '无法读取 /sys/kernel/security/lsm',
      ...(landlockOn ? {} : { fixHint: 'Proxmox 宿主机内核命令行加 lsm=landlock,lockdown,yama,integrity,apparmor' }),
    },
    {
      backend: 'container',
      available: inContainer || pref === 'container',
      detail: inContainer ? '运行在容器内：容器边界 + 每 run 快照 + 只收割 out/' : pref === 'container' ? '未检测到容器，但已显式指定 container 档' : '未检测到容器环境',
    },
    { backend: 'degraded', available: true, detail: '无 OS 级读写边界；只允许无 shell 的 harness（cc/agy/grok）' },
  ];
  const avail = (b: IsolationBackend) => backends.find((x) => x.backend === b)?.available ?? false;
  let selected: IsolationBackend;
  if (pref === 'auto') selected = avail('bwrap') ? 'bwrap' : avail('container') ? 'container' : 'degraded';
  else if (pref === 'landlock') selected = avail('bwrap') ? 'bwrap' : avail('container') ? 'container' : 'degraded';
  else selected = avail(pref) ? pref : avail('container') ? 'container' : 'degraded';
  const probe: IsolationProbe = {
    ts: new Date().toISOString(),
    selected,
    preference: pref,
    backends,
    kernel: os.release(),
    lsm,
    landlockAbi: null,
    inContainer,
  };
  cached = { pref, probe };
  return probe;
}

/** $DATA 根：$DATA/runs/YYYY-MM/<runId> → 上三级 */
export function dataRootOf(spec: Pick<RunSpec, 'runDir'>): string {
  return path.resolve(spec.runDir, '..', '..', '..');
}

/** worktree 快照的 .git 是文件（gitdir: …/books/<slug>/.git/worktrees/<id>）→ 返回 live 仓库 .git 目录 */
function liveGitDirOf(bookDir: string): string | null {
  try {
    const dotgit = path.join(bookDir, '.git');
    if (!lstatSync(dotgit).isFile()) return null;
    const m = readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/);
    if (!m) return null;
    const wt = path.resolve(bookDir, m[1]!.trim());
    // …/.git/worktrees/<id> → …/.git
    return path.resolve(wt, '..', '..');
  } catch {
    return null;
  }
}

/** 计算本 run 的挂载计划（§3.6：$RUN/book ro、outDir rw、$RUN/in ro、$RUN/log rw、home state rw、harness 安装目录 ro…） */
export function mountPlanFor(spec: RunSpec, homeStateDirs: string[], extraRo: string[]): MountPlan {
  const ro = new Set<string>();
  const rw = new Set<string>();
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const liveGit = liveGitDirOf(spec.bookDir);
  if (liveGit) ro.add(liveGit);
  // 整个书快照归作者使用（收割走快照目录）；live .git 与 $RUN/in 仍只读
  rw.add(spec.bookDir);
  ro.add(spec.inDir);
  for (const p of extraRo) {
    ro.add(p);
    ro.add(real(p));
  }
  rw.add(spec.outDir);
  rw.add(spec.logDir);
  for (const d of homeStateDirs) rw.add(d);
  return { ro: [...ro], rw: [...rw], mask: [dataRootOf(spec)] };
}

/** 用隔离后端包装 invocation（bwrap：前缀 bwrap argv；container/degraded：原样返回并校验 cwd/outDir） */
export function wrapInvocation(inv: Invocation, backend: IsolationBackend, plan: MountPlan): Invocation {
  if (backend !== 'bwrap') {
    // container / degraded：没有挂载表；把计划并入 read/writePaths 供契约测试与审计展示
    return { ...inv, argv: [...inv.argv], env: { ...inv.env }, readPaths: [...new Set([...inv.readPaths, ...plan.ro])], writePaths: [...new Set([...inv.writePaths, ...plan.rw])] };
  }
  const a: string[] = ['bwrap', '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--info-fd', '3'];
  a.push('--ro-bind', '/usr', '/usr');
  for (const d of ['bin', 'sbin', 'lib', 'lib64']) {
    const p = `/${d}`;
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) a.push('--symlink', path.relative('/', realpathSync(p)), p);
      else if (st.isDirectory()) a.push('--ro-bind', p, p);
    } catch {
      /* 不存在 */
    }
  }
  for (const f of ['/etc/ssl', '/etc/ca-certificates', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime', '/etc/passwd', '/etc/group', '/etc/alternatives'])
    a.push('--ro-bind-try', f, f);
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const m of plan.mask) a.push('--tmpfs', m);
  // 只读在前、可写在后（可写目录可能嵌在只读目录内，如 $RUN/book/work/…/out）
  const byDepth = (x: string, y: string) => x.split('/').length - y.split('/').length;
  for (const p of [...plan.ro].sort(byDepth)) a.push('--ro-bind-try', p, p);
  for (const p of [...plan.rw].sort(byDepth)) a.push('--bind-try', p, p);
  a.push('--chdir', inv.cwd, '--');
  return {
    ...inv,
    argv: [...a, ...inv.argv],
    env: { ...inv.env },
    readPaths: [...new Set([...inv.readPaths, ...plan.ro])],
    writePaths: [...new Set([...inv.writePaths, ...plan.rw])],
  };
}

/** 某 harness 在某后端下是否允许运行（degraded 拒绝 shellTool=always；pi 拒绝 degraded/container） */
export function isAllowed(harnessShellTool: 'disableable' | 'always', harness: string, backend: IsolationBackend): { ok: boolean; reason?: string } {
  if (harness === 'pi' && (backend === 'degraded' || backend === 'container')) {
    return { ok: false, reason: 'pi 没有自带沙箱，只在 bwrap / landlock 档运行' };
  }
  if (backend === 'degraded' && harnessShellTool === 'always') {
    return { ok: false, reason: `${harness} 的 shell 工具无法关闭，degraded 档（无 OS 边界）拒绝运行` };
  }
  return { ok: true };
}

/** run 后审计（§3.6）：home 配置 hash 不变（旧契约的“out/ 清单 ⊆ 声明”已删除，extraFiles 恒为 []） */
export async function postRunAudit(input: { homeConfigHashes: Record<string, string> }): Promise<{ ok: boolean; extraFiles: string[]; tamperedConfig: string[] }> {
  const extraFiles: string[] = [];
  const tamperedConfig: string[] = [];
  for (const [p, h] of Object.entries(input.homeConfigHashes)) {
    try {
      if ((await sha256FileImpl(p)) !== h) tamperedConfig.push(p);
    } catch {
      tamperedConfig.push(p);
    }
  }
  return { ok: tamperedConfig.length === 0, extraFiles, tamperedConfig };
}

/** 测试用：清空探测缓存 */
export function _resetIsolationCache(): void {
  cached = null;
}
