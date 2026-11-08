/** SSE（§9.7）：/api/admin/events、/api/admin/runs/:id/stream、/api/admin/login-sessions/:sid/stream。15s 心跳注释行。Owner: lane G。 */
import type { FastifyReply } from 'fastify';
import type { SseEvent } from '@novelist/shared';
import { isoDeep } from './iso.js';

const HEARTBEAT_MS = 15_000;
const open = new Set<() => void>();

/** 进程关闭时结束全部 SSE（否则 server.close 会等它们） */
export function closeAllSse(): void {
  for (const c of [...open]) c();
}

export function openSse(reply: FastifyReply): { send(e: SseEvent, id?: number): void; close(): void; onClose(cb: () => void): void } {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // Nginx Proxy Manager 不缓冲
  });
  res.write(': connected\n\n');
  let closed = false;
  const callbacks: (() => void)[] = [];
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    open.delete(close);
    for (const cb of callbacks) {
      try {
        cb();
      } catch {
        // 清理回调异常不影响其他回调
      }
    }
    if (!res.writableEnded) res.end();
  };
  open.add(close);
  res.on('close', close);
  return {
    send(e, id) {
      if (closed) return;
      res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${e.type}\ndata: ${JSON.stringify(isoDeep(e))}\n\n`);
    },
    close,
    onClose(cb) {
      if (closed) cb();
      else callbacks.push(cb);
    },
  };
}
