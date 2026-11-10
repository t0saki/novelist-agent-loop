/**
 * 可序列化的提交后 DB 效果（从旧流水线的 effects 迁来，只留 v3 的 'v3.batch'）。
 * 提交计划里存 {name, args}，崩溃恢复时按名字重放，不需要重跑 handler。
 * 每个效果都必须在已提交的 commit 上幂等（committer 用 effectsCommit 保证同一 commit 只跑一次）。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { books, chapters } from '../db/schema.js';
import { readV3Meta } from '../flow/state.js';
import type { V3BatchEffectArgs, V3Hint } from '../flow/types.js';

export interface DbEffect {
  name: string;
  args: Record<string, unknown>;
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
    const retro = a.orderKind === 'book.retro';
    // 批次记录（回退、复盘用）：有新章入库才记一条
    const batchLog = fresh.length
      ? [
          ...old.batchLog,
          {
            runId: a.runId,
            kind: a.orderKind === 'book.open' ? 'open' : completed ? 'finale' : 'write',
            from: Math.min(...fresh),
            to: Math.max(...fresh),
            baseCommit: a.baseCommit ?? '',
            finalCommit: sha,
            at: a.nowIso,
            ...(a.toolSteps ? { toolSteps: a.toolSteps } : {}),
          },
        ]
      : old.batchLog;
    const finaleNoMarker = retro ? old.finaleNoMarker : a.finaleNoMarker;
    // 主人留言：运行读到的仍是 meta 里等着的那一条、且这一批确实有正文落地（提交时可能被主人改动整批顶掉）→ 记回执、移进历史。
    // 回执的章号按真正落地的章重算（committer 也只在有章落地时清空并归档 notes/from-owner.md，两边一致）
    let owner: Record<string, unknown> = {};
    const read = retro ? undefined : a.ownerMessageRead;
    const proseLanded = fresh.length > 0 || chs.length > 0 || completed !== false;
    if (read && proseLanded && old.ownerMessage?.sha === read.sha) {
      const { sha: _sha, archivedPath, ...readIn } = read;
      const nos = fresh.length > 0 ? fresh : chs.length > 0 ? chs.map((c) => c.no) : [];
      if (nos.length > 0) {
        readIn.from = Math.min(...nos);
        readIn.to = Math.max(...nos);
      }
      owner = { ownerMessage: null, ownerMessages: [{ ...old.ownerMessage, readIn, archivedPath, status: 'read' }, ...old.ownerMessages].slice(0, 20) };
    }
    // 主人的改写请求：这一章的改写入库了就是 done（崩溃前落地的也算）；没入库时只有 final（正常结束且有章入库）才记 not_done（只用一次），
    // 否则继续等：发布暂扣照旧，下一张任务单再带
    if (!retro && a.ownerRequestResults?.length) {
      const res = new Map(a.ownerRequestResults.map((r) => [r.id, r]));
      owner.ownerRequests = old.ownerRequests.map((r) => {
        const x = res.get(r.id);
        if (!x || r.status !== 'waiting') return r;
        if (chs.some((c) => c.rewrite && c.no === r.chapter)) return { ...r, status: 'done', runId: a.runId };
        return x.final === false ? r : { ...r, status: 'not_done', runId: a.runId };
      });
    }
    const v3: Record<string, unknown> = {
      ...oldV3,
      // 复盘不动提示和各种连击（只追加主人改动的提示）
      hints: [...(retro ? old.hints : a.hints), ...(extra?.dropped ?? []).map((p) => ownerEditHint(p, a.nowIso))],
      noChapterStreak: retro ? old.noChapterStreak : a.noChapterStreak,
      finaleNoMarker,
      emptyStreak: retro ? old.emptyStreak : 0,
      lastBatchFrom: fresh.length ? Math.min(...fresh) : old.lastBatchFrom,
      lastBatchAt: fresh.length ? a.nowIso : old.lastBatchAt,
      hintedShort: retro ? old.hintedShort : a.hintedShort,
      ...(completed ? { completedAt: old.completedAt ?? a.nowIso, completedReason: completed, ...(a.completedNote ? { completedNote: a.completedNote } : {}) } : {}),
      batchLog,
      ...(retro ? { retro: { afterBatches: old.batchLog.length, lastAt: a.nowIso, lastRunId: a.runId, lastStatus: 'done' } } : {}),
      runawayBatches: typeof a.runawayBatches === 'number' ? a.runawayBatches : old.runawayBatches,
      shortEndUsed: typeof a.shortEndUsed === 'boolean' ? a.shortEndUsed : old.shortEndUsed,
      plannedFloor: a.plannedFloor !== undefined ? a.plannedFloor : old.plannedFloor,
      finaleNoMarkerAlerted: a.finaleNoMarkerAlert ? true : finaleNoMarker === 0 ? false : old.finaleNoMarkerAlerted,
      ...(a.feedback && fresh.length ? { feedback: a.feedback } : {}),
      ...(a.batchNote ? { batchNote: a.batchNote } : {}),
      ...owner,
      // 接手的旧书：接手任务单的这一批有新章入库，之后用普通的写作任务单（P3 D16）
      ...(a.takeoverDone && fresh.length > 0 && old.takeover ? { takeover: { ...old.takeover, status: 'done' } } : {}),
      // 主人要求的“立即写下一批”：这一批有新章入库就算写过了（只多写这一批）
      ...(fresh.length > 0 && oldV3.writeNow === true ? { writeNow: false } : {}),
      // 只清自己这次 run 的 pending（别的 run 的不动）；locked 不在这里改
      pending: old.pending && old.pending.runId === a.runId ? null : (old.pending ?? null),
    };
    // 标签（WP-3）：bible.md 第三行的原文，书库摘要按它计数
    const meta = { ...rawMeta, ...(a.blurb !== undefined ? { blurb: a.blurb } : {}), ...(Array.isArray(a.tags) ? { tags: a.tags } : {}), v3 };
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
