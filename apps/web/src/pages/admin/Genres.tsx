/** 题材包：列表 + 指令工作台（yaml/markdown）。Owner: lane H。 */
import { useState } from 'react';
import type { GenreSummary } from '@novelist/shared';
import { del, enc, post } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { InstructionWorkbench } from '../../components/admin/InstructionWorkbench';
import { Badge, Button, Card, confirmDialog, cx, Field, Input, Modal, Page, PageHeader, Q, Select } from '../../components/ui';

export function GenresPage() {
  const q = useApi<GenreSummary[]>('/api/admin/genres');
  const [picked, setPicked] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string; name: string; copyFrom: string } | null>(null);
  const create = useAction((f: { id: string; name: string; copyFrom: string }) => post<GenreSummary>('/api/admin/genres', { id: f.id, name: f.name, copyFrom: f.copyFrom || undefined }), { ok: '已创建', invalidate: ['/api/admin/genres'], onDone: (g) => { setForm(null); setPicked(g.id); } });
  const remove = useAction((id: string) => del(`/api/admin/genres/${enc(id)}`), { ok: '已删除', invalidate: ['/api/admin/genres'], onDone: () => setPicked(null) });
  const current = q.data?.find((g) => g.id === (picked ?? q.data?.[0]?.id));
  const idOk = form ? /^[a-z0-9][a-z0-9-]*$/.test(form.id) : false;

  return (
    <Page wide>
      <PageHeader title="题材包" sub="题材层的指令、节奏、词表和 gate。" actions={<Button variant="primary" onClick={() => setForm({ id: '', name: '', copyFrom: '' })}>新建题材包</Button>} />
      <Q q={q}>
        {(list) => (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {list.map((g) => (
                <button key={g.id} type="button" onClick={() => setPicked(g.id)} className={cx('text-sm border rounded-md px-3 py-1.5', current?.id === g.id ? 'border-accent bg-accent/10' : 'border-line bg-panel hover:bg-panel2')}>
                  {g.name}
                </button>
              ))}
            </div>
            {current && (
              <>
                <Card
                  title={
                    <span className="flex items-center gap-2">
                      {current.name} <code className="text-xs text-faint">{current.id}</code>
                      {current.builtin && <Badge>内置</Badge>}
                    </span>
                  }
                  actions={
                    !current.builtin && current.books === 0 ? (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (await confirmDialog({ title: `删除题材包 ${current.name}？`, danger: true, okText: '删除' })) remove.mutate(current.id);
                        }}
                      >
                        删除
                      </Button>
                    ) : undefined
                  }
                >
                  <p className="text-sm text-sub">{current.description || '（无描述）'}</p>
                  <p className="text-xs text-faint mt-1">
                    {current.books} 本书在用{current.extends.length > 0 && ` · 继承 ${current.extends.join('、')}`}
                  </p>
                </Card>
                <InstructionWorkbench key={current.id} scope={`genre:${current.id}`} genre={current.id} />
              </>
            )}
          </div>
        )}
      </Q>
      {form && (
        <Modal
          title="新建题材包"
          onClose={() => setForm(null)}
          footer={
            <Button variant="primary" busy={create.isPending} disabled={!idOk || !form.name.trim()} onClick={() => create.mutate(form)}>
              创建
            </Button>
          }
        >
          <div className="space-y-3">
            <Field label="ID" hint="小写字母、数字、连字符" error={form.id && !idOk ? '格式不正确' : undefined}>
              <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} autoFocus />
            </Field>
            <Field label="名称">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="复制自">
              <Select value={form.copyFrom} onChange={(e) => setForm({ ...form, copyFrom: e.target.value })}>
                <option value="">空白</option>
                {q.data?.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Modal>
      )}
    </Page>
  );
}
