/** /api/admin/genres*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { GenreSummary, Ok, SystemSettings } from '@novelist/shared';
import { zCreateGenre, zGenreVisibility, zPatchGenreAuto } from '@novelist/shared';
import type { AppDeps } from '../../../app.js';
import { books } from '../../../db/schema.js';
import { InvalidPackError, createGenre, listGenres, patchGenreAuto, setGenreHidden, trashGenre } from '../../../genres/index.js';
import { loadSystemSettings } from '../../../orchestrator/routing.js';
import { audit, domain, parseBody } from '../../helpers.js';
import { HttpProblem, conflict, notFound } from '../../problem.js';

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

async function toSummary(deps: AppDeps, pack: Awaited<ReturnType<typeof listGenres>>[number], bookCount: number, settingsIn?: SystemSettings): Promise<GenreSummary> {
  const auto = (settingsIn ?? (await loadSystemSettings(deps.db))).autoStart;
  // 旧设置里的覆盖（优先于 pack.yaml；界面只能清除，不再写新的）
  const override = { listed: auto.genres ? auto.genres.includes(pack.id) : null, weight: auto.genreWeights[pack.id] ?? null };
  return { id: pack.id, name: pack.name, description: pack.description, extends: pack.extends, builtin: pack.builtin, hidden: pack.hidden, books: bookCount, auto: pack.auto ? { enabled: pack.auto.enabled, weight: pack.auto.weight, keywords: pack.auto.keywords.length, lengthHint: pack.auto.length_hint, keywordList: pack.auto.keywords, adultOnly: pack.auto.adult_only, minChapters: pack.auto.min_chapters } : null, override, files: await filesOf(path.join(deps.paths.genres, pack.id)) };
}

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/admin/genres', async (): Promise<GenreSummary[]> => {
    const counts = await deps.db.select({ genre: books.genre, n: count() }).from(books).groupBy(books.genre);
    const countOf = new Map(counts.map((c) => [c.genre, Number(c.n)]));
    const settings = await loadSystemSettings(deps.db);
    return Promise.all((await listGenres(deps.paths)).map((p) => toSummary(deps, p, countOf.get(p.id) ?? 0, settings)));
  });

  app.post('/api/admin/genres', async (req, reply) => {
    const body = parseBody(zCreateGenre, req.body);
    const pack = await domain(() => createGenre(deps.paths, { id: body.id, name: body.name, extends: body.extends, ...(body.copyFrom ? { copyFrom: body.copyFrom } : {}) }));
    await audit(deps, req, 'genre.create', pack.id);
    return reply.code(201).send(await toSummary(deps, pack, 0));
  });

  /** 删除（C9）：没有书在用、没有包继承的包都能删，内置包也可以（记墓碑，不再自动拷回）。目录移进回收站，不做不可恢复的删除 */
  app.delete<{ Params: { id: string } }>('/api/admin/genres/:id', async (req): Promise<Ok> => {
    // 只认题材包列表里的规范 id（"./xianxia"、"x/"、"../trash/…" 这类写法会绕过下面的在用检查）
    const packs = await listGenres(deps.paths);
    const pack = packs.find((p) => p.id === req.params.id);
    if (!pack) throw notFound(`题材包 ${req.params.id} `);
    const id = pack.id;
    const refs = await deps.db.select({ n: count() }).from(books).where(eq(books.genre, id));
    const n = Number(refs[0]?.n ?? 0);
    if (n > 0) throw conflict(`还有 ${n} 本书使用这个题材包，可以停用`, 'genre_in_use');
    const children = packs.filter((p) => p.extends.includes(id));
    if (children.length) throw conflict(`被题材包 ${children.map((c) => c.id).join('、')} 继承，可以停用`, 'genre_extended');
    const trashed = await trashGenre(deps.paths, id, { builtin: pack.builtin === true });
    await audit(deps, req, 'genre.delete', id, { builtin: pack.builtin === true, trash: path.relative(deps.paths.root, trashed) });
    return { ok: true };
  });

  /** 停用 / 恢复（C9）：不再出现在开书页和自动开书里；已有的书照常使用，文件保留。所有包都可以 */
  app.post<{ Params: { id: string } }>('/api/admin/genres/:id/visibility', async (req): Promise<GenreSummary> => {
    const body = parseBody(zGenreVisibility, req.body);
    const found = (await listGenres(deps.paths)).find((p) => p.id === req.params.id);
    if (!found) throw notFound(`题材包 ${req.params.id} `);
    const id = found.id;
    const pack = await domain(() => setGenreHidden(deps.paths, id, body.hidden));
    await audit(deps, req, body.hidden ? 'genre.hide' : 'genre.unhide', id);
    const refs = await deps.db.select({ n: count() }).from(books).where(eq(books.genre, id));
    return toSummary(deps, pack, Number(refs[0]?.n ?? 0));
  });

  /** 自动开书配置（参与、权重、关键词、篇幅倾向）：写回 pack.yaml（保留注释），整份校验不过 → 400 invalid_pack，文件不动 */
  app.patch<{ Params: { id: string } }>('/api/admin/genres/:id/auto', async (req): Promise<GenreSummary> => {
    const body = zPatchGenreAuto.safeParse(req.body ?? {});
    if (!body.success) throw new HttpProblem(400, 'invalid_pack', '自动开书配置不合格式', { errors: body.error.issues.map((i) => ({ path: `auto.${i.path.join('.')}`, message: i.message })) });
    const found = (await listGenres(deps.paths)).find((p) => p.id === req.params.id);
    if (!found) throw notFound(`题材包 ${req.params.id} `);
    const id = found.id;
    let pack: Awaited<ReturnType<typeof patchGenreAuto>>;
    try {
      pack = await patchGenreAuto(deps.paths, id, body.data);
    } catch (e) {
      if (e instanceof InvalidPackError) throw new HttpProblem(400, 'invalid_pack', e.message, { errors: e.issues });
      throw e;
    }
    await audit(deps, req, 'genre.auto', id, body.data);
    const refs = await deps.db.select({ n: count() }).from(books).where(eq(books.genre, id));
    return toSummary(deps, pack, Number(refs[0]?.n ?? 0));
  });
}
