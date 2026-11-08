/** 路由共用工具。Owner: lane G。 */
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AppDeps } from '../app.js';
import { books, auditLog } from '../db/schema.js';
import { safeRel } from '../book/index.js';
import { HttpProblem, badRequest, notFound } from './problem.js';

export type BookRow = typeof books.$inferSelect;

export async function bookBySlug(deps: Pick<AppDeps, 'db'>, slug: string): Promise<BookRow> {
  const rows = await deps.db.select().from(books).where(eq(books.slug, slug)).limit(1);
  if (!rows[0]) throw notFound(`书 ${slug} `);
  return rows[0];
}

export function bookDir(deps: Pick<AppDeps, 'paths'>, slug: string): string {
  return path.join(deps.paths.books, slug);
}

export const parseBody = <S extends z.ZodType>(schema: S, data: unknown): z.output<S> => schema.parse(data ?? {}) as z.output<S>;

/**
 * 部分更新：只保留请求里实际出现的顶层键。schema 带默认值的 .partial() 在 zod 4 下会把缺失的键填成默认值，
 * 直接覆盖当前记录会把没传的字段重置。
 */
export function parsePatch<S extends z.ZodType>(schema: S, data: unknown): Partial<z.output<S>> {
  const raw = (data ?? {}) as Record<string, unknown>;
  const parsed = schema.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => k in raw)) as Partial<z.output<S>>;
}

/** 校验仓库相对路径（越界 / .git → 400） */
export function requireRel(rel: unknown): string {
  if (typeof rel !== 'string' || rel === '') throw badRequest('缺少 path 参数');
  try {
    return safeRel(rel);
  } catch (e) {
    throw badRequest((e as Error).message, 'bad_path');
  }
}

export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): (string | number)[] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(v) ? v : null;
  } catch {
    throw badRequest('cursor 不合法', 'bad_cursor');
  }
}

export function actorOf(req: FastifyRequest): string {
  if (!req.auth) return 'system';
  if (req.auth.via === 'pat') return `pat:${req.auth.patId}`;
  return req.auth.role === 'admin' ? 'admin' : `reader:${req.auth.readerId}`;
}

export async function audit(deps: AppDeps, req: FastifyRequest, action: string, target: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await deps.db.insert(auditLog).values({ actor: actorOf(req), action, target, detail, ip: req.ip });
}

/** 把编排层抛的普通 Error（业务拒绝）转成 4xx */
export async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpProblem) throw e;
    if (e instanceof Error && /不存在|not found/i.test(e.message)) throw new HttpProblem(404, 'not_found', e.message);
    if (e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError)) throw new HttpProblem(409, 'domain_error', e.message);
    throw e;
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}
