/** Inbox：审批 / 打回 / 附笔记，手机优先。Owner: lane H。 */
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { InboxItem } from '@novelist/shared';
import { enc, post } from '../../api/client';
import { useAction, usePaged } from '../../api/hooks';
import { Badge, Button, confirmDialog, Details, Empty, ErrorBox, Field, Loading, LoadMore, Modal, Page, PageHeader, Pre, Select, Textarea } from '../../components/ui';
import { fmtRel } from '../../lib/format';
import { INBOX_KIND } from '../../lib/labels';

type Act = InboxItem['actions'][number];

/** 内部字段不展示；questions / path 另行专门渲染 */
const SKIP_BODY = new Set(['on', 'related_task_id', 'relatedTaskId', 'dedupeKey', 'stage', 'kind', 'task', 'taskId', 'chapter', 'target', 'questions', 'path']);

interface InterviewQuestion {
  id: string;
  text: string;
  why?: string;
}

/** 笔记弹窗文案随动作变化：访谈答案 / 打回意见 / 本章笔记不是一回事 */
function noteHint(item: InboxItem, a: Act): string {
  if (a.id === 'answer') return '逐题回答，答案写入 premise 附录并交给规划师。';
  if (item.kind === 'approval') return '打回意见作为最高优先级笔记（L3.9）交给规划师，用于重做这份规划。';
  if (a.id === 'rewrite' || a.id === 'rewrite_with_note') return '重写要求作为本章的 owner 笔记进入最高优先级层（L3.9）。';
  return '作为 owner 笔记进入最高优先级层（L3.9）。';
}

function interviewNote(questions: InterviewQuestion[], answers: Record<string, string>): string {
  return questions.map((q) => `Q：${q.text}\nA：${answers[q.id]?.trim() || '（未回答）'}`).join('\n\n');
}

function bodyPreview(body: Record<string, unknown>): { text: ReactNode[]; rest: Record<string, unknown> } {
  const text: ReactNode[] = [];
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (SKIP_BODY.has(k)) continue;
    if (typeof v === 'string' && v.trim()) text.push(<p key={k} className="whitespace-pre-wrap">{v}</p>);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) text.push(<ul key={k} className="list-disc pl-5">{(v as string[]).map((x) => <li key={x}>{x}</li>)}</ul>);
    else rest[k] = v;
  }
  return { text, rest };
}

function Item({ item }: { item: InboxItem }) {
  const [pending, setPending] = useState<Act | null>(null);
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = (Array.isArray(item.body.questions) ? (item.body.questions as InterviewQuestion[]) : []).filter((q) => q && typeof q.text === 'string');
  const planPath = typeof item.body.path === 'string' ? item.body.path : null;
  const act = useAction(({ action, n }: { action: string; n?: string }) => post<InboxItem>(`/api/admin/inbox/${enc(item.id)}/act`, { action, note: n || undefined }), { ok: '已处理', invalidate: ['/api/admin/inbox', '/api/admin/books', '/api/admin/tasks'], onDone: () => setPending(null) });
  const kind = INBOX_KIND[item.kind];
  const { text, rest } = bodyPreview(item.body);

  async function run(a: Act) {
    if (a.needsNote) {
      setNote('');
      setAnswers({});
      setPending(a);
    } else if (!a.danger || (await confirmDialog({ title: `确认“${a.label}”？`, body: item.title, danger: true, okText: a.label }))) act.mutate({ action: a.id });
  }

  return (
    <article className="bg-panel border border-line rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-sub">
        <Badge tone={kind?.tone}>{kind?.label ?? item.kind}</Badge>
        {item.bookSlug && (
          <Link to="/admin/books/$slug/$tab" params={{ slug: item.bookSlug, tab: 'overview' }} className="hover:underline">
            {item.bookSlug}
          </Link>
        )}
        <span>{fmtRel(item.createdAt)}</span>
        {item.timeoutAt && item.state === 'open' && <span className="text-warn">{fmtRel(item.timeoutAt)}超时</span>}
        {item.state !== 'open' && <Badge>{{ resolved: '已处理', dismissed: '已忽略', expired: '已过期', open: '' }[item.state]}</Badge>}
      </div>
      <h2 className="font-medium mt-1.5">{item.title}</h2>
      {text.length > 0 && <div className="text-sm text-sub mt-2 space-y-2">{text}</div>}
      {questions.length > 0 && (
        <ol className="list-decimal pl-5 mt-2 space-y-1 text-sm">
          {questions.map((q) => (
            <li key={q.id}>
              {q.text}
              {q.why && <span className="block text-xs text-sub">{q.why}</span>}
            </li>
          ))}
        </ol>
      )}
      {planPath && item.bookSlug && (
        <p className="text-sm mt-2">
          待审文件：
          <Link to="/admin/books/$slug/$tab" params={{ slug: item.bookSlug, tab: 'plan' }} className="text-accent hover:underline">
            {planPath}
          </Link>
        </p>
      )}
      {Object.keys(rest).length > 0 && (
        <div className="mt-2">
          <Details summary={<span className="text-xs text-sub">详细数据</span>}>
            <Pre className="max-h-72">{JSON.stringify(rest, null, 2)}</Pre>
          </Details>
        </div>
      )}
      {item.state === 'open' && item.actions.length > 0 && (
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 mt-3">
          {item.actions.map((a, i) => (
            <Button key={a.id} variant={a.danger ? 'danger' : i === 0 ? 'primary' : 'default'} busy={act.isPending} onClick={() => void run(a)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {pending && (
        <Modal
          title={pending.label}
          onClose={() => setPending(null)}
          footer={
            <Button
              variant={pending.danger ? 'danger' : 'primary'}
              busy={act.isPending}
              disabled={pending.id === 'answer' ? !questions.some((q) => answers[q.id]?.trim()) : !note.trim()}
              onClick={() => act.mutate({ action: pending.id, n: pending.id === 'answer' ? interviewNote(questions, answers) : note })}
            >
              提交
            </Button>
          }
        >
          {pending.id === 'answer' ? (
            <div className="space-y-3">
              <p className="text-xs text-sub">{noteHint(item, pending)}</p>
              {questions.map((q) => (
                <Field key={q.id} label={q.text} hint={q.why}>
                  <Textarea rows={3} value={answers[q.id] ?? ''} onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))} />
                </Field>
              ))}
            </div>
          ) : (
            <Field label="笔记" hint={noteHint(item, pending)}>
              <Textarea rows={6} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
            </Field>
          )}
        </Modal>
      )}
    </article>
  );
}

export function InboxPage() {
  const [state, setState] = useState('open');
  const q = usePaged<InboxItem>(`/api/admin/inbox?state=${state}`);
  return (
    <Page>
      <PageHeader
        title="Inbox"
        actions={
          <Select value={state} onChange={(e) => setState(e.target.value)} aria-label="状态" className="w-28">
            <option value="open">待处理</option>
            <option value="resolved">已处理</option>
            <option value="dismissed">已忽略</option>
            <option value="expired">已过期</option>
          </Select>
        }
      />
      {q.error ? (
        <ErrorBox error={q.error} retry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <Loading />
      ) : q.items.length === 0 ? (
        <Empty>{state === 'open' ? '全部处理完了。' : '没有记录。'}</Empty>
      ) : (
        <div className="space-y-3">
          {q.items.map((i) => (
            <Item key={i.id} item={i} />
          ))}
          <LoadMore hasNext={Boolean(q.hasNextPage)} busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
        </div>
      )}
    </Page>
  );
}
