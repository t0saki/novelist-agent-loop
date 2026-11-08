/**
 * ID 约定（DESIGN §4.2）。全部是纯函数，可被任何模块直接使用。
 * 章：c00421；卷：v03；弧：a0012；伏笔/义务：F0057；实体：<kind 前缀>.<拼音-kebab>；事实：fact.<kebab>；
 * 临时 id（planner/extractor 提交，committer promote 时映射）：tmp:<局部名>。
 */
import { z } from 'zod';

export const CHAPTER_ID_RE = /^c\d{5}$/;
export const VOLUME_ID_RE = /^v\d{2,3}$/;
export const ARC_ID_RE = /^a\d{4}$/;
export const OBLIGATION_ID_RE = /^F\d{4,5}$/;
export const ENTITY_KINDS = ['character', 'location', 'faction', 'item', 'concept'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const ENTITY_PREFIX: Record<EntityKind, string> = {
  character: 'char',
  location: 'loc',
  faction: 'fac',
  item: 'item',
  concept: 'concept',
};
/** <prefix>.<slug>，slug 允许小写字母数字与 -，可带 -2 序号 */
export const ENTITY_ID_RE = /^(char|loc|fac|item|concept)\.[a-z0-9][a-z0-9-]*$/;
export const FACT_ID_RE = /^fact\.[a-z0-9][a-z0-9.-]*$/;
export const IDENTITY_ID_RE = /^ident\.[a-z0-9][a-z0-9-]*$/;
export const TMP_ID_RE = /^tmp:[^\s]+$/;

export const zChapterId = z.string().regex(CHAPTER_ID_RE, '章 id 形如 c00421');
export const zVolumeId = z.string().regex(VOLUME_ID_RE, '卷 id 形如 v03');
export const zArcId = z.string().regex(ARC_ID_RE, '弧 id 形如 a0012');
export const zObligationId = z.string().regex(OBLIGATION_ID_RE, '伏笔 id 形如 F0057');
export const zTmpId = z.string().regex(TMP_ID_RE, '临时 id 形如 tmp:xxx');
export const zEntityId = z.string().regex(ENTITY_ID_RE, '实体 id 形如 char.lin-feng');
export const zFactId = z.string().regex(FACT_ID_RE, '事实 id 形如 fact.su-wan-spy');
/** 引用位置可以是正式 id 或 tmp id */
export const zEntityRef = z.union([zEntityId, zTmpId]);
export const zFactRef = z.union([zFactId, zTmpId]);
export const zObligationRef = z.union([zObligationId, zTmpId]);

export type ChapterId = string;
export type VolumeId = string;
export type ArcId = string;
export type ObligationId = string;
export type EntityId = string;
export type FactId = string;
export type TmpId = `tmp:${string}`;

const pad = (n: number, w: number) => String(n).padStart(w, '0');
export const chapterId = (n: number): ChapterId => `c${pad(n, 5)}`;
export const volumeId = (n: number): VolumeId => `v${pad(n, 2)}`;
export const arcId = (n: number): ArcId => `a${pad(n, 4)}`;
export const obligationId = (n: number): ObligationId => `F${pad(n, 4)}`;

function parseNo(id: string, re: RegExp, kind: string): number {
  if (!re.test(id)) throw new Error(`invalid ${kind} id: ${id}`);
  return Number.parseInt(id.slice(1), 10);
}
export const chapterNo = (id: ChapterId) => parseNo(id, CHAPTER_ID_RE, 'chapter');
export const volumeNo = (id: VolumeId) => parseNo(id, VOLUME_ID_RE, 'volume');
export const arcNo = (id: ArcId) => parseNo(id, ARC_ID_RE, 'arc');
export const obligationNo = (id: ObligationId) => parseNo(id, OBLIGATION_ID_RE, 'obligation');
export const isTmpId = (s: string): s is TmpId => TMP_ID_RE.test(s);

/** git tag 名（DESIGN §4.4） */
export const tags = {
  chapter: (n: number) => `ch/${pad(n, 5)}`,
  volumeEnd: (n: number) => `vol/${pad(n, 2)}-end`,
  published: (n: number) => `pub/${pad(n, 5)}`,
};
