// copied verbatim from db19762 (packages/shared/src/schemas/predicate.ts); do not edit — the previous image's schema, used by test/compat.prev-image.test.ts
/**
 * nv.predicate/1（DESIGN §6.1）：有限 AST。用于卡片 pre/post/must_not、compass.ending.final_state。
 * 求值器在 state/predicate.ts（lane B）。实体引用的解析时机由调用方决定（pre 写前、post 抽取后、final_state endgame）。
 */
import { z } from 'zod';
import { zEntityRef, zFactRef, zObligationRef } from '../ids.js';

export const zAttrRef = z.object({ attr: z.tuple([zEntityRef, z.string().min(1)]) }).strict();
const zScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const OBLIGATION_STATUSES = ['open', 'advanced', 'paid', 'abandoned'] as const;

export type Predicate =
  | { eq: [{ attr: [string, string] }, string | number | boolean | null] }
  | { ne: [{ attr: [string, string] }, string | number | boolean | null] }
  | { in: [{ attr: [string, string] }, (string | number | boolean | null)[]] }
  | { knows: [string, string] }
  | { knows_not: [string, string] }
  | { obligation: string; status: (typeof OBLIGATION_STATUSES)[number] }
  | { stage: [string, string] }
  | { at_loc: [string, string] }
  | { alive: string }
  | { dead: string }
  | { has_cond: [string, string] }
  | { and: Predicate[] }
  | { or: Predicate[] }
  | { not: Predicate }
  | { manual: string };

export const zPredicate: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ eq: z.tuple([zAttrRef, zScalar]) }).strict(),
    z.object({ ne: z.tuple([zAttrRef, zScalar]) }).strict(),
    z.object({ in: z.tuple([zAttrRef, z.array(zScalar)]) }).strict(),
    z.object({ knows: z.tuple([zEntityRef, zFactRef]) }).strict(),
    z.object({ knows_not: z.tuple([zEntityRef, zFactRef]) }).strict(),
    z.object({ obligation: zObligationRef, status: z.enum(OBLIGATION_STATUSES) }).strict(),
    z.object({ stage: z.tuple([zEntityRef, z.string()]) }).strict(),
    z.object({ at_loc: z.tuple([zEntityRef, zEntityRef]) }).strict(),
    z.object({ alive: zEntityRef }).strict(),
    z.object({ dead: zEntityRef }).strict(),
    z.object({ has_cond: z.tuple([zEntityRef, z.string()]) }).strict(),
    z.object({ and: z.array(zPredicate) }).strict(),
    z.object({ or: z.array(zPredicate) }).strict(),
    z.object({ not: zPredicate }).strict(),
    z.object({ manual: z.string().min(1) }).strict(),
  ]),
) as z.ZodType<Predicate>;

/** 求值结果：manual 项永远 'manual'；未解析实体为 'unresolved' */
export type PredicateValue = true | false | 'manual' | 'unresolved';
