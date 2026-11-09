/** handler 共用工具：manifest、门禁、工作单公共部分、提交计划。Owner: lane E。 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import type { ArtifactDecl, Card, EffectiveGate, GatesFile, GateResult, InboxKind, LengthSpec, Lexicon, TaskKind } from '@novelist/shared';
import { SCHEMAS, type SchemaName, toJsonSchema, zGatesFile, zLexicon } from '@novelist/shared';
import type { BookState } from '../state/index.js';
import { canonicalJson, loadBookState } from '../state/index.js';
import { BUILTIN_GATES, mergeLexiconLayers, resolveEffectiveGates, runContractGates } from '../validators/index.js';
import type { ContractReport } from '../validators/index.js';
import type { BookHandle, HarvestedRun, InboxInput, Manifest, PipelineContext, RunContext, TaskResult, TaskRow, TaskSpec, AgentPlan } from './types.js';
import { P } from '../book/index.js';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function requireBook(ctx: PipelineContext): BookHandle {
  if (!ctx.book) throw new Error('该任务需要 book 上下文');
  return ctx.book;
}

async function readYamlFile<T>(abs: string, parse: (v: unknown) => T): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
  return parse(yamlParse(text));
}

export async function effectiveGates(ctx: PipelineContext, book: BookHandle): Promise<EffectiveGate[]> {
  const parse = (v: unknown): GatesFile => zGatesFile.parse(v);
  return resolveEffectiveGates({
    builtin: BUILTIN_GATES,
    global: await readYamlFile(path.join(ctx.deps.paths.instructionsGlobal, 'gates.yaml'), parse),
    genre: book.genre.gates,
    bookFile: await readYamlFile(path.join(book.dir, P.bookGates), parse),
    bookOverrides: book.config.gates.overrides,
  });
}

/** 题材链合并后的 lexicon，再叠加书层 style/lexicon.yaml（书层 allow 压过一切 ban，§6.8） */
export async function effectiveLexicon(ctx: PipelineContext, book: BookHandle): Promise<Lexicon> {
  const parse = (v: unknown): Lexicon => zLexicon.parse(v);
  const layers: Lexicon[] = [];
  const global = await readYamlFile(path.join(ctx.deps.paths.instructionsGlobal, 'lexicon.yaml'), parse);
  if (global) layers.push(global);
  layers.push(book.genre.lexicon);
  const bookLex = await book.files.lexicon().catch(() => null);
  if (bookLex) layers.push(bookLex);
  return mergeLexiconLayers(layers);
}

/** 长度区间：卡片 > book.yaml scale.chapter_length > 题材 pacing */
export function lengthFor(book: BookHandle, card: Card | null): LengthSpec {
  return card?.length ?? book.config.scale.chapter_length ?? book.genre.pacing.chapter_length;
}

/** 影响产物内容的配置 hash：gates 阈值、档位、长度、题材包版本、实例号（§7.2） */
export async function configHash(ctx: PipelineContext, book: BookHandle | null, spec: TaskSpec, extra: Record<string, unknown> = {}): Promise<string> {
  const content: Record<string, unknown> = {
    tier: spec.tier ?? null,
    instance: spec.params?.instance ?? null,
    params: spec.params?.mode ?? null,
    ...extra,
  };
  if (book) {
    content.gates = await effectiveGates(ctx, book);
    content.genre = book.genre.chain.map((g) => `${g.id}@${g.pack.version}`);
    content.scale = book.config.scale;
  }
  return sha256(canonicalJson(content));
}

export interface ManifestOpts {
  hard?: string[];
  soft?: string[];
  validators?: string[];
  extra?: Record<string, unknown>;
}

/** 按 HEAD 取 blob sha（不存在 → ''，stale check 约定） */
export async function buildManifest(ctx: PipelineContext, spec: TaskSpec, opts: ManifestOpts): Promise<Manifest> {
  const book = ctx.book;
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  const hard = uniq(opts.hard ?? []);
  const soft = uniq(opts.soft ?? []).filter((p) => !hard.includes(p));
  let hardShas: Record<string, string> = {};
  let softShas: Record<string, string> = {};
  if (book) {
    const head = await book.repo.head();
    [hardShas, softShas] = await Promise.all([book.repo.blobShas(hard, head), book.repo.blobShas(soft, head)]);
  }
  return { hard: hardShas, soft: softShas, rebaseValidators: opts.validators ?? [], configHash: await configHash(ctx, book, spec, opts.extra) };
}

// ───────── 契约门禁 ─────────

export interface ContractOutcome {
  report: ContractReport;
  /** 含 contract.nonce 的完整门禁结果 */
  results: GateResult[];
  ok: boolean;
}

export function nonceGate(h: HarvestedRun): GateResult {
  const detail: string[] = [];
  if (h.nonce.missingTail.length) detail.push(`缺少作者层 TAIL：${h.nonce.missingTail.join('、')}`);
  if (h.nonce.tainted) detail.push('agent 读取了含 nonce 的文件，回显不计入证明');
  return { rule: 'contract.nonce', family: 'contract', level: 'hard', ok: h.nonce.ok, source: 'novelist', spans: [], ...(detail.length ? { detail: detail.join('；') } : {}) };
}

export async function contractCheck(task: TaskRow, h: HarvestedRun): Promise<ContractOutcome> {
  const report = await runContractGates({ outDir: h.stagedOutDir, artifacts: h.artifacts, taskId: task.id });
  const nonce = nonceGate(h);
  const results = [...report.results, nonce];
  return { report, results, ok: report.ok && nonce.ok && h.audit.ok };
}

const failDetail = (results: GateResult[]): string =>
  results
    .filter((r) => !r.ok && r.level === 'hard')
    .map((r) => `${r.rule}: ${r.detail ?? '未通过'}`)
    .join('；');

/** I/O 契约失败：retry（同 profile 2 次后 avoidProfile）；attempts 耗尽 → block 本书 lane（§6.4 耗尽策略） */
export function contractFailure(task: TaskRow, h: HarvestedRun, c: ContractOutcome, handlerMaxAttempts: number, chapter?: { no: number }): TaskResult {
  const detail = failDetail(c.results) || (h.audit.ok ? '契约校验未通过' : `输出越界或配置被改动：${[...h.audit.extraFiles, ...h.audit.tamperedConfig].join('、')}`);
  const message = `产物未通过 I/O 契约：${detail}`;
  if (h.run.attempt >= handlerMaxAttempts) {
    return {
      status: 'blocked',
      errorClass: 'output_contract',
      message,
      ...(chapter ? { chapter: { no: chapter.no, state: 'blocked' as const } } : {}),
      inbox: [
        {
          kind: 'block',
          bookId: task.bookId,
          title: `I/O 契约失败已耗尽重试：${task.kind} ${task.target}`,
          body: { task: task.id, kind: task.kind, target: task.target, detail },
          // 章节任务跳过没有意义（chapters.state 仍是 blocked，写作 lane 不会前进）；重试或由 owner 改任务
          actions: chapter ? [{ id: 'retry', label: '重试' }] : [{ id: 'retry', label: '重试' }, { id: 'skip', label: '跳过', danger: true }],
          dedupeKey: `block:${task.kind}:${task.target}`,
          relatedTaskId: task.id,
        },
      ],
    };
  }
  return { status: 'retry', errorClass: 'output_contract', message, ...(h.run.attempt >= 2 ? { avoidProfile: h.run.profileId } : {}) };
}

export function questionsInbox(task: TaskRow, c: ContractOutcome): InboxInput[] {
  const qs = c.report.receipt?.questions_for_planner ?? [];
  if (qs.length === 0) return [];
  return [
    {
      kind: 'question',
      bookId: task.bookId,
      title: `Agent 提问：${task.kind} ${task.target}`,
      body: { task: task.id, kind: task.kind, target: task.target, questions: qs, notes: c.report.receipt?.notes },
      actions: [{ id: 'resolve', label: '已处理', needsNote: true }],
      dedupeKey: `question:${task.id}`,
      relatedTaskId: task.id,
    },
  ];
}

// ───────── 工作单公共部分 ─────────

export const RECEIPT_DECL: ArtifactDecl = { path: 'receipt.json', kind: 'receipt', schema: 'nv.receipt/1', required: true, description: '回执（必需）' };

export const DEFAULT_BUDGET = { max_full_chapter_reads: 4, max_searches: 8 };

export function frontmatterFor(book: BookHandle | null, task: TaskRow, run: RunContext, artifacts: ArtifactDecl[], inputs: AgentPlan['frontmatter']['inputs'] = []): AgentPlan['frontmatter'] {
  return {
    kind: task.kind as TaskKind,
    role: run.role,
    book: book?.slug ?? null,
    target: task.target,
    inputs,
    artifacts: [...artifacts, RECEIPT_DECL],
    budget: { ...DEFAULT_BUDGET },
  };
}

/** 工作单“输出要求”段：显式的绝对路径 + 回执要求（§5.5） */
const SCHEMA_BLOCK_MAX_CHARS = 16_000;

/** 结构化产物的 JSON Schema：只写 schema 名时模型只能猜字段（真实 run 里连续失败过） */
export function schemaBlock(artifacts: ArtifactDecl[]): string[] {
  const names = [...new Set(artifacts.map((a) => a.schema).filter((s): s is string => !!s && s in SCHEMAS))];
  const blocks = names.flatMap((name) => {
    const { $schema: _dialect, ...schema } = toJsonSchema(SCHEMAS[name as SchemaName]);
    const json = JSON.stringify(schema);
    return json.length > SCHEMA_BLOCK_MAX_CHARS ? [] : [`\`${name}\`：`, '', '```json', json, '```', ''];
  });
  if (blocks.length === 0) return [];
  return ['', '## 产物结构（必须一致）', '', '字段名、类型和层级必须与下面的 JSON Schema 完全一致，不要加同义字段或改成别的嵌套。YAML 产物按同样的结构书写，.md 产物写在 frontmatter 里。', '', ...blocks];
}

export function outputBlock(artifacts: ArtifactDecl[], outDir: string): string {
  const lines = artifacts.map((a) => {
    const qty = a.min !== undefined || a.max !== undefined ? `，文件数 ${a.min ?? 1}–${a.max ?? '不限'}` : '';
    const opt = a.required === false ? '（可选）' : '';
    return `- \`${path.join(outDir, a.path)}\`${opt}${a.schema ? `（schema: ${a.schema}）` : ''}${qty}${a.description ? ` — ${a.description}` : ''}`;
  });
  return [
    '## 输出要求（必须遵守）',
    '',
    `所有产物只写到 \`${outDir}\`，文件清单：`,
    '',
    ...lines,
    `- \`${path.join(outDir, 'receipt.json')}\`（schema: nv.receipt/1）— 回执，必须最后写，status 为 done / blocked / failed`,
    '',
    '产物以文件为准，标准输出只作日志。回执的 nonces 只从系统提示抄录。无法完成时写 status: blocked 并在 questions_for_planner 说明原因，不要交付凑数内容。',
    ...schemaBlock(artifacts),
  ].join('\n');
}

export function collectOwnerNotes(card: Card | null, task: TaskRow): { source: string; text: string }[] {
  const out: { source: string; text: string }[] = [];
  if (card?.notes) out.push({ source: `card:${card.id}`, text: card.notes });
  const ps = task.params as { ownerNotes?: unknown };
  if (Array.isArray(ps.ownerNotes)) {
    ps.ownerNotes.forEach((n, i) => {
      if (typeof n === 'string' && n.trim()) out.push({ source: `owner-note:${i + 1}`, text: n });
    });
  }
  return out;
}

export function retryHint(task: TaskRow): string {
  if (!task.lastError) return '';
  return `\n## 上一次尝试未通过\n\n${task.lastError}\n\n请修正后重新交付全部产物。\n`;
}

export const inputPath = (run: RunContext, rel: string): string => path.join(run.inDir, rel);

export async function loadRunState(run: RunContext): Promise<BookState> {
  return loadBookState(run.snapshotDir);
}

// ───────── 提交计划 ─────────

export interface InboxActions {
  approve: InboxInput['actions'];
}

export function approvalInbox(book: BookHandle, kind: InboxKind, key: string, title: string, body: Record<string, unknown>, gate: { timeout?: string | undefined; on_timeout: 'wait' | 'auto_approve' | 'skip' }, now: Date, taskId: string, redo?: { kind: TaskKind; target: string }): InboxInput {
  // 打回 = 重做同一 kind/target（新实例，笔记进 L3.9）；重做完成前 next.ts 继续拦住后续规划
  const on = redo ? { reject: { task: 'none', followups: [{ kind: redo.kind, bookId: book.id, target: redo.target, params: { instance: `reject-${taskId.slice(0, 10)}` } }] } } : undefined;
  const out: InboxInput = {
    kind,
    bookId: book.id,
    title,
    body: { ...body, ...(on ? { on } : {}) },
    actions: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '打回重做', danger: true, needsNote: true }],
    dedupeKey: key,
    relatedTaskId: taskId,
    onTimeout: gate.on_timeout,
  };
  if (gate.timeout) {
    const ms = parseIsoDuration(gate.timeout);
    if (ms !== null) out.timeoutAt = new Date(now.getTime() + ms).toISOString();
  }
  return out;
}

export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
}
