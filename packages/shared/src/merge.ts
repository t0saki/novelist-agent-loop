/**
 * 配置层合并（附录 A：book > genre > global > builtin；按键深合并，数组整体替换）。
 * layers 顺序：低优先级在前，高优先级在后。undefined 不覆盖；null 覆盖。
 */
export type PlainObject = Record<string, unknown>;
const isPlain = (v: unknown): v is PlainObject => typeof v === 'object' && v !== null && !Array.isArray(v);

export function mergeLayers<T = PlainObject>(...layers: (PlainObject | undefined | null)[]): T {
  let out: PlainObject = {};
  for (const layer of layers) if (layer) out = mergeTwo(out, layer);
  return out as T;
}

function mergeTwo(a: PlainObject, b: PlainObject): PlainObject {
  const out: PlainObject = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlain(prev) && isPlain(v) ? mergeTwo(prev, v) : v;
  }
  return out;
}
