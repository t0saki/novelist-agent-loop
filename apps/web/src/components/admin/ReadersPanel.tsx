/** 读者账号：每人一个密码，可限制可见书目（系统页的一节）。 */
import { useState } from 'react';
import type { BookSummary, ReaderAccount } from '@novelist/shared';
import { del, enc, patch, post } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { Badge, Button, Card, confirmDialog, Empty, Field, Input, Modal, Q, Toggle } from '../ui';
import { fmtRel } from '../../lib/format';

const key = '/api/admin/readers';

interface Draft {
  id: string | null;
  label: string;
  password: string;
  limit: boolean;
  allowBooks: string[];
  enabled: boolean;
}

function ReaderForm({ draft: initial, onClose }: { draft: Draft; onClose: () => void }) {
  const books = useApi<BookSummary[]>('/api/admin/books?filter=all');
  const [d, setD] = useState(initial);
  const save = useAction(
    () => {
      const allowBooks = d.limit ? d.allowBooks : null;
      if (d.id === null) return post(key, { label: d.label, password: d.password, allowBooks });
      return patch(`${key}/${enc(d.id)}`, { label: d.label, allowBooks, enabled: d.enabled, ...(d.password ? { password: d.password } : {}) });
    },
    { ok: '已保存', invalidate: [key], onDone: onClose },
  );
  const pwdShort = d.password !== '' && d.password.length < 4;
  const pwdMissing = d.id === null && d.password === '';
  return (
    <Modal
      title={d.id === null ? '新建读者' : `编辑 ${initial.label || '读者'}`}
      onClose={onClose}
      footer={
        <Button variant="primary" busy={save.isPending} disabled={pwdShort || pwdMissing} onClick={() => save.mutate()}>
          保存
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="名称">
          <Input value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} autoFocus />
        </Field>
        <Field label={d.id === null ? '密码' : '新密码（留空不改）'} error={pwdShort ? '至少 4 位' : undefined}>
          <Input type="text" autoComplete="off" value={d.password} onChange={(e) => setD({ ...d, password: e.target.value })} />
        </Field>
        {d.id !== null && <Toggle checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="启用" />}
        <Toggle checked={d.limit} onChange={(v) => setD({ ...d, limit: v })} label="只允许看指定的书" />
        {d.limit && (
          <div className="pl-6 space-y-1.5 max-h-52 overflow-y-auto">
            {books.data?.map((b) => (
              <Toggle key={b.slug} checked={d.allowBooks.includes(b.slug)} onChange={(on) => setD({ ...d, allowBooks: on ? [...d.allowBooks, b.slug] : d.allowBooks.filter((s) => s !== b.slug) })} label={b.title} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ReadersSection() {
  const q = useApi<ReaderAccount[]>(key);
  const [draft, setDraft] = useState<Draft | null>(null);
  const remove = useAction((id: string) => del(`${key}/${enc(id)}`), { ok: '已删除', invalidate: [key] });
  return (
    <div>
      <div className="flex justify-end mb-3">
        <Button variant="primary" onClick={() => setDraft({ id: null, label: '', password: '', limit: false, allowBooks: [], enabled: true })}>
          新建读者
        </Button>
      </div>
      <Card padded={false}>
        <Q q={q}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty>还没有读者。</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>可见范围</th>
                      <th>状态</th>
                      <th>最近访问</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          {r.label || '（未命名）'} {r.legacy && <Badge>v1</Badge>}
                        </td>
                        <td className="text-sub">{r.allowBooks === null ? '全部' : `${r.allowBooks.length} 本`}</td>
                        <td>{r.enabled ? <Badge tone="ok">启用</Badge> : <Badge tone="warn">停用</Badge>}</td>
                        <td className="text-sub whitespace-nowrap">{fmtRel(r.lastSeenAt)}</td>
                        <td className="whitespace-nowrap">
                          <Button size="sm" onClick={() => setDraft({ id: r.id, label: r.label, password: '', limit: r.allowBooks !== null, allowBooks: r.allowBooks ?? [], enabled: r.enabled })}>
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (await confirmDialog({ title: `删除读者 ${r.label || r.id}？`, body: '该读者的阅读进度也会失去关联。', danger: true, okText: '删除' })) remove.mutate(r.id);
                            }}
                          >
                            删除
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Q>
      </Card>
      {draft && <ReaderForm draft={draft} onClose={() => setDraft(null)} />}
    </div>
  );
}
