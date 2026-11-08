/** /api/admin/runs*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, gt, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { NEvent, Ok, Page, RunDetail, RunRow } from '@novelist/shared';
import { zPageQuery, zRunEventsQuery } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { books, runEvents, runs, tasks } from '../../../db/schema.js';
import { logFiles } from '../../../harness/index.js';
import { toRunRow } from '../../../services/chapters.js';
import { audit, bookDir, decodeCursor, domain, encodeCursor } from '../../helpers.js';
import { badRequest, notFound } from '../../problem.js';
import { openSse } from '../../sse.js';

const TERMINAL_RUN_STATES = new Set(['exited', 'finalized', 'lost', 'killed']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** body 列不含 seq/ts/runId（executor 落库时拆到了独立列），读出时必须拼回去，否则前端按 seq 去重会全部塌成一条 */
function eventFromRow(row: typeof runEvents.$inferSelect): NEvent {
  return { ...row.body, seq: row.seq, ts: row.ts, runId: row.runId } as unknown as NEvent;
}

async function runRow(deps: AppDeps, id: string) {
  const rows = await deps.db.select().from(runs).where(eq(runs.id, id)).limit(1);
  if (!rows[0]) throw notFound(`run ${id} `);
  return rows[0];
}

async function slugOf(deps: AppDeps, bookId: string | null): Promise<string | null> {
  if (!bookId) return null;
  const rows = await deps.db.select({ slug: books.slug }).from(books).where(eq(books.id, bookId)).limit(1);
  return rows[0]?.slug ?? null;
}

/** run 文件三个区：in/log 在 $RUN；out 在 live 树 work/<task>/attempt-k/out（收割后），否则快照里 */
async function areaRoot(deps: AppDeps, run: typeof runs.$inferSelect, area: string): Promise<string> {
  if (area === 'in' || area === 'log') return path.join(run.runDir, area);
  if (area === 'out') {
    const task = (await deps.db.select({ bookId: tasks.bookId }).from(tasks).where(eq(tasks.id, run.taskId)).limit(1))[0];
    const slug = await slugOf(deps, task?.bookId ?? run.bookId);
    if (slug) {
      const live = path.join(bookDir(deps, slug), 'work', run.taskId, `attempt-${run.attempt}`, 'out');
      if (await fs.stat(live).then(() => true, () => false)) return live;
    }
    return path.join(run.runDir, 'book', 'work', run.taskId, `attempt-${run.attempt}`, 'out');
  }
  throw badRequest('area 只能是 in、log、out');
}

async function walkFiles(root: string, area: 'in' | 'log' | 'out', prefix = ''): Promise<RunDetail['files']> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  const out: RunDetail['files'] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(root, area, rel)));
    else if (e.isFile() && !e.name.startsWith('.secret')) {
      const st = await fs.stat(path.join(root, rel)).catch(() => null);
      out.push({ path: rel, size: st?.size ?? 0, area });
    }
  }
  return out;
}

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Querystring: { cursor?: string; limit?: string; book?: string; state?: string; harness?: string } }>('/api/admin/runs', async (req): Promise<Page<RunRow>> => {
    const q = zPageQuery.parse(req.query);
    const where: SQL[] = [];
    if (req.query.book) {
      const b = await deps.db.select({ id: books.id }).from(books).where(eq(books.slug, req.query.book)).limit(1);
      where.push(eq(runs.bookId, b[0]?.id ?? '__none__'));
    }
    if (req.query.state) where.push(eq(runs.state, req.query.state));
    if (req.query.harness) where.push(eq(runs.harness, req.query.harness));
    const cur = decodeCursor(q.cursor);
    if (cur) {
      const [ts, id] = cur as [string, string];
      where.push(or(lt(runs.createdAt, ts), and(eq(runs.createdAt, ts), lt(runs.id, id))) as SQL);
    }
    const rows = await deps.db.select().from(runs).where(where.length ? and(...where) : undefined).orderBy(desc(runs.createdAt), desc(runs.id)).limit(q.limit + 1);
    const slugs = new Map((await deps.db.select({ id: books.id, slug: books.slug }).from(books)).map((b) => [b.id, b.slug]));
    const items = rows.slice(0, q.limit).map((r) => toRunRow(r, r.bookId ? (slugs.get(r.bookId) ?? null) : null));
    const last = rows[q.limit - 1];
    return { items, nextCursor: rows.length > q.limit && last ? encodeCursor([last.createdAt, last.id]) : null };
  });

  app.get<{ Params: { id: string } }>('/api/admin/runs/:id', async (req): Promise<RunDetail> => {
    const r = await runRow(deps, req.params.id);
    const files = [
      ...(await walkFiles(await areaRoot(deps, r, 'in'), 'in')),
      ...(await walkFiles(await areaRoot(deps, r, 'log'), 'log')),
      ...(await walkFiles(await areaRoot(deps, r, 'out'), 'out')),
    ];
    let argvPreview: string[] = [];
    try {
      const meta = JSON.parse(await fs.readFile(logFiles(path.join(r.runDir, 'log')).meta, 'utf8')) as { argvPreview?: string[] };
      argvPreview = meta.argvPreview ?? [];
    } catch {
      // meta 尚未写入或已清理
    }
    return { ...toRunRow(r, await slugOf(deps, r.bookId)), outcome: (r.outcome as RunDetail['outcome']) ?? null, nonceReport: (r.nonceReport as RunDetail['nonceReport']) ?? null, files, argvPreview };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>('/api/admin/runs/:id/events', async (req): Promise<NEvent[]> => {
    const q = zRunEventsQuery.parse(req.query);
    const rows = await deps.db.select().from(runEvents).where(and(eq(runEvents.runId, req.params.id), gt(runEvents.seq, q.after))).orderBy(asc(runEvents.seq)).limit(q.limit);
    return rows.map(eventFromRow);
  });

  app.get<{ Params: { id: string }; Querystring: { area?: string; path?: string } }>('/api/admin/runs/:id/file', async (req, reply) => {
    const r = await runRow(deps, req.params.id);
    const root = await areaRoot(deps, r, req.query.area ?? 'log');
    const rel = req.query.path ?? '';
    const abs = path.resolve(root, rel);
    if (rel === '' || !abs.startsWith(`${path.resolve(root)}${path.sep}`)) throw badRequest('path 越界');
    // harness 可写 log/、out/，软链可能指向 run 目录外（/data/.master_key）：按真实路径校验
    const [realRoot, real] = await Promise.all([fs.realpath(root).catch(() => null), fs.realpath(abs).catch(() => null)]);
    if (!realRoot || !real || !real.startsWith(`${realRoot}${path.sep}`)) throw notFound(`文件 ${rel} `);
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isFile()) throw notFound(`文件 ${rel} `);
    // 敏感文件（秘密 env）不出 API
    if (/secret|\.env$/i.test(path.basename(real))) throw notFound(`文件 ${rel} `);
    const fh = await fs.open(real, 'r');
    try {
      const size = Math.min(stat.size, MAX_FILE_BYTES);
      const { buffer } = await fh.read(Buffer.alloc(size), 0, size, 0);
      if (stat.size > MAX_FILE_BYTES) reply.header('x-truncated', 'true');
      return reply.type('text/plain; charset=utf-8').send(buffer);
    } finally {
      await fh.close();
    }
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/admin/runs/:id/stream', async (req, reply) => {
    const r = await runRow(deps, req.params.id);
    const lastId = Number(req.headers['last-event-id'] ?? req.query.after ?? -1);
    const sse = openSse(reply);
    const startSeq = Number.isFinite(lastId) ? lastId : -1;
    let maxSeq = startSeq;
    const pending: NEvent[] = [];
    let replaying = true;
    const deliver = (ev: NEvent) => {
      if (ev.seq <= maxSeq) return;
      maxSeq = ev.seq;
      sse.send({ type: 'run_event', runId: r.id, event: ev }, ev.seq);
    };
    const unsubscribe = deps.bus.subscribe(
      (e) => {
        if (e.type === 'run_event') {
          if (replaying) pending.push(e.event);
          else deliver(e.event);
        } else if (e.type === 'run_exit') {
          sse.send(e);
          sse.close();
        }
      },
      (e) => (e.type === 'run_event' || e.type === 'run_exit') && e.runId === r.id,
    );
    sse.onClose(unsubscribe);
    sse.send({ type: 'hello', ts: new Date().toISOString() });
    const history = await deps.db.select().from(runEvents).where(and(eq(runEvents.runId, r.id), gt(runEvents.seq, startSeq))).orderBy(asc(runEvents.seq)).limit(20000);
    for (const row of history) deliver(eventFromRow(row));
    replaying = false;
    for (const ev of pending) deliver(ev);
    const fresh = await runRow(deps, r.id);
    if (TERMINAL_RUN_STATES.has(fresh.state)) {
      sse.send({ type: 'run_exit', runId: r.id, state: fresh.state as RunRow['state'], errorClass: (fresh.errorClass as RunRow['errorClass']) ?? null });
      sse.close();
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/runs/:id/kill', async (req): Promise<Ok> => {
    await domain(() => deps.orchestrator.killRun(req.params.id));
    await audit(deps, req, 'run.kill', req.params.id);
    return { ok: true };
  });
}
