/**
 * 规划任务（DESIGN §6.0–§6.2、§6.11、附录 B 第 1–2 行）。Owner: lane E。
 * hard deps：compass、目标区间的卡片、被引用的实体、owner 编辑过的路径；soft：ledger、摘要、patterns。lane=side，重试 6（card.repair 4）。
 * 产物写 out/ 下与书库同构的相对路径（如 out/plan/arcs/a0012.yaml、out/plan/cards/c00421.yaml），committer 映射 tmp id 后提交。
 * 审批门：plan.compass、plan.volume(v01) 完成后进 Inbox approval（book.yaml approvals），批准前不派发后续。
 * 产物校验：schema 由契约 gate 负责；语义走 validatePlan + 本文件的连续性/收束校验。
 */
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { ArtifactDecl, Arc, Card, Compass, Finding, Volume } from '@novelist/shared';
import { chapterId, chapterNo, zArc, zCard, zCompass, zPlanChange, zVolume } from '@novelist/shared';
import { P } from '../../book/index.js';
import { ledgerHash, loadBookState, projectBuffer } from '../../state/index.js';
import type { BookState } from '../../state/index.js';
import { validatePlan } from '../../validators/index.js';
import { approvalInbox, buildManifest, collectOwnerNotes, contractCheck, contractFailure, frontmatterFor, lengthFor, loadRunState, outputBlock, questionsInbox, requireBook, retryHint } from '../common.js';
import type { BookHandle, HarvestedRun, InboxInput, PipelineContext, PrepareResult, PromotePlan, RunContext, TaskHandler, TaskResult, TaskRow, TaskSpec } from '../types.js';
import type { DbEffect } from '../effects.js';
import { renderTemplate } from '../workorder.js';
import { PREDICATE_REFERENCE, stateBrief } from './shared.js';

const PLAN_CHANGES = P.changes;
const SOFT_DEPS = [P.summaryBook];

export function totalChapters(book: BookHandle): number {
  const len = book.config.scale.chapter_length?.target ?? book.genre.pacing.chapter_length.target;
  return Math.max(1, Math.ceil(book.config.scale.target_cjk / len));
}

function softDeps(state: Pick<BookState, 'ledger'>): string[] {
  return state.ledger.length ? [...SOFT_DEPS, P.ledger(state.ledger.length)] : SOFT_DEPS;
}

function rel(file: string): string {
  return file.replace(/\\/g, '/');
}

// ───────── 工作单 ─────────

async function planWorkOrder(ctx: PipelineContext, task: TaskRow, run: RunContext, artifacts: ArtifactDecl[], template: string, vars: Record<string, string>): Promise<PrepareResult> {
  const book = requireBook(ctx);
  const body = await renderTemplate(template, { ...vars, output: outputBlock(artifacts, run.outDir), retry: retryHint(task), predicates: PREDICATE_REFERENCE });
  return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, artifacts), body, inputs: [], ownerNotes: collectOwnerNotes(null, task) } };
}

const scaleText = (book: BookHandle): string => {
  const s = book.config.scale;
  return `目标 ${s.target_cjk} 字（上限 ${s.hard_max_cjk}），${s.volumes[0]}–${s.volumes[1]} 卷，每卷 ${s.chapters_per_volume[0]}–${s.chapters_per_volume[1]} 章，单章 ${lengthFor(book, null).target} 字左右`;
};

const compassBrief = (c: Compass | null): string => {
  if (!c) return '（尚无 compass）';
  return [`logline：${c.logline}`, `结局方向：${c.ending.direction}`, `必须回收：${c.ending.required_closures.join('、') || '（无）'}`, `主题：${c.themes.join('、')}`].join('\n');
};

// ───────── 收尾、提交 ─────────

async function changeLog(book: BookHandle, ctx: PipelineContext, task: TaskRow, paths: string[], kind: 'create' | 'update' | 'repair' | 'revalidate', summary: string): Promise<{ path: string; content: string }> {
  const existing = (await book.repo.readFile(PLAN_CHANGES)) ?? '';
  const entry = zPlanChange.parse({ schema: 'nv.change/1', ts: ctx.deps.now().toISOString(), task: task.id, kind, paths, summary });
  return { path: PLAN_CHANGES, content: `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${JSON.stringify(entry)}\n` };
}

function promotePlan(book: BookHandle, task: TaskRow, h: HarvestedRun, files: { path: string; content: string }[], message: string, effect?: DbEffect): PromotePlan {
  return { bookId: book.id, taskId: task.id, runId: h.run.runId, baseCommit: h.run.baseCommit, files, resolveTmpIds: true, message, trailers: {}, tags: [], ...(effect ? { effect } : {}) };
}

function outFiles(c: { report: { files: Record<string, { text: string }> } }): { path: string; content: string }[] {
  return Object.entries(c.report.files)
    .filter(([p]) => p !== 'receipt.json')
    .map(([p, f]) => ({ path: rel(p), content: f.text }));
}

function planValidationFailure(task: TaskRow, h: HarvestedRun, hard: Finding[], maxAttempts: number): TaskResult {
  const message = `规划校验未通过：${hard.map((f) => f.message).join('；')}`;
  if (h.run.attempt >= maxAttempts) {
    return {
      status: 'blocked',
      errorClass: 'output_contract',
      message,
      inbox: [{ kind: 'block', bookId: task.bookId, title: `规划校验重试耗尽：${task.kind} ${task.target}`, body: { hard }, actions: [{ id: 'retry', label: '重试' }], dedupeKey: `block:${task.kind}:${task.target}`, relatedTaskId: task.id }],
    };
  }
  return { status: 'retry', errorClass: 'output_contract', message };
}

async function basicFinalize(ctx: PipelineContext, task: TaskRow, h: HarvestedRun, opts: { message: string; changeKind: 'create' | 'update' }): Promise<TaskResult> {
  const book = requireBook(ctx);
  const c = await contractCheck(task, h);
  if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
  const files = outFiles(c);
  files.push(await changeLog(book, ctx, task, files.map((f) => f.path), opts.changeKind, opts.message));
  return { status: 'done', promote: promotePlan(book, task, h, files, opts.message), inbox: questionsInbox(task, c) };
}

// ───────── 各 kind ─────────

export const planInterview: TaskHandler = {
  kind: 'plan.interview',
  role: 'planner',
  lane: 'side',
  maxAttempts: 6,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.premise] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const art: ArtifactDecl = { path: 'interview.json', kind: 'json', required: true, description: '问题列表（≤12 条）' };
    return planWorkOrder(ctx, task, run, [art], 'plan.interview', { premise: await book.files.premise() });
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const json = c.report.files['interview.json']?.json as { questions?: { id: string; text: string; why?: string }[] } | undefined;
    const questions = (json?.questions ?? []).slice(0, 12);
    if (questions.length === 0) return { status: 'retry', errorClass: 'output_contract', message: 'interview.json 没有问题' };
    return {
      status: 'done',
      summary: { questions: questions.length },
      inbox: [
        {
          kind: 'question',
          bookId: book.id,
          title: '开书访谈：请回答以下问题',
          body: { questions, stage: 'plan.interview', on: { answer: { task: 'none', followups: [{ kind: 'plan.premise', bookId: book.id, target: 'book', params: { instance: `interview-${task.id.slice(0, 10)}`, interviewAnswers: true } }] } } },
          actions: [{ id: 'answer', label: '提交答案', needsNote: true }, { id: 'skip', label: '跳过访谈' }],
          dedupeKey: `interview:${book.id}`,
          relatedTaskId: task.id,
        },
      ],
    };
  },
};

export const planPremise: TaskHandler = {
  kind: 'plan.premise',
  role: 'planner',
  lane: 'side',
  maxAttempts: 6,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.premise] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const art: ArtifactDecl = { path: P.premise, kind: 'markdown', required: true, description: 'premise 文档' };
    return planWorkOrder(ctx, task, run, [art], 'plan.premise', { title: book.config.title, genre: book.genre.pack.name, scale: scaleText(book), premise: await book.files.premise() });
  },
  async finalize(ctx, task, h) {
    const result = await basicFinalize(ctx, task, h, { message: 'plan: premise', changeKind: 'update' });
    const params = task.params as { interviewAnswers?: boolean; ownerNotes?: unknown };
    const answers = Array.isArray(params.ownerNotes) ? params.ownerNotes.filter((n): n is string => typeof n === 'string' && n.trim() !== '') : [];
    if (result.promote && params.interviewAnswers && answers.length) {
      const appendix = `\n\n## 开书访谈答案（owner）\n\n${answers.join('\n\n')}\n`;
      result.promote.files = result.promote.files.map((f) => (f.path === P.premise ? { ...f, content: `${String(f.content).trimEnd()}${appendix}` } : f));
    }
    return result;
  },
};

export const planCompass: TaskHandler = {
  kind: 'plan.compass',
  role: 'planner',
  lane: 'side',
  maxAttempts: 6,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.premise, P.compass] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const art: ArtifactDecl = { path: P.compass, kind: 'plan_yaml', schema: 'nv.compass/1', required: true };
    return planWorkOrder(ctx, task, run, [art], 'plan.compass', { premise: await book.files.premise(), scale: scaleText(book) });
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const compass = zCompass.safeParse(yamlParse(c.report.files[P.compass]?.text ?? ''));
    if (!compass.success) return { status: 'retry', errorClass: 'output_contract', message: `compass 不合法：${compass.error.issues[0]?.message ?? ''}` };
    // 规划校验（谓词语法等）
    const state = await loadBookState(book.dir);
    const v = validatePlan({ compass: compass.data, volumes: [], arcs: [], cards: [], snapshot: state.snapshot, fingerprints: [], changed: [P.compass] });
    if (!v.ok) return planValidationFailure(task, h, v.hard, task.maxAttempts);
    const files = outFiles(c);
    files.push(await changeLog(book, ctx, task, [P.compass], 'create', 'plan: compass'));
    const gate = book.config.approvals.compass;
    const inbox: InboxInput[] = [...questionsInbox(task, c)];
    if (gate.required) inbox.push(approvalInbox(book, 'approval', `approval:compass:${book.id}`, '全书罗盘待批准', { kind: 'plan.compass', stage: 'compass', path: P.compass }, gate, ctx.deps.now(), task.id, { kind: 'plan.compass', target: 'book' }));
    return { status: 'done', promote: promotePlan(book, task, h, files, 'plan: compass'), inbox };
  },
};

export const planBible: TaskHandler = {
  kind: 'plan.bible',
  role: 'planner',
  lane: 'side',
  maxAttempts: 6,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.compass, P.premise] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const compass = await book.files.compass();
    const artifacts: ArtifactDecl[] = [
      { path: P.worldRules, kind: 'plan_yaml', schema: 'nv.world/1', required: true },
      { path: P.glossary, kind: 'plan_yaml', schema: 'nv.glossary/1', required: false },
      { path: 'bible/entities/characters/*.md', kind: 'bible_md', schema: 'nv.entity/1', required: true, min: 1 },
      { path: 'bible/entities/locations/*.md', kind: 'bible_md', schema: 'nv.entity/1', required: false, min: 0 },
      { path: 'bible/entities/factions/*.md', kind: 'bible_md', schema: 'nv.entity/1', required: false, min: 0 },
      { path: 'bible/entities/items/*.md', kind: 'bible_md', schema: 'nv.entity/1', required: false, min: 0 },
      { path: 'bible/entities/concepts/*.md', kind: 'bible_md', schema: 'nv.entity/1', required: false, min: 0 },
      { path: 'bible/secrets/*.md', kind: 'bible_md', schema: 'nv.secret/1', required: false, min: 0 },
      { path: 'plan/character-arcs/*.yaml', kind: 'plan_yaml', schema: 'nv.charc/1', required: false, min: 0 },
      { path: P.strands, kind: 'plan_yaml', schema: 'nv.strands/1', required: false },
      { path: P.obligations, kind: 'plan_yaml', schema: 'nv.oblig/1', required: false },
    ];
    return planWorkOrder(ctx, task, run, artifacts, 'plan.bible', { premise: await book.files.premise(), compass: yamlStringify(compass ?? {}, { lineWidth: 0 }) });
  },
  finalize: (ctx, task, h) => basicFinalize(ctx, task, h, { message: 'plan: bible', changeKind: 'create' }),
};

export const planVolumes: TaskHandler = {
  kind: 'plan.volumes',
  role: 'planner',
  lane: 'side',
  maxAttempts: 6,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.compass] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const compass = await book.files.compass();
    const [min, max] = book.config.scale.volumes;
    const art: ArtifactDecl = { path: 'plan/volumes/v*.yaml', kind: 'plan_yaml', schema: 'nv.volume/1', required: true, min, max };
    return planWorkOrder(ctx, task, run, [art], 'plan.volumes', { compass: yamlStringify(compass ?? {}, { lineWidth: 0 }), volumes_range: `${min}–${max}` });
  },
  finalize: (ctx, task, h) => basicFinalize(ctx, task, h, { message: 'plan: volumes', changeKind: 'create' }),
};

export const planVolume: TaskHandler = {
  kind: 'plan.volume',
  role: 'planner',
  lane: 'side',
  maxAttempts: 6,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.compass, P.volume(spec.target)], soft: [P.summaryBook, P.obligations] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const volumeYaml = await book.repo.readFile(P.volume(task.target));
    if (!volumeYaml) return { kind: 'skip', result: { status: 'failed', errorClass: 'config', message: `缺少卷骨架 ${task.target}` } };
    const artifacts: ArtifactDecl[] = [
      { path: P.volume(task.target), kind: 'plan_yaml', schema: 'nv.volume/1', required: true },
      { path: 'plan/arcs/a*.yaml', kind: 'plan_yaml', schema: 'nv.arc/1', required: false, min: 0 },
      { path: P.obligations, kind: 'plan_yaml', schema: 'nv.oblig/1', required: false },
    ];
    const compass = await book.files.compass();
    const index = state.volumes.map((v) => `- ${v.id} ${v.title}（${v.detail}）：${v.goal}`).join('\n');
    return planWorkOrder(ctx, task, run, artifacts, 'plan.volume', { volume: task.target, compass: yamlStringify(compass ?? {}, { lineWidth: 0 }), volume_yaml: volumeYaml, volumes_index: index });
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const state = await loadBookState(book.dir);
    const parsedVolume = zVolume.parse(yamlParse(c.report.files[P.volume(task.target)]?.text ?? ''));
    const volume: Volume = { ...parsedVolume, id: task.target, detail: 'detailed' };
    const arcs = Object.entries(c.report.files)
      .filter(([p]) => /^plan\/arcs\/a\d+\.yaml$/.test(p) && !overwritesDetailedArc(p, state.arcs))
      .map(([, f]) => zArc.parse(yamlParse(f.text)));
    const v = validatePlan({ compass: state.compass, volumes: mergeById(state.volumes, [volume]), arcs: mergeById(state.arcs, arcs), cards: [], snapshot: state.snapshot, fingerprints: [], changed: [P.volume(task.target)] });
    if (!v.ok) return planValidationFailure(task, h, v.hard, task.maxAttempts);
    const files = outFiles(c).filter((f) => f.path !== P.volume(task.target) && !overwritesDetailedArc(f.path, state.arcs));
    files.push({ path: P.volume(task.target), content: yamlStringify(volume, { lineWidth: 0 }) });
    files.push(await changeLog(book, ctx, task, files.map((f) => f.path), 'update', `plan: volume ${task.target}`));
    const inbox: InboxInput[] = [...questionsInbox(task, c)];
    const gate = book.config.approvals.first_volume;
    if (task.target === 'v01' && gate.required) inbox.push(approvalInbox(book, 'approval', `approval:volume:v01:${book.id}`, '第一卷规划待批准', { kind: 'plan.volume', stage: 'first_volume', path: P.volume('v01') }, gate, ctx.deps.now(), task.id, { kind: 'plan.volume', target: 'v01' }));
    return { status: 'done', promote: promotePlan(book, task, h, files, `plan: volume ${task.target}`), inbox };
  },
};

/** plan.volume 只负责弧的大纲：已细化（已有卡片）的弧若被大纲覆盖，滚动规划会把同一个弧再排一遍，开书就卡死 */
export function overwritesDetailedArc(file: string, arcs: Pick<Arc, 'id' | 'detail'>[]): boolean {
  const id = /^plan\/arcs\/(a\d+)\.yaml$/.exec(file)?.[1];
  return id !== undefined && arcs.some((a) => a.id === id && a.detail === 'detailed');
}

function mergeById<T extends { id: string }>(existing: T[], updates: T[]): T[] {
  const m = new Map(existing.map((x) => [x.id, x]));
  for (const u of updates) m.set(u.id, u);
  return [...m.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ───────── plan.arc ─────────

export interface ArcTarget {
  arc: string;
  volume: string;
}

/** 弧的章号范围：从已有卡片之后连续往后（最后不超过全书总章数） */
function arcBounds(book: BookHandle, cardsThrough: number): { start: number; min: number; max: number; total: number } {
  const total = totalChapters(book);
  const [arcMin, arcMax] = book.genre.pacing.arc_length;
  const remaining = Math.max(0, total - cardsThrough);
  const start = cardsThrough + 1;
  const target = book.genre.pacing.card_buffer.target;
  const min = Math.min(remaining, Math.max(target, arcMin));
  const max = Math.min(remaining, Math.max(arcMax, min));
  return { start, min, max, total };
}

export interface EndgameInfo {
  active: boolean;
  reasons: string[];
  requiredClosures: string[];
}

/** §6.11：达到目标 85% / 进入最终卷 / 投影超上限 90% / closure capacity 触发 endgame */
export function endgameStatus(book: BookHandle, state: BookState, volumes: Volume[], volumeId: string, plannedThrough: number): EndgameInfo {
  const reasons: string[] = [];
  const s = book.config.scale;
  const total = state.snapshot.total_cjk;
  if (total >= s.target_cjk * 0.85) reasons.push(`字数达到目标的 85%（${total}/${s.target_cjk}）`);
  const lastVolume = volumes.length ? volumes[volumes.length - 1]?.id === volumeId : false;
  if (lastVolume) reasons.push('进入最终卷');
  const chapterTarget = book.config.scale.chapter_length?.target ?? book.genre.pacing.chapter_length.target;
  const remainingChapters = Math.max(0, totalChapters(book) - plannedThrough);
  if (total + remainingChapters * chapterTarget >= s.hard_max_cjk * 0.9) reasons.push('投影总字数接近 hard_max 的 90%');
  const open = Object.values(state.snapshot.obligations).filter((o) => o.status === 'open' || o.status === 'advanced');
  const heavy = open.filter((o) => o.weight === 'main' || o.weight === 'major');
  const closingChapters = 5;
  const needed = heavy.length * 3 + closingChapters; // 每条 main/major 平均约 3 章回收
  if (remainingChapters <= needed * 1.3) reasons.push(`剩余章数 ${remainingChapters} 不足以舒展收束（需要 ${needed}）`);
  const compassClosures = state.compass?.ending.required_closures ?? [];
  return { active: reasons.length > 0, reasons, requiredClosures: [...new Set([...compassClosures, ...heavy.map((o) => o.id)])] };
}

export const planArc: TaskHandler = {
  kind: 'plan.arc',
  role: 'planner',
  lane: 'side',
  maxAttempts: 6,
  async manifest(ctx, spec) {
    const book = requireBook(ctx);
    const state = await loadBookState(book.dir);
    const params = spec.params as { start?: number } | undefined;
    const hard: string[] = [P.compass, P.arc(spec.target)];
    if (params?.start) hard.push(P.card(params.start));
    return buildManifest(ctx, spec, { hard, soft: softDeps(state), validators: ['plan.numbering', 'card.projected_pre'] });
  },
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const params = task.params as { volume?: string; start?: number };
    const allCardsThrough = await highestCard(book);
    const start = params.start ?? allCardsThrough + 1;
    const bounds = arcBounds(book, start - 1);
    const volumeId = params.volume ?? state.volumes[0]?.id ?? 'v01';
    const volumeYaml = (await book.repo.readFile(P.volume(volumeId))) ?? '（缺少卷文件）';
    const end = endgameStatus(book, state, state.volumes, volumeId, start - 1);
    const lastChapter = bounds.total;
    const l = lengthFor(book, null);
    const artifacts: ArtifactDecl[] = [
      { path: P.arc(task.target), kind: 'plan_yaml', schema: 'nv.arc/1', required: true },
      { path: 'plan/cards/c*.yaml', kind: 'plan_yaml', schema: 'nv.card/1', required: true, min: Math.max(1, bounds.min), max: Math.max(1, bounds.max) },
      { path: P.obligations, kind: 'plan_yaml', schema: 'nv.oblig/1', required: false },
    ];
    const endgameText = end.active
      ? `\n**endgame 已触发**（${end.reasons.join('；')}）：不得新开 major/main 伏笔；minor 批量清理；必须把这些伏笔排进本弧收束：${end.requiredClosures.join('、') || '（无）'}。`
      : '';
    const closingNote = start + bounds.max - 1 >= lastChapter ? `\n这是全书最后一弧：把 ${chapterId(lastChapter)} 作为最终章（\`is_final: true\`），章节区间到此为止，并收束全部 open 伏笔。` : '';
    const body = await renderTemplate('plan.arc', {
      arc: task.target,
      start: chapterId(start),
      card_min: String(Math.max(1, bounds.min)),
      card_max: String(Math.max(1, bounds.max)),
      length_target: String(l.target),
      length_range: `${l.min}–${l.max}`,
      beats_range: `${book.genre.pacing.beats_per_chapter[0]}–${book.genre.pacing.beats_per_chapter[1]}`,
      endgame: `${endgameText}${closingNote}`,
      volume_yaml: volumeYaml,
      compass_brief: compassBrief(state.compass),
      state_brief: stateBrief(state.snapshot),
      arcs_index: state.arcs.slice(-30).map((a) => `- ${a.id}「${a.title}」${a.chapters.join('–')}：${a.question}`).join('\n') || '（暂无）',
      predicates: PREDICATE_REFERENCE,
      output: outputBlock(artifacts, run.outDir),
      retry: retryHint(task),
    });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, artifacts), body, inputs: [], ownerNotes: collectOwnerNotes(null, task) } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const params = task.params as { volume?: string; start?: number };
    const state = await loadBookState(book.dir);
    const start = params.start ?? (await highestCard(book)) + 1;
    const parsedArc = zArc.parse(yamlParse(c.report.files[P.arc(task.target)]?.text ?? ''));
    const arc: Arc = { ...parsedArc, id: task.target, detail: 'detailed' };
    const cards = Object.entries(c.report.files)
      .filter(([p]) => /^plan\/cards\/c\d+\.yaml$/.test(p))
      .map(([, f]) => zCard.parse(yamlParse(f.text)))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    // 连续性：从 start 起连续
    const hard: Finding[] = [];
    const fail = (id: string, message: string) => hard.push({ id, severity: 'hard', category: 'plan.arc', message, conflicts_with_author_layer: false });
    cards.forEach((card, i) => {
      if (card.id !== chapterId(start + i)) fail(`numbering-${i}`, `卡片编号应为 ${chapterId(start + i)}，实际 ${card.id}`);
      if (card.arc !== task.target) fail(`arc-${card.id}`, `${card.id}.arc 应为 ${task.target}`);
    });
    if (cards.length && cards[cards.length - 1]?.id !== arc.chapters[1]) fail('range', `弧章节区间 ${arc.chapters.join('–')} 与卡片不一致`);
    if (hard.length) return planValidationFailure(task, h, hard, task.maxAttempts);
    // 卡片补上 base_ledger_hash；投影校验（pre/must_not）
    const base = ledgerHash(state.ledger, state.overrides);
    const buffer = await book.files.cards(state.ledger.length + 1, start - 1);
    const stale = projectBuffer(state.snapshot, [...buffer, ...cards], { entities: state.entities.map((e) => e.entity) }).stale;
    const newIds = new Set(cards.map((x) => x.id));
    const staleNew = stale.filter((s) => newIds.has(s.card));
    if (staleNew.length) return planValidationFailure(task, h, staleNew.map((s) => ({ id: s.card, severity: 'hard' as const, category: 'plan.projection', message: `${s.card}：${s.reasons.join('；')}`, conflicts_with_author_layer: false })), task.maxAttempts);
    const v = validatePlan({ compass: state.compass, volumes: state.volumes, arcs: mergeById(state.arcs, [arc]), cards: [...buffer, ...cards], snapshot: state.snapshot, fingerprints: await book.files.arcFingerprints(), changed: [P.arc(task.target)] });
    if (!v.ok) return planValidationFailure(task, h, v.hard, task.maxAttempts);
    // §6.11 endgame：required_closures + open major/main 必须排进最后一弧（含 is_final 的弧）
    const volumeId = params.volume ?? arc.volume;
    const end = endgameStatus(book, state, state.volumes, volumeId, start - 1 + cards.length);
    if (end.active) {
      const heavyOpens = cards.flatMap((x) => x.post.filter((p) => (p as { op?: string; weight?: string }).op === 'obligation.open' && ['major', 'main'].includes((p as { weight?: string }).weight ?? '')).map(() => x.id));
      if (heavyOpens.length) return planValidationFailure(task, h, [{ id: 'endgame-opens', severity: 'hard', category: 'plan.endgame', message: `endgame 期间不得新开 major/main 伏笔：${[...new Set(heavyOpens)].join('、')}`, conflicts_with_author_layer: false }], task.maxAttempts);
    }
    const isLastArc = cards.some((x) => x.is_final);
    if (isLastArc) {
      const paid = new Set(cards.flatMap((x) => x.pays));
      const missing = end.requiredClosures.filter((id) => !paid.has(id));
      if (missing.length) return planValidationFailure(task, h, [{ id: 'closures', severity: 'hard', category: 'plan.endgame', message: `最后一弧没有回收：${missing.join('、')}`, conflicts_with_author_layer: false }], task.maxAttempts);
    }
    const files = outFiles(c).filter((f) => !/^plan\/cards\/c\d+\.yaml$/.test(f.path) && f.path !== P.arc(task.target));
    files.push({ path: P.arc(task.target), content: yamlStringify(arc, { lineWidth: 0 }) });
    for (const card of cards) files.push({ path: P.card(chapterNo(card.id)), content: yamlStringify({ ...card, base_ledger_hash: base } satisfies Card, { lineWidth: 0 }) });
    files.push(await changeLog(book, ctx, task, files.map((f) => f.path), 'create', `plan: arc ${task.target}（${cards[0]?.id}–${cards[cards.length - 1]?.id}）`));
    const lastNo = chapterNo(cards[cards.length - 1]?.id ?? chapterId(start));
    const bookId = book.id;
    const nowIso = ctx.deps.now().toISOString();
    const endgameActive = end.active;
    const rows = cards.map((x) => ({ bookId, no: chapterNo(x.id), chapterId: x.id, title: x.title, volume: x.volume, arc: x.arc }));
    const plan = promotePlan(book, task, h, files, `plan: arc ${task.target}`, { name: 'plan.arc', args: { bookId, rows, lastNo, nowIso, endgame: endgameActive } });
    return { status: 'done', promote: plan, inbox: questionsInbox(task, c), summary: { cards: cards.length, soft: v.soft.map((f) => f.message), endgame: end.reasons } };
  },
};

export async function highestCard(book: BookHandle): Promise<number> {
  const list = await book.repo.list('plan/cards');
  return list.reduce((max, p) => {
    const m = /c(\d{5})\.yaml$/.exec(p);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
}

// ───────── plan.fix / card.repair ─────────

export const planFix: TaskHandler = {
  kind: 'plan.fix',
  role: 'planner',
  lane: 'side',
  maxAttempts: 6,
  async manifest(ctx, spec) {
    const state = await loadBookState(requireBook(ctx).dir);
    // 账本前进后在 HEAD 上重跑投影校验，不通过转 card.repair（§7.2）
    return buildManifest(ctx, spec, { hard: [P.compass], soft: [...softDeps(state), P.obligations], validators: ['plan.numbering', 'card.projected_pre'] });
  },
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const params = task.params as { reason?: string };
    const through = state.ledger.length;
    const upcoming = await book.files.cards(through + 1, through + 50);
    const artifacts: ArtifactDecl[] = [
      { path: 'plan/cards/c*.yaml', kind: 'plan_yaml', schema: 'nv.card/1', required: false, min: 0 },
      { path: P.obligations, kind: 'plan_yaml', schema: 'nv.oblig/1', required: false },
    ];
    return planWorkOrder(ctx, task, run, artifacts, 'plan.fix', { reason: params.reason ?? '周期审计触发', state_brief: stateBrief(state.snapshot), through: chapterId(Math.max(1, through)), cards: yamlStringify(upcoming.slice(0, 20), { lineWidth: 0 }) });
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const state = await loadBookState(book.dir);
    const cards = Object.entries(c.report.files)
      .filter(([p]) => /^plan\/cards\/c\d+\.yaml$/.test(p))
      .map(([, f]) => zCard.parse(yamlParse(f.text)))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const through = state.ledger.length;
    const bad = cards.filter((x) => chapterNo(x.id) <= through);
    if (bad.length) return planValidationFailure(task, h, bad.map((x) => ({ id: x.id, severity: 'hard' as const, category: 'plan.fix', message: `不得修改已写章节的卡片：${x.id}`, conflicts_with_author_layer: false })), task.maxAttempts);
    const files = outFiles(c);
    if (files.length === 0) return { status: 'done', summary: { noop: true } };
    files.push(await changeLog(book, ctx, task, files.map((f) => f.path), 'repair', 'plan: fix'));
    return { status: 'done', promote: promotePlan(book, task, h, files, 'plan: fix'), inbox: questionsInbox(task, c) };
  },
};

export const cardRepair: TaskHandler = {
  kind: 'card.repair',
  role: 'planner',
  lane: 'side',
  maxAttempts: 4,
  async manifest(ctx, spec) {
    const params = spec.params as { cards?: string[] } | undefined;
    const ids = params?.cards ?? [spec.target];
    // soft = ledger（附录 B）：没有 soft deps 时账本前进也不会触发投影校验
    const state = await loadBookState(requireBook(ctx).dir);
    return buildManifest(ctx, spec, { hard: ids.map((id) => P.card(chapterNo(id))), soft: softDeps(state), validators: ['card.projected_pre'] });
  },
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const params = task.params as { cards?: string[]; reasons?: Record<string, string[]> };
    const ids = params.cards ?? [task.target];
    const cards = await Promise.all(ids.map(async (id) => book.repo.readFile(P.card(chapterNo(id)))));
    const artifacts: ArtifactDecl[] = ids.map((id) => ({ path: P.card(chapterNo(id)), kind: 'plan_yaml', schema: 'nv.card/1', required: true }));
    const reasons = Object.entries(params.reasons ?? {})
      .map(([id, r]) => `- ${id}：${r.join('；')}`)
      .join('\n');
    const body = await renderTemplate('card.repair', {
      reasons,
      cards: cards.map((t, i) => `### ${ids[i]}\n\n\`\`\`yaml\n${t ?? ''}\n\`\`\``).join('\n\n'),
      state_brief: stateBrief(state.snapshot),
      predicates: PREDICATE_REFERENCE,
      output: outputBlock(artifacts, run.outDir),
      retry: retryHint(task),
    });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, artifacts), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const params = task.params as { cards?: string[] };
    const ids = params.cards ?? [task.target];
    const cards = ids.map((id) => zCard.parse(yamlParse(c.report.files[P.card(chapterNo(id))]?.text ?? '')));
    const state = await loadBookState(book.dir);
    const through = state.ledger.length;
    const buffer = (await book.files.cards(through + 1, Math.max(...cards.map((x) => chapterNo(x.id))))).filter((x) => !cards.some((r) => r.id === x.id));
    const stale = projectBuffer(state.snapshot, [...buffer, ...cards], { entities: state.entities.map((e) => e.entity) }).stale;
    const repairedIds = new Set(cards.map((x) => x.id));
    const stillBad = stale.filter((s) => repairedIds.has(s.card));
    if (stillBad.length) return planValidationFailure(task, h, stillBad.map((s) => ({ id: s.card, severity: 'hard' as const, category: 'card.repair', message: `${s.card} 仍失效：${s.reasons.join('；')}`, conflicts_with_author_layer: false })), task.maxAttempts);
    const files = cards.map((card) => ({ path: P.card(chapterNo(card.id)), content: yamlStringify({ ...card, stale: false } satisfies Card, { lineWidth: 0 }) }));
    files.push(await changeLog(book, ctx, task, files.map((f) => f.path), 'repair', `card.repair ${ids.join(',')}`));
    const bookId = book.id;
    const nos = cards.map((x) => chapterNo(x.id));
    const plan = promotePlan(book, task, h, files, `plan: repair ${ids.join(',')}`, { name: 'card.repair', args: { bookId, nos } });
    return { status: 'done', promote: plan, inbox: questionsInbox(task, c), summary: { repaired: ids } };
  },
};

export type { TaskSpec, Arc, RunContext, Volume };
