/** API 契约：时间一律 ISO8601。drizzle mode:'string' 给的是 pg 文本格式（`2026-11-08 09:51:47.721+00`），移动端 Safari 解析不了。 */
const PG_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/;

export function isoDeep<T>(value: T): T {
  if (typeof value === 'string') return (PG_TS.test(value) ? new Date(value).toISOString() : value) as T;
  if (Array.isArray(value)) return value.map(isoDeep) as T;
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value) || value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = isoDeep(v);
    return out as T;
  }
  return value;
}
