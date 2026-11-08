/**
 * 账本折叠（DESIGN §4.2）：snapshot = fold(entities 初始态, ledger[*], overrides) —— 纯函数、确定性（属性测试）。Owner: lane B。
 *
 * 语义（实现约定，供 D/E 参考）：
 * - 实体初始态取自实体文件：initial 的键同 entity.update.set；`cond`/`conds` 为条件数组，`stage`、`alive`、`power{}`、`power.<体系>` 有专门字段，其余进 attrs。
 * - set 的特殊键：`cond+`/`cond-`（集合增删）、`conds`（整体替换）、`stage`、`alive`、`name`、`power`（对象合并）、`power.<体系>`；`null` 值保留为 null。
 * - item.transfer 同时写 items[item].holder 与物品实体的 attrs.owner。
 * - relation 按无序实体对去重（同一对只保留最新类型）。
 * - identity.reveal：实体文件里该身份有 known_by_fact → 视为对方（或读者）得知该事实；否则记合成事实 `ident:<ent>#<identity>`。
 * - overrides：
 *   - op 目标（replace/drop）改写对应章 delta 的那条 op，与 effective_from 无关；
 *   - entity/fact/obligation 目标在折叠到 effective_from 那一章之前生效（effective_from 超出账本 → 折叠末尾生效）；
 *     目标尚不存在则延后到其出现后立即生效；
 *   - fact 目标是“粘性”的：此后 fact.assert 不会改回原文（override 优先于 ledger），drop 的事实此后被忽略。
 * - 同一输入永远得到同一输出：overrides 按 (effective_from, ts, id) 排序；数组按出现顺序，集合类数组排序。
 */
import type { Delta, DeltaOp, Entity, EntityState, ObligationState, Override, Snapshot, WorldRules } from '@novelist/shared';
import { chapterNo } from '@novelist/shared';
import { canonicalJson, cloneJson, sha256 } from './canon.js';

export interface FoldInput {
  entities: Entity[];
  world: WorldRules | null;
  /** 按章号升序 */
  ledger: Delta[];
  overrides: Override[];
  /** 每章汉字数（total_cjk 统计），可选 */
  chapterCjk?: Record<string, number>;
}

export interface ApplyOptions {
  /** 实体定义（identity.reveal 解析 known_by_fact 用） */
  entities?: Entity[];
}

const KIND_BY_PREFIX: Record<string, string> = { char: 'character', loc: 'location', fac: 'faction', item: 'item', concept: 'concept' };

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

function emptySnapshot(): Snapshot {
  return {
    schema: 'nv.snapshot/1',
    through: null,
    ledger_hash: '',
    hash: '',
    entities: {},
    facts: {},
    knowledge: {},
    reader_knows: [],
    obligations: {},
    items: {},
    relations: [],
    arcs_resolved: [],
    events: [],
    total_cjk: 0,
  };
}

function asStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

/** 把 set（或 initial）应用到实体状态上 */
export function applySet(e: EntityState, set: Record<string, unknown>): void {
  for (const key of Object.keys(set).sort()) {
    const v = set[key];
    if (key === 'cond+') e.conds = sortedUnique([...e.conds, ...asStrings(v)]);
    else if (key === 'cond-') {
      const rm = new Set(asStrings(v));
      e.conds = e.conds.filter((c) => !rm.has(c));
    } else if (key === 'conds' || key === 'cond') e.conds = sortedUnique(asStrings(v));
    else if (key === 'stage') {
      if (typeof v === 'string') e.stage = v;
      else if (v === null) delete e.stage;
    } else if (key === 'alive') e.alive = v !== false;
    else if (key === 'name' && typeof v === 'string' && v) e.name = v;
    else if (key === 'power' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [sys, lvl] of Object.entries(v as Record<string, unknown>)) if (typeof lvl === 'string') e.power[sys] = lvl;
    } else if (key.startsWith('power.')) {
      const sys = key.slice(6);
      if (typeof v === 'string') e.power[sys] = v;
      else if (v === null) delete e.power[sys];
    } else e.attrs[key] = cloneJson(v === undefined ? null : v);
  }
}

function initialEntity(ent: Entity): EntityState {
  const st: EntityState = { id: ent.id, kind: ent.kind, name: ent.name, alive: true, attrs: {}, conds: [], power: {} };
  if (ent.first_ch) st.first_seen = ent.first_ch;
  applySet(st, ent.initial ?? {});
  return st;
}

function stubEntity(id: string, kind?: string, name?: string): EntityState {
  const prefix = id.split('.')[0] ?? '';
  return { id, kind: kind ?? KIND_BY_PREFIX[prefix] ?? 'concept', name: name ?? id, alive: true, attrs: {}, conds: [], power: {} };
}

interface Engine {
  s: Snapshot;
  identities: Map<string, Map<string, string | undefined>>;
  /** 粘性 fact override：fact → 生效的 override（drop 或 set） */
  stickyFacts: Map<string, Override>;
  pending: Override[];
}

function makeEngine(s: Snapshot, entities: Entity[]): Engine {
  const identities = new Map<string, Map<string, string | undefined>>();
  for (const e of entities) {
    const m = new Map<string, string | undefined>();
    for (const idn of e.identities ?? []) {
      m.set(idn.id, idn.known_by_fact);
      m.set(idn.alias, idn.known_by_fact);
    }
    identities.set(e.id, m);
  }
  return { s, identities, stickyFacts: new Map(), pending: [] };
}

function ensureEntity(g: Engine, id: string): EntityState {
  let e = g.s.entities[id];
  if (!e) {
    e = stubEntity(id);
    g.s.entities[id] = e;
  }
  return e;
}

function seen(g: Engine, id: string | null | undefined, ch: string): void {
  if (!id || id.startsWith('tmp:')) return;
  const e = ensureEntity(g, id);
  e.last_seen = ch;
  if (!e.first_seen) e.first_seen = ch;
}

function learn(g: Engine, who: string, fact: string): void {
  if (g.stickyFacts.get(fact)?.action === 'drop') return;
  g.s.knowledge[who] = sortedUnique([...(g.s.knowledge[who] ?? []), fact]);
}

function setRelation(g: Engine, a: string, b: string, type: string, since: string): void {
  const rels = g.s.relations.filter((r) => !((r.a === a && r.b === b) || (r.a === b && r.b === a)));
  rels.push({ a, b, type, since });
  g.s.relations = rels;
}

function applyOp(g: Engine, op: DeltaOp, ch: string): void {
  const s = g.s;
  switch (op.op) {
    case 'entity.create': {
      const ex = s.entities[op.ent];
      const e = ex ?? stubEntity(op.ent, op.kind, op.name);
      if (!ex) s.entities[op.ent] = e;
      if (op.set) applySet(e, op.set);
      seen(g, op.ent, ch);
      return;
    }
    case 'entity.update': {
      applySet(ensureEntity(g, op.ent), op.set ?? {});
      seen(g, op.ent, ch);
      return;
    }
    case 'entity.retire': {
      const e = ensureEntity(g, op.ent);
      e.retired = op.how;
      if (op.how === 'death' || op.how === 'destroyed') e.alive = false;
      seen(g, op.ent, ch);
      return;
    }
    case 'event': {
      const who = [...(op.who ?? [])];
      s.events.push({ id: op.id, ch, what: op.what, who });
      for (const w of who) seen(g, w, ch);
      if (op.loc) seen(g, op.loc, ch);
      return;
    }
    case 'fact.assert': {
      const sticky = g.stickyFacts.get(op.fact);
      if (sticky?.action === 'drop') return;
      if (sticky) {
        const prev = s.facts[op.fact];
        s.facts[op.fact] = { text: prev?.text ?? factText(sticky.value, op.text), since: prev?.since ?? ch, overridden: true };
        return;
      }
      const prev = s.facts[op.fact];
      s.facts[op.fact] = { text: op.text, since: prev?.since ?? ch, overridden: prev?.overridden ?? false };
      return;
    }
    case 'knowledge.learn': {
      learn(g, op.who, op.fact);
      seen(g, op.who, ch);
      return;
    }
    case 'reader.reveal': {
      if (g.stickyFacts.get(op.fact)?.action === 'drop') return;
      s.reader_knows = sortedUnique([...s.reader_knows, op.fact]);
      return;
    }
    case 'identity.reveal': {
      const fact = g.identities.get(op.ent)?.get(op.identity) ?? `ident:${op.ent}#${op.identity}`;
      if (op.to === 'reader') {
        if (g.stickyFacts.get(fact)?.action !== 'drop') s.reader_knows = sortedUnique([...s.reader_knows, fact]);
      } else {
        learn(g, op.to, fact);
        seen(g, op.to, ch);
      }
      seen(g, op.ent, ch);
      return;
    }
    case 'obligation.open': {
      const prev = s.obligations[op.id];
      const o: ObligationState = {
        id: op.id,
        kind: op.kind,
        weight: op.weight,
        text: op.text,
        status: 'open',
        opened: prev?.opened ?? ch,
        advances: prev?.advances ?? [],
        open_ev: op.ev,
      };
      if (op.due) o.due = [op.due[0], op.due[1]];
      s.obligations[op.id] = o;
      return;
    }
    case 'obligation.advance': {
      const o = s.obligations[op.id];
      if (!o) return;
      if (o.status === 'open') o.status = 'advanced';
      if (!o.advances.includes(ch)) o.advances = [...o.advances, ch];
      return;
    }
    case 'obligation.pay': {
      const o = s.obligations[op.id];
      if (!o) return;
      o.status = 'paid';
      o.closed = ch;
      return;
    }
    case 'obligation.abandon': {
      const o = s.obligations[op.id];
      if (!o) return;
      o.status = 'abandoned';
      o.closed = ch;
      return;
    }
    case 'arc.stage': {
      ensureEntity(g, op.who).stage = op.stage;
      seen(g, op.who, ch);
      return;
    }
    case 'arc.resolve': {
      s.arcs_resolved = sortedUnique([...s.arcs_resolved, op.arc]);
      return;
    }
    case 'offscreen.update': {
      applySet(ensureEntity(g, op.ent), op.set ?? {});
      return;
    }
    case 'time.advance': {
      if (op.flashback) return;
      s.time = { ...(s.time ?? {}), ...cloneJson(op.to) };
      return;
    }
    case 'power.change': {
      ensureEntity(g, op.who).power[op.system] = op.to;
      seen(g, op.who, ch);
      return;
    }
    case 'item.transfer': {
      const holder = op.to ?? null;
      s.items[op.item] = { holder };
      ensureEntity(g, op.item).attrs.owner = holder;
      if (op.from) seen(g, op.from, ch);
      if (holder) seen(g, holder, ch);
      return;
    }
    case 'relation.set': {
      setRelation(g, op.a, op.b, op.type, ch);
      seen(g, op.a, ch);
      seen(g, op.b, ch);
      return;
    }
    case 'contract.amend':
      // planner 提议，经审批后改实体文件；不改变故事状态
      return;
  }
}

function factText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') return (value as { text: string }).text;
  return fallback;
}

/** 尝试应用一条 entity/fact/obligation override；目标不存在返回 false（延后） */
function tryApplyOverride(g: Engine, o: Override): boolean {
  const s = g.s;
  const t = o.target;
  switch (t.kind) {
    case 'entity': {
      const e = s.entities[t.ent];
      if (!e) return false;
      if (o.action === 'drop') {
        if (t.field === 'stage') delete e.stage;
        else if (t.field.startsWith('power.')) delete e.power[t.field.slice(6)];
        else if (t.field === 'conds' || t.field === 'cond') e.conds = [];
        else delete e.attrs[t.field];
      } else applySet(e, { [t.field]: o.value ?? null });
      return true;
    }
    case 'fact': {
      g.stickyFacts.set(t.fact, o);
      if (o.action === 'drop') {
        delete s.facts[t.fact];
        for (const who of Object.keys(s.knowledge)) {
          const k = (s.knowledge[who] ?? []).filter((f) => f !== t.fact);
          if (k.length) s.knowledge[who] = k;
          else delete s.knowledge[who];
        }
        s.reader_knows = s.reader_knows.filter((f) => f !== t.fact);
        return true;
      }
      const prev = s.facts[t.fact];
      s.facts[t.fact] = { text: factText(o.value, prev?.text ?? o.note), since: prev?.since ?? o.effective_from, overridden: true };
      return true;
    }
    case 'obligation': {
      const ob = s.obligations[t.id];
      if (!ob) return false;
      if (o.action === 'drop') {
        delete s.obligations[t.id];
        return true;
      }
      if (o.value && typeof o.value === 'object' && !Array.isArray(o.value)) {
        const v = o.value as Record<string, unknown>;
        if (typeof v.status === 'string' && ['open', 'advanced', 'paid', 'abandoned'].includes(v.status)) ob.status = v.status as ObligationState['status'];
        if (typeof v.text === 'string') ob.text = v.text;
        if (typeof v.weight === 'string' && ['main', 'major', 'minor'].includes(v.weight)) ob.weight = v.weight as ObligationState['weight'];
        if (Array.isArray(v.due) && v.due.length === 2) ob.due = [String(v.due[0]), String(v.due[1])];
        if (typeof v.closed === 'string') ob.closed = v.closed;
      } else if (typeof o.value === 'string' && ['open', 'advanced', 'paid', 'abandoned'].includes(o.value)) {
        ob.status = o.value as ObligationState['status'];
      }
      return true;
    }
    case 'op':
      return true;
  }
}

function flushPending(g: Engine): void {
  if (g.pending.length === 0) return;
  g.pending = g.pending.filter((o) => !tryApplyOverride(g, o));
}

export function sortOverrides(overrides: Override[]): Override[] {
  return [...overrides].sort((a, b) => {
    if (a.effective_from !== b.effective_from) return a.effective_from < b.effective_from ? -1 : 1;
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 把 op 目标的 overrides 应用到账本（返回新数组，原数组不变） */
export function applyOpOverrides(ledger: Delta[], overrides: Override[]): Delta[] {
  const byCh = new Map<string, Override[]>();
  for (const o of sortOverrides(overrides)) {
    if (o.target.kind !== 'op') continue;
    const k = o.target.chapter;
    byCh.set(k, [...(byCh.get(k) ?? []), o]);
  }
  if (byCh.size === 0) return ledger;
  return ledger.map((d) => {
    const os = byCh.get(d.chapter);
    if (!os) return d;
    const ops: (DeltaOp | null)[] = [...d.ops];
    for (const o of os) {
      if (o.target.kind !== 'op') continue;
      const i = o.target.op_index;
      if (i >= ops.length) continue;
      if (o.action === 'drop') ops[i] = null;
      else if (o.action === 'replace' && o.value && typeof o.value === 'object' && typeof (o.value as { op?: unknown }).op === 'string')
        ops[i] = o.value as DeltaOp;
    }
    return { ...d, ops: ops.filter((x): x is DeltaOp => x !== null) };
  });
}

function stepDelta(g: Engine, d: Delta): void {
  const ch = d.chapter;
  for (const op of d.ops ?? []) applyOp(g, op, ch);
  for (const e of d.entities_present ?? []) seen(g, e, ch);
  g.s.through = ch;
  flushPending(g);
}

function finalize(s: Snapshot): Snapshot {
  const { hash: _h, ...rest } = s;
  void _h;
  s.hash = sha256(canonicalJson(rest));
  return s;
}

/**
 * 增量折叠器：fold 的分步版本（级联重放、审计窗口等需要多次“折叠到第 n 章”的场合）。
 * advanceTo(n) 只能单调前进；返回的是内部状态的深拷贝。
 */
export function createFolder(input: FoldInput): { advanceTo(n: number): Snapshot; finish(): Snapshot } {
  const s = emptySnapshot();
  const ents = [...input.entities].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of ents) s.entities[e.id] = initialEntity(e);
  for (const e of ents) {
    for (const r of e.relations ?? []) {
      const rels = s.relations.filter((x) => !((x.a === e.id && x.b === r.to) || (x.a === r.to && x.b === e.id)));
      rels.push({ a: e.id, b: r.to, type: r.type, since: e.first_ch ?? 'c00000' });
      s.relations = rels;
    }
    if (e.kind === 'item') {
      const holder = e.initial?.owner ?? e.initial?.holder;
      if (typeof holder === 'string' || holder === null) s.items[e.id] = { holder: holder ?? null };
    }
  }
  const g = makeEngine(s, ents);
  const ledger = applyOpOverrides(input.ledger, input.overrides);
  const setOverrides = sortOverrides(input.overrides).filter((o) => o.target.kind !== 'op');
  const lh = ledgerHash(input.ledger, input.overrides);
  let li = 0;
  let oi = 0;
  const cjk = input.chapterCjk ?? {};
  let total = 0;
  const applyOverridesBefore = (no: number) => {
    while (oi < setOverrides.length) {
      const o = setOverrides[oi] as Override;
      if (chapterNo(o.effective_from) > no) break;
      if (!tryApplyOverride(g, o)) g.pending.push(o);
      oi++;
    }
  };
  const snap = (): Snapshot => {
    const out = cloneJson(g.s);
    out.ledger_hash = lh;
    out.total_cjk = total;
    return finalize(out);
  };
  const step = (n: number) => {
    while (li < ledger.length) {
      const d = ledger[li] as Delta;
      const no = chapterNo(d.chapter);
      if (no > n) break;
      applyOverridesBefore(no);
      stepDelta(g, d);
      total += cjk[d.chapter] ?? 0;
      li++;
    }
  };
  return {
    /** 第 n 章写完之后、第 n+1 章写之前的状态（含 effective_from ≤ n+1 的 overrides） */
    advanceTo(n: number): Snapshot {
      step(n);
      applyOverridesBefore(n + 1);
      return snap();
    },
    /** 全部账本 + 全部 overrides（effective_from 超出账本的在末尾生效） */
    finish(): Snapshot {
      step(Number.MAX_SAFE_INTEGER);
      applyOverridesBefore(Number.MAX_SAFE_INTEGER);
      return snap();
    },
  };
}

export function fold(input: FoldInput): Snapshot {
  return createFolder(input).finish();
}

/** 账本内容 hash（Novelist-Snapshot-Hash trailer、delta.base_ledger_hash）。overrides 顺序无关 */
export function ledgerHash(ledger: Delta[], overrides: Override[]): string {
  return sha256(
    canonicalJson({ v: 'nv.ledger/1', ledger: ledger.map((d) => sha256(canonicalJson(d))), overrides: sortOverrides(overrides).map((o) => canonicalJson(o)) }),
  );
}

/**
 * 在 snapshot 上应用一章 delta（fold 的单步；delta.check 与投影复用）。不改原对象。
 * 注意：返回值的 ledger_hash 是链式投影值 sha256(prev.ledger_hash + delta)，不等于扩展后账本的 ledgerHash；
 * overrides 不在这里生效（需要精确结果时用 fold）。
 */
export function applyDelta(s: Snapshot, d: Delta, opts: ApplyOptions = {}): Snapshot {
  const g = makeEngine(cloneJson(s), opts.entities ?? []);
  stepDelta(g, d);
  const out = g.s;
  out.ledger_hash = sha256(`${s.ledger_hash}:${sha256(canonicalJson(d))}`);
  return finalize(out);
}

/** 给定 snapshot 重新计算 hash（外部构造 snapshot 时用） */
export function rehashSnapshot(s: Snapshot): Snapshot {
  return finalize(cloneJson(s));
}

/** 空 snapshot（无实体、无账本）；测试与投影用 */
export function emptyFoldSnapshot(): Snapshot {
  return finalize(emptySnapshot());
}
