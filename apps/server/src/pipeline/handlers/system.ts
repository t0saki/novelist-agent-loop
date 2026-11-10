/**
 * 其余任务（附录 B 尾部 + 系统任务）。Owner: lane E。
 * - ctx.build：确定性；通常在 chapter.write.prepare 内联执行，也可单独入队（UI “预览 context pack”）。
 * - publish：确定性；publisher（lane F）按 cadence 入队；打 tag pub/NNNNN、更新 chapters.published_at、books.published_through。
 * - import.bootstrap：v1 导入后的批量抽取（无 shell 的 profile；每批 5 章内联）。
 * - routing.feasibility、harness.canary：无书系统任务。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { ArtifactDecl, Delta } from '@novelist/shared';
import { chapterId, chapterNo, tags as gitTags, zDelta } from '@novelist/shared';
import { P } from '../../book/index.js';
import { buildContextPack, rebuildIndex } from '../../context/index.js';
import { books, chapters, publishSchedule } from '../../db/schema.js';
import { buildViews, loadBookState } from '../../state/index.js';
import { deltaCheck } from '../../validators/index.js';
import { buildAliasIndex } from '../../context/index.js';
import { aliasEntities } from '../../state/index.js';
import { buildManifest, contractCheck, contractFailure, effectiveLexicon, frontmatterFor, lengthFor, loadRunState, outputBlock, questionsInbox, requireBook, retryHint } from '../common.js';
import type { BookHandle, PipelineContext, TaskHandler, TaskResult, TaskRow, TaskSpec } from '../types.js';
import { requestHoldCap } from '../../flow/publish.js';
import { readV3Meta } from '../../flow/state.js';
import { renderTemplate } from '../workorder.js';
import { OP_REFERENCE } from './shared.js';

const emptyManifest = (ctx: PipelineContext, spec: TaskSpec) => buildManifest(ctx, spec, {});

export const ctxBuild: TaskHandler = {
  kind: 'ctx.build',
  role: null,
  lane: 'write',
  maxAttempts: 2,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.card(chapterNo(spec.target))] }),
  async execute(ctx, task) {
    const book = requireBook(ctx);
    const no = chapterNo(task.target);
    const state = await loadBookState(book.dir);
    const card = await book.files.card(no);
    if (!card) return { status: 'failed', errorClass: 'config', message: `缺少卡片 ${task.target}` };
    await buildViews(book.dir);
    const pack = await buildContextPack({ bookDir: book.dir, card, snapshot: state.snapshot, state, lexicon: await effectiveLexicon(ctx, book), sampleSeed: task.target });
    return { status: 'done', summary: { hash: pack.hash, cjk: pack.cjk, sections: pack.sections } };
  },
};

export const indexRebuild: TaskHandler = {
  kind: 'index.rebuild',
  role: null,
  lane: 'side',
  maxAttempts: 2,
  manifest: emptyManifest,
  async execute(ctx) {
    const book = requireBook(ctx);
    const r = await rebuildIndex(book.dir);
    return { status: 'done', summary: r };
  },
};

export const slopFingerprint: TaskHandler = {
  kind: 'slop.fingerprint',
  role: null,
  lane: 'side',
  maxAttempts: 2,
  manifest: emptyManifest,
  // 模型指纹提议默认不自动批准（§6.8）。P3 占位：这里只统计，不改任何文件。
  async execute() {
    return { status: 'done', summary: { proposals: 0, note: '模型指纹统计（P3+）' } };
  },
};

export const mediaCover: TaskHandler = {
  kind: 'media.cover',
  role: null,
  lane: 'side',
  maxAttempts: 2,
  manifest: emptyManifest,
  // 封面生成是插件能力（§9.2），未配置时直接跳过，不阻塞流水线。
  async execute() {
    return { status: 'done', summary: { skipped: true, reason: '未配置封面插件' } };
  },
};

/** publish 任务的 target：`through-N`（发布到第 N 章，publisher / publishNow）或 cNNNNN（单章） */
function publishThrough(target: string): number {
  const m = /^through-(\d+)$/.exec(target);
  return m ? Number(m[1]) : chapterNo(target);
}

/**
 * v3 书的发布（p2-plan §3.2）：在事务里锁住书行再算上限，和采用草稿、改写请求、回退的检查用同一把锁；
 * 回退进行中（meta.v3.rewinding）最多发布到回退目标。git 的 published/N 标签在事务提交之后打（-f 幂等）。
 */
async function publishV3(ctx: PipelineContext, book: BookHandle, through: number, nowIso: string, manual: boolean): Promise<TaskResult> {
  const r = await ctx.deps.db.transaction(async (tx) => {
    const row = (await tx.select({ published: books.publishedThrough, accepted: books.acceptedThrough, status: books.status, meta: books.meta }).from(books).where(eq(books.id, book.id)).limit(1).for('update'))[0];
    const from = (row?.published ?? 0) + 1;
    const meta = readV3Meta(row?.meta);
    const rewinding = meta.rewinding;
    // 入队之后主人才提的改写请求：锁内复查（手动发布越过请求，之后由 dropPublishedRequests 作废）
    const hold = manual ? Number.MAX_SAFE_INTEGER : Math.min(Number.MAX_SAFE_INTEGER, requestHoldCap(meta, row?.status, row?.status === 'completed'));
    const to = Math.min(through, row?.accepted ?? through, rewinding ? rewinding.to : Number.MAX_SAFE_INTEGER, hold);
    if (to < from) return { from, to };
    await tx.update(chapters).set({ publishedAt: sql`COALESCE(${chapters.publishedAt}, ${nowIso})` }).where(and(eq(chapters.bookId, book.id), gte(chapters.no, from), lte(chapters.no, to)));
    await tx.update(publishSchedule).set({ state: 'published', publishedAt: nowIso }).where(and(eq(publishSchedule.bookId, book.id), gte(publishSchedule.no, from), lte(publishSchedule.no, to)));
    await tx.update(books).set({ publishedThrough: sql`GREATEST(${books.publishedThrough}, ${to})`, updatedAt: nowIso }).where(eq(books.id, book.id));
    return { from, to };
  });
  if (r.to < r.from) return { status: 'done', summary: { published: 0, through } };
  for (let no = r.from; no <= r.to; no++) await book.repo.tag(gitTags.published(no));
  return { status: 'done', summary: { published: r.to - r.from + 1, through: r.to } };
}

export const publish: TaskHandler = {
  kind: 'publish',
  role: null,
  lane: 'system',
  maxAttempts: 3,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.manuscript(publishThrough(spec.target))] }),
  async execute(ctx, task): Promise<TaskResult> {
    const book = requireBook(ctx);
    const through = publishThrough(task.target);
    const nowIso = ctx.deps.now().toISOString();
    if (book.config.flow === 'v3') return publishV3(ctx, book, through, nowIso, (task.params as { manual?: boolean } | null)?.manual === true);
    const rows = await ctx.deps.db.select({ published: books.publishedThrough, accepted: books.acceptedThrough, audited: books.auditedThrough }).from(books).where(eq(books.id, book.id)).limit(1);
    const from = (rows[0]?.published ?? 0) + 1;
    const params = task.params as { manual?: boolean; ignoreAudit?: boolean };
    // 手动发布默认也服从 require_audited，只有显式 ignoreAudit 才越过审计
    // v3 书走 publishV3（不看审计前沿，发布规则见 flow/publish.ts）
    const auditCap = params.manual && params.ignoreAudit !== true && book.config.publish.require_audited ? (rows[0]?.audited ?? 0) : Number.MAX_SAFE_INTEGER;
    const to = Math.min(through, rows[0]?.accepted ?? through, auditCap);
    if (to < from) return { status: 'done', summary: { published: 0, through } };
    // tag 幂等（-f）；DB 更新重放也幂等（COALESCE / GREATEST）
    for (let no = from; no <= to; no++) await book.repo.tag(gitTags.published(no));
    await ctx.deps.db.transaction(async (tx) => {
      await tx.update(chapters).set({ publishedAt: sql`COALESCE(${chapters.publishedAt}, ${nowIso})` }).where(and(eq(chapters.bookId, book.id), gte(chapters.no, from), lte(chapters.no, to)));
      await tx.update(publishSchedule).set({ state: 'published', publishedAt: nowIso }).where(and(eq(publishSchedule.bookId, book.id), gte(publishSchedule.no, from), lte(publishSchedule.no, to)));
      await tx.update(books).set({ publishedThrough: sql`GREATEST(${books.publishedThrough}, ${to})`, updatedAt: nowIso }).where(eq(books.id, book.id));
    });
    return { status: 'done', summary: { published: to - from + 1, through: to } };
  },
};

export const routingFeasibility: TaskHandler = {
  kind: 'routing.feasibility',
  role: null,
  lane: 'system',
  maxAttempts: 1,
  manifest: emptyManifest,
  async execute(ctx, task): Promise<TaskResult> {
    // F 实现后才可用；不可用时不阻塞开书（只作展示）
    try {
      const { checkFeasibility } = await import('../../orchestrator/index.js');
      const report = await checkFeasibility(ctx.deps.db, ctx.book, { allowFakeHarness: ctx.deps.config.allowFakeHarness });
      return { status: 'done', summary: report as unknown as Record<string, unknown> };
    } catch (err) {
      return { status: 'done', summary: { ok: false, error: (err as Error).message, target: task.target } };
    }
  },
};

export const harnessCanary: TaskHandler = {
  kind: 'harness.canary',
  role: 'canary',
  lane: 'system',
  maxAttempts: 1,
  manifest: emptyManifest,
  async prepare(_ctx, task, run) {
    const token = (task.params as { token?: string }).token ?? `NOVELIST-CANARY-${task.id.slice(0, 12).toUpperCase()}`;
    const art: ArtifactDecl = { path: 'canary.md', kind: 'markdown', required: true };
    const body = await renderTemplate('harness.canary', { token, output: outputBlock([art], run.outDir) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(null, task, run, [art]), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(_ctx, task, h) {
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, 1);
    const token = (task.params as { token?: string }).token ?? `NOVELIST-CANARY-${task.id.slice(0, 12).toUpperCase()}`;
    const text = c.report.files['canary.md']?.text ?? '';
    if (!text.includes(token)) return { status: 'failed', errorClass: 'output_contract', message: '校验码缺失' };
    return { status: 'done', summary: { ok: true, nonce: h.nonce.ok } };
  },
};

// ───────── import.bootstrap ─────────

export const importBootstrap: TaskHandler = {
  kind: 'import.bootstrap',
  role: 'extractor',
  lane: 'side',
  maxAttempts: 4,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: spec.params?.chapters ? (spec.params.chapters as number[]).map((n) => P.manuscript(n)) : [] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const params = task.params as { from?: number; to?: number };
    const from = params.from ?? chapterNo(task.target.split('-')[0] as string);
    const to = params.to ?? from + 4;
    const artifacts: ArtifactDecl[] = [];
    const parts: string[] = [];
    for (let n = from; n <= to; n++) {
      const text = await state.manuscript(n);
      if (text === null) continue;
      parts.push(`## ${chapterId(n)}\n\n${text}`);
      artifacts.push({ path: P.ledger(n), kind: 'delta', schema: 'nv.delta/1', required: true });
    }
    if (artifacts.length === 0) return { kind: 'skip', result: { status: 'done', message: '本批没有可导入的章节' } };
    const body = await renderTemplate('import.bootstrap', { range: `${chapterId(from)}–${chapterId(to)}`, chapters: parts.join('\n\n'), op_reference: OP_REFERENCE, output: outputBlock(artifacts, run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, artifacts), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const state = await loadBookState(book.dir);
    const files: { path: string; content: string }[] = [];
    for (const [rel, f] of Object.entries(c.report.files)) {
      if (!/^state\/ledger\/c\d+\.json$/.test(rel)) continue;
      const delta: Delta = zDelta.parse(f.json);
      const no = chapterNo(delta.chapter);
      const text = await state.manuscript(no);
      const card = await book.files.card(no);
      if (text !== null && card) {
        const report = deltaCheck({ delta, draft: text, card, before: state.snapshot, world: state.world, secrets: [], overrides: [], eventFamilies: {}, aliases: buildAliasIndex(aliasEntities(state)), unplannedInvention: 'soft' });
        files.push({ path: rel, content: `${JSON.stringify(report.delta, null, 2)}\n` });
      } else files.push({ path: rel, content: f.text });
    }
    return { status: 'done', inbox: questionsInbox(task, c), promote: { bookId: book.id, taskId: task.id, runId: h.run.runId, baseCommit: h.run.baseCommit, files, resolveTmpIds: true, message: `import: bootstrap ${task.target}`, trailers: {}, tags: [] } };
  },
};

// ───────── bakeoff（opt-in，默认关；§6.0、§6.7）─────────

export const BAKEOFF_DIR = 'work/bakeoff';

function bakeoffCandidates(params: Record<string, unknown>): string[] {
  const c = params.candidates;
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : [];
}

export const bakeoffWrite: TaskHandler = {
  kind: 'bakeoff.write',
  role: 'writer',
  lane: 'side',
  maxAttempts: 3,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.card(chapterNo(spec.target.split('@')[0] as string))], extra: { candidate: spec.params?.candidate ?? null } }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const cid = task.target.split('@')[0] as string;
    const no = chapterNo(cid);
    const card = await state.files.card(no);
    if (!card) return { kind: 'skip', result: { status: 'failed', errorClass: 'config', message: `缺少卡片 ${cid}` } };
    const l = lengthFor(book, card);
    const art: ArtifactDecl = { path: `manuscript/${cid}.md`, kind: 'chapter_draft', required: true, length: { min: l.min, target: l.target, max: l.max, count_mode: l.count_mode } };
    const pack = await buildContextPack({ bookDir: run.snapshotDir, card, snapshot: state.snapshot, state, lexicon: await effectiveLexicon(ctx, book), sampleSeed: cid });
    const body = await renderTemplate('bakeoff.write', { cid, length_range: `${l.min}–${l.max}`, beats: card.beats.map((b) => `<!-- beat:${b.id} --> ${b.goal}`).join('\n'), context: pack.text, output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art]), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const cid = task.target.split('@')[0] as string;
    const candidate = (task.params as { candidate?: string }).candidate ?? h.run.profileId;
    const rel = `${BAKEOFF_DIR}/${cid}/${candidate}.md`;
    await fs.mkdir(path.dirname(path.join(book.dir, rel)), { recursive: true });
    await fs.copyFile(path.join(h.stagedOutDir, `manuscript/${cid}.md`), path.join(book.dir, rel));
    return { status: 'done', summary: { candidate, draft: rel } };
  },
};

export const bakeoffJudge: TaskHandler = {
  kind: 'bakeoff.judge',
  role: 'judge',
  lane: 'side',
  maxAttempts: 3,
  manifest: emptyManifest,
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const params = task.params as { candidates?: string[] };
    const cid = task.target;
    const dir = path.join(book.dir, BAKEOFF_DIR, cid);
    const inputs = bakeoffCandidates(params).map((p) => ({ from: path.join(dir, `${p}.md`), to: `inputs/${p}.md` }));
    const art: ArtifactDecl = { path: 'bakeoff.json', kind: 'json', required: true };
    const body = await renderTemplate('bakeoff.judge', { cid, candidates: inputs.map((i) => `- ${path.join(run.inDir, i.to)}`).join('\n'), output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art], inputs.map((i) => ({ path: path.join(run.inDir, i.to), kind: 'draft' }))), body, inputs, ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const result = c.report.files['bakeoff.json']?.json as { ranking?: string[]; reasons?: string[] } | undefined;
    const decisionRel = `${BAKEOFF_DIR}/${task.target}/decision.json`;
    await fs.mkdir(path.dirname(path.join(book.dir, decisionRel)), { recursive: true });
    await fs.writeFile(path.join(book.dir, decisionRel), `${JSON.stringify({ ranking: result?.ranking ?? [], reasons: result?.reasons ?? [], ts: ctx.deps.now().toISOString() }, null, 2)}\n`);
    return {
      status: 'done',
      summary: { ranking: result?.ranking ?? [] },
      inbox: [
        {
          kind: 'approval',
          bookId: book.id,
          title: `主笔对比结果（${task.target}）：请选择主笔`,
          body: { chapter: task.target, ranking: result?.ranking ?? [], reasons: result?.reasons ?? [], candidates: (task.params as { candidates?: string[] }).candidates ?? [] },
          actions: [{ id: 'choose', label: '确认主笔', needsNote: true }],
          dedupeKey: `bakeoff:${book.id}:${task.target}`,
          relatedTaskId: task.id,
        },
      ],
    };
  },
};

export type { TaskRow };
