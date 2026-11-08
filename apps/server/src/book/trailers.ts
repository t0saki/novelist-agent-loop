/** commit trailer（DESIGN §4.4、§7.7）。Owner: lane B。 */
export const TRAILER = {
  task: 'Novelist-Task',
  run: 'Novelist-Run',
  harness: 'Novelist-Harness',
  model: 'Novelist-Model',
  instructions: 'Novelist-Instructions',
  snapshotHash: 'Novelist-Snapshot-Hash',
  isolation: 'Novelist-Isolation',
  migration: 'Novelist-Migration',
  owner: 'Novelist-Owner-Edit',
} as const;

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * 渲染 trailer 块（`Key: value` 每行一条）。顺序：TRAILER 中已知键按声明顺序在前，其余按字典序；
 * value 中的换行折叠为空格（trailer 必须单行）。空值跳过。
 */
export function formatTrailers(t: Record<string, string>): string {
  const known = Object.values(TRAILER) as string[];
  const keys = Object.keys(t).filter((k) => t[k] !== undefined && t[k] !== null && String(t[k]).trim() !== '');
  for (const k of keys) if (!KEY_RE.test(k)) throw new Error(`invalid trailer key: ${k}`);
  keys.sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return keys
    .map(
      (k) =>
        `${k}: ${String(t[k])
          .replace(/\s*[\r\n]+\s*/g, ' ')
          .trim()}`,
    )
    .join('\n');
}

/**
 * 解析提交信息末尾段落中的 trailer。只认最后一个空行之后、且每一行都是 `Key: value` 的段落
 * （与 git interpret-trailers 的规则一致；续行以空白开头时拼接）。重复键取最后一个。
 */
export function parseTrailers(message: string): Record<string, string> {
  const text = message.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const paras = text.split(/\n[ \t]*\n/);
  if (paras.length < 2) {
    // 只有一段：仅当整段都是 trailer 且不是主题行时才算（主题行永远不是 trailer）
    return {};
  }
  const last = paras[paras.length - 1] ?? '';
  const out: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of last.split('\n')) {
    if (/^[ \t]+\S/.test(line) && lastKey) {
      out[lastKey] = `${out[lastKey]} ${line.trim()}`;
      continue;
    }
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
    if (!m) return {};
    lastKey = m[1] as string;
    out[lastKey] = (m[2] ?? '').trim();
  }
  return out;
}
