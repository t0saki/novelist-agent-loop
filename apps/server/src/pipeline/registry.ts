/** TaskKind → handler。Owner: lane E。每个 TASK_KINDS 成员必须有 handler（测试断言）。 */
import type { TaskKind } from '@novelist/shared';
import type { TaskHandler } from './types.js';
import * as plan from './handlers/plan.js';
import * as chapter from './handlers/chapter.js';
import * as summary from './handlers/summary.js';
import * as audit from './handlers/audit.js';
import * as system from './handlers/system.js';
import * as flowHandlers from '../flow/handlers.js';

const isHandler = (v: unknown): v is TaskHandler => typeof v === 'object' && v !== null && typeof (v as TaskHandler).kind === 'string' && typeof (v as TaskHandler).manifest === 'function';
const all: TaskHandler[] = [plan, chapter, summary, audit, system, flowHandlers].flatMap((m) => Object.values(m as Record<string, unknown>).filter(isHandler));

export const HANDLERS: Record<TaskKind, TaskHandler> = Object.fromEntries(all.map((h) => [h.kind, h])) as Record<TaskKind, TaskHandler>;

export function handlerFor(kind: TaskKind): TaskHandler {
  const h = HANDLERS[kind];
  if (!h) throw new Error(`no handler for ${kind}`);
  return h;
}
