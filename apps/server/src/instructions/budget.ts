/** 预算器（DESIGN §5.2）：超出 harness 上限时拒绝该 profile，绝不静默截断。Owner: lane C。 */
import type { Capabilities, HarnessId } from '@novelist/shared';
import type { BudgetResult, CompiledInstructions } from './types.js';

/** 已知上限：agy 每文件 24KB（编译器硬上限 20,000 字节）、dsh 每链 64KiB、codex developer_instructions ≤100KB 单 argv、grok --rules 单 argv（Linux MAX_ARG_STRLEN 128KiB） */
export const KNOWN_LIMITS: Partial<Record<HarnessId, number>> = {
  agy: 20_000,
  dsh: 65_536,
  codex: 100_000,
  grok: 128_000,
};

/** caps.maxInstructionBytes（probe 实测）与已知上限取较小者 */
export function limitFor(harness: HarnessId, caps: Capabilities | null): number | null {
  const candidates = [KNOWN_LIMITS[harness], caps?.maxInstructionBytes].filter((v): v is number => typeof v === 'number');
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function budgetVerdict(harness: HarnessId, bytes: number, limit: number | null, detail = ''): BudgetResult {
  if (limit === null || bytes <= limit) return { ok: true, bytes, limit };
  return { ok: false, bytes, limit, reason: `指令 ${bytes} 字节，超出 ${harness} 的上限 ${limit} 字节。${detail}请压缩该层或换 harness（Novelist 不做截断）。` };
}

export function checkBudget(harness: HarnessId, compiled: CompiledInstructions, caps: Capabilities | null): BudgetResult {
  const largest = [...compiled.layers]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((l) => `${l.id} ${l.bytes}B`)
    .join('、');
  return budgetVerdict(harness, compiled.bytes, limitFor(harness, caps), largest ? `最大的层：${largest}。` : '');
}
