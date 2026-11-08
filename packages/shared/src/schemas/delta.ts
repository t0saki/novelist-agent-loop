/**
 * nv.delta/1（DESIGN §4.2）：账本 state/ledger/cNNNNN.json 的格式；也是 chapter.check / chapter.extract 的产物。
 * snapshot = fold(ledger[*], overrides)（lane B）。delta.check（lane D）逐条核对 ev。
 */
import { z } from 'zod';
import {
  ENTITY_KINDS,
  zChapterId,
  zArcId,
  zEntityRef,
  zFactRef,
  zObligationRef,
} from '../ids.js';

/** ev = 草稿中的逐字引文（统一空白与标点后匹配；失败走模糊匹配） */
const ev = z.string().min(1);
const evOpt = ev.optional();

export const zStoryTime = z
  .object({
    year: z.number().int().optional(),
    day: z.number().int().optional(),
    hour: z.number().int().min(0).max(23).optional(),
    calendar: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();
export type StoryTime = z.infer<typeof zStoryTime>;

export const zEntityCreateOp = z.object({
  op: z.literal('entity.create'),
  ent: zEntityRef,
  kind: z.enum(ENTITY_KINDS),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  tier: z.enum(['major', 'minor', 'extra']).optional(),
  /** 卡片是否计划了该实体（未计划的发明按 policy.unplanned_invention 处理） */
  declared: z.boolean().default(false),
  set: z.record(z.string(), z.unknown()).optional(),
  ev,
});
export const zEntityUpdateOp = z.object({
  op: z.literal('entity.update'),
  ent: zEntityRef,
  /** 只比较 id 类和枚举类字段（loc、owner、status、title、realm）；条件类用 cond+ / cond- 按集合 */
  from: z.record(z.string(), z.unknown()).optional(),
  set: z.record(z.string(), z.unknown()),
  ev,
});
export const zEntityRetireOp = z.object({
  op: z.literal('entity.retire'),
  ent: zEntityRef,
  how: z.enum(['death', 'departure', 'destroyed', 'other']),
  ev,
});
export const zEventOp = z.object({
  op: z.literal('event'),
  id: z.string(),
  who: z.array(zEntityRef).default([]),
  what: z.string().min(1),
  loc: zEntityRef.optional(),
  ev,
});
export const zFactAssertOp = z.object({
  op: z.literal('fact.assert'),
  fact: zFactRef,
  text: z.string().min(1),
  about: z.array(zEntityRef).default([]),
  ev,
});
export const zKnowledgeLearnOp = z.object({
  op: z.literal('knowledge.learn'),
  who: zEntityRef,
  fact: zFactRef,
  how: z.string().optional(),
  ev,
});
export const zReaderRevealOp = z.object({ op: z.literal('reader.reveal'), fact: zFactRef, ev });
export const zIdentityRevealOp = z.object({
  op: z.literal('identity.reveal'),
  ent: zEntityRef,
  identity: z.string(),
  to: z.union([z.literal('reader'), zEntityRef]),
  ev,
});
export const zObligationOpenOp = z.object({
  op: z.literal('obligation.open'),
  id: zObligationRef,
  kind: z.enum(['foreshadow', 'promise', 'mystery', 'debt', 'setup']),
  weight: z.enum(['main', 'major', 'minor']),
  due: z.tuple([zChapterId, zChapterId]).optional(),
  text: z.string().min(1),
  ev,
});
export const zObligationAdvanceOp = z.object({ op: z.literal('obligation.advance'), id: zObligationRef, note: z.string().optional(), ev });
export const zObligationPayOp = z.object({ op: z.literal('obligation.pay'), id: zObligationRef, ev });
export const zObligationAbandonOp = z.object({ op: z.literal('obligation.abandon'), id: zObligationRef, reason: z.string().min(1), ev: evOpt });
export const zArcStageOp = z.object({ op: z.literal('arc.stage'), who: zEntityRef, stage: z.string().min(1), ev });
export const zArcResolveOp = z.object({ op: z.literal('arc.resolve'), arc: zArcId, ev });
export const zOffscreenUpdateOp = z.object({
  op: z.literal('offscreen.update'),
  ent: zEntityRef,
  set: z.record(z.string(), z.unknown()),
  declared_by_card: z.boolean().default(false),
});
export const zTimeAdvanceOp = z.object({ op: z.literal('time.advance'), to: zStoryTime, flashback: z.boolean().default(false), ev: evOpt });
export const zPowerChangeOp = z.object({
  op: z.literal('power.change'),
  who: zEntityRef,
  system: z.string(),
  from: z.string().optional(),
  to: z.string(),
  ev,
});
export const zItemTransferOp = z.object({
  op: z.literal('item.transfer'),
  item: zEntityRef,
  from: zEntityRef.nullable().optional(),
  to: zEntityRef.nullable(),
  ev,
});
export const zRelationSetOp = z.object({
  op: z.literal('relation.set'),
  a: zEntityRef,
  b: zEntityRef,
  type: z.string(),
  ev,
});
/** 只能由 planner 提议（showrunner/owner 审批），不会出现在 extractor 的 delta 里 */
export const zContractAmendOp = z.object({
  op: z.literal('contract.amend'),
  who: zEntityRef,
  stage: z.string(),
  contract: z.record(z.string(), z.unknown()),
  reason: z.string(),
});

export const zDeltaOp = z.discriminatedUnion('op', [
  zEntityCreateOp,
  zEntityUpdateOp,
  zEntityRetireOp,
  zEventOp,
  zFactAssertOp,
  zKnowledgeLearnOp,
  zReaderRevealOp,
  zIdentityRevealOp,
  zObligationOpenOp,
  zObligationAdvanceOp,
  zObligationPayOp,
  zObligationAbandonOp,
  zArcStageOp,
  zArcResolveOp,
  zOffscreenUpdateOp,
  zTimeAdvanceOp,
  zPowerChangeOp,
  zItemTransferOp,
  zRelationSetOp,
  zContractAmendOp,
]);
export type DeltaOp = z.infer<typeof zDeltaOp>;
export type DeltaOpType = DeltaOp['op'];
/** 关键 op：ev 缺失时定向补抽，不丢弃（§6.6） */
export const KEY_OP_TYPES: readonly DeltaOpType[] = [
  'knowledge.learn',
  'obligation.open',
  'obligation.pay',
  'entity.create',
  'entity.retire',
  'reader.reveal',
  'identity.reveal',
];

export const zSummarySentence = z.object({
  s: z.string().min(1),
  /** "op:<index>" 或 "ev:<逐字引文>" */
  anchors: z.array(z.string()).default([]),
});

export const zDelta = z.object({
  schema: z.literal('nv.delta/1'),
  chapter: zChapterId,
  card_blob: z.string().optional(),
  base_ledger_hash: z.string().optional(),
  mode: z.enum(['full', 'diff']).default('full'),
  summary: z.array(zSummarySentence).default([]),
  beats_realized: z.array(z.object({ beat: z.string(), ev: z.string() })).default([]),
  ops: z.array(zDeltaOp).default([]),
  uses_knowledge: z.array(z.object({ who: zEntityRef, fact: zFactRef, ev: z.string() })).default([]),
  /** 实际写出的场面类型（patterns.md 的来源，§4.3） */
  realized_patterns: z.array(z.string()).default([]),
  entities_present: z.array(zEntityRef).default([]),
});
export type Delta = z.infer<typeof zDelta>;

/** 卡片 post / must_not 里的“op 模式”：给出 op 类型和部分字段，匹配 delta 中任一 op */
export const zOpPattern = z.object({ op: z.string().min(1) }).catchall(z.unknown());
export type OpPattern = z.infer<typeof zOpPattern>;
