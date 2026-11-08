import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { MeResponse, ReaderBookCard } from '@novelist/shared';
import { post } from '../../api/client';
import { useApi } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { Badge, Button, cx } from '../../components/ui';
import { coverGradient } from '../../lib/reader';
import { cycleTheme, THEME_LABEL, useThemeMode } from '../../lib/theme';

export function isSerialFinished(b: Pick<ReaderBookCard, 'status'>): boolean {
  return b.status === 'completed';
}

export function SerialBadge({ book }: { book: Pick<ReaderBookCard, 'status'> }) {
  return isSerialFinished(book) ? <Badge tone="accent">已完结</Badge> : <Badge tone="ok">连载中</Badge>;
}

export function Cover({ book, className }: { book: Pick<ReaderBookCard, 'title' | 'coverUrl' | 'slug'>; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cx('relative aspect-[3/4] rounded-md overflow-hidden shadow-md', className)} style={{ background: coverGradient(book.slug) }}>
      {book.coverUrl && !failed ? (
        <img src={book.coverUrl} alt={book.title} loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-3 text-center font-serif font-semibold text-white/90 leading-snug text-base sm:text-lg">{book.title}</div>
      )}
    </div>
  );
}

export function ReaderHeader({ back }: { back?: boolean }) {
  const me = useApi<MeResponse>('/api/auth/me', { staleMs: 60_000 });
  const mode = useThemeMode();
  async function logout() {
    await post('/api/auth/logout');
    queryClient.clear();
    window.location.assign('/login');
  }
  return (
    <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur border-b border-line">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {back && (
            <Link to="/" className="text-sm text-sub hover:text-ink">
              ← 书库
            </Link>
          )}
          {!back && <span className="font-serif font-semibold text-lg">Novelist 阅读室</span>}
        </div>
        <div className="flex items-center gap-1">
          {me.data?.role === 'admin' && (
            <Link to="/admin" className="text-xs text-sub hover:text-ink px-2">
              管理
            </Link>
          )}
          <Button variant="ghost" size="sm" onClick={cycleTheme}>
            {THEME_LABEL[mode]}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            退出
          </Button>
        </div>
      </div>
    </header>
  );
}
