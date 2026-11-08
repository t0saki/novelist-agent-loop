/** 规划与设定：结构总览 + 书库文件编辑。Owner: lane H。 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { PlanOverview, StateView } from '@novelist/shared';
import { enc } from '../../../api/client';
import { useApi } from '../../../api/hooks';
import { RepoBrowser } from '../../../components/admin/RepoBrowser';
import { Badge, Card, Details, Empty, Input, Meter, Pre, Q, Tabs } from '../../../components/ui';
import { CHAPTER_STATE } from '../../../lib/labels';
import { parseChapterNo } from '../../../lib/chapterId';

export function PlanTab({ slug }: { slug: string }) {
  const [tab, setTab] = useState<'overview' | 'files'>('overview');
  const q = useApi<PlanOverview>(`/api/admin/books/${enc(slug)}/plan`);
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: '结构总览' },
          { id: 'files', label: '文件编辑' },
        ]}
      />
      {tab === 'files' ? (
        <RepoBrowser slug={slug} dir="plan" emptyHint="选择规划文件编辑。卡片 notes 字段是本章笔记，会进入最高优先级层。" newPlaceholder="如 plan/cards/c00421.yaml" />
      ) : (
        <Q q={q}>
          {(p) => (
            <div className="space-y-4">
              <div className="grid lg:grid-cols-2 gap-4">
                <Card
                  title={
                    <span className="flex items-center gap-2">
                      Compass
                      <Badge tone={p.compassApproved ? 'ok' : 'warn'}>{p.compassApproved ? '已批准' : '待批准'}</Badge>
                      {p.endgame && <Badge tone="accent">终局</Badge>}
                    </span>
                  }
                >
                  {p.compass ? <Pre className="max-h-64">{JSON.stringify(p.compass, null, 2)}</Pre> : <Empty>还没有 Compass。</Empty>}
                </Card>
                <Card title="卡片缓冲">
                  <Meter label={`已规划 ${p.cardBuffer.have} 张，目标 ${p.cardBuffer.target}（低于 ${p.cardBuffer.min} 补规划）`} ratio={p.cardBuffer.target > 0 ? p.cardBuffer.have / p.cardBuffer.target : 0} detail={`${p.cardBuffer.have}/${p.cardBuffer.target}`} />
                  <p className="text-xs text-sub mt-3">
                    共 {p.volumes.length} 卷、{p.arcs.length} 个弧、{p.cards.length} 张卡片。
                  </p>
                </Card>
              </div>
              <Card title="分卷与弧">
                {p.volumes.length === 0 ? (
                  <Empty>还没有分卷规划。</Empty>
                ) : (
                  <div className="space-y-2">
                    {p.volumes.map((v) => {
                      const arcs = p.arcs.filter((a) => a.volume === v.id);
                      return (
                        <Details
                          key={v.id}
                          summary={
                            <span className="flex flex-wrap items-baseline gap-2">
                              <span className="font-medium">{v.title}</span>
                              <span className="text-xs text-faint">
                                {v.id} · {v.detail}
                                {v.chapters && ` · ${v.chapters[0]}–${v.chapters[1]}`}
                              </span>
                            </span>
                          }
                        >
                          <ul className="pl-4 space-y-1">
                            {arcs.map((a) => (
                              <li key={a.id} className="text-sm flex flex-wrap items-baseline gap-2">
                                {a.title}
                                <span className="text-xs text-faint">
                                  {a.id} · {a.chapters[0]}–{a.chapters[1]}
                                </span>
                                {a.resolved && <Badge tone="ok">已收束</Badge>}
                              </li>
                            ))}
                            {arcs.length === 0 && <li className="text-xs text-faint">这一卷还没有弧。</li>}
                          </ul>
                        </Details>
                      );
                    })}
                  </div>
                )}
              </Card>
              <CardList slug={slug} cards={p.cards} />
            </div>
          )}
        </Q>
      )}
    </>
  );
}

function CardList({ slug, cards }: { slug: string; cards: PlanOverview['cards'] }) {
  const [text, setText] = useState('');
  const shown = text ? cards.filter((c) => c.id.includes(text) || c.title.includes(text)) : cards;
  return (
    <Card title={`卡片（${cards.length}）`} actions={<Input className="w-40" placeholder="搜索" value={text} onChange={(e) => setText(e.target.value)} aria-label="搜索卡片" />} padded={false}>
      {shown.length === 0 ? (
        <Empty>没有卡片。</Empty>
      ) : (
        <ul className="max-h-[32rem] overflow-y-auto divide-y divide-line">
          {shown.slice(0, 500).map((c) => {
            const st = CHAPTER_STATE[c.state];
            const no = parseChapterNo(c.id);
            return (
              <li key={c.id} className="flex items-center gap-2 px-4 py-1.5 text-sm">
                <code className="text-xs text-faint shrink-0">{c.id}</code>
                {no !== null ? (
                  <Link to="/admin/books/$slug/chapters/$no" params={{ slug, no: String(no) }} className="truncate flex-1 hover:underline">
                    {c.title}
                  </Link>
                ) : (
                  <span className="truncate flex-1">{c.title}</span>
                )}
                {c.key && <Badge tone="accent">关键</Badge>}
                {c.stale && <Badge tone="warn">过期</Badge>}
                <Badge tone={st?.tone}>{st?.label ?? c.state}</Badge>
              </li>
            );
          })}
        </ul>
      )}
      {shown.length > 500 && <p className="text-xs text-faint text-center py-2">只显示前 500 张，用搜索缩小范围。</p>}
    </Card>
  );
}

export function BibleTab({ slug }: { slug: string }) {
  const [tab, setTab] = useState<'files' | 'entities'>('files');
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'files', label: '设定文件' },
          { id: 'entities', label: '实体现状' },
        ]}
      />
      {tab === 'files' ? <RepoBrowser slug={slug} dir="bible" emptyHint="选择设定文件编辑。" newPlaceholder="如 bible/entities/characters/lin-feng.md" /> : <EntityTable slug={slug} />}
    </>
  );
}

export function EntityTable({ slug }: { slug: string }) {
  const q = useApi<StateView>(`/api/admin/books/${enc(slug)}/state`);
  const [text, setText] = useState('');
  return (
    <Q q={q}>
      {(s) => {
        const list = text ? s.entities.filter((e) => e.name.includes(text) || e.id.includes(text) || e.aliases.some((a) => a.includes(text))) : s.entities;
        return (
          <Card title={`实体（${s.entities.length}）`} actions={<Input className="w-40" placeholder="搜索" value={text} onChange={(e) => setText(e.target.value)} aria-label="搜索实体" />} padded={false}>
            {list.length === 0 ? (
              <Empty>没有实体。</Empty>
            ) : (
              <div className="overflow-x-auto max-h-[70vh]">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>类型</th>
                      <th>状态</th>
                      <th>属性</th>
                      <th>最近出场</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.slice(0, 500).map((e) => (
                      <tr key={e.id}>
                        <td>
                          {e.name}
                          <code className="block text-xs text-faint">{e.id}</code>
                          {e.aliases.length > 0 && <span className="block text-xs text-faint">{e.aliases.join('、')}</span>}
                        </td>
                        <td className="text-sub whitespace-nowrap">
                          {e.kind}
                          <span className="block text-xs text-faint">{e.tier}</span>
                        </td>
                        <td>{e.alive ? <Badge tone="ok">在场</Badge> : <Badge tone="neutral">{e.retired ?? '退场'}</Badge>}</td>
                        <td className="text-xs text-sub max-w-md">
                          {e.stage && <span className="block">阶段：{e.stage}</span>}
                          {Object.keys(e.power).length > 0 && <span className="block">{Object.entries(e.power).map(([k, v]) => `${k}=${v}`).join('，')}</span>}
                          {e.conds.length > 0 && <span className="block">{e.conds.join('、')}</span>}
                          {Object.keys(e.attrs).length > 0 && <code className="block">{JSON.stringify(e.attrs)}</code>}
                        </td>
                        <td className="text-xs text-faint whitespace-nowrap">{e.last_seen ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      }}
    </Q>
  );
}
