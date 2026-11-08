import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TASK_KINDS, chapterId, countCjk, zCard, zDebt, zDelta, zReview } from '@novelist/shared';
import { parse as yamlParse } from 'yaml';
import { P } from '../book/index.js';
import { books, chapters } from '../db/schema.js';
import { checkAnchors } from './handlers/summary.js';
import { windowTarget, parseWindow } from './handlers/audit.js';
import { computeTaskId, manifestHash } from './ids.js';
import { chapterActionSpecs } from './next.js';
import { effectiveTier, isKeyChapter } from './book.js';
import { HANDLERS, handlerFor } from './registry.js';
import { createMiniBook, runUntilIdle, startBook, type MiniEnv } from './testing.js';
import { parseWorkOrder, renderTemplate, renderWorkOrder } from './workorder.js';
import type { Manifest, TaskSpec } from './types.js';

let env: MiniEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('ids / workorder', () => {
  const m: Manifest = { hard: { 'a.yaml': 'x', 'b.yaml': 'y' }, soft: {}, rebaseValidators: [], configHash: 'c' };
  const s: TaskSpec = { kind: 'chapter.write', bookId: 'b', target: 'c00001' };
  it('task id 由 kind/target/manifest/stack/config 决定，params 不进 id', () => {
    const a = computeTaskId(s, m, 'st');
    expect(a).toBe(computeTaskId({ ...s, params: { foo: 1 } }, m, 'st'));
    expect(a).not.toBe(computeTaskId(s, { ...m, configHash: 'd' }, 'st'));
    expect(a).not.toBe(computeTaskId({ ...s, target: 'c00002' }, m, 'st'));
    expect(a).not.toBe(computeTaskId(s, m, 'other'));
    expect(manifestHash({ a: '1', b: '2' })).toBe(manifestHash({ b: '2', a: '1' }));
  });
  it('工作单往返', () => {
    const fm = {
      schema: 'nv.workorder/1' as const,
      task_id: 't',
      run_id: 'r',
      kind: 'chapter.write' as const,
      role: 'writer' as const,
      book: 'b',
      target: 'c00001',
      out_dir: '/out',
      inputs: [],
      artifacts: [{ path: 'receipt.json', kind: 'receipt' as const, required: true }],
      budget: { max_full_chapter_reads: 4, max_searches: 8 },
    };
    const text = renderWorkOrder(fm, '正文\n');
    const back = parseWorkOrder(text);
    expect(back.frontmatter.target).toBe('c00001');
    expect(back.body).toBe('正文\n');
  });
  it('模板单次替换，用户文本不被再次展开', async () => {
    const out = await renderTemplate('chapter.confirm', { cid: 'c1', draft_path: '/d', questions: '含 {{output}} 的文本 $1', op_reference: 'R', output: 'O', retry: '' });
    expect(out).toContain('含 {{output}} 的文本 $1');
    await expect(renderTemplate('chapter.confirm', { cid: 'c1' })).rejects.toThrow(/缺少变量/);
  });
  it('registry 覆盖全部 TaskKind', () => {
    for (const k of TASK_KINDS) expect(HANDLERS[k]?.kind).toBe(k);
    expect(handlerFor('chapter.accept').role).toBeNull();
  });
  it('摘要锚点校验', () => {
    expect(checkAnchors('主角出发了[c00001]。他到了城里[c00002]。', 1, 2).ok).toBe(true);
    expect(checkAnchors('主角出发了。他到了城里。又走了[c00002]。', 1, 2).ok).toBe(false);
    expect(windowTarget(6, 10)).toBe('c00006-c00010');
    expect(parseWindow('c00006-c00010')).toEqual([6, 10]);
  });
});

describe('5 章迷你书：standard（默认档）全流程', () => {
  it('开书 → 规划 → 5 章写作 → 摘要/审计 → 完结', async () => {
    env = await createMiniBook();
    await startBook(env);
    await runUntilIdle(env);
    const bookRow = (await env.dbh.db.select().from(books).where(eq(books.id, env.bookId)))[0];
    expect(env.log.filter((l) => l.status === 'failed' || l.status === 'blocked')).toEqual([]);
    expect(bookRow?.acceptedThrough).toBe(5);
    expect(bookRow?.status).toBe('completed');
    expect(bookRow?.auditedThrough).toBe(5);
    // 开书管线顺序
    const kinds = env.log.map((l) => l.kind);
    for (const k of ['plan.premise', 'plan.compass', 'plan.bible', 'plan.volumes', 'plan.volume', 'plan.arc', 'routing.feasibility']) expect(kinds).toContain(k);
    expect(kinds.indexOf('plan.compass')).toBeLessThan(kinds.indexOf('plan.bible'));
    expect(kinds.indexOf('plan.arc')).toBeLessThan(kinds.indexOf('chapter.write'));
    // standard 走 extract + review，不走 check
    expect(kinds).toContain('chapter.extract');
    expect(kinds).toContain('chapter.review');
    expect(kinds).not.toContain('chapter.check');
    // 产物入库
    const handle = await env.ctx();
    const book = handle.book!;
    for (let n = 1; n <= 5; n++) {
      const text = await book.files.manuscript(n);
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/<!--\s*beat:/);
      expect(countCjk(text as string, 'han')).toBeGreaterThan(2000);
      expect(zDelta.parse(JSON.parse((await book.repo.readFile(P.ledger(n))) as string)).chapter).toBe(chapterId(n));
      expect(zReview.parse(JSON.parse((await book.repo.readFile(P.review(n))) as string)).verdict).toBe('pass');
    }
    expect((await book.repo.tags('ch/*')).length).toBe(5);
    expect(await book.repo.exists(P.summaryArc('a0001'))).toBe(true);
    expect(await book.repo.exists(P.audit('arc-a0001'))).toBe(true);
    expect(await book.repo.exists(P.audit('window-c00001-c00005'))).toBe(true);
    expect(await book.repo.exists(P.summaryVolume('v01'))).toBe(true);
    expect(await book.repo.exists(P.summaryBook)).toBe(true);
    const row3 = (await env.dbh.db.select().from(chapters).where(eq(chapters.bookId, env.bookId))).find((r) => r.no === 3);
    expect(row3?.state).toBe('accepted');
    expect(row3?.cjk).toBeGreaterThan(2000);
    // 接受时 stale 卡要有标记字段（zCard 合法）
    expect(() => zCard.parse(yamlParse('schema: nv.card/1\nid: c00001\ntitle: t\nvolume: v01\narc: a0001\nbeats: [{id: b1, cjk: 1, goal: g}]\n'))).not.toThrow();
    await fs.access(path.join(book.dir, 'plan/cards/c00005.yaml'));
  }, 180_000);
});

describe('流程分支', () => {
  it('lite 档：write → check → accept，无 review', async () => {
    env = await createMiniBook({ chapters: 2, config: { tier: 'lite', tiers: { key_chapters: 'lite' } } });
    await startBook(env);
    await runUntilIdle(env);
    const kinds = env.log.map((l) => l.kind);
    expect(kinds).toContain('chapter.check');
    expect(kinds).not.toContain('chapter.extract');
    expect(kinds).not.toContain('chapter.review');
    const row = (await env.dbh.db.select().from(books).where(eq(books.id, env.bookId)))[0];
    expect(row?.acceptedThrough).toBe(2);
    expect(env.log.filter((l) => l.status === 'blocked')).toEqual([]);
  }, 120_000);

  it('偏短草稿 → chapter.expand 修订后通过', async () => {
    env = await createMiniBook({
      chapters: 1,
      scenario: (t, nth) => (t.kind === 'chapter.write' && nth === 1 ? { draftChars: 1500 } : undefined),
    });
    await startBook(env);
    await runUntilIdle(env);
    expect(env.log.map((l) => l.kind)).toContain('chapter.expand');
    const row = (await env.dbh.db.select().from(books).where(eq(books.id, env.bookId)))[0];
    expect(row?.acceptedThrough).toBe(1);
  }, 120_000);

  it('长度修订耗尽 → 普通章 accept_with_debt，写入 forward 债务', async () => {
    env = await createMiniBook({
      chapters: 1,
      // 单章书同时是第 1 章/最终章（关键章默认 hold），这里把 key 列设为放行，测 accept_with_debt
      config: { policy: { on_exhausted: { soft_only: { normal: 'accept_with_debt', key: 'accept_with_debt' }, craft_hard: { normal: 'accept_with_debt', key: 'accept_with_debt' }, canon_hard: 'block' } } as never },
      scenario: (t) => (t.kind === 'chapter.write' || t.kind === 'chapter.expand' ? { draftChars: 1500 } : undefined),
    });
    await startBook(env);
    await runUntilIdle(env);
    const row = (await env.dbh.db.select().from(books).where(eq(books.id, env.bookId)))[0];
    expect(row?.acceptedThrough).toBe(1);
    const book = (await env.ctx()).book!;
    const debts = (await book.repo.readFile(P.debt))?.trim().split('\n').map((l) => zDebt.parse(JSON.parse(l))) ?? [];
    expect(debts.some((d) => d.class === 'forward' && d.rule === 'length.total')).toBe(true);
  }, 120_000);

  it('评审要求修订 → chapter.revise(findings) → 第二次评审通过 → pairwise 关闭时直接再评审', async () => {
    let reviewCalls = 0;
    env = await createMiniBook({
      chapters: 1,
      scenario: (t) => {
        if (t.kind === 'chapter.review') {
          reviewCalls += 1;
          if (reviewCalls === 1) return { content: { 'review.json': { schema: 'nv.review/1', chapter: 'c00001', tier: 'standard', verdict: 'revise', findings: [{ id: 'f1', severity: 'hard', category: 'logic', message: '动机不足', suggestion: '补一句动机' }] } } };
        }
        return undefined;
      },
    });
    await startBook(env);
    await runUntilIdle(env);
    const kinds = env.log.map((l) => l.kind);
    expect(kinds).toContain('chapter.revise');
    expect(reviewCalls).toBe(2);
    const row = (await env.dbh.db.select().from(books).where(eq(books.id, env.bookId)))[0];
    expect(row?.acceptedThrough).toBe(1);
  }, 120_000);

  it('schema 不合法 → format.repair（≤1）', async () => {
    env = await createMiniBook({
      chapters: 1,
      scenario: (t, nth) => (t.kind === 'chapter.extract' && nth === 1 ? { content: { 'delta.json': { schema: 'nv.delta/1', chapter: 'c00001', ops: [{ op: 'bad-op' }] } } } : undefined),
    });
    await startBook(env);
    await runUntilIdle(env);
    expect(env.log.map((l) => l.kind)).toContain('format.repair');
  }, 120_000);

  it('审批门：compass 需批准时，开放审批项阻塞后续；批准后继续', async () => {
    env = await createMiniBook({ chapters: 1, config: { approvals: { compass: { required: true }, first_volume: { required: false }, failover: { required: false } } } });
    await startBook(env);
    await runUntilIdle(env);
    expect(env.log.map((l) => l.kind)).not.toContain('plan.bible');
    expect(env.inbox.some((i) => i.kind === 'approval')).toBe(true);
    env.openApprovals.clear();
    await runUntilIdle(env);
    expect(env.log.map((l) => l.kind)).toContain('plan.bible');
  }, 120_000);

  it('计划外 op 使后续卡片 stale → card.repair，修复后继续写作', async () => {
    // 第 1 章写死一段已知正文，让 delta 的 ev 可验证；delta 退场 char.fake-1，第 2 章卡片要求其活着
    const sentence = '他把手里的旧信又看了一遍，指尖在那枚模糊的印章上停了很久。';
    const draft = ['<!-- beat:b1 -->', sentence.repeat(50), '<!-- beat:b2 -->', sentence.repeat(50), '<!-- beat:b3 -->', sentence.repeat(50), ''].join('\n');
    const card2 = { schema: 'nv.card/1', id: 'c00002', title: '第2章', volume: 'v01', arc: 'a0001', pre: [{ alive: 'char.fake-1' }], beats: [{ id: 'b1', cjk: 1000, goal: 'g' }, { id: 'b2', cjk: 1000, goal: 'g' }, { id: 'b3', cjk: 1000, goal: 'g' }], length: { min: 2400, target: 3000, max: 3600, count_mode: 'han' }, is_final: true };
    env = await createMiniBook({
      chapters: 2,
      scenario: (t, nth) => {
        if (t.kind === 'plan.arc') return { expand: { 'plan/cards/c*.yaml': ['c00001', 'c00002'] }, chapters: ['c00001', 'c00002'], content: { 'plan/cards/c00002.yaml': card2 } };
        if (t.kind === 'chapter.write' && t.target === 'c00001' && nth === 1) return { content: { 'manuscript/c00001.md': draft } };
        if (t.kind === 'chapter.extract' && t.target === 'c00001' && nth === 1)
          return { content: { 'delta.json': { schema: 'nv.delta/1', chapter: 'c00001', summary: [{ s: '主角收到线索。', anchors: ['op:0'] }], ops: [{ op: 'entity.retire', ent: 'char.fake-1', how: 'death', ev: sentence }] } } };
        return undefined;
      },
    });
    await startBook(env);
    await runUntilIdle(env);
    const kinds = env.log.map((l) => l.kind);
    expect(kinds).toContain('card.repair');
    expect(kinds.indexOf('card.repair')).toBeGreaterThan(kinds.indexOf('chapter.accept'));
    expect((await env.dbh.db.select().from(books).where(eq(books.id, env.bookId)))[0]?.acceptedThrough).toBe(2);
    const book = (await env.ctx()).book!;
    expect((await book.files.card(2))?.stale).toBe(false);
  }, 120_000);
});

describe('tier 判定', () => {
  it('关键章规则', () => {
    expect(isKeyChapter(2)).toBe(true);
    expect(isKeyChapter(50)).toBe(false);
    expect(isKeyChapter(50, { card: { key: true, is_final: false, id: 'c00050' } as never })).toBe(true);
    expect(effectiveTier({ config: { tier: 'lite', tiers: { key_chapters: 'key' } } } as never, 2)).toBe('key');
    expect(effectiveTier({ config: { tier: 'lean', tiers: { key_chapters: 'lite' } } } as never, 50)).toBe('lite');
  });
});

describe('key 档与 owner 操作', () => {
  it('key 档：continuity + 判官×2，分歧时仲裁', async () => {
    let judgeCalls = 0;
    env = await createMiniBook({
      chapters: 1,
      config: { tier: 'key' },
      scenario: (t) => {
        if (t.kind === 'chapter.review') {
          const slot = (t.params as { slot?: string }).slot;
          if (slot === 'judge-a') judgeCalls += 1;
          if (slot === 'judge-b') return { verdict: 'revise' };
        }
        return undefined;
      },
    });
    await startBook(env);
    await runUntilIdle(env);
    expect(judgeCalls).toBe(1);
    const reviews = env.log.filter((l) => l.kind === 'chapter.review').length;
    expect(reviews).toBe(4);
    expect((await env.dbh.db.select().from(books).where(eq(books.id, env.bookId)))[0]?.acceptedThrough).toBe(1);
  }, 120_000);

  it('pairwise 开启：修订稿败给原稿时恢复原稿', async () => {
    let reviewCalls = 0;
    env = await createMiniBook({
      chapters: 1,
      config: { optin: { pairwise_regression: true } as never },
      scenario: (t) => {
        if (t.kind === 'chapter.review') {
          reviewCalls += 1;
          if (reviewCalls === 1) return { content: { 'review.json': { schema: 'nv.review/1', chapter: 'c00001', tier: 'standard', verdict: 'revise', findings: [{ id: 'f1', severity: 'soft', category: 'style', message: '节奏偏慢', suggestion: '压缩中段' }] } } };
        }
        if (t.kind === 'chapter.pairwise') return { content: { 'pairwise.json': { schema: 'nv.pairwise/1', chapter: 'c00001', a: 'a', b: 'b', winner: 'a', reasons: ['原稿更好'] } } };
        return undefined;
      },
    });
    await startBook(env);
    await runUntilIdle(env);
    expect(env.log.map((l) => l.kind)).toContain('chapter.pairwise');
    const book = (await env.ctx()).book!;
    const text = await book.files.manuscript(1);
    const debts = (await book.repo.readFile(P.debt))?.trim().split('\n').map((l) => zDebt.parse(JSON.parse(l))) ?? [];
    expect(text).toBeTruthy();
    expect(debts.some((d) => d.rule.startsWith('review.'))).toBe(true);
    expect((await env.dbh.db.select().from(books).where(eq(books.id, env.bookId)))[0]?.acceptedThrough).toBe(1);
  }, 120_000);

  it('章节 owner 操作映射', () => {
    const book = { id: 'b' } as never;
    expect(chapterActionSpecs(book, 3, 'rewrite', { note: '重写开头', instance: 'r1' }).chapter?.state).toBe('planned');
    expect(chapterActionSpecs(book, 3, 'approve', { instance: 'x', workflow: { delta: 'work/d.json' } }).specs[0]?.kind).toBe('chapter.accept');
    // hold 发生在抽取之前：放行后要先抽取
    const early = chapterActionSpecs(book, 3, 'approve', { instance: 'x', workflow: { delta: null, tier: 'lite' } });
    expect(early.specs[0]?.kind).toBe('chapter.check');
    expect(early.chapter?.workflow).toBeUndefined();
  });
});
