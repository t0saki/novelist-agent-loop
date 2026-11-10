/**
 * 主人对 v3 书的改写请求（p2-plan §2.5、§3.2；DESIGN §9 章节页“带意见重写”）。DB 层，不依赖 AppDeps：门面（orchestrator/）直接调用。
 * 请求单独存在 meta.v3.ownerRequests（提示每次收稿都会被替换）：只用一次，入库了就是 done，没改成就是 not_done，之后不再追问。
 */
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import type { V3ActionResult } from '@novelist/shared';
import type { Db } from '../db/client.js';
import { books } from '../db/schema.js';
import { HttpProblem } from '../api/problem.js';
import { patchV3Meta, readV3Meta } from './state.js';
import type { V3BookMeta, V3OwnerRequest } from './types.js';

/** 最多留这么多条（先丢最早处理完的） */
export const OWNER_REQUESTS_MAX = 50;

export const V3_FINISHED_MESSAGE = '这本书已完结，不会再有下一次运行：请直接修改章节，或者先回退到某一批之前';
export const V3_ARCHIVED_MESSAGE = '这本书已归档，不会再有下一次运行：请直接修改章节，或者先把书恢复成在写';
export const v3Finished = (status?: string): HttpProblem => new HttpProblem(409, 'v3_finished', status === 'archived' ? V3_ARCHIVED_MESSAGE : V3_FINISHED_MESSAGE);
export const notV3 = (): HttpProblem => new HttpProblem(409, 'not_v3', '这本书不是新流程');

/** 等着处理的请求里最小的章号；没有时 null */
export function firstWaitingRequest(meta: Pick<V3BookMeta, 'ownerRequests'> & { locked?: readonly number[] }): number | null {
  let k: number | null = null;
  // 请求之后又被锁定的章不算（见 order.ts waitingOwnerRequests）
  for (const r of meta.ownerRequests) if (r.status === 'waiting' && !(meta.locked ?? []).includes(r.chapter) && (k === null || r.chapter < k)) k = r.chapter;
  return k;
}

/** 超过上限时先丢最早处理完的（waiting 的从不丢） */
export function capRequests(list: V3OwnerRequest[]): V3OwnerRequest[] {
  const out = [...list];
  while (out.length > OWNER_REQUESTS_MAX) {
    const i = out.findIndex((r) => r.status !== 'waiting');
    if (i < 0) break;
    out.splice(i, 1);
  }
  return out;
}

const isV3Meta = (meta: unknown): boolean => !!meta && typeof meta === 'object' && (meta as { v3?: unknown }).v3 !== undefined && (meta as { v3?: unknown }).v3 !== null;

/**
 * 记一条改写请求：一个事务里锁住书行再检查（v3、没完结、未发布、已入库），所以紧挨着的发布一定能看到。
 * 解锁这一章（主人要它被改写），同一章之前还在等的请求作废。
 */
export async function requestChapterRewrite(db: Db, bookId: string, no: number, note: string, now: Date): Promise<V3ActionResult> {
  return patchV3Meta(db, bookId, (meta, row) => {
    if (!isV3Meta(row.meta)) throw notV3();
    if (row.status === 'completed' || row.status === 'archived') throw v3Finished(row.status);
    if (no <= row.publishedThrough) throw new HttpProblem(409, 'published', '已发布的章节只能直接修改');
    if (no > row.acceptedThrough) throw new HttpProblem(400, 'bad_request', `第 ${no} 章还没写到`);
    const at = now.toISOString();
    const requests = meta.ownerRequests.map((r) => (r.status === 'waiting' && r.chapter === no ? { ...r, status: 'dropped' as const } : r));
    requests.push({ id: nanoid(8), kind: 'rewrite', chapter: no, note: note.trim(), at, status: 'waiting' });
    return {
      patch: { ownerRequests: capRequests(requests), locked: meta.locked.filter((k) => k !== no) },
      result: { ok: true, detail: `已记下：下一批写作时先改写第 ${no} 章（改写前这一章不会发布）。` },
    };
  });
}

/** 章节已经发布了（主人手动发布）的等待请求 → dropped；没有时不写 */
export async function dropPublishedRequests(db: Db, bookId: string, publishedThrough: number): Promise<void> {
  const row = (await db.select({ meta: books.meta }).from(books).where(eq(books.id, bookId)).limit(1))[0];
  if (!row || !readV3Meta(row.meta).ownerRequests.some((r) => r.status === 'waiting' && r.chapter <= publishedThrough)) return;
  await patchV3Meta(db, bookId, (meta, cur) => {
    const pub = cur.publishedThrough;
    if (!meta.ownerRequests.some((r) => r.status === 'waiting' && r.chapter <= pub)) return { patch: null, result: undefined };
    return { patch: { ownerRequests: meta.ownerRequests.map((r) => (r.status === 'waiting' && r.chapter <= pub ? { ...r, status: 'dropped' as const } : r)) }, result: undefined };
  });
}
