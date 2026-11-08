/** 模板公共片段（中文）。Owner: lane E。 */
import type { Snapshot } from '@novelist/shared';
import { truncateCjk } from '../../context/index.js';

export const STATE_BRIEF_LIMIT = 4000;

export const OP_REFERENCE = `## op 速查（nv.delta/1）

实体用既有 id，新实体用 \`tmp:\` id。ev 一律是草稿逐字引文。
- 实体：entity.create{ent,kind,name,aliases,declared,ev} / entity.update{ent,from?,set,ev} / entity.retire{ent,how,ev}
- 事件与事实：event{id,who,what,loc?,ev} / fact.assert{fact,text,about,ev}
- 认知：knowledge.learn{who,fact,how?,ev} / reader.reveal{fact,ev} / identity.reveal{ent,identity,to,ev}
- 伏笔：obligation.open{id,kind,weight,due?,text,ev} / obligation.advance{id,note?,ev} / obligation.pay{id,ev} / obligation.abandon{id,reason,ev?}
- 进程：arc.stage{who,stage,ev} / arc.resolve{arc,ev} / time.advance{to,flashback?,ev?} / power.change{who,system,from?,to,ev}
- 其他：offscreen.update{ent,set,declared_by_card} / item.transfer{item,from?,to,ev} / relation.set{a,b,type,ev}
`;

export const PREDICATE_REFERENCE = `## 谓词速查（nv.predicate/1）

pre / post / must_not / final_state 使用的条件，二选一：谓词，或 op 模式（如 { op: knowledge.learn, who: char.x, fact: fact.y }）。谓词：
- { eq: [{ attr: [char.x, title] }, 宗主] }（ne、in 同形）
- { knows: [char.x, fact.y] } / { knows_not: [char.x, fact.y] }
- { obligation: F0001, status: paid }（open/advanced/paid/abandoned）
- { stage: [char.x, s2] } / { at_loc: [char.x, loc.y] } / { alive: char.x } / { dead: char.x } / { has_cond: [char.x, injury.arm] }
- { and: [..] } / { or: [..] } / { not: .. } / { manual: "需 owner 判断的说明" }
`;

/** 规划任务用的账本概况：时间、未收束伏笔、里程碑 */
export function stateBrief(snapshot: Snapshot): string {
  const open = Object.values(snapshot.obligations).filter((o) => o.status === 'open' || o.status === 'advanced');
  const lines = [
    `账本已到：${snapshot.through ?? '尚未开始'}；累计 ${snapshot.total_cjk} 字。`,
    `实体 ${Object.keys(snapshot.entities).length} 个，事实 ${Object.keys(snapshot.facts).length} 条。`,
    '未收束伏笔：',
    ...open.slice(0, 80).map((o) => `- ${o.id}［${o.weight}］${o.text}${o.due ? `（due ${o.due[0]}–${o.due[1]}）` : ''}`),
  ];
  return truncateCjk(lines.join('\n'), STATE_BRIEF_LIMIT, 'tail').text;
}
