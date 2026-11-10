/**
 * 新流程（v3）书页（docs/v3/DESIGN.md §9；p2-plan §2.10、§3.4）：概览 / 章节 / 故事资料 / 草稿 / 花费 / 指令 / 设置。
 * 数据来自 GET /api/admin/books/:slug/v3（V3BookView），主人操作走 /v3/* 和章节操作。
 */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { V3_LENGTHS, type BookOverview, type ChapterRow, type Effort, type Ok, type Profile, type V3ActionResult, type V3BookView, type V3DraftRow, type V3Settings } from '@novelist/shared';
import { enc, post, put } from '../../../api/client';
import { useAction, useApi, useInvalidate, usePaged } from '../../../api/hooks';
import { InstructionWorkbench } from '../../../components/admin/InstructionWorkbench';
import { RepoFilePane } from '../../../components/admin/RepoBrowser';
import { V3CostLine, V3StatusLine } from '../../../components/admin/V3Status';
import { Badge, Button, Card, confirmDialog, Details, Empty, ErrorBox, Field, Input, Loading, LoadMore, Modal, Notice, Q, Select, Textarea, Toggle } from '../../../components/ui';
import { toast } from '../../../components/toast';
import { fmtBytes, fmtCjk, fmtNum, fmtRel, fmtTime } from '../../../lib/format';
import { RUN_STATE, V3_DRAFT_KIND_LABEL, V3_LENGTH_LABEL, V3_REQUEST_STATUS_LABEL, V3_RUN_KIND_LABEL } from '../../../lib/labels';

export const V3_BOOK_TABS = [
  { id: 'overview', label: '概览' },
  { id: 'chapters', label: '章节' },
  { id: 'story', label: '故事资料' },
  { id: 'drafts', label: '草稿' },
  { id: 'runs', label: '花费' },
  { id: 'instructions', label: '指令' },
  { id: 'settings', label: '设置' },
] as const;

/** 与服务端 flow/owner.ts V3_FINISHED_MESSAGE / V3_ARCHIVED_MESSAGE 一致 */
const V3_FINISHED = '这本书已完结，不会再有下一次运行：请直接修改章节，或者先回退到某一批之前';
const V3_ARCHIVED = '这本书已归档，不会再有下一次运行：请直接修改章节，或者先把书恢复成在写';
const finishedText = (status: string) => (status === 'archived' ? V3_ARCHIVED : V3_FINISHED);
const finished = (status: string) => status === 'completed' || status === 'archived';
const viewPath = (slug: string) => `/api/admin/books/${enc(slug)}/v3`;

export function V3BookTabs(props: { book: BookOverview; tab: string }) {
  const q = useApi<V3BookView>(viewPath(props.book.slug), { refetchMs: 15_000 });
  const b = props.book;
  if (props.tab === 'instructions') return <InstructionWorkbench scope={`book:${b.slug}`} book={b.slug} />;
  return (
    <Q q={q}>
      {(v) => (
        <>
          {props.tab === 'overview' && <V3OverviewTab book={b} view={v} />}
          {props.tab === 'chapters' && <V3ChaptersTab book={b} view={v} />}
          {props.tab === 'story' && <V3StoryTab slug={b.slug} view={v} />}
          {props.tab === 'drafts' && <V3DraftsTab book={b} view={v} />}
          {props.tab === 'runs' && <V3RunsTab view={v} />}
          {props.tab === 'settings' && <V3SettingsTab key={JSON.stringify(v.settings)} slug={b.slug} view={v} />}
        </>
      )}
    </Q>
  );
}

/** 主人操作：成功提示服务端的那句话，刷新书页与列表 */
function useV3Action<A>(fn: (a: A) => Promise<V3ActionResult | Ok | unknown>, slug: string, onDone?: () => void) {
  const invalidate = useInvalidate();
  return useAction(fn, {
    onDone: (r) => {
      const detail = (r as { detail?: unknown } | null)?.detail;
      toast(typeof detail === 'string' ? detail : '已提交', 'ok');
      void invalidate(`/api/admin/books/${enc(slug)}`, '/api/admin/books', '/api/admin/tasks');
      onDone?.();
    },
  });
}

// ───────────────────────── 概览 ─────────────────────────

function V3OverviewTab({ book: b, view: v }: { book: BookOverview; view: V3BookView }) {
  const base = `/api/admin/books/${enc(b.slug)}`;
  const bookAct = useV3Action((action: string) => post(`${base}/actions`, { action }), b.slug);
  const rewind = useV3Action((to: number) => post<V3ActionResult>(`${base}/v3/rewind`, { to }), b.slug);
  const pending = useV3Action((action: 'retry' | 'discard') => post<V3ActionResult>(`${base}/v3/pending`, { action }), b.slug);
  const [rewindTo, setRewindTo] = useState<string>('');

  async function doRewind() {
    const to = Number(rewindTo);
    if (rewindTo === '' || Number.isNaN(to)) return;
    const ok = await confirmDialog({ title: `回退到第 ${to} 章？`, body: `第 ${to + 1} 章起的正文会移到 drafts/rewound-…/，笔记退回到那一批之前。`, danger: true, okText: '回退' });
    if (ok) rewind.mutate(to);
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[16rem] space-y-1">
            <V3StatusLine status={v.status} />
            <div className="text-xs text-sub">
              {V3_LENGTH_LABEL[v.length]} · 已写 {v.accepted} 章 {fmtCjk(v.totalCjk)} / 目标 {fmtCjk(v.settings.target_cjk)} · 计划 {v.planned} 章 · 存稿 {Math.max(0, v.accepted - v.published)} · 已发布 {v.published}
            </div>
            <V3CostLine cost={v.cost} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {b.status === 'draft' && (
              <Button variant="primary" busy={bookAct.isPending} onClick={() => bookAct.mutate('start')}>
                开始
              </Button>
            )}
            {(b.status === 'active' || b.status === 'planning') && (
              <Button busy={bookAct.isPending} onClick={() => bookAct.mutate('pause')}>
                暂停
              </Button>
            )}
            {b.status === 'paused' && (
              <Button variant="primary" busy={bookAct.isPending} onClick={() => bookAct.mutate('resume')}>
                继续
              </Button>
            )}
            {(b.status === 'active' || b.status === 'planning' || b.status === 'paused') && v.accepted > 0 && (
              <Button busy={bookAct.isPending} onClick={() => bookAct.mutate('write_now')} title="存稿满了也写这一批（只多写一批）；暂停中的书会一并恢复">
                立即写下一批
              </Button>
            )}
            {b.status === 'archived' && (
              <Button busy={bookAct.isPending} onClick={() => bookAct.mutate('resume')}>
                恢复成在写
              </Button>
            )}
            {/* 归档的书不会再写：回退后的章节也采用不回来，不给这个操作 */}
            {v.rewindPoints.length > 0 && b.status !== 'archived' && (
              <>
                <Select className="w-auto" value={rewindTo} onChange={(e) => setRewindTo(e.target.value)} aria-label="回退到">
                  <option value="">回退到…</option>
                  {v.rewindPoints.map((p) => (
                    <option key={p.to} value={p.to}>
                      {p.label}
                    </option>
                  ))}
                </Select>
                <Button variant="danger" disabled={rewindTo === ''} busy={rewind.isPending} onClick={() => void doRewind()}>
                  回退
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {v.pending?.blocked && (
        <Notice tone="danger">
          <div className="space-y-2">
            <div>
              收稿出错 {v.pending.failures} 次{v.pending.lastError ? `：${v.pending.lastError}` : ''}。重试会再收一次这次运行写好的稿；放弃会把它丢掉（稿子留在运行目录里）。
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" busy={pending.isPending} onClick={() => pending.mutate('retry')}>
                重试
              </Button>
              <Button
                size="sm"
                variant="danger"
                busy={pending.isPending}
                onClick={async () => {
                  if (await confirmDialog({ title: '放弃这次没收完的稿？', danger: true, okText: '放弃' })) pending.mutate('discard');
                }}
              >
                放弃
              </Button>
            </div>
          </div>
        </Notice>
      )}

      {v.agentsSize && (
        <Notice tone={v.agentsSize.hard ? 'danger' : 'warn'}>
          <div>
            AGENTS.md 有 {fmtNum(v.agentsSize.bytes)} 字节（{fmtRel(v.agentsSize.at)}），{v.agentsSize.hard ? `超过 ${v.agentsSize.harness} 的上限 ${fmtNum(v.agentsSize.limit)}，没有启动` : '超过 16 KB'}。请精简全局、题材或本书指令。
          </div>
          {v.agentsSize.layers.length > 0 && (
            <ul className="mt-1 text-xs tabular-nums">
              {v.agentsSize.layers.map((l) => (
                <li key={l.layer}>
                  {l.layer}：{fmtNum(l.bytes)} 字节
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      <OwnerMessageCard book={b} view={v} />

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="下一次任务单的系统提示">
          {v.hints.length === 0 ? (
            <Empty>没有。</Empty>
          ) : (
            <ol className="list-decimal pl-5 space-y-1 text-sm">
              {v.hints.map((h, i) => (
                <li key={`${h.kind}-${i}`}>{h.text}</li>
              ))}
            </ol>
          )}
        </Card>
        <Card title="改写请求">
          {v.ownerRequests.length === 0 ? (
            <Empty>没有。在章节列表里可以“带意见重写”。</Empty>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {v.ownerRequests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={V3_REQUEST_STATUS_LABEL[r.status].tone}>{V3_REQUEST_STATUS_LABEL[r.status].label}</Badge>
                  <span>第 {r.chapter} 章</span>
                  <span className="text-sub min-w-0 break-words">{r.note}</span>
                  <span className="text-xs text-faint">{fmtRel(r.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="批次" padded={false}>
        {v.batches.length === 0 ? (
          <Empty>还没有入库的批次。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>种类</th>
                  <th>章节</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {v.batches.map((x) => (
                  <tr key={`${x.from}-${x.to}-${x.at}`}>
                    <td>{BATCH_KIND[x.kind] ?? x.kind}</td>
                    <td className="tabular-nums">
                      第 {x.from}
                      {x.to !== x.from ? `–${x.to}` : ''} 章
                    </td>
                    <td className="text-xs text-sub whitespace-nowrap">{fmtTime(x.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {v.retro.enabled && (
        <div className="text-xs text-sub">
          复盘：上次复盘以来写了 {v.retro.batchesSince} 批（每 {v.retro.every} 批一次）{v.retro.lastAt ? `，上次 ${fmtTime(v.retro.lastAt)}` : ''}。
        </div>
      )}
    </div>
  );
}

const BATCH_KIND: Record<string, string> = { open: '开书', write: '写作', finale: '结局', adopt: '采用草稿' };

function readInText(r: NonNullable<V3BookView['ownerHistory'][number]['readIn']>): string {
  if (r.kind === 'open') return `已在开书时读取（${fmtTime(r.at)}）`;
  return `已在写第 ${r.from}${r.to !== r.from ? `–${r.to}` : ''} 章时读取（${fmtTime(r.at)}）`;
}

function OwnerMessageCard({ book: b, view: v }: { book: BookOverview; view: V3BookView }) {
  const [text, setText] = useState('');
  const base = `/api/admin/books/${enc(b.slug)}`;
  const save = useV3Action((t: string) => put<V3ActionResult>(`${base}/v3/message`, { text: t }), b.slug, () => setText(''));
  const done = finished(b.status);
  const latest = v.ownerHistory.find((m) => m.readIn !== null) ?? null;
  return (
    <Card title="给作者的话">
      {done ? (
        <div className="text-sm text-sub">{finishedText(b.status)}</div>
      ) : (
        <div className="space-y-2">
          <Textarea rows={4} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder="只用一次：下一次运行读到后就收起。长期有效的要求写在“指令”里。" aria-label="给作者的话" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-faint tabular-nums">{text.length} / 4000</span>
            <div className="flex-1" />
            <Button size="sm" variant="primary" disabled={text.trim() === ''} busy={save.isPending} onClick={() => save.mutate(text)}>
              保存
            </Button>
          </div>
        </div>
      )}
      <div className="mt-3 text-sm space-y-1">
        {v.ownerMessage ? (
          <div className="flex flex-wrap items-baseline gap-2">
            <Badge tone="warn">等待下一次运行读取（{fmtTime(v.ownerMessage.setAt)}）</Badge>
            <span className="text-sub whitespace-pre-wrap break-words min-w-0">{v.ownerMessage.text}</span>
            {!done && (
              <Button size="sm" variant="ghost" busy={save.isPending} onClick={() => save.mutate('')}>
                撤回
              </Button>
            )}
          </div>
        ) : latest?.readIn ? (
          <div className="flex flex-wrap items-baseline gap-2">
            <Badge tone="ok">{readInText(latest.readIn)}</Badge>
            <span className="text-sub whitespace-pre-wrap break-words min-w-0">{latest.text}</span>
          </div>
        ) : null}
        {v.ownerHistory.length > 0 && (
          <Details summary={`历史（${v.ownerHistory.length}）`}>
            <ul className="space-y-1.5 text-xs">
              {v.ownerHistory.map((m) => (
                <li key={`${m.setAt}-${m.text.slice(0, 20)}`}>
                  <span className="text-faint">{fmtTime(m.setAt)}</span> {m.readIn ? <span className="text-ok">{readInText(m.readIn)}</span> : <span className="text-faint">没有被读（已替换或撤回）</span>}
                  <div className="whitespace-pre-wrap break-words text-sub">{m.text}</div>
                  {m.archivedPath && <code className="text-faint">{m.archivedPath}</code>}
                </li>
              ))}
            </ul>
          </Details>
        )}
      </div>
    </Card>
  );
}

// ───────────────────────── 章节 ─────────────────────────

type ChapterAct = { kind: 'rewrite' | 'rewrite_from'; no: number };

function V3ChaptersTab({ book: b, view: v }: { book: BookOverview; view: V3BookView }) {
  const q = usePaged<ChapterRow>(`/api/admin/books/${enc(b.slug)}/chapters`, 200);
  const [text, setText] = useState('');
  const [act, setAct] = useState<ChapterAct | null>(null);
  const rows = useMemo(() => q.items.filter((c) => !text || c.title.includes(text) || String(c.no) === text), [q.items, text]);
  const waiting = new Set(v.ownerRequests.filter((r) => r.status === 'waiting').map((r) => r.chapter));
  const locked = new Set(v.locked);
  const done = finished(b.status);
  return (
    <Card padded={false} title={`章节（${q.items.length}）`} actions={<Input className="w-36" placeholder="章号或标题" value={text} onChange={(e) => setText(e.target.value)} aria-label="搜索章节" />}>
      {q.error ? (
        <ErrorBox error={q.error} retry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>还没有章节。</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>章</th>
                <th>标题</th>
                <th className="text-right">字数</th>
                <th>发布</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const published = c.publishedAt !== null;
                return (
                  <tr key={c.no}>
                    <td className="tabular-nums text-sub">{c.no}</td>
                    <td>
                      <span className="inline-flex flex-wrap items-center gap-1">
                        <Link to="/admin/books/$slug/chapters/$no" params={{ slug: b.slug, no: String(c.no) }} className="text-accent hover:underline">
                          {c.title || `第 ${c.no} 章`}
                        </Link>
                        {locked.has(c.no) && <Badge tone="info">已锁定</Badge>}
                        {waiting.has(c.no) && <Badge tone="warn">等改写</Badge>}
                      </span>
                    </td>
                    <td className="text-right tabular-nums text-sub">{c.cjk.toLocaleString('zh-CN')}</td>
                    <td className="text-xs text-sub whitespace-nowrap">{published ? fmtRel(c.publishedAt) : '—'}</td>
                    <td>
                      <span className="inline-flex flex-wrap gap-1">
                        <Link to="/admin/books/$slug/chapters/$no" params={{ slug: b.slug, no: String(c.no) }} className="text-xs px-2 py-1 rounded border border-line hover:bg-panel2">
                          直接改
                        </Link>
                        {!published && !done && (
                          <Button size="sm" onClick={() => setAct({ kind: 'rewrite', no: c.no })}>
                            带意见重写
                          </Button>
                        )}
                        {!published && b.status !== 'archived' && (
                          <Button size="sm" variant="danger" onClick={() => setAct({ kind: 'rewrite_from', no: c.no })}>
                            从这里起重写
                          </Button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <LoadMore hasNext={Boolean(q.hasNextPage)} busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
      {act && <ChapterActionModal slug={b.slug} act={act} onClose={() => setAct(null)} />}
    </Card>
  );
}

/** 带意见重写 / 从这里起重写：意见写进下一次任务单；后者先确认回退 */
export function ChapterActionModal({ slug, act, onClose }: { slug: string; act: ChapterAct; onClose: () => void }) {
  const [note, setNote] = useState('');
  const run = useV3Action((body: { action: string; note: string }) => post<Ok>(`/api/admin/books/${enc(slug)}/chapters/${act.no}/actions`, body), slug, onClose);
  const from = act.kind === 'rewrite_from';
  async function submit() {
    if (from && !(await confirmDialog({ title: `从第 ${act.no} 章起重写？`, body: `会回退到第 ${act.no - 1} 章：第 ${act.no} 章起的正文移到 drafts/rewound-…/，下一批从第 ${act.no} 章写起。`, danger: true, okText: '回退并重写' }))) return;
    run.mutate({ action: act.kind, note });
  }
  return (
    <Modal
      title={from ? `从第 ${act.no} 章起重写` : `带意见重写第 ${act.no} 章`}
      onClose={onClose}
      footer={
        <Button variant={from ? 'danger' : 'primary'} disabled={!from && note.trim() === ''} busy={run.isPending} onClick={() => void submit()}>
          确认
        </Button>
      }
    >
      <Field label={from ? '意见（可选）' : '意见'} hint={from ? '写进下一次任务单的第一条' : '并入下一次写作的第一条，不单开运行；改写完之前这一章不发布'}>
        <Textarea rows={5} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

// ───────────────────────── 故事资料 ─────────────────────────

function V3StoryTab({ slug, view: v }: { slug: string; view: V3BookView }) {
  const [path, setPath] = useState<string | null>(v.story[0]?.path ?? null);
  return (
    <div className="grid md:grid-cols-[260px_1fr] gap-4">
      <Card padded={false}>
        {v.story.length === 0 ? (
          <Empty>还没有设定和笔记。</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {v.story.map((f) => (
              <li key={f.path}>
                <button type="button" onClick={() => setPath(f.path)} className={`w-full text-left px-3 py-2 text-sm hover:bg-panel2 ${f.path === path ? 'bg-panel2 font-medium' : ''}`}>
                  <div className="truncate">{f.path}</div>
                  <div className={`text-xs tabular-nums ${f.over ? 'text-danger' : 'text-faint'}`}>
                    {f.size.toLocaleString('zh-CN')} 字{f.budget !== null ? ` / 预算 ${f.budget.toLocaleString('zh-CN')}` : ''}
                    {f.over ? '（超了）' : ''}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="min-w-0">{path ? <RepoFilePane key={path} slug={slug} path={path} height="65vh" /> : <Empty>从左侧选择文件。</Empty>}</div>
    </div>
  );
}

// ───────────────────────── 草稿 ─────────────────────────

function V3DraftsTab({ book: b, view: v }: { book: BookOverview; view: V3BookView }) {
  const [showHandled, setShowHandled] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const base = `/api/admin/books/${enc(b.slug)}`;
  const adopt = useV3Action((path: string) => post<V3ActionResult>(`${base}/v3/drafts/adopt`, { path }), b.slug);
  const discard = useV3Action((path: string) => post<V3ActionResult>(`${base}/v3/drafts/discard`, { path }), b.slug);
  const rows = v.drafts.filter((d) => showHandled || !d.handled);
  const locked = new Set(v.locked);

  async function doAdopt(d: V3DraftRow) {
    let body: string;
    if (d.chapter !== null && d.chapter <= v.accepted) {
      body = `采用后会替换第 ${d.chapter} 章的正文（并锁定这一章），原来的版本移到 drafts/replaced/。${locked.has(d.chapter) ? `第 ${d.chapter} 章现在是你改过的版本。` : ''}`;
    } else if (d.chapter !== null) body = `采用为第 ${d.chapter} 章。`;
    else body = `采用后会恢复 ${d.target ?? d.path}，当前版本移到 drafts/replaced/。`;
    if (await confirmDialog({ title: '采用这份草稿？', body, okText: '采用' })) adopt.mutate(d.path);
  }

  return (
    <div className="space-y-4">
      <Card padded={false} title={`草稿（${rows.length}）`} actions={<Toggle checked={showHandled} onChange={setShowHandled} label="显示已处理的" />}>
        {rows.length === 0 ? (
          <Empty>没有草稿。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>种类</th>
                  <th>章</th>
                  <th className="text-right">大小</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.path}>
                    <td>
                      <button type="button" className="text-accent hover:underline text-left break-all" onClick={() => setOpen(d.path)}>
                        {d.path}
                      </button>
                    </td>
                    <td className="text-xs">{V3_DRAFT_KIND_LABEL[d.kind] ?? d.kind}</td>
                    <td className="tabular-nums text-sub">{d.chapter ?? (d.target ? <code className="text-xs">{d.target}</code> : '—')}</td>
                    <td className="text-right tabular-nums text-sub">{fmtBytes(d.size)}</td>
                    <td>
                      {!d.handled && (
                        <span className="inline-flex gap-1">
                          <span title={d.adoptable ? undefined : (d.reason ?? undefined)}>
                            <Button size="sm" variant="primary" disabled={!d.adoptable} busy={adopt.isPending} onClick={() => void doAdopt(d)}>
                              采用
                            </Button>
                          </span>
                          <Button size="sm" busy={discard.isPending} onClick={() => discard.mutate(d.path)}>
                            收起
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && (
        <Card title={open} actions={<Button size="sm" variant="ghost" onClick={() => setOpen(null)}>关闭</Button>}>
          <RepoFilePane key={open} slug={b.slug} path={open} height="55vh" />
        </Card>
      )}
    </div>
  );
}

// ───────────────────────── 花费 ─────────────────────────

function runKindLabel(r: V3BookView['runs'][number]): string {
  if (r.taskKind === 'book.write' && r.mode === 'finale') return V3_RUN_KIND_LABEL.finale ?? '结局';
  return V3_RUN_KIND_LABEL[r.taskKind] ?? r.taskKind;
}

function V3RunsTab({ view: v }: { view: V3BookView }) {
  return (
    <Card padded={false} title="花费" actions={<V3CostLine cost={v.cost} />}>
      {v.runs.length === 0 ? (
        <Empty>还没有运行。</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>种类</th>
                <th>章节</th>
                <th>开始</th>
                <th className="text-right">分钟</th>
                <th className="text-right">输出 token</th>
                <th>模型</th>
                <th className="text-right">步数</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {v.runs.map((r) => (
                <tr key={r.runId}>
                  <td>
                    <Link to="/admin/runs/$id" params={{ id: r.runId }} className="text-accent hover:underline">
                      {runKindLabel(r)}
                    </Link>
                  </td>
                  <td className="tabular-nums text-sub">{r.chapters ? `${r.chapters[0]}${r.chapters[1] !== r.chapters[0] ? `–${r.chapters[1]}` : ''}` : '—'}</td>
                  <td className="text-xs text-sub whitespace-nowrap">{fmtTime(r.startedAt)}</td>
                  <td className="text-right tabular-nums">{r.minutes ?? '—'}</td>
                  <td className="text-right tabular-nums">{fmtNum(r.outputTokens)}</td>
                  <td className="text-xs">{r.model ?? '—'}</td>
                  <td className="text-right tabular-nums">{r.toolSteps ?? '—'}</td>
                  <td>
                    <Badge tone={r.errorClass ? 'warn' : RUN_STATE[r.state]?.tone}>{r.errorClass ?? RUN_STATE[r.state]?.label ?? r.state}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ───────────────────────── 设置 ─────────────────────────

const EFFORTS: Effort[] = ['low', 'medium', 'high'];
const EFFORT_ROWS: { id: keyof V3Settings['effort']; label: string }[] = [
  { id: 'open', label: '开书' },
  { id: 'write', label: '写作' },
  { id: 'closing', label: '收尾阶段的写作' },
  { id: 'finale', label: '结局批' },
  { id: 'retro', label: '复盘' },
];

/** 预算输入：空 = 不设上限 */
const capText = (v: number | null) => (v === null ? '' : String(v));
const capValue = (s: string): number | null | undefined => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

function V3SettingsTab({ slug, view: v }: { slug: string; view: V3BookView }) {
  const [s, setS] = useState<V3Settings>(v.settings);
  const [usd, setUsd] = useState(capText(v.settings.budgets.monthly_usd_cap));
  const [util, setUtil] = useState(capText(v.settings.budgets.max_window_util_pct));
  const profiles = useApi<Profile[]>('/api/admin/profiles');
  const invalidate = useInvalidate();
  const usdV = capValue(usd);
  const utilV = capValue(util);
  const budgetErr = usdV === undefined || utilV === undefined || (utilV !== null && utilV > 100);
  const save = useAction(() => put<V3BookView>(`${viewPath(slug)}/settings`, { ...s, budgets: { ...s.budgets, monthly_usd_cap: usdV ?? null, max_window_util_pct: utilV ?? null } }), {
    ok: '已保存',
    onDone: () => void invalidate(`/api/admin/books/${enc(slug)}`, '/api/admin/books'),
  });
  const num = (x: string, fallback: number) => (x === '' || Number.isNaN(Number(x)) ? fallback : Math.floor(Number(x)));
  const bufferErr = s.publish.max_buffer < 2 * s.batch ? '存稿上限要至少是每批章数的 2 倍' : undefined;
  const pub = (p: Partial<V3Settings['publish']>) => setS({ ...s, publish: { ...s.publish, ...p } });
  const knownWriter = s.writer_profile === null || (profiles.data ?? []).some((p) => p.id === s.writer_profile);
  return (
    <div className="space-y-4">
      <Card title="篇幅与写法">
        <div className="text-xs text-sub mb-2">篇幅档：{V3_LENGTH_LABEL[v.length]}（{V3_LENGTHS.map((l) => V3_LENGTH_LABEL[l]).join(' / ')} 在开书时选定）。字数只是下限，写多了照收。</div>
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="全书目标字数（下限）" hint="改了会按新目标重算计划章数">
            <Input type="number" min={1000} value={s.target_cjk} onChange={(e) => setS({ ...s, target_cjk: Math.max(1, num(e.target.value, s.target_cjk)) })} />
          </Field>
          <Field label="每章不少于（字）">
            <Input type="number" min={100} value={s.min_chapter_cjk} onChange={(e) => setS({ ...s, min_chapter_cjk: Math.max(1, num(e.target.value, s.min_chapter_cjk)) })} />
          </Field>
          <Field label="每批章数" hint="1–8">
            <Input type="number" min={1} max={8} value={s.batch} onChange={(e) => setS({ ...s, batch: Math.min(8, Math.max(1, num(e.target.value, s.batch))) })} />
          </Field>
        </div>
      </Card>
      <Card title="模型与 effort">
        <div className="grid sm:grid-cols-2 gap-3 mb-3">
          <Field label="写作用的模型" hint="覆盖“模型与账号”页上写作位置的主用；备用照旧">
            <Select value={s.writer_profile ?? ''} aria-label="写作用的模型" onChange={(e) => setS({ ...s, writer_profile: e.target.value === '' ? null : e.target.value })}>
              <option value="">跟随写作位置</option>
              {!knownWriter && <option value={s.writer_profile as string}>{s.writer_profile}（已不存在）</option>}
              {profiles.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {p.label || p.model}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {EFFORT_ROWS.map((r) => (
            <Field key={r.id} label={r.label}>
              <Select value={s.effort[r.id]} onChange={(e) => setS({ ...s, effort: { ...s.effort, [r.id]: e.target.value as Effort } })}>
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
      </Card>
      <Card title="发布">
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="方式">
            <Select value={s.publish.mode} onChange={(e) => pub({ mode: e.target.value as V3Settings['publish']['mode'] })}>
              <option value="scheduled">按节奏</option>
              <option value="immediate">可发布就发</option>
              <option value="manual">手动</option>
            </Select>
          </Field>
          <Field label="节奏（cron）" hint="例：0 8 * * * = 每天 8 点">
            <Input value={s.publish.cadence} onChange={(e) => pub({ cadence: e.target.value })} />
          </Field>
          <Field label="时区">
            <Input value={s.publish.timezone} onChange={(e) => pub({ timezone: e.target.value })} />
          </Field>
          <Field label="每次发布章数">
            <Input type="number" min={1} value={s.publish.per_slot} onChange={(e) => pub({ per_slot: Math.max(1, num(e.target.value, s.publish.per_slot)) })} />
          </Field>
          <Field label="存稿上限" error={bufferErr}>
            <Input type="number" min={2} value={s.publish.max_buffer} onChange={(e) => pub({ max_buffer: Math.max(1, num(e.target.value, s.publish.max_buffer)) })} />
          </Field>
        </div>
      </Card>
      <Card title="预算">
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="优先级" hint="多本书抢一个账号时，数大的先写">
            <Input type="number" value={s.budgets.priority} onChange={(e) => setS({ ...s, budgets: { ...s.budgets, priority: num(e.target.value, s.budgets.priority) } })} />
          </Field>
          <Field label="每月花费上限（美元）" hint="空 = 不设上限；只算按量计费的账号" error={usdV === undefined ? '需为非负数' : undefined}>
            <Input type="number" min={0} step="any" value={usd} onChange={(e) => setUsd(e.target.value)} />
          </Field>
          <Field label="额度窗口用到多少就停（%）" hint="空 = 不设上限" error={utilV === undefined || (utilV !== null && utilV > 100) ? '0–100' : undefined}>
            <Input type="number" min={0} max={100} value={util} onChange={(e) => setUtil(e.target.value)} />
          </Field>
        </div>
      </Card>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setS(v.settings);
            setUsd(capText(v.settings.budgets.monthly_usd_cap));
            setUtil(capText(v.settings.budgets.max_window_util_pct));
          }}
        >
          还原
        </Button>
        <Button variant="primary" disabled={bufferErr !== undefined || budgetErr} busy={save.isPending} onClick={() => save.mutate()}>
          保存
        </Button>
      </div>
    </div>
  );
}
