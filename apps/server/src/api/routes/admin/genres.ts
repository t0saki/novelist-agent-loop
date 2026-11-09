/** /api/admin/genres*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { GenreSummary, Ok } from '@novelist/shared';
import { zCreateGenre } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { NothingToCommitError, openRepo, TRAILER } from '../../../book/index.js';
import { books } from '../../../db/schema.js';
import { createGenre, genreExists, listGenres } from '../../../genres/index.js';
import { audit, domain, parseBody } from '../../helpers.js';
import { conflict, forbidden, notFound } from '../../problem.js';

async function filesOf(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await filesOf(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

async function toSummary(deps: AppDeps, pack: Awaited<ReturnType<typeof listGenres>>[number], bookCount: number): Promise<GenreSummary> {
  return { id: pack.id, name: pack.name, description: pack.description, extends: pack.extends, builtin: pack.builtin, books: bookCount, auto: pack.auto ? { enabled: pack.auto.enabled, weight: pack.auto.weight, keywords: pack.auto.keywords.length, lengthHint: pack.auto.length_hint } : null, files: await filesOf(path.join(deps.paths.genres, pack.id)) };
}

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/admin/genres', async (): Promise<GenreSummary[]> => {
    const counts = await deps.db.select({ genre: books.genre, n: count() }).from(books).groupBy(books.genre);
    const countOf = new Map(counts.map((c) => [c.genre, Number(c.n)]));
    return Promise.all((await listGenres(deps.paths)).map((p) => toSummary(deps, p, countOf.get(p.id) ?? 0)));
  });

  app.post('/api/admin/genres', async (req, reply) => {
    const body = parseBody(zCreateGenre, req.body);
    const pack = await domain(() => createGenre(deps.paths, { id: body.id, name: body.name, extends: body.extends, ...(body.copyFrom ? { copyFrom: body.copyFrom } : {}) }));
    await audit(deps, req, 'genre.create', pack.id);
    return reply.code(201).send(await toSummary(deps, pack, 0));
  });

  app.delete<{ Params: { id: string } }>('/api/admin/genres/:id', async (req): Promise<Ok> => {
    const id = req.params.id;
    if (!(await genreExists(deps.paths, id))) throw notFound(`题材包 ${id} `);
    const pack = (await listGenres(deps.paths)).find((p) => p.id === id);
    if (pack?.builtin) throw forbidden('内置题材包不能删除', 'builtin_readonly');
    const refs = await deps.db.select({ n: count() }).from(books).where(eq(books.genre, id));
    if (Number(refs[0]?.n ?? 0) > 0) throw conflict(`还有 ${refs[0]?.n} 本书使用这个题材包`, 'genre_in_use');
    const children = (await listGenres(deps.paths)).filter((p) => p.extends.includes(id));
    if (children.length) throw conflict(`被题材包 ${children.map((c) => c.id).join('、')} 继承`, 'genre_in_use');
    await fs.rm(path.join(deps.paths.genres, id), { recursive: true, force: true });
    await openRepo(deps.paths.genres)
      .commit({ message: `genres: delete ${id}`, trailers: { [TRAILER.owner]: 'true' } })
      .catch((e: unknown) => {
        if (!(e instanceof NothingToCommitError)) throw e;
      });
    await audit(deps, req, 'genre.delete', id);
    return { ok: true };
  });
}
