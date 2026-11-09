/** 路由 Preset 与 Profile 编辑、可行性检查。Owner: lane H。 */
import { useMemo, useState } from 'react';
import { ROLE_IDS, ROUTABLE_ROLES, ROUTE_CONSTRAINTS, type AccountView, type ActiveRouting, type BookSummary, type FeasibilityReport, type HarnessStatus, type Profile, type QualityTier, type RoleId, type RoleRoute, type RoutingPreset } from '@novelist/shared';
import { del, enc, patch, post, put, qs } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { FeasibilityView } from '../../components/admin/shared';
import { Badge, Button, Card, confirmDialog, Details, Empty, Field, Input, Modal, Notice, Page, PageHeader, Q, Select, Tabs, Textarea, Toggle } from '../../components/ui';
import { ROLE_LABEL, TIER_INFO } from '../../lib/labels';

const CONSTRAINT_LABEL: Record<string, string> = { none: '无', vendor_ne_writer: '与主笔不同厂商', vendor_ne_planner: '与规划不同厂商', not_in_judges: '不在评委组内' };

export function RoutingPage() {
  const [tab, setTab] = useState<'presets' | 'profiles' | 'check'>('presets');
  return (
    <Page>
      <PageHeader title="路由与 Profile" sub="Profile = harness + 模型 + 账号池；Preset = 每个角色走哪条 Profile 链。" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'presets', label: '路由 Preset' },
          { id: 'profiles', label: 'Profile' },
          { id: 'check', label: '可行性检查' },
        ]}
      />
      {tab === 'presets' && <PresetsTab />}
      {tab === 'profiles' && <ProfilesTab />}
      {tab === 'check' && <CheckTab />}
    </Page>
  );
}

function PresetsTab() {
  const presets = useApi<RoutingPreset[]>('/api/admin/routing/presets');
  const active = useApi<ActiveRouting>('/api/admin/routing/active');
  const profiles = useApi<Profile[]>('/api/admin/profiles');
  const [editing, setEditing] = useState<{ preset: RoutingPreset; isNew: boolean } | null>(null);
  const activate = useAction((presetId: string) => put('/api/admin/routing/active', { presetId, overrides: active.data?.overrides ?? {} }), { ok: '已切换当前路由', invalidate: ['/api/admin/routing', '/api/admin/settings'] });
  const remove = useAction((id: string) => del(`/api/admin/routing/presets/${enc(id)}`), { ok: '已删除', invalidate: ['/api/admin/routing'] });

  return (
    <Q q={presets}>
      {(list) => (
        <div className="space-y-3">
          {list.map((p) => {
            const isActive = active.data?.presetId === p.id;
            const roles = Object.keys(p.roles).length;
            return (
              <article key={p.id} className="bg-panel border border-line rounded-lg p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{p.name}</span>
                    {p.builtin && <Badge>内置</Badge>}
                    {isActive && <Badge tone="ok">当前</Badge>}
                  </div>
                  <p className="text-xs text-sub mt-1">{p.description}</p>
                  <p className="text-xs text-faint mt-1">{roles} 个角色</p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {!isActive && (
                    <Button size="sm" onClick={() => activate.mutate(p.id)}>
                      设为当前
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setEditing({ preset: p, isNew: false })}>
                    编辑
                  </Button>
                  <Button size="sm" onClick={() => setEditing({ preset: { ...p, id: `${p.id}-copy`, name: `${p.name} 副本`, builtin: false }, isNew: true })}>
                    复制
                  </Button>
                  {!p.builtin && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (await confirmDialog({ title: `删除 Preset ${p.name}？`, danger: true, okText: '删除' })) remove.mutate(p.id);
                      }}
                    >
                      删除
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
          {editing && <PresetEditor initial={editing.preset} isNew={editing.isNew} profiles={profiles.data ?? []} onClose={() => setEditing(null)} />}
        </div>
      )}
    </Q>
  );
}

function ChainEditor({ value, profiles, onChange, label, hint }: { value: string[]; profiles: Profile[]; onChange: (v: string[]) => void; label: string; hint?: string }) {
  const remaining = profiles.filter((p) => !value.includes(p.id));
  const move = (i: number, d: number) => {
    const n = [...value];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x as string);
    onChange(n);
  };
  return (
    <div>
      <div className="text-xs text-sub mb-1">
        {label}
        {hint && <span className="text-faint"> · {hint}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((id, i) => (
          <span key={id} className="inline-flex items-center gap-1 bg-panel2 rounded px-1.5 py-0.5 text-xs">
            <span className="text-faint">{i + 1}.</span> {id}
            {i > 0 && (
              <button type="button" aria-label="前移" className="text-faint hover:text-ink" onClick={() => move(i, -1)}>
                ←
              </button>
            )}
            {i < value.length - 1 && (
              <button type="button" aria-label="后移" className="text-faint hover:text-ink" onClick={() => move(i, 1)}>
                →
              </button>
            )}
            <button type="button" aria-label="移除" className="text-faint hover:text-danger" onClick={() => onChange(value.filter((x) => x !== id))}>
              ✕
            </button>
          </span>
        ))}
        {remaining.length > 0 && (
          <select
            className="text-xs bg-panel border border-line rounded px-1 py-0.5"
            value=""
            aria-label={`添加到${label}`}
            onChange={(e) => {
              if (e.target.value) onChange([...value, e.target.value]);
            }}
          >
            <option value="">＋ 添加</option>
            {remaining.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

const emptyRoute = (): RoleRoute => ({ chain: [], degrade_to: [], sticky: 'none', on_quota: 'degrade', failover_on: [], failover_chain: [], failover_requires_approval: true, constraint: 'none', distinct_vendors: false });

function RoleRow({ role, route, profiles, onChange }: { role: RoleId; route: RoleRoute | undefined; profiles: Profile[]; onChange: (r: RoleRoute) => void }) {
  const r = route ?? emptyRoute();
  const set = (p: Partial<RoleRoute>) => onChange({ ...r, ...p });
  return (
    <div className="py-3 border-b border-line last:border-0">
      <div className="grid sm:grid-cols-[8rem_1fr] gap-2 items-start">
        <div className="text-sm font-medium pt-0.5">
          {ROLE_LABEL[role]}
          <code className="block text-xs text-faint font-normal">{role}</code>
        </div>
        <div className="space-y-2 min-w-0">
          <ChainEditor value={r.chain} profiles={profiles} onChange={(chain) => set({ chain })} label="Profile 链" hint="靠前优先" />
          <Details summary={<span className="text-xs text-sub">约束与降级</span>}>
            <div className="space-y-3 pl-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Field label="约束">
                  <Select value={r.constraint} onChange={(e) => set({ constraint: e.target.value as RoleRoute['constraint'] })}>
                    {ROUTE_CONSTRAINTS.map((c) => (
                      <option key={c} value={c}>
                        {CONSTRAINT_LABEL[c]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="额度耗尽时">
                  <Select value={r.on_quota} onChange={(e) => set({ on_quota: e.target.value as RoleRoute['on_quota'] })}>
                    <option value="degrade">降级</option>
                    <option value="wait">等待重置</option>
                  </Select>
                </Field>
                <Field label="粘性">
                  <Select value={r.sticky} onChange={(e) => set({ sticky: e.target.value as RoleRoute['sticky'] })}>
                    <option value="none">无</option>
                    <option value="book">按书固定</option>
                  </Select>
                </Field>
                <Field label="同路由于">
                  <Select value={r.same_as ?? ''} onChange={(e) => set({ same_as: (e.target.value || undefined) as RoleId | undefined })}>
                    <option value="">—</option>
                    {ROLE_IDS.filter((x) => x !== role).map((x) => (
                      <option key={x} value={x}>
                        {ROLE_LABEL[x]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <ChainEditor value={r.degrade_to} profiles={profiles} onChange={(degrade_to) => set({ degrade_to })} label="降级链" />
              <ChainEditor value={r.failover_chain} profiles={profiles} onChange={(failover_chain) => set({ failover_chain })} label="故障转移链" />
              <div className="grid grid-cols-2 gap-2 items-end">
                <Field label="故障多久后转移（小时）">
                  <Input type="number" min={0} step={0.5} value={r.failover_after_ms === undefined ? '' : r.failover_after_ms / 3600_000} onChange={(e) => set({ failover_after_ms: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 3600_000) })} />
                </Field>
                <Toggle checked={r.failover_requires_approval} onChange={(v) => set({ failover_requires_approval: v })} label="转移前需要审批" />
              </div>
              {(role === 'judge' || r.panel !== undefined) && (
                <div className="grid grid-cols-2 gap-2 items-end">
                  <Field label="评委人数">
                    <Input type="number" min={1} value={r.panel ?? ''} onChange={(e) => set({ panel: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </Field>
                  <Toggle checked={r.distinct_vendors} onChange={(v) => set({ distinct_vendors: v })} label="评委要求不同厂商" />
                </div>
              )}
            </div>
          </Details>
        </div>
      </div>
    </div>
  );
}

function PresetEditor({ initial, isNew, profiles, onClose }: { initial: RoutingPreset; isNew: boolean; profiles: Profile[]; onClose: () => void }) {
  const [preset, setPreset] = useState<RoutingPreset>(initial);
  const idOk = /^[a-z0-9][a-z0-9-]*$/.test(preset.id);
  const save = useAction(
    () => {
      const roles = Object.fromEntries(Object.entries(preset.roles).filter(([, r]) => r && r.chain.length > 0));
      const body = { ...preset, roles };
      return isNew ? post('/api/admin/routing/presets', body) : put(`/api/admin/routing/presets/${enc(initial.id)}`, body);
    },
    { ok: initial.builtin && !isNew ? '内置 Preset 已另存为副本；若它正在生效，副本已自动设为当前' : '已保存', invalidate: ['/api/admin/routing', '/api/admin/settings'], onDone: onClose },
  );
  return (
    <Modal
      wide
      title={isNew ? '新建 Preset' : `编辑 ${initial.name}`}
      onClose={onClose}
      footer={
        <Button variant="primary" busy={save.isPending} disabled={!idOk || !preset.name.trim()} onClick={() => save.mutate()}>
          保存
        </Button>
      }
    >
      {initial.builtin && !isNew && (
        <div className="mb-3">
          <Notice>内置 Preset 不会被直接改写，保存时会生成一份副本；如果这个 Preset 正在生效，副本会自动设为当前。</Notice>
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <Field label="ID">
          <Input value={preset.id} disabled={!isNew} onChange={(e) => setPreset({ ...preset, id: e.target.value })} />
        </Field>
        <Field label="名称">
          <Input value={preset.name} onChange={(e) => setPreset({ ...preset, name: e.target.value })} />
        </Field>
        <Field label="说明" className="sm:col-span-2">
          <Textarea rows={2} value={preset.description} onChange={(e) => setPreset({ ...preset, description: e.target.value })} />
        </Field>
      </div>
      {ROUTABLE_ROLES.map((role) => (
        <RoleRow key={role} role={role} route={preset.roles[role]} profiles={profiles} onChange={(r) => setPreset((p) => ({ ...p, roles: { ...p.roles, [role]: r } }))} />
      ))}
    </Modal>
  );
}

function ProfilesTab() {
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
                              if (await confirmDialog({ title: `删除 Profile ${p.id}？`, body: '引用它的路由链会失效。', danger: true, okText: '删除' })) remove.mutate(p.id);
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

function CheckTab() {
  const books = useApi<BookSummary[]>('/api/admin/books');
  const [book, setBook] = useState('');
  const [report, setReport] = useState<FeasibilityReport | null>(null);
  const check = useAction(() => post<FeasibilityReport>(`/api/admin/routing/check${qs({ book })}`), { onDone: setReport });
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2 max-w-md">
        <Field label="检查对象" className="flex-1">
          <Select value={book} onChange={(e) => setBook(e.target.value)}>
            <option value="">系统默认路由</option>
            {books.data?.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.title}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" busy={check.isPending} onClick={() => check.mutate()}>
          检查
        </Button>
      </div>
      {report && (
        <Card title={`质量档 ${TIER_INFO[report.tier as QualityTier]?.label ?? report.tier}`}>
          <FeasibilityView report={report} />
        </Card>
      )}
    </div>
  );
}

