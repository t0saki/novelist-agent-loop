/**
 * 旧书页（P3）：导入的、旧流程写的书只读——按卷列章节、导出、直接改正文；想续写就“接手续写”（改成新流程，从下一章接着写）。
 * 书目录不在时只能删除。
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { V3_LENGTHS, takeoverPlanned, type BookOverview, type BookSummary, type ChapterRow, type Takeover, type TakeoverDefaults, type V3Length } from '@novelist/shared';
import { del, enc, post } from '../../../api/client';
import { useAction, useApi, useInvalidate, usePaged } from '../../../api/hooks';
import { Badge, Button, Card, confirmDialog, Empty, ErrorBox, Field, Input, Loading, LoadMore, Modal, Notice, Q, Select, Toggle } from '../../../components/ui';
import { toast } from '../../../components/toast';
import { fmtBytes, fmtCjk, fmtRel } from '../../../lib/format';
import { BOOK_STATUS, V3_LENGTH_LABEL } from '../../../lib/labels';

interface VolumeGroup {
  key: string;
  heading: string;
  chapters: ChapterRow[];
}

/** 按 volume 分组，标题用 volumeTitle，没有就用卷 id；没有卷的章节归到最后一组 */
export function groupByVolume(rows: ChapterRow[]): VolumeGroup[] {
  const out: VolumeGroup[] = [];
  for (const c of [...rows].sort((a, b) => a.no - b.no)) {
    const key = c.volume || '';
    let g = out.at(-1);
    if (!g || g.key !== key) {
      g = { key, heading: key === '' ? '未分卷' : key, chapters: [] };
      out.push(g);
    }
    // 卷标题取这一组里第一个非空的 volumeTitle；都为空就显示卷 id
    if (key !== '' && g.heading === key && c.volumeTitle) g.heading = c.volumeTitle;
    g.chapters.push(c);
  }
  return out;
}

function TakeoverModal({ slug, onClose }: { slug: string; onClose: () => void }) {
  const base = `/api/admin/books/${enc(slug)}`;
  const q = useApi<TakeoverDefaults>(`${base}/takeover`);
  return (
    <Modal title="接手续写" onClose={onClose}>
      <Q q={q}>{(d) => <TakeoverForm slug={slug} d={d} onClose={onClose} />}</Q>
    </Modal>
  );
}

function TakeoverForm({ slug, d, onClose }: { slug: string; d: TakeoverDefaults; onClose: () => void }) {
  const invalidate = useInvalidate();
  const [length, setLength] = useState<V3Length>(d.length);
  const [target, setTarget] = useState(String(d.target_cjk));
  const [batch, setBatch] = useState(String(d.batch));
  const [min, setMin] = useState(String(d.min_chapter_cjk));
  const [start, setStart] = useState(true);
  const t = Number(target);
  const b = Number(batch);
  const m = Number(min);
  const ok = Number.isInteger(t) && t > 0 && Number.isInteger(b) && b >= 1 && b <= 8 && Number.isInteger(m) && m > 0 && !d.gap;
  // 和服务端同一个折算（packages/shared takeoverPlanned）：计划章数、还要写几章、第一批是不是就进入收尾
  const planned = ok ? takeoverPlanned({ accepted: d.accepted, totalCjk: d.totalCjk, target_cjk: t, batch: b, min_chapter_cjk: m, length }, d.closingBatches) : null;
  const remaining = planned === null ? null : planned - d.accepted;
  const closingSoon = remaining !== null && d.accepted > 0 && (length === 'short' || remaining <= d.closingBatches * b);
  const go = useAction(() => post<BookSummary>(`/api/admin/books/${enc(slug)}/takeover`, { length, target_cjk: t, batch: b, min_chapter_cjk: m, start } satisfies Takeover), {
    ok: start ? '已接手，下一次写作先补笔记再续写' : '已接手（暂停中）',
    onDone: () => {
      onClose();
      void invalidate(`/api/admin/books/${enc(slug)}`, '/api/admin/books');
    },
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-sub">
        已写 {d.accepted} 章，共 {fmtCjk(d.totalCjk)}。接手后这本书改用新流程：book.yaml 加上新流程的设置（旧键原样保留），写作从第 {d.accepted + 1} 章接着来；第一次写作先读最后三章和旧设定，补出笔记再续写。已写的章节不会被改动，也不能回退到接手之前。
      </p>
      {d.gap && (
        <Notice tone="warn">
          第 {d.gap.missing.join('、') || '?'} 章缺失，后面却还有第 {d.gap.extra.join('、')} 章（导入时中间缺章）。接手会从缺的那一章写起并覆盖后面的章，所以现在不能接手：先补上缺的章，或者把后面的章移走。
        </Notice>
      )}
      {d.agentsOver && <Notice tone="warn">按建议篇幅渲染出的 AGENTS.md 有 {fmtBytes(d.agentsBytes)}，超过上限，接手会被拒绝。请先精简全局、题材或本书指令。</Notice>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="篇幅">
          <Select value={length} onChange={(e) => setLength(e.target.value as V3Length)} aria-label="篇幅">
            {V3_LENGTHS.map((l) => (
              <option key={l} value={l}>
                {V3_LENGTH_LABEL[l]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="全书目标字数（下限）">
          <Input type="number" min={1} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="目标字数" />
        </Field>
        <Field label="每批章数" hint="1–8">
          <Input type="number" min={1} max={8} value={batch} onChange={(e) => setBatch(e.target.value)} />
        </Field>
        <Field label="每章不少于（字）">
          <Input type="number" min={1} value={min} onChange={(e) => setMin(e.target.value)} />
        </Field>
      </div>
      {planned !== null && remaining !== null && (
        <p className="text-xs text-sub">
          折合计划共 {planned} 章，还要写约 {remaining} 章。
        </p>
      )}
      {closingSoon && <Notice tone="warn">按这个目标，接手后的第一批就进入收尾阶段（短篇每一批都是结局批），很快会写完全书。想多写一些就调高目标字数。</Notice>}
      <Toggle checked={start} onChange={setStart} label="接手后马上开始写" hint="关闭则接手后先暂停" />
      <div className="flex justify-end">
        <Button variant="primary" disabled={!ok} busy={go.isPending} onClick={() => go.mutate()}>
          接手
        </Button>
      </div>
    </div>
  );
}

function LegacyChapters({ slug }: { slug: string }) {
  const q = usePaged<ChapterRow>(`/api/admin/books/${enc(slug)}/chapters`, 500);
  const groups = useMemo(() => groupByVolume(q.items), [q.items]);
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  if (q.isLoading) return <Loading />;
  if (q.items.length === 0) return <Empty>没有章节。</Empty>;
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <Card key={`${g.key}-${g.chapters[0]?.no ?? 0}`} title={g.heading} padded={false}>
          <ul className="divide-y divide-line">
            {g.chapters.map((c) => (
              <li key={c.no} className="px-4 py-2 flex items-baseline justify-between gap-2 text-sm">
                <Link to="/admin/books/$slug/chapters/$no" params={{ slug, no: String(c.no) }} className="text-accent hover:underline truncate">
                  第 {c.no} 章 {c.title}
                </Link>
                <span className="text-xs text-sub tabular-nums shrink-0">
                  {c.cjk.toLocaleString('zh-CN')} 字 · {c.publishedAt ? `发布于 ${fmtRel(c.publishedAt)}` : '未发布'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <LoadMore hasNext={Boolean(q.hasNextPage)} busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
    </div>
  );
}

export function LegacyBookPage({ book: b }: { book: BookOverview }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [takeover, setTakeover] = useState(false);
  const [busy, setBusy] = useState(false);
  const exportBase = `/api/reader/books/${enc(b.slug)}`;

  async function remove() {
    const ok = await confirmDialog({ title: `删除《${b.title}》？`, body: b.dirMissing ? '书目录已经不在了，只删数据库里的记录。' : '书目录会移到回收站（数据目录下的 trash/books/），数据库里的记录删除。', danger: true, okText: '移到回收站' });
    if (!ok) return;
    setBusy(true);
    try {
      await del(`/api/admin/books/${enc(b.slug)}?confirm=${enc(b.slug)}`);
      toast('已删除', 'ok');
      await invalidate('/api/admin/books');
      void navigate({ to: '/admin' });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-2 mb-3">
        <h1 className="text-xl font-semibold font-serif">{b.title}</h1>
        <Badge>旧书（只读）</Badge>
        <Badge tone={BOOK_STATUS[b.status]?.tone}>{BOOK_STATUS[b.status]?.label ?? b.status}</Badge>
        <span className="text-xs text-sub">
          {b.genre} · {b.frontiers.accepted} 章 · {fmtCjk(b.totalCjk)} · 已发布 {b.frontiers.published}
        </span>
      </div>
      {b.dirMissing ? (
        <Notice tone="warn">书目录不存在：这里只剩数据库里的记录，能做的只有删除。</Notice>
      ) : (
        <p className="text-sm text-sub mb-3">这本书是导入的或旧流程写的：可以读、导出、直接改正文；想续写就接手，接手后改用新流程。</p>
      )}
      <div className="flex flex-wrap gap-2 my-3">
        {!b.dirMissing && (
          <>
            <Button variant="primary" onClick={() => setTakeover(true)}>
              接手续写
            </Button>
            <a className="text-sm px-3 py-1.5 rounded-md border border-line hover:bg-panel2" href={`${exportBase}/export.txt?scope=accepted`}>
              导出 TXT
            </a>
            <a className="text-sm px-3 py-1.5 rounded-md border border-line hover:bg-panel2" href={`${exportBase}/export.epub?scope=accepted`}>
              导出 EPUB
            </a>
          </>
        )}
        <Button variant="danger" busy={busy} onClick={() => void remove()}>
          删除
        </Button>
      </div>
      {!b.dirMissing && <LegacyChapters slug={b.slug} />}
      {takeover && <TakeoverModal slug={b.slug} onClose={() => setTakeover(false)} />}
    </>
  );
}
