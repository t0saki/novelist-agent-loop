/** 待办的一项（首页顶部的待办列表用）：标题、说明、可做的操作。 */
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { InboxItem } from '@novelist/shared';
import { enc, post } from '../../api/client';
import { useAction } from '../../api/hooks';
import { Badge, Button, confirmDialog, Details, Field, Modal, Pre, Textarea } from '../ui';
import { fmtRel } from '../../lib/format';
import { inboxKind } from '../../lib/labels';

type Act = InboxItem['actions'][number];

/** 内部字段不展示 */
const SKIP_BODY = new Set(['on', 'related_task_id', 'relatedTaskId', 'dedupeKey', 'stage', 'kind', 'task', 'taskId', 'chapter', 'target', 'questions', 'path']);

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

export function InboxItemCard({ item }: { item: InboxItem }) {
  const [pending, setPending] = useState<Act | null>(null);
  const [note, setNote] = useState('');
  const act = useAction(({ action, n }: { action: string; n?: string }) => post<InboxItem>(`/api/admin/inbox/${enc(item.id)}/act`, { action, note: n || undefined }), { ok: '已处理', invalidate: ['/api/admin/inbox', '/api/admin/books', '/api/admin/tasks'], onDone: () => setPending(null) });
  const kind = inboxKind(item.kind);
  const { text, rest } = bodyPreview(item.body);

  async function run(a: Act) {
    if (a.needsNote) {
      setNote('');
      setPending(a);
    } else if (!a.danger || (await confirmDialog({ title: `确认“${a.label}”？`, body: item.title, danger: true, okText: a.label }))) act.mutate({ action: a.id });
  }

  return (
    <article className="bg-panel border border-line rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-sub">
        <Badge tone={kind.tone}>{kind.label}</Badge>
        {item.bookSlug && (
          <Link to="/admin/books/$slug/$tab" params={{ slug: item.bookSlug, tab: 'overview' }} className="hover:underline">
            {item.bookSlug}
          </Link>
        )}
        <span>{fmtRel(item.createdAt)}</span>
      </div>
      <h2 className="font-medium mt-1.5">{item.title}</h2>
      {text.length > 0 && <div className="text-sm text-sub mt-2 space-y-2">{text}</div>}
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
            <Button variant={pending.danger ? 'danger' : 'primary'} busy={act.isPending} disabled={!note.trim()} onClick={() => act.mutate({ action: pending.id, n: note })}>
              提交
            </Button>
          }
        >
          <Field label="说明">
            <Textarea rows={6} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </article>
  );
}
