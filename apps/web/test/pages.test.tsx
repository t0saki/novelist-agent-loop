// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge, Meter, Q, Tabs } from '../src/components/ui';
import { LoginPage, safeNext } from '../src/pages/reader/Login';
import { ChapterPublishNow } from '../src/pages/admin/book/ChapterDetail';

const wrap = (node: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>;

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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ frontiers: { accepted: 8, audited: 4, published: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    render(wrap(<ChapterPublishNow slug="demo" no={5} />));
    fireEvent.click(await screen.findByRole('button', { name: '立即发布' }));
    expect(screen.getByText(/当前已发布到第 2 章/)).toBeTruthy();
    expect(screen.getByText('将发布第 3–5 章，共 3 章。')).toBeTruthy();
  });

  it('hides the button for a chapter that is already out', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ frontiers: { accepted: 8, audited: 4, published: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<ChapterPublishNow slug="demo" no={5} />));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: '立即发布' })).toBeNull();
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

