/** 章节详情：正文、草稿、卡片、delta、评审、gate、债务、run 与章节操作。Owner: lane H。 */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { BookOverview, ChapterAdminDetail, ImpactEstimate, Ok, PublishOverview, RepoFile } from '@novelist/shared';
import { ChapterActionModal } from './V3Book';
import { enc, get, post, put, qs } from '../../../api/client';
import { useApi, useInvalidate } from '../../../api/hooks';
import { CodeEditor } from '../../../components/CodeEditor';
import { RepoFilePane } from '../../../components/admin/RepoBrowser';
import { saveErrorText, saveWithImpact } from '../../../components/admin/saveFlow';
import { RunTable } from '../../../components/admin/shared';
import { Badge, Button, Card, confirmDialog, Empty, Field, Modal, Page, PageHeader, Pre, Q, Tabs, Textarea } from '../../../components/ui';
import { toast } from '../../../components/toast';
import { fmtTime } from '../../../lib/format';
import { CHAPTER_STATE, GATE_SOURCE } from '../../../lib/labels';
import { PublishNowButton } from '../Schedule';
import { ReviewView } from './ReviewView';

type Sub = 'text' | 'draft' | 'card' | 'delta' | 'review' | 'gates' | 'debts' | 'runs';
const ACTIONS: { id: string; label: string; note?: boolean; danger?: boolean }[] = [
  { id: 'rewrite', label: '重写', note: true, danger: true },
  { id: 'repair', label: '修复' },
  { id: 'reextract', label: '重新抽取' },
  { id: 'approve', label: '批准' },
  { id: 'hold', label: '暂扣' },
  { id: 'unhold', label: '解除暂扣' },
];

/** 发布按钮必须拿真实的发布前沿：发布到第 N 章会连带发布前面所有未发布章节 */
export function ChapterPublishNow({ slug, no }: { slug: string; no: number }) {
  const pub = useApi<PublishOverview>(`/api/admin/books/${enc(slug)}/publish`);
  if (!pub.data || no <= pub.data.frontiers.published) return null;
  return <PublishNowButton slug={slug} published={pub.data.frontiers.published} defaultThrough={no} />;
}

export function ChapterDetailPage({ slug, no }: { slug: string; no: number }) {
  const base = `/api/admin/books/${enc(slug)}`;
  const path = `${base}/chapters/${no}`;
  const q = useApi<ChapterAdminDetail>(path);
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [sub, setSub] = useState<Sub>('text');
  const [pending, setPending] = useState<(typeof ACTIONS)[number] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const book = useApi<BookOverview>(base);
  const v3 = book.data?.config.flow === 'v3';
  const v3Finished = book.data?.status === 'completed' || book.data?.status === 'archived';
  const [v3Act, setV3Act] = useState<{ kind: 'rewrite' | 'rewrite_from'; no: number } | null>(null);

  async function run(a: (typeof ACTIONS)[number], n?: string) {
    setBusy(true);
    try {
      const r = await saveWithImpact<Ok>((confirm) => post<Ok | ImpactEstimate>(`${path}/actions`, { action: a.id, note: n || undefined, confirm }));
      if (r) {
        toast('已提交', 'ok');
        setPending(null);
        await invalidate(base, '/api/admin/tasks');
      }
    } catch (e) {
      const text = saveErrorText(e);
      // 已发布章节：确认后带 confirm 重发
      if (text.includes('freeze_on_publish') && (await confirmDialog({ title: '修改已发布章节？', body: text, danger: true, okText: '仍要修改' }))) {
        try {
          await post<Ok>(`${path}/actions`, { action: a.id, note: n || undefined, confirm: true });
          toast('已提交', 'ok');
          setPending(null);
          await invalidate(base, '/api/admin/tasks');
        } catch (err) {
          toast(saveErrorText(err), 'danger');
        }
      } else toast(text, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page wide>
      <Q q={q}>
        {(c) => (
          <>
            <PageHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  第 {c.no} 章 {c.title}
                  <Badge tone={CHAPTER_STATE[c.state]?.tone}>{CHAPTER_STATE[c.state]?.label ?? c.state}</Badge>
                  {c.degraded && <Badge tone="warn">降级</Badge>}
                </span>
              }
              sub={
                <>
                  <Link to="/admin/books/$slug/$tab" params={{ slug, tab: 'chapters' }} className="hover:underline">
                    {slug}
                  </Link>{' '}
                  · {c.volume} / {c.arc} · {c.cjk.toLocaleString('zh-CN')} 字 · {c.publishedAt ? `发布于 ${fmtTime(c.publishedAt)}` : c.acceptedAt ? `验收于 ${fmtTime(c.acceptedAt)}` : '未验收'}
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
            {v3 ? (
              <div className="flex flex-wrap gap-2 mb-4">
                {/* 新流程：只有直接改（正文页的“手动修改”）、带意见重写、从这里起重写；后两项只对未发布章节 */}
                {c.publishedAt === null && !v3Finished && (
                  <Button size="sm" onClick={() => setV3Act({ kind: 'rewrite', no: c.no })}>
                    带意见重写
                  </Button>
                )}
                {c.publishedAt === null && book.data?.status !== 'archived' && (
                  <Button size="sm" variant="danger" onClick={() => setV3Act({ kind: 'rewrite_from', no: c.no })}>
                    从这里起重写
                  </Button>
                )}
                {c.publishedAt !== null && <span className="text-xs text-sub self-center">已发布的章节只能直接改这一章。</span>}
                <ChapterPublishNow slug={slug} no={no} />
              </div>
            ) : (
            <div className="flex flex-wrap gap-2 mb-4">
              {ACTIONS.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant={a.danger ? 'danger' : 'default'}
                  onClick={() => {
                    if (a.note) {
                      setNote('');
                      setPending(a);
                    } else void run(a);
                  }}
                >
                  {a.label}
                </Button>
              ))}
              <ChapterPublishNow slug={slug} no={no} />
            </div>
            )}
            <Tabs
              value={sub}
              onChange={setSub}
              tabs={[
                { id: 'text', label: '正文' },
                { id: 'draft', label: '草稿' },
                { id: 'card', label: '卡片' },
                { id: 'delta', label: 'Delta' },
                { id: 'review', label: '评审' },
                { id: 'gates', label: `Gate（${c.gates.length}）` },
                { id: 'debts', label: `债务（${c.debtsList.length}）` },
                { id: 'runs', label: `Run（${c.runs.length}）` },
              ]}
            />
            {sub === 'text' && <TextPane key={c.no} chapter={c} base={base} />}
            {sub === 'draft' && (c.draft ? <Pre className="max-h-[75vh] !text-sm !font-serif !leading-7">{c.draft}</Pre> : <Empty>当前没有草稿。</Empty>)}
            {sub === 'card' && (c.card ? <RepoFilePane slug={slug} path={`plan/cards/${c.id}.yaml`} height="60vh" /> : <Empty>这一章还没有卡片。</Empty>)}
            {sub === 'delta' && (c.delta ? <Pre className="max-h-[75vh]">{JSON.stringify(c.delta, null, 2)}</Pre> : <Empty>还没有 delta。</Empty>)}
            {sub === 'review' && <Card>{c.review ? <ReviewView review={c.review} /> : <Empty>还没有评审。</Empty>}</Card>}
            {sub === 'gates' && (
              <Card padded={false}>
                {c.gates.length === 0 ? (
                  <Empty>没有 gate 结果。</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>规则</th>
                          <th>结果</th>
                          <th>来源</th>
                          <th>详情</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.gates.map((g) => (
                          <tr key={g.rule}>
                            <td>
                              <code className="text-xs">{g.rule}</code>
                            </td>
                            <td>
                              <Badge tone={g.ok ? 'ok' : g.level === 'hard' ? 'danger' : 'warn'}>{g.ok ? '通过' : `未过（${g.level}）`}</Badge>
                            </td>
                            <td className={GATE_SOURCE[g.source]?.cls}>{GATE_SOURCE[g.source]?.label ?? g.source}</td>
                            <td className="text-xs text-sub">{g.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}
            {sub === 'debts' && (
              <Card>
                {c.debtsList.length === 0 ? (
                  <Empty>没有债务。</Empty>
                ) : (
                  <ul className="space-y-2">
                    {c.debtsList.map((d) => (
                      <li key={d.id} className="text-sm">
                        <Badge tone={d.status === 'open' ? 'warn' : 'ok'}>{d.class === 'forward' ? '前向' : '指标'}</Badge> <code className="text-xs">{d.rule}</code> {d.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
            {sub === 'runs' && (
              <Card padded={false}>
                <RunTable rows={c.runs} showBook={false} />
              </Card>
            )}
          </>
        )}
      </Q>
      {v3Act && <ChapterActionModal slug={slug} act={v3Act} onClose={() => setV3Act(null)} />}
      {pending && (
        <Modal
          title={pending.label}
          onClose={() => setPending(null)}
          footer={
            <Button variant={pending.danger ? 'danger' : 'primary'} busy={busy} onClick={() => void run(pending, note)}>
              确认
            </Button>
          }
        >
          <Field label="笔记（可选）" hint="进入最高优先级层 L3.9，交给下一次写作参考">
            <Textarea rows={5} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </Page>
  );
}

function TextPane({ chapter: c, base }: { chapter: ChapterAdminDetail; base: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidate();
  const path = `${base}/chapters/${c.no}`;

  async function save() {
    if (draft === null) return;
    setBusy(true);
    try {
      const file = await get<RepoFile>(`${base}/file${qs({ path: `manuscript/${c.id}.md` })}`);
      const r = await saveWithImpact<ChapterAdminDetail>((confirm) => put<ChapterAdminDetail | ImpactEstimate>(`${path}/text`, { text: draft, baseSha: file.sha, confirm }));
      if (r) {
        toast('已保存，后续章节会按影响重新校验', 'ok');
        setDraft(null);
        await invalidate(base);
      }
    } catch (e) {
      toast(saveErrorText(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (c.text === null) return <Empty>这一章还没有验收的正文。</Empty>;
  return (
    <div className="space-y-2">
      <div className="flex justify-end gap-2">
        {draft === null ? (
          <Button size="sm" onClick={() => setDraft(c.text)}>
            手动修改
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
