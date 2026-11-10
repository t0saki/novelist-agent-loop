/** handler 共用：书上下文、manifest（hard/soft blob sha + configHash）。从旧流水线的 common 迁来，只留 v3 用得到的部分。 */
import { createHash } from 'node:crypto';
import type { BookHandle, Manifest, PipelineContext, TaskSpec } from './types.js';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 规范 JSON（键排序、去 undefined），configHash 的确定性基础 */
function canonicalJson(v: unknown): string {
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

export function requireBook(ctx: PipelineContext): BookHandle {
  if (!ctx.book) throw new Error('该任务需要 book 上下文');
  return ctx.book;
}

export interface ManifestOpts {
  hard?: string[];
  soft?: string[];
  extra?: Record<string, unknown>;
}

/** 影响产物内容的配置 hash：实例号、模式、handler 的 extra、题材包版本（旧流程的 gates / scale / tier 已不参与，P3 D2） */
async function configHash(book: BookHandle | null, spec: TaskSpec, extra: Record<string, unknown> = {}): Promise<string> {
  const content: Record<string, unknown> = {
    instance: spec.params?.instance ?? null,
    params: spec.params?.mode ?? null,
    ...extra,
  };
  if (book) content.genre = book.genre.chain.map((g) => `${g.id}@${g.pack.version}`);
  return sha256(canonicalJson(content));
}

/** 按 HEAD 取 blob sha（不存在 → ''，stale check 约定） */
export async function buildManifest(ctx: PipelineContext, spec: TaskSpec, opts: ManifestOpts): Promise<Manifest> {
  const book = ctx.book;
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  const hard = uniq(opts.hard ?? []);
  const soft = uniq(opts.soft ?? []).filter((p) => !hard.includes(p));
  let hardShas: Record<string, string> = {};
  let softShas: Record<string, string> = {};
  if (book) {
    const head = await book.repo.head();
    [hardShas, softShas] = await Promise.all([book.repo.blobShas(hard, head), book.repo.blobShas(soft, head)]);
  }
  return { hard: hardShas, soft: softShas, configHash: await configHash(book, spec, opts.extra) };
}
