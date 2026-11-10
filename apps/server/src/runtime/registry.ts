/** TaskKind → handler。每个 TASK_KINDS 成员必须有 handler（测试断言）；已删除的旧种类只作为字符串留在 tasks/runs 行里。 */
import { TASK_KINDS, type TaskKind } from '@novelist/shared';
import { bookOpen, bookRetro, bookWrite } from '../flow/handlers.js';
import { publish } from './publish.js';
import type { TaskHandler } from './types.js';

export const HANDLERS: Record<TaskKind, TaskHandler> = {
  'book.open': bookOpen,
  'book.write': bookWrite,
  'book.retro': bookRetro,
  publish,
};

export class UnknownTaskKindError extends Error {
  constructor(readonly kind: string) {
    super(`unknown task kind ${kind}`);
    this.name = 'UnknownTaskKindError';
  }
}

export function isKnownKind(kind: string): kind is TaskKind {
  return (TASK_KINDS as readonly string[]).includes(kind);
}

export function handlerFor(kind: string): TaskHandler {
  if (!isKnownKind(kind)) throw new UnknownTaskKindError(kind);
  return HANDLERS[kind];
}
