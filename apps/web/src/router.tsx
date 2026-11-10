/**
 * 路由（TanStack Router，代码式路由树）。Owner: lane H。
 * 读者端：/login、/（书库）、/books/$slug、/read/$slug/$no（沉浸式阅读）
 * 管理端：首页 /admin、开书 /admin/new、题材与指令 /admin/genres、模型与账号 /admin/models、系统 /admin/system，另有书页、章节页、运行日志；旧地址跳到新家（页面按需加载，读者不下载管理端和 CodeMirror）
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
/** 旧地址（书签）跳到新家 */
const moved = <P extends string>(path: P, to: string) =>
  createRoute({
    getParentRoute: () => admin,
    path,
    beforeLoad: () => {
      throw redirect({ to: to as never });
    },
  });

/** 旧控制台的地址（相对 /admin）→ 新家 */
export const MOVED_ROUTES: Record<string, string> = {
  '/books': '/admin',
  '/books/new': '/admin/new',
  '/inbox': '/admin',
  '/runs': '/admin',
  '/instructions': '/admin/genres',
  '/harness': '/admin/models',
  '/routing': '/admin/models',
  '/quota': '/admin/models',
  '/schedule': '/admin/system',
  '/readers': '/admin/system',
  '/settings': '/admin/system',
  '/import': '/admin/system',
};

const adminIndex = page('/', () => import('./pages/admin/Home'), 'HomePage');
const adminNew = page('/new', () => import('./pages/admin/NewBook'), 'NewBookPage');
const adminGenres = page('/genres', () => import('./pages/admin/Genres'), 'GenresPage');
const adminModels = page('/models', () => import('./pages/admin/Models'), 'ModelsPage');
const adminSystem = page('/system', () => import('./pages/admin/System'), 'SystemPage');
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
const adminRun = createRoute({
  getParentRoute: () => admin,
  path: '/runs/$id',
  component: function RunRoute() {
    const { id } = adminRun.useParams();
    return <LazyRunDetail id={id} />;
  },
});
const movedRoutes = Object.entries(MOVED_ROUTES).map(([from, to]) => moved(from, to));

export const routeTree = root.addChildren([
  login,
  library,
  book,
  reader,
  admin.addChildren([adminIndex, adminNew, adminGenres, adminModels, adminSystem, adminBook, adminBookTab, adminBookChapter, adminRun, ...movedRoutes]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true, defaultPendingComponent: () => <Loading /> });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
