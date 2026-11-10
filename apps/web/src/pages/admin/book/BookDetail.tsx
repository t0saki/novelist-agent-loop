/** 书页：旧书（导入的、旧流程写的）走 LegacyBook.tsx；新流程的书分区：概览 / 章节 / 故事资料 / 草稿 / 花费 / 指令 / 设置（V3Book.tsx）。 */
import { Link } from '@tanstack/react-router';
import type { BookOverview } from '@novelist/shared';
import { enc } from '../../../api/client';
import { useApi } from '../../../api/hooks';
import { Badge, cx, Page, Q } from '../../../components/ui';
import { BOOK_STATUS, V3_LENGTH_LABEL } from '../../../lib/labels';
import { LegacyBookPage } from './LegacyBook';
import { V3_BOOK_TABS, V3BookTabs } from './V3Book';

export function BookDetailPage(props: { slug: string; tab: string }) {
  const q = useApi<BookOverview>(`/api/admin/books/${enc(props.slug)}`);
  return (
    <Page wide>
      <Q q={q}>
        {(b) => {
          if (b.legacy) return <LegacyBookPage book={b} />;
          const tab = V3_BOOK_TABS.find((t) => t.id === props.tab) ?? V3_BOOK_TABS[0];
          return (
            <>
              <div className="flex flex-wrap items-baseline gap-2 mb-3">
                <h1 className="text-xl font-semibold font-serif">{b.title}</h1>
                <Badge tone={BOOK_STATUS[b.status]?.tone}>{BOOK_STATUS[b.status]?.label ?? b.status}</Badge>
                <span className="text-xs text-sub">
                  {b.genre}
                  {b.v3 ? ` · ${V3_LENGTH_LABEL[b.v3.length]}` : ''}
                </span>
              </div>
              <div className="flex gap-1 border-b border-line overflow-x-auto no-scrollbar mb-4">
                {V3_BOOK_TABS.map((t) => (
                  <Link key={t.id} to="/admin/books/$slug/$tab" params={{ slug: props.slug, tab: t.id }} className={cx('px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px', t.id === tab.id ? 'border-accent text-ink font-medium' : 'border-transparent text-sub hover:text-ink')}>
                    {t.label}
                    {t.id === 'overview' && b.inboxOpen > 0 && <span className="ml-1 text-xs text-accent">{b.inboxOpen}</span>}
                  </Link>
                ))}
              </div>
              <V3BookTabs book={b} tab={tab.id} />
            </>
          );
        }}
      </Q>
    </Page>
  );
}
