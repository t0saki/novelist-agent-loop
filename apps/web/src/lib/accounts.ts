import type { AccountView } from '@novelist/shared';

/**
 * PATCH /accounts/:id 的完整字段集。
 * zPatchAccount 是带默认值 schema 的 .partial()：zod 4 会给缺失的键填默认值，
 * 服务端再覆盖到当前账号上，所以只发改动的字段会把其余字段重置。这里总是发全量。
 * reservePct / maxWeeklyUtilPct（配额预留、周用量上限）随配额预留一起删掉了（DESIGN §10），服务端不再读：
 * 页面上不能再改，这里只把存着的值原样带回去（不被默认值改写，上一版镜像读到的还是原值）。
 */
export function accountPatch(a: AccountView, changes: Partial<Pick<AccountView, 'label' | 'plan' | 'enabled' | 'concurrency' | 'customModels' | 'notes' | 'riskAck' | 'windows' | 'monthlyUsdCap'>>) {
  return {
    label: a.label,
    plan: a.plan,
    enabled: a.enabled,
    concurrency: a.concurrency,
    reservePct: a.reservePct,
    customModels: a.customModels,
    notes: a.notes,
    windows: a.windows,
    riskAck: a.riskAck,
    authMode: a.authMode,
    ...(a.maxWeeklyUtilPct === undefined ? {} : { maxWeeklyUtilPct: a.maxWeeklyUtilPct }),
    ...(a.monthlyUsdCap === undefined ? {} : { monthlyUsdCap: a.monthlyUsdCap }),
    ...changes,
  };
}
