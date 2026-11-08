/** 数据钩子：queryKey 第一项就是请求路径，失效按路径前缀做。 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page } from '@novelist/shared';
import { useCallback, useMemo } from 'react';
import { get } from './client';
import { toast } from '../components/toast';

export function useApi<T>(path: string | null, opts: { refetchMs?: number | ((data: T | undefined) => number | false); staleMs?: number } = {}) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => get<T>(path as string),
    enabled: path !== null,
    refetchInterval: typeof opts.refetchMs === 'function' ? (query) => (opts.refetchMs as (d: T | undefined) => number | false)(query.state.data) : opts.refetchMs,
    staleTime: opts.staleMs,
  });
}

export function usePaged<T>(path: string, limit = 50) {
  const sep = path.includes('?') ? '&' : '?';
  const q = useInfiniteQuery<Page<T>>({
    queryKey: [path, 'paged', limit],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => get<Page<T>>(`${path}${sep}limit=${limit}${pageParam ? `&cursor=${encodeURIComponent(pageParam as string)}` : ''}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  return { ...q, items };
}

export function useInvalidate() {
  const qc = useQueryClient();
  return useCallback(
    (...prefixes: string[]) =>
      qc.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return typeof key === 'string' && prefixes.some((p) => key.startsWith(p));
        },
      }),
    [qc],
  );
}

/** 写操作：错误走 toast，成功可提示并按路径前缀刷新。 */
export function useAction<A = void, R = unknown>(fn: (arg: A) => Promise<R>, opts: { ok?: string; invalidate?: string[]; onDone?: (r: R) => void; silentError?: boolean } = {}) {
  const invalidate = useInvalidate();
  return useMutation<R, Error, A>({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.ok) toast(opts.ok, 'ok');
      if (opts.invalidate?.length) void invalidate(...opts.invalidate);
      opts.onDone?.(r);
    },
    onError: (e) => {
      if (!opts.silentError) toast(e.message, 'danger');
    },
  });
}
