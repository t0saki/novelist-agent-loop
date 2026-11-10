/**
 * orchestrator 对任务运行时（runtime/）的依赖面。默认绑定真实实现；测试注入假的 handler。
 */
import * as runtime from '../runtime/index.js';
import type { BookHandle, PipelineContext, PipelineDeps, TaskHandler, TaskResult, TaskRow, TaskSpec, Manifest } from '../runtime/types.js';

export interface PipelineBinding {
  handlerFor(kind: string): TaskHandler;
  openBook(deps: PipelineDeps, idOrSlug: string): Promise<BookHandle>;
  computeTaskId(spec: TaskSpec, manifest: Manifest, stackHash: string): string;
  nextTasks(ctx: PipelineContext): Promise<TaskSpec[]>;
  onTaskDone(ctx: PipelineContext, task: TaskRow, result: TaskResult): Promise<TaskSpec[]>;
}

export const defaultPipeline: PipelineBinding = {
  handlerFor: runtime.handlerFor,
  openBook: runtime.openBook,
  computeTaskId: runtime.computeTaskId,
  nextTasks: runtime.nextTasks,
  onTaskDone: runtime.onTaskDone,
};
