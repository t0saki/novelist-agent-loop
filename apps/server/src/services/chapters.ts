/** 规划 / 章节 / 状态的只读视图（管理端）。Owner: lane G。 */
import { and, asc, desc, eq, gt, inArray, } from 'drizzle-orm';
import path from 'node:path';
import type { BookQuality, ChapterAdminDetail, ChapterRow, GateResult, Page, PlanOverview, Review, RunRow, StateView, ChapterWorkflowState } from '@novelist/shared';
import { chapterId, zAudit, zDelta, zReview } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { bookFiles, openRepo, P } from '../book/index.js';
import { chapters, inbox, runs, tasks } from '../db/schema.js';
import { notFound } from '../api/problem.js';
import { bookDir, decodeCursor, encodeCursor, type BookRow } from '../api/helpers.js';
import { loadBookState, } from '../state/index.js';
import { loadGenre } from '../genres/index.js';

type ChapterTable = typeof chapters.$inferSelect;

export function toChapterRow(c: ChapterTable): ChapterRow {
  return {
    no: c.no,
    id: c.chapterId,
    title: c.title,
    volume: c.volume,
    arc: c.arc,
    state: c.state as ChapterWorkflowState,
    cjk: c.cjk,
    acceptedAt: c.acceptedAt,
    audited: c.audited,
    publishedAt: c.publishedAt,
    verdict: c.verdict as ChapterRow['verdict'],
    revisions: c.revisions,
    degraded: c.degraded,
    debts: c.debts,
  };
}

export async function chapterPage(deps: Pick<AppDeps, 'db'>, book: BookRow, cursor: string | undefined, limit: number): Promise<Page<ChapterRow>> {
  const after = decodeCursor(cursor)?.[0];
  const where = typeof after === 'number' ? and(eq(chapters.bookId, book.id), gt(chapters.no, after)) : eq(chapters.bookId, book.id);
  const rows = await deps.db.select().from(chapters).where(where).orderBy(asc(chapters.no)).limit(limit + 1);
  const items = rows.slice(0, limit).map(toChapterRow);
  return { items, nextCursor: rows.length > limit ? encodeCursor([rows[limit - 1]?.no as number]) : null };
}

export function toRunRow(r: typeof runs.$inferSelect, slug: string | null): RunRow {
  const usage = (r.usage ?? {}) as { input?: number; output?: number; cachedInput?: number; costUsd?: number };
  return {
    id: r.id,
    taskId: r.taskId,
    bookSlug: slug,
    kind: r.taskKind as RunRow['kind'],
    attempt: r.attempt,
    role: r.role as RunRow['role'],
    profileId: r.profileId,
    accountId: r.accountId,
    harness: r.harness as RunRow['harness'],
    harnessVersion: r.harnessVersion,
    model: r.model,
    modelReported: r.modelReported,
    isolation: r.isolation as RunRow['isolation'],
    state: r.state as RunRow['state'],
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    errorClass: r.errorClass as RunRow['errorClass'],
    usage: { input: usage.input ?? 0, output: usage.output ?? 0, cached: usage.cachedInput ?? 0, costUsd: usage.costUsd ?? null },
    denials: r.denials,
    toolSteps: typeof r.outcome?.toolSteps === 'number' ? r.outcome.toolSteps : null,
  };
}

const zWorkflowPaths = (w: Record<string, unknown>): { draft: string | null; gates: GateResult[]; findings: unknown[] } => ({
  draft: ((w.draft as { path?: string } | null | undefined)?.path as string | undefined) ?? null,
  gates: (w.lastGates as GateResult[] | undefined) ?? [],
  findings: (w.findings as unknown[] | undefined) ?? [],
});

export async function chapterDetail(deps: AppDeps, book: BookRow, no: number): Promise<ChapterAdminDetail> {
  const repo = openRepo(bookDir(deps, book.slug));
  const files = bookFiles(repo);
  const rows = await deps.db.select().from(chapters).where(and(eq(chapters.bookId, book.id), eq(chapters.no, no))).limit(1);
  const card = await files.card(no).catch(() => null);
  if (!rows[0] && !card) throw notFound(`第 ${no} 章`);
  const row: ChapterTable = rows[0] ?? {
    bookId: book.id,
    no,
    chapterId: chapterId(no),
    title: card?.title ?? '',
    volume: card?.volume ?? '',
    arc: card?.arc ?? '',
    state: 'planned',
    workflow: {},
    cjk: 0,
    acceptedCommit: null,
    acceptedAt: null,
    audited: false,
    publishedAt: null,
    revisedAt: null,
    verdict: null,
    revisions: 0,
    degraded: false,
    debts: 0,
    writerModel: null,
    updatedAt: new Date().toISOString(),
  };
  const wf = zWorkflowPaths(row.workflow);
  const [text, draft, deltaRaw, reviewRaw, debtsAll, taskIds] = await Promise.all([
    files.manuscript(no),
    wf.draft ? repo.readFile(wf.draft) : Promise.resolve(null),
    repo.readFile(P.ledger(no)),
    repo.readFile(P.review(no)),
    files.debts().catch(() => []),
    deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.bookId, book.id), eq(tasks.target, chapterId(no)))),
  ]);
  const runRows = taskIds.length ? await deps.db.select().from(runs).where(inArray(runs.taskId, taskIds.map((t) => t.id))).orderBy(desc(runs.createdAt)).limit(30) : [];
  const parse = <S extends { safeParse(v: unknown): { success: boolean; data?: unknown } }>(raw: string | null, schema: S): unknown => {
    if (raw === null) return null;
    try {
      const r = schema.safeParse(JSON.parse(raw));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  };
  return {
    ...toChapterRow(row),
    text,
    draft,
    card,
    delta: parse(deltaRaw, zDelta) as ChapterAdminDetail['delta'],
    review: parse(reviewRaw, zReview) as ChapterAdminDetail['review'],
    gates: wf.gates,
    debtsList: debtsAll.filter((d) => d.chapter === row.chapterId),
    runs: runRows.map((r) => toRunRow(r, book.slug)),
    commit: row.acceptedCommit,
  };
}

export async function planOverview(deps: AppDeps, book: BookRow, opts: { allCards: boolean }): Promise<PlanOverview> {
  const dir = bookDir(deps, book.slug);
  const files = bookFiles(openRepo(dir));
  const [compassRaw, volumes, arcs, state, approvalRows, chapterStates] = await Promise.all([
    files.compass().catch(() => null),
    files.volumes(),
    files.arcs(),
    loadBookState(dir).catch(() => null),
    deps.db.select({ state: inbox.state, resolution: inbox.resolution }).from(inbox).where(and(eq(inbox.bookId, book.id), eq(inbox.dedupeKey, `approval:compass:${book.id}`))).orderBy(desc(inbox.createdAt)).limit(1),
    deps.db.select({ no: chapters.no, state: chapters.state }).from(chapters).where(eq(chapters.bookId, book.id)),
  ]);
  const cfg = await files.config().then((c) => c.config).catch(() => null);
  const from = opts.allCards ? 1 : Math.max(1, book.acceptedThrough - 2);
  const cards = await files.cards(from, Number.MAX_SAFE_INTEGER).catch(() => []);
  const stateOf = new Map(chapterStates.map((c) => [c.no, c.state]));
  const resolved = new Set(state?.snapshot.arcs_resolved ?? []);
  const pacing = cfg ? await loadGenre(deps.paths, cfg.genre).then((g) => g.pacing.card_buffer).catch(() => null) : null;
  // 打回重做也会 resolved：只有 approve（或超时自动批准）才算批准
  const compassApproved = compassRaw !== null && (cfg?.approvals.compass.required === false || (approvalRows[0]?.state === 'resolved' && (approvalRows[0].resolution as { action?: string } | null)?.action === 'approve') || approvalRows[0]?.state === 'expired');
  return {
    compass: compassRaw,
    compassApproved,
    volumes: volumes.map((v) => ({ id: v.id, title: v.title, detail: v.detail, chapters: v.chapters ? [v.chapters[0], v.chapters[1]] : null })),
    arcs: arcs.map((a) => ({ id: a.id, volume: a.volume, title: a.title, chapters: [a.chapters[0], a.chapters[1]], resolved: resolved.has(a.id) })),
    cards: cards.map((c) => ({ id: c.id, title: c.title, stale: c.stale, key: c.key, state: (stateOf.get(Number(c.id.slice(1))) ?? 'planned') as ChapterWorkflowState | 'planned' })),
    cardBuffer: { have: Math.max(0, book.cardsThrough - book.acceptedThrough), min: pacing?.min ?? 0, target: pacing?.target ?? 0 },
    endgame: book.endgame,
  };
}

/** §9.2 质量页：弧指纹两两相似度 + debt.jsonl 里的 recall.miss 统计 + 审计列表 */
export async function bookQuality(deps: AppDeps, book: BookRow): Promise<BookQuality> {
  const repo = openRepo(bookDir(deps, book.slug));
  const files = bookFiles(repo);
  const [fps, debts, auditNames] = await Promise.all([files.arcFingerprints().catch(() => []), files.debts().catch(() => []), repo.list('audits').catch(() => [] as string[])]);
  const tokens = (f: (typeof fps)[number]) => new Set(Object.entries(f.features).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}:${x}`) : [`${k}:${v}`])));
  const jaccard = (a: Set<string>, b: Set<string>) => (a.size === 0 && b.size === 0 ? 0 : [...a].filter((x) => b.has(x)).length / new Set([...a, ...b]).size);
  const arcs = fps.map((f, i) => {
    const mine = tokens(f);
    let topMatch: { arc: string; similarity: number } | null = null;
    for (const other of fps.slice(0, i)) {
      const similarity = Math.round(jaccard(mine, tokens(other)) * 1000) / 1000;
      if (!topMatch || similarity > topMatch.similarity) topMatch = { arc: other.arc, similarity };
    }
    const prev = fps[i - 1];
    return { arc: f.arc, ts: f.ts, features: f.features as Record<string, unknown>, similarityToPrev: prev ? Math.round(jaccard(mine, tokens(prev)) * 1000) / 1000 : null, topMatch };
  });
  const recallMap = new Map<string, number>();
  for (const d of debts) if (d.rule === 'recall.miss') recallMap.set(d.chapter, (recallMap.get(d.chapter) ?? 0) + 1);
  const audits = await Promise.all(
    auditNames
      .filter((n) => n.endsWith('.json'))
      .slice(-120)
      .map(async (p) => {
        const raw = await repo.readFile(p);
        if (!raw) return null;
        const parsed = zAudit.safeParse(JSON.parse(raw));
        if (!parsed.success) return null;
        const a = parsed.data;
        return { name: path.basename(p, '.json'), kind: a.kind, range: [a.range[0], a.range[1]] as [string, string], passed: a.passed, hard: a.findings.filter((f) => f.severity === 'hard').length, soft: a.findings.filter((f) => f.severity === 'soft').length, ts: a.ts };
      }),
  );
  return {
    arcs,
    recall: [...recallMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([chapter, misses]) => ({ chapter, misses })),
    recallTotal: [...recallMap.values()].reduce((s, n) => s + n, 0),
    frontiers: { accepted: book.acceptedThrough, audited: book.auditedThrough, published: book.publishedThrough },
    audits: audits.filter((a): a is NonNullable<typeof a> => a !== null).sort((a, b) => (a.ts < b.ts ? 1 : -1)),
  };
}

export async function stateView(deps: AppDeps, book: BookRow): Promise<StateView> {
  const state = await loadBookState(bookDir(deps, book.slug));
  const s = state.snapshot;
  const defs = new Map(state.entities.map((e) => [e.entity.id, e.entity]));
  const nameOfAlias = (a: unknown) => (typeof a === 'string' ? a : ((a as { name?: string; text?: string }).name ?? (a as { text?: string }).text ?? ''));
  const obligations = Object.values(s.obligations);
  const accepted = book.acceptedThrough;
  const dueNo = (id: string) => Number(id.slice(1));
  return {
    snapshot: { through: s.through, hash: s.hash, time: s.time, total_cjk: s.total_cjk },
    entities: Object.values(s.entities).map((e) => ({ ...e, tier: defs.get(e.id)?.tier ?? 'minor', aliases: (defs.get(e.id)?.aliases ?? []).map(nameOfAlias).filter(Boolean) })),
    obligations,
    overdue: obligations.filter((o) => (o.status === 'open' || o.status === 'advanced') && o.due && dueNo(o.due[1]) < accepted),
    knowledge: Object.entries(s.knowledge).map(([who, facts]) => ({ who, facts })),
    readerKnows: s.reader_knows,
    timeline: s.events.map((e) => ({ ch: e.ch, what: e.what, who: e.who })),
  };
}

export async function reviewsPage(deps: AppDeps, book: BookRow, cursor: string | undefined, limit: number): Promise<Page<Review>> {
  const repo = openRepo(bookDir(deps, book.slug));
  const files = (await repo.list('reviews')).filter((p) => p.endsWith('.json')).sort().reverse();
  const start = Number(decodeCursor(cursor)?.[0] ?? 0);
  const slice = files.slice(start, start + limit);
  const items: Review[] = [];
  for (const f of slice) {
    const raw = await repo.readFile(f);
    if (raw === null) continue;
    const r = zReview.safeParse(JSON.parse(raw));
    if (r.success) items.push(r.data);
  }
  return { items, nextCursor: start + limit < files.length ? encodeCursor([start + limit]) : null };
}

export async function auditsList(deps: AppDeps, book: BookRow): Promise<unknown[]> {
  const repo = openRepo(bookDir(deps, book.slug));
  const files = (await repo.list('audits')).filter((p) => p.endsWith('.json')).sort().reverse();
  const out: unknown[] = [];
  for (const f of files.slice(0, 200)) {
    const raw = await repo.readFile(f);
    if (raw === null) continue;
    const r = zAudit.safeParse(JSON.parse(raw));
    if (r.success) out.push(r.data);
  }
  return out;
}

