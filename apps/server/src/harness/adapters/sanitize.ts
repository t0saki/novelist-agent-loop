/**
 * 真实事件流录制成 fixture 前的脱敏（只在 real.format.test 里调用，不进运行时路径）。
 * - 替换账号秘密（redact 列表）、已知 token 形态、绝对路径前缀、邮箱、内部网关域名。
 * - 高频 stream_event 只保留前 30 条，避免 fixture 过大（parser 把它们映射成 heartbeat）。
 */

const TOKEN_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-REDACTED'],
  [/sk-[A-Za-z0-9_-]{20,}/g, 'sk-REDACTED'],
  [/ya29\.[A-Za-z0-9_.-]{10,}/g, 'ya29.REDACTED'],
  [/gsk_[A-Za-z0-9]{10,}/g, 'gsk_REDACTED'],
  [/Bearer\s+[A-Za-z0-9._-]{10,}/g, 'Bearer REDACTED'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT.REDACTED'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com'],
];

/** 路径：临时目录、用户 home、$DATA 前缀统一成占位符，保持 fixture 可比较、不泄露机器信息 */
export function sanitizePaths(line: string): string {
  return line
    .replace(/\/tmp\/claude-\d+\/[^"\\\s:]*?\/(nv-fmt-[a-z-]+-[A-Za-z0-9]+)/g, '/tmp/$1')
    .replace(/\/tmp\/nv-fmt-[a-z-]+-[A-Za-z0-9]+/g, '/SCRATCH')
    .replace(/\/tmp\/claude-\d+\/[^"\\\s]*?\/real\/data/g, '/DATA')
    .replace(/\/home\/[a-z_][a-z0-9_-]*/g, '/HOME');
}

export function sanitizeStream(raw: string, redact: string[] = [], maxPartial = 30): string {
  const secrets = redact.filter((s) => s.length >= 8);
  let partial = 0;
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (line.includes('"type":"stream_event"') && ++partial > maxPartial) continue;
    let l = line;
    for (const s of secrets) l = l.split(s).join('REDACTED');
    for (const [re, rep] of TOKEN_PATTERNS) l = l.replace(re, rep);
    l = sanitizePaths(l).replace(/https?:\/\/[a-z0-9.-]+\.(?:top|xyz)\b/g, 'https://gateway.example');
    out.push(l);
  }
  return `${out.join('\n')}\n`;
}
