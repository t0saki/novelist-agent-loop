/**
 * 各 harness 的物化方式（DESIGN §5.3）。Owner: lane C。
 * 产出文件 + argv 片段 + env；adapter（lane A）把它们拼进完整命令。
 * - claude-code：--append-system-prompt-file $RUN/in/system.md（replace：--system-prompt-file）；cc.settings.json 的 Stop hook（仅 caps.stopHook=verified）
 * - codex：-c developer_instructions=<smol-toml 序列化的 basic string>（replace：model_instructions_file）
 * - grok：--rules "<system.md 内容>"（replace：--system-prompt-override）
 * - agy：--agent nv-<role>-<stackhash8>；agent 文件写到本 run 的 workspace（$RUN/book/.agents/agents/，随 worktree 清理，
 *   不进持久 home，也不会与同账号的并发 run 互相覆盖）；编译器硬上限 20,000 字节，AGENTS.md 同样受限
 * - dsh：--patch $RUN/in/dsh.patch.yml，system-prompt.personaSuffix（`{{` 不可转义时 budget.ok=false）
 * - pi：--append-system-prompt $RUN/in/system.md（replace：--system-prompt）
 * - fake：--system $RUN/in/system.md
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessId } from '@novelist/shared';
import { stringify as tomlStringify } from 'smol-toml';
import { stringify as yamlStringify } from 'yaml';
import { budgetVerdict, checkBudget, KNOWN_LIMITS, limitFor } from '../budget.js';
import type { BudgetResult, MaterializeInput, MaterializeResult } from '../types.js';

export type Materializer = (input: MaterializeInput) => Promise<MaterializeResult>;

/** 单个 argv 元素的 Linux 上限（MAX_ARG_STRLEN = 128KiB），序列化后复核 */
const MAX_ARG_BYTES = 131_072;

const refuse = (budget: BudgetResult, notes: string[] = []): MaterializeResult => ({ files: [], argv: [], env: {}, budget, notes });

const refuseReason = (input: MaterializeInput, reason: string): BudgetResult => ({ ok: false, bytes: input.compiled.bytes, limit: null, reason });

const systemFile = (input: MaterializeInput) => ({ path: input.spec.systemFile, content: input.compiled.systemMd });

/** caps 不支持 replace 时退回 append，并在 notes 里说明 */
function effectiveMode(input: MaterializeInput, notes: string[]): 'append' | 'replace' {
  if (input.personaMode !== 'replace' || input.caps.systemReplace) return input.personaMode;
  notes.push(`${input.harness} 不支持替换系统提示（caps.systemReplace=false），已退回 append`);
  return 'append';
}

const claudeCode: Materializer = async (input) => {
  const budget = checkBudget('claude-code', input.compiled, input.caps);
  if (!budget.ok) return refuse(budget);
  const notes: string[] = [];
  const flag = effectiveMode(input, notes) === 'replace' ? '--system-prompt-file' : '--append-system-prompt-file';
  const files = [systemFile(input)];
  const argv = [flag, input.spec.systemFile];
  // Stop hook 只是优化（§5.3）；未经 probe 实测的不启用，nv 不可用时也不能影响 run
  if (input.caps.stopHook === 'verified') {
    const settings = path.join(input.spec.inDir, 'cc.settings.json');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 变量展开，不是 JS 模板
    const hook = { type: 'command', command: '"${NOVELIST_NV_BIN:-nv}" gate --quick --report' };
    files.push({ path: settings, content: `${JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } }, null, 2)}\n` });
    argv.push('--settings', settings);
  }
  return { files, argv, env: {}, budget, notes };
};

const codex: Materializer = async (input) => {
  const notes: string[] = [];
  if (effectiveMode(input, notes) === 'replace') {
    // model_instructions_file 走文件，不受单 argv 限制
    const budget = budgetVerdict('codex', input.compiled.bytes, input.caps.maxInstructionBytes ?? null);
    if (!budget.ok) return refuse(budget, notes);
    return { files: [systemFile(input)], argv: ['-c', `model_instructions_file=${tomlBasicString(input.spec.systemFile)}`], env: {}, budget, notes };
  }
  const budget = checkBudget('codex', input.compiled, input.caps);
  if (!budget.ok) return refuse(budget, notes);
  const arg = `developer_instructions=${tomlBasicString(input.compiled.systemMd)}`;
  // TOML 转义会让换行、引号变长：按真实 argv 元素复核
  const argBytes = Buffer.byteLength(arg, 'utf8');
  const hard = Math.min(limitFor('codex', input.caps) ?? MAX_ARG_BYTES, MAX_ARG_BYTES);
  if (argBytes > hard) return refuse(budgetVerdict('codex', argBytes, hard, '（TOML 转义后的 argv 长度）'), notes);
  return { files: [systemFile(input)], argv: ['-c', arg], env: {}, budget, notes };
};

const grok: Materializer = async (input) => {
  const budget = checkBudget('grok', input.compiled, input.caps);
  if (!budget.ok) return refuse(budget);
  if (input.compiled.systemMd.includes('\0')) return refuse(refuseReason(input, '指令含 NUL 字符，无法作为 grok 的命令行参数传递。请删除该字符或换 harness。'));
  const notes: string[] = [];
  const flag = effectiveMode(input, notes) === 'replace' ? '--system-prompt-override' : '--rules';
  return { files: [systemFile(input)], argv: [flag, input.compiled.systemMd], env: {}, budget, notes };
};

const agy: Materializer = async (input) => {
  const notes: string[] = [];
  effectiveMode(input, notes);
  const limit = limitFor('agy', input.caps) ?? KNOWN_LIMITS.agy!;
  const name = `nv-${input.spec.role.replaceAll('_', '-')}-${input.compiled.stackHash.slice(0, 8)}`;
  // 不写 tools 时 agy 的自定义 agent 没有文件写入工具（实测只有 read_file）；只给文件读写和搜索，不给 shell
  const tools = ['view_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'list_dir', 'find_by_name', 'grep_search'];
  const front = yamlStringify({ name, description: `Novelist ${input.spec.role}`, mainAgent: true, subagent: false, tools }, { lineWidth: 0 });
  const content = `---\n${front}---\n\n${input.compiled.systemMd}`;
  const budget = budgetVerdict('agy', Buffer.byteLength(content, 'utf8'), limit);
  if (!budget.ok) return refuse(budget, notes);
  const doc = input.workspaceDoc ?? (await fs.readFile(path.join(input.spec.bookDir, 'AGENTS.md'), 'utf8').catch(() => null));
  if (doc !== null) {
    const docBudget = budgetVerdict('agy', Buffer.byteLength(doc, 'utf8'), limit, '（工作区 AGENTS.md）');
    if (!docBudget.ok) return refuse(docBudget, notes);
  }
  const agentFile = path.join(input.spec.bookDir, '.agents', 'agents', `${name}.md`);
  return { files: [systemFile(input), { path: agentFile, content }], argv: ['--agent', name], env: {}, budget, notes };
};

const dsh: Materializer = async (input) => {
  const budget = checkBudget('dsh', input.compiled, input.caps);
  if (!budget.ok) return refuse(budget);
  const notes: string[] = [];
  effectiveMode(input, notes);
  const suffix = escapeDshTemplate(input.compiled.systemMd);
  if (suffix === null) return refuse(refuseReason(input, 'dsh 的 persona 模板没有转义语法，而指令中含会被解析的 {{…}}（templateEscaping: incompatible）。请改写这些花括号或换 harness。'), notes);
  const patchFile = path.join(input.spec.inDir, 'dsh.patch.yml');
  const patch = yamlStringify([{ id: 'system-prompt', config: { personaSuffix: suffix } }], { lineWidth: 0 });
  return { files: [systemFile(input), { path: patchFile, content: `# Novelist 每 run 生成（dsh 作者层）\n${patch}` }], argv: ['--patch', patchFile], env: {}, budget, notes };
};

const pi: Materializer = async (input) => {
  const budget = checkBudget('pi', input.compiled, input.caps);
  if (!budget.ok) return refuse(budget);
  const notes: string[] = [];
  const flag = effectiveMode(input, notes) === 'replace' ? '--system-prompt' : '--append-system-prompt';
  return { files: [systemFile(input)], argv: [flag, input.spec.systemFile], env: {}, budget, notes };
};

const fake: Materializer = async (input) => ({
  files: [systemFile(input)],
  argv: ['--system', input.spec.systemFile],
  env: {},
  budget: checkBudget('fake', input.compiled, input.caps),
  notes: [],
});

const MATERIALIZERS: Record<string, Materializer> = { 'claude-code': claudeCode, codex, grok, agy, dsh, pi, fake };

export async function materializeFor(harness: HarnessId, input: MaterializeInput): Promise<MaterializeResult> {
  // v3：指令只在工作区根 AGENTS.md / CLAUDE.md（不传 agy --agent、cc --append-system-prompt-file、codex developer_instructions）
  if (input.spec.contract === 'v3') return { files: [], argv: [], env: {}, budget: { ok: true, bytes: 0, limit: null }, notes: ['v3：指令只在工作区 AGENTS.md'] };
  const m = MATERIALIZERS[harness];
  if (!m) return refuse(refuseReason(input, `${harness} 没有指令物化方式`));
  return m(input);
}

/** TOML basic string 序列化（smol-toml；U+007F 与控制字符转 \\uXXXX）——codex 专用，golden test 覆盖 */
export function tomlBasicString(text: string): string {
  if (/[\uD800-\uDFFF]/u.test(text)) throw new Error('指令含孤立代理项，无法序列化为 TOML');
  return tomlStringify({ v: text }).trim().slice('v = '.length);
}

/**
 * dsh 模板（packages/core/system-prompt interpolate）没有转义语法：
 * `{{` 后面再无 `}}` 时按字面保留；否则会被当作变量引用（未知变量或畸形引用直接让 prompt 组装失败）。
 * 所以可字面保留时原样返回，否则返回 null（调用方拒绝该 profile）。
 */
export function escapeDshTemplate(text: string): string | null {
  const open = text.indexOf('{{');
  if (open < 0) return text;
  return text.indexOf('}}', open + 2) >= 0 ? null : text;
}
