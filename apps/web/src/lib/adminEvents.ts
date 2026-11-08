/** 管理端全局 SSE 的进程内广播：布局持有唯一连接，页面只订阅。 */
import { useEffect, useRef } from 'react';
import type { SseEvent } from '@novelist/shared';

const subs = new Set<(e: SseEvent) => void>();

export function publishAdminEvent(e: SseEvent): void {
  for (const s of subs) s(e);
}

export function useAdminEvent(fn: (e: SseEvent) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const s = (e: SseEvent) => ref.current(e);
    subs.add(s);
    return () => {
      subs.delete(s);
    };
  }, []);
}
