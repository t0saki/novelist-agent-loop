/** /api/admin/instructions/*（契约见 @novelist/shared ROUTES）。Owner: lane G。 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { InstructionFileEntry, InstructionPreviewV3, Ok, RepoFile, RoleId } from '@novelist/shared';
import { ROLE_IDS, V3_LENGTHS, zInstructionPreviewV3, zInstructionScope, zPutRepoFile } from '@novelist/shared';
import type { V3Length } from '@novelist/shared';
import { and, ne, sql } from 'drizzle-orm';
import type { AppDeps } from '../../../app.js';
import { bookFiles, ensureGitRepo, gitBlobSha, NothingToCommitError, openRepo, P, pathOwner, TRAILER } from '../../../book/index.js';
import { books } from '../../../db/schema.js';
import { BUILTIN_INSTRUCTIONS_DIR } from '../../../instructions/index.js';
import { previewInstructionsV3 } from '../../../services/instructions-preview.js';
import { V3_AGENTS_SOFT_LIMIT, renderAgentsMdV3 } from '../../../instructions/v3.js';
import { genreExists, listGenres, loadGenre } from '../../../genres/index.js';
import { loadSystemSettings } from '../../../orchestrator/routing.js';
import { saveRepoFile } from '../../../services/repo-files.js';
import { audit, bookBySlug, bookDir, parseBody, requireRel } from '../../helpers.js';
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
 * 书库本身不动。v2 书不检查。全局 / 题材层的保存见 assertV3StackSizes。
 */
async function assertV3AgentsSize(deps: AppDeps, bookRoot: string, rel: string, content: string): Promise<void> {
  const cfg = await bookFiles(openRepo(bookRoot)).config().then((c) => c.config).catch(() => null);
  if (cfg?.flow !== 'v3') return;
  const genre = await loadGenre(deps.paths, cfg.genre);
  const input = { globalDir: deps.paths.instructionsGlobal, genreDirs: genre.chain.map((g) => ({ id: g.id, dir: g.dir, name: g.pack.name ?? g.id })), bookDir: bookRoot, length: cfg.v3.length };
  const [before, after] = await Promise.all([settle(renderAgentsMdV3(input)), settle(renderAgentsMdV3({ ...input, drafts: { [path.join(bookRoot, rel)]: content } }))]);
  // 渲染错误：只拦这次保存带来的（保存前就渲染不了的，这次保存可能正是在修它）
  if (!after.ok) {
    if (!before.ok) return;
    throw new HttpProblem(400, 'instruction_include', `保存后本书的 AGENTS.md 渲染失败：${after.error.message}`);
  }
  const agents = after.value;
  // 尺寸：只拦“这次保存让它超标、或让已超标的变得更大”的；不变或变小的照收（主人可以一步步缩短）
  if (overLimit(before.ok ? before.value.bytes : null, agents.bytes)) {
    throw new HttpProblem(400, 'instructions_too_large', `保存后本书的 AGENTS.md 有 ${agents.bytes} 字节，超过 ${V3_AGENTS_SOFT_LIMIT} 字节${before.ok ? `（保存前 ${before.value.bytes} 字节）` : ''}`, {
      detail: agents.layers.map((l) => `${l.label}：${l.bytes} 字节`).join('；'),
      errors: agents.layers.map((l) => ({ path: l.id, message: `${l.label}：${l.bytes} 字节` })),
    });
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then((value) => ({ ok: true as const, value }), (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e : new Error(String(e)) }));

/** 保存后超过 16 KB，并且保存前没超、或保存后更大（保存前渲染不了时按“没超”算） */
export function overLimit(beforeBytes: number | null, afterBytes: number): boolean {
  return afterBytes > V3_AGENTS_SOFT_LIMIT && (beforeBytes === null || beforeBytes <= V3_AGENTS_SOFT_LIMIT || afterBytes > beforeBytes);
}

const LENGTH_LABEL: Record<V3Length, string> = { short: '短篇', medium: '中篇', long: '长篇', epic: '超长' };

/**
 * 全局 / 题材层的保存（WP-3，p2-plan §3.3 I）：把草稿当作未保存内容，对受影响的 v3 书逐本渲染根 AGENTS.md，
 * 再对自动开书能选到的题材包按每一档篇幅各渲染一本“新书”（空的书目录）。没有 v3 书在用、自动开书也选不到的题材包不查。
 * 最大的那个超过 16 KB → 400 instructions_too_large（errors 里列各层字节数）；渲染出错 → 400 instruction_include。从不截断。
 */
async function assertV3StackSizes(deps: AppDeps, root: ScopeRoot, rel: string, content: string): Promise<void> {
  if (!/\.md$/i.test(rel)) return;
  const drafts = { [path.join(root.dir, rel)]: content };
  const inScope = (chain: { id: string }[]) => root.kind === 'global' || chain.some((g) => g.id === root.id);
  type Rendered = Awaited<ReturnType<typeof renderAgentsMdV3>>;
  let worst: { label: string; agents: Rendered; before: number | null } | null = null;
  // 每个目标渲染两次（保存前 / 保存后）：只拦这次保存带来的超标或渲染错误，已经超标、已经坏掉的目标不锁死整个全局 / 题材层
  const measure = async (label: string, genreId: string, bookRoot: string, length: V3Length) => {
    const genre = await loadGenre(deps.paths, genreId);
    if (!inScope(genre.chain)) return;
    const input = { globalDir: deps.paths.instructionsGlobal, genreDirs: genre.chain.map((g) => ({ id: g.id, dir: g.dir, name: g.pack.name ?? g.id })), bookDir: bookRoot, length };
    const [before, after] = await Promise.all([settle(renderAgentsMdV3(input)), settle(renderAgentsMdV3({ ...input, drafts }))]);
    if (!after.ok) {
      if (!before.ok) {
        deps.log.warn({ label, err: before.error.message }, 'v3 AGENTS.md already fails to render; save not blocked by it');
        return;
      }
      throw new HttpProblem(400, 'instruction_include', `保存后${label}的 AGENTS.md 渲染失败：${after.error.message}`);
    }
    const agents = after.value;
    const beforeBytes = before.ok ? before.value.bytes : null;
    if (overLimit(beforeBytes, agents.bytes) && (!worst || agents.bytes > worst.agents.bytes)) worst = { label, agents, before: beforeBytes };
  };
  // (1) 在写的 v3 书（没归档的）
  const rows = await deps.db.select({ slug: books.slug, title: books.title }).from(books).where(and(ne(books.status, 'archived'), sql`${books.meta}->'v3' is not null`));
  for (const r of rows) {
    const dir = bookDir(deps, r.slug);
    const cfg = await bookFiles(openRepo(dir)).config().then((c) => c.config).catch(() => null);
    if (cfg?.flow !== 'v3' || !(await genreExists(deps.paths, cfg.genre))) continue;
    await measure(`《${r.title}》`, cfg.genre, dir, cfg.v3.length);
  }
  // (2) 自动开书能选到的题材包：每档篇幅一本空书
  const auto = (await loadSystemSettings(deps.db)).autoStart;
  const packs = (await listGenres(deps.paths)).filter((p) => !p.hidden && (auto.genres ? auto.genres.includes(p.id) : p.auto?.enabled === true) && (auto.genreWeights[p.id] ?? p.auto?.weight ?? 1) > 0);
  if (packs.length) {
    const tmp = path.join(deps.paths.tmp, `v3-agents-${randomUUID()}`);
    await fs.mkdir(tmp, { recursive: true });
    try {
      for (const p of packs) for (const len of V3_LENGTHS) await measure(`题材「${p.name || p.id}」的新书（${LENGTH_LABEL[len]}）`, p.id, tmp, len);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  const w = worst as { label: string; agents: Rendered; before: number | null } | null;
  if (w) {
    throw new HttpProblem(400, 'instructions_too_large', `保存后${w.label}的 AGENTS.md 有 ${w.agents.bytes} 字节，超过 ${V3_AGENTS_SOFT_LIMIT} 字节${w.before !== null ? `（保存前 ${w.before} 字节）` : ''}`, {
      detail: w.agents.layers.map((l) => `${l.label}：${l.bytes} 字节`).join('；'),
      errors: w.agents.layers.map((l) => ({ path: l.id, message: `${l.label}：${l.bytes} 字节` })),
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
        layer: root.kind === 'builtin' && f.path === 'v3/contract.md' ? ('S0' as const) : root.layer,
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
    if (root.kind === 'global' || root.kind === 'genre') await assertV3StackSizes(deps, root, rel, body.content);
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

  /** 根 AGENTS.md 预览（按书，或按题材包 + 篇幅；services/instructions-preview.ts） */
  app.post('/api/admin/instructions/preview', async (req): Promise<InstructionPreviewV3> => previewInstructionsV3(deps, parseBody(zInstructionPreviewV3, req.body)));

}
