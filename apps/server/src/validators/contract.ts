/**
 * I/O 契约 gate（DESIGN §6.5，不可关闭）：路径正确且只有声明的产物、UTF-8、非空、schema 合法、未截断、receipt 存在且合法。
 * nonce 核对由 instructions.checkNonces 完成，结果以 contract.nonce 规则并入。Owner: lane D。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArtifactDecl, GateResult, Receipt, SchemaName } from '@novelist/shared';
import { SCHEMAS, schemaForPath, zReceipt } from '@novelist/shared';
import { parse as yamlParse } from 'yaml';
import { parseFrontmatter } from '../book/index.js';
import { checkTruncation } from './truncation.js';
import { escapeRegExp } from './util.js';

export { checkTruncation };

export interface ContractInput {
  /** 收割后的 out 目录（live 树 work/<task>/attempt-k/out） */
  outDir: string;
  artifacts: ArtifactDecl[];
  /** 给出时核对 receipt.task_id（缺省不核对） */
  taskId?: string;
}

export interface ContractReport {
  results: GateResult[];
  ok: boolean;
  receipt: Receipt | null;
  /** 解析后的产物（path → 文本 / JSON），供 handler 复用，避免重复读盘 */
  files: Record<string, { text: string; json?: unknown }>;
  extraFiles: string[];
}

const RECEIPT_PATH = 'receipt.json';

const KIND_SCHEMA: Partial<Record<ArtifactDecl['kind'], SchemaName>> = {
  receipt: 'nv.receipt/1',
  delta: 'nv.delta/1',
  check: 'nv.check/1',
  review: 'nv.review/1',
  audit: 'nv.audit/1',
  patches: 'nv.patches/1',
  pairwise: 'nv.pairwise/1',
};

type Syntax = 'json' | 'yaml' | 'frontmatter' | 'text';

function syntaxOf(kind: ArtifactDecl['kind'], rel: string): Syntax {
  switch (kind) {
    case 'chapter_draft':
    case 'summary':
    case 'markdown':
      return 'text';
    case 'bible_md':
      return 'frontmatter';
    case 'plan_yaml':
    case 'yaml':
      return 'yaml';
    case 'json':
    case 'receipt':
    case 'delta':
    case 'check':
    case 'review':
    case 'audit':
    case 'patches':
    case 'pairwise':
      return rel.endsWith('.yaml') || rel.endsWith('.yml') ? 'yaml' : 'json';
  }
}

const isText = (kind: ArtifactDecl['kind']): boolean => syntaxOf(kind, '') === 'text' || kind === 'bible_md';

/** 声明路径 → 匹配器；不合法路径（绝对、..）返回 null */
function declMatcher(p: string): RegExp | null {
  if (path.isAbsolute(p) || p.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return new RegExp(`^${p.split('*').map(escapeRegExp).join('[^/]*')}$`, 'u');
}

async function walk(dir: string, rel = ''): Promise<{ files: string[]; symlinks: string[] }> {
  const out = { files: [] as string[], symlinks: [] as string[] };
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) out.symlinks.push(r);
    else if (e.isDirectory()) {
      const sub = await walk(dir, r);
      out.files.push(...sub.files);
      out.symlinks.push(...sub.symlinks);
    } else if (e.isFile()) out.files.push(r);
  }
  return out;
}

const decodeUtf8 = (buf: Buffer): string | null => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
};

function parseBody(syntax: Syntax, text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    if (syntax === 'json') return { ok: true, value: JSON.parse(text) };
    if (syntax === 'yaml') return { ok: true, value: yamlParse(text) };
    if (syntax === 'frontmatter') {
      const { data } = parseFrontmatter(text);
      if (data === null) return { ok: false, error: '缺少 YAML frontmatter' };
      return { ok: true, value: data };
    }
    return { ok: true, value: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface Collector {
  fails: Map<string, string[]>;
  note(rule: string, detail: string): void;
}

function makeCollector(): Collector {
  const fails = new Map<string, string[]>();
  return {
    fails,
    note(rule, detail) {
      fails.set(rule, [...(fails.get(rule) ?? []), detail]);
    },
  };
}

const RULES = ['contract.path', 'contract.artifacts_exact', 'contract.utf8', 'contract.nonempty', 'contract.schema', 'contract.truncation', 'contract.receipt'] as const;

export async function runContractGates(input: ContractInput): Promise<ContractReport> {
  const c = makeCollector();
  const decls = [...input.artifacts];
  if (!decls.some((d) => d.path === RECEIPT_PATH)) {
    decls.push({ path: RECEIPT_PATH, kind: 'receipt', required: true });
  }
  const { files: found, symlinks } = await walk(input.outDir);
  for (const s of symlinks) c.note('contract.path', `符号链接不是合法产物：${s}`);

  const matchers = decls.map((d) => ({ decl: d, re: declMatcher(d.path) }));
  for (const m of matchers) if (!m.re) c.note('contract.path', `声明路径非法：${m.decl.path}`);

  const claimed = new Map<string, ArtifactDecl>();
  const extraFiles: string[] = [];
  for (const rel of found.sort()) {
    const hit = matchers.find((m) => m.re?.test(rel));
    if (hit) claimed.set(rel, hit.decl);
    else extraFiles.push(rel);
  }
  if (extraFiles.length) c.note('contract.artifacts_exact', `存在未声明的产物：${extraFiles.join('、')}`);

  for (const m of matchers) {
    if (!m.re) continue;
    const n = [...claimed.values()].filter((d) => d === m.decl).length;
    const required = m.decl.required !== false;
    const min = m.decl.min ?? (required ? 1 : 0);
    if (n < min) c.note('contract.path', n === 0 ? `缺少产物：${m.decl.path}` : `产物数量不足：${m.decl.path}（${n}/${min}）`);
    if (m.decl.max !== undefined && n > m.decl.max) c.note('contract.artifacts_exact', `产物过多：${m.decl.path}（${n}/${m.decl.max}）`);
  }

  const files: ContractReport['files'] = {};
  let receipt: Receipt | null = null;
  for (const [rel, decl] of claimed) {
    const buf = await fs.readFile(path.join(input.outDir, rel));
    const text = decodeUtf8(buf);
    if (text === null) {
      c.note('contract.utf8', `不是合法 UTF-8 文本：${rel}`);
      continue;
    }
    files[rel] = { text };
    if (text.trim().length === 0) {
      c.note('contract.nonempty', `空文件：${rel}`);
      continue;
    }

    const syntax = syntaxOf(decl.kind, rel);
    const parsed = parseBody(syntax, text);
    if (!parsed.ok) {
      c.note('contract.schema', `${rel} 解析失败：${parsed.error}`);
      continue;
    }
    let value = parsed.value;
    const schemaName = (decl.schema as SchemaName | undefined) ?? KIND_SCHEMA[decl.kind] ?? (syntax === 'text' ? null : schemaForPath(rel));
    if (schemaName) {
      const schema = SCHEMAS[schemaName];
      if (!schema) c.note('contract.schema', `${rel}：未知 schema ${schemaName}`);
      else {
        const r = schema.safeParse(value);
        if (r.success) value = r.data;
        else {
          const issue = r.error.issues[0];
          c.note('contract.schema', `${rel} 不符合 ${schemaName}：${issue ? `${issue.path.join('.')} ${issue.message}` : '校验失败'}`);
        }
      }
    }
    if (value !== undefined) (files[rel] as { json?: unknown }).json = value;

    if (decl.kind === 'receipt') {
      const r = zReceipt.safeParse(parsed.value);
      if (r.success) {
        receipt = r.data;
        if (input.taskId && r.data.task_id && r.data.task_id !== input.taskId) c.note('contract.receipt', `receipt.task_id 不匹配：${r.data.task_id}`);
      } else c.note('contract.receipt', 'receipt.json 不符合 nv.receipt/1');
    }
    if (isText(decl.kind)) {
      const t = checkTruncation(text, { sentence: decl.kind === 'chapter_draft' });
      if (!t.ok) c.note('contract.truncation', `${rel}：${t.detail ?? '疑似截断'}`);
    }
  }
  if (!receipt && !c.fails.has('contract.receipt')) c.note('contract.receipt', '缺少合法的 receipt.json');

  const results: GateResult[] = RULES.map((rule) => {
    const fail = c.fails.get(rule);
    return {
      rule,
      family: 'contract' as const,
      level: 'hard' as const,
      ok: !fail,
      source: 'novelist' as const,
      spans: [],
      ...(fail ? { detail: fail.join('；') } : {}),
    };
  });
  return { results, ok: results.every((r) => r.ok), receipt, files, extraFiles };
}
