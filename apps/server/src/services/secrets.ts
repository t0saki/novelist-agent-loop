/**
 * 秘密存储（D5）：AES-256-GCM，主密钥来自 NOVELIST_MASTER_KEY（base64 32B 或 hex 64）或生成到 $DATA/.master_key（0600）。
 * 存储格式：secrets.ciphertext = base64(iv[12] | ciphertext | tag[16])；AAD = `${ownerKind}:${ownerId}:${kind}:${name}`。
 * 明文从不入库、不出 API、不进日志。Owner: lane G。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Db } from '../db/client.js';
import { secrets } from '../db/schema.js';

export interface SecretRef {
  id: string;
  sha256: string;
  bytes: number;
}

export interface SecretStore {
  put(input: { kind: 'env' | 'file' | 'system'; ownerKind: 'account' | 'system'; ownerId: string | null; name: string; value: Buffer | string }): Promise<SecretRef>;
  get(id: string): Promise<Buffer>;
  getString(id: string): Promise<string>;
  delete(id: string): Promise<void>;
  listByOwner(ownerKind: 'account' | 'system', ownerId: string | null): Promise<{ id: string; kind: string; name: string; sha256: string; bytes: number; updatedAt: string }[]>;
  /** 用新主密钥重加密全部（novelist secrets rotate-master-key） */
  rotate(newKey: Buffer): Promise<number>;
}

export function parseMasterKey(value: string): Buffer {
  const v = value.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (buf.length !== 32) throw new Error('主密钥必须是 32 字节（base64）或 64 位 hex');
  return buf;
}

export async function loadMasterKey(input: { envValue: string | null; keyFile: string }): Promise<{ key: Buffer; source: 'env' | 'file' | 'generated' }> {
  if (input.envValue) return { key: parseMasterKey(input.envValue), source: 'env' };
  try {
    return { key: parseMasterKey(await fs.readFile(input.keyFile, 'utf8')), source: 'file' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const key = randomBytes(32);
  await fs.mkdir(path.dirname(input.keyFile), { recursive: true });
  await fs.writeFile(input.keyFile, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  return { key, source: 'generated' };
}

/** 会话 / lookup HMAC 的密钥：NOVELIST_SESSION_SECRET 或 $DATA/.session_secret（0600） */
export async function loadSessionSecret(input: { envValue: string | null; keyFile: string }): Promise<string> {
  if (input.envValue) return input.envValue;
  try {
    const v = (await fs.readFile(input.keyFile, 'utf8')).trim();
    if (v) return v;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const v = randomBytes(32).toString('base64url');
  await fs.mkdir(path.dirname(input.keyFile), { recursive: true });
  await fs.writeFile(input.keyFile, `${v}\n`, { mode: 0o600 });
  return v;
}

export function encrypt(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}

export function decrypt(key: Buffer, blob: string, aad: string): Buffer {
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < 28) throw new Error('密文长度不合法');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
}

const aadOf = (r: { ownerKind: string; ownerId: string | null; kind: string; name: string }) => `${r.ownerKind}:${r.ownerId ?? ''}:${r.kind}:${r.name}`;

export function createSecretStore(db: Db, initialKey: Buffer): SecretStore {
  let key = initialKey;
  const load = async (id: string) => {
    const rows = await db.select().from(secrets).where(eq(secrets.id, id)).limit(1);
    if (!rows[0]) throw new Error(`secret ${id} 不存在`);
    return rows[0];
  };
  const store: SecretStore = {
    async put(input) {
      const value = Buffer.isBuffer(input.value) ? input.value : Buffer.from(input.value, 'utf8');
      const sha256 = createHash('sha256').update(value).digest('hex');
      const ciphertext = encrypt(key, value, aadOf(input));
      const now = new Date().toISOString();
      // ownerId 为 NULL 时唯一索引不生效（NULL 互不相等），用先查后写的 upsert
      const owner = input.ownerId === null ? isNull(secrets.ownerId) : eq(secrets.ownerId, input.ownerId);
      const existing = await db.select({ id: secrets.id }).from(secrets).where(and(eq(secrets.ownerKind, input.ownerKind), owner, eq(secrets.kind, input.kind), eq(secrets.name, input.name))).limit(1);
      if (existing[0]) {
        await db.update(secrets).set({ ciphertext, sha256, bytes: value.length, updatedAt: now }).where(eq(secrets.id, existing[0].id));
        return { id: existing[0].id, sha256, bytes: value.length };
      }
      const id = `sec_${nanoid(16)}`;
      await db.insert(secrets).values({ id, kind: input.kind, ownerKind: input.ownerKind, ownerId: input.ownerId, name: input.name, ciphertext, sha256, bytes: value.length, createdAt: now, updatedAt: now });
      return { id, sha256, bytes: value.length };
    },
    async get(id) {
      const row = await load(id);
      return decrypt(key, row.ciphertext, aadOf(row));
    },
    async getString(id) {
      return (await store.get(id)).toString('utf8');
    },
    async delete(id) {
      await db.delete(secrets).where(eq(secrets.id, id));
    },
    async listByOwner(ownerKind, ownerId) {
      const owner = ownerId === null ? isNull(secrets.ownerId) : eq(secrets.ownerId, ownerId);
      const rows = await db.select().from(secrets).where(and(eq(secrets.ownerKind, ownerKind), owner));
      return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, sha256: r.sha256, bytes: r.bytes, updatedAt: r.updatedAt }));
    },
    async rotate(newKey) {
      if (newKey.length !== 32) throw new Error('新主密钥必须是 32 字节');
      const rows = await db.select().from(secrets);
      await db.transaction(async (tx) => {
        for (const r of rows) {
          const plain = decrypt(key, r.ciphertext, aadOf(r));
          await tx.update(secrets).set({ ciphertext: encrypt(newKey, plain, aadOf(r)), keyVersion: r.keyVersion + 1, updatedAt: new Date().toISOString() }).where(eq(secrets.id, r.id));
        }
      });
      key = newKey;
      return rows.length;
    },
  };
  return store;
}
