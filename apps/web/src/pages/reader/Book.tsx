/** 书详情：简介、进度、分卷目录、导出。Owner: lane H。 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ReaderBookDetail } from '@novelist/shared';
import { enc } from '../../api/client';
import { useApi } from '../../api/hooks';
import { cx, Empty, Q } from '../../components/ui';
import { fmtCjk, fmtRel, fmtTime } from '../../lib/format';
import { Cover, ReaderHeader, SerialBadge } from './parts';

export function BookPage({ slug }: { slug: string }) {
  const q = useApi<ReaderBookDetail>(`/api/reader/books/${enc(slug)}`);
  return (
    <div className="min-h-dvh">
      <ReaderHeader back />
      <main className="max-w-3xl mx-auto p-4">
        <Q q={q}>{(b) => <BookBody book={b} />}</Q>
      </main>
    </div>
  );
}

function BookBody({ book }: { book: ReaderBookDetail }) {
  const chapters = book.volumes.flatMap((v) => v.chapters);
  const first = chapters[0]?.no ?? null;
  const current = book.progress?.ch ?? null;
  const currentVol = current === null ? null : (book.volumes.find((v) => v.chapters.some((c) => c.no === current))?.id ?? null);
  const [open, setOpen] = useState<Set<string>>(() => new Set([currentVol ?? book.volumes[0]?.id ?? '']));
  const pct = current !== null && chapters.length > 0 ? Math.round(((chapters.findIndex((c) => c.no === current) + 1) / chapters.length) * 100) : 0;
  const exportBase = `/api/reader/books/${enc(book.slug)}/export`;

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const startNo = current ?? first;
  return (
    <>
      <section className="flex gap-4">
        <Cover book={book} className="w-28 sm:w-36 shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-xl sm:text-2xl font-semibold">{book.title}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-sub">
            <SerialBadge book={book} />
            <span>{book.genre}</span>
            <span>{fmtCjk(book.publishedCjk)}</span>
            <span>{book.publishedChapters} 章</span>
            {book.lastPublishedAt && <span>{fmtRel(book.lastPublishedAt)}更新</span>}
          </div>
          {current !== null && (
            <div className="mt-3 max-w-xs">
              <div className="flex justify-between text-xs text-sub mb-1">
                <span>读到第 {current} 章</span>
                <span className="tabular-nums">{pct}%</span>
              </div>
              <div className="h-1 rounded-full bg-panel2 overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-4">
            {startNo !== null && (
              <Link to="/read/$slug/$no" params={{ slug: book.slug, no: String(startNo) }} className="bg-accent text-on-accent rounded-md text-sm px-4 py-1.5">
                {current !== null ? '继续阅读' : '开始阅读'}
              </Link>
            )}
            <a href={`${exportBase}.epub`} className="border border-line bg-panel rounded-md text-sm px-3 py-1.5 hover:bg-panel2">
              EPUB
            </a>
            <a href={`${exportBase}.txt`} className="border border-line bg-panel rounded-md text-sm px-3 py-1.5 hover:bg-panel2">
              TXT
            </a>
          </div>
        </div>
      </section>

      {book.blurb && <p className="mt-5 text-sm leading-7 whitespace-pre-line text-sub">{book.blurb}</p>}

      <section className="mt-6">
        <h2 className="text-sm font-semibold mb-2">目录</h2>
        {book.volumes.length === 0 && <Empty>还没有发布的章节。</Empty>}
        <div className="space-y-2">
          {book.volumes.map((v) => (
            <div key={v.id} className="bg-panel border border-line rounded-lg overflow-hidden">
              <button type="button" onClick={() => toggle(v.id)} aria-expanded={open.has(v.id)} className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-sm hover:bg-panel2">
                <span className="font-medium truncate text-left">{v.title}</span>
                <span className="text-xs text-faint shrink-0">
                  {v.chapters.length} 章 {open.has(v.id) ? '▾' : '▸'}
                </span>
              </button>
              {open.has(v.id) && (
                <>
                  <ul className="border-t border-line grid sm:grid-cols-2">
                    {v.chapters.map((c) => (
                      <li key={c.no}>
                        <Link to="/read/$slug/$no" params={{ slug: book.slug, no: String(c.no) }} title={`${c.cjk} 字 · ${fmtTime(c.publishedAt)}`} className={cx('block px-4 py-2 text-sm truncate hover:bg-panel2', c.no === current ? 'text-accent font-medium' : 'text-sub')}>
                          第 {c.no} 章 {c.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-line px-4 py-1.5 text-right">
                    <a href={`${exportBase}.epub?vol=${enc(v.id)}`} className="text-xs text-faint hover:text-ink">
                      导出本卷 EPUB
                    </a>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
