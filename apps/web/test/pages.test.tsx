// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zSystemSettings, type BookOverview, type BookSummary, type ChapterRow, type GenreSummary, type RoutingSlotsView, type SystemSettingsView } from '@novelist/shared';
import { Badge, Meter, Q, Tabs } from '../src/components/ui';
import { LoginPage, safeNext } from '../src/pages/reader/Login';
import { ChapterDetailPage, ChapterPublishNow } from '../src/pages/admin/book/ChapterDetail';
import { LegacyBookPage } from '../src/pages/admin/book/LegacyBook';
import { HomePage } from '../src/pages/admin/Home';
import { NewBookPage } from '../src/pages/admin/NewBook';
import { ModelsPage } from '../src/pages/admin/Models';
import { GenresPage } from '../src/pages/admin/Genres';
import { SystemPage } from '../src/pages/admin/System';
import { AdminLayout, NAV } from '../src/components/AdminLayout';

const wrap = (node: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>;

/** 页面里有 Link / useNavigate：放进一个只有根路由的内存路由器里渲染 */
function renderPage(node: ReactNode) {
  const router = createRouter({ routeTree: createRootRoute({ component: () => <>{node}</> }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return render(wrap(<RouterProvider router={router as never} />));
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** fetch 替身：记下每次请求，按 handler 返回 JSON（handler 返回 undefined → {}） */
function mockApi(handler: (method: string, url: string, body: unknown) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const data = handler(method, url, body);
      return data instanceof Response ? data : json(data ?? {});
    }),
  );
  return calls;
}
const sent = (calls: Call[], method: string, url: string) => calls.filter((c) => c.method === method && c.url === url);
const card = (title: string | RegExp) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;

const SETTINGS: SystemSettingsView = { ...zSystemSettings.parse({}), updatedAt: '2026-11-11T00:00:00.000Z' };
const GENRE: GenreSummary = {
  id: 'xianxia',
  name: '仙侠',
  description: '',
  extends: [],
  builtin: true,
  hidden: false,
  books: 2,
  files: [],
  auto: { enabled: true, weight: 2, keywords: 1, lengthHint: '长篇', keywordList: ['飞剑'], adultOnly: false, minChapters: null },
  override: { listed: null, weight: null },
};
const V3_BOOK: BookSummary = {
  slug: 'feng',
  title: '风起',
  genre: 'xianxia',
  status: 'active',
  totalCjk: 30_000,
  frontiers: { accepted: 8, published: 5, buffer: 3, bufferDays: 5 },
  activeTasks: 1,
  waiting: null,
  inboxOpen: 0,
  updatedAt: '2026-11-11T00:00:00.000Z',
  flow: 'v3',
  legacy: false,
  v3: { length: 'medium', targetCjk: 60_000, plannedChapters: 15, status: { kind: 'writing', sentence: '正在写第 9–13 章，已 9 分钟', since: null, until: null, notes: [] }, cost: { runs: 2, hours: 1.5, outputTokens: 1000, tokensPer1kChars: null } },
};
const OLD_BOOK: BookSummary = { ...V3_BOOK, slug: 'old', title: '旧书一本', status: 'archived', flow: 'v2', legacy: true, v3: null, frontiers: { accepted: 12, published: 10, buffer: 2, bufferDays: null } };
const overview = (b: BookSummary, extra: Partial<BookOverview> = {}): BookOverview => ({ ...b, config: null, writerOverride: null, recentCommits: [], dirMissing: false, ...extra });
const chapter = (no: number, volume: string, volumeTitle: string): ChapterRow => ({ no, id: `c${String(no).padStart(5, '0')}`, title: `章${no}`, volume, volumeTitle, state: 'accepted', cjk: 3000, acceptedAt: '2026-01-01T00:00:00Z', publishedAt: no <= 10 ? '2026-01-02T00:00:00Z' : null });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('login', () => {
  it('rejects open-redirect targets', () => {
    expect(safeNext('/admin/inbox')).toBe('/admin/inbox');
    expect(safeNext('//evil.example')).toBeNull();
    expect(safeNext('https://evil.example')).toBeNull();
    expect(safeNext('/login')).toBeNull();
    expect(safeNext(null)).toBeNull();
  });

  it('shows a clear message for a wrong password', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401 }), { status: 401, headers: { 'content-type': 'application/problem+json' } })));
    render(wrap(<LoginPage />));
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: '进入' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('密码不正确'));
  });
});

describe('chapter publish now', () => {
  it('uses the real published frontier and states the whole range that will go out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ frontiers: { accepted: 8, published: 2 } })));
    render(wrap(<ChapterPublishNow slug="demo" no={5} />));
    fireEvent.click(await screen.findByRole('button', { name: '立即发布' }));
    expect(screen.getByText(/当前已发布到第 2 章/)).toBeTruthy();
    expect(screen.getByText('将发布第 3–5 章，共 3 章。')).toBeTruthy();
  });

  it('hides the button for a chapter that is already out', async () => {
    const fetchMock = vi.fn(async () => json({ frontiers: { accepted: 8, published: 7 } }));
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<ChapterPublishNow slug="demo" no={5} />));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: '立即发布' })).toBeNull();
  });
});

describe('home', () => {
  it('shows the to-do items and one row per book; the filter chips switch the query', async () => {
    const calls = mockApi((_m, url) => {
      if (url.startsWith('/api/admin/inbox')) return { items: [{ id: 'i1', bookSlug: null, kind: 'auth', title: '账号登录失效', body: {}, state: 'open', actions: [{ id: 'dismiss', label: '知道了' }], createdAt: '2026-11-11T00:00:00Z', resolvedAt: null, timeoutAt: null }], nextCursor: null };
      if (url === '/api/admin/books?filter=active') return [V3_BOOK];
      if (url === '/api/admin/books?filter=legacy') return [OLD_BOOK];
      if (url.startsWith('/api/admin/runs')) return { items: [], nextCursor: null };
      if (url === '/api/admin/quota') return [];
      return undefined;
    });
    renderPage(<HomePage />);
    expect(await screen.findByText('账号登录失效')).toBeTruthy();
    expect(await screen.findByText('风起')).toBeTruthy();
    expect(screen.getByText('正在写第 9–13 章，已 9 分钟')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '旧书' }));
    expect(await screen.findByText('旧书一本')).toBeTruthy();
    expect(screen.getByText('旧书 · 只读')).toBeTruthy();
    expect(sent(calls, 'GET', '/api/admin/books?filter=legacy')).toHaveLength(1);
  });

  it('says so when there is nothing to do', async () => {
    mockApi((_m, url) => (url.startsWith('/api/admin/inbox') || url.startsWith('/api/admin/runs') ? { items: [], nextCursor: null } : []));
    renderPage(<HomePage />);
    expect(await screen.findByText('没有待办')).toBeTruthy();
  });
});

describe('new book', () => {
  const api = (calls?: (c: Call) => void) =>
    mockApi((method, url, body) => {
      calls?.({ method, url, body });
      if (url === '/api/admin/genres') return [GENRE];
      if (url === '/api/admin/settings') return SETTINGS;
      if (method === 'POST' && url === '/api/admin/books') return V3_BOOK;
      return undefined;
    });

  it('submits genre / length / idea only; the advanced fields stay out unless filled', async () => {
    const calls = api();
    renderPage(<NewBookPage />);
    const idea = await screen.findByRole('textbox', { name: '一句话想法' });
    fireEvent.change(idea, { target: { value: '一个关于雨的故事' } });
    fireEvent.click(screen.getByRole('button', { name: '开书' }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/admin/books')).toHaveLength(1));
    expect(sent(calls, 'POST', '/api/admin/books')[0]?.body).toEqual({ genre: 'random', length: 'random', idea: '一个关于雨的故事' });
  });

  it('the automatic-start panel saves without `enabled`; the toggle sends only `enabled`, both with baseUpdatedAt', async () => {
    const calls = api();
    renderPage(<NewBookPage />);
    const panel = await waitFor(() => card('自动开书'));
    fireEvent.change(within(panel).getByRole('spinbutton', { name: /24 小时内最多开几本/ }), { target: { value: '5' } });
    fireEvent.click(within(panel).getByRole('button', { name: '保存自动开书设置' }));
    await waitFor(() => expect(sent(calls, 'PUT', '/api/admin/settings')).toHaveLength(1));
    const save = sent(calls, 'PUT', '/api/admin/settings')[0]?.body as { baseUpdatedAt: string; autoStart: Record<string, unknown> };
    expect(Object.keys(save).sort()).toEqual(['autoStart', 'baseUpdatedAt']);
    expect(save.baseUpdatedAt).toBe(SETTINGS.updatedAt);
    expect(Object.keys(save.autoStart).sort()).toEqual(['lengthMix', 'lengths', 'maxPerDay', 'maxUnfinishedBooks']);
    expect(save.autoStart.maxPerDay).toBe(5);
    expect(save.autoStart.lengths).toEqual({ short: { targetCjk: 15_000 }, medium: { targetCjk: 60_000 }, long: { targetCjk: 200_000 }, epic: { targetCjk: 500_000 } });

    fireEvent.click(within(panel).getByRole('checkbox', { name: /有空位时自动开新书/ }));
    await waitFor(() => expect(sent(calls, 'PUT', '/api/admin/settings')).toHaveLength(2));
    const toggle = sent(calls, 'PUT', '/api/admin/settings')[1]?.body as { baseUpdatedAt: string; autoStart: Record<string, unknown> };
    expect(Object.keys(toggle).sort()).toEqual(['autoStart', 'baseUpdatedAt']);
    expect(Object.keys(toggle.autoStart)).toEqual(['enabled']);
  });

  it('pack participation goes through PATCH /genres/:id/auto', async () => {
    const calls = api();
    renderPage(<NewBookPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: '仙侠 参与自动开书' }));
    await waitFor(() => expect(sent(calls, 'PATCH', '/api/admin/genres/xianxia/auto')).toHaveLength(1));
    expect(sent(calls, 'PATCH', '/api/admin/genres/xianxia/auto')[0]?.body).toEqual({ enabled: false });
  });
});

describe('legacy book page', () => {
  const rows = [chapter(1, 'v01', '第一卷 风起'), chapter(2, 'v01', '第一卷 风起'), chapter(3, 'v02', ''), chapter(4, '', '')];
  it('groups chapters by volume (title, else the volume id) and the takeover modal posts /takeover', async () => {
    const calls = mockApi((method, url) => {
      if (url.startsWith('/api/admin/books/old/chapters')) return { items: rows, nextCursor: null };
      if (method === 'GET' && url === '/api/admin/books/old/takeover') return { length: 'long', target_cjk: 200_000, batch: 5, min_chapter_cjk: 3000, accepted: 12, totalCjk: 36_000, agentsBytes: 4000, agentsOver: false };
      if (method === 'POST' && url === '/api/admin/books/old/takeover') return OLD_BOOK;
      return undefined;
    });
    renderPage(<LegacyBookPage book={overview(OLD_BOOK)} />);
    expect(await screen.findByRole('heading', { name: '第一卷 风起' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'v02' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '未分卷' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '导出 TXT' }).getAttribute('href')).toBe('/api/reader/books/old/export.txt?scope=accepted');
    fireEvent.click(screen.getByRole('button', { name: '接手续写' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: '接手' }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/admin/books/old/takeover')).toHaveLength(1));
    expect(sent(calls, 'POST', '/api/admin/books/old/takeover')[0]?.body).toEqual({ length: 'long', target_cjk: 200_000, batch: 5, min_chapter_cjk: 3000, start: true });
  });

  it('a book whose directory is gone offers only delete', async () => {
    mockApi(() => undefined);
    renderPage(<LegacyBookPage book={overview(OLD_BOOK, { dirMissing: true })} />);
    expect(await screen.findByText(/书目录不存在/)).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['删除']);
    expect(screen.queryByRole('link', { name: '导出 TXT' })).toBeNull();
  });
});

describe('chapter page', () => {
  it('a legacy chapter can be read and edited, nothing else', async () => {
    mockApi((_m, url) => {
      if (url === '/api/admin/books/old/chapters/3') return { ...chapter(3, 'v01', '第一卷'), text: '旧书第三章的正文', runs: [], commit: null, locked: false, legacy: true };
      if (url === '/api/admin/books/old') return overview(OLD_BOOK);
      return undefined;
    });
    renderPage(<ChapterDetailPage slug="old" no={3} />);
    expect(await screen.findByText('旧书第三章的正文')).toBeTruthy();
    await screen.findByText(/旧书只能读和直接改正文/);
    expect(screen.getByRole('button', { name: '直接改' })).toBeTruthy();
    for (const name of ['带意见重写', '从这里起重写', '立即发布']) expect(screen.queryByRole('button', { name })).toBeNull();
  });
});

describe('models page', () => {
  const VIEW: RoutingSlotsView = {
    slots: { schema: 'nv.slots/1', writer: { primary: 'agy-argon', fallback: null }, utility: { primary: 'agy-flash-check', fallback: null }, droppedProfiles: [] },
    forced: false,
    status: {
      writer: { slot: 'writer', profile: 'agy-argon', account: 'a1', harness: 'agy', model: 'm', usedFallback: false, waitUntil: null, reason: null },
      utility: { slot: 'utility', profile: 'agy-flash-check', account: 'a1', harness: 'agy', model: 'm', usedFallback: false, waitUntil: null, reason: null },
    },
    profiles: ['agy-argon', 'agy-flash-check', 'cc-opus'].map((id) => ({ id, label: id, harness: 'agy', model: 'm', accounts: [], driver: 'spawn', enabled: true, requires_ack: [], limits: {}, extra_args: [], tags: [] })) as RoutingSlotsView['profiles'],
  };
  it('saves the slots with PUT /routing/slots and the effort table as { v3: { effortDefaults } } only', async () => {
    const calls = mockApi((_m, url) => (url === '/api/admin/routing/slots' ? VIEW : url === '/api/admin/settings' ? SETTINGS : undefined));
    renderPage(<ModelsPage />);
    fireEvent.change(await screen.findByRole('combobox', { name: '写作用的模型 备用' }), { target: { value: 'cc-opus' } });
    fireEvent.click(screen.getByRole('button', { name: '保存位置' }));
    await waitFor(() => expect(sent(calls, 'PUT', '/api/admin/routing/slots')).toHaveLength(1));
    expect(sent(calls, 'PUT', '/api/admin/routing/slots')[0]?.body).toEqual({ writer: { primary: 'agy-argon', fallback: 'cc-opus' }, utility: { primary: 'agy-flash-check', fallback: null } });

    fireEvent.change(await screen.findByRole('combobox', { name: '复盘 effort' }), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 effort' }));
    await waitFor(() => expect(sent(calls, 'PUT', '/api/admin/settings')).toHaveLength(1));
    const body = sent(calls, 'PUT', '/api/admin/settings')[0]?.body as { v3: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(['baseUpdatedAt', 'v3']);
    expect(body.v3).toEqual({ effortDefaults: { ...SETTINGS.v3.effortDefaults, retro: 'high' } });
  });

  it('warns about fake mode and dropped profiles', async () => {
    mockApi((_m, url) => (url === '/api/admin/routing/slots' ? { ...VIEW, forced: true, slots: { ...VIEW.slots, migratedFrom: 'mixed', droppedProfiles: ['cx-sol'] } } : url === '/api/admin/settings' ? SETTINGS : undefined));
    renderPage(<ModelsPage />);
    expect(await screen.findByText(/现在是 fake 模式/)).toBeTruthy();
    expect(screen.getByText(/cx-sol/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存位置' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('genres page', () => {
  it('saves the pack form through PATCH /genres/:id/auto', async () => {
    const calls = mockApi((_m, url) => {
      if (url === '/api/admin/genres') return [GENRE];
      if (url === '/api/admin/settings') return SETTINGS;
      if (url.startsWith('/api/admin/instructions/files')) return [];
      if (url === '/api/admin/instructions/preview') return { text: '', bytes: 0, limit: 16384, over: false, layers: [] };
      return undefined;
    });
    renderPage(<GenresPage />);
    const form = await waitFor(() => card('自动开书'));
    fireEvent.change(within(form).getByRole('spinbutton', { name: /权重/ }), { target: { value: '3' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(sent(calls, 'PATCH', '/api/admin/genres/xianxia/auto')).toHaveLength(1));
    expect(sent(calls, 'PATCH', '/api/admin/genres/xianxia/auto')[0]?.body).toEqual({ enabled: true, weight: 3, keywords: ['飞剑'], length_hint: '长篇' });
  });
});

describe('system page', () => {
  it('each card sends only its own section, with baseUpdatedAt', async () => {
    const calls = mockApi((_m, url) => (url === '/api/admin/settings' ? SETTINGS : undefined));
    renderPage(<SystemPage />);
    const cases: [string, (c: HTMLElement) => void, Record<string, unknown>][] = [
      ['默认发布节奏与存稿上限', () => {}, { v3: { publishDefaults: SETTINGS.v3.publishDefaults } }],
      ['失控兜底', (c) => fireEvent.change(within(c).getByRole('spinbutton'), { target: { value: '3' } }), { v3: { runawayFactor: 3 } }],
      ['并发与调度', (c) => fireEvent.change(within(c).getByRole('spinbutton'), { target: { value: '2' } }), { maxConcurrentRuns: 2 }],
      ['隔离', () => {}, { isolation: 'auto' }],
      ['通知', () => {}, { notifications: { ntfyUrl: '', webhookUrl: '' } }],
    ];
    await waitFor(() => card('失控兜底'));
    for (const [i, [title, change, section]] of cases.entries()) {
      const c = card(title);
      change(c);
      fireEvent.click(within(c).getByRole('button', { name: '保存' }));
      await waitFor(() => expect(sent(calls, 'PUT', '/api/admin/settings')).toHaveLength(i + 1));
      expect(sent(calls, 'PUT', '/api/admin/settings')[i]?.body, title).toEqual({ baseUpdatedAt: SETTINGS.updatedAt, ...section });
    }
  });
});

describe('admin layout', () => {
  it('the navigation has exactly five entries', async () => {
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener() {}
        close() {}
      },
    );
    mockApi((_m, url) => (url.startsWith('/api/admin/inbox') ? { items: [], nextCursor: null } : { role: 'admin', insecureCookies: false }));
    renderPage(<AdminLayout />);
    const nav = await screen.findByRole('navigation', { name: '管理端导航' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['首页', '开书', '题材与指令', '模型与账号', '系统']);
    expect(NAV).toHaveLength(5);
  });

  it('old console addresses redirect to their new home', async () => {
    mockApi((_m, url) => (url === '/api/auth/me' ? { role: 'admin', insecureCookies: false } : undefined));
    const { routeTree } = await import('../src/router');
    for (const [from, to] of [
      ['/admin/inbox', '/admin'],
      ['/admin/routing', '/admin/models'],
      ['/admin/settings', '/admin/system'],
      ['/admin/books/new', '/admin/new'],
      ['/admin/instructions', '/admin/genres'],
    ] as const) {
      const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [from] }) });
      await router.load();
      expect(router.state.location.pathname, from).toBe(to);
    }
  });
});

describe('ui kit', () => {
  it('Q renders data, error and loading states', () => {
    const base = { refetch: vi.fn() } as never as { refetch: () => Promise<never> };
    const { rerender } = render(<Q q={{ ...base, data: undefined, error: null, isLoading: true }}>{(d: string) => d}</Q>);
    expect(screen.getByText('加载中…')).toBeTruthy();
    rerender(<Q q={{ ...base, data: undefined, error: new Error('挂了') as never, isLoading: false }}>{(d: string) => d}</Q>);
    expect(screen.getByText(/挂了/)).toBeTruthy();
    rerender(<Q q={{ ...base, data: '内容', error: null, isLoading: false }}>{(d: string) => d}</Q>);
    expect(screen.getByText('内容')).toBeTruthy();
  });

  it('Meter shows the percent as text and handles unknown', () => {
    const { rerender } = render(<Meter label="5h" ratio={0.42} />);
    expect(screen.getByText('42%')).toBeTruthy();
    rerender(<Meter label="5h" ratio={null} />);
    expect(screen.getByText('未知')).toBeTruthy();
  });

  it('Tabs reports the selected tab', () => {
    const onChange = vi.fn();
    render(<Tabs value="a" onChange={onChange} tabs={[{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }]} />);
    fireEvent.click(screen.getByRole('tab', { name: '乙' }));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.getByRole('tab', { name: '甲' }).getAttribute('aria-selected')).toBe('true');
  });

  it('Badge renders its label', () => {
    render(<Badge tone="ok">已完结</Badge>);
    expect(screen.getByText('已完结')).toBeTruthy();
  });
});
