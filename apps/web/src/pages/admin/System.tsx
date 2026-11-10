/**
 * 系统（docs/v3/DESIGN.md §9）：默认发布节奏与存稿上限、失控兜底、并发、时限、隔离、保留期、读者、通知、v1 导入、密码与令牌、Doctor。
 * 每张卡片只保存自己那一节（带 baseUpdatedAt，P3 D30）。
 */
import { useState, type ReactNode } from 'react';
import type { CreatedPat, DoctorReport, PatRow, SystemInfo, SystemSettingsView } from '@novelist/shared';
import { del, enc, post, put } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { ImportSection } from '../../components/admin/ImportPanel';
import { ReadersSection } from '../../components/admin/ReadersPanel';
import { useSectionSaver, useSettings } from '../../components/admin/settingsSave';
import { Badge, Button, Card, confirmDialog, Empty, Field, Input, KV, Notice, Page, PageHeader, Pre, Q, Select, Tabs, Toggle } from '../../components/ui';
import { fmtBytes, fmtRel, fmtTime } from '../../lib/format';

type Tab = 'settings' | 'readers' | 'import' | 'security' | 'doctor';

export function SystemPage() {
  const [tab, setTab] = useState<Tab>('settings');
  const q = useSettings();
  return (
    <Page>
      <PageHeader title="系统" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'settings', label: '设置' },
          { id: 'readers', label: '读者' },
          { id: 'import', label: 'v1 导入' },
          { id: 'security', label: '密码与令牌' },
          { id: 'doctor', label: 'Doctor' },
        ]}
      />
      {tab === 'settings' && <Q q={q}>{(s) => <SettingsCards key={s.updatedAt ?? 'new'} s={s} />}</Q>}
      {tab === 'readers' && (
        <div className="space-y-4">
          <Q q={q}>{(s) => <ReaderVisibilityCard key={s.updatedAt ?? 'new'} s={s} />}</Q>
          <ReadersSection />
        </div>
      )}
      {tab === 'import' && <ImportSection />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'doctor' && <DoctorTab />}
    </Page>
  );
}

const int = (v: string): number | null => (/^\d+$/.test(v.trim()) ? Number(v) : null);

/** 一张只存自己那一节的卡片 */
function SectionCard({ title, children, onSave, busy, disabled }: { title: ReactNode; children: ReactNode; onSave: () => void; busy: boolean; disabled?: boolean }) {
  return (
    <Card title={title}>
      {children}
      <div className="flex justify-end mt-3">
        <Button variant="primary" size="sm" busy={busy} disabled={disabled} onClick={onSave}>
          保存
        </Button>
      </div>
    </Card>
  );
}

export function PublishDefaultsCard({ s }: { s: SystemSettingsView }) {
  const saver = useSectionSaver();
  const [p, setP] = useState(s.v3.publishDefaults);
  const [perSlot, setPerSlot] = useState(String(p.per_slot));
  const [maxBuffer, setMaxBuffer] = useState(String(p.max_buffer));
  const ok = (int(perSlot) ?? 0) >= 1 && (int(maxBuffer) ?? 0) >= 2 && p.cadence.trim() !== '' && p.timezone.trim() !== '';
  return (
    <SectionCard title="默认发布节奏与存稿上限" busy={saver.isPending} disabled={!ok} onSave={() => saver.save(s.updatedAt, { v3: { publishDefaults: { ...p, per_slot: Number(perSlot), max_buffer: Number(maxBuffer) } } })}>
      <p className="text-xs text-sub mb-2">开新书和接手旧书时写进 book.yaml；每本书在书页上可以单独改。存稿上限实际取它和“每批章数 × 2”中较大的那个。</p>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="方式">
          <Select value={p.mode} onChange={(e) => setP({ ...p, mode: e.target.value as typeof p.mode })}>
            <option value="scheduled">按节奏</option>
            <option value="immediate">可发布就发</option>
            <option value="manual">手动</option>
          </Select>
        </Field>
        <Field label="节奏（cron）" hint="例：0 8 * * * = 每天 8 点">
          <Input value={p.cadence} onChange={(e) => setP({ ...p, cadence: e.target.value })} />
        </Field>
        <Field label="时区">
          <Input value={p.timezone} onChange={(e) => setP({ ...p, timezone: e.target.value })} />
        </Field>
        <Field label="每次发布章数" error={(int(perSlot) ?? 0) >= 1 ? undefined : '至少 1'}>
          <Input type="number" min={1} value={perSlot} onChange={(e) => setPerSlot(e.target.value)} />
        </Field>
        <Field label="存稿上限（章）" error={(int(maxBuffer) ?? 0) >= 2 ? undefined : '至少 2'}>
          <Input type="number" min={2} value={maxBuffer} onChange={(e) => setMaxBuffer(e.target.value)} />
        </Field>
      </div>
    </SectionCard>
  );
}

export function RunawayCard({ s }: { s: SystemSettingsView }) {
  const saver = useSectionSaver();
  const [v, setV] = useState(String(s.v3.runawayFactor));
  const n = Number(v);
  const ok = v.trim() !== '' && Number.isFinite(n) && (n === 0 || (n >= 2 && n <= 10));
  return (
    <SectionCard title="失控兜底" busy={saver.isPending} disabled={!ok} onSave={() => saver.save(s.updatedAt, { v3: { runawayFactor: n } })}>
      <Field label="倍数" hint={'0 = 关闭；开着时 2–10。写到计划章数的这个倍数后再写两批仍未完结，就强制收尾；关闭后，连续两次结局批没写"（全书完）"只在待办里提醒'} error={ok ? undefined : '0，或 2–10'}>
        <Input type="number" min={0} max={10} step="0.5" value={v} onChange={(e) => setV(e.target.value)} className="max-w-40" />
      </Field>
    </SectionCard>
  );
}

function ConcurrencyCard({ s }: { s: SystemSettingsView }) {
  const saver = useSectionSaver();
  const sched = useSectionSaver(s.schedulerEnabled ? '调度已暂停' : '调度已恢复');
  const [v, setV] = useState(String(s.maxConcurrentRuns));
  const ok = (int(v) ?? 0) >= 1;
  return (
    <SectionCard title="并发与调度" busy={saver.isPending} disabled={!ok} onSave={() => saver.save(s.updatedAt, { maxConcurrentRuns: Number(v) })}>
      <div className="grid sm:grid-cols-2 gap-3 items-end">
        <Field label="同时最多几次运行" hint="每个账号另有自己的并发数" error={ok ? undefined : '至少 1'}>
          <Input type="number" min={1} value={v} onChange={(e) => setV(e.target.value)} />
        </Field>
        <div className="pb-1.5">
          <Toggle checked={s.schedulerEnabled} disabled={sched.isPending} onChange={(on) => sched.save(s.updatedAt, { schedulerEnabled: on })} label="调度器运行中" hint="关闭后不再派发新任务，正在运行的照常完成（立即生效）" />
        </div>
      </div>
    </SectionCard>
  );
}

function TimeLimitsCard({ s }: { s: SystemSettingsView }) {
  const saver = useSectionSaver();
  const min = (ms: number) => String(Math.round(ms / 60_000));
  const [wall, setWall] = useState(min(s.wallTimeoutMs));
  const [writer, setWriter] = useState(min(s.idleTimeouts.writerMs));
  const [other, setOther] = useState(min(s.idleTimeouts.otherMs));
  const [dsh, setDsh] = useState(min(s.idleTimeouts.dshMs));
  const all = [wall, writer, other, dsh];
  const ok = all.every((x) => (int(x) ?? 0) >= 1);
  const ms = (x: string) => Number(x) * 60_000;
  return (
    <SectionCard title="时限（分钟）" busy={saver.isPending} disabled={!ok} onSave={() => saver.save(s.updatedAt, { wallTimeoutMs: ms(wall), idleTimeouts: { writerMs: ms(writer), otherMs: ms(other), dshMs: ms(dsh) } })}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="单次运行总时限">
          <Input type="number" min={1} value={wall} onChange={(e) => setWall(e.target.value)} />
        </Field>
        <Field label="写作空闲">
          <Input type="number" min={1} value={writer} onChange={(e) => setWriter(e.target.value)} />
        </Field>
        <Field label="其他运行空闲">
          <Input type="number" min={1} value={other} onChange={(e) => setOther(e.target.value)} />
        </Field>
        <Field label="dsh 空闲">
          <Input type="number" min={1} value={dsh} onChange={(e) => setDsh(e.target.value)} />
        </Field>
      </div>
    </SectionCard>
  );
}

function IsolationCard({ s }: { s: SystemSettingsView }) {
  const saver = useSectionSaver();
  const [v, setV] = useState(s.isolation);
  return (
    <SectionCard title="隔离" busy={saver.isPending} onSave={() => saver.save(s.updatedAt, { isolation: v })}>
      <Field label="隔离后端" hint="自动探测会选当前机器上最强的可用后端（详见 Doctor）">
        <Select value={v} onChange={(e) => setV(e.target.value as typeof v)} className="max-w-60">
          {['auto', 'container', 'bwrap', 'landlock', 'degraded'].map((b) => (
            <option key={b} value={b}>
              {b === 'auto' ? '自动探测' : b}
            </option>
          ))}
        </Select>
      </Field>
    </SectionCard>
  );
}

function RetentionCard({ s }: { s: SystemSettingsView }) {
  const saver = useSectionSaver();
  const [r, setR] = useState(() => ({ runEventsDays: String(s.retention.runEventsDays), rawStreamDays: String(s.retention.rawStreamDays), keepAcceptedRawDays: String(s.retention.keepAcceptedRawDays), thinkingDays: String(s.retention.thinkingDays) }));
  const ok = Object.values(r).every((x) => (int(x) ?? 0) >= 1);
  const field = (k: keyof typeof r, label: string) => (
    <Field label={label}>
      <Input type="number" min={1} value={r[k]} onChange={(e) => setR({ ...r, [k]: e.target.value })} />
    </Field>
  );
  return (
    <SectionCard title="保留期（天）" busy={saver.isPending} disabled={!ok} onSave={() => saver.save(s.updatedAt, { retention: Object.fromEntries(Object.entries(r).map(([k, x]) => [k, Number(x)])) })}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {field('runEventsDays', '运行事件')}
        {field('rawStreamDays', '原始输出')}
        {field('keepAcceptedRawDays', '入库运行的原始输出')}
        {field('thinkingDays', '思考内容')}
      </div>
    </SectionCard>
  );
}

function NotificationsCard({ s }: { s: SystemSettingsView }) {
  const saver = useSectionSaver();
  const [ntfy, setNtfy] = useState(s.notifications.ntfyUrl ?? '');
  const [hook, setHook] = useState(s.notifications.webhookUrl ?? '');
  return (
    <SectionCard title="通知" busy={saver.isPending} onSave={() => saver.save(s.updatedAt, { notifications: { ntfyUrl: ntfy.trim(), webhookUrl: hook.trim() } })}>
      <p className="text-xs text-sub mb-2">新待办和账号等额度时推送；留空不推送。</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="ntfy 地址">
          <Input value={ntfy} placeholder="https://ntfy.example.com/topic" onChange={(e) => setNtfy(e.target.value)} />
        </Field>
        <Field label="Webhook 地址">
          <Input value={hook} placeholder="https://example.com/hook" onChange={(e) => setHook(e.target.value)} />
        </Field>
      </div>
    </SectionCard>
  );
}

export function ReaderVisibilityCard({ s }: { s: SystemSettingsView }) {
  const saver = useSectionSaver();
  const [v, setV] = useState(s.readers.defaultVisibility);
  return (
    <SectionCard title="新读者默认能看到" busy={saver.isPending} onSave={() => saver.save(s.updatedAt, { readers: { defaultVisibility: v } })}>
      <Select value={v} onChange={(e) => setV(e.target.value as typeof v)} className="max-w-72" aria-label="新读者默认可见">
        <option value="all">全部已发布的书</option>
        <option value="none">什么都看不到（逐个授权）</option>
      </Select>
    </SectionCard>
  );
}

function SettingsCards({ s }: { s: SystemSettingsView }) {
  return (
    <div className="space-y-4">
      <PublishDefaultsCard s={s} />
      <RunawayCard s={s} />
      <ConcurrencyCard s={s} />
      <TimeLimitsCard s={s} />
      <IsolationCard s={s} />
      <RetentionCard s={s} />
      <NotificationsCard s={s} />
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
