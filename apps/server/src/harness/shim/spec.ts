/**
 * nv-shim 规格（DESIGN §2.3）。D1 替代：无 Go 工具链 → nv-shim 是一个 detached 的 Node 脚本（shim/nv-shim.ts）。
 * runner 写 $RUN/in/spec.json 后用 `setsid`/`detached:true` 启动 shim；shim 的 stdio 全部重定向到文件，
 * 父进程（serve）崩溃不影响 harness；新 runner 通过 pid + 启动时间重新接管（reattachRun）。
 */
export interface ShimSpec {
  schema: 'nv.shim/1';
  runId: string;
  argv: string[];
  /** 不含秘密的 env（秘密在 envFile，shim 读后立即删除） */
  env: Record<string, string>;
  cwd: string;
  stdin: 'devnull' | { file: string };
  /** $RUN/log/stdout.ndjson */
  stdoutFile: string;
  /** $RUN/log/stderr.log */
  stderrFile: string;
  /** $RUN/log/pid：{"shimPid":n,"harnessPid":n,"startedAt":iso,"bootId":…} */
  pidFile: string;
  /** $RUN/log/exit.json（原子写：tmp + rename）：ShimExit */
  exitFile: string;
  /** $RUN/log/heartbeat：每次 stdout/stderr 有输出时 touch（idle 计时） */
  heartbeatFile: string;
  wallMs: number;
  idleMs: number;
  /** 依次发送的停止信号（发给 harness pid 及其进程组） */
  stop: { signal: 'SIGINT' | 'SIGTERM'; graceMs: number }[];
  /** cc --include-partial-messages 的 delta 采样：每 N ms 最多落盘 1 行 partial（0 = 不过滤） */
  partialSampleMs: number;
  /** 0600 的秘密 env 文件（JSON 对象）；shim 读取后删除，合并到 env */
  envFile?: string;
  /** bwrap 档：argv 含 `--info-fd 3`，shim 从 fd 3 读出沙箱内 child-pid，信号直接发给它 */
  infoFd?: boolean;
  /** 轮询间隔（ms，默认 250；测试可调小） */
  tickMs?: number;
}

export interface ShimExit {
  code: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  timedOut: 'wall' | 'idle' | null;
  killed: 'user' | 'shutdown' | null;
  /** 收到 $RUN/log/kill 文件（runner 请求终止）时置 user */
  /** spawn 失败（可执行文件不存在等） */
  spawnError?: string;
}

export interface ShimPidInfo {
  shimPid: number;
  harnessPid: number | null;
  /** bwrap 档：沙箱内 harness 在外层命名空间的 pid */
  innerPid?: number | null;
  startedAt: string;
  bootId: string | null;
  /** /proc/<pid>/stat 第 22 字段（启动时钟滴答）：pid 复用检测 */
  shimStart: string | null;
  harnessStart: string | null;
}

/** runner 请求终止：写这个文件（内容为原因），shim 轮询到后执行 stop 序列 */
export const KILL_FILE = 'kill';
