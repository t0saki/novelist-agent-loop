/**
 * 可序列化的提交后 DB 效果（DESIGN §7.7 第 7 步）。Owner: lane E。
 * handler 不再返回闭包：VALIDATED.json 里存 {name, args}，崩溃恢复时按名字重放，不需要重跑 handler。
 * 每个效果都必须在已提交的 commit 上幂等（committer 用 effectsCommit 保证同一 commit 只跑一次）。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { books, chapters } from '../db/schema.js';
import { readV3Meta } from '../flow/state.js';
import type { V3BatchEffectArgs, V3Hint } from '../flow/types.js';

export interface DbEffect {
  name: string;
  args: Record<string, unknown>;
}

async function oldCjk(tx: Tx, bookId: string, no: number): Promise<number> {
  const rows = await tx.select({ cjk: chapters.cjk }).from(chapters).where(and(eq(chapters.bookId, bookId), eq(chapters.no, no))).limit(1);
  return rows[0]?.cjk ?? 0;
}

interface AcceptArgs {
  bookId: string;
  no: number;
  cid: string;
  title: string;
  volume: string;
  arc: string;
  cjk: number;
  nowIso: string;
  verdict: string;
  revisions: number;
  degraded: boolean;
  debts: number;
  writerModel: string | null;
  isFinal: boolean;
  seq: number;
}

interface IngestArgs {
  bookId: string;
  no: number;
  cid: string;
  title: string;
  cjk: number;
  nowIso: string;
}

interface ReextractArgs {
  bookId: string;
  no: number;
  needRepair: number[];
  /** 有新正文时的字数；纯重抽（不改正文）为 null */
  cjk: number | null;
  nowIso: string;
}

interface PlanArcArgs {
  bookId: string;
  rows: { bookId: string; no: number; chapterId: string; title: string; volume: string; arc: string }[];
  lastNo: number;
  nowIso: string;
  endgame: boolean;
}

interface CardRepairArgs {
  bookId: string;
  nos: number[];
}

interface AuditAdvanceArgs {
  bookId: string;
  nowIso: string;
  audit: { window_through: number; arc_through: number };
}

/** promoteV3 实际落地的结果（v3.batch 用）：landed = 已提交的章号（改写 + 新章），dropped = 主人改过而放弃的路径 */
export interface DbEffectExtra {
  landed?: number[];
  dropped?: string[];
}

type Handler = (tx: Tx, sha: string, args: never, extra?: DbEffectExtra) => Promise<void>;

/** 主人在运行期间改过的文件：作者版本另存了，下一次任务单里告诉作者 */
function ownerEditHint(p: string, nowIso: string): V3Hint {
  const copy = p.startsWith('drafts/owner-conflicts/') ? '' : `，你的版本另存在 drafts/owner-conflicts/${p}`;
  return { kind: 'owner_edit', text: `主人在你上次运行期间改了 ${p}，以主人的版本为准${copy}；需要的话把你的改动并进主人的版本。`, at: nowIso };
}

const REGISTRY: Record<string, Handler> = {
  async 'chapter.accept'(tx: Tx, sha: string, a: AcceptArgs) {
    const previous = await oldCjk(tx, a.bookId, a.no);
    const values = {
      state: 'accepted' as const,
      title: a.title,
      volume: a.volume,
      arc: a.arc,
      cjk: a.cjk,
      acceptedCommit: sha,
      acceptedAt: a.nowIso,
      verdict: a.verdict,
      revisions: a.revisions,
      degraded: a.degraded,
      debts: a.debts,
      writerModel: a.writerModel,
      // seq 保留：之后对本章的重写沿用递增的实例号，不会撞上首轮已完成的任务 id
      workflow: { v: 1, seq: a.seq },
    };
    await tx
      .insert(chapters)
      .values({ bookId: a.bookId, no: a.no, chapterId: a.cid, ...values })
      .onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: values });
    await tx
      .update(books)
      .set({
        acceptedThrough: sql`GREATEST(${books.acceptedThrough}, ${a.no})`,
        cursor: sql`GREATEST(${books.cursor}, ${a.no + 1})`,
        totalCjk: sql`${books.totalCjk} + ${a.cjk - previous}`,
        headCommit: sha,
        updatedAt: a.nowIso,
        ...(a.isFinal ? { status: 'completed' } : {}),
      })
      .where(eq(books.id, a.bookId));
  },

  async 'chapter.ingest'(tx: Tx, sha: string, a: IngestArgs) {
    const previous = await oldCjk(tx, a.bookId, a.no);
    const values = { state: 'accepted' as const, title: a.title, cjk: a.cjk, acceptedCommit: sha, acceptedAt: a.nowIso, workflow: {} };
    await tx.insert(chapters).values({ bookId: a.bookId, no: a.no, chapterId: a.cid, ...values }).onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: values });
    await tx
      .update(books)
      .set({ acceptedThrough: sql`GREATEST(${books.acceptedThrough}, ${a.no})`, totalCjk: sql`${books.totalCjk} + ${a.cjk - previous}`, cursor: sql`GREATEST(${books.cursor}, ${a.no + 1})`, headCommit: sha, updatedAt: a.nowIso })
      .where(eq(books.id, a.bookId));
  },

  async 'chapter.reextract'(tx: Tx, _sha: string, a: ReextractArgs) {
    if (a.needRepair.length) await tx.update(chapters).set({ state: 'needs_repair' }).where(and(eq(chapters.bookId, a.bookId), inArray(chapters.no, a.needRepair)));
    if (a.cjk !== null) {
      const previous = await oldCjk(tx, a.bookId, a.no);
      await tx.update(chapters).set({ cjk: a.cjk, revisedAt: a.nowIso, updatedAt: a.nowIso }).where(and(eq(chapters.bookId, a.bookId), eq(chapters.no, a.no)));
      await tx.update(books).set({ totalCjk: sql`${books.totalCjk} + ${a.cjk - previous}`, updatedAt: a.nowIso }).where(eq(books.id, a.bookId));
    }
    // 修补完成：本章回到已验收（下游冲突章节已单独标 needs_repair）
    if (!a.needRepair.includes(a.no)) await tx.update(chapters).set({ state: 'accepted' }).where(and(eq(chapters.bookId, a.bookId), eq(chapters.no, a.no), eq(chapters.state, 'needs_repair')));
  },

  async 'plan.arc'(tx: Tx, sha: string, a: PlanArcArgs) {
    for (const r of a.rows) await tx.insert(chapters).values(r).onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: { title: r.title, volume: r.volume, arc: r.arc } });
    await tx
      .update(books)
      .set({
        cardsThrough: sql`GREATEST(${books.cardsThrough}, ${a.lastNo})`,
        headCommit: sha,
        updatedAt: a.nowIso,
        // 只有开书期才从 planning 转 active；不解除 owner 暂停，也不复活已完结的书
        status: sql`CASE WHEN ${books.status} = 'planning' THEN 'active' ELSE ${books.status} END`,
        ...(a.endgame ? { endgame: true } : {}),
      })
      .where(eq(books.id, a.bookId));
  },

  async 'card.repair'(tx: Tx, _sha: string, a: CardRepairArgs) {
    await tx
      .update(chapters)
      .set({ state: 'planned' })
      .where(and(eq(chapters.bookId, a.bookId), inArray(chapters.no, a.nos), eq(chapters.state, 'needs_repair')));
  },

  async 'audit.advance'(tx: Tx, _sha: string, a: AuditAdvanceArgs) {
    // 单调取大：audit.window / audit.arc 可能并发，各自基于旧快照算出另一字段；用 UPDATE 内的表达式，后提交者看到的是最新行
    const windowThrough = sql`GREATEST(coalesce((${books.meta}->'audit'->>'window_through')::int, 0), ${a.audit.window_through}::int)`;
    const arcThrough = sql`GREATEST(coalesce((${books.meta}->'audit'->>'arc_through')::int, 0), ${a.audit.arc_through}::int)`;
    await tx
      .update(books)
      .set({
        meta: sql`${books.meta} || jsonb_build_object('audit', jsonb_build_object('window_through', ${windowThrough}, 'arc_through', ${arcThrough}))`,
        auditedThrough: sql`LEAST(${windowThrough}, ${arcThrough})`,
        updatedAt: a.nowIso,
      })
      .where(eq(books.id, a.bookId));
  },

  /**
   * v3 一批收稿（p1-plan §3 pipeline/effects.ts）：章节行、书的计数、meta.v3（提示、连击、发布规则用的 lastBatchFrom、pending 清理）。
   * 在 books 行上 select … for update；同一 commit 只跑一次（committer 的 effectsCommit），重放也幂等。
   */
  async 'v3.batch'(tx: Tx, sha: string, a: V3BatchEffectArgs, extra?: DbEffectExtra) {
    const rows = await tx.select().from(books).where(eq(books.id, a.bookId)).limit(1).for('update');
    const b = rows[0];
    if (!b) return;
    const landed = extra?.landed ? new Set(extra.landed) : null;
    const chs = a.chapters.filter((c) => !landed || landed.has(c.no));
    const fresh = chs.filter((c) => !c.rewrite).map((c) => c.no);
    let delta = 0;
    for (const c of chs) {
      const prev = (await tx.select({ cjk: chapters.cjk, acceptedAt: chapters.acceptedAt }).from(chapters).where(and(eq(chapters.bookId, a.bookId), eq(chapters.no, c.no))).limit(1))[0];
      delta += c.cjk - (prev?.cjk ?? 0);
      const values = {
        state: 'accepted' as const,
        title: c.title,
        cjk: c.cjk,
        acceptedCommit: sha,
        // 改写保留原来的 acceptedAt（发布规则按入库时间算），记 revisedAt
        ...(c.rewrite && prev?.acceptedAt ? { revisedAt: a.nowIso } : { acceptedAt: a.nowIso }),
        volume: '',
        arc: '',
        workflow: { v3: true },
        updatedAt: a.nowIso,
      };
      await tx
        .insert(chapters)
        .values({ bookId: a.bookId, no: c.no, chapterId: c.cid, ...values })
        .onConflictDoUpdate({ target: [chapters.bookId, chapters.no], set: values });
    }
    // 结束全书的那一章（本批最后一个新章）被主人改动顶掉时，完结不算数
    const lastNew = a.chapters.filter((c) => !c.rewrite).reduce((m, c) => Math.max(m, c.no), 0);
    // 没有新章、结局批只在已入库的末章上补了标记（completedOn）：补标记的那次改写被主人改动顶掉时同样不算；章已冻结时没有改写，直接算
    const endOn = lastNew === 0 ? a.completedOn : undefined;
    const endRewrite = endOn !== undefined ? a.chapters.some((c) => c.rewrite && c.no === endOn) : false;
    const endOk = endOn !== undefined && (!endRewrite || chs.some((c) => c.no === endOn));
    const completed = a.completed !== false && (lastNew > 0 ? fresh.includes(lastNew) : endOk) ? a.completed : false;
    const old = readV3Meta(b.meta);
    const rawMeta = (b.meta ?? {}) as Record<string, unknown>;
    const oldV3 = (rawMeta.v3 && typeof rawMeta.v3 === 'object' ? rawMeta.v3 : {}) as Record<string, unknown>;
    const v3: Record<string, unknown> = {
      ...oldV3,
      hints: [...a.hints, ...(extra?.dropped ?? []).map((p) => ownerEditHint(p, a.nowIso))],
      noChapterStreak: a.noChapterStreak,
      finaleNoMarker: a.finaleNoMarker,
      emptyStreak: 0,
      lastBatchFrom: fresh.length ? Math.min(...fresh) : old.lastBatchFrom,
      lastBatchAt: fresh.length ? a.nowIso : old.lastBatchAt,
      hintedShort: a.hintedShort,
      ...(completed ? { completedAt: old.completedAt ?? a.nowIso, completedReason: completed } : {}),
      // 只清自己这次 run 的 pending（别的 run 的不动）；locked 不在这里改
      pending: old.pending && old.pending.runId === a.runId ? null : (old.pending ?? null),
    };
    const meta = { ...rawMeta, ...(a.blurb !== undefined ? { blurb: a.blurb } : {}), v3 };
    const maxNew = fresh.length ? Math.max(...fresh) : 0;
    await tx
      .update(books)
      .set({
        acceptedThrough: sql`GREATEST(${books.acceptedThrough}, ${maxNew})`,
        cursor: sql`GREATEST(${books.cursor}, ${maxNew + 1})`,
        totalCjk: sql`${books.totalCjk} + ${delta}`,
        headCommit: sha,
        status: completed ? sql`CASE WHEN ${books.status} = 'archived' THEN ${books.status} ELSE 'completed' END` : sql`CASE WHEN ${books.status} = 'planning' THEN 'active' ELSE ${books.status} END`,
        ...(a.title !== undefined ? { title: a.title } : {}),
        meta,
        updatedAt: a.nowIso,
      })
      .where(eq(books.id, a.bookId));
  },
};

export function hasDbEffect(name: string): boolean {
  return name in REGISTRY;
}

export async function runDbEffect(tx: Tx, sha: string, effect: DbEffect, extra?: DbEffectExtra): Promise<void> {
  const fn = REGISTRY[effect.name];
  if (!fn) throw new Error(`unknown db effect: ${effect.name}`);
  await fn(tx, sha, effect.args as never, extra);
}
