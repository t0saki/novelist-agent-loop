/** 账本旁路与派生状态：overrides / debt / arc-fingerprints / snapshot（DESIGN §4.2、§6.4、§6.10） */
import { z } from 'zod';
import { zArcId, zChapterId, zEntityRef } from '../ids.js';
import { zStoryTime } from './delta.js';

/** state/overrides.jsonl 每行一条。override 优先于 manuscript 原文与 ledger */
export const zOverride = z.object({
  schema: z.literal('nv.override/1'),
  id: z.string(),
  ts: z.string(),
  /** 从哪一章起生效 */
  effective_from: zChapterId,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('op'), chapter: zChapterId, op_index: z.number().int().nonnegative() }),
    z.object({ kind: z.literal('entity'), ent: zEntityRef, field: z.string() }),
    z.object({ kind: z.literal('fact'), fact: z.string() }),
    z.object({ kind: z.literal('obligation'), id: z.string() }),
  ]),
  /** op 目标：replace=替换整条 op、drop=删除；entity/fact/obligation：set 字段 */
  action: z.enum(['replace', 'drop', 'set']),
  value: z.unknown().optional(),
  /** 显示给读者/agent 的更正说明，如“正确为…” */
  note: z.string(),
  author: z.enum(['owner', 'audit', 'repair', 'cascade']),
});
export type Override = z.infer<typeof zOverride>;

/** debt.jsonl：forward-payable（连续性/伏笔，有上限）与 metric-only（文风，仅仪表盘） */
export const zDebt = z.object({
  schema: z.literal('nv.debt/1'),
  id: z.string(),
  ts: z.string(),
  chapter: zChapterId,
  class: z.enum(['forward', 'metric']),
  rule: z.string(),
  detail: z.string(),
  status: z.enum(['open', 'paid', 'waived']).default('open'),
  paid_by: zChapterId.optional(),
});
export type Debt = z.infer<typeof zDebt>;

export const zArcFingerprint = z.object({
  schema: z.literal('nv.arcfp/1'),
  arc: zArcId,
  ts: z.string(),
  features: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])),
  vector: z.array(z.number()).default([]),
});
export type ArcFingerprint = z.infer<typeof zArcFingerprint>;

export const zEntityState = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  alive: z.boolean().default(true),
  retired: z.enum(['death', 'departure', 'destroyed', 'other']).optional(),
  attrs: z.record(z.string(), z.unknown()).default({}),
  conds: z.array(z.string()).default([]),
  stage: z.string().optional(),
  power: z.record(z.string(), z.string()).default({}),
  last_seen: zChapterId.optional(),
  first_seen: zChapterId.optional(),
});
export type EntityState = z.infer<typeof zEntityState>;

export const zObligationState = z.object({
  id: z.string(),
  kind: z.string(),
  weight: z.enum(['main', 'major', 'minor']),
  text: z.string(),
  status: z.enum(['open', 'advanced', 'paid', 'abandoned']),
  opened: zChapterId,
  due: z.tuple([zChapterId, zChapterId]).optional(),
  advances: z.array(zChapterId).default([]),
  closed: zChapterId.optional(),
  open_ev: z.string().optional(),
});
export type ObligationState = z.infer<typeof zObligationState>;

/** views/snapshot.json —— 派生，不入库；snapshot = fold(ledger, overrides) */
export const zSnapshot = z.object({
  schema: z.literal('nv.snapshot/1'),
  through: zChapterId.nullable(),
  ledger_hash: z.string(),
  hash: z.string(),
  time: zStoryTime.optional(),
  entities: z.record(z.string(), zEntityState),
  facts: z.record(z.string(), z.object({ text: z.string(), since: zChapterId, overridden: z.boolean().default(false) })),
  /** who → fact ids */
  knowledge: z.record(z.string(), z.array(z.string())),
  reader_knows: z.array(z.string()).default([]),
  obligations: z.record(z.string(), zObligationState),
  items: z.record(z.string(), z.object({ holder: z.string().nullable() })).default({}),
  relations: z.array(z.object({ a: z.string(), b: z.string(), type: z.string(), since: zChapterId })).default([]),
  arcs_resolved: z.array(zArcId).default([]),
  events: z.array(z.object({ id: z.string(), ch: zChapterId, what: z.string(), who: z.array(z.string()) })).default([]),
  total_cjk: z.number().int().default(0),
});
export type Snapshot = z.infer<typeof zSnapshot>;
