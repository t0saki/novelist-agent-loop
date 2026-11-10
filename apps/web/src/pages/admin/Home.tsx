/**
 * 首页（docs/v3/DESIGN.md §9）：顶部是待办（平时为空），下面每本书一行。
 * 默认只列在写和等待中的书；已完结、旧书（导入的、旧流程写的）另有筛选。
 */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { BookSummary, InboxItem, Page as ApiPage, QuotaStatus, RunRow } from '@novelist/shared';
import { useApi } from '../../api/hooks';
import { InboxItemCard } from '../../components/admin/InboxItem';
import { RunTable } from '../../components/admin/shared';
import { V3CostLine, V3StatusLine } from '../../components/admin/V3Status';
import { Badge, Card, cx, Empty, Page, PageHeader, Q } from '../../components/ui';
import { buildAlerts } from '../../lib/alerts';
import { fmtCjk } from '../../lib/format';
import { ACTIVE_RUN_STATES, BOOK_STATUS, V3_LENGTH_LABEL } from '../../lib/labels';

export type BookFilter = 'active' | 'finished' | 'legacy' | 'all';
export const BOOK_FILTERS: { id: BookFilter; label: string }[] = [
  { id: 'active', label: '在写' },
  { id: 'finished', label: '已完结' },
  { id: 'legacy', label: '旧书' },
  { id: 'all', label: '全部' },
];

function BookRow({ b }: { b: BookSummary }) {
  const s = b.v3;
  return (
    <li className="px-4 py-2.5 grid gap-1 md:grid-cols-[minmax(10rem,1.2fr)_2fr_auto] md:items-center">
      <div className="min-w-0">
        <Link to="/admin/books/$slug/$tab" params={{ slug: b.slug, tab: 'overview' }} className="text-sm font-medium hover:underline truncate block">
          {b.title}
        </Link>
        <div className="text-xs text-sub truncate">
          {b.genre}
          {s ? ` · ${V3_LENGTH_LABEL[s.length]} · 已写 ${b.frontiers.accepted} / 计划 ${s.plannedChapters} 章 · ${fmtCjk(b.totalCjk)} / ${fmtCjk(s.targetCjk)}` : ` · ${b.frontiers.accepted} 章 · ${fmtCjk(b.totalCjk)}`}
        </div>
      </div>
      {s ? (
        <V3StatusLine status={s.status} compact />
      ) : (
        <div className="flex items-center gap-2 text-sm text-sub">
          <Badge>旧书 · 只读</Badge>
          <Badge tone={BOOK_STATUS[b.status]?.tone}>{BOOK_STATUS[b.status]?.label ?? b.status}</Badge>
        </div>
      )}
      <div className="text-xs text-sub md:text-right space-y-0.5">
        <div className="tabular-nums">
          {s ? `存稿 ${b.frontiers.buffer} · ` : ''}已发布 {b.frontiers.published}
        </div>
        {s && <V3CostLine cost={s.cost} />}
      </div>
    </li>
  );
}

export function BooksCard({ filter, onFilter }: { filter: BookFilter; onFilter: (f: BookFilter) => void }) {
  const books = useApi<BookSummary[]>(`/api/admin/books?filter=${filter}`);
  return (
    <Card
      title="书"
      className="mb-4"
      padded={false}
      actions={
        <span className="inline-flex gap-1" role="group" aria-label="筛选">
          {BOOK_FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => onFilter(f.id)} className={cx('text-xs px-2 py-0.5 rounded-full border', filter === f.id ? 'border-accent text-accent' : 'border-line text-sub hover:text-ink')}>
              {f.label}
            </button>
          ))}
        </span>
      }
    >
      <Q q={books}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>
              {filter === 'active' ? (
                <>
                  没有在写的书。
                  <Link to="/admin/new" className="text-accent ml-1">
                    开一本
                  </Link>
                </>
              ) : (
                '没有。'
              )}
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((b) => (
                <BookRow key={b.slug} b={b} />
              ))}
            </ul>
          )
        }
      </Q>
    </Card>
  );
}

export function HomePage() {
  const [filter, setFilter] = useState<BookFilter>('active');
  const inbox = useApi<ApiPage<InboxItem>>('/api/admin/inbox?state=open&limit=100');
  const active = useApi<BookSummary[]>('/api/admin/books?filter=active');
  const quota = useApi<QuotaStatus[]>('/api/admin/quota');
  const runs = useApi<ApiPage<RunRow>>('/api/admin/runs?limit=50', { refetchMs: 30_000 });
  const alerts = useMemo(() => buildAlerts({ books: active.data, quota: quota.data }), [active.data, quota.data]);
  const activeRuns = useMemo(() => runs.data?.items.filter((r) => ACTIVE_RUN_STATES.includes(r.state)) ?? [], [runs.data]);

  return (
    <Page>
      <PageHeader title="首页" />
      <section className="mb-4" aria-label="待办">
        <h2 className="text-sm font-semibold mb-2">待办</h2>
        <Q q={inbox}>
          {(p) =>
            p.items.length === 0 ? (
              <div className="bg-panel border border-line rounded-lg">
                <Empty>没有待办</Empty>
              </div>
            ) : (
              <div className="space-y-3">
                {p.items.map((i) => (
                  <InboxItemCard key={i.id} item={i} />
                ))}
              </div>
            )
          }
        </Q>
      </section>

      {alerts.length > 0 && (
        <Card title="提示" className="mb-4">
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

      <BooksCard filter={filter} onFilter={setFilter} />

      {activeRuns.length > 0 && (
        <Card title="正在运行" padded={false}>
          <RunTable rows={activeRuns} />
        </Card>
      )}
    </Page>
  );
}
