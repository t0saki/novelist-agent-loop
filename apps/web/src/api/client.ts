/**
 * API 客户端（契约：@novelist/shared 的 DTO 与 ROUTES）。Owner: lane H。
 * - 错误统一抛 ApiError（problem+json）；401 → 跳登录页（auth 接口自身除外）。
 * - SSE：服务端发的是具名事件（event: <type>），必须逐类型监听，onmessage 收不到。
 */
import type { ApiProblem, ImpactEstimate, SseEvent, SseEventType } from '@novelist/shared';

export class ApiError extends Error {
  readonly status: number;
  /** 409 且响应体是 ImpactEstimate 时给出（needsConfirm 二次确认流程） */
  readonly impact: ImpactEstimate | null;
  constructor(public readonly problem: ApiProblem, raw?: unknown) {
    super(problem.detail || problem.title || `HTTP ${problem.status}`);
    this.status = problem.status;
    this.impact = isImpact(raw) ? raw : null;
  }
}

export function isImpact(v: unknown): v is ImpactEstimate {
  return typeof v === 'object' && v !== null && 'needsConfirm' in v;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function redirectToLogin(): void {
  const { pathname, search } = window.location;
  if (pathname === '/login') return;
  window.location.assign(`/login?next=${encodeURIComponent(pathname + search)}`);
}

async function parse<T>(res: Response, path: string): Promise<T> {
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) redirectToLogin();
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      raw = undefined;
    }
    const problem: ApiProblem =
      typeof raw === 'object' && raw !== null && 'title' in raw
        ? (raw as ApiProblem)
        : { type: 'about:blank', title: res.statusText || `HTTP ${res.status}`, status: res.status };
    throw new ApiError({ ...problem, status: res.status }, raw);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? await res.json() : await res.text()) as T;
}

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(res, path);
}

export const get = <T,>(p: string) => api<T>('GET', p);
export const post = <T,>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const put = <T,>(p: string, b: unknown) => api<T>('PUT', p, b);
export const patch = <T,>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T,>(p: string) => api<T>('DELETE', p);

export async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form });
  return parse<T>(res, path);
}

/** 拼查询串，跳过空值 */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const enc = encodeURIComponent;

const SSE_TYPES: SseEventType[] = [
  'hello',
  'task_changed',
  'run_started',
  'run_event',
  'run_exit',
  'quota_wait',
  'inbox_new',
  'chapter_accepted',
  'chapter_published',
  'circuit_changed',
  'book_changed',
  'login_output',
  'login_state',
];

export type StreamStatus = 'connecting' | 'open' | 'error';

export function openEventStream(path: string, onEvent: (e: SseEvent) => void, onStatus?: (s: StreamStatus) => void): () => void {
  const es = new EventSource(path, { withCredentials: true });
  const handle = (m: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(m.data) as SseEvent);
    } catch {
      // 非 JSON 帧直接忽略，不打断流
    }
  };
  for (const t of SSE_TYPES) es.addEventListener(t, handle as EventListener);
  es.onmessage = handle;
  onStatus?.('connecting');
  es.onopen = () => onStatus?.('open');
  es.onerror = () => onStatus?.('error');
  return () => es.close();
}
