/** /api/admin/instructions/*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Capabilities, HarnessId, InstructionFileEntry, InstructionPreview, Ok, RepoFile, RoleId } from '@novelist/shared';
import { ROLE_IDS, zInstructionPreviewRequest, zInstructionScope, zPutRepoFile } from '@novelist/shared';
import { desc, eq } from 'drizzle-orm';
import type { AppDeps } from '../../../app.js';
import { bookFiles, ensureGitRepo, gitBlobSha, NothingToCommitError, openRepo, P, pathOwner, TRAILER } from '../../../book/index.js';
import { capabilities } from '../../../db/schema.js';
import { BUILTIN_INSTRUCTIONS_DIR, previewInstructions } from '../../../instructions/index.js';
import { V3_AGENTS_SOFT_LIMIT, renderAgentsMdV3 } from '../../../instructions/v3.js';
import { genreExists, loadGenre } from '../../../genres/index.js';
import { saveRepoFile } from '../../../services/repo-files.js';
import { audit, bookBySlug, bookDir, domain, parseBody, requireRel } from '../../helpers.js';
import { HttpProblem, badRequest, conflict, forbidden, notFound } from '../../problem.js';

type ScopeQuery = { Querystring: { scope?: string; path?: string } };

interface ScopeRoot {
  kind: 'global' | 'builtin' | 'genre' | 'book';
  /** 文件根目录 */
  dir: string;
  /** git 仓库根（builtin 无） */
  repoRoot: string | null;
  /** rel → 仓库内路径（genre 需要加 <id>/ 前缀） */
  repoPath(rel: string): string;
  layer: InstructionFileEntry['layer'];
  /** 只列这些子目录下的文件（book scope 只显示指令相关） */
  include?: RegExp;
  id: string;
}

async function scopeRoot(deps: AppDeps, raw: string | undefined): Promise<ScopeRoot> {
  const scope = zInstructionScope.parse(raw ?? 'global');
  if (scope === 'global') return { kind: 'global', dir: deps.paths.instructionsGlobal, repoRoot: deps.paths.instructionsGlobal, repoPath: (r) => r, layer: 'L1', id: '' };
  if (scope === 'builtin') return { kind: 'builtin', dir: BUILTIN_INSTRUCTIONS_DIR, repoRoot: null, repoPath: (r) => r, layer: 'S1', id: '' };
  if (scope.startsWith('genre:')) {
    const id = scope.slice('genre:'.length);
    if (!(await genreExists(deps.paths, id))) throw notFound(`题材包 ${id} `);
    return { kind: 'genre', dir: path.join(deps.paths.genres, id), repoRoot: deps.paths.genres, repoPath: (r) => `${id}/${r}`, layer: 'L2', id };
  }
  const slug = scope.slice('book:'.length);
  await bookBySlug(deps, slug);
  return { kind: 'book', dir: bookDir(deps, slug), repoRoot: bookDir(deps, slug), repoPath: (r) => r, layer: 'L3', include: /^(instructions\/|style\/|gates\.yaml$)/, id: slug };
}

async function walk(root: string, prefix: string, out: { path: string; size: number }[], skipHidden: boolean): Promise<void> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name === '.git' || (skipHidden && e.name.startsWith('.'))) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, rel, out, skipHidden);
    else if (e.isFile()) out.push({ path: rel, size: (await fs.stat(path.join(root, rel))).size });
  }
}

const roleOf = (rel: string): RoleId | null => {
  const name = /(?:^|\/)roles\/([^/]+)\.md$/.exec(rel)?.[1];
  return name && (ROLE_IDS as readonly string[]).includes(name) ? (name as RoleId) : null;
};

const zPutInstruction = zPutRepoFile.extend({ scope: zInstructionScope });

async function commitTo(root: ScopeRoot, rel: string, content: string | null, message: string, baseSha: string | null): Promise<{ commit: string }> {
  const repoRoot = root.repoRoot as string;
  await ensureGitRepo(repoRoot);
  const repo = openRepo(repoRoot);
  const repoRel = root.repoPath(rel);
  if (baseSha && baseSha !== (await repo.blobShas([repoRel]))[repoRel]) throw conflict('文件已被修改，请刷新后重试', 'stale_base');
  await repo.writeFiles([{ path: repoRel, content }]);
  const head = await repo.head();
  try {
    return { commit: await repo.commit({ message, trailers: { [TRAILER.owner]: 'true' }, paths: [repoRel] }) };
  } catch (e) {
    if (e instanceof NothingToCommitError) return { commit: head };
    throw e;
  }
}

/**
 * v3 书（flow: v3）：把草稿当作未保存内容、对整本书目录渲染一次根 AGENTS.md（和运行时一样，nv:include 可以引到书里别处的文件，例如 ../style/voice.md），
 * 超过 16 KB 拒收（400 instructions_too_large，errors 里列各层字节数）；include 找不到、越界之类的渲染错误是 400 instruction_include。
 * 书库本身不动。v2 书不检查。全局 / 题材层的保存检查留到第二阶段。
 */
async function assertV3AgentsSize(deps: AppDeps, bookRoot: string, rel: string, content: string): Promise<void> {
  const cfg = await bookFiles(openRepo(bookRoot)).config().then((c) => c.config).catch(() => null);
  if (cfg?.flow !== 'v3') return;
  const genre = await loadGenre(deps.paths, cfg.genre);
  let agents: Awaited<ReturnType<typeof renderAgentsMdV3>>;
  try {
    agents = await renderAgentsMdV3({
      globalDir: deps.paths.instructionsGlobal,
      genreDirs: genre.chain.map((g) => ({ id: g.id, dir: g.dir, name: g.pack.name ?? g.id })),
      bookDir: bookRoot,
      length: cfg.v3.length,
      drafts: { [path.join(bookRoot, rel)]: content },
    });
  } catch (e) {
    throw new HttpProblem(400, 'instruction_include', `保存后本书的 AGENTS.md 渲染失败：${(e as Error).message}`);
  }
  if (agents.bytes > V3_AGENTS_SOFT_LIMIT) {
    throw new HttpProblem(400, 'instructions_too_large', `保存后本书的 AGENTS.md 有 ${agents.bytes} 字节，超过 ${V3_AGENTS_SOFT_LIMIT} 字节`, {
      detail: agents.layers.map((l) => `${l.label}：${l.bytes} 字节`).join('；'),
      errors: agents.layers.map((l) => ({ path: l.id, message: `${l.label}：${l.bytes} 字节` })),
    });
  }
}

export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<ScopeQuery>('/api/admin/instructions/files', async (req): Promise<InstructionFileEntry[]> => {
    const root = await scopeRoot(deps, req.query.scope);
    const files: { path: string; size: number }[] = [];
    await walk(root.dir, '', files, root.kind !== 'book');
    return files
      .filter((f) => !root.include || root.include.test(f.path))
      .map((f) => ({
        scope: req.query.scope ?? 'global',
        path: f.path,
        size: f.size,
        layer: root.kind === 'builtin' && f.path === 'contract.md' ? ('S0' as const) : root.layer,
        role: roleOf(f.path),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });

  app.get<ScopeQuery>('/api/admin/instructions/file', async (req): Promise<RepoFile> => {
    const root = await scopeRoot(deps, req.query.scope);
    const rel = requireRel(req.query.path);
    const content = await fs.readFile(path.join(root.dir, rel), 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') throw notFound(`文件 ${rel} `);
      throw e;
    });
    const commit = root.repoRoot ? await openRepo(root.repoRoot).head() : '';
    return { path: rel, content, sha: gitBlobSha(content), commit };
  });

  app.put('/api/admin/instructions/file', async (req, reply) => {
    const body = parseBody(zPutInstruction, req.body);
    const root = await scopeRoot(deps, body.scope);
    if (root.kind === 'builtin') throw forbidden('内置指令只读；请在全局层覆盖', 'builtin_readonly');
    const rel = requireRel(body.path);
    if (root.kind === 'book') {
      const book = await bookBySlug(deps, root.id);
      if (!root.include?.test(rel) || pathOwner(rel) !== 'user') throw badRequest('书层指令只能写 instructions/、style/ 和 gates.yaml');
      // style/ 也可能被 nv:include 引进 AGENTS.md，一并量一下
      if (rel.startsWith('instructions/') || rel.startsWith('style/')) await assertV3AgentsSize(deps, root.dir, rel, body.content);
      const r = await saveRepoFile(deps, book, { path: rel, content: body.content, baseSha: body.baseSha, message: body.message, confirm: body.confirm });
      if (r.kind === 'needs_confirm') return reply.code(409).send(r.impact);
      await audit(deps, req, 'instruction.write', `book:${book.slug}`, { path: rel });
      return r.file;
    }
    const { commit } = await commitTo(root, rel, body.content, body.message ?? `owner: edit ${root.kind} ${rel}`, body.baseSha);
    await audit(deps, req, 'instruction.write', body.scope, { path: rel });
    return { path: rel, content: body.content, sha: gitBlobSha(body.content), commit } satisfies RepoFile;
  });

  app.delete<ScopeQuery>('/api/admin/instructions/file', async (req): Promise<Ok> => {
    const root = await scopeRoot(deps, req.query.scope);
    if (root.kind === 'builtin') throw forbidden('内置指令只读', 'builtin_readonly');
    const rel = requireRel(req.query.path);
    if (root.kind === 'book') {
      const book = await bookBySlug(deps, root.id);
      if (!root.include?.test(rel) || rel === P.instructionsAgents) throw badRequest('这个文件不能删除');
      const { commitOwnerEdit } = await import('../../../orchestrator/index.js');
      await commitOwnerEdit(deps.db, openRepo(root.dir), book.id, { files: [{ path: rel, content: null }], message: `owner: delete ${rel}`, baseSha: null });
    } else {
      await commitTo(root, rel, null, `owner: delete ${root.kind} ${rel}`, null);
    }
    await audit(deps, req, 'instruction.delete', req.query.scope ?? 'global', { path: rel });
    return { ok: true };
  });

  app.post('/api/admin/instructions/preview', async (req): Promise<InstructionPreview> => {
    const body = parseBody(zInstructionPreviewRequest, req.body);
    return domain(() =>
      previewInstructions(body, {
        paths: deps.paths,
        bookDir: async (slug) => ((await bookBySlug(deps, slug).catch(() => null)) ? bookDir(deps, slug) : null),
        caps: async (harness: HarnessId) => {
          const rows = await deps.db.select().from(capabilities).where(eq(capabilities.harness, harness)).orderBy(desc(capabilities.verifiedAt)).limit(1);
          return (rows[0]?.body as Capabilities | undefined) ?? null;
        },
      }),
    );
  });

}
