/**
 * 系统设置的保存（P3 D30）。每个页面只发自己那一节：按节合并到库里的设置上，合并结果再整体校验后写回。
 * 带 baseUpdatedAt 的请求只在它和设置行的 updatedAt 一致时才写（否则 409 stale_settings：页面先重新读一遍），
 * 这样一个停在旧页面上的整份设置不会把别处刚改的值（比如自动开书开关）改回去。从不写 routing.active。
 */
import { eq } from 'drizzle-orm';
import type { SystemSettings, SystemSettingsView } from '@novelist/shared';
import { V3_PUBLISH_DEFAULTS, zPublishConfig, zPutSettings, zSystemSettings } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { badRequest, HttpProblem } from '../api/problem.js';
import { settings } from '../db/schema.js';
import { assertPublishConfig } from './publish-config.js';

/**
 * 逐键合并的对象节（其余键整体替换）。数组和记录（genreWeights、genres、lengthMix、notifications.events）出现时整体替换。
 * autoStart.lengths.<档> 也逐键合并：页面只发 targetCjk，chaptersMin / chaptersMax 保持原值。
 */
const MERGED_SECTIONS = new Set([
  'autoStart',
  'autoStart.lengths',
  'autoStart.lengths.short',
  'autoStart.lengths.medium',
  'autoStart.lengths.long',
  'autoStart.lengths.epic',
  'v3',
  'v3.effortDefaults',
  'v3.publishDefaults',
  'retention',
  'notifications',
  'readers',
  'idleTimeouts',
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function mergeAt(current: unknown, patch: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const at = prefix ? `${prefix}.${k}` : k;
    out[k] = MERGED_SECTIONS.has(at) && isPlainObject(v) && isPlainObject(out[k]) ? mergeAt(out[k], v, at) : v;
  }
  return out;
}

/** 按节合并（见 MERGED_SECTIONS）；顶层的标量直接替换。不做校验 */
export function mergeSettings(current: SystemSettings, patch: unknown): unknown {
  if (!isPlainObject(patch)) return { ...current };
  const { baseUpdatedAt: _base, ...rest } = patch;
  return mergeAt(current, rest, '');
}

const sameInstant = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  const x = new Date(a).getTime();
  const y = new Date(b).getTime();
  return Number.isFinite(x) && x === y;
};

export async function readSettingsView(deps: Pick<AppDeps, 'db'>): Promise<SystemSettingsView> {
  const rows = await deps.db.select().from(settings).where(eq(settings.key, 'system')).limit(1);
  const parsed = zSystemSettings.safeParse(rows[0]?.value ?? {});
  const value = parsed.success ? parsed.data : zSystemSettings.parse({});
  return { ...value, updatedAt: rows[0] ? new Date(rows[0].updatedAt).toISOString() : null };
}

function validate(next: SystemSettings, rawPatch: unknown): void {
  // 失控兜底倍数：0（关闭）或 ≥ 2（schema 只是把旧值抬到 2，新保存的直接拒收）
  const rawFactor = (rawPatch as { v3?: { runawayFactor?: unknown } } | null)?.v3?.runawayFactor;
  if (typeof rawFactor === 'number' && rawFactor > 0 && rawFactor < 2) throw badRequest('失控兜底倍数要么是 0（关闭），要么不小于 2', 'invalid_runaway_factor');
  // 自动开书的篇幅分布：四档按本数的百分比，必须加起来是 100
  const mix = next.autoStart.lengthMix;
  if (Math.abs(mix.short + mix.medium + mix.long + mix.epic - 100) > 1e-9) throw badRequest('篇幅分布四档加起来要等于 100', 'invalid_length_mix');
  // 默认发布节奏：和开书时写进 book.yaml 的完全一样地校验（按每批 1 章：存稿上限至少 2）
  const pd = next.v3.publishDefaults;
  assertPublishConfig(zPublishConfig.parse({ ...V3_PUBLISH_DEFAULTS, ...pd, resume_buffer: Math.max(1, pd.max_buffer - 5) }), { batch: 1 });
}

/**
 * PUT /api/admin/settings：baseUpdatedAt 检查（同一个事务里锁住设置行）→ 按节合并 → 整体校验 → 写回。返回新的设置和 updatedAt。
 * 没带 autoStart.enabled 的请求永远改不了它。
 */
export async function putSettings(deps: Pick<AppDeps, 'db'>, body: unknown): Promise<{ view: SystemSettingsView; fields: string[] }> {
  const head = zPutSettings.safeParse(body ?? {});
  if (!head.success) throw badRequest('设置格式不对', 'invalid_settings');
  const base = head.data.baseUpdatedAt;
  const patch = body as Record<string, unknown>;
  const fields = Object.keys(patch).filter((k) => k !== 'baseUpdatedAt');
  await deps.db.transaction(async (tx) => {
    const rows = await tx.select().from(settings).where(eq(settings.key, 'system')).limit(1).for('update');
    const row = rows[0];
    if (base !== undefined && !sameInstant(base, row ? row.updatedAt : null)) {
      throw new HttpProblem(409, 'stale_settings', '设置在别处改过了，请刷新页面后再改');
    }
    const loaded = zSystemSettings.safeParse(row?.value ?? {});
    const current = loaded.success ? loaded.data : zSystemSettings.parse({});
    const merged = zSystemSettings.safeParse(mergeSettings(current, patch));
    if (!merged.success) {
      throw new HttpProblem(400, 'invalid_settings', '设置不合法', { errors: merged.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    validate(merged.data, patch);
    const nowIso = new Date().toISOString();
    await tx
      .insert(settings)
      .values({ key: 'system', value: merged.data, updatedAt: nowIso })
      .onConflictDoUpdate({ target: settings.key, set: { value: merged.data, updatedAt: nowIso } });
  });
  return { view: await readSettingsView(deps), fields };
}
