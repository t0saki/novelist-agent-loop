/** 系统设置、Doctor、安全（管理员密码 / PAT）。Owner: lane H。 */
import { useState, type ReactNode } from 'react';
import { QUALITY_TIERS, type CreatedPat, type DoctorReport, type PatRow, type QualityTier, type RoutingPreset, type SystemInfo, type SystemSettings } from '@novelist/shared';
import { del, enc, post, put } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { Badge, Button, Card, confirmDialog, Empty, Field, Input, KV, Notice, Page, PageHeader, Pre, Q, Select, Tabs, Toggle } from '../../components/ui';
import { fmtBytes, fmtRel, fmtTime } from '../../lib/format';
import { TIER_INFO } from '../../lib/labels';

export function SettingsPage() {
  const [tab, setTab] = useState<'system' | 'doctor' | 'security'>('system');
  return (
    <Page>
      <PageHeader title="系统与 Doctor" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'system', label: '系统设置' },
          { id: 'doctor', label: 'Doctor' },
          { id: 'security', label: '安全' },
        ]}
      />
      {tab === 'system' && <SystemTab />}
      {tab === 'doctor' && <DoctorTab />}
      {tab === 'security' && <SecurityTab />}
    </Page>
  );
}

function SystemTab() {
  const q = useApi<SystemSettings>('/api/admin/settings');
  return <Q q={q}>{(s) => <SettingsForm key={JSON.stringify(s)} initial={s} />}</Q>;
}

function SettingsForm({ initial }: { initial: SystemSettings }) {
  const presets = useApi<RoutingPreset[]>('/api/admin/routing/presets');
  const [s, setS] = useState(initial);
  const set = <K extends keyof SystemSettings>(k: K, v: SystemSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const save = useAction(() => put<SystemSettings>('/api/admin/settings', s), { ok: '已保存', invalidate: ['/api/admin/settings', '/api/admin/routing'] });
  const num = (v: string, fallback: number) => (v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));
  const minutes = (ms: number) => Math.round(ms / 60_000);
  return (
    <div className="space-y-4">
      <Card title="调度">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Field label="当前路由 Preset">
            <Select value={s.activePreset} onChange={(e) => set('activePreset', e.target.value)}>
              {presets.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="默认质量档">
            <Select value={s.defaultTier} onChange={(e) => set('defaultTier', e.target.value as QualityTier)}>
              {QUALITY_TIERS.map((t) => (
                <option key={t} value={t}>
                  {TIER_INFO[t].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="隔离后端">
            <Select value={s.isolation} onChange={(e) => set('isolation', e.target.value as SystemSettings['isolation'])}>
              {['auto', 'container', 'bwrap', 'landlock', 'degraded'].map((b) => (
                <option key={b} value={b}>
                  {b === 'auto' ? '自动探测' : b}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="最大并发 run">
            <Input type="number" min={1} value={s.maxConcurrentRuns} onChange={(e) => set('maxConcurrentRuns', Math.max(1, num(e.target.value, 1)))} />
          </Field>
          <Field label="全局配额预留 %">
            <Input type="number" min={0} max={100} value={s.reservePct} onChange={(e) => set('reservePct', num(e.target.value, 0))} />
          </Field>
          <Field label="工单字数上限">
            <Input type="number" min={1000} value={s.workOrderMaxCjk} onChange={(e) => set('workOrderMaxCjk', num(e.target.value, 65000))} />
          </Field>
        </div>
        <div className="mt-3">
          <Toggle checked={s.schedulerEnabled} onChange={(v) => set('schedulerEnabled', v)} label="启用调度器" hint="关闭后不再派发新任务，正在运行的 run 继续完成" />
        </div>
      </Card>

      <Card title="时限（分钟）">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="写手空闲">
            <Input type="number" min={1} value={minutes(s.idleTimeouts.writerMs)} onChange={(e) => set('idleTimeouts', { ...s.idleTimeouts, writerMs: num(e.target.value, 20) * 60_000 })} />
          </Field>
          <Field label="其他角色空闲">
            <Input type="number" min={1} value={minutes(s.idleTimeouts.otherMs)} onChange={(e) => set('idleTimeouts', { ...s.idleTimeouts, otherMs: num(e.target.value, 10) * 60_000 })} />
          </Field>
          <Field label="dsh 空闲">
            <Input type="number" min={1} value={minutes(s.idleTimeouts.dshMs)} onChange={(e) => set('idleTimeouts', { ...s.idleTimeouts, dshMs: num(e.target.value, 15) * 60_000 })} />
          </Field>
          <Field label="单次总时限">
            <Input type="number" min={1} value={minutes(s.wallTimeoutMs)} onChange={(e) => set('wallTimeoutMs', num(e.target.value, 60) * 60_000)} />
          </Field>
        </div>
      </Card>

      <Card title="通知">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="ntfy 地址">
            <Input value={s.notifications.ntfyUrl ?? ''} onChange={(e) => set('notifications', { ...s.notifications, ntfyUrl: e.target.value || undefined })} />
          </Field>
          <Field label="Webhook 地址">
            <Input value={s.notifications.webhookUrl ?? ''} onChange={(e) => set('notifications', { ...s.notifications, webhookUrl: e.target.value || undefined })} />
          </Field>
        </div>
      </Card>

      <Card title="保留期（天）与读者">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="run 事件">
            <Input type="number" min={1} value={s.retention.runEventsDays} onChange={(e) => set('retention', { ...s.retention, runEventsDays: num(e.target.value, 30) })} />
          </Field>
          <Field label="原始流">
            <Input type="number" min={1} value={s.retention.rawStreamDays} onChange={(e) => set('retention', { ...s.retention, rawStreamDays: num(e.target.value, 30) })} />
          </Field>
          <Field label="已验收章节的原始流">
            <Input type="number" min={1} value={s.retention.keepAcceptedRawDays} onChange={(e) => set('retention', { ...s.retention, keepAcceptedRawDays: num(e.target.value, 365) })} />
          </Field>
          <Field label="思考内容">
            <Input type="number" min={1} value={s.retention.thinkingDays} onChange={(e) => set('retention', { ...s.retention, thinkingDays: num(e.target.value, 90) })} />
          </Field>
          <Field label="新读者默认可见">
            <Select value={s.readers.defaultVisibility} onChange={(e) => set('readers', { defaultVisibility: e.target.value as 'all' | 'none' })}>
              <option value="all">全部已发布的书</option>
              <option value="none">不可见（需逐本授权）</option>
            </Select>
          </Field>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          保存设置
        </Button>
      </div>
    </div>
  );
}

function DoctorTab() {
  const q = useApi<DoctorReport>('/api/admin/doctor');
  const sys = useApi<SystemInfo>('/api/admin/system');
  const ok = (v: boolean, text?: string) => <Badge tone={v ? 'ok' : 'danger'}>{text ?? (v ? '正常' : '异常')}</Badge>;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" busy={q.isFetching} onClick={() => void q.refetch()}>
          重新检查
        </Button>
      </div>
      <Q q={q}>
        {(d) => (
          <>
            {d.access.warning && <Notice tone="danger">{d.access.warning}</Notice>}
            {d.hints.length > 0 && (
              <Notice tone="warn">
                <ul className="list-disc pl-4 space-y-0.5">
                  {d.hints.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <Card title="隔离后端">
              <KV
                items={[
                  ['当前选中', <Badge key="s" tone="accent">{d.isolation.selected}</Badge>],
                  ['偏好', d.isolation.preference],
                  ['内核', d.isolation.kernel ?? '—'],
                  ['在容器内', d.isolation.inContainer ? '是' : '否'],
                  ['Landlock ABI', d.isolation.landlockAbi ?? '—'],
                  ['LSM', d.isolation.lsm.join(', ') || '—'],
                ]}
              />
              <ul className="mt-3 space-y-1.5">
                {d.isolation.backends.map((b) => (
                  <li key={b.backend} className="text-sm flex gap-2 items-start">
                    {ok(b.available, b.available ? '可用' : '不可用')}
                    <span>
                      <b className="font-medium">{b.backend}</b> <span className="text-sub">{b.detail}</span>
                      {b.fixHint && <span className="block text-xs text-faint">{b.fixHint}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
            <div className="grid md:grid-cols-2 gap-4">
              <Card title="Harness 版本">
                <ul className="space-y-1.5">
                  {d.harnesses.map((h) => (
                    <li key={h.id} className="text-sm flex gap-2 items-start">
                      {ok(h.ok)}
                      <span>
                        {h.id} <span className="text-sub text-xs">{h.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title="工具">
                <ul className="space-y-1.5">
                  {d.tools.map((t) => (
                    <li key={t.name} className="text-sm flex gap-2 items-start">
                      {ok(t.ok)}
                      <span>
                        {t.name} <span className="text-sub text-xs">{t.version ?? t.detail ?? ''}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title="存储与数据库">
                <KV
                  items={[
                    ['数据库', <span key="d">{d.db.kind} {d.db.version} {ok(d.db.ok)}</span>],
                    ['迁移', d.db.migrations],
                    ...d.disk.map((x): [string, ReactNode] => [x.path, <span key={x.path}>剩余 {fmtBytes(x.freeBytes)} {ok(x.ok)}</span>]),
                  ]}
                />
              </Card>
              <Card title="访问与主密钥">
                <KV
                  items={[
                    ['协议', d.access.protocol],
                    ['信任反代', d.access.trustProxy ? '是' : '否'],
                    ['Cookie 不安全', d.access.insecureCookies ? '是' : '否'],
                    ['主密钥来源', <span key="k">{{ env: '环境变量', file: '文件', generated: '自动生成' }[d.masterKey.source]} {ok(d.masterKey.ok)}</span>],
                    ['检查时间', fmtTime(d.ts)],
                  ]}
                />
              </Card>
            </div>
          </>
        )}
      </Q>
      <Card title="系统信息">
        <Q q={sys}>
          {(s) => (
            <KV
              items={[
                ['版本', s.version],
                ['Node', s.node],
                ['架构', `${s.platform}/${s.arch}`],
                ['数据目录', <code key="dd" className="text-xs">{s.dataDir}</code>],
                ['角色', s.roles.join(', ')],
                ['运行时长', `${Math.floor(s.uptimeSec / 3600)} 小时 ${Math.floor((s.uptimeSec % 3600) / 60)} 分`],
              ]}
            />
          )}
        </Q>
      </Card>
    </div>
  );
}

function SecurityTab() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useAction(() => put('/api/admin/settings/admin-password', { current, next }), {
    ok: '管理员密码已修改',
    onDone: () => {
      setCurrent('');
      setNext('');
    },
  });
  const pats = useApi<PatRow[]>('/api/admin/pats');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<CreatedPat | null>(null);
  const issue = useAction(() => post<CreatedPat>('/api/admin/pats', { label }), {
    invalidate: ['/api/admin/pats'],
    onDone: (p) => {
      setCreated(p);
      setLabel('');
    },
  });
  const revoke = useAction((id: string) => del(`/api/admin/pats/${enc(id)}`), { ok: '已吊销', invalidate: ['/api/admin/pats'] });
  return (
    <div className="space-y-4">
      <Card title="管理员密码">
        <div className="grid sm:grid-cols-2 gap-3 max-w-xl">
          <Field label="当前密码">
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="新密码" hint="至少 8 位">
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
        </div>
        <Button className="mt-3" variant="primary" busy={change.isPending} disabled={!current || next.length < 8} onClick={() => change.mutate()}>
          修改密码
        </Button>
      </Card>
      <Card title="个人访问令牌（CLI）">
        <div className="flex gap-2 max-w-md mb-3">
          <Input placeholder="用途，如 laptop" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button busy={issue.isPending} disabled={!label.trim()} onClick={() => issue.mutate()}>
            签发
          </Button>
        </div>
        {created && (
          <div className="mb-3 space-y-1">
            <Notice tone="warn">令牌只显示这一次，请立即保存。</Notice>
            <Pre>{created.token}</Pre>
          </div>
        )}
        <Q q={pats}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty>还没有令牌。</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((p) => (
                  <li key={p.id} className="py-2 flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0">
                      {p.label} {p.revokedAt && <Badge tone="warn">已吊销</Badge>}
                      <span className="block text-xs text-faint">
                        创建于 {fmtRel(p.createdAt)} · 最近使用 {fmtRel(p.lastUsedAt)}
                      </span>
                    </span>
                    {!p.revokedAt && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (await confirmDialog({ title: `吊销令牌 ${p.label}？`, danger: true, okText: '吊销' })) revoke.mutate(p.id);
                        }}
                      >
                        吊销
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </Q>
      </Card>
    </div>
  );
}
