/** 账号额度窗口与用量报表（模型与账号页的一节）。 */
import { useState } from 'react';
import type { QuotaStatus, UsageReport } from '@novelist/shared';
import { qs } from '../../api/client';
import { useApi } from '../../api/hooks';
import { BarChart } from '../charts';
import { Badge, Card, Empty, Field, Input, Meter, Q, Select } from '../ui';
import { fmtNum, fmtRel, fmtTime, fmtUsd, toRatio } from '../../lib/format';
import { WINDOW_LABEL } from '../../lib/labels';

const GROUPS: { id: string; label: string }[] = [
  { id: 'day', label: '按天' },
  { id: 'book', label: '按书' },
  { id: 'profile', label: '按 Profile' },
  { id: 'account', label: '按账号' },
  { id: 'task_kind', label: '按任务类型' },
];

export function UsageSection() {
  const quota = useApi<QuotaStatus[]>('/api/admin/quota', { refetchMs: 30_000 });
  const [groupBy, setGroupBy] = useState('day');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const usage = useApi<UsageReport>(`/api/admin/usage${qs({ groupBy, from, to })}`);
  return (
    <div>
      <Q q={quota}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>还没有账号。</Empty>
          ) : (
            <div className="grid md:grid-cols-2 gap-3 mb-6">
              {rows.map((q) => (
                <Card
                  key={q.accountId}
                  title={
                    <span className="flex items-center gap-2">
                      {q.accountId} <span className="text-xs text-faint font-normal">{q.harness}</span>
                    </span>
                  }
                  actions={q.plan ? <Badge>{q.plan}</Badge> : undefined}
                >
                  <div className="space-y-3">
                    {q.windows.map((w) => (
                      <div key={w.window}>
                        <Meter label={WINDOW_LABEL[w.window] ?? w.window} ratio={toRatio(w.utilization)} />
                        {w.resetsAt && <div className="text-xs text-faint mt-0.5">{fmtRel(w.resetsAt)}重置（{fmtTime(w.resetsAt)}）</div>}
                      </div>
                    ))}
                    {q.windows.length === 0 && <p className="text-xs text-faint">暂无窗口数据。</p>}
                    <div className="text-xs text-sub">
                      活跃 {q.activeRuns}/{q.concurrency}
                      {q.sleepUntil && <span className="text-warn"> · 休眠至 {fmtTime(q.sleepUntil)}{q.sleepReason ? `（${q.sleepReason}）` : ''}</span>}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )
        }
      </Q>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <Field label="分组">
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            {GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="开始日期">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="结束日期">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <Q q={usage}>
        {(u) =>
          u.rows.length === 0 ? (
            <Empty>这段时间没有用量。</Empty>
          ) : (
            <div className="space-y-4">
              <div className="grid lg:grid-cols-2 gap-4">
                <Card>
                  <BarChart
                    title="Token（输入 + 输出）"
                    keyHeader={GROUPS.find((g) => g.id === groupBy)?.label ?? '分组'}
                    format={fmtNum}
                    data={u.rows.map((r) => ({
                      key: r.key,
                      value: r.input + r.output,
                      detail: (
                        <span className="whitespace-nowrap">
                          输入 {fmtNum(r.input)} · 缓存 {fmtNum(r.cached)} · 输出 {fmtNum(r.output)} · {r.runs} 个 run
                        </span>
                      ),
                    }))}
                  />
                </Card>
                <Card>
                  <BarChart title="API 费用（美元，仅按量账号）" keyHeader={GROUPS.find((g) => g.id === groupBy)?.label ?? '分组'} format={(v) => fmtUsd(v)} data={u.rows.map((r) => ({ key: r.key, value: r.usd }))} />
                </Card>
              </div>
              {u.perChapter.length > 0 && (
                <Card title="单章实测消耗" padded={false}>
                  <div className="overflow-x-auto">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Profile</th>
                          <th className="text-right">Token/章</th>
                          <th>窗口占用/章</th>
                          <th className="text-right">样本</th>
                        </tr>
                      </thead>
                      <tbody>
                        {u.perChapter.map((p) => (
                          <tr key={`${p.profile}-${p.tier}`}>
                            <td>{p.profile}</td>
                            <td className="text-right tabular-nums">{fmtNum(p.tokens)}</td>
                            <td className="text-xs text-sub">
                              {Object.entries(p.utilDelta)
                                .map(([w, v]) => `${w} ${(v * 100).toFixed(2)}%`)
                                .join(' · ') || '—'}
                            </td>
                            <td className="text-right tabular-nums">{p.samples}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </div>
          )
        }
      </Q>
    </div>
  );
}
