/** harness 账号（D5）：env、凭据文件、交互登录结果登记、AccountView 映射。秘密值从不出这里。Owner: lane G。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { type Account, type AccountState, type AccountView, type AuthMode, type EnvBinding, type LoginSessionView, RISK_NOTES, zAccount, zAccountState, type zCreateAccount, zCredentialFile } from '@novelist/shared';
import type { z } from 'zod';
import type { AppDeps } from '../app.js';
import { accounts, accountsState, loginSessions } from '../db/schema.js';
import { type LoginHandle, type LoginResult, type ResolvedAccount, accountHome, detectInstalls, getAdapter, resolveAccount } from '../harness/index.js';
import { accountFromRow } from '../orchestrator/index.js';
import { HttpProblem, badRequest, conflict, notFound } from '../api/problem.js';

export async function loadAccount(deps: Pick<AppDeps, 'db'>, id: string): Promise<Account> {
  const rows = await deps.db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  if (!rows[0]) throw notFound(`账号 ${id} `);
  const acct = accountFromRow(rows[0]);
  if (!acct) throw new HttpProblem(422, 'invalid_account', `账号 ${id} 的数据不合法`);
  return acct;
}

export async function saveAccount(deps: Pick<AppDeps, 'db'>, acct: Account): Promise<void> {
  const { id, harness, label, authMode, enabled, ...body } = acct;
  await deps.db.update(accounts).set({ harness, label, authMode, enabled, body, updatedAt: new Date().toISOString() }).where(eq(accounts.id, id));
}

/** 写 env：secret=true 存 secrets 表、只留引用；非秘密值直接放 body */
export async function setAccountEnv(deps: Pick<AppDeps, 'secrets'>, acct: Account, name: string, value: string, secret: boolean): Promise<Account> {
  const others = acct.env.filter((e) => e.name !== name);
  let binding: EnvBinding;
  if (secret) {
    const ref = await deps.secrets.put({ kind: 'env', ownerKind: 'account', ownerId: acct.id, name, value });
    binding = { name, secretId: ref.id, secret: true };
  } else {
    const old = acct.env.find((e) => e.name === name);
    if (old?.secretId) await deps.secrets.delete(old.secretId);
    binding = { name, value, secret: false };
  }
  return { ...acct, env: [...others, binding] };
}

export async function removeAccountEnv(deps: Pick<AppDeps, 'secrets'>, acct: Account, name: string): Promise<Account> {
  const old = acct.env.find((e) => e.name === name);
  if (old?.secretId) await deps.secrets.delete(old.secretId);
  return { ...acct, env: acct.env.filter((e) => e.name !== name) };
}

export async function setAccountFile(deps: Pick<AppDeps, 'secrets'>, acct: Account, relPath: string, part: 'state' | 'config', content: Buffer): Promise<Account> {
  const ref = await deps.secrets.put({ kind: 'file', ownerKind: 'account', ownerId: acct.id, name: relPath, value: content });
  const entry = zCredentialFile.parse({ relPath, part, secretId: ref.id, uploadedAt: new Date().toISOString(), sha256: ref.sha256, bytes: ref.bytes });
  return { ...acct, files: [...acct.files.filter((f) => f.relPath !== relPath), entry] };
}

export async function removeAccountFile(deps: Pick<AppDeps, 'secrets'>, acct: Account, relPath: string): Promise<Account> {
  const old = acct.files.find((f) => f.relPath === relPath);
  if (old) await deps.secrets.delete(old.secretId);
  return { ...acct, files: acct.files.filter((f) => f.relPath !== relPath) };
}

/** 账号相关的风险提示（D5：只提示，不阻塞） */
export function riskNotesFor(acct: Account): AccountView['riskNotes'] {
  const ids: string[] = [];
  const subscription = acct.authMode === 'subscription_login' || acct.authMode === 'oauth_token';
  if (acct.harness === 'agy' && (subscription || acct.authMode === 'credential_file')) ids.push('agy_consumer_wrap');
  if (acct.harness === 'claude-code' && subscription) ids.push('cc_subscription_unattended');
  if (acct.harness === 'codex' && (subscription || acct.authMode === 'credential_file')) ids.push('codex_subscription_automation');
  if (acct.authMode === 'api_key' || acct.authMode === 'custom_api') ids.push('api_key_billing');
  return ids.map((id) => ({ id, level: RISK_NOTES[id]?.level ?? 'low', text: RISK_NOTES[id]?.text ?? '', acked: acct.riskAck.includes(id) }));
}

export async function toAccountView(deps: Pick<AppDeps, 'db'>, acct: Account): Promise<AccountView> {
  const stateRows = await deps.db.select().from(accountsState).where(eq(accountsState.accountId, acct.id)).limit(1);
  const st = stateRows[0];
  const state: AccountState | null = st ? zAccountState.parse({ accountId: st.accountId, sleepUntil: st.sleepUntil, sleepReason: st.sleepReason, util: st.util, credExpiresAt: st.credExpiresAt, lastAuthCheck: st.lastAuthCheck ?? null, activeRuns: 0 }) : null;
  const { env, ...rest } = acct;
  return {
    ...rest,
    env: env.map((e) => (e.secret ? { name: e.name, secret: true, set: !!e.secretId } : { name: e.name, secret: false, set: e.value !== undefined && e.value !== '', ...(e.value !== undefined ? { value: e.value } : {}) })),
    state,
    riskNotes: riskNotesFor(acct),
  };
}

export async function createAccountRow(deps: Pick<AppDeps, 'db' | 'secrets'>, input: z.output<typeof zCreateAccount>): Promise<Account> {
  const exists = await deps.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, input.id)).limit(1);
  if (exists[0]) throw conflict(`账号 ${input.id} 已存在`);
  const { env, ...rest } = input;
  const method = getAdapter(input.harness).authMethods().find((m) => m.mode === input.authMode);
  for (const group of method?.requireOneOf ?? []) {
    if (!group.some((name) => env.some((e) => e.name === name && e.value))) throw badRequest(`至少需要提供其一：${group.join(' / ')}`);
  }
  let acct: Account = zAccount.parse({ ...rest, env: [], files: [] });
  await deps.db.insert(accounts).values({ id: acct.id, harness: acct.harness, label: acct.label, authMode: acct.authMode, enabled: acct.enabled, body: {} });
  for (const e of env) acct = await setAccountEnv(deps, acct, e.name, e.value, e.secret);
  await saveAccount(deps, acct);
  return acct;
}

export async function deleteAccountCascade(deps: AppDeps, acct: Account): Promise<void> {
  for (const s of await deps.secrets.listByOwner('account', acct.id)) await deps.secrets.delete(s.id);
  await deps.db.delete(accounts).where(eq(accounts.id, acct.id));
  await fs.rm(path.dirname(accountHome(deps.paths, acct.id)), { recursive: true, force: true });
}

export async function installFor(deps: AppDeps, harness: Account['harness']) {
  const installs = await detectInstalls(deps.config.harnessDir);
  return installs.find((i) => i.id === harness) ?? null;
}

export function toLoginView(handle: LoginHandle): LoginSessionView {
  return { ...handle.session(), output: handle.output() };
}

async function persistSession(deps: AppDeps, handle: LoginHandle): Promise<void> {
  const s = handle.session();
  const values = { accountId: s.accountId, harness: s.harness, state: s.state, endedAt: s.endedAt, urls: s.urls, codes: s.codes, exitCode: s.exitCode, output: handle.output() };
  await deps.db.insert(loginSessions).values({ id: s.id, startedAt: s.startedAt, ...values }).onConflictDoUpdate({ target: loginSessions.id, set: values });
}

/** 启动交互登录：spawn adapter 的登录命令，输出转发到总线（SSE）并持久化会话 */
export async function startLogin(deps: AppDeps, acct: Account, mode: AuthMode | undefined): Promise<LoginSessionView> {
  const inst = await installFor(deps, acct.harness);
  if (!inst) throw conflict(`${acct.harness} 尚未安装，无法登录`, 'harness_not_installed');
  const resolved = await resolveAccount(acct, deps.paths, deps.secrets);
  const handle = await deps.logins.start(getAdapter(acct.harness), resolved, inst, mode ?? acct.authMode).catch((e: Error) => {
    throw new HttpProblem(400, 'login_unsupported', e.message);
  });
  const persist = () => persistSession(deps, handle).catch((err) => deps.log.warn({ err: (err as Error).message }, 'login session persist failed'));
  handle.subscribe((e) => {
    if (e.chunk) deps.bus.publish({ type: 'login_output', sessionId: handle.session().id, chunk: e.chunk });
    if (e.session) {
      deps.bus.publish({ type: 'login_state', session: e.session });
      void persist();
    }
  });
  await persist();
  return toLoginView(handle);
}

/** 登录成功：把 home 里新增/变化的凭据文件加密登记到账号；捕获的 env 秘密入库 */
export async function registerLoginResult(deps: Pick<AppDeps, 'db' | 'secrets'>, resolved: ResolvedAccount, result: LoginResult): Promise<void> {
  let acct = await loadAccount(deps, resolved.id);
  for (const f of result.files) {
    const buf = await fs.readFile(f.absPath);
    acct = await setAccountFile(deps, acct, f.relPath, f.part, buf);
  }
  for (const [name, value] of Object.entries(result.capturedEnv)) acct = await setAccountEnv(deps, acct, name, value, true);
  await saveAccount(deps, acct);
  const nowIso = new Date().toISOString();
  const check = { ok: true, ts: nowIso, detail: 'interactive login succeeded' };
  await deps.db.insert(accountsState).values({ accountId: acct.id, lastAuthCheck: check, updatedAt: nowIso }).onConflictDoUpdate({ target: accountsState.accountId, set: { lastAuthCheck: check, updatedAt: nowIso } });
}
