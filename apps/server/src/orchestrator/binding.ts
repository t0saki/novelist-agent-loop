/**
 * orchestrator 对 lane E（pipeline）的依赖面。默认绑定真实实现；测试注入假的 handler。Owner: lane F。
 */
import * as pipeline from '../pipeline/index.js';
import type { BookHandle, PipelineContext, PipelineDeps, TaskHandler, TaskResult, TaskRow, TaskSpec, Manifest } from '../pipeline/types.js';
import type { BookRuntimeState } from '../pipeline/next.js';
import type { TaskKind, WorkOrderFrontmatter } from '@novelist/shared';

export interface PipelineBinding {
  handlerFor(kind: TaskKind): TaskHandler;
  openBook(deps: PipelineDeps, idOrSlug: string): Promise<BookHandle>;
  effectiveTier(book: BookHandle, chapterNo: number | null): 'lite' | 'standard' | 'key';
  computeTaskId(spec: TaskSpec, manifest: Manifest, stackHash: string): string;
  initialTasks(book: BookHandle, opts: { interview: boolean }): TaskSpec[];
  nextTasks(ctx: PipelineContext, state: BookRuntimeState): Promise<TaskSpec[]>;
  onTaskDone(ctx: PipelineContext, task: TaskRow, result: TaskResult): Promise<TaskSpec[]>;
  renderWorkOrder(fm: WorkOrderFrontmatter, body: string): string;
}

export const defaultPipeline: PipelineBinding = {
  handlerFor: pipeline.handlerFor,
  openBook: pipeline.openBook,
  effectiveTier: pipeline.effectiveTier,
  computeTaskId: pipeline.computeTaskId,
  initialTasks: pipeline.initialTasks,
  nextTasks: pipeline.nextTasks,
  onTaskDone: pipeline.onTaskDone,
  renderWorkOrder: pipeline.renderWorkOrder,
};

export type { BookRuntimeState };
