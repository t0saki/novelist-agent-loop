/**
 * 周期审计（DESIGN §6.10）。Owner: lane E。
 * - audit.window：确定性（0 个模型 run）：重放 fold 核对 Novelist-Snapshot-Hash、窗口内重跑 delta.check、逾期伏笔、limits、泄漏签名、时间单调；
 *   通过后推进 books.audited_through（发布门控：min(窗口审计前沿, 已审计弧的末章)）。opt-in 模型版另起一个 auditor run。
 * - audit.arc：auditor 轻量版 + 弧指纹（arc-fingerprints.jsonl）；audit.volume；audit.heldout（opt-in）。
 */
import { eq } from 'drizzle-orm';
import type { Arc, ArtifactDecl, Audit, Card, Delta, Finding } from '@novelist/shared';
import { chapterId, chapterNo, stripBeatMarkers, zAudit } from '@novelist/shared';
import { P, TRAILER } from '../../book/index.js';
import { buildAliasIndex } from '../../context/index.js';
import { books } from '../../db/schema.js';
import { aliasEntities, createFolder, ledgerHash, loadBookState, locateCard } from '../../state/index.js';
import type { BookState } from '../../state/index.js';
import { arcFingerprintFeatures, deltaCheck, verifyQuotes } from '../../validators/index.js';
import { buildManifest, contractCheck, contractFailure, frontmatterFor, loadRunState, outputBlock, questionsInbox, requireBook, retryHint } from '../common.js';
import type { DbEffect } from '../effects.js';
import type { BookHandle, InboxInput, PipelineContext, TaskHandler, TaskResult, TaskRow, TaskSpec } from '../types.js';
import { renderTemplate } from '../workorder.js';

/** target "c00001-c00005" → [1,5] */
export function parseWindow(target: string): [number, number] {
  const m = /^c(\d{5})-c(\d{5})$/.exec(target);
  if (!m) throw new Error(`invalid window target: ${target}`);
  return [Number(m[1]), Number(m[2])];
}

export const windowTarget = (from: number, to: number): string => `${chapterId(from)}-${chapterId(to)}`;

export interface AuditProgress {
  window_through: number;
  arc_through: number;
}

export async function auditProgress(ctx: PipelineContext, book: BookHandle): Promise<AuditProgress> {
  const rows = await ctx.deps.db.select({ meta: books.meta }).from(books).where(eq(books.id, book.id)).limit(1);
  const meta = (rows[0]?.meta ?? {}) as { audit?: Partial<AuditProgress> };
  return { window_through: meta.audit?.window_through ?? 0, arc_through: meta.audit?.arc_through ?? 0 };
}

function advanceAudit(bookId: string, nowIso: string, patch: Partial<AuditProgress>, current: AuditProgress): DbEffect {
  return { name: 'audit.advance', args: { bookId, nowIso, audit: { ...current, ...patch } } };
}

function noticeInbox(book: BookHandle, title: string, body: Record<string, unknown>, key: string, taskId: string): InboxInput {
  return { kind: 'notice', bookId: book.id, title, body, actions: [{ id: 'ok', label: '知道了' }], dedupeKey: key, relatedTaskId: taskId };
}

const finding = (id: string, severity: 'hard' | 'soft', category: string, message: string, quote?: string): Finding => ({ id, severity, category, message, conflicts_with_author_layer: false, ...(quote ? { quote } : {}) });

/** 窗口内确定性检查（可单测） */
export async function runWindowChecks(book: BookHandle, state: BookState, from: number, to: number): Promise<{ findings: Finding[]; metrics: Record<string, number>; hashOk: boolean }> {
  const findings: Finding[] = [];
  const metrics: Record<string, number> = {};
  const entities = state.entities.map((e) => e.entity);
  const folder = createFolder({ entities, world: state.world, ledger: state.ledger, overrides: state.overrides });
  const aliases = buildAliasIndex(aliasEntities(state));
  let hashOk = true;
  if (state.overrides.length === 0) {
    // 只有无 override 时 trailer 与重放哈希才可直接比较（override 后移动了基线）
    for (let n = from; n <= to; n++) {
      const trailer = await chapterTrailer(book, n);
      if (trailer !== null && trailer !== ledgerHash(state.ledger.slice(0, n), state.overrides)) {
        hashOk = false;
        findings.push(finding(`hash-${n}`, 'hard', 'snapshot.hash', `第 ${n} 章 Novelist-Snapshot-Hash 与重放结果不一致`));
      }
    }
  }
  let hardFlags = 0;
  for (let n = from; n <= to; n++) {
    const delta = state.ledger[n - 1];
    if (!delta) continue;
    const card = await book.files.card(n);
    const text = await state.manuscript(n);
    if (!card || text === null) continue;
    const before = folder.advanceTo(n - 1);
    const { volume } = locateCard(state, card);
    const report = deltaCheck({
      delta,
      draft: text,
      card,
      before,
      world: state.world,
      secrets: state.secrets.map((s) => s.secret),
      overrides: state.overrides,
      eventFamilies: book.genre.eventFamilies,
      aliases,
      ...(volume?.power_range ? { powerRange: volume.power_range } : {}),
      unplannedInvention: book.config.policy.unplanned_invention,
      entities,
      expandOnly: false,
    });
    for (const f of report.hard) {
      hardFlags += 1;
      findings.push({ ...f, id: `${delta.chapter}:${f.id}` });
    }
    for (const l of report.leaks) findings.push(finding(`leak-${delta.chapter}-${l.secret}`, 'hard', 'secret.leak', `第 ${n} 章触发秘密 ${l.secret} 的泄漏签名`, l.quote));
  }
  metrics.delta_hard = hardFlags;
  const snap = state.snapshot;
  const compass = state.compass;
  if (compass) {
    const open = Object.values(snap.obligations).filter((o) => o.status === 'open' || o.status === 'advanced');
    metrics.open_total = open.length;
    if (open.length > compass.limits.open_total) findings.push(finding('limits.open_total', 'soft', 'limits', `open 伏笔 ${open.length} 超过上限 ${compass.limits.open_total}`));
    const overdue = open.filter((o) => o.due && chapterNo(o.due[1]) < to);
    metrics.overdue = overdue.length;
    for (const o of overdue.slice(0, 20)) findings.push(finding(`overdue-${o.id}`, 'soft', 'obligation.overdue', `伏笔 ${o.id} 已逾期（due ${o.due?.[1]}）：${o.text}`));
    const minorOld = open.filter((o) => o.weight === 'minor' && to - chapterNo(o.opened) > compass.limits.minor_max_age_ch);
    metrics.minor_stale = minorOld.length;
  }
  return { findings, metrics, hashOk };
}

async function chapterTrailer(book: BookHandle, n: number): Promise<string | null> {
  const log = await book.repo.log({ limit: 1, path: P.ledger(n) });
  const commit = log.items[0];
  return commit?.trailers[TRAILER.snapshotHash] ?? null;
}

function overdueFollowups(book: BookHandle, state: BookState, metrics: Record<string, number>): TaskSpec[] {
  if ((metrics.overdue ?? 0) > 5) return [{ kind: 'plan.fix', bookId: book.id, target: 'book', params: { reason: `逾期伏笔 ${metrics.overdue} 条，超过 5 条`, instance: `overdue-${state.snapshot.through}` } }];
  return [];
}

export const auditWindow: TaskHandler = {
  kind: 'audit.window',
  role: null,
  lane: 'side',
  maxAttempts: 4,
  manifest: (ctx, spec) => {
    const [from, to] = parseWindow(spec.target);
    const ledger: string[] = [];
    for (let n = from; n <= to; n++) ledger.push(P.ledger(n), P.manuscript(n));
    return buildManifest(ctx, spec, { hard: ledger, soft: [P.summaryBook] });
  },
  async execute(ctx, task): Promise<TaskResult> {
    const book = requireBook(ctx);
    const [from, to] = parseWindow(task.target);
    const state = await loadBookState(book.dir);
    if (state.ledger.length < to) return { status: 'waiting', message: '账本尚未到达审计窗口', retryAfter: new Date(ctx.deps.now().getTime() + 300_000).toISOString() };
    const { findings, metrics, hashOk } = await runWindowChecks(book, state, from, to);
    const passed = findings.every((f) => f.severity !== 'hard');
    const audit: Audit = { schema: 'nv.audit/1', kind: 'window', range: [chapterId(from), chapterId(to)], ts: ctx.deps.now().toISOString(), passed, snapshot_hash_ok: hashOk, findings, metrics, runs: [] };
    const progress = await auditProgress(ctx, book);
    const nowIso = ctx.deps.now().toISOString();
    const followups = overdueFollowups(book, state, metrics);
    const inbox: InboxInput[] = passed ? [] : [noticeInbox(book, `审计窗口 ${task.target} 未通过`, { target: task.target, findings: findings.filter((f) => f.severity === 'hard').slice(0, 50) }, `audit-window:${task.target}`, task.id)];
    return {
      status: 'done',
      followups,
      inbox,
      summary: { passed, metrics },
      promote: {
        bookId: book.id,
        taskId: task.id,
        runId: null,
        baseCommit: await book.repo.head(),
        files: [{ path: P.audit(`window-${task.target}`), content: `${JSON.stringify(audit, null, 2)}\n` }],
        resolveTmpIds: false,
        message: `audit: window ${task.target}${passed ? '' : ' (failed)'}`,
        trailers: {},
        tags: [],
        ...(passed ? { effect: advanceAudit(book.id, nowIso, { window_through: to }, progress) } : {}),
      },
    };
  },
};

// ───────── 模型审计（audit.arc / audit.volume / heldout）─────────

function ledgerExcerpt(state: BookState, from: number, to: number, limit = 200): string {
  const out: string[] = [];
  for (const d of state.ledger.slice(from - 1, to)) {
    out.push(`[${d.chapter}] ${d.summary.map((s) => s.s).join('')}`);
    for (const op of d.ops.slice(0, 30)) if (op.op !== 'event') out.push(`  - ${JSON.stringify(op)}`);
    if (out.length > limit) break;
  }
  return out.join('\n');
}

async function verifiedAuditFindings(state: BookState, audit: Audit, from: number, to: number): Promise<Finding[]> {
  const texts: string[] = [];
  for (let n = from; n <= to; n++) texts.push((await state.manuscript(n)) ?? '');
  const all = stripBeatMarkers(texts.join('\n'));
  const quotes = audit.findings.filter((f) => f.quote).map((f) => f.quote as string);
  const verified = new Map(verifyQuotes(all, quotes).map((v) => [v.quote, v.ok]));
  return audit.findings.map((f) => ({ ...f, verified: f.quote ? (verified.get(f.quote) ?? false) : true })).filter((f) => f.verified);
}

function arcRange(arc: Arc): [number, number] {
  return [chapterNo(arc.chapters[0]), chapterNo(arc.chapters[1])];
}

async function arcCards(book: BookHandle, arc: Arc): Promise<Card[]> {
  const [from, to] = arcRange(arc);
  return (await book.files.cards(from, to)).filter((c) => c.arc === arc.id);
}

export const auditArc: TaskHandler = {
  kind: 'audit.arc',
  role: 'auditor',
  lane: 'side',
  maxAttempts: 4,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.arc(spec.target), P.summaryArc(spec.target)], soft: [P.summaryBook] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const arc = state.arcs.find((a) => a.id === task.target);
    if (!arc) return { kind: 'skip', result: { status: 'failed', errorClass: 'config', message: `缺少弧 ${task.target}` } };
    const [from, to] = arcRange(arc);
    const art: ArtifactDecl = { path: 'audit.json', kind: 'audit', schema: 'nv.audit/1', required: true };
    const body = await renderTemplate('audit.arc', { arc: task.target, range: `${arc.chapters[0]}–${arc.chapters[1]}`, range_json: JSON.stringify(arc.chapters), summary: (await book.files.summary('arc', task.target)) ?? '（无）', sources: ledgerExcerpt(state, from, to), output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art]), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const state = await loadBookState(book.dir);
    const arc = state.arcs.find((a) => a.id === task.target);
    if (!arc) return { status: 'failed', errorClass: 'config', message: `缺少弧 ${task.target}` };
    const [from, to] = arcRange(arc);
    const audit = zAudit.parse(c.report.files['audit.json']?.json);
    const findings = await verifiedAuditFindings(state, audit, from, to);
    const passed = audit.passed && findings.every((f) => f.severity !== 'hard');
    const finalAudit: Audit = { ...audit, kind: 'arc', range: [arc.chapters[0], arc.chapters[1]], findings, passed, runs: [h.run.runId] };
    // 弧指纹写入 state/arc-fingerprints.jsonl（§6.10）；与 plan 校验共用特征函数，保证新旧可比
    const fp = { schema: 'nv.arcfp/1' as const, arc: arc.id, ts: ctx.deps.now().toISOString(), features: arcFingerprintFeatures(arc, await arcCards(book, arc)), vector: [] };
    const existingFp = (await book.repo.readFile(P.arcFingerprints)) ?? '';
    const progress = await auditProgress(ctx, book);
    const nowIso = ctx.deps.now().toISOString();
    const arcEnd = to;
    const followups: TaskSpec[] = [];
    const inbox: InboxInput[] = [...questionsInbox(task, c)];
    if (!passed) inbox.push(noticeInbox(book, `弧审计 ${task.target} 未通过`, { target: task.target, findings: findings.filter((f) => f.severity === 'hard').slice(0, 50) }, `audit-arc:${task.target}`, task.id));
    return {
      status: 'done',
      followups,
      inbox,
      summary: { passed },
      promote: {
        bookId: book.id,
        taskId: task.id,
        runId: h.run.runId,
        baseCommit: h.run.baseCommit,
        files: [
          { path: P.audit(`arc-${task.target}`), content: `${JSON.stringify(finalAudit, null, 2)}\n` },
          { path: P.arcFingerprints, content: `${existingFp}${existingFp && !existingFp.endsWith('\n') ? '\n' : ''}${JSON.stringify(fp)}\n` },
        ],
        resolveTmpIds: false,
        message: `audit: arc ${task.target}${passed ? '' : ' (failed)'}`,
        trailers: {},
        tags: [],
        ...(passed && from - 1 <= progress.arc_through ? { effect: advanceAudit(book.id, nowIso, { arc_through: Math.max(progress.arc_through, arcEnd) }, progress) } : {}),
      },
    };
  },
};

export const auditVolume: TaskHandler = {
  kind: 'audit.volume',
  role: 'auditor',
  lane: 'side',
  maxAttempts: 4,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.volume(spec.target), P.summaryVolume(spec.target)], soft: [P.summaryBook] }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const arcs = state.arcs.filter((a) => a.volume === task.target);
    const from = arcs[0]?.chapters[0] ?? 'c00001';
    const to = arcs[arcs.length - 1]?.chapters[1] ?? chapterId(Math.max(1, state.ledger.length));
    const art: ArtifactDecl = { path: 'audit.json', kind: 'audit', schema: 'nv.audit/1', required: true };
    const body = await renderTemplate('audit.volume', { volume: task.target, range: `${from}–${to}`, range_json: JSON.stringify([from, to]), summary: (await book.files.summary('volume', task.target)) ?? '（无）', sources: ledgerExcerpt(state, chapterNo(from), chapterNo(to)), output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art]), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const audit = zAudit.parse(c.report.files['audit.json']?.json);
    const state = await loadBookState(book.dir);
    const findings = await verifiedAuditFindings(state, audit, chapterNo(audit.range[0]), chapterNo(audit.range[1]));
    const passed = audit.passed && findings.every((f) => f.severity !== 'hard');
    const finalAudit: Audit = { ...audit, kind: 'volume', findings, passed, runs: [h.run.runId] };
    const inbox: InboxInput[] = [...questionsInbox(task, c)];
    if (!passed) inbox.push(noticeInbox(book, `卷审计 ${task.target} 未通过`, { target: task.target, findings: findings.slice(0, 50) }, `audit-volume:${task.target}`, task.id));
    return { status: 'done', inbox, summary: { passed }, promote: { bookId: book.id, taskId: task.id, runId: h.run.runId, baseCommit: h.run.baseCommit, files: [{ path: P.audit(`volume-${task.target}`), content: `${JSON.stringify(finalAudit, null, 2)}\n` }], resolveTmpIds: false, message: `audit: volume ${task.target}`, trailers: {}, tags: [] } };
  },
};

export const auditHeldout: TaskHandler = {
  kind: 'audit.heldout',
  role: 'heldout',
  lane: 'side',
  maxAttempts: 4,
  manifest: (ctx, spec) => buildManifest(ctx, spec, { hard: [P.summaryBook], extra: { sample: spec.params?.sample ?? null } }),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const params = task.params as { sample?: string[] };
    const sample = params.sample ?? [];
    const texts = await Promise.all(sample.map(async (id) => `### ${id}\n\n${(await state.manuscript(chapterNo(id))) ?? ''}`));
    const art: ArtifactDecl = { path: 'audit.json', kind: 'audit', schema: 'nv.audit/1', required: true };
    const range = sample.length ? [sample[0] as string, sample[sample.length - 1] as string] : [chapterId(1), chapterId(1)];
    const body = await renderTemplate('audit.heldout', { target: task.target, range_json: JSON.stringify(range), sources: texts.join('\n\n'), output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art]), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const audit = zAudit.parse(c.report.files['audit.json']?.json);
    const finalAudit: Audit = { ...audit, kind: 'heldout', runs: [h.run.runId] };
    return { status: 'done', summary: { passed: audit.passed }, promote: { bookId: book.id, taskId: task.id, runId: h.run.runId, baseCommit: h.run.baseCommit, files: [{ path: P.audit(`heldout-${task.target}`), content: `${JSON.stringify(finalAudit, null, 2)}\n` }], resolveTmpIds: false, message: `audit: heldout ${task.target}`, trailers: {}, tags: [] } };
  },
};

export type { Delta, TaskRow };
