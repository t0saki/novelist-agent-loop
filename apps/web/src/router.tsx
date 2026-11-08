/**
 * 路由（TanStack Router，代码式路由树）。Owner: lane H。
 * 读者端：/login、/（书库）、/books/$slug、/read/$slug/$no（沉浸式阅读）
 * 管理端：/admin/**（页面按需加载，读者不下载管理端和 CodeMirror）
 */
import type React from 'react';
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Link, Outlet, redirect } from '@tanstack/react-router';
import type { MeResponse } from '@novelist/shared';
import { get } from './api/client';
import { queryClient } from './api/queryClient';
import { AdminLayout } from './components/AdminLayout';
import { ErrorBox, Loading } from './components/ui';
import { LoginPage } from './pages/reader/Login';
import { LibraryPage } from './pages/reader/Library';
import { BookPage } from './pages/reader/Book';
import { ReaderPage } from './pages/reader/Reader';

const fetchMe = () => queryClient.fetchQuery({ queryKey: ['/api/auth/me'], queryFn: () => get<MeResponse>('/api/auth/me'), staleTime: 30_000 });

async function requireReader({ location }: { location: { href: string } }) {
  const me = await fetchMe();
  if (!me.role) throw redirect({ to: '/login', search: { next: location.href } });
}
async function requireAdmin({ location }: { location: { href: string } }) {
  const me = await fetchMe();
  if (!me.role) throw redirect({ to: '/login', search: { next: location.href } });
  if (me.role !== 'admin') throw redirect({ to: '/' });
}

const root = createRootRoute({
  component: () => <Outlet />,
  errorComponent: ({ error, reset }) => (
    <div className="p-6">
      <ErrorBox error={error} retry={reset} />
    </div>
  ),
  notFoundComponent: () => (
    <div className="p-10 text-center text-sub text-sm space-y-2">
      <p>页面不存在。</p>
      <Link to="/" className="text-accent">
        回到书库
      </Link>
    </div>
  ),
  pendingComponent: () => <Loading />,
});

const login = createRoute({ getParentRoute: () => root, path: '/login', component: LoginPage, validateSearch: (s: Record<string, unknown>): { next?: string } => (typeof s.next === 'string' ? { next: s.next } : {}) });
const library = createRoute({ getParentRoute: () => root, path: '/', beforeLoad: requireReader, component: LibraryPage });
const book = createRoute({
  getParentRoute: () => root,
  path: '/books/$slug',
  beforeLoad: requireReader,
  component: function BookRoute() {
    const { slug } = book.useParams();
    return <BookPage slug={slug} />;
  },
});
const reader = createRoute({
  getParentRoute: () => root,
  path: '/read/$slug/$no',
  beforeLoad: requireReader,
  component: function ReaderRoute() {
    const { slug, no } = reader.useParams();
    return <ReaderPage slug={slug} no={Number(no)} />;
  },
});

const admin = createRoute({ getParentRoute: () => root, path: '/admin', beforeLoad: requireAdmin, component: AdminLayout });
const page = <P extends string>(path: P, load: () => Promise<Record<string, unknown>>, name: string) => createRoute({ getParentRoute: () => admin, path, component: lazyRouteComponent(load as never, name as never) as never });

const adminIndex = page('/', () => import('./pages/admin/Dashboard'), 'DashboardPage');
const adminBooks = page('/books', () => import('./pages/admin/Books'), 'BooksPage');
const adminNewBook = page('/books/new', () => import('./pages/admin/NewBook'), 'NewBookPage');
const LazyBookDetail = lazyRouteComponent(() => import('./pages/admin/book/BookDetail') as never, 'BookDetailPage') as unknown as (p: { slug: string; tab: string }) => React.ReactNode;
const LazyChapterDetail = lazyRouteComponent(() => import('./pages/admin/book/ChapterDetail') as never, 'ChapterDetailPage') as unknown as (p: { slug: string; no: number }) => React.ReactNode;
const LazyRunDetail = lazyRouteComponent(() => import('./pages/admin/RunDetail') as never, 'RunDetailPage') as unknown as (p: { id: string }) => React.ReactNode;

const adminBook = createRoute({
  getParentRoute: () => admin,
  path: '/books/$slug',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/admin/books/$slug/$tab', params: { slug: params.slug, tab: 'overview' } });
  },
});
const adminBookTab = createRoute({
  getParentRoute: () => admin,
  path: '/books/$slug/$tab',
  component: function BookTabRoute() {
    const { slug, tab } = adminBookTab.useParams();
    return <LazyBookDetail slug={slug} tab={tab} />;
  },
});
const adminBookChapter = createRoute({
  getParentRoute: () => admin,
  path: '/books/$slug/chapters/$no',
  component: function ChapterRoute() {
    const { slug, no } = adminBookChapter.useParams();
    return <LazyChapterDetail slug={slug} no={Number(no)} />;
  },
});
const adminRuns = page('/runs', () => import('./pages/admin/Runs'), 'RunsPage');
const adminRun = createRoute({
  getParentRoute: () => admin,
  path: '/runs/$id',
  component: function RunRoute() {
    const { id } = adminRun.useParams();
    return <LazyRunDetail id={id} />;
  },
});
const adminInbox = page('/inbox', () => import('./pages/admin/Inbox'), 'InboxPage');
const adminInstructions = page('/instructions', () => import('./pages/admin/Instructions'), 'InstructionsPage');
const adminGenres = page('/genres', () => import('./pages/admin/Genres'), 'GenresPage');
const adminHarness = page('/harness', () => import('./pages/admin/Harness'), 'HarnessPage');
const adminRouting = page('/routing', () => import('./pages/admin/Routing'), 'RoutingPage');
const adminSchedule = page('/schedule', () => import('./pages/admin/Schedule'), 'SchedulePage');
const adminQuota = page('/quota', () => import('./pages/admin/Quota'), 'QuotaPage');
const adminReaders = page('/readers', () => import('./pages/admin/Readers'), 'ReadersPage');
const adminSettings = page('/settings', () => import('./pages/admin/Settings'), 'SettingsPage');
const adminImport = page('/import', () => import('./pages/admin/Import'), 'ImportPage');

export const routeTree = root.addChildren([
  login,
  library,
  book,
  reader,
  admin.addChildren([
    adminIndex,
    adminBooks,
    adminNewBook,
    adminBook,
    adminBookTab,
    adminBookChapter,
    adminRuns,
    adminRun,
    adminInbox,
    adminInstructions,
    adminGenres,
    adminHarness,
    adminRouting,
    adminSchedule,
    adminQuota,
    adminReaders,
    adminSettings,
    adminImport,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true, defaultPendingComponent: () => <Loading /> });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
