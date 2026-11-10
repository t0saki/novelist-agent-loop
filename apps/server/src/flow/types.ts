/**
 * v3 流程的类型（docs/v3/DESIGN.md；p1-plan §1.9、§2.1）。
 * 一次运行 = 作者在书快照里干一班活；服务器只排班、递任务单、收稿、数字数、提交、发布。
 */
import type { FileChange } from '../book/repo.js';

export type OrderMode = 'open-short' | 'open-long' | 'write' | 'finale';

/** 任务单的全部输入（同时落盘为 $RUN/in/order.json，finalize 读回） */
export interface OrderSpec {
  v: 1;
  mode: OrderMode;
  kind: 'book.open' | 'book.write';
  from: number;
  count: number;
  /** 结局批（open-short 也算） */
  finale: boolean;
  minChars: number;
  targetCjk: number;
  planned: number;
  plannedMax: number;
  batch: number;
  accepted: number;
  totalCjk: number;
  publishedThrough: number;
  locked: number[];
  allowRewrite: number[];
  bibleExisted: boolean;
  hintsShown: V3Hint[];
  effort: 'low' | 'medium' | 'high';
}

export interface ChangedFile {
  path: string;
  sha: string;
  bytes: number;
  isNew: boolean;
  /** live 仓库的 .gitignore 规则忽略它（git add 会拒收） */
  ignored: boolean;
}

export interface RunChanges {
  schema: 'nv.v3changes/1';
  runId: string;
  baseCommit: string;
  /** absolute: <live>/work/<task>/run-<runId>/changes */
  stagedDir: string;
  files: ChangedFile[];
  skipped: { path: string; reason: 'protected' | 'binary' | 'not_utf8' | 'too_large' | 'symlink' }[];
}

export interface V3CommitPart {
  no: number;
  path: string;
  content: string;
  message: string;
  tag: string | null;
  rewrite: boolean;
  /** e.g. delete drafts/cNNNNN.md */
  extra: FileChange[];
}

export interface V3CommitPlan {
  /** pending.trailerKey – idempotency */
  key: string;
  /** rewrites first (tag null), then new chapters ascending (tag ch/NNNNN) */
  parts: V3CommitPart[];
  /** notes/bible/outline/drafts/archive/other text files */
  tail: { path: string; content: string | null }[];
  /** applied to HEAD's book.yaml under the lock */
  bookYaml: { path: (string | number)[]; value: unknown }[];
  baseCommit: string;
  tailMessage: string;
}

/** DbEffect name 'v3.batch' */
export interface V3BatchEffectArgs {
  bookId: string;
  runId: string;
  nowIso: string;
  chapters: { no: number; cid: string; title: string; cjk: number; rewrite: boolean; path: string }[];
  batchFrom: number | null;
  completed: false | 'marker' | 'no_marker_twice';
  /** completion without a new chapter: the finale only marked this already-accepted chapter */
  completedOn?: number;
  title?: string;
  blurb?: string;
  hints: V3Hint[];
  noChapterStreak: number;
  finaleNoMarker: number;
  hintedShort: number[];
}

/** output of planHarvest (pure) */
export interface HarvestPlan {
  newChapters: {
    no: number;
    title: string;
    content: string;
    cjk: number;
    sourcePaths: string[];
    /** 随该章提交一起删除的旧残稿（drafts/cNNNNN.md 在 base 存在时） */
    extra?: { path: string; content: null }[];
  }[];
  rewrites: { no: number; title: string; content: string; cjk: number }[];
  tail: { path: string; content: string | null }[];
  hints: V3Hint[];
  completed: false | 'marker' | 'no_marker_twice';
  /** completed on an already-accepted chapter (finale added （全书完） to it, no new chapter) */
  completedOn?: number;
  finaleNoMarker: number;
  zeroDiff: boolean;
  changed: number;
  title?: string;
  blurb?: string;
  plannedChapters?: number;
  hintedShort: number[];
}

// ───────────────────────── books.meta.v3（§1.9） ─────────────────────────

export interface V3BookMeta {
  /** shown in the next ORDER; replaced by every harvest that had changes */
  hints: V3Hint[];
  /** consecutive runs with changes but no new chapter (book ladder, inbox at 5) */
  noChapterStreak: number;
  /** consecutive runs of THIS book with no change at all, lost runs included (book ladder, inbox at 5) */
  emptyStreak: number;
  /** consecutive finale runs that landed chapters without the end marker */
  finaleNoMarker: number;
  /** first new chapter of the most recent landed batch (publisher rule) */
  lastBatchFrom: number | null;
  lastBatchAt: string | null;
  /** chapters that already got the one-time "补到 X 字" hint */
  hintedShort: number[];
  /** chapters the owner edited by hand; never rewritten by a run */
  locked: number[];
  /** an unfinished harvest; while set, no new harness run starts for this book */
  pending: V3Pending | null;
  completedAt?: string;
  completedReason?: 'marker' | 'no_marker_twice';
}

export interface V3Pending {
  taskId: string;
  runId: string;
  attempt: number;
  /** 'run': snapshot not harvested yet; 'harvested': changes copied, snapshot may be gone */
  stage: 'run' | 'harvested';
  runDir: string;
  inDir: string;
  snapshotDir: string;
  baseCommit: string;
  /** <live>/work/<task>/run-<runId>/changes.json once harvested */
  manifestFile: string | null;
  /** `${taskTrailerValue(taskId, generation)}@${runId}`, fixed at run start */
  trailerKey: string;
  route: { profile: string; account: string | null; harness: string; model: string | null; isolation: string; stackHash: string };
  /** server-side harvest/finalize/promote failures on this pending */
  failures: number;
  lastError?: string;
  /** the run's infra side effects (account sleep / auth-bad / inbox / orch patch) were applied once; later consumes skip them */
  infraApplied?: boolean;
  createdAt: string;
}

export type V3HintKind =
  | 'unfinished'
  | 'short'
  | 'early_end'
  | 'end_marker'
  | 'notes_missing'
  | 'notes_shrunk'
  | 'misplaced'
  | 'relocated'
  | 'ignored'
  | 'meta_stripped'
  | 'owner_edit'
  | 'unauthorized_edit'
  | 'rewrite_rejected'
  | 'no_bible'
  | 'renumbered';

export interface V3Hint {
  kind: V3HintKind;
  /** Chinese, rendered verbatim into ORDER.md */
  text: string;
  chapter?: number;
  /** authorises rewriting this already-accepted chapter in the next run (short / early_end); dropped once the chapter is published or locked */
  rewrite?: number;
  /** kept across harvests until resolved ('unfinished' only: until that chapter is accepted) */
  sticky?: boolean;
  /** 章号区间（notes_missing：判断“同一批只提示一次”） */
  range?: [number, number];
  /** ISO time the hint was created (early_end publish hold) */
  at: string;
}
