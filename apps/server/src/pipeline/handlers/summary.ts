/** 摘要（DESIGN §6.3、§6.10）：summary.arc / summary.volume（summarizer），book.blurb。锚点校验。side lane，重试 4。Owner: lane E。 */
import type { ArtifactDecl, Delta } from '@novelist/shared';
import { chapterId, chapterNo } from '@novelist/shared';
import { P } from '../../book/index.js';
import { truncateCjk } from '../../context/index.js';
import { loadBookState } from '../../state/index.js';
import { buildManifest, contractCheck, contractFailure, frontmatterFor, loadRunState, outputBlock, questionsInbox, requireBook, retryHint } from '../common.js';
import type { BookHandle, TaskHandler, TaskRow, TaskSpec } from '../types.js';
import { renderTemplate } from '../workorder.js';

const summaryText = (d: Delta): string => d.summary.map((s) => s.s).join('');

function sourcesText(ledger: Delta[], from: number, to: number, limit = 40000): string {
  const out: string[] = [];
  for (const d of ledger) {
    const n = chapterNo(d.chapter);
    if (n < from || n > to) continue;
    out.push(`[${d.chapter}] ${summaryText(d)}`);
  }
  return truncateCjk(out.join('\n'), limit, 'tail').text;
}

/** 确定性锚点校验（§6.3）：句末须带 [cNNNNN]，且引用落在区间内；无锚点句超过 30% 拒收 */
export function checkAnchors(text: string, from: number, to: number): { ok: boolean; ratio: number } {
  const sentences = text
    .split(/(?<=[。！？!?])/)
    .map((s) => s.trim())
    .filter((s) => /[\p{Script=Han}]/u.test(s));
  if (sentences.length === 0) return { ok: false, ratio: 1 };
  const inRange = (s: string): boolean => [...s.matchAll(/\[c(\d{5})\]/g)].some((m) => Number(m[1]) >= from && Number(m[1]) <= to);
  const bad = sentences.filter((s) => !inRange(s)).length;
  const ratio = bad / sentences.length;
  return { ok: ratio <= 0.3, ratio };
}

function spec(book: BookHandle, kind: 'summary.arc' | 'summary.volume' | 'book.blurb' | 'audit.arc' | 'audit.volume', target: string): TaskSpec {
  return { kind, bookId: book.id, target };
}

function summaryManifest(paths: (spec: TaskSpec) => { hard: string[]; soft?: string[] }) {
  return (ctx: Parameters<TaskHandler['manifest']>[0], s: TaskSpec) => buildManifest(ctx, s, { ...paths(s) });
}

export const summaryArc: TaskHandler = {
  kind: 'summary.arc',
  role: 'summarizer',
  lane: 'side',
  maxAttempts: 2,
  manifest: summaryManifest((s) => ({ hard: [P.arc(s.target), P.summaryArc(s.target)] })),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const arc = state.arcs.find((a) => a.id === task.target);
    if (!arc) return { kind: 'skip', result: { status: 'failed', errorClass: 'config', message: `缺少弧 ${task.target}` } };
    const from = chapterNo(arc.chapters[0]);
    const to = chapterNo(arc.chapters[1]);
    const art: ArtifactDecl = { path: P.summaryArc(task.target), kind: 'summary', required: true };
    const body = await renderTemplate('summary.arc', { arc: arc.id, arc_title: arc.title, range: `${arc.chapters[0]}–${arc.chapters[1]}`, sources: sourcesText(state.ledger, from, to), output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art]), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const state = await loadBookState(book.dir);
    const arc = state.arcs.find((a) => a.id === task.target);
    if (!arc) return { status: 'failed', errorClass: 'config', message: `缺少弧 ${task.target}` };
    const rel = P.summaryArc(task.target);
    const text = c.report.files[rel]?.text ?? '';
    const anchors = checkAnchors(text, chapterNo(arc.chapters[0]), chapterNo(arc.chapters[1]));
    if (!anchors.ok) return { status: 'retry', errorClass: 'output_contract', message: `摘要无锚点句占比 ${anchors.ratio.toFixed(2)} 超过 30%` };
    const followups = [spec(book, 'audit.arc', task.target)];
    return { status: 'done', followups, inbox: questionsInbox(task, c), promote: { bookId: book.id, taskId: task.id, runId: h.run.runId, baseCommit: h.run.baseCommit, files: [{ path: rel, content: text }], resolveTmpIds: false, message: `summary: arc ${task.target}`, trailers: {}, tags: [] } };
  },
};

export const summaryVolume: TaskHandler = {
  kind: 'summary.volume',
  role: 'summarizer',
  lane: 'side',
  maxAttempts: 2,
  manifest: summaryManifest((s) => ({ hard: [P.volume(s.target), P.summaryVolume(s.target)] })),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const volume = state.volumes.find((v) => v.id === task.target);
    if (!volume) return { kind: 'skip', result: { status: 'failed', errorClass: 'config', message: `缺少卷 ${task.target}` } };
    const arcs = state.arcs.filter((a) => a.volume === task.target);
    const sections = await Promise.all(arcs.map(async (a) => `### ${a.id} ${a.title}\n\n${(await book.files.summary('arc', a.id)) ?? '（暂无摘要）'}`));
    const art: ArtifactDecl = { path: P.summaryVolume(task.target), kind: 'summary', required: true };
    const body = await renderTemplate('summary.volume', { volume: task.target, volume_title: volume.title, sources: truncateCjk(sections.join('\n\n'), 40000, 'tail').text, output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art]), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const rel = P.summaryVolume(task.target);
    const text = c.report.files[rel]?.text ?? '';
    const state = await loadBookState(book.dir);
    const arcs = state.arcs.filter((a) => a.volume === task.target);
    const range = arcs.length ? [chapterNo(arcs[0]?.chapters[0] ?? 'c00001'), chapterNo(arcs[arcs.length - 1]?.chapters[1] ?? chapterId(state.ledger.length))] : [1, state.ledger.length];
    const anchors = checkAnchors(text, range[0] as number, range[1] as number);
    if (!anchors.ok) return { status: 'retry', errorClass: 'output_contract', message: `摘要无锚点句占比 ${anchors.ratio.toFixed(2)} 超过 30%` };
    return { status: 'done', followups: [spec(book, 'audit.volume', task.target), spec(book, 'book.blurb', 'book')], inbox: questionsInbox(task, c), promote: { bookId: book.id, taskId: task.id, runId: h.run.runId, baseCommit: h.run.baseCommit, files: [{ path: rel, content: text }], resolveTmpIds: false, message: `summary: volume ${task.target}`, trailers: {}, tags: [] } };
  },
};

export const bookBlurb: TaskHandler = {
  kind: 'book.blurb',
  role: 'summarizer',
  lane: 'side',
  maxAttempts: 2,
  manifest: summaryManifest(() => ({ hard: [P.summaryBook] })),
  async prepare(ctx, task, run) {
    const book = requireBook(ctx);
    const state = await loadRunState(run);
    const vols = await Promise.all(state.volumes.map(async (v) => `### ${v.id} ${v.title}\n\n${(await book.files.summary('volume', v.id)) ?? '（暂无）'}`));
    const art: ArtifactDecl = { path: P.summaryBook, kind: 'summary', required: true };
    const body = await renderTemplate('book.blurb', { sources: truncateCjk(vols.join('\n\n'), 40000, 'tail').text, output: outputBlock([art], run.outDir), retry: retryHint(task) });
    return { kind: 'run', plan: { frontmatter: frontmatterFor(book, task, run, [art]), body, inputs: [], ownerNotes: [] } };
  },
  async finalize(ctx, task, h) {
    const book = requireBook(ctx);
    const c = await contractCheck(task, h);
    if (!c.ok) return contractFailure(task, h, c, task.maxAttempts);
    const text = c.report.files[P.summaryBook]?.text ?? '';
    const state = await loadBookState(book.dir);
    const anchors = checkAnchors(text, 1, Math.max(1, state.ledger.length));
    if (!anchors.ok) return { status: 'retry', errorClass: 'output_contract', message: `摘要无锚点句占比 ${anchors.ratio.toFixed(2)} 超过 30%` };
    return { status: 'done', inbox: questionsInbox(task, c), promote: { bookId: book.id, taskId: task.id, runId: h.run.runId, baseCommit: h.run.baseCommit, files: [{ path: P.summaryBook, content: text }], resolveTmpIds: false, message: 'summary: book', trailers: {}, tags: [] } };
  },
};

export type { TaskRow };
