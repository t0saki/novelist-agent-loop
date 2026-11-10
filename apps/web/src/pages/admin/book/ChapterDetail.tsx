/**
 * 章节页（docs/v3/DESIGN.md §9）：读、直接改（改过即锁定，作者不能再覆盖）、带意见重写、从这里起重写后续、立即发布。
 * 后两项只对未发布章节开放；已发布的只能直接改这一章。旧书只能读和直接改。
 */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { BookOverview, ChapterAdminDetail, ImpactEstimate, RepoFile } from '@novelist/shared';
import { ChapterActionModal } from './V3Book';
import { enc, get, post, put, qs } from '../../../api/client';
import { useAction, useApi, useInvalidate } from '../../../api/hooks';
import { CodeEditor } from '../../../components/CodeEditor';
import { saveErrorText, saveWithImpact } from '../../../components/admin/saveFlow';
import { RunTable } from '../../../components/admin/shared';
import { Badge, Button, Card, Empty, Field, Input, Modal, Page, PageHeader, Q, Tabs } from '../../../components/ui';
import { toast } from '../../../components/toast';
import { fmtTime } from '../../../lib/format';

type Sub = 'text' | 'runs';

/** 立即发布到第 N 章：会连带发布前面所有还没发布的章节 */
export function PublishNowButton({ slug, published, defaultThrough }: { slug: string; published: number; defaultThrough?: number }) {
  const [open, setOpen] = useState(false);
  const [through, setThrough] = useState(defaultThrough ?? published + 1);
  const act = useAction(() => post(`/api/admin/books/${enc(slug)}/publish/now`, { through }), { ok: '已加入发布队列', invalidate: [`/api/admin/books/${enc(slug)}`, '/api/admin/books'], onDone: () => setOpen(false) });
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        立即发布
      </Button>
      {open && (
        <Modal
          title="立即发布"
          onClose={() => setOpen(false)}
          footer={
            <Button variant="primary" busy={act.isPending} onClick={() => act.mutate()}>
              发布
            </Button>
          }
        >
          <div className="space-y-3">
            <Field label="发布到第几章" hint={`当前已发布到第 ${published} 章`}>
              <Input type="number" min={published + 1} value={through} onChange={(e) => setThrough(Number(e.target.value) || published + 1)} />
            </Field>
            <p className="text-sm text-sub">{through > published + 1 ? `将发布第 ${published + 1}–${through} 章，共 ${through - published} 章。` : `将发布第 ${through} 章。`}</p>
          </div>
        </Modal>
      )}
    </>
  );
}

/** 发布按钮要拿真实的发布前沿（书概览里的 frontiers.published） */
export function ChapterPublishNow({ slug, no }: { slug: string; no: number }) {
  const book = useApi<Pick<BookOverview, 'frontiers'>>(`/api/admin/books/${enc(slug)}`);
  if (!book.data || no <= book.data.frontiers.published) return null;
  return <PublishNowButton slug={slug} published={book.data.frontiers.published} defaultThrough={no} />;
}

export function ChapterDetailPage({ slug, no }: { slug: string; no: number }) {
  const base = `/api/admin/books/${enc(slug)}`;
  const q = useApi<ChapterAdminDetail>(`${base}/chapters/${no}`);
  const book = useApi<BookOverview>(base);
  const navigate = useNavigate();
  const [sub, setSub] = useState<Sub>('text');
  const [act, setAct] = useState<{ kind: 'rewrite' | 'rewrite_from'; no: number } | null>(null);
  const legacy = book.data?.legacy ?? false;
  const finished = book.data?.status === 'completed' || book.data?.status === 'archived';

  return (
    <Page wide>
      <Q q={q}>
        {(c) => (
          <>
            <PageHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  第 {c.no} 章 {c.title}
                  {c.locked && <Badge tone="info">已锁定</Badge>}
                  {legacy && <Badge>旧书</Badge>}
                </span>
              }
              sub={
                <>
                  <Link to="/admin/books/$slug/$tab" params={{ slug, tab: legacy ? 'overview' : 'chapters' }} className="hover:underline">
                    {book.data?.title ?? slug}
                  </Link>
                  {c.volume ? ` · ${c.volumeTitle || c.volume}` : ''} · {c.cjk.toLocaleString('zh-CN')} 字 · {c.publishedAt ? `发布于 ${fmtTime(c.publishedAt)}` : c.acceptedAt ? `入库于 ${fmtTime(c.acceptedAt)}` : '未入库'}
                </>
              }
              actions={
                <>
                  <Button size="sm" disabled={no <= 1} onClick={() => void navigate({ to: '/admin/books/$slug/chapters/$no', params: { slug, no: String(no - 1) } })}>
                    上一章
                  </Button>
                  <Button size="sm" onClick={() => void navigate({ to: '/admin/books/$slug/chapters/$no', params: { slug, no: String(no + 1) } })}>
                    下一章
                  </Button>
                </>
              }
            />
            {book.data && !legacy && (
              <div className="flex flex-wrap gap-2 mb-4">
                {c.publishedAt === null && !finished && (
                  <Button size="sm" onClick={() => setAct({ kind: 'rewrite', no: c.no })}>
                    带意见重写
                  </Button>
                )}
                {c.publishedAt === null && book.data.status !== 'archived' && (
                  <Button size="sm" variant="danger" onClick={() => setAct({ kind: 'rewrite_from', no: c.no })}>
                    从这里起重写
                  </Button>
                )}
                {c.publishedAt !== null && <span className="text-xs text-sub self-center">已发布的章节只能直接改这一章。</span>}
                <ChapterPublishNow slug={slug} no={no} />
              </div>
            )}
            {legacy && <p className="text-xs text-sub mb-4">旧书只能读和直接改正文；想让作者续写，先在书页上接手。</p>}
            <Tabs
              value={sub}
              onChange={setSub}
              tabs={[
                { id: 'text', label: '正文' },
                { id: 'runs', label: `运行（${c.runs.length}）` },
              ]}
            />
            {sub === 'text' && <TextPane key={c.no} chapter={c} base={base} legacy={legacy} />}
            {sub === 'runs' && (
              <Card padded={false}>
                <RunTable rows={c.runs} showBook={false} />
              </Card>
            )}
          </>
        )}
      </Q>
      {act && <ChapterActionModal slug={slug} act={act} onClose={() => setAct(null)} />}
    </Page>
  );
}

function TextPane({ chapter: c, base, legacy }: { chapter: ChapterAdminDetail; base: string; legacy: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidate();

  async function save() {
    if (draft === null) return;
    setBusy(true);
    try {
      const file = await get<RepoFile>(`${base}/file${qs({ path: `manuscript/${c.id}.md` })}`);
      const r = await saveWithImpact<ChapterAdminDetail>((confirm) => put<ChapterAdminDetail | ImpactEstimate>(`${base}/chapters/${c.no}/text`, { text: draft, baseSha: file.sha, confirm }));
      if (r) {
        toast(legacy ? '已保存' : '已保存；这一章已锁定，作者不会再覆盖', 'ok');
        setDraft(null);
        await invalidate(base);
      }
    } catch (e) {
      toast(saveErrorText(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (c.text === null) return <Empty>这一章还没有正文（或者书目录不在）。</Empty>;
  return (
    <div className="space-y-2">
      <div className="flex justify-end gap-2">
        {draft === null ? (
          <Button size="sm" onClick={() => setDraft(c.text)}>
            直接改
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button size="sm" variant="primary" busy={busy} disabled={draft === c.text || draft.trim() === ''} onClick={() => void save()}>
              保存
            </Button>
          </>
        )}
      </div>
      {draft === null ? (
        <article className="bg-panel border border-line rounded-lg p-5 font-serif leading-8 max-h-[75vh] overflow-y-auto whitespace-pre-wrap">{c.text}</article>
      ) : (
        <CodeEditor value={draft} onChange={setDraft} lang="markdown" height="70vh" />
      )}
    </div>
  );
}
