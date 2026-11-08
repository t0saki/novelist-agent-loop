/** 层解析（DESIGN §5.1）。Owner: lane C。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { InstructionLayer, InstructionStack, LayerKind, ResolveStackInput } from './types.js';

/** 内置文件目录：apps/server/src/instructions/builtin（构建后拷到 dist） */
export const BUILTIN_INSTRUCTIONS_DIR = new URL('./builtin/', import.meta.url).pathname;

export const MAX_INCLUDE_DEPTH = 8;

/** S0→C、S1→S1、L1*→G、L2*→R、L3.9→N、L3*→B（§5.2） */
export function nonceTagFor(layerId: string): string {
  if (layerId === 'S0') return 'C';
  if (layerId === 'S1') return 'S1';
  if (layerId === 'L3.9') return 'N';
  if (layerId.startsWith('L1')) return 'G';
  if (layerId.startsWith('L2')) return 'R';
  if (layerId.startsWith('L3')) return 'B';
  throw new Error(`unknown layer id: ${layerId}`);
}

type Reader = (absPath: string) => Promise<string>;

const isMissing = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR';
};

/** drafts（预览的未保存内容，绝对路径 → 文本）优先于磁盘 */
function makeReader(drafts: Record<string, string> | undefined): Reader {
  const map = new Map(Object.entries(drafts ?? {}).map(([k, v]) => [path.resolve(k), v]));
  return async (abs) => {
    const draft = map.get(path.resolve(abs));
    return draft !== undefined ? draft : fs.readFile(abs, 'utf8');
  };
}

async function readOptional(read: Reader, abs: string): Promise<string | null> {
  try {
    return await read(abs);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

const INCLUDE_RE = /^\s*<!--\s*nv:include\s+(\S+?)\s*-->\s*$/;
const LITERAL_OPEN_RE = /^\s*<!--\s*nv:literal\s*-->\s*$/;
const LITERAL_CLOSE_RE = /^\s*<!--\s*\/nv:literal\s*-->\s*$/;
const LITERAL_INLINE_RE = /<!--\s*nv:literal\s*-->(.*?)<!--\s*\/nv:literal\s*-->/g;

/**
 * `<!-- nv:include relative/path.md -->` 独占一行时展开（路径相对于所在文件）；
 * `<!-- nv:literal -->…<!-- /nv:literal -->` 内原样（可独占行成块，也可行内）。
 * root 给出时 include 不得越出该目录（默认 baseDir）。除指令行外，文本逐字保留。
 */
export async function expandIncludes(text: string, baseDir: string, read: (absPath: string) => Promise<string>, depth = 0, root: string = baseDir): Promise<string> {
  if (depth > MAX_INCLUDE_DEPTH) throw new Error(`nv:include 嵌套超过 ${MAX_INCLUDE_DEPTH} 层（循环引用？）：${baseDir}`);
  const out: string[] = [];
  let literal = false;
  for (const line of text.split('\n')) {
    if (literal) {
      if (LITERAL_CLOSE_RE.test(line)) literal = false;
      else out.push(line);
      continue;
    }
    if (LITERAL_OPEN_RE.test(line)) {
      literal = true;
      continue;
    }
    const inc = INCLUDE_RE.exec(line);
    if (!inc) {
      out.push(line.replace(LITERAL_INLINE_RE, '$1'));
      continue;
    }
    const rel = inc[1]!;
    const abs = path.resolve(baseDir, rel);
    const within = path.relative(path.resolve(root), abs);
    if (path.isAbsolute(rel) || within.startsWith('..') || path.isAbsolute(within)) throw new Error(`nv:include 路径越界：${rel}（只能引用 ${root} 内的文件）`);
    let body: string;
    try {
      body = await read(abs);
    } catch (e) {
      if (isMissing(e)) throw new Error(`nv:include 文件不存在：${rel}（在 ${baseDir} 中引用）`);
      throw e;
    }
    out.push((await expandIncludes(body, path.dirname(abs), read, depth + 1, root)).replace(/\r?\n$/, ''));
  }
  return out.join('\n');
}

const EXTENDS_RE = /^﻿?\s*@extends\b[^\n]*(\n|$)/;

/** 首个非空行以 @extends 开头 = 追加；指令行本身不进入正文 */
function parseRoleMode(text: string): { mode: 'replace' | 'extends'; content: string } {
  const m = EXTENDS_RE.exec(text);
  return m ? { mode: 'extends', content: text.slice(m[0].length) } : { mode: 'replace', content: text };
}

interface LayerSpec {
  id: string;
  kind: LayerKind;
  label: string;
  owner: 'novelist' | 'user';
  file: string;
  root: string;
  isRole?: boolean;
  required?: boolean;
}

export async function resolveStack(input: ResolveStackInput): Promise<InstructionStack> {
  const read = makeReader(input.drafts);
  const { role, taskKind } = input;
  if (taskKind && !/^[a-z0-9_.-]+$/.test(taskKind)) throw new Error(`非法 taskKind：${taskKind}`);

  const specs: LayerSpec[] = [
    { id: 'S0', kind: 'S0', label: 'S0 文件机制', owner: 'novelist', file: path.join(BUILTIN_INSTRUCTIONS_DIR, 'contract.md'), root: BUILTIN_INSTRUCTIONS_DIR, required: true },
    { id: 'S1', kind: 'S1', label: `S1 内置角色 ${role}`, owner: 'novelist', file: path.join(BUILTIN_INSTRUCTIONS_DIR, 'roles', `${role}.md`), root: BUILTIN_INSTRUCTIONS_DIR, required: true, isRole: true },
    { id: 'L1', kind: 'L1', label: 'L1 全局 AGENTS.md', owner: 'user', file: path.join(input.globalDir, 'AGENTS.md'), root: input.globalDir },
    { id: 'L1.role', kind: 'L1', label: `L1 全局角色 ${role}`, owner: 'user', file: path.join(input.globalDir, 'roles', `${role}.md`), root: input.globalDir, isRole: true },
  ];
  if (taskKind) specs.push({ id: 'L1.task', kind: 'L1', label: `L1 全局任务 ${taskKind}`, owner: 'user', file: path.join(input.globalDir, 'tasks', `${taskKind}.md`), root: input.globalDir });
  for (const g of input.genreDirs) {
    specs.push({ id: `L2:${g.id}`, kind: 'L2', label: `L2 题材 ${g.id}`, owner: 'user', file: path.join(g.dir, 'AGENTS.md'), root: g.dir });
    specs.push({ id: `L2:${g.id}.role`, kind: 'L2', label: `L2 题材 ${g.id} 角色 ${role}`, owner: 'user', file: path.join(g.dir, 'roles', `${role}.md`), root: g.dir, isRole: true });
  }
  if (input.bookDir) {
    const inst = path.join(input.bookDir, 'instructions');
    specs.push({ id: 'L3', kind: 'L3', label: 'L3 书 AGENTS.md', owner: 'user', file: path.join(inst, 'AGENTS.md'), root: input.bookDir, required: true });
    specs.push({ id: 'L3.role', kind: 'L3', label: `L3 书角色 ${role}`, owner: 'user', file: path.join(inst, 'roles', `${role}.md`), root: input.bookDir, isRole: true });
    if (taskKind) specs.push({ id: 'L3.task', kind: 'L3', label: `L3 书任务 ${taskKind}`, owner: 'user', file: path.join(inst, 'tasks', `${taskKind}.md`), root: input.bookDir });
  }

  const layers: InstructionLayer[] = [];
  for (const s of specs) {
    const raw = await readOptional(read, s.file);
    // L3 永远占位：保证“最后一个作者块来自书层”；其余空文件视同不存在
    if (raw === null || raw.trim() === '') {
      if (s.id === 'L3') layers.push({ id: s.id, kind: s.kind, label: s.label, owner: s.owner, source: s.file, content: raw ?? '', mode: 'extends', nonceTag: nonceTagFor(s.id) });
      else if (s.required && s.owner === 'novelist') throw new Error(`内置指令缺失或为空：${s.file}`);
      continue;
    }
    const parsed = s.isRole ? parseRoleMode(raw) : { mode: 'extends' as const, content: raw };
    const content = await expandIncludes(parsed.content, path.dirname(s.file), read, 0, s.root);
    layers.push({ id: s.id, kind: s.kind, label: s.label, owner: s.owner, source: s.file, content, mode: parsed.mode, nonceTag: nonceTagFor(s.id) });
  }

  const notes = input.ownerNotes.filter((n) => n.text.trim() !== '');
  if (notes.length > 0) {
    layers.push({
      id: 'L3.9',
      kind: 'L3.9',
      label: 'L3.9 owner 本章笔记',
      owner: 'user',
      source: notes.map((n) => n.source).join(','),
      content: notes.map((n) => n.text).join('\n\n'),
      mode: 'extends',
      nonceTag: 'N',
    });
  }

  // 角色文件：非 @extends 只替换同一来源层内更低的同名角色（题材继承链 base→self）。
  // 全局 / 题材 / 书是用户自己写的不同来源层，互不删除，靠“后出现者优先”覆盖（IMPL §3.4）。
  const roleIds = new Set(specs.filter((s) => s.isRole).map((s) => s.id));
  const dropped = new Set<string>();
  const chain = layers.filter((l) => roleIds.has(l.id));
  chain.forEach((l, i) => {
    if (l.mode === 'replace') for (const prev of chain.slice(0, i)) if (prev.kind === l.kind) dropped.add(prev.id);
  });
  const replaced = layers.filter((l) => dropped.has(l.id)).map(({ id, label, source }) => ({ id, label, source }));
  return { role, taskKind, genreChain: input.genreDirs.map((g) => g.id), layers: layers.filter((l) => !dropped.has(l.id)), replaced };
}
