/**
 * 开机迁移 M4（p3-plan §5）：旧的路由 preset（settings 'routing.active' + routing_presets 行）→ 两个路由位置（写作 / 杂活）。
 * 只读旧行，不改不删（上一版镜像还要用）。旧的内置 preset 在库里可能没有行（或被删了），这时按下表换算。
 */
import type { Slot } from '@novelist/shared';

/**
 * 旧内置 preset 的换算：写作位置主用、杂活位置主用。写作位置不配备用：旧的内置写手都是粘住的（sticky: book，不可用就等），
 * 换写手要主人批准（failover_chain），自动备用会把“等”变成“中途换模型”（DESIGN §7：默认不配备用）。
 */
export const LEGACY_PRESET_SLOTS: Record<string, { writer: string; utility: string }> = {
  'agy-argon': { writer: 'agy-argon', utility: 'agy-flash-check' },
  'cc-only': { writer: 'cc-opus', utility: 'cc-opus' },
  'codex-only': { writer: 'cx-sol', utility: 'cx-terra' },
  mixed: { writer: 'cc-opus', utility: 'cx-terra' },
  'dev-cheap': { writer: 'cc-haiku', utility: 'cx-luna' },
  fake: { writer: 'fake', utility: 'fake' },
};

/** 旧 settings 'routing.active' 缺省时的 preset */
const LEGACY_DEFAULT_PRESET = 'agy-argon';

function routeOf(roles: unknown, role: string): Record<string, unknown> | undefined {
  const r = roles && typeof roles === 'object' ? (roles as Record<string, unknown>)[role] : undefined;
  return r && typeof r === 'object' ? (r as Record<string, unknown>) : undefined;
}

function chainOf(roles: unknown, role: string): string[] {
  const chain = routeOf(roles, role)?.chain;
  return Array.isArray(chain) ? chain.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/**
 * 换算规则：
 *  写作主用 = overrides.writer.chain[0] ?? preset 行 roles.writer.chain[0] ?? 换算表 ?? 'agy-argon'；
 *  写作备用 = 所用链的第 2 个，只在那条写作路由不粘住（sticky 不是 'book'）时；否则 null（与主用相同也不要）。
 *    粘住的写手在旧流程里不可用就等（换写手要主人批准），链的第 2 个只在第一次挑写手时有用；换算表（内置 preset）一律粘住。
 *  杂活主用 = overrides.checker.chain[0] ?? preset 行 roles.checker.chain[0] ?? 换算表 ?? 写作主用。
 * 已经不存在的 profile 一律丢掉（记进 dropped）：写作主用顺着所用链往后找，再不行用 'agy-argon'（存在的话），否则 null（任务等着，主人在网页上设）；
 * 备用不存在 → null；杂活不存在 → 用写作主用。
 */
export function slotsFromLegacy(active: unknown, presetRow: { body: unknown } | null, existingProfiles: ReadonlySet<string>): { writer: Slot; utility: Slot; from: string; dropped: string[] } {
  const a = (active && typeof active === 'object' ? active : {}) as { presetId?: unknown; overrides?: unknown };
  const from = typeof a.presetId === 'string' && a.presetId ? a.presetId : LEGACY_DEFAULT_PRESET;
  const table = LEGACY_PRESET_SLOTS[from];
  const rowRoles = presetRow?.body && typeof presetRow.body === 'object' ? (presetRow.body as { roles?: unknown }).roles : undefined;
  const dropped = new Set<string>();
  const exists = (id: string | null | undefined): id is string => {
    if (!id) return false;
    if (existingProfiles.has(id)) return true;
    dropped.add(id);
    return false;
  };

  const overrideWriter = chainOf(a.overrides, 'writer');
  const rowWriter = chainOf(rowRoles, 'writer');
  const chain = overrideWriter.length ? overrideWriter : rowWriter.length ? rowWriter : table ? [table.writer] : ['agy-argon'];
  const writerRoute = overrideWriter.length ? routeOf(a.overrides, 'writer') : rowWriter.length ? routeOf(rowRoles, 'writer') : undefined;
  // 自定义路由的 sticky 缺省是 'none'；内置 preset（有换算表）的写手都是 'book'
  const sticky = typeof writerRoute?.sticky === 'string' ? writerRoute.sticky : table ? 'book' : 'none';
  let primary: string | null = null;
  for (const id of chain) {
    if (exists(id)) {
      primary = id;
      break;
    }
  }
  if (!primary && chain[0] !== 'agy-argon') primary = existingProfiles.has('agy-argon') ? 'agy-argon' : null;

  const fbCand = sticky === 'book' ? null : (chain[1] ?? null);
  let fallback: string | null = null;
  if (fbCand && fbCand !== primary && exists(fbCand)) fallback = fbCand;

  const utilCand = chainOf(a.overrides, 'checker')[0] ?? chainOf(rowRoles, 'checker')[0] ?? table?.utility ?? primary;
  const utility = utilCand && exists(utilCand) ? utilCand : primary;

  return { writer: { primary, fallback }, utility: { primary: utility, fallback: null }, from, dropped: [...dropped] };
}
