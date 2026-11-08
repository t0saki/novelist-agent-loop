/**
 * 级联一致性（DESIGN §6.10）：替换第 k 章 delta 后，从 k+1 起按序重放下游 delta 的 delta.check（纯确定性）。Owner: lane B。
 * delta.check 本身属于 lane D；这里接收一个 checker 回调以避免依赖环。
 */
import type { Delta, DeltaOp, Snapshot } from '@novelist/shared';
import { chapterNo } from '@novelist/shared';
import { canonicalJson } from './canon.js';
import { createFolder, type FoldInput } from './fold.js';

export interface CascadeResult {
  /** 下游发生冲突的章号 */
  conflicts: { no: number; reasons: string[] }[];
  /** delta diff 为空（只改文字） */
  noop: boolean;
  /** 被重放的下游章号区间（含两端）；noop 或没有下游时为 null */
  affected: [number, number] | null;
}

/** 去掉逐字引文后的语义内容（判断“只改文字”） */
function semanticOps(d: Delta): unknown {
  const stripEv = (op: DeltaOp) => {
    const { ev: _ev, ...rest } = op as DeltaOp & { ev?: string };
    void _ev;
    return rest;
  };
  return {
    ops: (d.ops ?? []).map(stripEv),
    uses_knowledge: (d.uses_knowledge ?? []).map((u) => ({ who: u.who, fact: u.fact })),
    entities_present: [...(d.entities_present ?? [])].sort(),
  };
}

export function deltaSemanticallyEqual(a: Delta, b: Delta): boolean {
  return canonicalJson(semanticOps(a)) === canonicalJson(semanticOps(b));
}

export function cascadeReplay(input: {
  replaceAt: number;
  newDelta: Delta;
  ledger: Delta[];
  check: (d: Delta, before: Snapshot) => { ok: boolean; reasons: string[] };
  foldUpTo: (n: number, ledger: Delta[]) => Snapshot;
}): CascadeResult {
  const { replaceAt, newDelta, ledger, check, foldUpTo } = input;
  const idx = ledger.findIndex((d) => chapterNo(d.chapter) === replaceAt);
  const old = idx >= 0 ? ledger[idx] : undefined;
  if (old && deltaSemanticallyEqual(old, newDelta)) return { conflicts: [], noop: true, affected: null };
  const newLedger = idx >= 0 ? ledger.map((d, i) => (i === idx ? newDelta : d)) : [...ledger, newDelta].sort((a, b) => (a.chapter < b.chapter ? -1 : 1));
  const downstream = newLedger.filter((d) => chapterNo(d.chapter) > replaceAt);
  const conflicts: CascadeResult['conflicts'] = [];
  for (const d of downstream) {
    const no = chapterNo(d.chapter);
    const r = check(d, foldUpTo(no - 1, newLedger));
    if (!r.ok) conflicts.push({ no, reasons: r.reasons });
  }
  const first = downstream[0];
  const last = downstream[downstream.length - 1];
  return {
    conflicts,
    noop: false,
    affected: first && last ? [chapterNo(first.chapter), chapterNo(last.chapter)] : null,
  };
}

/**
 * foldUpTo 的高效实现：同一 ledger 引用上单调递增调用时增量推进（O(n)），否则从头折叠。
 * 用法：cascadeReplay({ …, foldUpTo: incrementalFoldUpTo({ entities, world, overrides }) })
 */
export function incrementalFoldUpTo(base: Omit<FoldInput, 'ledger'>): (n: number, ledger: Delta[]) => Snapshot {
  let cur: { ledger: Delta[]; folder: ReturnType<typeof createFolder>; at: number } | null = null;
  return (n, ledger) => {
    if (!cur || cur.ledger !== ledger || n < cur.at) cur = { ledger, folder: createFolder({ ...base, ledger }), at: -1 };
    cur.at = n;
    return cur.folder.advanceTo(n);
  };
}
