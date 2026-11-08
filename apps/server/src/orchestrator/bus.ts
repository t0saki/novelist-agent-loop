/**
 * 进程内事件总线 + 跨进程桥（pg LISTEN/NOTIFY 'novelist_events'；PGlite 下只有进程内）。Owner: lane F。
 * API 的 SSE（lane G）订阅这里；所有模块通过 publish 发 SseEvent。
 */
import { randomUUID } from 'node:crypto';
import type { SseEvent } from '@novelist/shared';

export interface EventBus {
  publish(e: SseEvent): void;
  subscribe(cb: (e: SseEvent) => void, filter?: (e: SseEvent) => boolean): () => void;
  close(): Promise<void>;
}

const CHANNEL = 'novelist_events';
/** NOTIFY 负载上限 8000 字节；高频/大体积事件只走进程内 */
const LOCAL_ONLY: ReadonlySet<SseEvent['type']> = new Set(['run_event', 'login_output']);
const MAX_NOTIFY_BYTES = 7500;

export function createEventBus(opts?: {
  pgNotify?: { listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>>; notify(channel: string, payload: string): Promise<void> };
}): EventBus {
  type Sub = { cb: (e: SseEvent) => void; filter?: ((e: SseEvent) => boolean) | undefined };
  const subs = new Set<Sub>();
  const origin = randomUUID();
  const pg = opts?.pgNotify;

  const dispatch = (e: SseEvent): void => {
    for (const s of [...subs]) {
      try {
        if (!s.filter || s.filter(e)) s.cb(e);
      } catch {
        // 订阅者异常不影响发布方
      }
    }
  };

  let closed = false;
  const unlisten: Promise<(() => Promise<void>) | null> = pg
    ? pg
        .listen(CHANNEL, (payload) => {
          try {
            const msg = JSON.parse(payload) as { o: string; e: SseEvent };
            if (msg.o !== origin) dispatch(msg.e);
          } catch {
            // 忽略格式错误的通知
          }
        })
        .catch(() => null)
    : Promise.resolve(null);

  return {
    publish(e) {
      if (closed) return;
      dispatch(e);
      if (!pg || LOCAL_ONLY.has(e.type)) return;
      const payload = JSON.stringify({ o: origin, e });
      if (Buffer.byteLength(payload) > MAX_NOTIFY_BYTES) return;
      void pg.notify(CHANNEL, payload).catch(() => {});
    },
    subscribe(cb, filter) {
      const sub: Sub = { cb, filter };
      subs.add(sub);
      return () => subs.delete(sub);
    },
    async close() {
      closed = true;
      subs.clear();
      const stop = await unlisten;
      if (stop) await stop().catch(() => {});
    },
  };
}
