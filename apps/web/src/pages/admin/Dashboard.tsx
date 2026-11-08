/** 仪表盘：lane、活跃 run、配额窗口、最近提交、告警、实时活动。Owner: lane H。 */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueries } from '@tanstack/react-query';
import { LANES, type BookSummary, type GitCommitRow, type HarnessStatus, type InboxItem, type Page as ApiPage, type QuotaStatus, type RunRow, type SseEvent, type TaskRow } from '@novelist/shared';
import { enc, get } from '../../api/client';
import { useApi } from '../../api/hooks';
import { RunTable, WaitingNote, FrontierBar } from '../../components/admin/shared';
import { Badge, Card, Empty, Meter, Page, PageHeader, Q, Stat } from '../../components/ui';
import { useAdminEvent } from '../../lib/adminEvents';
import { buildAlerts } from '../../lib/alerts';
import { fmtCjk, fmtRel, fmtTime, toRatio } from '../../lib/format';
import { ACTIVE_RUN_STATES, BOOK_STATUS, WINDOW_LABEL } from '../../lib/labels';

const LANE_LABEL: Record<string, string> = { write: '写作', side: '旁路', system: '系统' };

function describeSse(e: SseEvent): string | null {
  switch (e.type) {
    case 'run_started':
      return `启动 run：${e.role}（${e.profile}）${e.book ? ` · ${e.book}` : ''}`;
    case 'run_exit':
      return `run 结束：${e.state}${e.errorClass ? `（${e.errorClass}）` : ''}`;
    case 'quota_wait':
      return `账号 ${e.accountId} 等待配额：${e.reason}`;
    case 'inbox_new':
      return `新 Inbox：${e.item.title}`;
    case 'chapter_accepted':
      return `${e.book} 验收第 ${e.no} 章（${fmtCjk(e.cjk)}）`;
    case 'chapter_published':
      return `${e.book} 发布第 ${e.no} 章`;
    case 'circuit_changed':
      return `${e.harness} 熔断状态：${e.state}${e.reason ? `（${e.reason}）` : ''}`;
    default:
      return null;
  }
}

export function DashboardPage() {
  const books = useApi<BookSummary[]>('/api/admin/books');
  const runs = useApi<ApiPage<RunRow>>('/api/admin/runs?limit=50');
  const tasks = useApi<ApiPage<TaskRow>>('/api/admin/tasks?limit=300');
  const quota = useApi<QuotaStatus[]>('/api/admin/quota');
  const harness = useApi<HarnessStatus[]>('/api/admin/harness');
  const inbox = useApi<ApiPage<InboxItem>>('/api/admin/inbox?state=open&limit=100');

  const [feed, setFeed] = useState<{ id: number; ts: string; text: string }[]>([]);
  useAdminEvent((e) => {
    const text = describeSse(e);
    if (text) setFeed((f) => [{ id: Date.now() + Math.random(), ts: new Date().toISOString(), text }, ...f].slice(0, 30));
  });

  const activeRuns = useMemo(() => runs.data?.items.filter((r) => ACTIVE_RUN_STATES.includes(r.state)) ?? [], [runs.data]);
  const alerts = useMemo(() => buildAlerts({ books: books.data, harness: harness.data, quota: quota.data, inbox: inbox.data?.items }), [books.data, harness.data, quota.data, inbox.data]);

  const lanes = useMemo(() => {
    const m = new Map<string, Record<string, number>>(LANES.map((l) => [l, {}]));
    for (const t of tasks.data?.items ?? []) {
      const row = m.get(t.lane) ?? {};
      row[t.state] = (row[t.state] ?? 0) + 1;
      m.set(t.lane, row);
    }
    return [...m.entries()];
  }, [tasks.data]);

  const recentSlugs = useMemo(() => [...(books.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4).map((b) => b.slug), [books.data]);
  const logs = useQueries({
    queries: recentSlugs.map((slug) => {
      const path = `/api/admin/books/${enc(slug)}/git/log?limit=5`;
      return { queryKey: [path], queryFn: () => get<ApiPage<GitCommitRow>>(path) };
    }),
  });
  const commits = logs
    .flatMap((l, i) => (l.data?.items ?? []).map((c) => ({ ...c, slug: recentSlugs[i] as string })))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 8);

  const totalCjk = books.data?.reduce((s, b) => s + b.totalCjk, 0) ?? 0;
  const activeBooks = books.data?.filter((b) => b.status === 'active').length ?? 0;

  return (
    <Page>
      <PageHeader title="仪表盘" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat label="写作中的书" value={activeBooks} sub={`共 ${books.data?.length ?? 0} 本`} />
        <Stat label="累计字数" value={fmtCjk(totalCjk)} />
        <Stat label="活跃 run" value={activeRuns.length} />
        <Stat label="待处理 Inbox" value={inbox.data?.items.length ?? 0} />
      </div>

      {alerts.length > 0 && (
        <Card title="告警" className="mb-4">
          <ul className="space-y-1.5">
            {alerts.map((a) => (
              <li key={a.id} className="flex gap-2 items-start text-sm">
                <Badge tone={a.tone}>{a.tone === 'danger' ? '严重' : a.tone === 'warn' ? '注意' : '提示'}</Badge>
                {a.to ? (
                  <Link to={a.to} className="hover:underline">
                    {a.text}
                  </Link>
                ) : (
                  a.text
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <Card title="Lane 负载">
          <Q q={tasks}>
            {() => (
              <div className="space-y-3">
                {lanes.map(([lane, c]) => (
                  <div key={lane}>
                    <div className="text-sm font-medium">{LANE_LABEL[lane] ?? lane}</div>
                    <div className="text-xs text-sub tabular-nums mt-0.5">
                      运行 {(c.running ?? 0) + (c.leased ?? 0) + (c.finalizing ?? 0)} · 就绪 {c.ready ?? 0} · 等待 {c.waiting ?? 0} · 需处理 {(c.blocked ?? 0) + (c.failed ?? 0)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Q>
        </Card>
        <Card title="配额窗口" actions={<Link to="/admin/quota" className="text-xs text-sub hover:text-ink">详情</Link>} className="lg:col-span-2">
          <Q q={quota}>
            {(rows) =>
              rows.length === 0 ? (
                <Empty>还没有账号，去 Harness 与账号页添加。</Empty>
              ) : (
                <div className="grid sm:grid-cols-2 gap-x-6 gap-y-4">
                  {rows.map((q) => (
                    <div key={q.accountId} className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="truncate">{q.accountId}</span>
                        <span className="text-xs text-faint">
                          {q.activeRuns}/{q.concurrency} 并发
                        </span>
                      </div>
                      {q.windows.map((w) => (
                        <Meter key={w.window} label={WINDOW_LABEL[w.window] ?? w.window} ratio={toRatio(w.utilization)} reserved={w.reserved} />
                      ))}
                      {q.sleepUntil && <div className="text-xs text-warn">休眠至 {fmtTime(q.sleepUntil)}</div>}
                    </div>
                  ))}
                </div>
              )
            }
          </Q>
        </Card>
      </div>

      <Card title="活跃 run" padded={false} className="mb-4" actions={<Link to="/admin/runs" className="text-xs text-sub hover:text-ink">全部</Link>}>
        <Q q={runs}>{() => <RunTable rows={activeRuns} />}</Q>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <Card title="书">
          <Q q={books}>
            {(rows) =>
              rows.length === 0 ? (
                <Empty>
                  还没有书。
                  <Link to="/admin/books/new" className="text-accent ml-1">
                    开一本
                  </Link>
                </Empty>
              ) : (
                <div className="space-y-4">
                  {rows.slice(0, 6).map((b) => (
                    <div key={b.slug}>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <Link to="/admin/books/$slug/$tab" params={{ slug: b.slug, tab: 'overview' }} className="text-sm font-medium hover:underline truncate">
                          {b.title}
                        </Link>
                        <Badge tone={BOOK_STATUS[b.status].tone}>{BOOK_STATUS[b.status].label}</Badge>
                      </div>
                      <FrontierBar f={b.frontiers} />
                      <WaitingNote book={b} />
                    </div>
                  ))}
                </div>
              )
            }
          </Q>
        </Card>
        <div className="space-y-4">
          <Card title="最近提交">
            {commits.length === 0 ? (
              <Empty>暂无提交。</Empty>
            ) : (
              <ul className="space-y-1.5">
                {commits.map((c) => (
                  <li key={`${c.slug}-${c.sha}`} className="text-sm flex items-baseline justify-between gap-2">
                    <span className="truncate">
                      <span className="text-xs text-faint mr-1.5">{c.slug}</span>
                      {c.subject}
                    </span>
                    <span className="text-xs text-faint shrink-0">{fmtRel(c.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="实时活动">
            {feed.length === 0 ? (
              <Empty>等待事件…</Empty>
            ) : (
              <ul className="space-y-1 max-h-60 overflow-y-auto">
                {feed.map((f) => (
                  <li key={f.id} className="text-xs flex gap-2">
                    <span className="text-faint shrink-0 tabular-nums">{fmtTime(f.ts).slice(-5)}</span>
                    <span>{f.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}
