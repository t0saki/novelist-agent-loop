/**
 * DB 连接（pg 生产 / PGlite dev+test）与迁移。Owner: lane G。
 * 所有模块只依赖 `Db` 类型（drizzle PgDatabase，pg 与 PGlite 行为一致的子集）。
 * 注意 PGlite 单连接：不要在一个事务里等待另一个连接；SKIP LOCKED / advisory lock 在 PGlite 上退化为单进程语义。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { schema } from './schema.js';

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
/** 事务回调里拿到的对象（同 Db 接口） */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  kind: 'pg' | 'pglite';
  close(): Promise<void>;
  /** 原始 SQL（迁移、advisory lock、LISTEN/NOTIFY 用） */
  exec(query: string): Promise<void>;
  /** LISTEN/NOTIFY（仅 pg；进程拆分时给事件总线做跨进程桥） */
  notifier?: PgNotifier;
}

export interface PgNotifier {
  listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>>;
  notify(channel: string, payload: string): Promise<void>;
}

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface OpenDbOptions {
  /** postgres://… ；null → PGlite */
  url: string | null;
  /** PGlite 数据目录；null → 内存 */
  pgliteDir?: string | null;
  poolMax?: number;
}

/** 目标库不存在（3D000）时，连同一服务器的 postgres 库创建它（D3：v2 用新库 novelist2） */
async function ensureDatabase(url: string): Promise<void> {
  const { default: pg } = await import('pg');
  const probe = new pg.Client({ connectionString: url });
  try {
    await probe.connect();
    return;
  } catch (e) {
    if ((e as { code?: string }).code !== '3D000') throw e;
  } finally {
    await probe.end().catch(() => {});
  }
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  target.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(dbName)}`);
  } catch (e) {
    // 另一个进程抢先创建：42P04（duplicate_database）或并发创建时的 23505
    if (!['42P04', '23505'].includes((e as { code?: string }).code ?? '')) throw e;
  } finally {
    await admin.end().catch(() => {});
  }
}

export async function openDb(opts: OpenDbOptions): Promise<DbHandle> {
  if (opts.url && /^postgres(ql)?:\/\//.test(opts.url)) {
    await ensureDatabase(opts.url);
    const { default: pg } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new pg.Pool({ connectionString: opts.url, max: opts.poolMax ?? 10 });
    // 空闲连接断开时 pg 发 error 事件；没有监听器会让进程崩溃
    pool.on('error', (err) => console.error('pg pool error:', err.message));
    const db = drizzle(pool, { schema }) as unknown as Db;
    return {
      db,
      kind: 'pg',
      close: () => pool.end(),
      exec: async (q) => {
        await pool.query(q);
      },
      notifier: {
        async listen(channel, cb) {
          const client = await pool.connect();
          const onNotification = (m: { payload?: string }) => {
            if (m.payload !== undefined) cb(m.payload);
          };
          client.on('notification', onNotification);
          await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
          return async () => {
            client.off('notification', onNotification);
            await client.query(`UNLISTEN ${client.escapeIdentifier(channel)}`).catch(() => {});
            client.release();
          };
        },
        async notify(channel, payload) {
          await pool.query('select pg_notify($1, $2)', [channel, payload]);
        },
      },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  if (opts.pgliteDir) fs.mkdirSync(opts.pgliteDir, { recursive: true });
  const client = opts.pgliteDir ? new PGlite(opts.pgliteDir) : new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as Db;
  return {
    db,
    kind: 'pglite',
    close: () => client.close(),
    exec: async (q) => {
      await client.exec(q);
    },
  };
}

/** 应用 drizzle-kit 生成的迁移（只前进）。pg 与 PGlite 共用 MIGRATIONS_DIR */
export async function migrate(h: DbHandle): Promise<void> {
  if (h.kind === 'pg') {
    const { migrate: m } = await import('drizzle-orm/node-postgres/migrator');
    await m(h.db as never, { migrationsFolder: MIGRATIONS_DIR });
  } else {
    const { migrate: m } = await import('drizzle-orm/pglite/migrator');
    await m(h.db as never, { migrationsFolder: MIGRATIONS_DIR });
  }
}

export async function ping(h: DbHandle): Promise<string> {
  const r = (await h.db.execute(sql`select version() as v`)) as unknown as { rows?: { v: string }[] } | { v: string }[];
  const rows = Array.isArray(r) ? r : (r.rows ?? []);
  return rows[0]?.v ?? 'unknown';
}
