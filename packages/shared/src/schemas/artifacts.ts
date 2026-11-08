/** agent / validator 产物：receipt / check / review / audit / validated / pairwise / patches（附录 A） */
import { z } from 'zod';
import { zChapterId } from '../ids.js';
import { zDelta, zDeltaOp } from './delta.js';

/**
 * nv.receipt/1：所有 harness 都必须写 out/receipt.json（§5.5）。以文件为准，zod 宽松校验（passthrough）。
 * nonces：agent 回显 system.md 中看到的所有 NV-*-HEAD/TAIL-* 串。
 */
export const zReceipt = z
  .object({
    schema: z.literal('nv.receipt/1'),
    task_id: z.string().optional(),
    status: z.enum(['done', 'blocked', 'failed']),
    artifacts: z.array(z.object({ path: z.string(), kind: z.string().optional() })).default([]),
    nonces: z.array(z.string()).default([]),
    title_proposal: z.string().optional(),
    questions_for_planner: z.array(z.string()).default([]),
    self_count: z.object({ total: z.number().int().optional(), beats: z.record(z.string(), z.number().int()).optional() }).optional(),
    notes: z.string().optional(),
  })
  .passthrough();
export type Receipt = z.infer<typeof zReceipt>;

/** chapter.check（lite 默认）产物：delta + 轻量 continuity_flags（≤10，每条带逐字引文） */
export const zContinuityFlag = z.object({
  kind: z.enum(['dead_reappears', 'knowledge_leak', 'location_jump', 'time_jump', 'item_conflict', 'must_not', 'other']),
  quote: z.string().min(1),
  message: z.string(),
  ents: z.array(z.string()).default([]),
});
export type ContinuityFlag = z.infer<typeof zContinuityFlag>;
export const zCheckOutput = z.object({
  schema: z.literal('nv.check/1'),
  chapter: zChapterId,
  delta: zDelta,
  continuity_flags: z.array(zContinuityFlag).max(10).default([]),
});
export type CheckOutput = z.infer<typeof zCheckOutput>;

export const zFinding = z.object({
  id: z.string(),
  severity: z.enum(['hard', 'soft']),
  category: z.string(),
  quote: z.string().optional(),
  message: z.string(),
  suggestion: z.string().optional(),
  /** true 的建议不得进入 revision_brief（§6.4） */
  conflicts_with_author_layer: z.boolean().default(false),
  verified: z.boolean().optional(),
});
export type Finding = z.infer<typeof zFinding>;

/** reviews/cNNNNN.json（入库）：review run 结果 + 降级记录 + gate/check 摘要 */
export const zReview = z.object({
  schema: z.literal('nv.review/1'),
  chapter: zChapterId,
  tier: z.enum(['lite', 'standard', 'key']),
  verdict: z.enum(['pass', 'revise', 'block', 'accept_with_debt', 'hold']),
  scores: z.record(z.string(), z.number()).default({}),
  findings: z.array(zFinding).default([]),
  missing_ops: z.array(zDeltaOp).default([]),
  continuity_flags: z.array(zContinuityFlag).default([]),
  reviewers: z.array(z.object({ role: z.string(), profile: z.string(), model: z.string().optional(), run: z.string().optional() })).default([]),
  /** 每一次降级（§7.4），UI 标黄 */
  degraded: z.array(z.object({ role: z.string(), from: z.string(), to: z.string(), reason: z.string() })).default([]),
  revisions: z.number().int().default(0),
  gate_summary: z.array(z.object({ rule: z.string(), level: z.string(), ok: z.boolean(), detail: z.string().optional() })).default([]),
});
export type Review = z.infer<typeof zReview>;

export const zAudit = z.object({
  schema: z.literal('nv.audit/1'),
  kind: z.enum(['window', 'window_model', 'arc', 'volume', 'heldout', 'fresh_reader']),
  range: z.tuple([zChapterId, zChapterId]),
  ts: z.string(),
  passed: z.boolean(),
  snapshot_hash_ok: z.boolean().optional(),
  findings: z.array(zFinding).default([]),
  metrics: z.record(z.string(), z.number()).default({}),
  runs: z.array(z.string()).default([]),
});
export type Audit = z.infer<typeof zAudit>;

export const zGateResult = z.object({
  rule: z.string(),
  /** contract 类不可关闭 */
  family: z.enum(['contract', 'craft']),
  level: z.enum(['hard', 'soft', 'off']),
  ok: z.boolean(),
  /** 规则来自哪一层（生效 gate 清单着色用） */
  source: z.enum(['novelist', 'builtin', 'global', 'genre', 'book']),
  detail: z.string().optional(),
  spans: z.array(z.object({ start: z.number().int(), end: z.number().int(), text: z.string().optional() })).default([]),
  measured: z.record(z.string(), z.number()).optional(),
});
export type GateResult = z.infer<typeof zGateResult>;

/** attempt-k/VALIDATED.json：committer 崩溃恢复用 */
export const zValidated = z.object({
  schema: z.literal('nv.validated/1'),
  task_id: z.string(),
  run_id: z.string(),
  attempt: z.number().int(),
  ok: z.boolean(),
  ts: z.string(),
  gates: z.array(zGateResult),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })),
});
export type Validated = z.infer<typeof zValidated>;

export const zPairwise = z.object({
  schema: z.literal('nv.pairwise/1'),
  chapter: zChapterId,
  a: z.string(),
  b: z.string(),
  winner: z.enum(['a', 'b', 'tie']),
  reasons: z.array(z.string()).default([]),
});
export type Pairwise = z.infer<typeof zPairwise>;

/** stylist / editor span-patch：find 必须唯一命中 */
export const zPatches = z.object({
  schema: z.literal('nv.patches/1'),
  chapter: zChapterId,
  patches: z.array(z.object({ find: z.string().min(1), replace: z.string(), reason: z.string().optional() })),
});
export type Patches = z.infer<typeof zPatches>;
