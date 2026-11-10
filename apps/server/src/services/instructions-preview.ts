/**
 * 指令页的预览（P3 WP-3，D18）：渲染一份和运行时完全一样的根 AGENTS.md（instructions/v3.ts），带各层字节数。
 * 给了书：用这本书的题材链、篇幅和书目录（旧书 409 legacy_book）；否则用题材包 + 篇幅（缺省中篇）和一个空的临时书目录。
 * drafts 是编辑器里还没保存的内容：绝对路径，或 `global:<rel>` / `genre:<id>:<rel>` / `book:<slug>:<rel>`；其余相对路径按书目录（没有书时按全局目录）解析。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { InstructionPreviewV3, V3Length } from '@novelist/shared';
import type { z } from 'zod';
import type { zInstructionPreviewV3 } from '@novelist/shared';
import type { AppDeps } from '../app.js';
import { bookBySlug, bookDir } from '../api/helpers.js';
import { HttpProblem, badRequest } from '../api/problem.js';
import { bookFiles, isV3Meta, openRepo } from '../book/index.js';
import type { DataPaths } from '../config/index.js';
import { genreExists, loadGenre } from '../genres/index.js';
import { V3_AGENTS_SOFT_LIMIT, renderAgentsMdV3 } from '../instructions/v3.js';

const SCOPED_DRAFT_RE = /^(global|genre:[a-z0-9-]+|book:[a-z0-9-]+):(.+)$/;

function resolveDraftPaths(drafts: Record<string, string>, ctx: { paths: DataPaths; bookDir: string | null; bookSlug: string | undefined }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(drafts)) {
    if (path.isAbsolute(key)) {
      out[key] = value;
      continue;
    }
    const m = SCOPED_DRAFT_RE.exec(key);
    if (!m) {
      out[path.join(ctx.bookDir ?? ctx.paths.instructionsGlobal, key)] = value;
    } else if (m[1] === 'global') {
      out[path.join(ctx.paths.instructionsGlobal, m[2] as string)] = value;
    } else if ((m[1] as string).startsWith('genre:')) {
      out[path.join(ctx.paths.genres, (m[1] as string).slice('genre:'.length), m[2] as string)] = value;
    } else if (ctx.bookDir && m[1] === `book:${ctx.bookSlug}`) {
      out[path.join(ctx.bookDir, m[2] as string)] = value;
    }
  }
  return out;
}

export async function previewInstructionsV3(deps: AppDeps, req: z.output<typeof zInstructionPreviewV3>): Promise<InstructionPreviewV3> {
  let genreId: string;
  let length: V3Length;
  let dir: string | null = null;
  if (req.book) {
    const row = await bookBySlug(deps, req.book);
    if (!isV3Meta(row.meta)) throw new HttpProblem(409, 'legacy_book', '旧书没有新流程的指令；接手之后才能预览');
    dir = bookDir(deps, row.slug);
    const cfg = (await bookFiles(openRepo(dir)).config()).config;
    genreId = cfg.genre;
    length = req.length ?? cfg.v3.length;
  } else {
    if (!req.genre) throw badRequest('预览需要 book，或者 genre（加可选的 length）');
    genreId = req.genre;
    length = req.length ?? 'medium';
  }
  if (!(await genreExists(deps.paths, genreId))) throw new HttpProblem(404, 'not_found', `题材包 ${genreId} 不存在`);
  const genre = await loadGenre(deps.paths, genreId);
  const tmp = dir ? null : path.join(deps.paths.tmp, `preview-${randomUUID()}`);
  if (tmp) await fs.mkdir(tmp, { recursive: true });
  try {
    const bookRoot = dir ?? (tmp as string);
    const drafts = resolveDraftPaths(req.drafts, { paths: deps.paths, bookDir: dir, bookSlug: req.book });
    let agents: Awaited<ReturnType<typeof renderAgentsMdV3>>;
    try {
      agents = await renderAgentsMdV3({
        globalDir: deps.paths.instructionsGlobal,
        genreDirs: genre.chain.map((g) => ({ id: g.id, dir: g.dir, name: g.pack.name ?? g.id })),
        bookDir: bookRoot,
        length,
        ...(Object.keys(drafts).length ? { drafts } : {}),
      });
    } catch (e) {
      throw new HttpProblem(400, 'instruction_include', `AGENTS.md 渲染失败：${(e as Error).message}`);
    }
    return { text: agents.text, bytes: agents.bytes, limit: V3_AGENTS_SOFT_LIMIT, over: agents.bytes > V3_AGENTS_SOFT_LIMIT, layers: agents.layers };
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
