/**
 * 认证（§9.3、§9.6）：管理员密码（settings 'admin'，argon2id；首次启动取 NOVELIST_ADMIN_PASSWORD 或随机生成并打印）、
 * 具名读者密码（单框登录）、PAT（Authorization: Bearer nvpat_…）。会话 cookie `nv_sid`（httpOnly、SameSite=Lax、按协议决定 Secure），
 * cookie 值用 sessionSecret 签名，服务端只存 sha256(token)。Origin 校验（同源）。Owner: lane G。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MeResponse, SessionRole } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { pats, readers, sessions, settings } from '../db/schema.js';
import { hashPassword, passwordLookupId, verifyPassword } from '../services/passwords.js';
import { HttpProblem } from './problem.js';

export interface AuthContext {
  role: SessionRole;
  readerId: string | null;
  label: string | null;
  via: 'cookie' | 'pat';
  patId?: string;
  /** 当前会话 id（登出 / 改密码时保留当前会话） */
  sessionId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export const SESSION_COOKIE = 'nv_sid';
const REMEMBER_MS = 30 * 86400_000;
const SHORT_MS = 12 * 3600_000;
const TOUCH_MS = 60_000;

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface AdminSecret {
  pwHash: string;
  tokenVersion: number;
}

export async function loadAdminSecret(deps: Pick<AppDeps, 'db'>): Promise<AdminSecret | null> {
  const rows = await deps.db.select().from(settings).where(eq(settings.key, 'admin')).limit(1);
  return (rows[0]?.value as AdminSecret | undefined) ?? null;
}

export async function saveAdminSecret(deps: Pick<AppDeps, 'db'>, value: AdminSecret): Promise<void> {
  const row = { key: 'admin', value, updatedAt: new Date().toISOString() };
  await deps.db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: row.updatedAt } });
}

/** 首次启动：写入管理员密码。只有随机生成时返回明文（调用方打印一次） */
export async function ensureAdminPassword(deps: AppDeps): Promise<{ generated: string | null }> {
  if (await loadAdminSecret(deps)) return { generated: null };
  const generated = deps.config.adminPassword ? null : randomBytes(12).toString('base64url');
  await saveAdminSecret(deps, { pwHash: await hashPassword(deps.config.adminPassword ?? (generated as string)), tokenVersion: 1 });
  return { generated };
}

export function sessionSecretOf(deps: AppDeps): string {
  if (!deps.config.sessionSecret) throw new Error('sessionSecret 未加载');
  return deps.config.sessionSecret;
}

async function authFromPat(deps: AppDeps, token: string): Promise<AuthContext | null> {
  const rows = await deps.db.select().from(pats).where(and(eq(pats.hash, sha256hex(token)), isNull(pats.revokedAt))).limit(1);
  const pat = rows[0];
  if (!pat || !pat.scopes.includes('admin')) return null;
  const now = Date.now();
  if (!pat.lastUsedAt || now - Date.parse(pat.lastUsedAt) > TOUCH_MS) {
    await deps.db.update(pats).set({ lastUsedAt: new Date(now).toISOString() }).where(eq(pats.id, pat.id));
  }
  return { role: 'admin', readerId: null, label: pat.label, via: 'pat', patId: pat.id };
}

async function authFromCookie(deps: AppDeps, req: FastifyRequest): Promise<AuthContext | null> {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const id = sha256hex(unsigned.value);
  const rows = await deps.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  const s = rows[0];
  if (!s) return null;
  const now = Date.now();
  if (Date.parse(s.expiresAt) <= now) {
    await deps.db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  let ctx: AuthContext;
  if (s.role === 'admin') {
    const admin = await loadAdminSecret(deps);
    if (!admin || admin.tokenVersion !== s.tokenVersion) return null;
    ctx = { role: 'admin', readerId: null, label: null, via: 'cookie', sessionId: id };
  } else {
    if (!s.readerId) return null;
    const r = (await deps.db.select().from(readers).where(eq(readers.id, s.readerId)).limit(1))[0];
    if (!r || !r.enabled || r.tokenVersion !== s.tokenVersion) return null;
    ctx = { role: 'reader', readerId: r.id, label: r.label, via: 'cookie', sessionId: id };
    if (!r.lastSeenAt || now - Date.parse(r.lastSeenAt) > TOUCH_MS) {
      await deps.db.update(readers).set({ lastSeenAt: new Date(now).toISOString() }).where(eq(readers.id, r.id));
    }
  }
  if (!s.lastSeenAt || now - Date.parse(s.lastSeenAt) > TOUCH_MS) {
    await deps.db.update(sessions).set({ lastSeenAt: new Date(now).toISOString() }).where(eq(sessions.id, id));
  }
  return ctx;
}

export function requireRole(role: SessionRole | 'any') {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.auth) throw new HttpProblem(401, 'unauthenticated', '需要登录');
    if (role === 'admin' && req.auth.role !== 'admin') throw new HttpProblem(403, 'forbidden', '需要管理员权限');
  };
}

function originAllowed(deps: AppDeps, req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端（CLI、curl）不带 Origin
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host === req.host || deps.config.allowedOrigins.includes(host);
}

export function registerAuthHooks(app: FastifyInstance, deps: AppDeps): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
    if (bearer) {
      req.auth = await authFromPat(deps, bearer);
      if (!req.auth) throw new HttpProblem(401, 'invalid_token', 'PAT 无效或已吊销');
      return;
    }
    // 同源检查：cookie 认证的写请求（含登录）。GET/HEAD 不改状态，EventSource 也不带自定义头
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originAllowed(deps, req)) throw new HttpProblem(403, 'bad_origin', '跨源请求被拒绝');
    req.auth = await authFromCookie(deps, req);
  });
}

export function setSessionCookie(deps: AppDeps, req: FastifyRequest, reply: FastifyReply, token: string, maxAgeMs: number | null): void {
  reply.setCookie(SESSION_COOKIE, token, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !deps.config.insecureCookies && req.protocol === 'https',
    ...(maxAgeMs === null ? {} : { maxAge: Math.floor(maxAgeMs / 1000) }),
  });
}

async function createSession(deps: AppDeps, req: FastifyRequest, reply: FastifyReply, input: { role: SessionRole; readerId: string | null; tokenVersion: number; remember: boolean }): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const ttl = input.remember ? REMEMBER_MS : SHORT_MS;
  const now = Date.now();
  await deps.db.delete(sessions).where(lt(sessions.expiresAt, new Date(now).toISOString()));
  await deps.db.insert(sessions).values({
    id: sha256hex(token),
    role: input.role,
    readerId: input.readerId,
    tokenVersion: input.tokenVersion,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    ip: req.ip,
    ua: req.headers['user-agent']?.slice(0, 256) ?? null,
  });
  setSessionCookie(deps, req, reply, token, input.remember ? ttl : null);
}

async function upgradeLegacyReader(deps: AppDeps, id: string, password: string): Promise<void> {
  await deps.db
    .update(readers)
    .set({ pwHash: await hashPassword(password), lookupId: passwordLookupId(sessionSecretOf(deps), password), legacy: false })
    .where(eq(readers.id, id));
}

/** 单框登录：先管理员，再按 HMAC 前缀查读者，最后遍历尚未建立 lookup 的 v1 读者（首次成功后升级） */
export async function login(deps: AppDeps, req: FastifyRequest, reply: FastifyReply, password: string, remember: boolean): Promise<MeResponse> {
  const insecureCookies = deps.config.insecureCookies;
  const admin = await loadAdminSecret(deps);
  if (admin && (await verifyPassword(password, admin.pwHash)).ok) {
    await createSession(deps, req, reply, { role: 'admin', readerId: null, tokenVersion: admin.tokenVersion, remember });
    return { role: 'admin', insecureCookies };
  }
  const lookupId = passwordLookupId(sessionSecretOf(deps), password);
  const candidates = await deps.db.select().from(readers).where(and(eq(readers.lookupId, lookupId), eq(readers.enabled, true)));
  for (const r of candidates) {
    if (!(await verifyPassword(password, r.pwHash)).ok) continue;
    await createSession(deps, req, reply, { role: 'reader', readerId: r.id, tokenVersion: r.tokenVersion, remember });
    return { role: 'reader', readerId: r.id, label: r.label, insecureCookies };
  }
  const legacy = await deps.db.select().from(readers).where(and(eq(readers.legacy, true), eq(readers.enabled, true), isNull(readers.lookupId)));
  for (const r of legacy) {
    const v = await verifyPassword(password, r.pwHash);
    if (!v.ok) continue;
    await upgradeLegacyReader(deps, r.id, password);
    await createSession(deps, req, reply, { role: 'reader', readerId: r.id, tokenVersion: r.tokenVersion, remember });
    return { role: 'reader', readerId: r.id, label: r.label, insecureCookies };
  }
  throw new HttpProblem(401, 'bad_password', '密码错误');
}

export async function logout(deps: AppDeps, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.auth?.sessionId) await deps.db.delete(sessions).where(eq(sessions.id, req.auth.sessionId));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** 改管理员密码：tokenVersion+1 使其他管理员会话失效，当前会话跟随新版本 */
export async function changeAdminPassword(deps: AppDeps, req: FastifyRequest, current: string, next: string): Promise<void> {
  const admin = await loadAdminSecret(deps);
  if (!admin || !(await verifyPassword(current, admin.pwHash)).ok) throw new HttpProblem(403, 'bad_password', '当前密码错误');
  const tokenVersion = admin.tokenVersion + 1;
  await saveAdminSecret(deps, { pwHash: await hashPassword(next), tokenVersion });
  if (req.auth?.sessionId) await deps.db.update(sessions).set({ tokenVersion }).where(eq(sessions.id, req.auth.sessionId));
}

export async function deleteSessionsForReaders(deps: AppDeps, ids: string[]): Promise<void> {
  if (ids.length) await deps.db.delete(sessions).where(inArray(sessions.readerId, ids));
}
