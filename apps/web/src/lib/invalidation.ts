import type { SseEvent } from '@novelist/shared';

/** SSE 事件 → 要刷新的查询路径前缀。run_event/登录输出频率高，由各自页面处理，这里不刷新。 */
export function invalidationsFor(e: SseEvent): string[] {
  switch (e.type) {
    case 'task_changed':
      return ['/api/admin/tasks', ...(e.book ? [`/api/admin/books/${e.book}`, '/api/admin/books'] : [])];
    case 'run_started':
    case 'run_exit':
      return ['/api/admin/runs', '/api/admin/quota'];
    case 'quota_wait':
      return ['/api/admin/quota', '/api/admin/accounts'];
    case 'inbox_new':
      return ['/api/admin/inbox'];
    case 'chapter_accepted':
    case 'chapter_published':
      return ['/api/admin/books', '/api/admin/schedule'];
    case 'circuit_changed':
      return ['/api/admin/harness'];
    case 'book_changed':
      return ['/api/admin/books', '/api/admin/schedule'];
    default:
      return [];
  }
}
