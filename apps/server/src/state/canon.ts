/** 规范 JSON（键排序、去 undefined）与 hash。fold / ledgerHash / pack hash 的确定性基础。Owner: lane B。 */
import { createHash } from 'node:crypto';

export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortDeep(v));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortDeep(x)));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      const x = o[k];
      if (x === undefined) continue;
      out[k] = sortDeep(x);
    }
    return out;
  }
  return v;
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** 结构化深拷贝（只含 JSON 值） */
export function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
