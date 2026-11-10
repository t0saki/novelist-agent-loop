import { describe, expect, it } from 'vitest';
import type { BookHandle, RunContext, TaskRow } from '../runtime/types.js';
import { buildPromote } from './commit.js';
import { planHarvest } from './map.js';
import { chapterText, file, mapInput, notesFor, orderSpec } from './testing.js';
import type { V3BatchEffectArgs } from './types.js';

const book = { id: 'book1' } as BookHandle;
const task = { id: 'task1' } as TaskRow;
const run = { runId: 'abcdef1234567890', baseCommit: 'base0' } as RunContext;
const nowIso = '2026-11-10T00:00:00.000Z';

describe('buildPromote', () => {
  it('rewrites first (untagged), then new chapters with ch/ tags; tail and book.yaml patch', () => {
    const order = orderSpec({ allowRewrite: [4] });
    const plan = planHarvest(
      mapInput({
        order,
        autoTitle: true,
        titleIsPlaceholder: true,
        hasBlurb: false,
        files: [
          file('manuscript/c00007.md', chapterText(7, 3200, '')),
          file('manuscript/c00006.md', chapterText(6, 3200, '雨夜')),
          file('manuscript/c00004.md', chapterText(4, 4200, '旧章', 44), { isNew: false, baseText: chapterText(4, 4000, '旧章') }),
          file('outline.md', '计划：共 18 章', { isNew: false, baseText: '计划：共 15 章' }),
          ...notesFor(6, 7),
        ],
      }),
    );
    const p = buildPromote({ book, task, run, order, plan, trailerKey: 'task1.g0@abcdef1234567890', noChapterStreak: 0, nowIso });
    expect(p).not.toBeNull();
    const v3 = p?.v3;
    expect(v3?.parts.map((x) => [x.no, x.tag, x.rewrite, x.message])).toEqual([
      [4, null, true, 'chapter: rewrite c00004「旧章」'],
      [6, 'ch/00006', false, 'chapter: c00006「雨夜」'],
      [7, 'ch/00007', false, 'chapter: c00007'],
    ]);
    expect(v3?.parts.map((x) => x.path)).toEqual(['manuscript/c00004.md', 'manuscript/c00006.md', 'manuscript/c00007.md']);
    expect(v3?.tail.map((t) => t.path)).toEqual(['notes/chapters.md', 'notes/progress.md', 'outline.md']);
    expect(v3?.bookYaml).toEqual([
      { path: ['v3', 'planned_chapters'], value: 18 },
      { path: ['title'], value: '旧书' },
      { path: ['blurb'], value: '旧简介。' },
    ]);
    expect(v3?.key).toBe('task1.g0@abcdef1234567890');
    expect(v3?.tailMessage).toBe('notes: book.write 6–7 run abcdef12');
    expect(p).toMatchObject({ files: [], resolveTmpIds: false, tags: [], trailers: {}, baseCommit: 'base0', runId: run.runId, taskId: 'task1', bookId: 'book1' });
    expect(p?.effect?.name).toBe('v3.batch');
    const args = p?.effect?.args as unknown as V3BatchEffectArgs;
    expect(args.chapters.map((c) => [c.no, c.rewrite, c.cid])).toEqual([
      [4, true, 'c00004'],
      [6, false, 'c00006'],
      [7, false, 'c00007'],
    ]);
    expect(args).toMatchObject({ batchFrom: 6, completed: false, title: '旧书', blurb: '旧简介。', noChapterStreak: 0, runId: run.runId, nowIso });
  });
  it('notes-only plan → no parts, batchFrom null; zero-diff → null', () => {
    const order = orderSpec();
    const plan = planHarvest(mapInput({ order, files: [file('notes/progress.md', '想想', { isNew: false, baseText: '旧' })] }));
    const p = buildPromote({ book, task, run, order, plan, trailerKey: 'k', noChapterStreak: 1, nowIso });
    expect(p?.v3?.parts).toEqual([]);
    expect(p?.v3?.tailMessage).toBe('notes: book.write 6–10 run abcdef12');
    expect((p?.effect?.args as unknown as V3BatchEffectArgs).batchFrom).toBeNull();
    expect(buildPromote({ book, task, run, order, plan: planHarvest(mapInput({ order, files: [] })), trailerKey: 'k', noChapterStreak: 0, nowIso })).toBeNull();
  });
  it('stale drafts move (to drafts/discarded/) travels with its chapter commit', () => {
    const order = orderSpec();
    const plan = planHarvest(mapInput({ order, draftsAtBase: new Map([['drafts/c00006.md', '残稿']]), files: [file('manuscript/c00006.md', chapterText(6)), ...notesFor(6, 6)] }));
    const p = buildPromote({ book, task, run, order, plan, trailerKey: 'k', noChapterStreak: 0, nowIso });
    expect(p?.v3?.parts[0]?.extra).toEqual([
      { path: 'drafts/c00006.md', content: null },
      { path: 'drafts/discarded/c00006.md', content: '残稿' },
    ]);
  });
});
