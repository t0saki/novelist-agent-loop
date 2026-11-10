/** Profile（harness + 账号池 + 模型 + effort + 环境）的列表与编辑（模型与账号页的一节）。 */
import { useMemo, useState } from 'react';
import type { AccountView, HarnessStatus, Profile } from '@novelist/shared';
import { del, enc, patch, post } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { Badge, Button, Card, confirmDialog, Details, Empty, Field, Input, Modal, Q, Select, Textarea, Toggle } from '../ui';

export function ProfilesSection() {
  const q = useApi<Profile[]>('/api/admin/profiles');
  const [editing, setEditing] = useState<{ profile: Profile; isNew: boolean } | null>(null);
  const remove = useAction((id: string) => del(`/api/admin/profiles/${enc(id)}`), { ok: '已删除', invalidate: ['/api/admin/profiles'] });
  const blank: Profile = { id: '', label: '', harness: 'claude-code', model: '', accounts: [], driver: 'spawn', enabled: true, requires_ack: [], limits: {}, extra_args: [], tags: [] };
  return (
    <>
      <div className="flex justify-end mb-3">
        <Button variant="primary" onClick={() => setEditing({ profile: blank, isNew: true })}>
          新建 Profile
        </Button>
      </div>
      <Card padded={false}>
        <Q q={q}>
          {(list) =>
            list.length === 0 ? (
              <Empty>还没有 Profile。</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Harness</th>
                      <th>模型</th>
                      <th>账号池</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.id}
                          <span className="block text-xs text-faint">{p.label}</span>
                        </td>
                        <td>{p.harness}</td>
                        <td className="text-xs">
                          {p.model}
                          {p.effort && <span className="text-faint"> · {p.effort}</span>}
                          <div className="mt-0.5 flex gap-1">
                            {!p.enabled && <Badge tone="warn">已停用</Badge>}
                            {p.tags.includes('dev') && <Badge tone="info">仅测试</Badge>}
                          </div>
                        </td>
                        <td className="text-xs text-sub">{p.accounts.length ? p.accounts.join('、') : '任意已启用账号'}</td>
                        <td className="whitespace-nowrap">
                          <Button size="sm" onClick={() => setEditing({ profile: p, isNew: false })}>
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (await confirmDialog({ title: `删除 Profile ${p.id}？`, body: '写作或杂活位置正在用它时不能删除。', danger: true, okText: '删除' })) remove.mutate(p.id);
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
      {editing && <ProfileEditor initial={editing.profile} isNew={editing.isNew} onClose={() => setEditing(null)} />}
    </>
  );
}

function ProfileEditor({ initial, isNew, onClose }: { initial: Profile; isNew: boolean; onClose: () => void }) {
  const harness = useApi<HarnessStatus[]>('/api/admin/harness');
  const accounts = useApi<AccountView[]>('/api/admin/accounts');
  const [p, setP] = useState<Profile>(initial);
  const [extra, setExtra] = useState(initial.extra_args.join('\n'));
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [ack, setAck] = useState(initial.requires_ack.join(', '));
  const models = useApi<string[]>(p.harness ? `/api/admin/harness/${enc(p.harness)}/models` : null, { staleMs: 60_000 });
  const pool = useMemo(() => accounts.data?.filter((a) => a.harness === p.harness) ?? [], [accounts.data, p.harness]);
  const idOk = /^[a-z0-9][a-z0-9-]*$/.test(p.id);
  const save = useAction(
    () => {
      const splitList = (s: string) => s.split(/[,，\s]+/).filter(Boolean);
      const body = { ...p, extra_args: extra.split('\n').map((x) => x.trim()).filter(Boolean), tags: splitList(tags), requires_ack: splitList(ack) };
      if (isNew) return post('/api/admin/profiles', body);
      const { id: _id, ...rest } = body;
      return patch(`/api/admin/profiles/${enc(initial.id)}`, rest);
    },
    { ok: '已保存', invalidate: ['/api/admin/profiles', '/api/admin/routing'], onDone: onClose },
  );
  const limitField = (k: keyof Profile['limits'], label: string, scale = 1) => (
    <Field label={label}>
      <Input type="number" min={0} value={p.limits[k] === undefined ? '' : (p.limits[k] as number) / scale} onChange={(e) => setP({ ...p, limits: { ...p.limits, [k]: e.target.value === '' ? undefined : Number(e.target.value) * scale } })} />
    </Field>
  );
  return (
    <Modal
      wide
      title={isNew ? '新建 Profile' : `编辑 ${initial.id}`}
      onClose={onClose}
      footer={
        <Button variant="primary" busy={save.isPending} disabled={!idOk || !p.model.trim()} onClick={() => save.mutate()}>
          保存
        </Button>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="ID">
          <Input value={p.id} disabled={!isNew} onChange={(e) => setP({ ...p, id: e.target.value })} />
        </Field>
        <Field label="名称">
          <Input value={p.label} onChange={(e) => setP({ ...p, label: e.target.value })} />
        </Field>
        <Field label="Harness">
          <Select value={p.harness} onChange={(e) => setP({ ...p, harness: e.target.value as Profile['harness'], accounts: [] })}>
            {harness.data?.map((h) => (
              <option key={h.id} value={h.id}>
                {h.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="模型" hint={models.isLoading ? '正在读取模型列表…' : models.error ? '读取模型列表失败，可手动填写' : '可从列表选，也可手填（自建网关的模型名）'}>
          <Input list="profile-models" value={p.model} onChange={(e) => setP({ ...p, model: e.target.value })} />
          <datalist id="profile-models">
            {models.data?.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Effort">
          <Input value={p.effort ?? ''} placeholder="low / medium / high" onChange={(e) => setP({ ...p, effort: e.target.value || undefined })} />
        </Field>
        <div className="flex items-end pb-1.5">
          <Toggle checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} label="启用" />
        </div>
      </div>
      <div className="mt-3">
        <div className="text-xs text-sub mb-1">账号池（不选 = 该 harness 任意已启用账号）</div>
        {pool.length === 0 ? (
          <p className="text-xs text-faint">这个 harness 还没有账号。</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {pool.map((a) => (
              <Toggle key={a.id} checked={p.accounts.includes(a.id)} onChange={(on) => setP({ ...p, accounts: on ? [...p.accounts, a.id] : p.accounts.filter((x) => x !== a.id) })} label={a.label || a.id} />
            ))}
          </div>
        )}
      </div>
      <div className="mt-4">
        <Details summary={<span className="text-xs text-sub">高级</span>}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {limitField('wallMs', '总时限（分钟）', 60_000)}
            {limitField('idleMs', '空闲时限（分钟）', 60_000)}
            {limitField('maxTurns', '最大轮数')}
            {limitField('maxBudgetUsd', '单次预算（美元）')}
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <Field label="额外参数（每行一个）">
              <Textarea rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} />
            </Field>
            <div className="space-y-3">
              <Field label="标签">
                <Input value={tags} onChange={(e) => setTags(e.target.value)} />
              </Field>
              <Field label="需确认的风险条款">
                <Input value={ack} onChange={(e) => setAck(e.target.value)} />
              </Field>
            </div>
          </div>
        </Details>
      </div>
    </Modal>
  );
}
