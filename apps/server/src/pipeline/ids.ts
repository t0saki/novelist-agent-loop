/** task id（DESIGN §7.2）= sha256(book, kind, target, hard_manifest_hash, stack_hash, config_hash, pipeline_ver)。Owner: lane E。 */
import { createHash } from 'node:crypto';
import type { Manifest, TaskSpec } from './types.js';

/** pipeline_ver 变化：进行中的 run 不受影响，新任务使用新 id（§10.5） */
export const PIPELINE_VERSION = '2.0.0';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function manifestHash(m: Record<string, string>): string {
  const entries = Object.keys(m)
    .sort()
    .map((k) => `${k}\0${m[k]}`);
  return sha256(entries.join('\n'));
}

/**
 * spec.params 不进 id（DESIGN：params 只是 handler 私有参数）；需要区分同 kind/target 的多个实例
 * （修订轮次、owner 重写等）时，manifest.configHash 里已经包含 params.instance（common.ts buildManifest）。
 */
export function computeTaskId(spec: TaskSpec, manifest: Manifest, stackHash: string): string {
  return sha256([spec.bookId ?? '', spec.kind, spec.target, manifestHash(manifest.hard), stackHash, manifest.configHash, PIPELINE_VERSION].join('\0'));
}
