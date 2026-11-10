/**
 * 书库文件的类型化读取。旧流程的规划 / 正典 / 账本读取已删除，只剩 book.yaml、正文与种子。
 * rev 省略 = 工作树；run 内（快照目录）直接 openRepo(snapshotDir) 读取。
 * 解析失败抛 CanonicalParseError（带相对路径与 zod issues），调用方决定怎么处理。
 */
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { z } from 'zod';
import { stripBeatMarkers, zBookConfig } from '@novelist/shared';
import type { BookConfig } from '@novelist/shared';
import { P } from './layout.js';
import { V3_SEED_FILE, type BookRepo } from './repo.js';

export class CanonicalParseError extends Error {
  constructor(
    public readonly path: string,
    public readonly issues: { path: string; message: string }[],
  ) {
    super(`invalid ${path}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }
}

export interface BookFiles {
  config(rev?: string): Promise<{ raw: string; config: BookConfig }>;
  /** 正文（已剥离 beat 标记的定稿） */
  manuscript(no: number, rev?: string): Promise<string | null>;
  /** 种子：v3 书的 seed.md，旧书的 bible/premise.md */
  premise(rev?: string): Promise<string>;
}

function issuesOf(err: z.ZodError, prefix = ''): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: prefix + i.path.map(String).join('.'), message: i.message }));
}

/** 解析 YAML 文本并用 schema 校验；语法错误也转成 CanonicalParseError */
export function parseYamlAs<T>(rel: string, text: string, schema: z.ZodType<T>): T {
  let data: unknown;
  try {
    data = yamlParse(text);
  } catch (e) {
    throw new CanonicalParseError(rel, [{ path: '', message: `YAML: ${(e as Error).message}` }]);
  }
  const r = schema.safeParse(data);
  if (!r.success) throw new CanonicalParseError(rel, issuesOf(r.error));
  return r.data;
}

/** YAML frontmatter + markdown 正文。没有 frontmatter 时 data=null */
export function parseFrontmatter(md: string): { data: unknown; body: string } {
  const text = md.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n/.exec(text);
  if (!m) return { data: null, body: text };
  const rest = text.slice(m[0].length);
  const end = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!end) return { data: null, body: text };
  const yamlText = rest.slice(0, end.index);
  let body = rest.slice(end.index + end[0].length);
  body = body.replace(/^\r?\n/, '');
  return { data: yamlText.trim() === '' ? {} : yamlParse(yamlText), body };
}

export function formatFrontmatter(data: unknown, body: string): string {
  const y = yamlStringify(data ?? {}, { lineWidth: 0 });
  return `---\n${y}---\n\n${body.replace(/^\r?\n/, '')}`;
}

export function bookFiles(repo: BookRepo): BookFiles {
  return {
    async config(rev) {
      const raw = await repo.readFile(P.bookYaml, rev);
      if (raw === null) throw new CanonicalParseError(P.bookYaml, [{ path: '', message: 'book.yaml 不存在' }]);
      return { raw, config: parseYamlAs(P.bookYaml, raw, zBookConfig) };
    },
    async manuscript(no, rev) {
      const t = await repo.readFile(P.manuscript(no), rev);
      return t === null ? null : stripBeatMarkers(t);
    },
    async premise(rev) {
      return (await repo.readFile(V3_SEED_FILE, rev)) ?? (await repo.readFile(P.premise, rev)) ?? '';
    },
  };
}
