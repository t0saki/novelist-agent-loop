/** 指令预览（DESIGN §9.2 指令页）：编译 + 物化 + 生效 gate 清单。Owner: lane C。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { type Capabilities, type GatesFile, type HarnessId, type InstructionPreview, type InstructionPreviewRequest, type RoleId, type TaskKind, TASK_KINDS, zBookConfig, zGatesFile, zInstructionPreviewRequest } from '@novelist/shared';
import { parse as yamlParse } from 'yaml';
import type { DataPaths } from '../config/index.js';
import { type ResolvedGenre, loadGenre } from '../genres/index.js';
import type { RunSpec } from '../harness/types.js';
import { BUILTIN_GATES, resolveEffectiveGates } from '../validators/index.js';
import { compileInstructions } from './compile.js';
import { BUILTIN_INSTRUCTIONS_DIR, resolveStack } from './layers.js';
import { materializeFor } from './materialize/index.js';
import { renderSkills, renderWorkspaceDoc, skillIndex } from './workspace.js';

export interface PreviewDeps {
  paths: DataPaths;
  /** 书 slug → 书根目录（live 树） */
  bookDir(slug: string): Promise<string | null>;
  /** 该 harness 的 probe 结果；省略时用 adapter 的默认能力表（标注为未验证） */
  caps?(harness: HarnessId): Promise<Capabilities | null>;
}

const SCOPED_DRAFT_RE = /^(global|genre:[a-z0-9-]+|book:[a-z0-9-]+):(.+)$/;

/**
 * drafts 的 key 支持：绝对路径；`<scope>:<相对路径>`（global:AGENTS.md、genre:xianxia:roles/writer.md、book:<slug>:instructions/AGENTS.md）；
 * 其余相对路径按书根（无书时按全局目录）解析。
 */
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
      out[path.join(ctx.paths.instructionsGlobal, m[2]!)] = value;
    } else if (m[1]!.startsWith('genre:')) {
      out[path.join(ctx.paths.genres, m[1]!.slice('genre:'.length), m[2]!)] = value;
    } else if (ctx.bookDir && m[1] === `book:${ctx.bookSlug}`) {
      out[path.join(ctx.bookDir, m[2]!)] = value;
    }
  }
  return out;
}

async function readGates(file: string): Promise<GatesFile | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  return text === null ? null : zGatesFile.parse(yamlParse(text));
}

function previewSpec(harness: HarnessId, role: RoleId, taskKind: TaskKind | null, bookSlug: string | null, profileId: string): RunSpec {
  const run = '$RUN';
  return {
    runId: 'preview',
    taskId: 'preview',
    attempt: 1,
    role,
    taskKind: taskKind ?? TASK_KINDS[0],
    harness,
    profileId,
    accountId: null,
    bookSlug,
    runDir: run,
    bookDir: `${run}/book`,
    outDir: `${run}/book/work/preview/attempt-1/out`,
    inDir: `${run}/in`,
    logDir: `${run}/log`,
    workOrderFile: `${run}/in/workorder.md`,
    systemFile: `${run}/in/system.md`,
    receiptSchemaFile: `${run}/in/receipt.schema.json`,
    model: 'preview',
    limits: { wallMs: 0, idleMs: 0, maxTurns: 0 },
    session: { mode: 'fresh', id: 'preview' },
    persistSession: false,
    egress: { allow: [] },
    subagents: false,
    extraArgs: [],
  };
}

async function resolveCaps(harness: HarnessId, deps: PreviewDeps): Promise<Capabilities> {
  const probed = await deps.caps?.(harness);
  if (probed) return probed;
  const { defaultCapabilities } = await import('../harness/index.js');
  return defaultCapabilities(harness, 'preview', 'container');
}

export async function previewInstructions(req: InstructionPreviewRequest, deps: PreviewDeps): Promise<InstructionPreview> {
  const { book: slug, genre: reqGenre, role, harness, profileId, taskKind: rawKind, drafts: rawDrafts } = zInstructionPreviewRequest.parse(req);
  const taskKind = (rawKind ?? null) as TaskKind | null;
  if (taskKind && !(TASK_KINDS as readonly string[]).includes(taskKind)) throw new Error(`未知 taskKind：${taskKind}`);

  const bookDir = slug ? await deps.bookDir(slug) : null;
  if (slug && !bookDir) throw new Error(`书不存在：${slug}`);
  const bookYamlRaw = bookDir ? (await fs.readFile(path.join(bookDir, 'book.yaml'), 'utf8').catch(() => null)) : null;
  const book = bookYamlRaw === null ? null : zBookConfig.parse(yamlParse(bookYamlRaw));
  const genreId = reqGenre ?? book?.genre ?? null;
  const genre: ResolvedGenre | null = genreId ? await loadGenre(deps.paths, genreId) : null;

  const drafts = resolveDraftPaths(rawDrafts, { paths: deps.paths, bookDir, bookSlug: slug });
  const stack = await resolveStack({
    globalDir: deps.paths.instructionsGlobal,
    genreDirs: genre?.chain.map((c) => ({ id: c.id, dir: c.dir })) ?? [],
    bookDir,
    role,
    taskKind,
    ownerNotes: [],
    drafts,
  });
  const compiled = compileInstructions(stack, { nonces: 'placeholder' });

  const contract = await fs.readFile(path.join(BUILTIN_INSTRUCTIONS_DIR, 'contract.md'), 'utf8');
  const skills = bookDir ? await renderSkills({ bookDir, genreDirs: genre?.chain.map((c) => c.dir) ?? [], globalDir: deps.paths.instructionsGlobal }) : [];
  const workspaceDoc = renderWorkspaceDoc({ bookTitle: book?.title ?? '（未选择书）', contract, skills: skillIndex(skills) });

  const caps = await resolveCaps(harness, deps);
  const spec = previewSpec(harness, role, taskKind, slug ?? null, profileId ?? 'preview');
  const mat = await materializeFor(harness, { harness, spec, compiled, caps, personaMode: 'append', home: '$HOME', workspaceDoc });

  const effectiveGates = resolveEffectiveGates({
    builtin: BUILTIN_GATES,
    global: await readGates(path.join(deps.paths.instructionsGlobal, 'gates.yaml')),
    genre: genre?.gates ?? [],
    bookFile: bookDir ? await readGates(path.join(bookDir, 'gates.yaml')) : null,
    bookOverrides: book?.gates.overrides ?? {},
  });

  return {
    systemMd: compiled.systemMd,
    workspaceDoc,
    layers: compiled.layers,
    replaced: stack.replaced ?? [],
    budget: mat.budget,
    effectiveGates,
    materialized: { files: mat.files.map((f) => ({ path: f.path, content: f.content })), argv: mat.argv, env: mat.env },
    lastAuthorBlock: compiled.lastAuthorLayerId,
  };
}
