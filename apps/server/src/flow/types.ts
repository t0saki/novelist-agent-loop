/**
 * v3 流程的类型（docs/v3/DESIGN.md；p1-plan §1.9、§2.1）。
 * 一次运行 = 作者在书快照里干一班活；服务器只排班、递任务单、收稿、数字数、提交、发布。
 */
import type { FileChange } from '../book/repo.js';

export type OrderMode = 'open-short' | 'open-long' | 'write' | 'finale' | 'retro';

/** 任务单的全部输入（同时落盘为 $RUN/in/order.json，finalize 读回） */
export interface OrderSpec {
  v: 1;
  mode: OrderMode;
  kind: 'book.open' | 'book.write' | 'book.retro';
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
  // ── phase 2（可选：phase 1 的 order.json 照样能读） ──
  /** 写作批：收尾阶段（剩余计划章数 ≤ 3 批） */
  phase?: 'normal' | 'closing';
  /** 失控兜底强制的结局批 */
  forced?: boolean;
  /** 写作批：已写到失控基准的 0.75×factor，要求三批内收尾 */
  runawayWarn?: boolean;
  /** 失控基准（主人一侧的计划章数） */
  runawayBase?: number;
  /** outline.md 在 HEAD 上已有“结局章节清单” */
  endingListExists?: boolean;
  /** 复盘的章节区间 */
  retro?: { from: number; to: number };
  /** 上一批的零成本统计（重复的说法、近期偏短） */
  feedback?: { phrases: string[]; range: [number, number] | null; shortRecent: boolean };
  /** WP-2：任务单列出的 notes/from-owner.md 的 blob sha（非空时）；复盘恒为 null */
  ownerMessageSha?: string | null;
  /** WP-2：这一批要先处理的主人改写请求；复盘恒为 [] */
  ownerRequests?: { id: string; chapter: number; note: string }[];
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
  /**
   * WP-2：服务器替主人写的文件（读过的主人留言清空并归档）。只在最后一个提交里、且 HEAD 上该路径的 blob sha 等于 expectSha（null = HEAD 上没有）时写入；
   * 一组里有任何一条对不上就整组不写（主人在运行期间换了或撤回了留言）。不参加“主人为准”的比较，也从不进 drafts/owner-conflicts/。
   */
  serverTail?: { path: string; content: string | null; expectSha: string | null }[];
}

/** DbEffect name 'v3.batch' */
export interface V3BatchEffectArgs {
  bookId: string;
  runId: string;
  nowIso: string;
  chapters: { no: number; cid: string; title: string; cjk: number; rewrite: boolean; path: string }[];
  batchFrom: number | null;
  completed: false | 'marker' | 'backstop';
  /** completion without a new chapter: the finale only marked this already-accepted chapter */
  completedOn?: number;
  /** completed below 60% of the target */
  completedNote?: 'short';
  title?: string;
  blurb?: string;
  hints: V3Hint[];
  noChapterStreak: number;
  finaleNoMarker: number;
  hintedShort: number[];
  /** phase 2 */
  orderKind: OrderSpec['kind'];
  /** the run's base commit (= notes before this batch) */
  baseCommit: string;
  toolSteps?: number;
  runawayBatches: number;
  shortEndUsed: boolean;
  plannedFloor: number | null;
  /** factor 0: two marker-less finales in a row raised the v3_end item */
  finaleNoMarkerAlert?: boolean;
  feedback?: { from: number; to: number; phrases: string[] };
  batchNote?: V3BatchNote;
  /** WP-2：这次运行读到并消化了主人留言（serverTail 已清空 notes/from-owner.md 并归档） */
  ownerMessageRead?: { sha: string; kind: 'open' | 'write' | 'finale'; from: number; to: number; at: string; runId: string; archivedPath: string };
  /**
   * WP-2：任务单带的主人改写请求；效果按入库结果记 done / not_done。
   * final = 运行正常结束且有章入库：只有 final 时没改成的请求才记 not_done，否则继续等（缺省按 final 处理，旧的 pending 记录）
   */
  ownerRequestResults?: { id: string; chapter: number; final?: boolean }[];
  /** WP-3：这次改了 bible.md 且第三行能解析出标签 → 写进 books.meta.tags（顶层） */
  tags?: string[];
}

export interface V3BatchNote {
  from: number;
  to: number;
  steps: number;
  runId: string;
  at: string;
}

/** output of planHarvest (pure) */
export interface HarvestPlan {
  newChapters: {
    no: number;
    title: string;
    content: string;
    cjk: number;
    sourcePaths: string[];
    /** 随该章提交一起移走的旧残稿（drafts/cNNNNN.md 在 base 存在时：删掉原路径，原文存进 drafts/discarded/） */
    extra?: { path: string; content: string | null }[];
  }[];
  /** extra：主人要求的改写通过时，旧版随这次改写存进 drafts/replaced/<ts>/ */
  rewrites: { no: number; title: string; content: string; cjk: number; extra?: { path: string; content: string | null }[] }[];
  tail: { path: string; content: string | null }[];
  hints: V3Hint[];
  completed: false | 'marker' | 'backstop';
  /** completed on an already-accepted chapter (finale added （全书完） to it, no new chapter) */
  completedOn?: number;
  completedNote?: 'short';
  finaleNoMarker: number;
  /** factor 0 only: the second marker-less finale in a row (finalize raises one v3_end item) */
  finaleNoMarkerAlert?: boolean;
  runawayBatches: number;
  shortEndUsed: boolean;
  plannedFloor: number | null;
  zeroDiff: boolean;
  changed: number;
  title?: string;
  blurb?: string;
  plannedChapters?: number;
  hintedShort: number[];
  /** WP-3：bible.md 在这次改动里、第三行的标签（books.meta.tags） */
  tags?: string[];
}

/** WP-3：最近一次运行渲染出的 AGENTS.md 超过 16 KB（hard = 超过 harness 的硬上限，没有启动）；渲染回 16 KB 以下的运行清掉 */
export interface V3AgentsSize {
  bytes: number;
  hard: boolean;
  limit: number;
  harness: string;
  at: string;
  layers: { layer: string; bytes: number }[];
}

/** WP-3：排班用的存稿状况（nextTasksV3 有变化时写；claimNext 按 bufferDays 排、自动开书看 bufferFull） */
export interface V3Sched {
  bufferDays: number | null;
  bufferFull: boolean;
  at: string;
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
  /** no_marker_twice: phase 1 only (read, never produced again) */
  completedReason?: 'marker' | 'no_marker_twice' | 'backstop';
  /** set when the book completed below 60% of the target */
  completedNote?: 'short';
  /** oldest first; appended by v3.batch when new chapters landed */
  batchLog: V3BatchLogEntry[];
  retro: { afterBatches: number; lastAt: string | null; lastRunId: string | null; lastStatus: 'done' | 'failed' | 'empty' | null };
  /** consecutive landed batches that started at accepted ≥ factor × runawayBase (0 below it) */
  runawayBatches: number;
  /** factor 0 only: the v3_end item was raised for the current run of marker-less finales */
  finaleNoMarkerAlerted: boolean;
  /** long/epic: the "too short to end" extension has been used once */
  shortEndUsed: boolean;
  /** lower clamp for planned_chapters after that extension */
  plannedFloor: number | null;
  /** repetition stats of the last landed batch */
  feedback: { from: number; to: number; phrases: string[] } | null;
  /** last automatic batch reduction */
  batchNote: V3BatchNote | null;
  /** WP-3：AGENTS.md 超过 16 KB 的最近一次记录（没有 = null） */
  agentsSize: V3AgentsSize | null;
  /** WP-3：存稿天数 / 是否已满 */
  sched: V3Sched | null;
  // ── WP-2：主人的操作 ──
  /** 回退进行中（git 动手之前设上，DB 那一步清掉；恢复用的键） */
  rewinding: { to: number; ts: string; at: string; note?: string } | null;
  /** 还没被读的一次性留言 */
  ownerMessage: V3OwnerMessageMeta | null;
  /** 历史，新的在前，≤ 20 */
  ownerMessages: V3OwnerMessageMeta[];
  /** 改写请求，≤ 50（先丢最早处理完的） */
  ownerRequests: V3OwnerRequest[];
}

export interface V3OwnerMessageMeta {
  id: string;
  text: string;
  sha: string;
  setAt: string;
  /** 复盘从不读 */
  readIn: { kind: 'open' | 'write' | 'finale'; from: number; to: number; at: string; runId: string } | null;
  archivedPath: string | null;
  status: 'waiting' | 'read' | 'replaced' | 'withdrawn';
}

export interface V3OwnerRequest {
  id: string;
  kind: 'rewrite';
  chapter: number;
  note: string;
  at: string;
  status: 'waiting' | 'done' | 'not_done' | 'dropped';
  runId?: string;
}

export interface V3BatchLogEntry {
  runId: string | null;
  kind: 'open' | 'write' | 'finale' | 'adopt';
  /** landed new chapters */
  from: number;
  to: number;
  /** the run's base (= notes before this batch; rewind uses it) */
  baseCommit: string;
  finalCommit: string;
  at: string;
  toolSteps?: number;
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
  | 'renumbered'
  | 'end_too_short'
  | 'finale_no_marker'
  | 'owner_rewrite'
  | 'rewound';

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
