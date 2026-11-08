/** 管理端布局：分组侧栏（手机为抽屉）、全局 SSE、Inbox 计数、明暗切换。Owner: lane H。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import type { InboxItem, MeResponse, Page as ApiPage, SseEvent } from '@novelist/shared';
import { openEventStream, post, type StreamStatus } from '../api/client';
import { useApi, useInvalidate } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { cycleTheme, THEME_LABEL, useThemeMode } from '../lib/theme';
import { publishAdminEvent } from '../lib/adminEvents';
import { invalidationsFor } from '../lib/invalidation';
import { Button, cx, Notice } from './ui';

const NAV: { group: string; items: { to: string; label: string; badge?: 'inbox' }[] }[] = [
  {
    group: '工作台',
    items: [
      { to: '/admin', label: '仪表盘' },
      { to: '/admin/inbox', label: 'Inbox', badge: 'inbox' },
      { to: '/admin/runs', label: '运行' },
    ],
  },
  {
    group: '创作',
    items: [
      { to: '/admin/books', label: '书' },
      { to: '/admin/instructions', label: '全局指令' },
      { to: '/admin/genres', label: '题材包' },
    ],
  },
  {
    group: '接入',
    items: [
      { to: '/admin/harness', label: 'Harness 与账号' },
      { to: '/admin/routing', label: '路由与 Profile' },
      { to: '/admin/quota', label: '配额与用量' },
    ],
  },
  {
    group: '运营',
    items: [
      { to: '/admin/schedule', label: '发布排期' },
      { to: '/admin/readers', label: '读者' },
      { to: '/admin/settings', label: '系统与 Doctor' },
      { to: '/admin/import', label: 'v1 导入' },
    ],
  },
];

function useAdminStream(): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const invalidate = useInvalidate();
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // SSE 事件可能很密（run_event），刷新合并到 800ms 一批
    const onEvent = (e: SseEvent) => {
      publishAdminEvent(e);
      for (const p of invalidationsFor(e)) pending.current.add(p);
      if (pending.current.size > 0 && timer.current === null) {
        timer.current = setTimeout(() => {
          timer.current = null;
          const prefixes = [...pending.current];
          pending.current.clear();
          void invalidate(...prefixes);
        }, 800);
      }
    };
    const close = openEventStream('/api/admin/events', onEvent, setStatus);
    return () => {
      close();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [invalidate]);
  return status;
}

function NavBody({ inboxCount, onNavigate }: { inboxCount: number; onNavigate?: () => void }) {
  return (
    <nav className="space-y-4 text-sm">
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="text-xs text-faint px-2 mb-1">{g.group}</div>
          <div className="space-y-0.5">
            {g.items.map((n) => (
              <Link key={n.to} to={n.to} onClick={onNavigate} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sub hover:bg-panel2 hover:text-ink" activeOptions={{ exact: n.to === '/admin' }} activeProps={{ className: 'bg-panel2 !text-ink font-medium' }}>
                {n.label}
                {n.badge === 'inbox' && inboxCount > 0 && <span className="bg-accent text-on-accent rounded-full text-xs px-1.5 min-w-5 text-center">{inboxCount}</span>}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function ThemeButton(): ReactNode {
  const mode = useThemeMode();
  return (
    <Button variant="ghost" size="sm" onClick={cycleTheme} title="切换明暗">
      {THEME_LABEL[mode]}
    </Button>
  );
}

export function AdminLayout() {
  const stream = useAdminStream();
  const [drawer, setDrawer] = useState(false);
  const inbox = useApi<ApiPage<InboxItem>>('/api/admin/inbox?state=open&limit=100');
  const me = useApi<MeResponse>('/api/auth/me', { staleMs: 60_000 });
  const inboxCount = inbox.data?.items.length ?? 0;
  const path = useRouterState({ select: (s) => s.location.pathname });
  // biome-ignore lint/correctness/useExhaustiveDependencies: 路由变化时收起抽屉
  useEffect(() => setDrawer(false), [path]);

  async function logout() {
    await post('/api/auth/logout');
    queryClient.clear();
    window.location.assign('/login');
  }

  const footer = (
    <div className="flex flex-wrap items-center gap-1 pt-3 mt-3 border-t border-line">
      <Link to="/" className="text-xs text-sub hover:text-ink px-2 py-1">
        阅读室
      </Link>
      <ThemeButton />
      <Button variant="ghost" size="sm" onClick={() => void logout()}>
        退出
      </Button>
    </div>
  );

  return (
    <div className="min-h-full md:flex">
      <aside className="hidden md:flex flex-col w-52 shrink-0 border-r border-line p-3 sticky top-0 h-dvh overflow-y-auto">
        <div className="font-semibold px-2 mb-4 font-serif text-lg">Novelist</div>
        <div className="flex-1">
          <NavBody inboxCount={inboxCount} />
        </div>
        {footer}
      </aside>

      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between bg-bg/95 backdrop-blur border-b border-line px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => setDrawer(true)} aria-label="打开导航">
          ☰ 菜单
        </Button>
        <span className="font-serif font-semibold">Novelist</span>
        <Link to="/admin/inbox" className="text-sm text-sub px-2">
          Inbox{inboxCount > 0 && <span className="ml-1 bg-accent text-on-accent rounded-full text-xs px-1.5">{inboxCount}</span>}
        </Link>
      </header>

      {drawer && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setDrawer(false)}>
          <div className="absolute inset-y-0 left-0 w-64 bg-panel p-3 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <NavBody inboxCount={inboxCount} onNavigate={() => setDrawer(false)} />
            {footer}
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0">
        {me.data?.insecureCookies && (
          <div className="p-3 pb-0">
            <Notice tone="danger">当前为局域网 HTTP 模式（Cookie 未设 Secure）。请勿在公网暴露，公网访问须走 HTTPS 反代。</Notice>
          </div>
        )}
        {stream === 'error' && (
          <div className={cx('px-3 pt-3')}>
            <Notice tone="warn">实时事件流已断开，正在重连；页面数据可能滞后。</Notice>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
