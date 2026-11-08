import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type HarnessId, type NEvent, ROLE_IDS, type RoleId, type TaskKind, zGatesFile } from '@novelist/shared';
import { parse as tomlParse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { dataPaths } from '../config/index.js';
import { BUILTIN_GENRES_DIR, loadGenre, seedBuiltinGenres } from '../genres/index.js';
import { defaultCapabilities } from '../harness/probe.js';
import type { RunSpec } from '../harness/types.js';
import { checkBudget, KNOWN_LIMITS } from './budget.js';
import { checkNonces, compileInstructions, generateNonces, measure } from './compile.js';
import { BUILTIN_INSTRUCTIONS_DIR, expandIncludes, resolveStack } from './layers.js';
import { escapeDshTemplate, materializeFor, tomlBasicString } from './materialize/index.js';
import { previewInstructions } from './preview.js';
import type { CompiledInstructions, InstructionStack, ResolveStackInput } from './types.js';
import { isWorkspaceDocModified, renderSkills, renderWorkspaceDoc, skillIndex } from './workspace.js';

vi.mock('../validators/index.js', () => ({
  BUILTIN_GATES: { schema: 'nv.gates/1', rules: {} },
  resolveEffectiveGates: (layers: { genre: { genre: string }[]; bookOverrides: Record<string, unknown> }) => [
    ...layers.genre.map((g) => ({ rule: `from:${g.genre}`, family: 'craft', level: 'soft', params: {}, allow: [], source: 'genre' })),
    ...Object.keys(layers.bookOverrides).map((rule) => ({ rule, family: 'craft', level: 'off', params: {}, allow: [], source: 'book' })),
  ],
}));

let root: string;
let globalDir: string;
let bookDir: string;
let genreA: string;
let genreB: string;

const write = async (abs: string, text: string) => {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-instr-'));
  globalDir = path.join(root, 'global');
  bookDir = path.join(root, 'book');
  genreA = path.join(root, 'genres/base');
  genreB = path.join(root, 'genres/self');
  await fs.mkdir(globalDir, { recursive: true });
  await fs.mkdir(path.join(bookDir, 'instructions'), { recursive: true });
  await fs.mkdir(genreA, { recursive: true });
  await fs.mkdir(genreB, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function input(over: Partial<ResolveStackInput> = {}): ResolveStackInput {
  return { globalDir, genreDirs: [{ id: 'base', dir: genreA }, { id: 'self', dir: genreB }], bookDir, role: 'writer', taskKind: 'chapter.write', ownerNotes: [], ...over };
}

const ids = (s: InstructionStack) => s.layers.map((l) => l.id);

function spec(harness: HarnessId, over: Partial<RunSpec> = {}): RunSpec {
  const run = path.join(root, 'run');
  return {
    runId: 'r1',
    taskId: 't1',
    attempt: 1,
    role: 'writer',
    taskKind: 'chapter.write',
    harness,
    profileId: 'p',
    accountId: null,
    bookSlug: 'b',
    runDir: run,
    bookDir: path.join(run, 'book'),
    outDir: path.join(run, 'book/out'),
    inDir: path.join(run, 'in'),
    logDir: path.join(run, 'log'),
    workOrderFile: path.join(run, 'in/workorder.md'),
    systemFile: path.join(run, 'in/system.md'),
    receiptSchemaFile: path.join(run, 'in/receipt.json'),
    model: 'm',
    limits: { wallMs: 0, idleMs: 0, maxTurns: 0 },
    session: { mode: 'fresh', id: 's' },
    persistSession: false,
    egress: { allow: [] },
    subagents: false,
    extraArgs: [],
    ...over,
  };
}

function compiledOf(systemMd: string): CompiledInstructions {
  return { systemMd, mirrorMd: systemMd, layers: [], nonces: {}, stackHash: 'abcdef0123456789', bytes: Buffer.byteLength(systemMd), lastAuthorLayerId: 'L3' };
}

const caps = (h: HarnessId, over = {}) => ({ ...defaultCapabilities(h, 'v', 'container'), ...over });
const materialize = (h: HarnessId, compiled: CompiledInstructions, extra: Partial<Parameters<typeof materializeFor>[1]> = {}, capOver = {}) =>
  materializeFor(h, { harness: h, spec: spec(h), compiled, caps: caps(h, capOver), personaMode: 'append', home: path.join(root, 'home'), ...extra });

describe('resolveStack：层顺序（golden）', () => {
  it('所有层都存在时按 §5.1 排序', async () => {
    await write(path.join(globalDir, 'AGENTS.md'), 'g');
    await write(path.join(globalDir, 'roles/writer.md'), '@extends\ngr');
    await write(path.join(globalDir, 'tasks/chapter.write.md'), 'gt');
    await write(path.join(genreA, 'AGENTS.md'), 'a');
    await write(path.join(genreA, 'roles/writer.md'), '@extends\nar');
    await write(path.join(genreB, 'AGENTS.md'), 'b');
    await write(path.join(genreB, 'roles/writer.md'), '@extends\nbr');
    await write(path.join(bookDir, 'instructions/AGENTS.md'), 'book');
    await write(path.join(bookDir, 'instructions/roles/writer.md'), '@extends\nbkr');
    await write(path.join(bookDir, 'instructions/tasks/chapter.write.md'), 'bkt');
    const s = await resolveStack(input({ ownerNotes: [{ source: 'card:c00001', text: '本章笔记' }] }));
    expect(ids(s)).toEqual(['S0', 'S1', 'L1', 'L1.role', 'L1.task', 'L2:base', 'L2:base.role', 'L2:self', 'L2:self.role', 'L3', 'L3.role', 'L3.task', 'L3.9']);
  });

  it('任意层组合下最后一个作者块都来自 L3 或 L3.9', async () => {
    const flags = [0, 1];
    for (const hasGlobal of flags)
      for (const hasGlobalRole of flags)
        for (const genreCount of [0, 1, 2])
          for (const hasBookAgents of flags)
            for (const hasBookRole of flags)
              for (const hasTask of flags)
                for (const hasNote of flags) {
                  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
                  await fs.mkdir(path.join(bookDir, 'instructions'), { recursive: true });
                  await fs.mkdir(globalDir, { recursive: true });
                  if (hasGlobal) await write(path.join(globalDir, 'AGENTS.md'), 'G');
                  if (hasGlobalRole) await write(path.join(globalDir, 'roles/writer.md'), 'GR');
                  if (hasBookAgents) await write(path.join(bookDir, 'instructions/AGENTS.md'), 'B');
                  if (hasBookRole) await write(path.join(bookDir, 'instructions/roles/writer.md'), 'BR');
                  if (hasTask) await write(path.join(bookDir, 'instructions/tasks/chapter.write.md'), 'BT');
                  const genreDirs = [{ id: 'base', dir: genreA }, { id: 'self', dir: genreB }].slice(0, genreCount);
                  for (const g of genreDirs) await write(path.join(g.dir, 'AGENTS.md'), g.id);
                  const stack = await resolveStack(input({ genreDirs, ownerNotes: hasNote ? [{ source: 'card:c1', text: 'NOTE' }] : [] }));
                  const compiled = compileInstructions(stack, { nonces: 'placeholder' });
                  expect(compiled.lastAuthorLayerId).toMatch(/^L3(\.role|\.task|\.9)?$/);
                  const lastHeader = [...compiled.systemMd.matchAll(/^=== (.+?) ===/gm)].at(-1)![1]!;
                  expect(lastHeader.startsWith('L3')).toBe(true);
                }
  });

  it('书层 AGENTS.md 不存在时仍占位 L3（保证作者优先）', async () => {
    const s = await resolveStack(input({ genreDirs: [] }));
    expect(ids(s)).toContain('L3');
    expect(s.layers.find((l) => l.id === 'L3')?.content).toBe('');
  });

  it('无书任务：无 L3，最后一个作者块是最后的 L1/L2', async () => {
    await write(path.join(globalDir, 'AGENTS.md'), 'G');
    await write(path.join(genreB, 'AGENTS.md'), 'B');
    const s = await resolveStack(input({ bookDir: null, taskKind: null }));
    expect(compileInstructions(s, { nonces: 'placeholder' }).lastAuthorLayerId).toBe('L2:self');
  });

  it('角色文件：@extends 追加；替换只在同一来源层内生效（题材链 base→self），不跨全局/题材/书', async () => {
    await write(path.join(globalDir, 'roles/writer.md'), '全局写手');
    await write(path.join(genreA, 'roles/writer.md'), '@extends\n题材追加');
    const a = await resolveStack(input());
    expect(ids(a)).toContain('S1');
    expect(ids(a)).toEqual(expect.arrayContaining(['L1.role', 'L2:base.role']));
    expect(a.layers.find((l) => l.id === 'L2:base.role')).toMatchObject({ mode: 'extends', content: '题材追加' });

    await write(path.join(genreB, 'roles/writer.md'), '题材完全替换');
    const b = await resolveStack(input());
    expect(ids(b)).toContain('S1');
    expect(ids(b)).toContain('L1.role');
    expect(ids(b)).not.toContain('L2:base.role');
    expect(ids(b)).toContain('L2:self.role');
    expect(ids(b).indexOf('L2:self.role')).toBeLessThan(ids(b).indexOf('L3'));
    expect(b.replaced?.map((l) => l.id)).toEqual(['L2:base.role']);
  });

  it('全部 @extends 时 S1 保留', async () => {
    await write(path.join(globalDir, 'roles/writer.md'), '@extends 任意说明\n追加');
    const s = await resolveStack(input());
    expect(ids(s)).toContain('S1');
    expect(s.layers.find((l) => l.id === 'L1.role')!.content).toBe('追加');
  });

  it('空文件视同不存在（L3 除外）', async () => {
    await write(path.join(globalDir, 'AGENTS.md'), '  \n');
    await write(path.join(genreA, 'roles/writer.md'), '');
    const s = await resolveStack(input());
    expect(ids(s)).not.toContain('L1');
    expect(ids(s)).toContain('S1');
  });

  it('drafts 优先于磁盘；owner 笔记合并为一层；空笔记被忽略', async () => {
    await write(path.join(bookDir, 'instructions/AGENTS.md'), '旧');
    const s = await resolveStack(input({ drafts: { [path.join(bookDir, 'instructions/AGENTS.md')]: '新草稿' }, ownerNotes: [{ source: 'card:c1', text: '一' }, { source: 'inbox:x', text: '  ' }, { source: 'inbox:y', text: '二' }] }));
    expect(s.layers.find((l) => l.id === 'L3')!.content).toBe('新草稿');
    expect(s.layers.find((l) => l.id === 'L3.9')).toMatchObject({ content: '一\n\n二', source: 'card:c1,inbox:y' });
  });
});

describe('expandIncludes', () => {
  const read = async (p: string) => {
    throw Object.assign(new Error(p), { code: 'ENOENT' });
  };

  it('展开独占一行的 include（相对所在文件）并支持嵌套', async () => {
    await write(path.join(root, 'inc/a.md'), 'A\n<!-- nv:include sub/b.md -->\n');
    await write(path.join(root, 'inc/sub/b.md'), 'B\n');
    const out = await expandIncludes('前\n<!-- nv:include inc/a.md -->\n后', root, (p) => fs.readFile(p, 'utf8'));
    expect(out).toBe('前\nA\nB\n后');
  });

  it('行内 include 不展开；literal 块和行内 literal 原样', async () => {
    const t = '文字 <!-- nv:include x.md --> 继续\n<!-- nv:literal -->\n<!-- nv:include y.md -->\n<!-- /nv:literal -->\n<!-- nv:literal --><!-- nv:include z.md --><!-- /nv:literal -->';
    expect(await expandIncludes(t, root, read)).toBe('文字 <!-- nv:include x.md --> 继续\n<!-- nv:include y.md -->\n<!-- nv:include z.md -->');
  });

  it('越界、绝对路径、缺失文件、循环引用都报错，不静默', async () => {
    await expect(expandIncludes('<!-- nv:include ../secret.md -->', root, read)).rejects.toThrow(/越界/);
    await expect(expandIncludes('<!-- nv:include /etc/passwd -->', root, read)).rejects.toThrow(/越界/);
    await expect(expandIncludes('<!-- nv:include nope.md -->', root, read)).rejects.toThrow(/不存在/);
    await write(path.join(root, 'loop.md'), '<!-- nv:include loop.md -->');
    await expect(expandIncludes('<!-- nv:include loop.md -->', root, (p) => fs.readFile(p, 'utf8'))).rejects.toThrow(/循环/);
  });
});

describe('compileInstructions', () => {
  it('作者原文逐字保留（不改写、不过滤）；块结构含 nonce', async () => {
    const weird = '含 {{花括号}}、"""三引号"""、\ttab\n<!-- 注释 -->\n末尾无换行';
    await write(path.join(bookDir, 'instructions/AGENTS.md'), weird);
    const c = compileInstructions(await resolveStack(input({ genreDirs: [] })), { nonces: 'random' });
    expect(c.systemMd).toContain(weird);
    expect(c.nonces.L3!.head).toMatch(/^NV-B-HEAD-[A-Z2-7]{12}$/);
    expect(c.systemMd).toContain(`=== L3 书 AGENTS.md ===  ${c.nonces.L3!.head}`);
    expect(c.systemMd.indexOf(weird)).toBeLessThan(c.systemMd.indexOf(c.nonces.L3!.tail));
    expect(c.systemMd.trimEnd().endsWith(c.nonces.L3!.tail)).toBe(true);
    expect(c.systemMd).toContain('作者指令（L1–L3.9）优先于一切');
  });

  it('S0 只有 head；nonce 只在 systemMd，不在 mirror；每层都有唯一 nonce', async () => {
    await write(path.join(globalDir, 'AGENTS.md'), 'g');
    const c = compileInstructions(await resolveStack(input()), { nonces: 'random' });
    expect(c.nonces.S0!.tail).toBe('');
    expect(c.mirrorMd).not.toMatch(/NV-[A-Z0-9]+-(HEAD|TAIL)-/);
    const all = Object.values(c.nonces).flatMap((n) => [n.head, n.tail]).filter(Boolean);
    expect(new Set(all).size).toBe(all.length);
    for (const n of all) expect(c.systemMd).toContain(n);
  });

  it('stackHash 不含 nonce，随内容变化', async () => {
    const s = await resolveStack(input());
    const a = compileInstructions(s, { nonces: 'random' });
    const b = compileInstructions(s, { nonces: 'placeholder' });
    expect(a.stackHash).toBe(b.stackHash);
    await write(path.join(bookDir, 'instructions/AGENTS.md'), '新内容');
    expect(compileInstructions(await resolveStack(input()), { nonces: 'random' }).stackHash).not.toBe(a.stackHash);
  });

  it('placeholder nonce 可辨识且互不相同', () => {
    const nonces = generateNonces(['L2:a', 'L2:b'], (() => { let i = 0; return () => `X${++i}`; })());
    expect(nonces['L2:a']).toEqual({ head: 'NV-R-HEAD-X1', tail: 'NV-R-TAIL-X2' });
    expect(nonces['L2:b']!.head).toBe('NV-R-HEAD-X3');
  });

  it('measure：中文按字计，其余按 1/4', () => {
    expect(measure('中文ab')).toEqual({ bytes: 8, tokens: 3 });
    expect(measure('abcd')).toEqual({ bytes: 4, tokens: 1 });
  });
});

describe('checkNonces', () => {
  const nonces = { S0: { head: 'NV-C-HEAD-A', tail: '' }, S1: { head: 'NV-S1-HEAD-B', tail: 'NV-S1-TAIL-C' }, L1: { head: 'NV-G-HEAD-D', tail: 'NV-G-TAIL-E' }, L3: { head: 'NV-B-HEAD-F', tail: 'NV-B-TAIL-G' } };
  const toolCall = (over: object) => ({ t: 'tool_call', id: '1', name: 'Read', kind: 'read', seq: 0, ts: '', runId: 'r', ...over }) as unknown as NEvent;
  const inDir = '/run/in';
  const all = ['NV-C-HEAD-A', 'NV-S1-HEAD-B', 'NV-S1-TAIL-C', 'NV-G-HEAD-D', 'NV-G-TAIL-E', 'NV-B-HEAD-F', 'NV-B-TAIL-G'];

  it('全部回显：ok', () => {
    const r = checkNonces({ nonces, echoed: all, events: [], inDir, role: 'writer' });
    expect(r).toMatchObject({ ok: true, tainted: false, missingTail: [] });
  });

  it('writer 缺作者层 TAIL：ok=false；HEAD 在 TAIL 缺说明尾部被截断', () => {
    const r = checkNonces({ nonces, echoed: all.filter((n) => n !== 'NV-B-TAIL-G'), events: [], inDir, role: 'writer' });
    expect(r.ok).toBe(false);
    expect(r.missingTail).toEqual(['L3']);
    expect(r.layers.find((l) => l.layer === 'L3')).toEqual({ layer: 'L3', head: true, tail: false });
  });

  it('其他角色缺失只记录，ok=true；S1 TAIL 缺失不影响', () => {
    expect(checkNonces({ nonces, echoed: [], events: [], inDir, role: 'summarizer' }).ok).toBe(true);
    expect(checkNonces({ nonces, echoed: all.filter((n) => n !== 'NV-S1-TAIL-C'), events: [], inDir, role: 'writer' }).ok).toBe(true);
  });

  it('读过 system.md / 执行 cat 含 nonce 文件：tainted，回显不算', () => {
    for (const ev of [toolCall({ paths: ['/run/in/system.md'] }), toolCall({ command: 'cat /run/in/system.md' }), toolCall({ command: 'cat ../in/dsh.patch.yml' }), toolCall({ paths: ['/run/book/.agents/agents/nv-writer-abc.md'] })]) {
      const r = checkNonces({ nonces, echoed: all, events: [ev], inDir, role: 'writer' });
      expect(r.tainted, JSON.stringify(ev)).toBe(true);
      expect(r.ok).toBe(false);
    }
  });

  it('读 work order、书库里的 system.md 不算违规', () => {
    for (const ev of [toolCall({ paths: ['/run/in/workorder.md'] }), toolCall({ paths: ['/run/book/bible/power-system.md'] }), toolCall({ paths: ['/run/book/bible/system.md'] })]) {
      expect(checkNonces({ nonces, echoed: all, events: [ev], inDir, role: 'writer' }).tainted, JSON.stringify(ev)).toBe(false);
    }
  });
});

describe('checkBudget', () => {
  it('超限拒绝，给出原因；caps 上限更严时取较小者', () => {
    const big = compiledOf('字'.repeat(7000));
    const r = checkBudget('agy', big, null);
    expect(r).toMatchObject({ ok: false, limit: KNOWN_LIMITS.agy });
    expect(r.reason).toMatch(/压缩该层或换 harness/);
    expect(checkBudget('claude-code', big, null)).toMatchObject({ ok: true, limit: null });
    expect(checkBudget('claude-code', big, { maxInstructionBytes: 100 } as never)).toMatchObject({ ok: false, limit: 100 });
  });
});

describe('tomlBasicString（golden）', () => {
  const samples = ['纯中文\n换行', 'tab\t引号"反斜杠\\', 'DEL\u007f结束', '控制\u0001\u001f字符', `"""三引号"""\n${'长'.repeat(10000)}`, '\u{1F600}'];
  for (const s of samples) {
    it(`往返解析 ${JSON.stringify(s).slice(0, 24)}`, () => {
      const lit = tomlBasicString(s);
      expect(lit).not.toMatch(/\n/);
      expect(tomlParse(`developer_instructions = ${lit}`)).toEqual({ developer_instructions: s });
    });
  }
  it('DEL 和控制字符转义为 \\uXXXX', () => {
    expect(tomlBasicString('\u007f')).toBe('"\\u007f"');
    expect(tomlBasicString('\u0001')).toBe('"\\u0001"');
  });
  it('孤立代理项断言失败', () => {
    expect(() => tomlBasicString('\ud800')).toThrow(/代理项/);
  });
});

describe('materializeFor', () => {
  const compiled = compiledOf('# 指令\nNV-G-HEAD-X\n');

  it('claude-code：append / replace；Stop hook 只在 verified 时启用', async () => {
    const r = await materialize('claude-code', compiled);
    expect(r.argv).toEqual(['--append-system-prompt-file', spec('claude-code').systemFile]);
    expect(r.files).toEqual([{ path: spec('claude-code').systemFile, content: compiled.systemMd }]);
    const rep = await materialize('claude-code', compiled, { personaMode: 'replace' }, { systemReplace: true });
    expect(rep.argv[0]).toBe('--system-prompt-file');
    const hooked = await materialize('claude-code', compiled, {}, { stopHook: 'verified' });
    expect(hooked.argv).toContain('--settings');
    const settings = hooked.files.find((f) => f.path.endsWith('cc.settings.json'))!;
    expect(JSON.parse(settings.content).hooks.Stop[0].hooks[0].command).toContain('gate --quick --report');
  });

  it('codex：developer_instructions 单个 argv 元素，TOML 可解析；replace 用 model_instructions_file', async () => {
    const r = await materialize('codex', compiledOf('行一\n"引号"\u007f'));
    expect(r.argv[0]).toBe('-c');
    expect(tomlParse(r.argv[1]!)).toEqual({ developer_instructions: '行一\n"引号"\u007f' });
    const rep = await materialize('codex', compiled, { personaMode: 'replace' }, { systemReplace: true });
    expect(tomlParse(rep.argv[1]!)).toEqual({ model_instructions_file: spec('codex').systemFile });
  });

  it('codex：转义后超限也拒绝', async () => {
    const r = await materialize('codex', compiledOf('\n'.repeat(60_000)));
    expect(r.budget.ok).toBe(false);
    expect(r.argv).toEqual([]);
  });

  it('grok：--rules 文本 / --system-prompt-override；NUL 拒绝', async () => {
    const r = await materialize('grok', compiled);
    expect(r.argv).toEqual(['--rules', compiled.systemMd]);
    expect((await materialize('grok', compiled, { personaMode: 'replace' }, { systemReplace: true })).argv[0]).toBe('--system-prompt-override');
    expect((await materialize('grok', compiledOf('a\0b'))).budget.ok).toBe(false);
  });

  it('agy：--agent 文件在本 run workspace，文件名不含下划线，frontmatter 可解析', async () => {
    const r = await materialize('agy', compiled, { spec: spec('agy', { role: 'format_checker' }) });
    expect(r.argv).toEqual(['--agent', 'nv-format-checker-abcdef01']);
    const f = r.files.find((x) => x.path.includes('.agents/agents/'))!;
    expect(f.path).toBe(path.join(spec('agy').bookDir, '.agents/agents/nv-format-checker-abcdef01.md'));
    const m = /^---\n([\s\S]*?)---\n\n([\s\S]*)$/.exec(f.content)!;
    expect(yamlParse(m[1]!)).toMatchObject({ name: 'nv-format-checker-abcdef01', mainAgent: true, subagent: false });
    expect(m[2]).toBe(compiled.systemMd);
  });

  it('agy：frontmatter 计入 20,000 字节上限；AGENTS.md 超限也拒绝', async () => {
    const edge = compiledOf('a'.repeat(19_990));
    expect((await materialize('agy', edge)).budget.ok).toBe(false);
    const ok = await materialize('agy', compiledOf('a'.repeat(10_000)), { workspaceDoc: 'x'.repeat(21_000) });
    expect(ok.budget).toMatchObject({ ok: false });
    expect(ok.budget.reason).toMatch(/AGENTS\.md/);
    expect((await materialize('agy', compiled, { workspaceDoc: '小文档' })).budget.ok).toBe(true);
  });

  it('agy：不支持 replace 时退回 append 并说明', async () => {
    const r = await materialize('agy', compiled, { personaMode: 'replace' }, { systemReplace: false });
    expect(r.budget.ok).toBe(true);
    expect(r.notes.join()).toMatch(/退回 append/);
  });

  it('dsh：personaSuffix YAML 往返；无闭合 {{ 字面保留；可解析的 {{ 拒绝', async () => {
    const r = await materialize('dsh', compiledOf('甲\n单独的 {{ 不闭合\n'));
    const patch = yamlParse(r.files.find((f) => f.path.endsWith('dsh.patch.yml'))!.content);
    expect(patch[0]).toEqual({ id: 'system-prompt', config: { personaSuffix: '甲\n单独的 {{ 不闭合\n' } });
    expect(r.argv).toEqual(['--patch', path.join(spec('dsh').inDir, 'dsh.patch.yml')]);
    const bad = await materialize('dsh', compiledOf('使用 {{model}} 变量'));
    expect(bad.budget.ok).toBe(false);
    expect(bad.budget.reason).toMatch(/templateEscaping: incompatible/);
    expect(escapeDshTemplate('纯文本')).toBe('纯文本');
    expect(escapeDshTemplate('}} 在前 {{')).toBe('}} 在前 {{');
    expect(escapeDshTemplate('{{}}')).toBeNull();
    expect(escapeDshTemplate('{{ 中文 }}')).toBeNull();
  });

  it('pi 和 fake', async () => {
    expect((await materialize('pi', compiled)).argv).toEqual(['--append-system-prompt', spec('pi').systemFile]);
    expect((await materialize('pi', compiled, { personaMode: 'replace' }, { systemReplace: true })).argv[0]).toBe('--system-prompt');
    expect((await materialize('fake', compiled)).argv).toEqual(['--system', spec('fake').systemFile]);
  });

  it('未知 harness：拒绝而不是抛错', async () => {
    const r = await materializeFor('acp:x', { harness: 'acp:x', spec: spec('fake'), compiled, caps: caps('fake'), personaMode: 'append', home: root });
    expect(r.budget.ok).toBe(false);
  });
});

describe('workspace doc', () => {
  it('首行固定、含 L0 契约和地图、不含 nonce', () => {
    const d = renderWorkspaceDoc({ bookTitle: '示例', contract: '只写 out_dir', skills: [{ name: 's1', description: '做某事' }] });
    expect(d.split('\n')[0]).toBe('本文件由 Novelist 生成；你的书层指令在 instructions/AGENTS.md');
    expect(d).toContain('《示例》');
    expect(d).toContain('只写 out_dir');
    expect(d).toContain('作者指令在你的 system prompt 中');
    expect(d).toContain('`s1`：做某事');
    expect(d).not.toMatch(/NV-[A-Z]+-HEAD/);
  });

  it('isWorkspaceDocModified 忽略换行差异', () => {
    expect(isWorkspaceDocModified('a\r\nb\n', 'a\nb')).toBe(false);
    expect(isWorkspaceDocModified('a\nc', 'a\nb')).toBe(true);
  });

  it('renderSkills：书 > 题材 > 全局，frontmatter 只留规范字段，正文原样', async () => {
    const skill = (desc: string, extra = '') => `---\nname: x\ndescription: ${desc}\n${extra}---\n正文 ${desc}\n`;
    await write(path.join(globalDir, 'skills/shared/SKILL.md'), skill('全局', 'custom: 1\n'));
    await write(path.join(globalDir, 'skills/only-global/SKILL.md'), skill('仅全局'));
    await write(path.join(globalDir, 'skills/only-global/data.bin'), '');
    await write(path.join(genreA, 'skills/shared/SKILL.md'), skill('题材'));
    await write(path.join(genreA, 'skills/only-global/helper.md'), '不应混入');
    await fs.rm(path.join(genreA, 'skills/only-global'), { recursive: true });
    await write(path.join(bookDir, 'instructions/skills/shared/SKILL.md'), skill('书', 'custom: 2\nlicense: MIT\n'));
    const files = await renderSkills({ bookDir, genreDirs: [genreA, genreB], globalDir });
    expect(files.map((f) => f.path).sort()).toEqual(['.agents/skills/only-global/SKILL.md', '.agents/skills/only-global/data.bin', '.agents/skills/shared/SKILL.md']);
    const shared = files.find((f) => f.path.endsWith('shared/SKILL.md'))!;
    expect(shared.content).toContain('正文 书');
    expect(shared.content).toContain('license: MIT');
    expect(shared.content).not.toContain('custom');
    expect(skillIndex(files)).toContainEqual({ name: 'shared', description: '书' });
  });
});

describe('previewInstructions', () => {
  it('编译 + 物化 + 生效 gate 来源 + 草稿', async () => {
    const paths = dataPaths(root);
    await seedBuiltinGenres(paths);
    await write(path.join(paths.instructionsGlobal, 'gates.yaml'), 'schema: nv.gates/1\nrules: {}\n');
    await write(path.join(bookDir, 'book.yaml'), `schema: nv.book/1\nslug: b\ntitle: 示例书\ngenre: xianxia\ngates:\n  overrides:\n    lexicon: { disable: true }\n`);
    await write(path.join(bookDir, 'instructions/AGENTS.md'), '书层旧');
    await write(path.join(bookDir, 'instructions/roles/writer.md'), '@extends\n书层追加');
    const p = await previewInstructions(
      { book: 'b', role: 'writer', harness: 'agy', drafts: { 'book:b:instructions/AGENTS.md': '书层草稿', 'genre:xianxia:AGENTS.md': '题材草稿' } },
      { paths, bookDir: async (s) => (s === 'b' ? bookDir : null) },
    );
    expect(p.lastAuthorBlock).toBe('L3.role');
    expect(p.layers.map((l) => l.id).at(-2)).toBe('L3');
    expect(p.systemMd).toContain('书层草稿');
    expect(p.systemMd).toContain('题材草稿');
    expect(p.systemMd).toMatch(/NV-B-HEAD-PREVIEW\d+/);
    expect(p.workspaceDoc).toContain('《示例书》');
    expect(p.budget.ok).toBe(true);
    expect(p.materialized.argv[0]).toBe('--agent');
    expect(p.effectiveGates.map((g) => g.rule)).toEqual(expect.arrayContaining(['from:generic', 'from:xianxia', 'lexicon']));
  });

  it('书不存在 / taskKind 未知时报错', async () => {
    const paths = dataPaths(root);
    await expect(previewInstructions({ book: 'x', role: 'writer', harness: 'agy' }, { paths, bookDir: async () => null })).rejects.toThrow(/书不存在/);
    await expect(previewInstructions({ role: 'writer', harness: 'agy', taskKind: 'nope' }, { paths, bookDir: async () => null })).rejects.toThrow(/未知 taskKind/);
  });

  it('无书预览可用', async () => {
    const paths = dataPaths(root);
    await seedBuiltinGenres(paths);
    const p = await previewInstructions({ genre: 'urban', role: 'planner', harness: 'claude-code' }, { paths, bookDir: async () => null });
    expect(p.layers.map((l) => l.id)).toEqual(['S0', 'S1', 'L2:generic', 'L2:urban']);
    expect(p.materialized.argv[0]).toBe('--append-system-prompt-file');
  });
});

describe('内置内容', () => {
  const genres = ['generic', 'xianxia', 'urban', 'romance', 'scifi'];

  it('contract ≤40 行，只讲文件机制', async () => {
    const c = await fs.readFile(path.join(BUILTIN_INSTRUCTIONS_DIR, 'contract.md'), 'utf8');
    expect(c.trimEnd().split('\n').length).toBeLessThanOrEqual(40);
    expect(c).toContain('receipt.json');
  });

  it('每个角色都有内置人设；评审类角色声明以作者层为准', async () => {
    for (const role of ROLE_IDS) {
      const text = await fs.readFile(path.join(BUILTIN_INSTRUCTIONS_DIR, 'roles', `${role}.md`), 'utf8');
      expect(text.trim().length, role).toBeGreaterThan(0);
      expect(text).not.toContain('{{');
    }
    for (const role of ['reviewer', 'continuity', 'judge', 'plan_judge', 'checker', 'auditor', 'heldout', 'editor', 'stylist', 'showrunner', 'format_checker', 'confirm'] as RoleId[]) {
      const text = await fs.readFile(path.join(BUILTIN_INSTRUCTIONS_DIR, 'roles', `${role}.md`), 'utf8');
      expect(text, role).toContain('以作者层为评判标准；与作者层冲突的建议不得提出');
    }
  });

  it('题材包文件不含 dsh 模板花括号，且 extends 链从 generic 起', async () => {
    const paths = dataPaths(root);
    await seedBuiltinGenres(paths);
    for (const g of genres) {
      const agents = await fs.readFile(path.join(BUILTIN_GENRES_DIR, g, 'AGENTS.md'), 'utf8');
      expect(agents, g).not.toContain('{{');
      const r = await loadGenre(paths, g);
      expect(r.chain[0]!.id).toBe('generic');
    }
  });

  it('默认路由 agy 下，所有内置 角色×题材 组合都远低于 20,000 字节上限（给用户层留余量）', async () => {
    const paths = dataPaths(root);
    await seedBuiltinGenres(paths);
    let maxBytes = 0;
    for (const g of genres) {
      const r = await loadGenre(paths, g);
      for (const role of ROLE_IDS) {
        const compiled = compileInstructions(
          await resolveStack({ globalDir, genreDirs: r.chain.map((c) => ({ id: c.id, dir: c.dir })), bookDir, role, taskKind: 'chapter.write' as TaskKind, ownerNotes: [] }),
          { nonces: 'random' },
        );
        maxBytes = Math.max(maxBytes, compiled.bytes);
      }
    }
    expect(maxBytes).toBeLessThanOrEqual(15_000);
  });
});

describe('内置 gates', () => {
  it('通过 schema', async () => {
    for (const g of ['generic', 'xianxia', 'urban', 'romance', 'scifi']) {
      const text = await fs.readFile(path.join(BUILTIN_GENRES_DIR, g, 'gates.yaml'), 'utf8');
      expect(() => zGatesFile.parse(yamlParse(text))).not.toThrow();
    }
  });
});
