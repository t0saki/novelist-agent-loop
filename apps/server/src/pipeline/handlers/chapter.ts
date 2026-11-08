/**
 * 单章任务（DESIGN §6.4 任务图、§6.5 gates、§6.6 delta.check、附录 B）。Owner: lane E。
 * write lane，一本书同时只有一个章节在流水线中。
 * - chapter.write：prepare 内先 ctx.build（buildContextPack；投影 pre 失败 → skip + card.repair）；
 *   finalize：contract gate → craft gate → hard 失败 revise(mech)（≤2，长度类耗尽 accept_with_debt）→ 排抽取。
 * - chapter.check（lite）/ chapter.extract（standard/key）：产出 delta；schema 不合法 → format.repair（≤1）→ 重跑（≤1）；
 *   delta.check + 召回探针 + 泄漏签名 + quotes.verify；关键 op ev 缺失 → chapter.confirm 定向补抽（lite 合并成 1 次）；hard 冲突 → revise(canon)。
 * - chapter.review（standard：一个 run；key：continuity → 判官×2 → 分歧仲裁）→ quotes.verify → missing_ops 并入 → 再跑 delta.check →
 *   revise(findings) → gate → extract(diff) → pairwise（key 档，或 optin.pairwise_regression）→ 保留胜者（≤2，key ≤3）。
 * - chapter.accept（确定性）：剥离 beat 标记写 manuscript、写 ledger/review/debt 增量、标 stale 卡、tag ch/NNNNN，dbEffects 更新 chapters/books。
 * 草稿等中间产物只在 live 树 work/<task>/attempt-k/out（gitignored），由后续任务的 prepare 作为 inputs 带入 run。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { diffArrays } from 'diff';
import { stringify as yamlStringify } from 'yaml';
import { z } from 'zod';
import type { ArtifactDecl, Card, ChapterWorkflowState, ContinuityFlag, Debt, Delta, DeltaOp, Finding, GateResult, Review, TaskKind } from '@novelist/shared';
import {
  chapterId,
  chapterNo,
  countCjk,
  stripBeatMarkers,
  tags as gitTags,
  toJsonSchema,
  zCheckOutput,
  zDelta,
  zDeltaOp,
  zDebt,
  zPairwise,
  zPatches,
  zReview,
} from '@novelist/shared';
import { P, TRAILER } from '../../book/index.js';
import { buildAliasIndex, buildCheckSlice, buildContextPack } from '../../context/index.js';
import { cascadeReplay, aliasEntities, applyDelta, buildTmpIdContext, cardsTouchedBy, evaluateCard, incrementalFoldUpTo, ledgerHash, loadBookState, locateCard, opMatches, projectBuffer, resolveTmpIds, evaluatePredicate } from '../../state/index.js';
import type { BookState } from '../../state/index.js';
import { deltaCheck, gateVerdict, matchEvidence, runCraftGates, verifyFormatRepair, verifyQuotes } from '../../validators/index.js';
import type { DeltaCheckReport } from '../../validators/index.js';
import { effectiveTier, isKeyChapter } from '../book.js';
import {
  buildManifest,
  collectOwnerNotes,
  contractCheck,
  contractFailure,
  effectiveGates,
  effectiveLexicon,
  frontmatterFor,
  inputPath,
  lengthFor,
  loadRunState,
  outputBlock,
  questionsInbox,
  requireBook,
  retryHint,
} from '../common.js';
import type { AgentPlan, BookHandle, HarvestedRun, InboxInput, PipelineContext, PrepareResult, RunContext, TaskHandler, TaskResult, TaskRow, TaskSpec } from '../types.js';
import { chapterActionSpecs } from '../next.js';
import { renderTemplate } from '../workorder.js';
import type { ChapterWorkflow, ConfirmQuestion, DraftRef } from '../workflow.js';
import { getChapterRow, loadWorkflow } from '../workflow.js';
import { OP_REFERENCE } from './shared.js';

// ───────── 章节任务上下文 ─────────

interface ChapterCtx {
  book: BookHandle;
  no: number;
  cid: string;
  card: Card;
  wf: ChapterWorkflow;
}

async function chapterCtx(ctx: PipelineContext, task: TaskRow, rev?: string): Promise<ChapterCtx | null> {
  const book = requireBook(ctx);
  const no = chapterNo(task.target);
  const card = await book.files.card(no, rev);
  if (!card) return null;
  const state = await loadBookState(book.dir);
  const { arc, volume } = locateCard(state, card);
  const tier = effectiveTier(book, no, { card, arc, volume });
  const key = isKeyChapter(no, { card, arc, volume });
  const wf = await loadWorkflow(ctx.deps.db, book.id, no, tier, key);
  return { book, no, cid: task.target, card, wf };
}

const missingCard = (task: TaskRow): TaskResult => ({ status: 'failed', errorClass: 'config', message: `缺少卡片：${task.target}` });

function chapterSpec(b: ChapterCtx, kind: TaskKind, params: Record<string, unknown> = {}, extra: Partial<TaskSpec> = {}): TaskSpec {
  b.wf.seq += 1;
  const merged: Record<string, unknown> = { instance: `s${b.wf.seq}`, ...params };
  b.wf.next = { kind, params: merged, ...(extra.role ? { role: extra.role } : {}), ...(extra.lane ? { lane: extra.lane } : {}), ...(extra.priority !== undefined ? { priority: extra.priority } : {}) };
  return { kind, bookId: b.book.id, target: b.cid, tier: b.wf.tier, params: merged, ...extra };
}

function chapterResult(b: ChapterCtx, state: ChapterWorkflowState, followups: TaskSpec[] = [], extra: Partial<TaskResult> = {}): TaskResult {
  return {
    status: 'done',
    chapter: { no: b.no, state, workflow: b.wf as unknown as Record<string, unknown> },
    followups,
    ...extra,
  };
}

/**
 * hold/block 的 Inbox 效果（body.on）：放行 = 有定稿 delta 走 chapter.accept（ownerApproved），否则继续抽取；重写 = 新实例的 chapter.write。
 * chapters.state + workflow.next 一起写，崩溃或 followups 还没投递时 writeLane 也能按同一实例补派。
 */
function ownerGateOn(b: ChapterCtx, task: TaskRow): Record<string, unknown> {
  const inst = `owner-${task.id.slice(0, 10)}`;
  const nextOf = (s: TaskSpec | undefined): ChapterWorkflow['next'] => (s ? { kind: s.kind, params: s.params ?? {} } : null);
  const approve = chapterActionSpecs(b.book, b.no, 'approve', { instance: `${inst}-approve`, workflow: b.wf });
  const rewrite = chapterActionSpecs(b.book, b.no, 'rewrite', { instance: `${inst}-rewrite`, workflow: b.wf });
  const approvedWf: ChapterWorkflow = { ...b.wf, verdict: b.wf.delta ? 'accept_with_debt' : b.wf.verdict, owner: { ...b.wf.owner, approved: true }, next: nextOf(approve.specs[0]) };
  return {
    approve: { task: 'done', followups: approve.specs, chapter: { no: b.no, state: approve.chapter?.state ?? 'checking', workflow: approvedWf } },
    rewrite: { task: 'cancelled', followups: rewrite.specs, chapter: rewrite.chapter },
  };
}

function holdResult(b: ChapterCtx, task: TaskRow, title: string, body: Record<string, unknown>): TaskResult {
  b.wf.verdict = 'hold';
  b.wf.next = null;
  const inbox: InboxInput = {
    kind: 'hold',
    bookId: b.book.id,
    title,
    body: { chapter: b.cid, target: b.cid, task: task.id, ...body, on: ownerGateOn(b, task) },
    actions: [{ id: 'approve', label: '放行', needsNote: false }, { id: 'rewrite', label: '重写', danger: true, needsNote: true }],
    dedupeKey: `hold:${b.cid}`,
    relatedTaskId: task.id,
  };
  return { status: 'hold', message: title, chapter: { no: b.no, state: 'held', workflow: b.wf as unknown as Record<string, unknown> }, inbox: [inbox] };
}

function blockResult(b: ChapterCtx, task: TaskRow, title: string, body: Record<string, unknown>): TaskResult {
  b.wf.verdict = 'block';
  b.wf.next = null;
  const inbox: InboxInput = {
    kind: 'block',
    bookId: b.book.id,
    title,
    body: { chapter: b.cid, target: b.cid, task: task.id, ...body, on: ownerGateOn(b, task) },
    actions: [{ id: 'approve', label: '强制放行', danger: true }, { id: 'rewrite', label: '重写', danger: true, needsNote: true }],
    dedupeKey: `block:${b.cid}`,
    relatedTaskId: task.id,
  };
  return { status: 'blocked', message: title, chapter: { no: b.no, state: 'blocked', workflow: b.wf as unknown as Record<string, unknown> }, inbox: [inbox] };
}

const readRel = (book: BookHandle, rel: string): Promise<string> => fs.readFile(path.join(book.dir, rel), 'utf8');

async function writeWork(book: BookHandle, rel: string, content: string): Promise<void> {
  const abs = path.join(book.dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const relFromOut = (book: BookHandle, h: HarvestedRun, rel: string): string => path.relative(book.dir, path.join(h.stagedOutDir, rel)).split(path.sep).join('/');
const attemptDir = (book: BookHandle, h: HarvestedRun): string => path.relative(book.dir, path.dirname(h.stagedOutDir)).split(path.sep).join('/');

function draftRef(book: BookHandle, task: TaskRow, h: HarvestedRun, rel: string, title?: string): DraftRef {
  return {
    path: relFromOut(book, h, rel),
    taskId: task.id,
    attempt: h.run.attempt,
    runId: h.run.runId,
    harness: h.run.harness,
    model: h.run.model,
    ...(title ? { titleProposal: title } : {}),
  };
}

// ───────── manifest ─────────

function chapterHardDeps(no: number): string[] {
  const deps = [P.card(no)];
  if (no > 1) deps.push(P.manuscript(no - 1), P.ledger(no - 1));
  if (no > 2) deps.push(P.manuscript(no - 2));
  return deps;
}

const chapterManifest = (ctx: PipelineContext, spec: TaskSpec) => buildManifest(ctx, spec, { hard: chapterHardDeps(chapterNo(spec.target)) });

// ───────── 写作类（write / revise / expand / compress）───────────

const beatsText = (card: Card): string => card.beats.map((b) => `<!-- beat:${b.id} -->  （${b.mode}，约 ${b.cjk} 字）${b.goal}`).join('\n');
const lengthRange = (l: { min: number; max: number }) => `${l.min}–${l.max}`;

async function writerContext(ctx: PipelineContext, b: { book: BookHandle; card: Card; cid: string }, run: RunContext) {
  const state = await loadRunState(run);
  const pack = await buildContextPack({ bookDir: run.snapshotDir, card: b.card, snapshot: state.snapshot, state, lexicon: await effectiveLexicon(ctx, b.book), sampleSeed: b.cid });
  return { state, pack };
}

function draftArtifact(cid: string, book: BookHandle, card: Card): ArtifactDecl {
  const l = lengthFor(book, card);
  return { path: `manuscript/${cid}.md`, kind: 'chapter_draft', required: true, length: { min: l.min, target: l.target, max: l.max, count_mode: l.count_mode }, description: '章节正文（含 beat 锚点）' };
}

function writerVars(b: { cid: string; card: Card; book: BookHandle }): Record<string, string> {
  const l = lengthFor(b.book, b.card);
  return {
    cid: b.cid,
    title: b.card.title,
    length_range: lengthRange(l),
    length_target: String(l.target),
    count_mode: l.count_mode === 'han' ? '汉字' : '平台字数',
    beats: beatsText(b.card),
    max_reads: '4',
    max_searches: '8',
  };
}

async function prepareWrite(ctx: PipelineContext, task: TaskRow, run: RunContext): Promise<PrepareResult> {
  const book = requireBook(ctx);
  const no = chapterNo(task.target);
  const state = await loadRunState(run);
  const card = await state.files.card(no);
  if (!card) return { kind: 'skip', result: missingCard(task) };
  // 投影校验（§6.2）：写前 pre 不成立 → card.repair，不开 writer run
  const report = evaluateCard(card, state.snapshot);
  const badPre = report.pre.filter((p) => p.value === false || p.value === 'unresolved');
  if (card.stale || badPre.length > 0) {
    const reasons = card.stale ? ['卡片已标记 stale'] : badPre.map((p) => `pre 不成立：${JSON.stringify(p.cond)}`);
    return {
      kind: 'skip',
      result: {
        status: 'done',
        message: `卡片 ${card.id} 前提失效，转 card.repair`,
        followups: [{ kind: 'card.repair', bookId: book.id, target: card.id, params: { cards: [card.id], reasons: { [card.id]: reasons } } }],
        chapter: { no, state: 'needs_repair', workflow: {} },
      },
    };
  }
  const b = { book, card, cid: task.target };
  const { pack } = await writerContext(ctx, b, run);
  const art = draftArtifact(task.target, book, card);
  const body = await renderTemplate('chapter.write', {
    ...writerVars(b),
    output: outputBlock([art], run.outDir),
    retry: retryHint(task),
    context: pack.text,
  });
  const plan: AgentPlan = {
    frontmatter: frontmatterFor(book, task, run, [art]),
    body,
    inputs: [],
    ownerNotes: collectOwnerNotes(card, task),
  };
  return { kind: 'run', plan };
}

async function draftInput(b: ChapterCtx, run: RunContext, ref: DraftRef): Promise<{ input: AgentPlan['inputs'][number]; path: string }> {
  return { input: { from: path.join(b.book.dir, ref.path), to: 'inputs/draft.md' }, path: inputPath(run, 'inputs/draft.md') };
}

async function prepareRevision(ctx: PipelineContext, task: TaskRow, run: RunContext, kind: 'chapter.revise' | 'chapter.expand' | 'chapter.compress'): Promise<PrepareResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return { kind: 'skip', result: missingCard(task) };
  if (!b.wf.draft) return { kind: 'skip', result: { status: 'failed', message: '缺少上一稿' } };
  const { input, path: draftPath } = await draftInput(b, run, b.wf.draft);
  const params = task.params as { brief?: string; mode?: string; measured?: number };
  const { pack } = await writerContext(ctx, b, run);
  const art = draftArtifact(b.cid, b.book, b.card);
  const modeLabel = { mech: '机械修订', canon: '正典修订', findings: '评审修订' }[params.mode ?? 'mech'] ?? '修订';
  const body = await renderTemplate(kind, {
    ...writerVars(b),
    mode_label: modeLabel,
    draft_path: draftPath,
    measured: String(params.measured ?? ''),
    revision_brief: params.brief ?? '',
    output: outputBlock([art], run.outDir),
    retry: retryHint(task),
    context: pack.text,
  });
  return {
    kind: 'run',
    plan: { frontmatter: frontmatterFor(b.book, task, run, [art], [{ path: draftPath, kind: 'draft', description: '上一稿' }]), body, inputs: [input], ownerNotes: collectOwnerNotes(b.card, task) },
  };
}

async function craftResults(ctx: PipelineContext, b: ChapterCtx, draft: string): Promise<GateResult[]> {
  const state = await loadBookState(b.book.dir);
  const recent: { id: string; text: string }[] = [];
  for (let n = b.no - 1; n >= Math.max(1, b.no - 30); n--) {
    const t = await state.manuscript(n);
    if (t) recent.push({ id: chapterId(n), text: t });
  }
  const glossary = await b.book.files.glossary().catch(() => null);
  const protectedTerms = [...new Set([...(glossary?.terms.flatMap((t) => [t.term, ...t.aliases]) ?? []), ...state.entities.flatMap((e) => [e.entity.name, ...e.entity.aliases.map((a) => (typeof a === 'string' ? a : a.text))])])];
  const results = runCraftGates({
    draft,
    card: b.card,
    length: lengthFor(b.book, b.card),
    gates: await effectiveGates(ctx, b.book),
    lexicon: await effectiveLexicon(ctx, b.book),
    isFinal: b.card.is_final,
    recent,
    protectedTerms,
  });
  return results;
}

const hardGateBrief = (hard: GateResult[]): string => hard.map((g) => `- [${g.rule}] ${g.detail ?? '未通过'}${g.spans.length ? `（例：${g.spans[0]?.text ?? ''}）` : ''}`).join('\n');

function sentenceRatio(oldText: string, newText: string): number {
  const split = (t: string) => t.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  const a = split(stripBeatMarkers(oldText));
  const b = split(stripBeatMarkers(newText));
  const total = b.join('').length || 1;
  let changed = 0;
  for (const part of diffArrays(a, b)) if (part.added) changed += part.value.join('').length;
  return changed / total;
}

function extractionStep(b: ChapterCtx, opts: { expandOnly?: boolean; mode?: 'full' | 'diff' } = {}): TaskSpec {
  const kind: TaskKind = b.wf.tier === 'lite' ? 'chapter.check' : 'chapter.extract';
  return chapterSpec(b, kind, { mode: opts.mode ?? 'full', expandOnly: opts.expandOnly === true }, kind === 'chapter.check' ? { role: 'checker' } : {});
}

async function afterGates(task: TaskRow, b: ChapterCtx, draftText: string): Promise<TaskResult> {
  const cfg = b.book.config;
  if (cfg.optin.formatcheck && b.wf.counters.formatcheck === 0 && task.kind !== 'chapter.formatcheck') {
    b.wf.counters.formatcheck += 1;
    const spec = chapterSpec(b, 'chapter.formatcheck', { from: task.kind });
    return chapterResult(b, 'gating', [spec]);
  }
  let mode: 'full' | 'diff' = 'full';
  if (b.wf.delta && b.wf.draft) {
    // 修订后默认 diff 抽取；编辑比例超过 35% 退回 full（§6.4）
    const prev = task.kind === 'chapter.write' ? null : await priorDraftText(b);
    if (prev !== null && sentenceRatio(prev, draftText) <= 0.35) mode = 'diff';
  }
  // expand 拒收规则只对 diff 抽取有意义（full 抽取的 ops 全是“新增”）
  const expandOnly = task.kind === 'chapter.expand' && mode === 'diff';
  return chapterResult(b, 'checking', [extractionStep(b, { mode, expandOnly })]);
}

async function priorDraftText(b: ChapterCtx): Promise<string | null> {
  const ref = b.wf.prevDraft;
  if (!ref) return null;
  return readRel(b.book, ref.path).catch(() => null);
}

async function finalizeWriter(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return missingCard(task);
  const c = await contractCheck(task, h);
  if (!c.ok) return contractFailure(task, h, c, task.maxAttempts, { no: b.no });
  const rel = `manuscript/${b.cid}.md`;
  const draft = c.report.files[rel]?.text ?? '';
  const params = task.params as { mode?: string };
  // 修订前的草稿留给 pairwise / diff 抽取比较
  if (b.wf.draft && task.kind !== 'chapter.write') {
    b.wf.prevDraft = b.wf.draft;
    b.wf.prevDelta = b.wf.delta;
  }
  b.wf.pairwisePending = task.kind === 'chapter.revise' && params.mode === 'findings';
  b.wf.draft = draftRef(b.book, task, h, rel, c.report.receipt?.title_proposal);
  const gates = await craftResults(ctx, b, draft);
  b.wf.lastGates = [...c.results, ...gates];
  const v = gateVerdict(gates);
  const inbox = questionsInbox(task, c);
  const withInbox = (r: TaskResult): TaskResult => (inbox.length ? { ...r, inbox: [...(r.inbox ?? []), ...inbox] } : r);
  if (v.ok) {
    return withInbox(await afterGates(task, b, draft));
  }
  if (b.wf.counters.mech < 2) {
    b.wf.counters.mech += 1;
    const brief = `确定性检查未通过，请修正：\n\n${hardGateBrief(v.hardFailed)}`;
    const measured = v.hardFailed[0]?.measured?.total;
    if (v.suggestion === 'expand') return withInbox(chapterResult(b, 'revising', [chapterSpec(b, 'chapter.expand', { brief, measured })]));
    if (v.suggestion === 'compress') return withInbox(chapterResult(b, 'revising', [chapterSpec(b, 'chapter.compress', { brief, measured })]));
    return withInbox(chapterResult(b, 'revising', [chapterSpec(b, 'chapter.revise', { mode: 'mech', brief })]));
  }
  // 耗尽策略：长度类/工艺类 hard（§6.4 耗尽策略表）
  const policy = b.book.config.policy.on_exhausted.craft_hard[b.wf.key ? 'key' : 'normal'];
  if (policy === 'accept_with_debt') {
    for (const g of v.hardFailed) b.wf.debts.push({ class: 'forward', rule: g.rule, detail: g.detail ?? '工艺 hard 问题' });
    return withInbox(await afterGates(task, b, draft));
  }
  // 走到这里说明本稿还没抽取：之前的 delta（若有）对应旧稿，放行时必须重新抽取
  b.wf.delta = null;
  if (policy === 'hold') return holdResult(b, task, `章节 ${b.cid} 工艺问题修订耗尽，待人工处理`, { gates: v.hardFailed.map((g) => ({ rule: g.rule, detail: g.detail })) });
  return blockResult(b, task, `章节 ${b.cid} 工艺问题修订耗尽`, { gates: v.hardFailed.map((g) => ({ rule: g.rule, detail: g.detail })) });
}

// ───────── formatcheck（opt-in，默认关）─────────

function applyPatches(draft: string, patches: { find: string; replace: string }[]): { text: string; applied: number; rejected: string[] } {
  let text = draft;
  let applied = 0;
  const rejected: string[] = [];
  for (const p of patches) {
    const first = text.indexOf(p.find);
    if (first < 0 || text.indexOf(p.find, first + p.find.length) >= 0) {
      rejected.push(p.find);
      continue;
    }
    text = text.slice(0, first) + p.replace + text.slice(first + p.find.length);
    applied += 1;
  }
  return { text, applied, rejected };
}

function worseLint(before: GateResult[], after: GateResult[]): boolean {
  const hits = (rs: GateResult[]) => rs.filter((r) => r.rule === 'lexicon').reduce((n, r) => n + (r.ok ? 0 : r.spans.length || 1), 0);
  const hard = (rs: GateResult[]) => rs.filter((r) => !r.ok && r.level === 'hard').length;
  return hard(after) > hard(before) || hits(after) > hits(before);
}

async function patchStep(ctx: PipelineContext, task: TaskRow, b: ChapterCtx, h: HarvestedRun): Promise<{ applied: number; rejected: string[] }> {
  const c = await contractCheck(task, h);
  if (!c.ok || !b.wf.draft) return { applied: 0, rejected: [] };
  const patches = zPatches.parse(c.report.files['patches.json']?.json);
  const draft = await readRel(b.book, b.wf.draft.path);
  const before = await craftResults(ctx, b, draft);
  const r = applyPatches(draft, patches.patches);
  if (r.applied > 0) {
    const after = await craftResults(ctx, b, r.text);
    if (!worseLint(before, after)) {
      const rel = `${attemptDir(b.book, h)}/patched.md`;
      await writeWork(b.book, rel, r.text);
      b.wf.draft = { ...b.wf.draft, path: rel };
      b.wf.lastGates = [...b.wf.lastGates.filter((g) => g.family === 'contract'), ...after];
      return r;
    }
    return { applied: 0, rejected: r.rejected };
  }
  return r;
}

export const chapterFormatcheck: TaskHandler = {
  kind: 'chapter.formatcheck',
  role: 'format_checker',
  lane: 'write',
  maxAttempts: 2,
  manifest: chapterManifest,
  async prepare(ctx, task, run) {
    const b = await chapterCtx(ctx, task);
    if (!b) return { kind: 'skip', result: missingCard(task) };
    if (!b.wf.draft) return { kind: 'skip', result: { status: 'failed', message: '缺少草稿' } };
    const { input, path: draftPath } = await draftInput(b, run, b.wf.draft);
    const art: ArtifactDecl = { path: 'patches.json', kind: 'patches', schema: 'nv.patches/1', required: true };
    const body = await renderTemplate('chapter.formatcheck', { cid: b.cid, draft_path: draftPath, output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(b.book, task, run, [art], [{ path: draftPath, kind: 'draft' }]), body, inputs: [input], ownerNotes: collectOwnerNotes(b.card, task) } };
  },
  async finalize(ctx, task, h) {
    const b = await chapterCtx(ctx, task);
    if (!b) return missingCard(task);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts, { no: b.no });
    await patchStep(ctx, task, b, h);
    const draft = b.wf.draft ? await readRel(b.book, b.wf.draft.path) : '';
    return afterGates(task, b, draft);
  },
};

// ───────── 抽取 / 校对 ─────────

function modeRules(mode: string, expandOnly: boolean, basePath: string | null): string {
  if (mode !== 'diff') return '模式 full：抽取本章全部状态变化。';
  return [
    `模式 diff：这是修订稿，上一版账本增量在 \`${basePath ?? ''}\`。只输出**发生变化**的 op（新增或被修改的），未变化的 op 由程序继承并逐字校验；summary 必须按新稿重写。`,
    expandOnly ? '本次是扩写修订，不得新增 event、fact.assert、entity.create、obligation.open，这些 op 会被状态引擎拒收。' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function prepareExtract(ctx: PipelineContext, task: TaskRow, run: RunContext, kind: 'chapter.check' | 'chapter.extract'): Promise<PrepareResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return { kind: 'skip', result: missingCard(task) };
  if (!b.wf.draft) return { kind: 'skip', result: { status: 'failed', message: '缺少草稿' } };
  const params = task.params as { mode?: string; expandOnly?: boolean; hint?: string };
  const mode = params.mode === 'diff' && b.wf.delta ? 'diff' : 'full';
  const state = await loadRunState(run);
  const slice = await buildCheckSlice({ bookDir: run.snapshotDir, card: b.card, snapshot: state.snapshot, state });
  const { input, path: draftPath } = await draftInput(b, run, b.wf.draft);
  const inputs = [input];
  const fmInputs: AgentPlan['frontmatter']['inputs'] = [{ path: draftPath, kind: 'draft', description: '本章草稿' }];
  let basePath: string | null = null;
  if (mode === 'diff' && b.wf.delta) {
    inputs.push({ from: path.join(b.book.dir, b.wf.delta), to: 'inputs/base.delta.json' });
    basePath = inputPath(run, 'inputs/base.delta.json');
    fmInputs.push({ path: basePath, kind: 'delta', description: '上一版账本增量' });
  }
  const artifacts: ArtifactDecl[] =
    kind === 'chapter.check'
      ? [{ path: 'check.json', kind: 'check', schema: 'nv.check/1', required: true }]
      : [{ path: 'delta.json', kind: 'delta', schema: 'nv.delta/1', required: true }];
  const hint = params.hint ? `\n本次重点：${params.hint}\n` : '';
  const body = await renderTemplate(kind, {
    cid: b.cid,
    mode,
    draft_path: draftPath,
    mode_rules: `${modeRules(mode, params.expandOnly === true, basePath)}${hint}`,
    check_slice: slice,
    op_reference: OP_REFERENCE,
    output: outputBlock(artifacts, run.outDir),
    retry: retryHint(task),
  });
  return { kind: 'run', plan: { frontmatter: frontmatterFor(b.book, task, run, artifacts, fmInputs), body, inputs, ownerNotes: collectOwnerNotes(b.card, task) } };
}

function runDeltaCheck(book: BookHandle, state: BookState, card: Card, delta: Delta, draft: string, flags: ContinuityFlag[], expandOnly: boolean): DeltaCheckReport {
  const { volume } = locateCard(state, card);
  return deltaCheck({
    delta,
    draft,
    card,
    before: state.snapshot,
    world: state.world,
    secrets: state.secrets.map((s) => s.secret),
    overrides: state.overrides,
    eventFamilies: book.genre.eventFamilies,
    aliases: buildAliasIndex(aliasEntities(state)),
    ...(volume?.power_range ? { powerRange: volume.power_range } : {}),
    continuityFlags: flags,
    unplannedInvention: book.config.policy.unplanned_invention,
    entities: state.entities.map((e) => e.entity),
    expandOnly,
  });
}

/** diff 模式合并：继承 op 逐字校验 ev（新稿找不到的移除），再并入本次新增；summary 取新稿 */
function mergeDiffDelta(base: Delta, diff: Delta, draft: string): Delta {
  const stripped = stripBeatMarkers(draft);
  const inherited = base.ops.filter((op) => {
    const ev = (op as { ev?: string }).ev;
    return ev === undefined || matchEvidence(stripped, ev).kind !== 'none';
  });
  const key = (o: DeltaOp) => JSON.stringify(o);
  const seen = new Set(inherited.map(key));
  const ops = [...inherited];
  for (const op of diff.ops) {
    if (!seen.has(key(op))) {
      ops.push(op);
      seen.add(key(op));
    }
  }
  return {
    ...base,
    mode: 'full',
    summary: diff.summary.length ? diff.summary : base.summary,
    beats_realized: diff.beats_realized.length ? diff.beats_realized : base.beats_realized,
    ops,
    uses_knowledge: [...base.uses_knowledge, ...diff.uses_knowledge],
    entities_present: [...new Set([...base.entities_present, ...diff.entities_present])],
    realized_patterns: diff.realized_patterns.length ? diff.realized_patterns : base.realized_patterns,
  };
}

async function saveDelta(b: ChapterCtx, h: HarvestedRun, name: string, delta: Delta): Promise<string> {
  const rel = `${attemptDir(b.book, h)}/${name}`;
  await writeWork(b.book, rel, `${JSON.stringify(delta, null, 2)}\n`);
  return rel;
}

async function loadDelta(book: BookHandle, rel: string): Promise<Delta> {
  return zDelta.parse(JSON.parse(await readRel(book, rel)));
}

function confirmLimit(b: ChapterCtx): number {
  return b.wf.tier === 'lite' ? 1 : 2;
}
function canonLimit(b: ChapterCtx): number {
  return b.wf.tier === 'lite' ? 1 : 2;
}
function findingsLimit(b: ChapterCtx): number {
  return b.wf.tier === 'key' ? 3 : 2;
}

function pairwiseEnabled(b: ChapterCtx): boolean {
  return b.wf.tier === 'key' || b.book.config.optin.pairwise_regression;
}

function reviewSlots(tier: ChapterWorkflow['tier']): string[] {
  return tier === 'key' ? ['continuity', 'judge-a', 'judge-b'] : ['combined'];
}

function reviewStep(b: ChapterCtx, slot: string): TaskSpec {
  const role = slot === 'continuity' ? 'continuity' : slot.startsWith('judge') || slot === 'arbiter' ? 'judge' : 'reviewer';
  return chapterSpec(b, 'chapter.review', { slot }, { role });
}

function acceptStep(b: ChapterCtx): TaskSpec {
  return chapterSpec(b, 'chapter.accept');
}

function goToReviewOrAccept(b: ChapterCtx): TaskResult {
  if (b.wf.tier === 'lite') return chapterResult(b, 'accepting', [acceptStep(b)]);
  // 修订稿的 pairwise（保留胜者）
  if (b.wf.pairwisePending && b.wf.prevDraft && pairwiseEnabled(b)) return chapterResult(b, 'reviewing', [chapterSpec(b, 'chapter.pairwise')]);
  b.wf.pairwisePending = false;
  b.wf.prevDraft = null;
  b.wf.reviews = [];
  return chapterResult(b, 'reviewing', [reviewStep(b, reviewSlots(b.wf.tier)[0] ?? 'combined')]);
}

const describeOp = (d: Delta, idx: number): string => JSON.stringify(d.ops[idx] ?? {});

async function routeDeltaReport(task: TaskRow, b: ChapterCtx, h: HarvestedRun, report: DeltaCheckReport, originalDelta: Delta): Promise<TaskResult> {
  // 软发现记入指标类债务
  for (const f of report.soft) b.wf.debts.push({ class: 'metric', rule: f.category, detail: f.message });
  const validated = report.delta;
  const needsConfirm = report.reextract.length > 0 || report.unmetPost.length > 0 || report.recallMisses.length > 0;
  if (needsConfirm && b.wf.counters.confirm < confirmLimit(b)) {
    const questions: ConfirmQuestion[] = [];
    let n = 0;
    for (const r of report.reextract) questions.push({ id: `q${++n}`, kind: 'reextract', text: `账本记录了这条 op，但引文不在草稿中（${r.reason}）。请在草稿中找到实际出现的句子，给出正确 op：${describeOp(originalDelta, r.index)}` });
    for (const u of report.unmetPost) questions.push({ id: `q${++n}`, kind: 'unmet_post', text: `章卡要求发生：${JSON.stringify(u.cond)}。草稿中是否写了？候选句：${u.candidates.slice(0, 3).join(' / ') || '（无）'}。有就给逐字引文和对应 op。` });
    for (const m of report.recallMisses) questions.push({ id: `q${++n}`, kind: 'recall', text: `草稿提到 ${m.entity}（${m.family}）：「${m.quote}」，但账本没有对应 op。如确实发生，给出 op；否则 found: false。` });
    const path0 = await saveDelta(b, h, 'delta.pending.json', validated);
    b.wf.pending = { path: path0, questions };
    b.wf.counters.confirm += 1;
    const spec = chapterSpec(b, 'chapter.confirm', {}, { role: b.wf.tier === 'lite' ? 'checker' : 'confirm' });
    return chapterResult(b, 'delta_check', [spec]);
  }
  // confirm 用尽后：未补回的关键 op 移除并记 forward 债，未回应的 recall 记 forward 债
  let finalDelta = validated;
  if (report.reextract.length > 0) {
    const draft = b.wf.draft ? await readRel(b.book, b.wf.draft.path) : '';
    const stripped = stripBeatMarkers(draft);
    const before = finalDelta.ops.length;
    finalDelta = { ...finalDelta, ops: finalDelta.ops.filter((op) => { const ev = (op as { ev?: string }).ev; return ev === undefined || matchEvidence(stripped, ev).kind !== 'none'; }) };
    b.wf.debts.push({ class: 'forward', rule: 'ledger.reextract', detail: `${before - finalDelta.ops.length} 条关键 op 无法在草稿中确认，已移除：${report.reextract.map((r) => r.reason).join('；')}` });
  }
  for (const m of report.recallMisses) b.wf.debts.push({ class: 'forward', rule: 'recall.miss', detail: `${m.entity}/${m.family}: ${m.quote}` });
  b.wf.delta = await saveDelta(b, h, 'delta.validated.json', finalDelta);

  // 分流：extractor 错 → 重跑一次抽取；writer 问题 → revise(canon)
  const writerHard = report.hard.filter((f) => report.attribution[f.id] === 'writer');
  const extractorHard = report.hard.filter((f) => report.attribution[f.id] !== 'writer');
  const writerIssues = [
    ...writerHard.map((f) => `- ${f.category}：${f.message}${f.quote ? `（原文：${f.quote}）` : ''}`),
    ...report.confirmedFlags.map((f) => `- 连续性：${f.message}（原文：${f.quote}）`),
    ...report.unmetPost.map((u) => `- 章卡要求未兑现：${JSON.stringify(u.cond)}`),
    ...report.mustNotHits.map((m) => `- 触犯 must_not：${JSON.stringify(m.cond)}${m.quote ? `（原文：${m.quote}）` : ''}`),
    ...report.leaks.map((l) => `- 泄漏秘密 ${l.secret}：${l.quote}`),
  ];
  if (extractorHard.length > 0 && writerIssues.length === 0) {
    if (b.wf.counters.rerun < 1) {
      b.wf.counters.rerun += 1;
      const hint = extractorHard.map((f) => f.message).join('；');
      const step = extractionStep(b, { mode: 'full' });
      step.params = { ...step.params, hint };
      return chapterResult(b, 'checking', [step]);
    }
    return canonExhausted(task, b, extractorHard.map((f) => f.message));
  }
  if (writerIssues.length > 0) {
    if (b.wf.counters.canon < canonLimit(b)) {
      b.wf.counters.canon += 1;
      const brief = `正典核对发现下列问题，必须修正（不得新增与账本矛盾的内容）：\n\n${writerIssues.join('\n')}`;
      const followups = [chapterSpec(b, 'chapter.revise', { mode: 'canon', brief })];
      return chapterResult(b, 'revising', followups);
    }
    return canonExhausted(task, b, writerIssues);
  }
  return goToReviewOrAccept(b);
}

function canonExhausted(task: TaskRow, b: ChapterCtx, issues: string[]): TaskResult {
  const policy = b.book.config.policy.on_exhausted.canon_hard;
  const title = `章节 ${b.cid} 正典冲突修订耗尽（确认查询后仍成立）`;
  return policy === 'hold' ? holdResult(b, task, title, { issues }) : blockResult(b, task, title, { issues });
}

async function processExtraction(_ctx: PipelineContext, task: TaskRow, b: ChapterCtx, h: HarvestedRun, delta: Delta, flags: ContinuityFlag[], params: { mode?: string; expandOnly?: boolean }): Promise<TaskResult> {
  if (!b.wf.draft) return { status: 'failed', message: '缺少草稿' };
  const draft = await readRel(b.book, b.wf.draft.path);
  let merged = delta;
  if (params.mode === 'diff' && b.wf.delta) {
    const base = await loadDelta(b.book, b.wf.delta);
    merged = mergeDiffDelta(base, delta, draft);
  }
  merged = { ...merged, chapter: b.cid };
  const state = await loadBookState(b.book.dir);
  const report = runDeltaCheck(b.book, state, b.card, merged, draft, flags, params.expandOnly === true);
  b.wf.delta = await saveDelta(b, h, 'delta.validated.json', report.delta);
  b.wf.lastExtractMode = params.mode === 'diff' ? 'diff' : 'full';
  return routeDeltaReport(task, b, h, report, merged);
}

async function finalizeExtraction(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return missingCard(task);
  const isCheck = task.kind === 'chapter.check';
  const rawRel = isCheck ? 'check.json' : 'delta.json';
  const c = await contractCheck(task, h);
  const params = task.params as { mode?: string; expandOnly?: boolean };
  const raw = c.report.files[rawRel];
  const schemaFail = !c.ok && raw !== undefined && c.results.filter((r) => !r.ok).every((r) => r.rule === 'contract.schema');
  if (schemaFail) {
    // schema 不合法 → format.repair（≤1）→ 仍不合法 → 重跑（≤1）
    if (b.wf.counters.formatRepair < 1) {
      b.wf.counters.formatRepair += 1;
      const spec = chapterSpec(b, 'format.repair', { raw: relFromOut(b.book, h, rawRel), source: task.kind, mode: params.mode ?? 'full', expandOnly: params.expandOnly === true, errors: c.results.filter((r) => !r.ok).map((r) => r.detail ?? '').join('；') });
      return chapterResult(b, 'format_repair', [spec]);
    }
    if (b.wf.counters.rerun < 1) {
      b.wf.counters.rerun += 1;
      return chapterResult(b, 'checking', [extractionStep(b, { mode: params.mode === 'diff' ? 'diff' : 'full', expandOnly: params.expandOnly === true })]);
    }
    return blockResult(b, task, `章节 ${b.cid} 抽取输出多次不合法`, { detail: c.results.filter((r) => !r.ok).map((r) => r.detail) });
  }
  if (!c.ok) return contractFailure(task, h, c, task.maxAttempts, { no: b.no });
  let delta: Delta;
  let flags: ContinuityFlag[] = [];
  try {
    if (isCheck) {
      const parsed = zCheckOutput.parse(raw?.json);
      delta = parsed.delta;
      flags = parsed.continuity_flags;
    } else delta = zDelta.parse(raw?.json);
  } catch (e) {
    return { status: 'retry', errorClass: 'output_contract', message: `解析 ${rawRel} 失败：${(e as Error).message}` };
  }
  return processExtraction(ctx, task, b, h, delta, flags, params);
}

// ───────── format.repair ─────────

async function finalizeRepair(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return missingCard(task);
  const params = task.params as { raw?: string; source?: string; mode?: string; expandOnly?: boolean };
  const isCheck = params.source === 'chapter.check';
  const rel = isCheck ? 'check.json' : 'delta.json';
  const c = await contractCheck(task, h);
  const rerun = (): TaskResult => {
    if (b.wf.counters.rerun < 1) {
      b.wf.counters.rerun += 1;
      return chapterResult(b, 'checking', [extractionStep(b, { mode: params.mode === 'diff' ? 'diff' : 'full', expandOnly: params.expandOnly === true })]);
    }
    return blockResult(b, task, `章节 ${b.cid} 抽取输出多次不合法`, { detail: 'format.repair 校验未通过' });
  };
  if (!c.ok) return c.report.files[rel] ? rerun() : contractFailure(task, h, c, task.maxAttempts, { no: b.no });
  let repaired: Delta;
  let flags: ContinuityFlag[] = [];
  let original: unknown = null;
  if (params.raw) original = await readRel(b.book, params.raw).catch(() => null);
  try {
    if (isCheck) {
      const p = zCheckOutput.parse(c.report.files[rel]?.json);
      repaired = p.delta;
      flags = p.continuity_flags;
    } else repaired = zDelta.parse(c.report.files[rel]?.json);
  } catch {
    return rerun();
  }
  if (!b.wf.draft) return { status: 'failed', message: '缺少草稿' };
  const draft = await readRel(b.book, b.wf.draft.path);
  const v = verifyFormatRepair(original, repaired, draft);
  if (!v.ok) return rerun();
  return processExtraction(ctx, task, b, h, repaired, flags, params);
}

// ───────── confirm（定向补抽）─────────

const zConfirmOutput = z.object({
  schema: z.literal('nv.confirm/1').optional(),
  answers: z.array(z.object({ id: z.string(), found: z.boolean(), quote: z.string().optional(), ops: z.array(zDeltaOp).default([]) })),
});

async function finalizeConfirm(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return missingCard(task);
  const c = await contractCheck(task, h);
  if (!c.ok) return contractFailure(task, h, c, task.maxAttempts, { no: b.no });
  const parsed = zConfirmOutput.safeParse(c.report.files['confirm.json']?.json);
  if (!parsed.success) return { status: 'retry', errorClass: 'output_contract', message: `confirm.json 不合法：${parsed.error.issues[0]?.message ?? ''}` };
  if (!b.wf.pending || !b.wf.draft) return { status: 'failed', message: '缺少 pending delta' };
  const draft = await readRel(b.book, b.wf.draft.path);
  const stripped = stripBeatMarkers(draft);
  const pending = await loadDelta(b.book, b.wf.pending.path);
  const qs = new Map(b.wf.pending.questions.map((q) => [q.id, q]));
  // 被问到的 reextract 项：原 op 的 ev 无法确认，先从 pending 删除，答案里若给出修正 op 再并入
  const hasReextract = b.wf.pending.questions.some((q) => q.kind === 'reextract');
  const kept = hasReextract
    ? pending.ops.filter((op) => {
        const ev = (op as { ev?: string }).ev;
        return ev === undefined || matchEvidence(stripped, ev).kind !== 'none';
      })
    : pending.ops;
  const added: DeltaOp[] = [];
  for (const a of parsed.data.answers) {
    if (!a.found || !qs.has(a.id)) continue;
    for (const op of a.ops) {
      const ev = (op as { ev?: string }).ev;
      if (ev && matchEvidence(stripped, ev).kind === 'none') continue;
      added.push(op);
    }
  }
  const merged: Delta = { ...pending, ops: [...kept, ...added] };
  b.wf.pending = null;
  const state = await loadBookState(b.book.dir);
  const report = runDeltaCheck(b.book, state, b.card, merged, draft, [], false);
  b.wf.delta = await saveDelta(b, h, 'delta.validated.json', report.delta);
  // 第二轮不再回到 confirm（lite 限 1 次；standard 允许 2 次由计数控制）
  return routeDeltaReport(task, b, h, report, merged);
}

// ───────── review ─────────

const SLOT_LABELS: Record<string, string> = { combined: '连续性 + 综合判官', continuity: '连续性专审', 'judge-a': '判官一', 'judge-b': '判官二', arbiter: '分歧仲裁' };

async function prepareReview(ctx: PipelineContext, task: TaskRow, run: RunContext): Promise<PrepareResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return { kind: 'skip', result: missingCard(task) };
  if (!b.wf.draft || !b.wf.delta) return { kind: 'skip', result: { status: 'failed', message: '缺少草稿或 delta' } };
  const slot = (task.params as { slot?: string }).slot ?? 'combined';
  const state = await loadRunState(run);
  const slice = await buildCheckSlice({ bookDir: run.snapshotDir, card: b.card, snapshot: state.snapshot, state });
  const { input, path: draftPath } = await draftInput(b, run, b.wf.draft);
  const deltaPath = inputPath(run, 'inputs/delta.json');
  const inputs = [input, { from: path.join(b.book.dir, b.wf.delta), to: 'inputs/delta.json' }];
  const art: ArtifactDecl = { path: 'review.json', kind: 'review', schema: 'nv.review/1', required: true };
  // 带 pay 的章节追加“回收是否兑现了埋设”（§6.4）
  const pays = b.card.pays
    .map((id) => state.snapshot.obligations[id])
    .filter((o): o is NonNullable<typeof o> => !!o)
    .map((o) => `- ${o.id}：埋设原文「${o.open_ev ?? ''}」——回收是否兑现了埋设？`);
  const focus = [
    slot === 'continuity' ? '- 本次只核对连续性：与账本、设定的一致性、逻辑错误，不评判文风。' : '',
    slot === 'arbiter' ? '- 两位判官意见不一致，请独立仲裁并给出最终 verdict。' : '',
    pays.length ? `- 本章有伏笔回收，请判断：\n${pays.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const body = await renderTemplate('chapter.review', {
    cid: b.cid,
    title: b.card.title,
    slot_label: SLOT_LABELS[slot] ?? slot,
    draft_path: draftPath,
    delta_path: deltaPath,
    review_focus: focus,
    check_slice: slice,
    output: outputBlock([art], run.outDir),
    retry: retryHint(task),
  });
  return {
    kind: 'run',
    plan: {
      frontmatter: frontmatterFor(b.book, task, run, [art], [{ path: draftPath, kind: 'draft' }, { path: deltaPath, kind: 'delta' }]),
      body,
      inputs,
      ownerNotes: collectOwnerNotes(b.card, task),
    },
  };
}

function actionableFindings(review: Review, draft: string): Finding[] {
  const quotes = review.findings.filter((f) => f.quote).map((f) => f.quote as string);
  const verified = new Map(verifyQuotes(stripBeatMarkers(draft), quotes).map((v) => [v.quote, v.ok]));
  return review.findings
    .map((f) => ({ ...f, verified: f.quote ? (verified.get(f.quote) ?? false) : true }))
    .filter((f) => f.verified && !f.conflicts_with_author_layer);
}

async function finalizeReview(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return missingCard(task);
  const c = await contractCheck(task, h);
  if (!c.ok) return contractFailure(task, h, c, task.maxAttempts, { no: b.no });
  if (!b.wf.draft) return { status: 'failed', message: '缺少草稿' };
  zReview.parse(c.report.files['review.json']?.json);
  const slot = (task.params as { slot?: string }).slot ?? 'combined';
  const reviewPath = relFromOut(b.book, h, 'review.json');
  b.wf.reviews.push({ slot, path: reviewPath, role: h.run.role, profile: h.run.profileId, model: h.run.model, run: h.run.runId });
  for (const d of h.run.degraded) b.wf.degraded.push({ role: h.run.role, ...d });
  const slots = reviewSlots(b.wf.tier);
  const nextSlot = slot === 'arbiter' ? undefined : slots[slots.indexOf(slot) + 1];
  if (nextSlot) return chapterResult(b, 'reviewing', [reviewStep(b, nextSlot)]);

  const reviews = await Promise.all(b.wf.reviews.map(async (r) => ({ meta: r, review: zReview.parse(JSON.parse(await readRel(b.book, r.path))) })));
  // key 档：判官分歧 → 仲裁一次
  if (b.wf.tier === 'key' && !b.wf.reviews.some((r) => r.slot === 'arbiter')) {
    const judges = reviews.filter((r) => r.meta.slot.startsWith('judge'));
    if (judges.length === 2 && judges[0]?.review.verdict !== judges[1]?.review.verdict) return chapterResult(b, 'reviewing', [reviewStep(b, 'arbiter')]);
  }
  const draft = await readRel(b.book, b.wf.draft.path);
  // 合并 missing_ops（逐字校验）→ 再跑 delta.check
  const missing = reviews.flatMap((r) => r.review.missing_ops);
  if (missing.length > 0 && b.wf.delta) {
    const stripped = stripBeatMarkers(draft);
    const verifiedOps = missing.filter((op) => {
      const ev = (op as { ev?: string }).ev;
      return ev !== undefined && matchEvidence(stripped, ev).kind !== 'none';
    });
    if (verifiedOps.length) {
      const delta = await loadDelta(b.book, b.wf.delta);
      const merged: Delta = { ...delta, ops: [...delta.ops, ...verifiedOps] };
      const state = await loadBookState(b.book.dir);
      const report = runDeltaCheck(b.book, state, b.card, merged, draft, [], false);
      b.wf.delta = await saveDelta(b, h, 'delta.validated.json', report.delta);
      if (!report.ok) return routeDeltaReport(task, b, h, report, merged);
    }
  }
  const actionable = reviews.flatMap((r) => actionableFindings(r.review, draft));
  const verdict = aggregateVerdict(b, reviews.map((r) => ({ slot: r.meta.slot, verdict: r.review.verdict })));
  b.wf.findings = actionable;
  if (verdict === 'pass') return postReview(b);
  if (actionable.length === 0) return postReview(b);
  if (b.wf.counters.findings < findingsLimit(b)) {
    b.wf.counters.findings += 1;
    const lines = actionable.map((f) => `- [${f.severity}][${f.category}] ${f.message}${f.suggestion ? `｜建议：${f.suggestion}` : ''}${f.quote ? `（原文：${f.quote}）` : ''}`);
    const brief = `## 评审建议（优先级低于作者指令）\n\n以下建议仅供参考，与作者层冲突时一律以作者层为准。\n\n${lines.join('\n')}`;
    const followups = [chapterSpec(b, 'chapter.revise', { mode: 'findings', brief })];
    return chapterResult(b, 'revising', followups);
  }
  return exhausted(task, b, actionable);
}

function aggregateVerdict(b: ChapterCtx, reviews: { slot: string; verdict: Review['verdict'] }[]): 'pass' | 'revise' {
  const isRevise = (v: Review['verdict']) => v === 'revise' || v === 'block';
  if (b.wf.tier !== 'key') return isRevise(reviews[0]?.verdict ?? 'pass') ? 'revise' : 'pass';
  const arbiter = reviews.find((r) => r.slot === 'arbiter');
  if (arbiter) return isRevise(arbiter.verdict) ? 'revise' : 'pass';
  // key：continuity 要求修订 或 判官多数要求修订
  const continuity = reviews.find((r) => r.slot === 'continuity');
  const judgesRevise = reviews.filter((r) => r.slot.startsWith('judge') && isRevise(r.verdict)).length;
  if (continuity && isRevise(continuity.verdict)) return 'revise';
  return judgesRevise >= 2 ? 'revise' : 'pass';
}

function postReview(b: ChapterCtx): TaskResult {
  if (b.book.config.optin.deslop && b.wf.counters.deslop === 0) {
    const issues = b.wf.lastGates.filter((g) => !g.ok && g.level === 'soft' && g.rule === 'lexicon');
    if (issues.length > 0) {
      b.wf.counters.deslop += 1;
      return chapterResult(b, 'reviewing', [chapterSpec(b, 'chapter.deslop', { issues: issues.flatMap((g) => g.spans.map((s) => s.text ?? '')) })]);
    }
  }
  b.wf.verdict = 'pass';
  return chapterResult(b, 'accepting', [acceptStep(b)]);
}

function exhausted(task: TaskRow, b: ChapterCtx, findings: Finding[]): TaskResult {
  const hasHard = findings.some((f) => f.severity === 'hard');
  const col = b.wf.key ? 'key' : 'normal';
  const policy = b.book.config.policy.on_exhausted;
  const action = hasHard ? policy.craft_hard[col] : policy.soft_only[col];
  if (action === 'accept_with_debt') {
    for (const f of findings) b.wf.debts.push({ class: f.severity === 'hard' ? 'forward' : 'metric', rule: `review.${f.category}`, detail: f.message });
    b.wf.verdict = 'accept_with_debt';
    return chapterResult(b, 'accepting', [acceptStep(b)]);
  }
  if (action === 'hold') return holdResult(b, task, `章节 ${b.cid} 评审问题修订耗尽，待人工处理`, { findings });
  return blockResult(b, task, `章节 ${b.cid} 评审问题修订耗尽`, { findings });
}

// ───────── pairwise / deslop ─────────

async function finalizePairwise(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return missingCard(task);
  const c = await contractCheck(task, h);
  if (!c.ok) return contractFailure(task, h, c, task.maxAttempts, { no: b.no });
  const r = zPairwise.parse(c.report.files['pairwise.json']?.json);
  b.wf.counters.pairwise += 1;
  b.wf.pairwisePending = false;
  if (r.winner === 'a' && b.wf.prevDraft) {
    // 修订稿没有胜过原稿：恢复原稿与原 delta，按耗尽处理原 findings
    b.wf.draft = b.wf.prevDraft;
    b.wf.delta = b.wf.prevDelta ?? b.wf.delta;
    b.wf.prevDraft = null;
    return exhausted(task, b, b.wf.findings);
  }
  b.wf.prevDraft = null;
  b.wf.reviews = [];
  return chapterResult(b, 'reviewing', [reviewStep(b, reviewSlots(b.wf.tier)[0] ?? 'combined')]);
}

async function finalizeDeslop(ctx: PipelineContext, task: TaskRow, h: HarvestedRun): Promise<TaskResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return missingCard(task);
  const c = await contractCheck(task, h);
  if (!c.ok) return contractFailure(task, h, c, task.maxAttempts, { no: b.no });
  await patchStep(ctx, task, b, h);
  b.wf.verdict = 'pass';
  return chapterResult(b, 'accepting', [acceptStep(b)]);
}

// ───────── accept ─────────

async function finalChapterCheck(book: BookHandle, state: BookState, after: ReturnType<typeof applyDelta>, delta: Delta): Promise<string[]> {
  const issues: string[] = [];
  void delta;
  for (const o of Object.values(after.obligations)) {
    if (o.status === 'open' || o.status === 'advanced') issues.push(`伏笔 ${o.id}［${o.weight}］未收束：${o.text}`);
  }
  const compass = state.compass;
  if (compass) {
    for (const p of compass.ending.final_state) {
      const v = evaluatePredicate(p, after);
      if (v === false || v === 'unresolved') issues.push(`最终状态谓词未成立：${JSON.stringify(p)}`);
      else if (v === 'manual') issues.push(`需要 owner 签字：${JSON.stringify(p)}`);
    }
  }
  for (const arc of await book.files.characterArcs()) {
    const last = arc.stages[arc.stages.length - 1];
    if (last && after.entities[arc.who] && after.entities[arc.who]?.stage !== last.id) issues.push(`角色 ${arc.who} 未到达最终阶段（当前 ${after.entities[arc.who]?.stage ?? '无'}，应为 ${last.id}）`);
  }
  return issues;
}

async function executeAccept(ctx: PipelineContext, task: TaskRow): Promise<TaskResult> {
  const b = await chapterCtx(ctx, task);
  if (!b) return missingCard(task);
  const { book, no, cid, card, wf } = b;
  if (!wf.draft || !wf.delta) return { status: 'failed', errorClass: 'config', message: '缺少草稿或 delta' };
  if ((await book.repo.exists(P.ledger(no))) && (await book.repo.exists(P.manuscript(no)))) {
    // 账本已有本章：accept 只处理前沿章节（已验收章节的重写走 chapter.repair → reextract，由 cascade 处理下游）
    return { status: 'failed', errorClass: 'config', message: `章节 ${cid} 已验收，拒绝重复 accept` };
  }
  const ownerApproved = (task.params as { ownerApproved?: boolean }).ownerApproved === true;
  const [draftText, state] = await Promise.all([readRel(book, wf.draft.path), loadBookState(book.dir)]);
  const manuscript = stripBeatMarkers(draftText);
  let delta = await loadDelta(book, wf.delta);
  delta = { ...delta, chapter: cid, base_ledger_hash: ledgerHash(state.ledger, state.overrides) };
  // tmp id 在这里解析（Novelist-Snapshot-Hash 依赖最终 ledger 内容）
  const idCtx = await buildTmpIdContext(book.repo);
  const rawLedger = `${JSON.stringify(delta, null, 2)}\n`;
  const resolved = resolveTmpIds([{ path: P.ledger(no), content: rawLedger }], idCtx);
  const ledgerText = String(resolved.files[0]?.content ?? rawLedger);
  delta = zDelta.parse(JSON.parse(ledgerText));

  const after = applyDelta(state.snapshot, delta, { entities: state.entities.map((e) => e.entity) });
  if (card.is_final && !ownerApproved) {
    const issues = await finalChapterCheck(book, state, after, delta);
    if (issues.length > 0) {
      return holdResult(b, task, `最终章 ${cid} 的收束条件未全部满足`, { issues });
    }
  }

  const reviews = await Promise.all(wf.reviews.map(async (r) => ({ meta: r, review: zReview.parse(JSON.parse(await readRel(book, r.path))) })));
  const primary = reviews[reviews.length - 1]?.review;
  const debts = dedupeDebts(wf.debts);
  for (const g of wf.lastGates) if (!g.ok && g.level === 'soft') debts.push({ class: 'metric', rule: g.rule, detail: g.detail ?? '软指标未达标' });
  const review: Review = {
    schema: 'nv.review/1',
    chapter: cid,
    tier: wf.tier,
    verdict: wf.verdict === 'accept_with_debt' ? 'accept_with_debt' : 'pass',
    scores: primary?.scores ?? {},
    findings: wf.findings,
    missing_ops: reviews.flatMap((r) => r.review.missing_ops),
    continuity_flags: [],
    reviewers: wf.reviews.map((r) => ({ role: r.role, profile: r.profile, model: r.model, run: r.run })),
    degraded: wf.degraded,
    revisions: wf.counters.mech + wf.counters.canon + wf.counters.findings,
    gate_summary: wf.lastGates.map((g) => ({ rule: g.rule, level: g.level, ok: g.ok, ...(g.detail ? { detail: g.detail } : {}) })),
  };

  const files: { path: string; content: string }[] = [
    { path: P.manuscript(no), content: manuscript },
    { path: P.ledger(no), content: ledgerText },
    { path: P.review(no), content: `${JSON.stringify(review, null, 2)}\n` },
  ];
  // 标题采纳（receipt.title_proposal → 卡片）
  let cardOut: Card = card;
  if (wf.draft.titleProposal && wf.draft.titleProposal !== card.title) cardOut = { ...cardOut, title: wf.draft.titleProposal };
  if (cardOut !== card) files.push({ path: P.card(no), content: yamlStringify(cardOut, { lineWidth: 0 }) });
  if (debts.length) {
    const now = ctx.deps.now().toISOString();
    const lines = debts.map((d, i) => JSON.stringify(zDebt.parse({ schema: 'nv.debt/1', id: `D-${cid}-${i + 1}`, ts: now, chapter: cid, class: d.class, rule: d.rule, detail: d.detail, status: 'open' } satisfies Debt)));
    const existing = (await book.repo.readFile(P.debt)) ?? '';
    files.push({ path: P.debt, content: `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n` });
  }

  // stale 标记（§6.2）：投影校验全部缓冲卡 + 计划外 op 触及的未来卡
  const buffer = await book.files.cards(no + 1, no + 200);
  const stale = await staleCards(card, delta, after, state, buffer);
  for (const id of Object.keys(stale)) {
    const c = buffer.find((x) => x.id === id);
    if (!c || c.stale) continue;
    files.push({ path: P.card(chapterNo(id)), content: yamlStringify({ ...c, stale: true }, { lineWidth: 0 }) });
  }

  const followups: TaskSpec[] = [];
  if (Object.keys(stale).length) {
    followups.push({ kind: 'card.repair', bookId: book.id, target: Object.keys(stale).sort()[0] as string, params: { cards: Object.keys(stale).sort(), reasons: stale } });
  }

  const cjk = countCjk(manuscript, 'han');
  const snapshotHash = ledgerHash([...state.ledger, delta], state.overrides);
  const verdict = review.verdict;
  const revisions = review.revisions;
  const openDebts = debts.filter((d) => d.class === 'forward').length;
  const writerModel = wf.draft.model ?? null;
  const degraded = wf.degraded.length > 0;
  const isFinal = card.is_final;
  const nowIso = ctx.deps.now().toISOString();
  return {
    status: 'done',
    summary: { cjk, verdict, revisions, debts: openDebts, stale: Object.keys(stale) },
    followups,
    promote: {
      bookId: book.id,
      taskId: task.id,
      runId: null,
      baseCommit: await book.repo.head(),
      files,
      resolveTmpIds: false,
      message: `chapter: accept ${cid}「${cardOut.title}」`,
      trailers: { [TRAILER.snapshotHash]: snapshotHash },
      tags: [gitTags.chapter(no)],
      effect: { name: 'chapter.accept', args: { bookId: book.id, no, cid, title: cardOut.title, volume: card.volume, arc: card.arc, cjk, nowIso, verdict, revisions, degraded, debts: openDebts, writerModel, isFinal, seq: wf.seq } },
    },
  };
}

function dedupeDebts(debts: ChapterWorkflow['debts']): ChapterWorkflow['debts'] {
  const seen = new Set<string>();
  return debts.filter((d) => {
    const k = `${d.class}|${d.rule}|${d.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function staleCards(card: Card, delta: Delta, after: ReturnType<typeof applyDelta>, state: BookState, buffer: Card[]): Promise<Record<string, string[]>> {
  const reasons: Record<string, string[]> = {};
  if (buffer.length === 0) return reasons;
  for (const s of projectBuffer(after, buffer, { entities: state.entities.map((e) => e.entity) }).stale) reasons[s.card] = [...s.reasons];
  // 计划外的 op（不匹配本卡 post 的）
  const unplanned: Delta = { ...delta, ops: delta.ops.filter((op) => !card.post.some((p) => isPattern(p) && opMatches(p, op))) };
  for (const id of cardsTouchedBy(unplanned, buffer)) {
    reasons[id] = [...(reasons[id] ?? []), '计划外 op 触及本卡依赖'];
  }
  return reasons;
}

function isPattern(c: Card['post'][number]): c is Extract<Card['post'][number], { op: string }> {
  return typeof (c as { op?: unknown }).op === 'string';
}

// ───────── handlers ─────────

export const chapterWrite: TaskHandler = {
  kind: 'chapter.write',
  role: 'writer',
  lane: 'write',
  maxAttempts: 6,
  manifest: chapterManifest,
  prepare: prepareWrite,
  finalize: finalizeWriter,
};

const revisionHandler = (kind: 'chapter.revise' | 'chapter.expand' | 'chapter.compress'): TaskHandler => ({
  kind,
  role: 'writer',
  lane: 'write',
  maxAttempts: 6,
  manifest: chapterManifest,
  prepare: (ctx, task, run) => prepareRevision(ctx, task, run, kind),
  finalize: finalizeWriter,
});
export const chapterRevise = revisionHandler('chapter.revise');
export const chapterExpand = revisionHandler('chapter.expand');
export const chapterCompress = revisionHandler('chapter.compress');

export const chapterExtract: TaskHandler = {
  kind: 'chapter.extract',
  role: 'extractor',
  lane: 'write',
  maxAttempts: 4,
  manifest: chapterManifest,
  prepare: (ctx, task, run) => prepareExtract(ctx, task, run, 'chapter.extract'),
  finalize: finalizeExtraction,
};

export const chapterCheck: TaskHandler = {
  kind: 'chapter.check',
  role: 'checker',
  lane: 'write',
  maxAttempts: 4,
  manifest: chapterManifest,
  prepare: (ctx, task, run) => prepareExtract(ctx, task, run, 'chapter.check'),
  finalize: finalizeExtraction,
};

export const formatRepair: TaskHandler = {
  kind: 'format.repair',
  role: 'format_checker',
  lane: 'write',
  maxAttempts: 2,
  manifest: chapterManifest,
  async prepare(ctx, task, run) {
    const b = await chapterCtx(ctx, task);
    if (!b) return { kind: 'skip', result: missingCard(task) };
    const params = task.params as { raw?: string; source?: string; errors?: string };
    if (!params.raw) return { kind: 'skip', result: { status: 'failed', message: '缺少原始输出路径' } };
    const isCheck = params.source === 'chapter.check';
    const target = isCheck ? 'check.json' : 'delta.json';
    const art: ArtifactDecl = isCheck ? { path: target, kind: 'check', schema: 'nv.check/1', required: true } : { path: target, kind: 'delta', schema: 'nv.delta/1', required: true };
    const rawPath = inputPath(run, 'inputs/raw.json');
    const body = await renderTemplate('format.repair', {
      cid: b.cid,
      schema_name: isCheck ? 'nv.check/1' : 'nv.delta/1',
      target_file: path.join(run.outDir, target),
      raw_path: rawPath,
      errors: params.errors ?? '',
      json_schema: JSON.stringify(toJsonSchema(isCheck ? zCheckOutput : zDelta), null, 1),
      output: outputBlock([art], run.outDir),
      retry: retryHint(task),
    });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(b.book, task, run, [art], [{ path: rawPath, kind: 'raw' }]), body, inputs: [{ from: path.join(b.book.dir, params.raw), to: 'inputs/raw.json' }], ownerNotes: [] } };
  },
  finalize: finalizeRepair,
};

export const chapterConfirm: TaskHandler = {
  kind: 'chapter.confirm',
  role: 'confirm',
  lane: 'write',
  maxAttempts: 2,
  manifest: chapterManifest,
  async prepare(ctx, task, run) {
    const b = await chapterCtx(ctx, task);
    if (!b) return { kind: 'skip', result: missingCard(task) };
    if (!b.wf.draft || !b.wf.pending) return { kind: 'skip', result: { status: 'failed', message: '缺少 pending delta' } };
    const { input, path: draftPath } = await draftInput(b, run, b.wf.draft);
    const art: ArtifactDecl = { path: 'confirm.json', kind: 'json', required: true };
    const questions = b.wf.pending.questions.map((q) => `- ${q.id}：${q.text}`).join('\n');
    const body = await renderTemplate('chapter.confirm', { cid: b.cid, draft_path: draftPath, questions, op_reference: OP_REFERENCE, output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(b.book, task, run, [art], [{ path: draftPath, kind: 'draft' }]), body, inputs: [input], ownerNotes: collectOwnerNotes(b.card, task) } };
  },
  finalize: finalizeConfirm,
};

export const chapterReview: TaskHandler = {
  kind: 'chapter.review',
  role: 'reviewer',
  lane: 'write',
  maxAttempts: 4,
  manifest: chapterManifest,
  prepare: prepareReview,
  finalize: finalizeReview,
};

export const chapterPairwise: TaskHandler = {
  kind: 'chapter.pairwise',
  role: 'judge',
  lane: 'write',
  maxAttempts: 4,
  manifest: chapterManifest,
  async prepare(ctx, task, run) {
    const b = await chapterCtx(ctx, task);
    if (!b) return { kind: 'skip', result: missingCard(task) };
    if (!b.wf.draft || !b.wf.prevDraft) return { kind: 'skip', result: { status: 'failed', message: '缺少对比稿' } };
    const a = inputPath(run, 'inputs/draft-a.md');
    const bp = inputPath(run, 'inputs/draft-b.md');
    const art: ArtifactDecl = { path: 'pairwise.json', kind: 'pairwise', schema: 'nv.pairwise/1', required: true };
    const body = await renderTemplate('chapter.pairwise', { cid: b.cid, draft_a: a, draft_b: bp, output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return {
      kind: 'run',
      plan: {
        frontmatter: frontmatterFor(b.book, task, run, [art], [{ path: a, kind: 'draft', description: 'A' }, { path: bp, kind: 'draft', description: 'B' }]),
        body,
        inputs: [{ from: path.join(b.book.dir, b.wf.prevDraft.path), to: 'inputs/draft-a.md' }, { from: path.join(b.book.dir, b.wf.draft.path), to: 'inputs/draft-b.md' }],
        ownerNotes: collectOwnerNotes(b.card, task),
      },
    };
  },
  finalize: finalizePairwise,
};

export const chapterDeslop: TaskHandler = {
  kind: 'chapter.deslop',
  role: 'stylist',
  lane: 'write',
  maxAttempts: 2,
  manifest: chapterManifest,
  async prepare(ctx, task, run) {
    const b = await chapterCtx(ctx, task);
    if (!b) return { kind: 'skip', result: missingCard(task) };
    if (!b.wf.draft) return { kind: 'skip', result: { status: 'failed', message: '缺少草稿' } };
    const { input, path: draftPath } = await draftInput(b, run, b.wf.draft);
    const art: ArtifactDecl = { path: 'patches.json', kind: 'patches', schema: 'nv.patches/1', required: true };
    const issues = ((task.params as { issues?: string[] }).issues ?? []).map((s) => `- ${s}`).join('\n') || '（无）';
    const body = await renderTemplate('chapter.deslop', { cid: b.cid, draft_path: draftPath, issues, output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(b.book, task, run, [art], [{ path: draftPath, kind: 'draft' }]), body, inputs: [input], ownerNotes: collectOwnerNotes(b.card, task) } };
  },
  finalize: finalizeDeslop,
};

export const chapterAccept: TaskHandler = {
  kind: 'chapter.accept',
  role: null,
  lane: 'write',
  maxAttempts: 3,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: chapterHardDeps(chapterNo(spec.target)) }),
  execute: executeAccept,
};

export const chapterIngest: TaskHandler = {
  kind: 'chapter.ingest',
  role: null,
  lane: 'write',
  maxAttempts: 3,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.manuscript(chapterNo(spec.target))] }),
  // 导入/手工录入一章：params { text, title?, delta? }；不走模型，直接落正文和账本（import.bootstrap 再补账本时 delta 可省）
  async execute(ctx, task) {
    const book = requireBook(ctx);
    const no = chapterNo(task.target);
    const params = task.params as { text?: string; title?: string; delta?: unknown };
    if (!params.text) return { status: 'failed', errorClass: 'config', message: 'chapter.ingest 缺少 text' };
    const files: { path: string; content: string }[] = [{ path: P.manuscript(no), content: stripBeatMarkers(params.text) }];
    if (params.delta) files.push({ path: P.ledger(no), content: `${JSON.stringify(zDelta.parse(params.delta), null, 2)}\n` });
    const cjk = countCjk(params.text, 'han');
    const nowIso = ctx.deps.now().toISOString();
    const title = params.title ?? `第${no}章`;
    return {
      status: 'done',
      promote: {
        bookId: book.id,
        taskId: task.id,
        runId: null,
        baseCommit: await book.repo.head(),
        files,
        resolveTmpIds: false,
        message: `chapter: ingest ${task.target}`,
        trailers: {},
        tags: [gitTags.chapter(no)],
        effect: { name: 'chapter.ingest', args: { bookId: book.id, no, cid: task.target, title, cjk, nowIso } },
      },
    };
  },
};

// ───────── reextract / repair（级联，§6.10）─────────

async function reextractState(ctx: PipelineContext, task: TaskRow) {
  const book = requireBook(ctx);
  const no = chapterNo(task.target);
  const card = await book.files.card(no);
  const manuscript = (task.params as { draftPath?: string }).draftPath;
  return { book, no, card, manuscript };
}

async function foldBefore(state: BookState, no: number) {
  const fold = incrementalFoldUpTo({ entities: state.entities.map((e) => e.entity), world: state.world, overrides: state.overrides });
  return fold(no - 1, state.ledger);
}

/**
 * chapter.reextract（diff）：owner 手改正文或 chapter.repair 之后，抽取新 delta，用它替换账本第 k 章，
 * 从 k+1 起按序重放 delta.check（纯确定性）。冲突章节：未发布的标 needs_repair + chapter.repair（链长 ≤3）；
 * 已发布的只生成 override（§6.10 第 4 条：已发布正文绝不自动修改；冲突链超过 3 → 只写 override）。
 */
export const chapterReextract: TaskHandler = {
  kind: 'chapter.reextract',
  role: 'extractor',
  lane: 'write',
  maxAttempts: 4,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.manuscript(chapterNo(spec.target)), P.ledger(chapterNo(spec.target))], extra: { from: spec.params?.draftPath ?? null } }),
  async prepare(ctx, task, run) {
    const { book, no, card, manuscript } = await reextractState(ctx, task);
    if (!card) return { kind: 'skip', result: missingCard(task) };
    const state = await loadRunState(run);
    const snapshotBefore = await foldBefore(state, no);
    const slice = await buildCheckSlice({ bookDir: run.snapshotDir, card, snapshot: snapshotBefore, state });
    const from = manuscript ? path.join(book.dir, manuscript) : path.join(book.dir, P.manuscript(no));
    const draftPath = inputPath(run, 'inputs/draft.md');
    const inputs = [{ from, to: 'inputs/draft.md' }];
    const basePath = inputPath(run, 'inputs/base.delta.json');
    const fm: AgentPlan['frontmatter']['inputs'] = [{ path: draftPath, kind: 'draft' }];
    if (await book.repo.exists(P.ledger(no))) {
      inputs.push({ from: path.join(book.dir, P.ledger(no)), to: 'inputs/base.delta.json' });
      fm.push({ path: basePath, kind: 'delta' });
    }
    const art: ArtifactDecl = { path: 'delta.json', kind: 'delta', schema: 'nv.delta/1', required: true };
    const body = await renderTemplate('chapter.reextract', { cid: task.target, draft_path: draftPath, base_delta_path: basePath, check_slice: slice, op_reference: OP_REFERENCE, output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art], fm), body, inputs, ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const { book, no, card, manuscript } = await reextractState(ctx, task);
    if (!card) return missingCard(task);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const delta = zDelta.parse(c.report.files['delta.json']?.json);
    const state = await loadBookState(book.dir);
    const draftText = manuscript ? await readRel(book, manuscript) : ((await book.repo.readFile(P.manuscript(no))) ?? '');
    const before = await foldBefore(state, no);
    const beforeState: BookState = { ...state, snapshot: before };
    const report = runDeltaCheck(book, beforeState, card, delta, draftText, [], false);
    if (report.hard.some((f) => report.attribution[f.id] !== 'writer') && !report.ok) return { status: 'retry', errorClass: 'output_contract', message: `delta.check 未通过：${report.hard.map((f) => f.message).join('；')}` };
    const newDelta = { ...report.delta, chapter: task.target };
    const foldUpTo = incrementalFoldUpTo({ entities: state.entities.map((e) => e.entity), world: state.world, overrides: state.overrides });
    const result = cascadeReplay({
      replaceAt: no,
      newDelta,
      ledger: state.ledger,
      check: (d, snap) => replayCheck(d, snap),
      foldUpTo,
    });
    const files: { path: string; content: string }[] = [{ path: P.ledger(no), content: `${JSON.stringify(newDelta, null, 2)}\n` }];
    if (manuscript) files.push({ path: P.manuscript(no), content: stripBeatMarkers(draftText) });
    const followups: TaskSpec[] = [];
    const inbox: InboxInput[] = [];
    const chapterRows = await Promise.all(result.conflicts.map(async (x) => ({ x, row: await getChapterRow(ctx.deps.db, book.id, x.no) })));
    const needRepair: number[] = [];
    if (result.conflicts.length > 3) {
      // 冲突链过长：不自动修改下游章节，全部转为 override（由 owner 在 Inbox 决定）
      inbox.push({ kind: 'notice', bookId: book.id, title: `修订引发 ${result.conflicts.length} 章下游冲突，请人工处理`, body: { chapter: task.target, conflicts: result.conflicts }, actions: [{ id: 'ok', label: '知道了' }], dedupeKey: `cascade:${task.target}`, relatedTaskId: task.id });
    } else {
      for (const { x, row } of chapterRows) {
        if (row?.publishedAt) {
          inbox.push({ kind: 'notice', bookId: book.id, title: `已发布章节 ${chapterId(x.no)} 与修订冲突，需要补 override`, body: { chapter: chapterId(x.no), reasons: x.reasons }, actions: [{ id: 'ok', label: '知道了' }], dedupeKey: `cascade:${x.no}` });
        } else {
          needRepair.push(x.no);
          followups.push({ kind: 'chapter.repair', bookId: book.id, target: chapterId(x.no), params: { conflicts: x.reasons, instance: `${task.target}-${task.id.slice(0, 8)}` } });
        }
      }
    }
    const newCjk = manuscript ? countCjk(stripBeatMarkers(draftText), 'han') : null;
    const nowIso = ctx.deps.now().toISOString();
    return {
      status: 'done',
      followups,
      inbox,
      summary: { noop: result.noop, conflicts: result.conflicts.length, affected: result.affected },
      promote: {
        bookId: book.id,
        taskId: task.id,
        runId: h.run.runId,
        baseCommit: h.run.baseCommit,
        files,
        resolveTmpIds: true,
        message: `chapter: reextract ${task.target}`,
        trailers: {},
        tags: [],
        effect: { name: 'chapter.reextract', args: { bookId: book.id, no, needRepair, cjk: newCjk, nowIso } },
      },
    };
  },
};

/** 级联重放用的 delta.check：只看账本一致性（不需要原文） */
function replayCheck(d: Delta, snap: ReturnType<typeof applyDelta>): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const op of d.ops) {
    if (op.op === 'entity.update') {
      const ent = snap.entities[op.ent];
      if (!ent) reasons.push(`未知实体 ${op.ent}`);
      else if (!ent.alive) reasons.push(`实体 ${op.ent} 已退场，仍被更新`);
      else if (op.from) {
        for (const [k, v] of Object.entries(op.from)) {
          if (['loc', 'owner', 'status', 'title', 'realm'].includes(k) && JSON.stringify(ent.attrs[k] ?? null) !== JSON.stringify(v ?? null)) reasons.push(`${op.ent}.${k} 账本为 ${JSON.stringify(ent.attrs[k] ?? null)}，下游声明 from=${JSON.stringify(v)}`);
        }
      }
    }
    if (op.op === 'entity.retire' && !snap.entities[op.ent]?.alive) reasons.push(`实体 ${op.ent} 重复退场`);
    if (op.op === 'obligation.pay') {
      const o = snap.obligations[op.id];
      if (!o) reasons.push(`伏笔 ${op.id} 不存在`);
      else if (o.status === 'paid' || o.status === 'abandoned') reasons.push(`伏笔 ${op.id} 已收束`);
    }
    if (op.op === 'item.transfer' && op.from !== undefined && (snap.items[op.item]?.holder ?? null) !== (op.from ?? null)) reasons.push(`物品 ${op.item} 持有者为 ${snap.items[op.item]?.holder ?? '无'}，下游声明 from=${op.from ?? '无'}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export const chapterRepair: TaskHandler = {
  kind: 'chapter.repair',
  role: 'writer',
  lane: 'side',
  maxAttempts: 4,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.manuscript(chapterNo(spec.target)), P.ledger(chapterNo(spec.target))], soft: [P.summaryBook] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const no = chapterNo(task.target);
    const row = await getChapterRow(ctx.deps.db, book.id, no);
    // owner 明确发起且已通过 freeze_on_publish 检查时才允许改已发布章节
    if (row?.publishedAt && (task.params as { allowPublished?: boolean }).allowPublished !== true) return { kind: 'skip', result: { status: 'done', message: '已发布章节不自动修改' } };
    const state = await loadRunState(run);
    const card = await state.files.card(no);
    if (!card) return { kind: 'skip', result: missingCard(task) };
    const params = task.params as { conflicts?: string[] };
    const art = draftArtifact(task.target, book, card);
    const body = await renderTemplate('chapter.repair', {
      cid: task.target,
      draft_path: inputPath(run, 'inputs/draft.md'),
      revision_brief: (params.conflicts ?? []).map((s) => `- ${s}`).join('\n'),
      output: outputBlock([art], run.outDir),
      retry: retryHint(task),
      context: (await buildContextPack({ bookDir: run.snapshotDir, card, snapshot: await foldBefore(state, no), state, lexicon: await effectiveLexicon(ctx, book), sampleSeed: task.target })).text,
    });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art], [{ path: inputPath(run, 'inputs/draft.md'), kind: 'draft' }]), body, inputs: [{ from: path.join(book.dir, P.manuscript(no)), to: 'inputs/draft.md' }], ownerNotes: collectOwnerNotes(card, task) } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const draftRel = relFromOut(book, h, `manuscript/${task.target}.md`);
    return {
      status: 'done',
      followups: [{ kind: 'chapter.reextract', bookId: book.id, target: task.target, lane: 'side', params: { draftPath: draftRel, instance: task.id.slice(0, 12) } }],
    };
  },
};
