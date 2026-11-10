/**
 * Fastify 5 应用（§9.7）：/api/* 路由 + @fastify/static 托管 apps/web/dist（SPA fallback 到 index.html）。
 * 只有对外监听器；MCP 等内部服务不在这里注册（§8）。Owner: lane G。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { ApiProblem } from '@novelist/shared';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { CanonicalParseError } from '../book/index.js';
import { StaleBaseError } from '../orchestrator/index.js';
import { registerAuthHooks, requireRole, sessionSecretOf } from './auth.js';
import { HttpProblem } from './problem.js';
import { isoDeep } from './iso.js';
import { closeAllSse } from './sse.js';
import { register as registerAuthRoutes } from './routes/auth.js';
import { register as registerReader } from './routes/reader.js';
import { register as registerBooks } from './routes/admin/books.js';
import { register as registerChapters } from './routes/admin/chapters.js';
import { register as registerTasks } from './routes/admin/tasks.js';
import { register as registerRuns } from './routes/admin/runs.js';
import { register as registerInbox } from './routes/admin/inbox.js';
import { register as registerInstructions } from './routes/admin/instructions.js';
import { register as registerGenres } from './routes/admin/genres.js';
import { register as registerHarness } from './routes/admin/harness.js';
import { register as registerAccounts } from './routes/admin/accounts.js';
import { register as registerRouting } from './routes/admin/routing.js';
import { register as registerSchedule } from './routes/admin/schedule.js';
import { register as registerReaders } from './routes/admin/readers.js';
import { register as registerSettings } from './routes/admin/settings.js';
import { register as registerImport } from './routes/admin/import.js';
import { register as registerV3 } from './routes/admin/v3.js';

const PROBLEM_TYPE = 'application/problem+json';

function toProblem(err: FastifyError | Error, req: FastifyRequest): ApiProblem {
  if (err instanceof HttpProblem) return err.toJSON();
  if (err instanceof z.ZodError) {
    return { type: 'https://novelist/errors/validation', title: '请求参数校验失败', status: 400, code: 'validation', errors: err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) };
  }
  if (err instanceof StaleBaseError) return { type: 'https://novelist/errors/stale_base', title: '文件已被修改，请刷新后重试', status: 409, code: 'stale_base', detail: err.message };
  if (err instanceof CanonicalParseError) return { type: 'https://novelist/errors/canonical_parse', title: `书库文件不合法：${err.path}`, status: 422, code: 'canonical_parse', errors: err.issues };
  const status = (err as FastifyError).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return { type: 'about:blank', title: err.message, status, code: (err as FastifyError).code ?? 'client_error' };
  const problem: ApiProblem = { type: 'about:blank', title: '服务器内部错误', status: 500, code: 'internal' };
  if (req.auth?.role === 'admin') problem.detail = err.message; // 单用户控制台：把原因告诉管理员
  return problem;
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.log as unknown as FastifyBaseLogger, logController: new LogController({ disableRequestLogging: true }), trustProxy: deps.config.trustProxy, bodyLimit: 16 * 1024 * 1024, forceCloseConnections: true });

  // POST 无 body 时 fastify 默认报 400；CLI 与部分前端调用是空 body
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpProblem(400, 'bad_json', '请求体不是合法的 JSON'), undefined);
    }
  });

  await app.register(cookie, { secret: sessionSecretOf(deps) });
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 8 } });
  await app.register(rateLimit, { global: false });

  registerAuthHooks(app, deps);

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  });

  app.addHook('preSerialization', async (_req, _reply, payload) => isoDeep(payload));

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const problem = toProblem(err, req);
    if (problem.status >= 500) req.log.error({ err, url: req.url }, 'request failed');
    reply.code(problem.status).type(PROBLEM_TYPE).send(problem);
  });

  await registerAuthRoutes(app, deps);

  await app.register(async (scope) => {
    scope.addHook('preHandler', requireRole('reader'));
    await registerReader(scope, deps);
  });

  await app.register(async (scope) => {
    scope.addHook('preHandler', requireRole('admin'));
    for (const reg of [registerBooks, registerV3, registerChapters, registerTasks, registerRuns, registerInbox, registerInstructions, registerGenres, registerHarness, registerAccounts, registerRouting, registerSchedule, registerReaders, registerSettings, registerImport]) {
      await reg(scope, deps);
    }
  });

  const webRoot = deps.config.webDistDir;
  const hasWeb = existsSync(path.join(webRoot, 'index.html'));
  if (hasWeb) await app.register(fastifyStatic, { root: path.resolve(webRoot), wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    if (!req.url.startsWith('/api/') && hasWeb && (req.method === 'GET' || req.method === 'HEAD')) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).type(PROBLEM_TYPE).send({ type: 'about:blank', title: '接口不存在', status: 404, code: 'not_found' } satisfies ApiProblem);
  });

  app.addHook('onClose', async () => closeAllSse());
  return app;
}
