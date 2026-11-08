/**
 * 备份与恢复（DESIGN §9.3、§12 P1）。Owner: lane G。
 * 归档内容：$DATA 下的 books、instructions、genres、accounts、media，加上 db/<table>.jsonl（逻辑导出）。
 * 不含 harness（可重新安装）、runs（遥测）、.master_key（必须单独保管）。pg_dump 依赖版本匹配，这里用逻辑导出，pg 与 PGlite 通用。
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';

const DATA_DIRS = ['books', 'instructions', 'genres', 'accounts', 'media'];
const SKIP_TABLES = new Set(['__drizzle_migrations']);
const BATCH = 500;

type Rows = { rows: Record<string, unknown>[] };

function tar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar 失败（exit ${code}）：${err.trim()}`))));
  });
}

async function tablesOf(deps: AppDeps): Promise<string[]> {
  const res = (await deps.db.execute(sql`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name`)) as unknown as Rows;
  return res.rows.map((r) => String(r.table_name)).filter((t) => !SKIP_TABLES.has(t));
}

const quote = (t: string): string => `"${t.replace(/"/g, '""')}"`;

export async function createBackup(deps: AppDeps, outFile: string): Promise<{ file: string; tables: Record<string, number> }> {
  const work = await fs.mkdtemp(path.join(deps.paths.tmp, 'backup-'));
  const dbDir = path.join(work, 'db');
  await fs.mkdir(dbDir, { recursive: true });
  const counts: Record<string, number> = {};
  try {
    for (const table of await tablesOf(deps)) {
      const out = createWriteStream(path.join(dbDir, `${table}.jsonl`));
      let n = 0;
      for (let offset = 0; ; offset += BATCH) {
        const res = (await deps.db.execute(sql.raw(`select to_jsonb(t) as row from (select * from ${quote(table)} limit ${BATCH} offset ${offset}) t`))) as unknown as Rows;
        for (const r of res.rows) {
          out.write(`${JSON.stringify(r.row)}\n`);
          n += 1;
        }
        if (res.rows.length < BATCH) break;
      }
      await new Promise<void>((resolve, reject) => out.end((err: Error | null | undefined) => (err ? reject(err) : resolve())));
      counts[table] = n;
    }
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const present: string[] = [];
    for (const d of DATA_DIRS) if (await fs.stat(path.join(deps.paths.root, d)).then(() => true, () => false)) present.push(d);
    await tar(['-czf', outFile, '-C', work, 'db', '-C', deps.paths.root, ...present]);
    return { file: outFile, tables: counts };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function readBatches(file: string, onBatch: (rows: string[]) => Promise<void>): Promise<void> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
  let batch: string[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    batch.push(line);
    if (batch.length >= BATCH) {
      await onBatch(batch);
      batch = [];
    }
  }
  if (batch.length) await onBatch(batch);
}

/** 覆盖式恢复：清空各表后导入，$DATA 目录替换为归档里的内容。需要主密钥（secrets 表是密文） */
export async function restoreBackup(deps: AppDeps, archive: string): Promise<{ tables: Record<string, number> }> {
  const work = await fs.mkdtemp(path.join(deps.paths.tmp, 'restore-'));
  const counts: Record<string, number> = {};
  try {
    await tar(['-xzf', archive, '-C', work]);
    const tables = (await fs.readdir(path.join(work, 'db'))).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));
    const known = new Set(await tablesOf(deps));
    await deps.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local session_replication_role = 'replica'`));
      for (const t of tables) if (known.has(t)) await tx.execute(sql.raw(`delete from ${quote(t)}`));
      for (const t of tables) {
        if (!known.has(t)) continue;
        let n = 0;
        await readBatches(path.join(work, 'db', `${t}.jsonl`), async (rows) => {
          await tx.execute(sql`insert into ${sql.raw(quote(t))} select * from jsonb_populate_recordset(null::${sql.raw(quote(t))}, ${`[${rows.join(',')}]`}::jsonb)`);
          n += rows.length;
        });
        counts[t] = n;
      }
      // bigserial 序列不随 insert 前进：不重置的话恢复后第一条新行就撞主键
      const serials = (await tx.execute(sql`select table_name, column_name from information_schema.columns where table_schema='public' and column_default like 'nextval(%'`)) as unknown as Rows;
      for (const r of serials.rows) {
        const [t, c] = [String(r.table_name), String(r.column_name)];
        if (!tables.includes(t) || !known.has(t)) continue;
        await tx.execute(sql`select setval(pg_get_serial_sequence(${quote(t)}, ${c}), coalesce((select max(${sql.raw(quote(c))}) from ${sql.raw(quote(t))}), 1), (select count(*) > 0 from ${sql.raw(quote(t))}))`);
      }
    });
    for (const d of DATA_DIRS) {
      const src = path.join(work, d);
      if (!(await fs.stat(src).then(() => true, () => false))) continue;
      const dest = path.join(deps.paths.root, d);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.cp(src, dest, { recursive: true, verbatimSymlinks: true });
    }
    return { tables: counts };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
