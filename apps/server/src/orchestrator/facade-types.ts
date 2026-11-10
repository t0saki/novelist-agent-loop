/** 门面用到的 DTO 类型别名（来自 shared/api） */
import type { z } from 'zod';
import type { zBookAction, zChapterAction } from '@novelist/shared';
export type { InboxItem } from '@novelist/shared';
export type BookAction = z.infer<typeof zBookAction>;
export type ChapterAction = z.infer<typeof zChapterAction>;
