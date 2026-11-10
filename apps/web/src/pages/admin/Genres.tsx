/** 题材包：列表 + 指令工作台（yaml/markdown）。Owner: lane H。 */
import { useState } from 'react';
import type { GenreSummary } from '@novelist/shared';
import { del, enc, post } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { InstructionWorkbench } from '../../components/admin/InstructionWorkbench';
import { Badge, Button, Card, confirmDialog, cx, Field, Input, Modal, Page, PageHeader, Q, Select } from '../../components/ui';
import { toast } from '../../components/toast';

export function GenresPage() {
  const q = useApi<GenreSummary[]>('/api/admin/genres');
  const [picked, setPicked] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string; name: string; copyFrom: string } | null>(null);
  const create = useAction((f: { id: string; name: string; copyFrom: string }) => post<GenreSummary>('/api/admin/genres', { id: f.id, name: f.name, copyFrom: f.copyFrom || undefined }), { ok: '已创建', invalidate: ['/api/admin/genres'], onDone: (g) => { setForm(null); setPicked(g.id); } });
  const remove = useAction((id: string) => del(`/api/admin/genres/${enc(id)}`), { ok: '已删除', invalidate: ['/api/admin/genres'], onDone: () => setPicked(null) });
  const visibility = useAction((a: { id: string; hidden: boolean }) => post<GenreSummary>(`/api/admin/genres/${enc(a.id)}/visibility`, { hidden: a.hidden }), { invalidate: ['/api/admin/genres'], onDone: (g) => toast(g.hidden ? '已停用' : '已恢复', 'ok') });
  const current = q.data?.find((g) => g.id === (picked ?? q.data?.[0]?.id));
  const idOk = form ? /^[a-z0-9][a-z0-9-]*$/.test(form.id) : false;
  // 没有书在用、也没有包继承 → 可以删除（内置包也可以）；否则只能停用
  const extendedBy = current ? (q.data ?? []).filter((g) => g.extends.includes(current.id)) : [];
  const deletable = !!current && current.books === 0 && extendedBy.length === 0;
  const keepReason = current && !deletable ? [current.books > 0 ? `${current.books} 本书在用` : '', extendedBy.length > 0 ? `被 ${extendedBy.map((g) => g.name).join('、')} 继承` : ''].filter(Boolean).join('，') : '';

  async function onDelete(g: GenreSummary) {
    const ok = await confirmDialog({ title: `删除题材包 ${g.name}？`, body: g.builtin ? '内置包删除后不会自动恢复。' : undefined, danger: true, okText: '删除' });
    if (ok) remove.mutate(g.id);
  }

  async function onHide(g: GenreSummary) {
    const ok = await confirmDialog({ title: `停用题材包 ${g.name}？`, body: `停用后不再出现在开书页和自动开书里；已有的 ${g.books} 本书照常使用，文件保留。要彻底删除，需要先没有书在用。`, okText: '停用' });
    if (ok) visibility.mutate({ id: g.id, hidden: true });
  }

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
                  {g.hidden && <span className="ml-1 text-xs text-faint">已停用</span>}
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
                      {current.hidden && <Badge tone="warn">已停用</Badge>}
                    </span>
                  }
                  actions={
                    <>
                      {current.hidden ? (
                        <Button size="sm" busy={visibility.isPending} onClick={() => visibility.mutate({ id: current.id, hidden: false })}>
                          恢复
                        </Button>
                      ) : (
                        !deletable && (
                          <Button size="sm" busy={visibility.isPending} onClick={() => void onHide(current)}>
                            停用
                          </Button>
                        )
                      )}
                      {deletable && (
                        <Button size="sm" variant="danger" busy={remove.isPending} onClick={() => void onDelete(current)}>
                          删除
                        </Button>
                      )}
                    </>
                  }
                >
                  <p className="text-sm text-sub">{current.description || '（无描述）'}</p>
                  <p className="text-xs text-faint mt-1">
                    {current.books} 本书在用{current.extends.length > 0 && ` · 继承 ${current.extends.join('、')}`}
                  </p>
                  {keepReason && <p className="text-xs text-faint mt-1">不能删除：{keepReason}；可以停用（不再出现在开书页和自动开书里）。</p>}
                  {current.hidden && <p className="text-xs text-faint mt-1">已停用：不出现在开书页和自动开书里，已有的书照常使用。</p>}
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
