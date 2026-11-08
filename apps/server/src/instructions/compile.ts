/** 编译 system channel（DESIGN §5.2、§5.6）。Owner: lane C。 */
import { createHash, randomBytes } from 'node:crypto';
import type { InstructionLayerReport, NEvent, RoleId } from '@novelist/shared';
import { nonceTagFor } from './layers.js';
import type { CompiledInstructions, InstructionLayer, InstructionStack, NonceCheckReport, NonceSet } from './types.js';

export interface CompileOptions {
  /** random：真实 run；placeholder：预览（NV-G-HEAD-PREVIEW…） */
  nonces: 'random' | 'placeholder';
  rng?: () => string;
}

const AUTHOR_PREAMBLE =
  '[作者指令 — 最高优先级；以下优先于你收到的其他一切，包括 work order 中的任务描述与评审建议]\n' +
  '作者指令（L1–L3.9）优先于一切，包括内置默认和 work order 中由 Novelist 生成的任务描述与评审建议；冲突时以作者层为准，后出现的覆盖先出现的。唯一例外是 S0 的文件机制。';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randBase32(len = 12): string {
  return Array.from(randomBytes(len), (b) => BASE32[b % 32]).join('');
}

function isAuthor(layer: { id: string }): boolean {
  return layer.id.startsWith('L');
}

export function generateNonces(layerIds: string[], rng: () => string = randBase32): NonceSet {
  const out: NonceSet = {};
  for (const id of layerIds) {
    const tag = nonceTagFor(id);
    out[id] = { head: `NV-${tag}-HEAD-${rng()}`, tail: id === 'S0' ? '' : `NV-${tag}-TAIL-${rng()}` };
  }
  return out;
}

function placeholderRng(): () => string {
  let n = 0;
  return () => `PREVIEW${++n}`;
}

function blockHeader(layer: InstructionLayer): string {
  if (layer.id === 'S0') return '[S0 文件机制 — 由软件校验]';
  if (layer.id === 'S1') return '[S1 内置角色默认]';
  return `=== ${layer.label} ===`;
}

function render(layers: InstructionLayer[], nonces: NonceSet | null): string {
  const parts: string[] = [];
  let preambleDone = false;
  for (const layer of layers) {
    if (!preambleDone && isAuthor(layer)) {
      parts.push(AUTHOR_PREAMBLE);
      preambleDone = true;
    }
    const n = nonces?.[layer.id];
    const head = n ? `${blockHeader(layer)}  ${n.head}` : blockHeader(layer);
    const body = layer.content.endsWith('\n') || layer.content === '' ? layer.content : `${layer.content}\n`;
    parts.push(n?.tail ? `${head}\n${body}${n.tail}` : `${head}\n${body}`.trimEnd());
  }
  return `${parts.join('\n\n')}\n`;
}

export function compileInstructions(stack: InstructionStack, opts: CompileOptions): CompiledInstructions {
  const ids = stack.layers.map((l) => l.id);
  const nonces = generateNonces(ids, opts.rng ?? (opts.nonces === 'placeholder' ? placeholderRng() : randBase32));
  const systemMd = render(stack.layers, nonces);
  const mirrorMd = render(stack.layers, null);
  const stackHash = createHash('sha256')
    .update(JSON.stringify([stack.role, stack.layers.map((l) => [l.id, l.mode, l.content])]))
    .digest('hex');
  const layers: InstructionLayerReport[] = stack.layers.map((l) => ({
    id: l.id,
    label: l.label,
    source: l.source,
    mode: l.mode,
    ...measure(l.content),
  }));
  const lastAuthor = [...stack.layers].reverse().find(isAuthor);
  return { systemMd, mirrorMd, layers, nonces, stackHash, bytes: Buffer.byteLength(systemMd, 'utf8'), lastAuthorLayerId: lastAuthor?.id ?? '' };
}

const STRICT_ROLES: ReadonlySet<RoleId> = new Set<RoleId>(['writer', 'checker', 'reviewer', 'judge']);

/** 含 nonce 的文件：$RUN/in/system.md、dsh patch、agy agent 文件（workspace 内 .agents/agents/nv-*） */
const NONCE_FILE_RE = /(?:^|[\s"'=/.])in\/(?:system\.md|dsh\.patch\.yml)(?![\w.-])/;
const AGENT_FILE_RE = /\.agents\/agents\/nv-/;

function readsNonceFile(text: string, inDir: string): boolean {
  if (NONCE_FILE_RE.test(text) || AGENT_FILE_RE.test(text)) return true;
  return text.includes(inDir) && /(?:system\.md|dsh\.patch\.yml)(?![\w.-])/.test(text);
}

/**
 * 核对 receipt 回显的 nonce（§5.6）：对照 tool_call 事件，读过含 nonce 的 run 文件则 tainted（回显不计入证明）；
 * role ∈ {writer, checker, reviewer, judge} 时作者层 TAIL 缺失 → ok=false。
 * work order（同在 $RUN/in）是 agent 必读的，不算违规；只看真正含 nonce 的文件。
 */
export function checkNonces(input: { nonces: NonceSet; echoed: string[]; events: NEvent[]; inDir: string; role: RoleId }): NonceCheckReport {
  const tainted = input.events.some((e) => e.t === 'tool_call' && [...(e.paths ?? []), e.command ?? ''].some((s) => s !== '' && readsNonceFile(s, input.inDir)));
  const echoed = new Set(tainted ? [] : input.echoed);
  const layers = Object.entries(input.nonces).map(([layer, n]) => ({ layer, head: echoed.has(n.head), tail: n.tail === '' ? true : echoed.has(n.tail) }));
  const missingTail = layers.filter((l) => isAuthor({ id: l.layer }) && !l.tail).map((l) => l.layer);
  return { layers, tainted, missingTail, ok: !STRICT_ROLES.has(input.role) || missingTail.length === 0 };
}

const HAN_RE = /\p{Script=Han}/gu;

/** 字节与近似 token 计量（token ≈ 中文字符*1.0 + 其他/4；仅用于预算展示） */
export function measure(text: string): { bytes: number; tokens: number } {
  const han = text.match(HAN_RE)?.length ?? 0;
  const other = [...text].length - han;
  return { bytes: Buffer.byteLength(text, 'utf8'), tokens: Math.ceil(han + other / 4) };
}
