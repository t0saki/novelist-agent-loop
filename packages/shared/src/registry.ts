/** schema 注册表：名字 → zod。用于 JSON Schema 导出、golden 样例测试、UI 编辑器校验。 */
import { z } from 'zod';
import { zAudit, zCheckOutput, zPairwise, zPatches, zReceipt, zReview, zValidated } from './schemas/artifacts.js';
import { zEntity, zGlossary, zSecret, zWorldRules } from './schemas/bible.js';
import { zBookConfig } from './schemas/book.js';
import { zDelta } from './schemas/delta.js';
import { zGatesFile, zGenrePack, zLexicon, zPacing } from './schemas/genre.js';
import { zArc, zCard, zCharacterArc, zCompass, zObligationPlan, zPlanChange, zStrands, zVolume } from './schemas/plan.js';
import { zPredicate } from './schemas/predicate.js';
import { zArcFingerprint, zDebt, zOverride, zSnapshot } from './schemas/state.js';
import { zAccount } from './config/accounts.js';
import { zProfile, zRoutingPreset } from './config/routing.js';
import { zSystemSettings } from './config/settings.js';
import { zCapabilities } from './harness.js';
import { zWorkOrderFrontmatter } from './schemas/workorder.js';
import { zNEvent } from './events.js';

export const SCHEMAS = {
  'nv.book/1': zBookConfig,
  'nv.compass/1': zCompass,
  'nv.volume/1': zVolume,
  'nv.arc/1': zArc,
  'nv.card/1': zCard,
  'nv.charc/1': zCharacterArc,
  'nv.strands/1': zStrands,
  'nv.oblig/1': zObligationPlan,
  'nv.change/1': zPlanChange,
  'nv.entity/1': zEntity,
  'nv.world/1': zWorldRules,
  'nv.secret/1': zSecret,
  'nv.glossary/1': zGlossary,
  'nv.predicate/1': zPredicate,
  'nv.delta/1': zDelta,
  'nv.override/1': zOverride,
  'nv.debt/1': zDebt,
  'nv.arcfp/1': zArcFingerprint,
  'nv.snapshot/1': zSnapshot,
  'nv.receipt/1': zReceipt,
  'nv.check/1': zCheckOutput,
  'nv.review/1': zReview,
  'nv.audit/1': zAudit,
  'nv.validated/1': zValidated,
  'nv.pairwise/1': zPairwise,
  'nv.patches/1': zPatches,
  'nv.pack/1': zGenrePack,
  'nv.gates/1': zGatesFile,
  'nv.pacing/1': zPacing,
  'nv.lexicon/1': zLexicon,
  'nv.routing/1': zRoutingPreset,
  'nv.profile/1': zProfile,
  'nv.account/1': zAccount,
  'nv.settings/1': zSystemSettings,
  'nv.capabilities/1': zCapabilities,
  'nv.event/1': zNEvent,
  'nv.workorder/1': zWorkOrderFrontmatter,
} as const;
export type SchemaName = keyof typeof SCHEMAS;

/** 书库相对路径 → schema 名（validators / UI 编辑器按路径选 schema） */
export function schemaForPath(relPath: string): SchemaName | null {
  const p = relPath.replace(/\\/g, '/');
  if (p === 'book.yaml') return 'nv.book/1';
  if (p === 'plan/compass.yaml') return 'nv.compass/1';
  if (/^plan\/volumes\/v\d+\.yaml$/.test(p)) return 'nv.volume/1';
  if (/^plan\/arcs\/a\d+\.yaml$/.test(p)) return 'nv.arc/1';
  if (/^plan\/cards\/c\d+\.yaml$/.test(p)) return 'nv.card/1';
  if (/^plan\/character-arcs\/[^/]+\.yaml$/.test(p)) return 'nv.charc/1';
  if (p === 'plan/strands.yaml') return 'nv.strands/1';
  if (p === 'plan/obligations.yaml') return 'nv.oblig/1';
  if (/^bible\/entities\/[^/]+\/[^/]+\.md$/.test(p)) return 'nv.entity/1';
  if (p === 'bible/world/rules.yaml') return 'nv.world/1';
  if (/^bible\/secrets\/[^/]+\.md$/.test(p)) return 'nv.secret/1';
  if (p === 'bible/glossary.yaml') return 'nv.glossary/1';
  if (/^state\/ledger\/c\d+\.json$/.test(p)) return 'nv.delta/1';
  if (/^reviews\/c\d+\.json$/.test(p)) return 'nv.review/1';
  if (/^audits\/[^/]+\.json$/.test(p)) return 'nv.audit/1';
  if (p === 'gates.yaml' || p.endsWith('/gates.yaml')) return 'nv.gates/1';
  if (p.endsWith('lexicon.yaml')) return 'nv.lexicon/1';
  if (p.endsWith('pacing.yaml')) return 'nv.pacing/1';
  if (p.endsWith('pack.yaml')) return 'nv.pack/1';
  return null;
}

/** jsonl 文件的行 schema */
export const JSONL_SCHEMAS: Record<string, SchemaName> = {
  'state/overrides.jsonl': 'nv.override/1',
  'state/arc-fingerprints.jsonl': 'nv.arcfp/1',
  'debt.jsonl': 'nv.debt/1',
  'plan/changes.jsonl': 'nv.change/1',
};

export type JsonSchemaDialect = 'lenient' | 'strict';
type JS = Record<string, unknown>;

/**
 * 导出 JSON Schema（§5.5）。
 * - lenient（cc/agy/通用）：z.toJSONSchema 的原样输出（input 视角，默认值字段可省略）
 * - strict（codex --output-schema）：所有 object additionalProperties:false、全部属性 required、原可选字段改为可空
 */
export function toJsonSchema(schema: z.ZodType, dialect: JsonSchemaDialect = 'lenient'): JS {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', cycles: 'ref' }) as JS;
  return dialect === 'strict' ? strictify(js) : js;
}

function strictify(node: unknown): JS {
  if (Array.isArray(node)) return node.map(strictify) as unknown as JS;
  if (typeof node !== 'object' || node === null) return node as JS;
  const n: JS = {};
  for (const [k, v] of Object.entries(node)) n[k] = typeof v === 'object' ? strictify(v) : v;
  if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
    const props = n.properties as Record<string, JS>;
    const req = new Set((n.required as string[] | undefined) ?? []);
    for (const key of Object.keys(props)) {
      if (!req.has(key)) props[key] = nullable(props[key] ?? {});
      delete (props[key] as JS).default;
    }
    n.required = Object.keys(props);
    n.additionalProperties = false;
  }
  return n;
}

function nullable(s: JS): JS {
  if (typeof s.type === 'string') return { ...s, type: [s.type, 'null'] };
  if (Array.isArray(s.type)) return s.type.includes('null') ? s : { ...s, type: [...s.type, 'null'] };
  return { anyOf: [s, { type: 'null' }] };
}
