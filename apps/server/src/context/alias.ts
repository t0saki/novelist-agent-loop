/**
 * 别名索引（Aho-Corasick，支持 ambiguous 标记）（DESIGN §6.3、§6.6 召回探针）。Owner: lane B。
 * 两字人名也能命中（v1 FTS5 trigram 的教训）。
 */
import type { Entity } from '@novelist/shared';

export interface Mention {
  entity: string;
  alias: string;
  start: number;
  end: number;
  ambiguous: boolean;
}

export interface AliasIndex {
  scan(text: string): Mention[];
  /** ambiguous 别名的消歧：附近有对话/动作动词、同句出现其他实体、或卡片 entities_present 包含该实体 */
  resolve(mentions: Mention[], text: string, entitiesPresent: string[], opts?: { pov?: string }): Mention[];
  names(): Map<string, string>;
  /** lane B 扩展：实体 → 全部别名文本（含正式名） */
  aliasesOf?(entity: string): string[];
}

interface Target {
  entity: string;
  ambiguous: boolean;
  pov?: string;
}

interface Node {
  next: Map<number, number>;
  fail: number;
  /** 以本节点结尾的模式长度（含 fail 链上的输出通过 dictLink 访问） */
  out: number[];
  dict: number;
}

/** 附近（±12 字，且不跨句）出现这些词即视为“对话或动作” */
const ACTION_RE = /[道说问答笑喝叫喊吼骂叹哼应喃嘀咕看望瞪盯瞥走跑跳冲退拔抬举挥握抓拉推踢转点摇伸摸拍皱眯怒惊愣哭吐站坐跪躺起扶]|[“"「：:]/u;
const SENTENCE_END = /[。！？!?\n…]/u;

function aliasEntries(e: Entity): { text: string; ambiguous: boolean; pov?: string }[] {
  const out: { text: string; ambiguous: boolean; pov?: string }[] = [{ text: e.name, ambiguous: false }];
  for (const a of e.aliases ?? []) {
    if (typeof a === 'string') out.push({ text: a, ambiguous: false });
    else {
      const x: { text: string; ambiguous: boolean; pov?: string } = { text: a.text, ambiguous: !!a.ambiguous };
      if (a.scope?.pov) x.pov = a.scope.pov;
      out.push(x);
    }
  }
  for (const idn of e.identities ?? []) if (idn.alias) out.push({ text: idn.alias, ambiguous: false });
  return out.filter((x) => x.text.trim().length > 0);
}

export function buildAliasIndex(entities: Entity[]): AliasIndex {
  const sorted = [...entities].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 模式文本 → 目标列表
  const patterns = new Map<string, Target[]>();
  const byEntity = new Map<string, string[]>();
  for (const e of sorted) {
    const texts: string[] = [];
    for (const a of aliasEntries(e)) {
      const list = patterns.get(a.text) ?? [];
      if (!list.some((t) => t.entity === e.id)) {
        const t: Target = { entity: e.id, ambiguous: a.ambiguous };
        if (a.pov) t.pov = a.pov;
        list.push(t);
      }
      patterns.set(a.text, list);
      texts.push(a.text);
    }
    byEntity.set(e.id, [...new Set(texts)]);
  }
  // 同一文本指向多个实体 → 全部按 ambiguous 处理
  for (const list of patterns.values()) if (list.length > 1) for (const t of list) t.ambiguous = true;

  // ---- Aho-Corasick ----
  const nodes: Node[] = [{ next: new Map(), fail: 0, out: [], dict: -1 }];
  const patList = [...patterns.keys()];
  patList.forEach((p, pi) => {
    let cur = 0;
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      let nx = nodes[cur]?.next.get(c);
      if (nx === undefined) {
        nx = nodes.length;
        nodes.push({ next: new Map(), fail: 0, out: [], dict: -1 });
        nodes[cur]?.next.set(c, nx);
      }
      cur = nx;
    }
    nodes[cur]?.out.push(pi);
  });
  const queue: number[] = [];
  for (const nx of nodes[0]?.next.values() ?? []) queue.push(nx);
  while (queue.length) {
    const u = queue.shift() as number;
    const nu = nodes[u] as Node;
    for (const [c, v] of nu.next) {
      let f = nu.fail;
      while (f !== 0 && !nodes[f]?.next.has(c)) f = nodes[f]?.fail ?? 0;
      const cand = nodes[f]?.next.get(c);
      const nv = nodes[v] as Node;
      nv.fail = cand !== undefined && cand !== v ? cand : 0;
      const fn = nodes[nv.fail] as Node;
      nv.dict = fn.out.length > 0 ? nv.fail : fn.dict;
      queue.push(v);
    }
  }

  function rawMatches(text: string): { start: number; end: number; pi: number }[] {
    const res: { start: number; end: number; pi: number }[] = [];
    let cur = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      while (cur !== 0 && !nodes[cur]?.next.has(c)) cur = nodes[cur]?.fail ?? 0;
      cur = nodes[cur]?.next.get(c) ?? 0;
      for (let n = cur; n > 0; n = nodes[n]?.dict ?? -1) {
        const node = nodes[n] as Node;
        for (const pi of node.out) {
          const len = (patList[pi] as string).length;
          res.push({ start: i + 1 - len, end: i + 1, pi });
        }
        if (node.dict < 0) break;
      }
    }
    return res;
  }

  function scan(text: string): Mention[] {
    // leftmost-longest，不重叠
    const ms = rawMatches(text).sort((a, b) => a.start - b.start || b.end - a.end);
    const out: Mention[] = [];
    let lastEnd = 0;
    for (const m of ms) {
      if (m.start < lastEnd) continue;
      const alias = patList[m.pi] as string;
      for (const t of patterns.get(alias) ?? []) out.push({ entity: t.entity, alias, start: m.start, end: m.end, ambiguous: t.ambiguous || !!t.pov });
      lastEnd = m.end;
    }
    return out;
  }

  function sentenceBounds(text: string, start: number, end: number): [number, number] {
    let s = start;
    while (s > 0 && !SENTENCE_END.test(text[s - 1] as string)) s--;
    let e = end;
    while (e < text.length && !SENTENCE_END.test(text[e] as string)) e++;
    return [s, Math.min(text.length, e + 1)];
  }

  function resolve(mentions: Mention[], text: string, entitiesPresent: string[], opts: { pov?: string } = {}): Mention[] {
    const present = new Set(entitiesPresent);
    const firm = mentions.filter((m) => !m.ambiguous);
    // 同一位置的候选分组
    const groups = new Map<string, Mention[]>();
    for (const m of mentions) {
      if (!m.ambiguous) continue;
      const k = `${m.start}:${m.end}`;
      groups.set(k, [...(groups.get(k) ?? []), m]);
    }
    const kept: Mention[] = [...firm];
    for (const group of groups.values()) {
      // scope.pov：视角不符的候选先剔除
      const scoped = group.filter((m) => {
        const t = patterns.get(m.alias)?.find((x) => x.entity === m.entity);
        return !t?.pov || !opts.pov || t.pov === opts.pov;
      });
      if (scoped.length === 0) continue;
      const inPresent = scoped.filter((m) => present.has(m.entity));
      if (inPresent.length === 1) {
        kept.push(inPresent[0] as Mention);
        continue;
      }
      if (scoped.length > 1) {
        // 多实体共享的别名：只有视角唯一确定时才采纳
        const povHit = opts.pov ? scoped.filter((m) => patterns.get(m.alias)?.find((x) => x.entity === m.entity)?.pov === opts.pov) : [];
        if (povHit.length === 1) kept.push(povHit[0] as Mention);
        continue;
      }
      const m = scoped[0] as Mention;
      if (inPresent.length === 1) {
        kept.push(m);
        continue;
      }
      const [ss, se] = sentenceBounds(text, m.start, m.end);
      const near = text.slice(Math.max(ss, m.start - 12), Math.min(se, m.end + 12)).replace(m.alias, '');
      if (ACTION_RE.test(near)) {
        kept.push(m);
        continue;
      }
      if (firm.some((f) => f.entity !== m.entity && f.start >= ss && f.end <= se)) kept.push(m);
    }
    return kept.sort((a, b) => a.start - b.start || (a.entity < b.entity ? -1 : 1));
  }

  function names(): Map<string, string> {
    const m = new Map<string, string>();
    for (const [text, list] of [...patterns.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const first = list.find((t) => !t.ambiguous) ?? list[0];
      if (first && !m.has(text)) m.set(text, first.entity);
    }
    return m;
  }

  return { scan, resolve, names, aliasesOf: (e) => byEntity.get(e) ?? [] };
}
