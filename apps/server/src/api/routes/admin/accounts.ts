/** /api/admin/accounts*、/api/admin/login-sessions*（D5；契约见 @novelist/shared ROUTES）。秘密值不出 API。Owner: lane G。 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AccountCheck, AccountView, LoginOutputChunk, LoginSessionView, Ok } from '@novelist/shared';
import { zAccount, zCreateAccount, zCredentialFile, zLoginInput, zPatchAccount, zPutEnv, zStartLogin } from '@novelist/shared';
import { z } from 'zod';
import type { AppDeps } from '../../../app.js';
import { accounts, accountsState, loginSessions } from '../../../db/schema.js';
import { getAdapter, resolveAccount } from '../../../harness/index.js';
import { CONFIG_ONLY_LABEL, probeCustomApi } from '../../../services/account-probe.js';
import { accountFromRow } from '../../../orchestrator/index.js';
import { createAccountRow, deleteAccountCascade, installFor, loadAccount, removeAccountEnv, removeAccountFile, saveAccount, setAccountEnv, setAccountFile, startLogin, toAccountView, toLoginView } from '../../../services/accounts.js';
import { audit, parseBody, parsePatch } from '../../helpers.js';
import { badRequest, conflict, notFound } from '../../problem.js';
import { openSse } from '../../sse.js';

type IdParams = { Params: { id: string } };
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const view = async (id: string): Promise<AccountView> => toAccountView(deps, await loadAccount(deps, id));

  app.get('/api/admin/accounts', async (): Promise<AccountView[]> => {
    const rows = await deps.db.select().from(accounts).orderBy(accounts.id);
    const out: AccountView[] = [];
    for (const r of rows) {
      const a = accountFromRow(r);
      if (a) out.push(await toAccountView(deps, a));
    }
    return out;
  });

  app.post('/api/admin/accounts', async (req, reply) => {
    const body = parseBody(zCreateAccount, req.body);
    const acct = await createAccountRow(deps, body);
    await audit(deps, req, 'account.create', acct.id, { harness: acct.harness, authMode: acct.authMode });
    return reply.code(201).send(await toAccountView(deps, acct));
  });

  app.get<IdParams>('/api/admin/accounts/:id', async (req) => view(req.params.id));

  app.patch<IdParams>('/api/admin/accounts/:id', async (req): Promise<AccountView> => {
    const body = parsePatch(zPatchAccount, req.body);
    const current = await loadAccount(deps, req.params.id);
    const { env, ...fields } = body;
    let next = zAccount.parse({ ...current, ...fields, id: current.id, harness: current.harness, env: current.env, files: current.files });
    for (const e of env ?? []) next = await setAccountEnv(deps, next, e.name, e.value, e.secret);
    await saveAccount(deps, next);
    await audit(deps, req, 'account.patch', current.id, { fields: Object.keys(fields) });
    return toAccountView(deps, next);
  });

  app.delete<IdParams>('/api/admin/accounts/:id', async (req): Promise<Ok> => {
    const acct = await loadAccount(deps, req.params.id);
    await deleteAccountCascade(deps, acct);
    await audit(deps, req, 'account.delete', acct.id);
    return { ok: true };
  });

  app.put<{ Params: { id: string; name: string } }>('/api/admin/accounts/:id/env/:name', async (req): Promise<AccountView> => {
    if (!ENV_RE.test(req.params.name)) throw badRequest('env 名称不合法');
    const body = parseBody(zPutEnv, req.body);
    const acct = await setAccountEnv(deps, await loadAccount(deps, req.params.id), req.params.name, body.value, body.secret);
    await saveAccount(deps, acct);
    await audit(deps, req, 'account.env.set', acct.id, { name: req.params.name, secret: body.secret });
    return toAccountView(deps, acct);
  });

  app.delete<{ Params: { id: string; name: string } }>('/api/admin/accounts/:id/env/:name', async (req): Promise<AccountView> => {
    const acct = await removeAccountEnv(deps, await loadAccount(deps, req.params.id), req.params.name);
    await saveAccount(deps, acct);
    await audit(deps, req, 'account.env.delete', acct.id, { name: req.params.name });
    return toAccountView(deps, acct);
  });

  app.post<IdParams>('/api/admin/accounts/:id/files', async (req, reply): Promise<AccountView> => {
    const acct = await loadAccount(deps, req.params.id);
    if (!req.isMultipart()) throw new (await import('../../problem.js')).HttpProblem(415, 'multipart_required', '需要 multipart/form-data');
    const fields: Record<string, string> = {};
    let content: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') content = await part.toBuffer();
      else fields[part.fieldname] = String(part.value);
    }
    if (!content) throw badRequest('缺少 file 字段');
    const relPath = zCredentialFile.shape.relPath.parse(fields.relPath);
    const part = z.enum(['state', 'config']).parse(fields.part ?? 'state');
    const next = await setAccountFile(deps, acct, relPath, part, content);
    await saveAccount(deps, next);
    await audit(deps, req, 'account.file.upload', acct.id, { relPath, part, bytes: content.length });
    return reply.send(await toAccountView(deps, next));
  });

  app.delete<IdParams & { Querystring: { relPath?: string } }>('/api/admin/accounts/:id/files', async (req): Promise<AccountView> => {
    if (!req.query.relPath) throw badRequest('缺少 relPath');
    const acct = await removeAccountFile(deps, await loadAccount(deps, req.params.id), req.query.relPath);
    await saveAccount(deps, acct);
    await audit(deps, req, 'account.file.delete', acct.id, { relPath: req.query.relPath });
    return toAccountView(deps, acct);
  });

  app.post<IdParams>('/api/admin/accounts/:id/verify', async (req): Promise<AccountCheck> => {
    const acct = await loadAccount(deps, req.params.id);
    const adapter = getAdapter(acct.harness);
    const checks: AccountCheck['checks'] = [];
    const inst = await installFor(deps, acct.harness);
    checks.push({ id: 'installed', ok: !!inst, detail: inst ? `${inst.version}（${inst.binPath}）` : `${acct.harness} 未安装` });
    const method = adapter.authMethods().find((m) => m.mode === acct.authMode);
    const missing = (method?.env ?? []).filter((e) => e.required && !acct.env.some((b) => b.name === e.name));
    checks.push({ id: 'required_env', ok: missing.length === 0, detail: missing.length ? `缺少：${missing.map((m) => m.name).join('、')}` : '必需的 env 已设置' });
    if (acct.harness === 'claude-code' && (acct.authMode === 'subscription_login' || acct.authMode === 'oauth_token')) {
      const hasKey = acct.env.some((b) => b.name === 'ANTHROPIC_API_KEY' || b.name === 'ANTHROPIC_AUTH_TOKEN');
      checks.push({ id: 'no_api_key_in_env', ok: !hasKey, detail: hasKey ? '订阅模式下不应设置 ANTHROPIC_API_KEY' : '订阅模式未携带 API key' });
    }
    let models: string[] = [...acct.customModels];
    let detail = '';
    let connectivity: AccountCheck['connectivity'] = null;
    const resolved = await resolveAccount(acct, deps.paths, deps.secrets);
    if (acct.authMode === 'custom_api') {
      const probe = await probeCustomApi(acct.harness, resolved.secretEnv);
      connectivity = probe.kind;
      checks.push({ id: 'connectivity', ok: probe.ok, detail: probe.detail });
      models = [...models, ...probe.models];
      detail = probe.detail;
    } else if (acct.authMode === 'api_key') {
      connectivity = 'config_only';
      detail = `${CONFIG_ONLY_LABEL}（密钥在第一次请求时才会校验）`;
    }
    if (inst) {
      if (adapter.authCheck) {
        const r = await adapter.authCheck(resolved, inst).catch((e: Error) => ({ ok: false, detail: e.message }));
        checks.push({ id: 'auth', ok: r.ok, detail: r.detail });
        if (connectivity === null || connectivity === 'config_only') detail = connectivity ? `${detail}；${r.detail}` : r.detail;
      }
      try {
        models = [...new Set([...models, ...(await adapter.listModels(resolved, inst))])].sort();
      } catch (e) {
        checks.push({ id: 'models', ok: false, detail: (e as Error).message });
      }
    }
    const ok = checks.every((c) => c.ok);
    const nowIso = new Date().toISOString();
    const lastAuthCheck = { ok, ts: nowIso, detail: detail || (ok ? '通过' : '未通过'), ...(connectivity === 'config_only' || connectivity === 'reachable' ? { configOnly: true } : {}) };
    await deps.db.insert(accountsState).values({ accountId: acct.id, lastAuthCheck, updatedAt: nowIso }).onConflictDoUpdate({ target: accountsState.accountId, set: { lastAuthCheck, updatedAt: nowIso } });
    return { ok, authMode: acct.authMode, detail: lastAuthCheck.detail, models: [...new Set(models)].sort(), checks, connectivity };
  });

  app.post<IdParams>('/api/admin/accounts/:id/login', async (req): Promise<LoginSessionView> => {
    const body = parseBody(zStartLogin, req.body);
    const acct = await loadAccount(deps, req.params.id);
    const view = await startLogin(deps, acct, body.mode);
    await audit(deps, req, 'account.login', acct.id, { mode: body.mode ?? acct.authMode });
    return view;
  });

  app.get<{ Params: { sid: string } }>('/api/admin/login-sessions/:sid', async (req): Promise<LoginSessionView> => {
    const h = deps.logins.get(req.params.sid);
    if (h) return toLoginView(h);
    const rows = await deps.db.select().from(loginSessions).where(eq(loginSessions.id, req.params.sid)).limit(1);
    const r = rows[0];
    if (!r) throw notFound('登录会话');
    return { id: r.id, accountId: r.accountId, harness: r.harness as LoginSessionView['harness'], state: r.state as LoginSessionView['state'], startedAt: r.startedAt, endedAt: r.endedAt, urls: r.urls, codes: r.codes, exitCode: r.exitCode, output: r.output as LoginOutputChunk[] };
  });

  app.get<{ Params: { sid: string }; Querystring: { after?: string } }>('/api/admin/login-sessions/:sid/stream', async (req, reply) => {
    const h = deps.logins.get(req.params.sid);
    if (!h) throw notFound('登录会话');
    const sse = openSse(reply);
    const sid = req.params.sid;
    const after = Number(req.query.after ?? -1);
    let lastSeq = Number.isFinite(after) ? after : -1;
    const sendChunk = (chunk: LoginOutputChunk) => {
      if (chunk.seq <= lastSeq) return;
      lastSeq = chunk.seq;
      sse.send({ type: 'login_output', sessionId: sid, chunk }, chunk.seq);
    };
    const finished = () => ['succeeded', 'failed', 'cancelled', 'expired'].includes(h.session().state);
    // 先订阅，补发已有输出（避免订阅前的 chunk 丢失），seq 去重
    const unsub = h.subscribe((e) => {
      if (e.chunk) sendChunk(e.chunk);
      if (e.session) {
        sse.send({ type: 'login_state', session: e.session });
        if (finished()) sse.close();
      }
    });
    sse.onClose(unsub);
    sse.send({ type: 'hello', ts: new Date().toISOString() });
    sse.send({ type: 'login_state', session: h.session() });
    for (const chunk of h.output(lastSeq)) sendChunk(chunk);
    if (finished()) sse.close();
  });

  app.post<{ Params: { sid: string } }>('/api/admin/login-sessions/:sid/input', async (req): Promise<Ok> => {
    const h = deps.logins.get(req.params.sid);
    if (!h) throw notFound('登录会话');
    const body = parseBody(zLoginInput, req.body);
    try {
      h.write(body.text, body.newline);
    } catch (e) {
      throw conflict((e as Error).message);
    }
    return { ok: true };
  });

  app.post<{ Params: { sid: string } }>('/api/admin/login-sessions/:sid/cancel', async (req): Promise<Ok> => {
    const h = deps.logins.get(req.params.sid);
    if (!h) throw notFound('登录会话');
    h.cancel();
    return { ok: true };
  });
}
