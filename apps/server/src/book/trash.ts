/**
 * 回收站（P3 D14）：产品在运行时删掉的、主人看得见的目录一律移到 $DATA/trash/<kind>/<name>-<时间>，不做不可恢复的删除。
 * 每个条目带一个 .novelist-trash.json 墓碑（删了什么、什么时候、数据库里原来的样子），回收站从不自动清理。
 * 恢复一本书：把目录移回 $DATA/books/<slug>，再 `novelist reindex <slug>`（数据库行要先按墓碑重建）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DataPaths } from '../config/index.js';

export const TRASH_TOMBSTONE = '.novelist-trash.json';

export function trashDir(paths: DataPaths, kind: 'books'): string {
  return path.join(paths.root, 'trash', kind);
}

const compactTs = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** srcDir → $DATA/trash/<kind>/<name>-<compactTs>（跨文件系统时复制后再删原目录），写墓碑；返回新位置 */
export async function moveToTrash(paths: DataPaths, kind: 'books', name: string, srcDir: string, tombstone: Record<string, unknown>): Promise<string> {
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) throw new Error(`回收站条目名不合法：${name}`);
  const root = trashDir(paths, kind);
  await fs.mkdir(root, { recursive: true });
  const now = new Date();
  let dest = path.join(root, `${name}-${compactTs(now)}`);
  // 同一秒内删两次同名目录：加序号，不覆盖已有条目
  for (let i = 2; await fs.stat(dest).then(() => true, () => false); i++) dest = path.join(root, `${name}-${compactTs(now)}-${i}`);
  await fs.rename(srcDir, dest).catch(async (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EXDEV') throw e;
    await fs.cp(srcDir, dest, { recursive: true, verbatimSymlinks: true });
    await fs.rm(srcDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dest, TRASH_TOMBSTONE), `${JSON.stringify({ kind, name, at: now.toISOString(), ...tombstone }, null, 2)}\n`, 'utf8');
  return dest;
}
