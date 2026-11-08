/** 书库封面墙。Owner: lane H。 */
import { Link } from '@tanstack/react-router';
import type { ReaderBookCard } from '@novelist/shared';
import { useApi } from '../../api/hooks';
import { Empty, Q } from '../../components/ui';
import { fmtCjk, fmtRel } from '../../lib/format';
import { Cover, ReaderHeader, SerialBadge } from './parts';

export function LibraryPage() {
  const q = useApi<ReaderBookCard[]>('/api/reader/books');
  return (
    <div className="min-h-dvh">
      <ReaderHeader />
      <main className="max-w-5xl mx-auto p-4">
        <Q q={q}>
          {(books) =>
            books.length === 0 ? (
              <Empty>书库还是空的，等第一本书发布吧。</Empty>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-x-4 gap-y-6">
                {books.map((b) => (
                  <Link key={b.slug} to="/books/$slug" params={{ slug: b.slug }} className="group block min-w-0">
                    <Cover book={b} className="transition group-hover:-translate-y-0.5 group-hover:shadow-lg" />
                    <h2 className="mt-2 text-sm font-medium truncate">{b.title}</h2>
                    <div className="flex items-center gap-1.5 mt-1">
                      <SerialBadge book={b} />
                      <span className="text-xs text-faint truncate">{fmtCjk(b.publishedCjk)}</span>
                    </div>
                    <p className="text-xs text-faint mt-1 truncate">
                      {b.progress ? `读到第 ${b.progress.ch} 章 · ` : ''}
                      {b.lastPublishedAt ? `${fmtRel(b.lastPublishedAt)}更新` : '尚未发布'}
                    </p>
                  </Link>
                ))}
              </div>
            )
          }
        </Q>
      </main>
    </div>
  );
}
