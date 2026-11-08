#!/usr/bin/env node
/**
 * nv（DESIGN §3.5、§6.5、§10.6）：沙箱内/hook 用的只读计数与快速检查。不访问 DB，不写文件，不调模型。
 *   nv count <file> [--mode han|platform] [--json]
 *   nv gate --quick [--report] [--json] [--draft <file>] [--workorder <file>] [--card <file>]
 * 只回报实测字数、缺失的 beat 标记和截断提示；最终结论始终来自环外 validators。
 * --report 模式总是退出 0（Stop hook 绝不能阻断 run）。Owner: lane D。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { CountMode } from '@novelist/shared';
import { BEAT_MARKER_RE, countByBeat, countCjk, stripBeatMarkers } from '@novelist/shared';
import { parse as yamlParse } from 'yaml';
import { checkTruncation } from './truncation.js';

export interface NvIo {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
}

const defaultIo = (): NvIo => ({
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  cwd: process.cwd(),
});

const asMode = (v: unknown): CountMode => (v === 'platform' ? 'platform' : 'han');

function countReport(text: string, mode: CountMode) {
  const beats = countByBeat(text, mode);
  if ((beats._pre ?? 0) === 0) delete beats._pre;
  const body = stripBeatMarkers(text);
  return { mode, total: countCjk(body, mode), han: countCjk(body, 'han'), platform: countCjk(body, 'platform'), beats };
}

function cmdCount(args: string[], io: NvIo): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { mode: { type: 'string' }, json: { type: 'boolean' } } });
  const file = positionals[0];
  if (!file) {
    io.err('用法：nv count <file> [--mode han|platform] [--json]');
    return 64;
  }
  let text: string;
  try {
    text = readFileSync(path.resolve(io.cwd, file), 'utf8');
  } catch (e) {
    io.err(`无法读取 ${file}：${e instanceof Error ? e.message : String(e)}`);
    return 66;
  }
  const r = countReport(text, asMode(values.mode));
  if (values.json) {
    io.out(JSON.stringify(r));
    return 0;
  }
  io.out(`总计（${r.mode}）：${r.total}（汉字 ${r.han}，平台口径 ${r.platform}）`);
  for (const [beat, n] of Object.entries(r.beats)) io.out(`  ${beat}: ${n}`);
  return 0;
}

interface Frontmatter {
  out_dir?: string;
  target?: string;
  artifacts?: { path: string; kind: string; length?: { min: number; target: number; max: number; count_mode?: CountMode } }[];
}

function readFrontmatter(file: string): Frontmatter | null {
  try {
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return m ? (yamlParse(m[1] as string) as Frontmatter) : null;
  } catch {
    return null;
  }
}

/** 工作单定位：--workorder > cwd 向上找 in/workorder.md（hook 的 cwd = $RUN/book） */
function findWorkOrder(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    for (const candidate of [path.join(dir, 'in', 'workorder.md'), path.join(dir, '..', 'in', 'workorder.md')]) {
      if (existsSync(candidate)) return candidate;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function readBeatBudgets(card: string | null): { id: string; cjk: number }[] {
  if (!card) return [];
  try {
    const doc = yamlParse(readFileSync(card, 'utf8')) as { beats?: { id?: unknown; cjk?: unknown }[] };
    return (doc.beats ?? []).flatMap((b) => (typeof b.id === 'string' && typeof b.cjk === 'number' ? [{ id: b.id, cjk: b.cjk }] : []));
  } catch {
    return [];
  }
}

function cmdGate(args: string[], io: NvIo): number {
  const { values } = parseArgs({
    args,
    options: {
      quick: { type: 'boolean' },
      report: { type: 'boolean' },
      json: { type: 'boolean' },
      draft: { type: 'string' },
      workorder: { type: 'string' },
      card: { type: 'string' },
      mode: { type: 'string' },
    },
  });
  const report = !!values.report;
  const done = (code: number): number => (report ? 0 : code);
  if (!values.quick) {
    io.err('nv gate 目前只支持 --quick');
    return done(64);
  }
  const workorder = values.workorder ? path.resolve(io.cwd, values.workorder) : findWorkOrder(io.cwd);
  const fm = workorder ? readFrontmatter(workorder) : null;
  const decl = fm?.artifacts?.find((a) => a.kind === 'chapter_draft');
  const draft = values.draft ? path.resolve(io.cwd, values.draft) : decl && fm?.out_dir ? path.join(fm.out_dir, decl.path) : null;
  if (!draft || !existsSync(draft)) {
    io.out('[nv gate --quick] 未找到章节草稿，跳过');
    return 0;
  }
  const text = readFileSync(draft, 'utf8');
  const mode = values.mode ? asMode(values.mode) : (decl?.length?.count_mode ?? 'han');
  const c = countReport(text, mode);
  const cardFile = values.card
    ? path.resolve(io.cwd, values.card)
    : fm?.target && workorder
      ? path.join(path.dirname(workorder), '..', 'book', 'plan', 'cards', `${fm.target}.yaml`)
      : null;
  const budgets = readBeatBudgets(cardFile);
  const markers = new Set([...text.matchAll(new RegExp(BEAT_MARKER_RE.source, 'gm'))].map((m) => m[1] as string));
  const missing = budgets.map((b) => b.id).filter((id) => !markers.has(id));
  const truncation = checkTruncation(text, { sentence: true });
  const range = decl?.length;
  const inRange = range ? c.total >= range.min && c.total <= range.max : true;
  const passed = inRange && missing.length === 0 && truncation.ok;

  if (values.json) {
    io.out(JSON.stringify({ draft, ...c, range: range ?? null, missing_beats: missing, truncation: truncation.ok ? null : truncation.detail, passed }));
    return done(passed ? 0 : 1);
  }
  io.out(`[nv gate --quick] ${path.basename(draft)}`);
  io.out(`字数（${c.mode}）：${c.total}${range ? `，要求 ${range.min}–${range.max}，目标 ${range.target}${inRange ? '' : '（不在区间内）'}` : ''}`);
  for (const [beat, n] of Object.entries(c.beats)) {
    const budget = budgets.find((b) => b.id === beat);
    io.out(`  ${beat}: ${n}${budget ? ` / 预算 ${budget.cjk}` : ''}`);
  }
  if (missing.length) io.out(`缺少 beat 标记：${missing.join('、')}`);
  if (!truncation.ok) io.out(`可能截断：${truncation.detail ?? ''}`);
  return done(passed ? 0 : 1);
}

export function nvMain(argv: string[], io: NvIo = defaultIo()): number {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'count':
        return cmdCount(rest, io);
      case 'gate':
        return cmdGate(rest, io);
      default:
        io.err('用法：nv count <file> | nv gate --quick [--report]');
        return 64;
    }
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return cmd === 'gate' && rest.includes('--report') ? 0 : 1;
  }
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) process.exit(nvMain(process.argv.slice(2)));
