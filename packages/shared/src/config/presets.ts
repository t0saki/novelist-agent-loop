/**
 * 内置 profile 与默认路由位置（DESIGN §7）。
 * - 写作位置默认 agy + Gemini 4 Argon（slug 可在 UI 改；以 `agy models` 列表为准），杂活位置默认 Gemini 3.8 Flash。
 * - 测试用廉价模型（gpt-6-luna / claude-haiku-5-5 / gemini-3.8-flash-low）标记 tags:[dev]。
 * 首次启动时把 profile 写入 DB（不存在才写），用户随后可在 UI 任意修改。
 */
import type { ProfileInput } from './routing.js';
import type { RoutingSlots } from './slots.js';

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
  // ---- 开发 / 测试用（tags: dev） ----
  { id: 'cc-haiku', label: '[测试] Claude Code · Haiku 5.5', harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'medium', tags: ['dev'] },
  { id: 'cx-luna', label: '[测试] Codex · gpt-6-luna', harness: 'codex', model: 'gpt-6-luna', effort: 'low', tags: ['dev'] },
  { id: 'agy-flash', label: '[测试] agy · Gemini 3.8 Flash Low', harness: 'agy', model: 'gemini-3.8-flash-low', effort: 'low', tags: ['dev'] },
  { id: 'fake', label: '[测试] fake harness', harness: 'fake', model: 'fake-model', tags: ['dev'] },
];

/** 全新安装（既没有 routing.slots 也没有旧的 routing.active）时的两个位置 */
export const DEFAULT_SLOTS: Pick<RoutingSlots, 'writer' | 'utility'> = {
  writer: { primary: 'agy-argon', fallback: null },
  utility: { primary: 'agy-flash-check', fallback: null },
};
