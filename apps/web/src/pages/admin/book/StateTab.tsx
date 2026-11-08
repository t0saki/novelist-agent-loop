/** 状态：实体、伏笔看板、时间线、知识、账本文件、债务、审计。Owner: lane H。 */
import { useMemo, useState } from 'react';
import type { Audit, Debt, ObligationState, StateView } from '@novelist/shared';
import { enc } from '../../../api/client';
import { useApi } from '../../../api/hooks';
import { RepoBrowser } from '../../../components/admin/RepoBrowser';
import { Badge, Card, cx, Empty, Input, Q, Stat, Tabs } from '../../../components/ui';
import { fmtCjk, fmtTime } from '../../../lib/format';
import { EntityTable } from './Content';

type Sub = 'obligations' | 'entities' | 'timeline' | 'knowledge' | 'ledger' | 'debts' | 'audits';
const COLUMNS: { id: ObligationState['status']; label: string }[] = [
  { id: 'open', label: '未回收' },
  { id: 'advanced', label: '推进中' },
  { id: 'paid', label: '已回收' },
  { id: 'abandoned', label: '已放弃' },
];
const COLUMN_LIMIT = 200;

export function StateTab({ slug }: { slug: string }) {
  const [sub, setSub] = useState<Sub>('obligations');
  const base = `/api/admin/books/${enc(slug)}`;
  const q = useApi<StateView>(`${base}/state`);
  return (
    <Q q={q}>
      {(s) => (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Stat label="状态折叠至" value={s.snapshot.through ?? '—'} sub={`hash ${s.snapshot.hash.slice(0, 8)}`} />
            <Stat label="累计字数" value={fmtCjk(s.snapshot.total_cjk)} />
            <Stat label="实体" value={s.entities.length} />
            <Stat label="逾期伏笔" value={s.overdue.length} sub={`共 ${s.obligations.length} 条`} />
          </div>
          <Tabs
            value={sub}
            onChange={setSub}
            tabs={[
              { id: 'obligations', label: '伏笔看板' },
              { id: 'entities', label: '实体' },
              { id: 'timeline', label: '时间线' },
              { id: 'knowledge', label: '知识' },
              { id: 'ledger', label: '账本文件' },
              { id: 'debts', label: '债务' },
              { id: 'audits', label: '审计' },
            ]}
          />
          {sub === 'obligations' && <ObligationBoard state={s} />}
          {sub === 'entities' && <EntityTable slug={slug} />}
          {sub === 'timeline' && (
            <Card padded={false}>
              {s.timeline.length === 0 ? (
                <Empty>还没有事件。</Empty>
              ) : (
                <ul className="divide-y divide-line max-h-[70vh] overflow-y-auto">
                  {s.timeline.map((t) => (
                    <li key={`${t.ch}:${t.what}`} className="px-4 py-2 text-sm flex gap-3">
                      <code className="text-xs text-faint shrink-0">{t.ch}</code>
                      <span className="min-w-0">
                        {t.what}
                        {t.who.length > 0 && <span className="block text-xs text-faint">{t.who.join('、')}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          {sub === 'knowledge' && (
            <div className="grid md:grid-cols-2 gap-3">
              <Card title="读者已知">{s.readerKnows.length === 0 ? <Empty>无。</Empty> : <FactList facts={s.readerKnows} />}</Card>
              {s.knowledge.map((k) => (
                <Card key={k.who} title={k.who}>
                  <FactList facts={k.facts} />
                </Card>
              ))}
            </div>
          )}
          {sub === 'ledger' && <RepoBrowser slug={slug} dir="state" readOnly emptyHint="账本由系统写入，这里只读。要修正事实请用 override。" />}
          {sub === 'debts' && <DebtList base={base} />}
          {sub === 'audits' && <AuditList base={base} />}
        </>
      )}
    </Q>
  );
}

const FactList = ({ facts }: { facts: string[] }) => (
  <ul className="text-sm space-y-1 list-disc pl-4 max-h-64 overflow-y-auto">
    {facts.map((f) => (
      <li key={f}>{f}</li>
    ))}
  </ul>
);

function ObligationBoard({ state }: { state: StateView }) {
  const [text, setText] = useState('');
  const overdue = useMemo(() => new Set(state.overdue.map((o) => o.id)), [state.overdue]);
  const shown = text ? state.obligations.filter((o) => o.text.includes(text) || o.id.includes(text)) : state.obligations;
  return (
    <div>
      <div className="max-w-xs mb-3">
        <Input placeholder="搜索伏笔" value={text} onChange={(e) => setText(e.target.value)} aria-label="搜索伏笔" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {COLUMNS.map((c) => {
          const items = shown.filter((o) => o.status === c.id);
          return (
            <section key={c.id} className="bg-panel2/60 rounded-lg p-2 min-w-0">
              <h3 className="text-xs text-sub px-1 mb-2">
                {c.label}（{items.length}）
              </h3>
              <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                {items.slice(0, COLUMN_LIMIT).map((o) => (
                  <article key={o.id} className={cx('bg-panel border rounded-md p-2 text-sm', overdue.has(o.id) ? 'border-danger/60' : 'border-line')}>
                    <div className="flex flex-wrap items-center gap-1 mb-1">
                      <Badge tone={o.weight === 'main' ? 'accent' : o.weight === 'major' ? 'info' : 'neutral'}>{{ main: '主线', major: '重要', minor: '次要' }[o.weight]}</Badge>
                      {overdue.has(o.id) && <Badge tone="danger">逾期</Badge>}
                      <code className="text-xs text-faint">{o.id}</code>
                    </div>
                    <p>{o.text}</p>
                    <p className="text-xs text-faint mt-1">
                      开启 {o.opened}
                      {o.due && ` · 应回收 ${o.due[0]}–${o.due[1]}`}
                      {o.closed && ` · 关闭 ${o.closed}`}
                      {o.advances.length > 0 && ` · 推进 ${o.advances.length} 次`}
                    </p>
                  </article>
                ))}
                {items.length > COLUMN_LIMIT && <p className="text-xs text-faint text-center">还有 {items.length - COLUMN_LIMIT} 条，用搜索缩小范围。</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function DebtList({ base }: { base: string }) {
  const q = useApi<Debt[]>(`${base}/debts`);
  return (
    <Card padded={false}>
      <Q q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>没有债务。</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>章</th>
                    <th>类别</th>
                    <th>规则</th>
                    <th>详情</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td className="text-xs text-sub whitespace-nowrap">{d.chapter}</td>
                      <td>
                        <Badge tone={d.class === 'forward' ? 'warn' : 'neutral'}>{d.class === 'forward' ? '前向' : '指标'}</Badge>
                      </td>
                      <td>
                        <code className="text-xs">{d.rule}</code>
                      </td>
                      <td className="text-sub">{d.detail}</td>
                      <td>
                        <Badge tone={d.status === 'open' ? 'warn' : 'ok'}>{{ open: '未还', paid: `已还${d.paid_by ? ` ${d.paid_by}` : ''}`, waived: '已豁免' }[d.status]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Q>
    </Card>
  );
}

function AuditList({ base }: { base: string }) {
  const q = useApi<Audit[]>(`${base}/audits`);
  return (
    <Q q={q}>
      {(rows) =>
        rows.length === 0 ? (
          <Empty>还没有审计记录。</Empty>
        ) : (
          <div className="space-y-3">
            {rows.map((a) => (
              <Card key={`${a.kind}-${a.range[0]}-${a.ts}`}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={a.passed ? 'ok' : 'danger'}>{a.passed ? '通过' : '未通过'}</Badge>
                  <span>{a.kind}</span>
                  <span className="text-xs text-sub">
                    {a.range[0]}–{a.range[1]}
                  </span>
                  <span className="text-xs text-faint">{fmtTime(a.ts)}</span>
                  {a.snapshot_hash_ok === false && <Badge tone="danger">快照 hash 不一致</Badge>}
                </div>
                {Object.keys(a.metrics).length > 0 && (
                  <p className="text-xs text-sub mt-2 tabular-nums">
                    {Object.entries(a.metrics)
                      .map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(3)}`)
                      .join(' · ')}
                  </p>
                )}
                {a.findings.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {a.findings.map((f) => (
                      <li key={f.id}>
                        <Badge tone={f.severity === 'hard' ? 'danger' : 'warn'}>{f.severity === 'hard' ? '硬伤' : '软问题'}</Badge> {f.message}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}
          </div>
        )
      }
    </Q>
  );
}
