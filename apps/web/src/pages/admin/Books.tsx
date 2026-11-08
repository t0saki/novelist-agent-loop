/** 书列表。Owner: lane H。 */
import { Link } from '@tanstack/react-router';
import type { BookSummary } from '@novelist/shared';
import { enc, post } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { FrontierBar, WaitingNote } from '../../components/admin/shared';
import { Badge, Button, Empty, Page, PageHeader, Q } from '../../components/ui';
import { fmtCjk, fmtRel } from '../../lib/format';
import { BOOK_STATUS, TIER_INFO } from '../../lib/labels';

export function BooksPage() {
  const q = useApi<BookSummary[]>('/api/admin/books');
  const act = useAction(({ slug, action }: { slug: string; action: string }) => post(`/api/admin/books/${enc(slug)}/actions`, { action }), { ok: '已提交', invalidate: ['/api/admin/books'] });
  return (
    <Page>
      <PageHeader
        title="书"
        actions={
          <Link to="/admin/books/new" className="bg-accent text-on-accent rounded-md text-sm px-3.5 py-1.5">
            开新书
          </Link>
        }
      />
      <Q q={q}>
        {(books) =>
          books.length === 0 ? (
            <Empty>还没有书，点右上角“开新书”。</Empty>
          ) : (
            <div className="grid md:grid-cols-2 gap-3">
              {books.map((b) => (
                <article key={b.slug} className="bg-panel border border-line rounded-lg p-4 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link to="/admin/books/$slug/$tab" params={{ slug: b.slug, tab: 'overview' }} className="font-medium hover:underline">
                        {b.title}
                      </Link>
                      <div className="text-xs text-sub mt-0.5">
                        {b.genre} · {TIER_INFO[b.tier].label} · {fmtCjk(b.totalCjk)} · {fmtRel(b.updatedAt)}更新
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {b.inboxOpen > 0 && <Badge tone="accent">Inbox {b.inboxOpen}</Badge>}
                      <Badge tone={BOOK_STATUS[b.status].tone}>{BOOK_STATUS[b.status].label}</Badge>
                    </div>
                  </div>
                  <div className="mt-3">
                    <FrontierBar f={b.frontiers} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
                    <div className="text-xs text-sub">
                      存稿 {b.frontiers.buffer} 章{b.frontiers.bufferDays !== null && `（约 ${b.frontiers.bufferDays.toFixed(1)} 天）`} · {b.activeTasks} 个活跃任务 <WaitingNote book={b} />
                    </div>
                    <div className="flex gap-1">
                      {b.status === 'draft' && (
                        <Button size="sm" onClick={() => act.mutate({ slug: b.slug, action: 'start' })}>
                          启动
                        </Button>
                      )}
                      {(b.status === 'active' || b.status === 'planning') && (
                        <Button size="sm" onClick={() => act.mutate({ slug: b.slug, action: 'pause' })}>
                          暂停
                        </Button>
                      )}
                      {b.status === 'paused' && (
                        <Button size="sm" onClick={() => act.mutate({ slug: b.slug, action: 'resume' })}>
                          恢复
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )
        }
      </Q>
    </Page>
  );
}
