/**
 * 密码（§9.6、§11）：argon2id（@node-rs/argon2）；v1 导入的 `pbkdf2$rounds$salthex$dkhex`（sha256）兼容校验，首次成功后重 hash。
 * 读者单框登录：lookupId = HMAC-SHA256(sessionSecret, password) 前 16 hex，按它查 readers，不遍历。Owner: lane G。
 */
import { createHmac, pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hash, verify } from '@node-rs/argon2';

const pbkdf2Async = promisify(pbkdf2);
/** argon2id（memory 19 MiB，OWASP 基线）；@node-rs/argon2 默认算法即 argon2id */
const ARGON2_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(pw: string): Promise<string> {
  return hash(pw, ARGON2_OPTS);
}

async function verifyPbkdf2(pw: string, stored: string): Promise<boolean> {
  const [, roundsS, saltHex, dkHex] = stored.split('$');
  const rounds = Number(roundsS);
  if (!Number.isInteger(rounds) || rounds <= 0 || !saltHex || !dkHex) return false;
  const expected = Buffer.from(dkHex, 'hex');
  if (expected.length === 0) return false;
  const dk = await pbkdf2Async(pw, Buffer.from(saltHex, 'hex'), rounds, expected.length, 'sha256');
  return timingSafeEqual(dk, expected);
}

export async function verifyPassword(pw: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  try {
    if (stored.startsWith('pbkdf2$')) {
      const ok = await verifyPbkdf2(pw, stored);
      return { ok, needsRehash: ok };
    }
    return { ok: await verify(stored, pw), needsRehash: false };
  } catch {
    return { ok: false, needsRehash: false };
  }
}

export function passwordLookupId(secret: string, pw: string): string {
  return createHmac('sha256', secret).update(pw).digest('hex').slice(0, 16);
}
