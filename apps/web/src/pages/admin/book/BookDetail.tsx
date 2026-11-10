/** 书详情：旧流程 tabs = 概览 / 规划 / 设定 / 章节 / 状态 / 评审 / 运行 / 指令 / 设置；新流程（v3）书走 V3Book.tsx。Owner: lane H。 */
import { Link } from '@tanstack/react-router';
import type { BookOverview } from '@novelist/shared';
import { enc } from '../../../api/client';
import { useApi } from '../../../api/hooks';
import { InstructionWorkbench } from '../../../components/admin/InstructionWorkbench';
import { Badge, cx, Page, Q } from '../../../components/ui';
import { BOOK_STATUS, TIER_INFO, V3_LENGTH_LABEL } from '../../../lib/labels';
import { V3_BOOK_TABS, V3BookTabs } from './V3Book';
import { ChaptersTab } from './Chapters';
import { BibleTab, PlanTab } from './Content';
import { OverviewTab } from './Overview';
import { ReviewsTab, RunsTab } from './Activity';
import { SettingsTab } from './BookSettings';
import { QualityTab } from './Quality';
import { StateTab } from './StateTab';

export const BOOK_TABS = [
  { id: 'overview', label: '概览' },
  { id: 'plan', label: '规划' },
  { id: 'bible', label: '设定' },
  { id: 'chapters', label: '章节' },
  { id: 'state', label: '状态' },
  { id: 'reviews', label: '评审' },
  { id: 'quality', label: '质量' },
  { id: 'runs', label: '运行' },
  { id: 'instructions', label: '指令' },
  { id: 'settings', label: '设置' },
] as const;
export type BookTab = (typeof BOOK_TABS)[number]['id'];

export function BookDetailPage(props: { slug: string; tab: string }) {
  const q = useApi<BookOverview>(`/api/admin/books/${enc(props.slug)}`);
  return (
    <Page wide>
      <Q q={q}>
        {(b) => {
          const v3 = b.config.flow === 'v3';
          const tabs: readonly { id: string; label: string }[] = v3 ? V3_BOOK_TABS : BOOK_TABS;
          const tab = tabs.find((t) => t.id === props.tab) ?? (tabs[0] as { id: string; label: string });
          return (
          <>
            <div className="flex flex-wrap items-baseline gap-2 mb-3">
              <h1 className="text-xl font-semibold font-serif">{b.title}</h1>
              <Badge tone={BOOK_STATUS[b.status].tone}>{BOOK_STATUS[b.status].label}</Badge>
              <span className="text-xs text-sub">
                {b.genre} · {v3 ? `新流程${b.v3 ? ` · ${V3_LENGTH_LABEL[b.v3.length]}` : ''}` : TIER_INFO[b.tier].label}
              </span>
            </div>
            <div className="flex gap-1 border-b border-line overflow-x-auto no-scrollbar mb-4">
              {tabs.map((t) => (
                <Link key={t.id} to="/admin/books/$slug/$tab" params={{ slug: props.slug, tab: t.id }} className={cx('px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px', t.id === tab.id ? 'border-accent text-ink font-medium' : 'border-transparent text-sub hover:text-ink')}>
                  {t.label}
                  {t.id === 'overview' && b.inboxOpen > 0 && <span className="ml-1 text-xs text-accent">{b.inboxOpen}</span>}
                </Link>
              ))}
            </div>
            {v3 ? (
              <V3BookTabs book={b} tab={tab.id} />
            ) : (
              <>
                {tab.id === 'overview' && <OverviewTab book={b} />}
                {tab.id === 'plan' && <PlanTab slug={b.slug} />}
                {tab.id === 'bible' && <BibleTab slug={b.slug} />}
                {tab.id === 'chapters' && <ChaptersTab slug={b.slug} />}
                {tab.id === 'state' && <StateTab slug={b.slug} />}
                {tab.id === 'reviews' && <ReviewsTab slug={b.slug} />}
                {tab.id === 'quality' && <QualityTab slug={b.slug} />}
                {tab.id === 'runs' && <RunsTab slug={b.slug} />}
                {tab.id === 'instructions' && <InstructionWorkbench scope={`book:${b.slug}`} book={b.slug} />}
                {tab.id === 'settings' && <SettingsTab book={b} />}
              </>
            )}
          </>
          );
        }}
      </Q>
    </Page>
  );
}
