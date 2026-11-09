/**
 * 内置 profile 与路由 preset（D2 修订）。
 * - 默认 preset = agy-argon：所有角色走 agy + Gemini 4 Argon（slug 可在 UI 改；以 `agy models` 列表为准）。
 * - 测试用廉价模型（gpt-6-luna / claude-haiku-5-5 / gemini-3.8-flash-low）只出现在 dev-cheap preset，标记 tags:[dev]。
 *   默认 preset 里不产出正文的角色用 Flash（agy-flash-check），这是用户定的成本取舍，写作和规划仍是 Argon。
 * lane F（orchestrator/routing）在首次启动时把这些写入 DB（不存在才写），用户随后可在 UI 任意修改。
 */
import type { RoleId } from '../enums.js';
import type { ProfileInput, RoleRouteInput, RoutingPresetInput } from './routing.js';

/** Ultra 账号的 `agy models` 里只有 gemini-4-argon-{low,medium,high}（2026-11-09 核实）；UI 可改 */
export const AGY_ARGON_DEFAULT_SLUG = 'gemini-4-argon-medium';

export const BUILTIN_PROFILES: ProfileInput[] = [
  { id: 'agy-argon', label: 'agy · Gemini 4 Argon', harness: 'agy', model: AGY_ARGON_DEFAULT_SLUG, effort: 'medium' },
  { id: 'agy-argon-high', label: 'agy · Gemini 4 Argon（高推理，规划和裁决用）', harness: 'agy', model: 'gemini-4-argon-high', effort: 'high' },
  { id: 'agy-flash-check', label: 'agy · Gemini 3.8 Flash（校验抽取用，不产出正文）', harness: 'agy', model: 'gemini-3.8-flash-medium', effort: 'medium' },
  { id: 'cc-opus', label: 'Claude Code · Opus 5.5', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' },
  { id: 'cx-sol', label: 'Codex · gpt-6.1-sol', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { id: 'cx-terra', label: 'Codex · gpt-6.1-terra', harness: 'codex', model: 'gpt-6.1-terra', effort: 'medium' },
  { id: 'grok-47', label: 'Grok Build · grok-4.7', harness: 'grok', model: 'grok-4.7', effort: 'high', enabled: false },
  { id: 'dsh-flash', label: 'DeepSeek Harness · flash', harness: 'dsh', model: 'deepseek-flash' },
  // ---- 开发 / 测试用（tags: dev），不进入任何非 dev preset ----
  { id: 'cc-haiku', label: '[测试] Claude Code · Haiku 5.5', harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'medium', tags: ['dev'] },
  { id: 'cx-luna', label: '[测试] Codex · gpt-6-luna', harness: 'codex', model: 'gpt-6-luna', effort: 'low', tags: ['dev'] },
  { id: 'agy-flash', label: '[测试] agy · Gemini 3.8 Flash Low', harness: 'agy', model: 'gemini-3.8-flash-low', effort: 'low', tags: ['dev'] },
  { id: 'fake', label: '[测试] fake harness', harness: 'fake', model: 'fake-model', tags: ['dev'] },
];

/** lite/standard/key 用到的全部角色（canary 除外） */
export const ROUTABLE_ROLES: RoleId[] = [
  'planner',
  'showrunner',
  'writer',
  'checker',
  'confirm',
  'extractor',
  'format_checker',
  'summarizer',
  'auditor',
  'reviewer',
  'continuity',
  'judge',
  'plan_judge',
  'extractor_cross',
  'heldout',
  'editor',
  'stylist',
];

const WRITER_STICKY: Omit<RoleRouteInput, 'chain'> = {
  sticky: 'book',
  on_quota: 'wait',
  failover_after_ms: 6 * 3600_000,
  failover_on: ['auth', 'circuit_open', 'model_unavailable'],
  failover_requires_approval: true,
};

/** 决定全书走向的角色：调用次数少，错了后面全受影响 */
const DECISION_ROLES: RoleId[] = ['planner', 'showrunner', 'plan_judge', 'judge'];
/** 不产出正文的角色：推理深度对结果影响小，调用又多 */
const MECHANICAL_ROLES: RoleId[] = ['checker', 'extractor', 'extractor_cross', 'format_checker', 'summarizer', 'auditor'];

function allRoles(profile: string, extra: Partial<Record<RoleId, RoleRouteInput>> = {}): Partial<Record<RoleId, RoleRouteInput>> {
  const roles: Partial<Record<RoleId, RoleRouteInput>> = {};
  for (const r of ROUTABLE_ROLES) roles[r] = { chain: [profile] };
  roles.writer = { chain: [profile], ...WRITER_STICKY };
  roles.confirm = { chain: [profile], same_as: 'checker' };
  return { ...roles, ...extra };
}

export const BUILTIN_PRESETS: RoutingPresetInput[] = [
  {
    id: 'agy-argon',
    name: 'agy + Gemini 4 Argon（全部角色）',
    description: '默认。规划和裁决用 high，写作和评审用 medium，校验、抽取、摘要等不产出正文的角色用 Gemini 3.8 Flash，都走 Antigravity CLI。需要 Google AI Pro/Ultra。',
    builtin: true,
    roles: allRoles('agy-argon', {
      ...Object.fromEntries(MECHANICAL_ROLES.map((r) => [r, { chain: ['agy-flash-check'] }])),
      ...Object.fromEntries(DECISION_ROLES.map((r) => [r, { chain: ['agy-argon-high'] }])),
    }),
  },
  {
    id: 'cc-only',
    name: '仅 Claude Code',
    description: '所有角色走 Claude Code（订阅 OAuth 或自建 API 网关均可，在账号页配置）。',
    builtin: true,
    roles: allRoles('cc-opus'),
  },
  {
    id: 'codex-only',
    name: '仅 Codex',
    description: '所有角色走 Codex CLI。',
    builtin: true,
    roles: allRoles('cx-sol', { checker: { chain: ['cx-terra', 'cx-sol'] }, summarizer: { chain: ['cx-terra', 'cx-sol'] }, auditor: { chain: ['cx-terra', 'cx-sol'] } }),
  },
  {
    id: 'mixed',
    name: '混合（cc 主笔 + codex 校验 + agy 评审）',
    description: '写手 cc-opus；校验/摘要/审计走 codex；评审要求与写手不同厂商。',
    builtin: true,
    roles: {
      ...allRoles('cc-opus'),
      writer: { chain: ['cc-opus'], ...WRITER_STICKY, failover_chain: ['cx-sol'] },
      planner: { chain: ['cc-opus', 'cx-sol'] },
      showrunner: { chain: ['cc-opus', 'cx-sol'] },
      checker: { chain: ['cx-terra'], degrade_to: ['agy-argon', 'cc-opus'] },
      confirm: { chain: ['cx-terra'], same_as: 'checker' },
      extractor: { chain: ['cx-terra'], degrade_to: ['agy-argon'] },
      format_checker: { chain: ['agy-argon', 'cc-opus'] },
      summarizer: { chain: ['cx-terra', 'agy-argon'] },
      auditor: { chain: ['cx-terra', 'agy-argon'] },
      reviewer: { chain: ['cx-sol', 'agy-argon', 'grok-47'], constraint: 'vendor_ne_writer' },
      continuity: { chain: ['cx-sol', 'agy-argon'], constraint: 'vendor_ne_writer' },
      judge: { chain: ['cx-sol', 'agy-argon', 'grok-47'], constraint: 'vendor_ne_writer', panel: 2, distinct_vendors: true },
      plan_judge: { chain: ['cx-sol', 'agy-argon', 'grok-47'], constraint: 'vendor_ne_planner' },
      heldout: { chain: ['grok-47', 'agy-argon', 'cx-sol'], constraint: 'not_in_judges' },
      editor: { chain: ['grok-47', 'cx-sol'], constraint: 'vendor_ne_writer' },
      extractor_cross: { chain: ['agy-argon', 'cx-terra', 'dsh-flash'] },
    },
  },
  {
    id: 'dev-cheap',
    name: '[测试] 廉价模型',
    description: '仅用于开发/测试：luna / haiku / flash-low。不要用于正式写书。',
    builtin: true,
    roles: {
      ...allRoles('cx-luna'),
      writer: { chain: ['cc-haiku', 'agy-flash', 'cx-luna'], ...WRITER_STICKY },
      format_checker: { chain: ['cc-haiku', 'agy-flash'] },
    },
  },
  {
    id: 'fake',
    name: '[测试] fake harness',
    description: '全部角色走 fake adapter（e2e / chaos 测试用，不调用任何模型）。',
    builtin: true,
    roles: allRoles('fake'),
  },
];

export const DEFAULT_PRESET_ID = 'agy-argon';
