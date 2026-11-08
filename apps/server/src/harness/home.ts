/**
 * 账号 home 管理（DESIGN §3.6 Home 布局）。Owner: lane A。
 * $DATA/accounts/<accountId>/home 持久（状态部分）；配置部分每 run 由 adapter.prepareHome 重写，run 后 hash 校验。
 * 凭据文件（secrets 表里的加密文件）在 run 前解密写入 home（0600），state 部分的文件 run 后若被 harness 刷新则回写 secrets。
 *
 * 新旧判定（state 文件）：$H/.nv/creds.json 记录“上次物化/回写时的 sha256”。
 *   - 磁盘 sha == 记录 且 ≠ secret sha → 用户在 UI 上传了新文件 → 覆盖磁盘；
 *   - 磁盘 sha ≠ 记录 → harness 刷新过（如 codex auth.json）→ 保留磁盘，syncBack 时回写 secrets；
 *   - 磁盘不存在 → 写入。config 部分总是覆盖。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Account } from '@novelist/shared';
import type { DataPaths } from '../config/index.js';
import type { SecretStore } from '../services/secrets.js';
import type { ResolvedAccount } from './types.js';
import { atomicWrite, isInside, readJsonFile, sha256Buf, sha256FileImpl } from './util.js';

export function accountHome(paths: DataPaths, accountId: string): string {
  return `${paths.accounts}/${accountId}/home`;
}

const MARKER = '.nv/creds.json';
type Marker = Record<string, string>;

async function readMarker(home: string): Promise<Marker> {
  return (await readJsonFile<Marker>(path.join(home, MARKER))) ?? {};
}
async function writeMarker(home: string, m: Marker): Promise<void> {
  await atomicWrite(path.join(home, MARKER), JSON.stringify(m, null, 2), 0o600);
}

function safeJoin(home: string, rel: string): string {
  const abs = path.resolve(home, rel);
  if (!isInside(abs, home) || abs === home) throw new Error(`凭据路径越界：${rel}`);
  return abs;
}

/** 解密 env 与凭据文件，物化到 home，返回 ResolvedAccount（只在内存） */
export async function resolveAccount(acct: Account, paths: DataPaths, secrets: SecretStore): Promise<ResolvedAccount> {
  const home = accountHome(paths, acct.id);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const secretEnv: Record<string, string> = {};
  for (const b of acct.env ?? []) {
    if (b.value !== undefined && b.value !== '') secretEnv[b.name] = b.value;
    else if (b.secretId) secretEnv[b.name] = await secrets.getString(b.secretId);
  }
  const marker = await readMarker(home);
  const credentialFiles: ResolvedAccount['credentialFiles'] = [];
  for (const f of acct.files ?? []) {
    const abs = safeJoin(home, f.relPath);
    let diskSha: string | null = null;
    try {
      diskSha = await sha256FileImpl(abs);
    } catch {
      diskSha = null;
    }
    const refreshedByHarness = f.part === 'state' && diskSha !== null && marker[f.relPath] !== undefined && diskSha !== marker[f.relPath];
    if (!refreshedByHarness && diskSha !== f.sha256) {
      const buf = await secrets.get(f.secretId);
      await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
      await atomicWrite(abs, buf, 0o600);
      marker[f.relPath] = sha256Buf(buf);
    } else if (diskSha !== null && marker[f.relPath] === undefined) {
      marker[f.relPath] = diskSha;
    }
    credentialFiles.push({ relPath: f.relPath, absPath: abs, part: f.part });
  }
  await writeMarker(home, marker);
  return { ...acct, home, secretEnv, credentialFiles };
}

/**
 * run 后：state 部分的凭据文件若变化（如 codex auth.json 刷新），重新加密写回 secrets。
 * 返回变化的 relPath；同时就地更新 acct.files 对应条目（secretId/sha256/bytes），调用方负责把 acct.files 持久化到 accounts 表。
 */
export async function syncBackCredentials(acct: ResolvedAccount, secrets: SecretStore): Promise<string[]> {
  const marker = await readMarker(acct.home);
  const changed: string[] = [];
  for (const cf of acct.credentialFiles) {
    if (cf.part !== 'state') continue;
    let buf: Buffer;
    try {
      buf = await fs.readFile(cf.absPath);
    } catch {
      continue;
    }
    const sha = sha256Buf(buf);
    const entry = acct.files.find((f) => f.relPath === cf.relPath);
    if (entry && entry.sha256 === sha) {
      marker[cf.relPath] = sha;
      continue;
    }
    const ref = await secrets.put({ kind: 'file', ownerKind: 'account', ownerId: acct.id, name: cf.relPath, value: buf });
    if (entry) {
      entry.secretId = ref.id;
      entry.sha256 = ref.sha256 || sha;
      entry.bytes = ref.bytes || buf.length;
    }
    marker[cf.relPath] = sha;
    changed.push(cf.relPath);
  }
  await writeMarker(acct.home, marker);
  return changed;
}

export function sha256File(path: string): Promise<string> {
  return sha256FileImpl(path);
}

/** 登录前快照：给定相对路径集合的 sha（不存在 = null），登录后比较得出新增/变化的凭据文件 */
export async function snapshotFiles(home: string, relPaths: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const r of relPaths) {
    try {
      out[r] = await sha256FileImpl(path.join(home, r));
    } catch {
      out[r] = null;
    }
  }
  return out;
}

/** 内存版 SecretStore（测试 / 无 DB 场景） */
export function createMemorySecretStore(): SecretStore {
  const m = new Map<string, { kind: string; ownerKind: string; ownerId: string | null; name: string; value: Buffer; updatedAt: string }>();
  let n = 0;
  const keyOf = (i: { kind: string; ownerKind: string; ownerId: string | null; name: string }) => `${i.ownerKind}:${i.ownerId}:${i.kind}:${i.name}`;
  return {
    async put(i) {
      const value = Buffer.isBuffer(i.value) ? i.value : Buffer.from(i.value);
      const existing = [...m.entries()].find(([, v]) => keyOf(v) === keyOf(i));
      const id = existing?.[0] ?? `sec_${++n}`;
      m.set(id, { ...i, value, updatedAt: new Date().toISOString() });
      return { id, sha256: sha256Buf(value), bytes: value.length };
    },
    async get(id) {
      const v = m.get(id);
      if (!v) throw new Error(`secret ${id} not found`);
      return v.value;
    },
    async getString(id) {
      return (await this.get(id)).toString('utf8');
    },
    async delete(id) {
      m.delete(id);
    },
    async listByOwner(ownerKind, ownerId) {
      return [...m.entries()]
        .filter(([, v]) => v.ownerKind === ownerKind && v.ownerId === ownerId)
        .map(([id, v]) => ({ id, kind: v.kind, name: v.name, sha256: sha256Buf(v.value), bytes: v.value.length, updatedAt: v.updatedAt }));
    },
    async rotate() {
      return m.size;
    },
  };
}
