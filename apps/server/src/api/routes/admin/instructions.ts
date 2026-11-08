/** /api/admin/instructions/*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Capabilities, HarnessId, InstructionFileEntry, InstructionPreview, Ok, RepoFile, RoleId } from '@novelist/shared';
import { ROLE_IDS, zInstructionPreviewRequest, zInstructionScope, zPutRepoFile } from '@novelist/shared';
import { desc, eq } from 'drizzle-orm';
import type { AppDeps } from '../../../app.js';
import { ensureGitRepo, gitBlobSha, NothingToCommitError, openRepo, P, pathOwner, TRAILER } from '../../../book/index.js';
import { capabilities } from '../../../db/schema.js';
import { BUILTIN_INSTRUCTIONS_DIR, previewInstructions } from '../../../instructions/index.js';
import { genreExists } from '../../../genres/index.js';
import { saveRepoFile } from '../../../services/repo-files.js';
import { audit, bookBySlug, bookDir, domain, parseBody, requireRel } from '../../helpers.js';
import { badRequest, conflict, forbidden, notFound } from '../../problem.js';

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
