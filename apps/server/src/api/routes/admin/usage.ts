/** /api/admin/quota、usage（契约见 @novelist/shared ROUTES）。旧的 /api/admin/schedule（发布排期页）已删除：发布设置在新流程的书页上。 */
import { and, eq, gte, inArray, isNull, lte, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { QuotaStatus, UsageReport } from '@novelist/shared';
import { zUsageQuery } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { accountsState, books, quotaReservations, usageLedger } from '../../../db/schema.js';
import { loadAccountSnapshots } from '../../../orchestrator/index.js';

export async function registerUsage(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/admin/quota', async (): Promise<QuotaStatus[]> => {
    const now = new Date();
    const snapshots = await loadAccountSnapshots(deps.db, now);
    const ids = snapshots.map((s) => s.account.id);
    const reservations = ids.length
      ? await deps.db.select().from(quotaReservations).where(and(inArray(quotaReservations.accountId, ids), isNull(quotaReservations.settledAt), gte(quotaReservations.expiresAt, now.toISOString())))
      : [];
    const stateRows = ids.length ? await deps.db.select().from(accountsState).where(inArray(accountsState.accountId, ids)) : [];
    const utilOf = new Map(stateRows.map((s) => [s.accountId, s.util as Record<string, { utilization: number | null; resetsAt: string | null }>]));
    return snapshots.map((s) => {
      const reservedByWindow = new Map<string, number>();
      for (const r of reservations) if (r.accountId === s.account.id) reservedByWindow.set(r.window, (reservedByWindow.get(r.window) ?? 0) + r.amount);
      const util = utilOf.get(s.account.id) ?? {};
      const windows = new Set([...Object.keys(util), ...s.account.windows.map((w) => w.window), ...reservedByWindow.keys()]);
      return {
        accountId: s.account.id,
        harness: s.account.harness,
        plan: s.account.plan,
        windows: [...windows].sort().map((w) => ({ window: w, utilization: util[w]?.utilization ?? null, reserved: reservedByWindow.get(w) ?? 0, resetsAt: util[w]?.resetsAt ?? null })),
        sleepUntil: s.sleepUntil,
        sleepReason: s.sleepReason,
        activeRuns: s.active,
        concurrency: s.account.concurrency,
      };
    });
  });

  app.get<{ Querystring: Record<string, string> }>('/api/admin/usage', async (req): Promise<UsageReport> => {
    const q = zUsageQuery.parse(req.query);
    const from = q.from ?? new Date(Date.now() - 30 * 86400_000).toISOString();
    const where: SQL[] = [gte(usageLedger.ts, from)];
    if (q.to) where.push(lte(usageLedger.ts, q.to));
    const slugs = new Map((await deps.db.select({ id: books.id, slug: books.slug }).from(books)).map((b) => [b.id, b.slug]));
    if (q.book) {
      const id = [...slugs.entries()].find(([, slug]) => slug === q.book)?.[0] ?? '__none__';
      where.push(eq(usageLedger.bookId, id));
    }
    const rows = await deps.db.select().from(usageLedger).where(and(...where)).limit(100_000);
    const keyOf = (r: (typeof rows)[number]): string => {
      switch (q.groupBy) {
        case 'day':
          return r.ts.slice(0, 10);
        case 'book':
          return (r.bookId && slugs.get(r.bookId)) || '(无)';
        case 'profile':
          return r.profileId ?? '(无)';
        case 'account':
          return r.accountId ?? '(无)';
        case 'task_kind':
          return r.taskKind;
      }
    };
    const groups = new Map<string, UsageReport['rows'][number]>();
    const perChapter = new Map<string, { profile: string; tier: string; tokens: number; utilDelta: Record<string, number>; samples: number }>();
    for (const r of rows) {
      const key = keyOf(r);
      const g = groups.get(key) ?? { key, runs: 0, input: 0, cached: 0, output: 0, usd: 0, utilDelta: {} };
      g.runs += 1;
      g.input += r.input;
      g.cached += r.cached;
      g.output += r.output;
      g.usd += r.usd ?? 0;
      for (const [w, v] of Object.entries(r.utilDelta)) g.utilDelta[w] = (g.utilDelta[w] ?? 0) + v;
      groups.set(key, g);
      if (r.taskKind === 'chapter.write' && r.profileId) {
        const pk = `${r.profileId}:${r.tier ?? ''}`;
        const p = perChapter.get(pk) ?? { profile: r.profileId, tier: r.tier ?? 'standard', tokens: 0, utilDelta: {}, samples: 0 };
        p.tokens += r.input + r.output + r.cached;
        p.samples += 1;
        for (const [w, v] of Object.entries(r.utilDelta)) p.utilDelta[w] = (p.utilDelta[w] ?? 0) + v;
        perChapter.set(pk, p);
      }
    }
    const perChapterRows = [...perChapter.values()].map((p) => ({
      ...p,
      tokens: p.samples ? Math.round(p.tokens / p.samples) : 0,
      utilDelta: Object.fromEntries(Object.entries(p.utilDelta).map(([w, v]) => [w, v / p.samples])),
    }));
    return { groupBy: q.groupBy, rows: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)), perChapter: perChapterRows };
  });

}
