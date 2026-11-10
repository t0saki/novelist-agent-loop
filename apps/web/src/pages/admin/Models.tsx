/**
 * 模型与账号（docs/v3/DESIGN.md §7、§9）：两个位置（写作 / 杂活）的主备、effort 表、harness 安装登录探测、profile、用量。
 */
import { useState } from 'react';
import { SLOT_IDS, type Effort, type Profile, type RoutingSlotsView, type SlotCanaryResult, type SlotId, type SlotStatus, type SystemSettingsView } from '@novelist/shared';
import { enc, post, put } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { HarnessSection } from '../../components/admin/HarnessPanel';
import { ProfilesSection } from '../../components/admin/ProfilesPanel';
import { useSectionSaver, useSettings } from '../../components/admin/settingsSave';
import { UsageSection } from '../../components/admin/UsagePanel';
import { Badge, Button, Card, Field, Modal, Notice, Page, PageHeader, Q, Select, Tabs } from '../../components/ui';
import { fmtTime } from '../../lib/format';

type Tab = 'models' | 'harness' | 'profiles' | 'usage';

const SLOT_LABEL: Record<SlotId, { label: string; hint: string }> = {
  writer: { label: '写作用的模型', hint: '开书、写作、结局、复盘都用它；每本书可以在书页上单独换' },
  utility: { label: '杂活用的模型', hint: '探测和试跑用它' },
};

const EFFORTS: Effort[] = ['low', 'medium', 'high'];
export const EFFORT_ROWS: { id: keyof SystemSettingsView['v3']['effortDefaults']; label: string }[] = [
  { id: 'open', label: '开书' },
  { id: 'write', label: '写作' },
  { id: 'closing', label: '收尾阶段的写作' },
  { id: 'finale', label: '结局批' },
  { id: 'retro', label: '复盘' },
];

function statusText(s: SlotStatus): string {
  if (s.waitUntil) return `暂时不可用，约 ${fmtTime(s.waitUntil)} 恢复${s.reason ? `（${s.reason}）` : ''}`;
  if (!s.profile) return s.reason ?? '没有可用的 profile：用到它的任务会等';
  return `现在用 ${s.profile}${s.account ? ` · 账号 ${s.account}` : ''}${s.model ? ` · ${s.model}` : ''}${s.usedFallback ? '（备用）' : ''}`;
}

function ProfileSelect({ value, profiles, onChange, label, allowNone }: { value: string | null; profiles: Profile[]; onChange: (v: string | null) => void; label: string; allowNone: string }) {
  const known = value === null || profiles.some((p) => p.id === value);
  return (
    <Select value={value ?? ''} aria-label={label} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
      <option value="">{allowNone}</option>
      {!known && <option value={value as string}>{value}（已不存在）</option>}
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.id} · {p.label || p.model}
          {p.enabled ? '' : '（已停用）'}
        </option>
      ))}
    </Select>
  );
}

function CanaryButton({ slot }: { slot: SlotId }) {
  const [result, setResult] = useState<SlotCanaryResult | null>(null);
  const run = useAction(() => post<SlotCanaryResult>(`/api/admin/routing/slots/${enc(slot)}/canary`), { onDone: setResult, invalidate: ['/api/admin/harness'] });
  return (
    <>
      <Button size="sm" busy={run.isPending} onClick={() => run.mutate()}>
        试跑
      </Button>
      {result && (
        <Modal title={`${SLOT_LABEL[slot].label}：试跑结果`} onClose={() => setResult(null)}>
          <div className="space-y-2 text-sm">
            <p>
              <Badge tone={result.result.ok ? 'ok' : 'danger'}>{result.result.ok ? '通过' : '没通过'}</Badge> 写出文件 {result.result.wroteFile ? '是' : '否'} · AGENTS.md 生效 {result.result.honouredAgents ? '是' : '否'} · 工具步数 {result.result.toolSteps}
            </p>
            <p className="text-xs text-sub">{statusText(result.status)}</p>
            <ul className="space-y-1">
              {result.result.steps.map((s) => (
                <li key={s.step} className="flex gap-2 items-start">
                  <Badge tone={s.ok ? 'ok' : 'danger'}>{s.ok ? '通过' : '失败'}</Badge>
                  <span>
                    {s.step}
                    {s.detail && <span className="block text-xs text-sub">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      )}
    </>
  );
}

export function SlotsCard({ view }: { view: RoutingSlotsView }) {
  const [slots, setSlots] = useState({ writer: view.slots.writer, utility: view.slots.utility });
  const save = useAction(() => put<RoutingSlotsView>('/api/admin/routing/slots', slots), { ok: '已保存', invalidate: ['/api/admin/routing'] });
  const dirty = JSON.stringify(slots) !== JSON.stringify({ writer: view.slots.writer, utility: view.slots.utility });
  return (
    <Card title="两个位置">
      <div className="space-y-3">
        {view.forced && <Notice tone="warn">现在是 fake 模式：两个位置都走 fake harness，书页上的模型覆盖不生效；这里的设置不能改，换回正常模式后照常可改。</Notice>}
        {view.slots.droppedProfiles.length > 0 && (
          <Notice tone="warn">
            从旧的路由 preset{view.slots.migratedFrom ? `（${view.slots.migratedFrom}）` : ''}换算过来时，这些 profile 已经不存在、被丢掉了：{view.slots.droppedProfiles.join('、')}。请确认下面的选择。
          </Notice>
        )}
        <p className="text-xs text-sub">每个位置可以配主、备两套；默认不配备用，主用不可用时就等。备用不限制同模型。</p>
        {SLOT_IDS.map((id) => (
          <div key={id} className="border border-line rounded-lg p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
              <div>
                <span className="font-medium text-sm">{SLOT_LABEL[id].label}</span>
                <span className="block text-xs text-faint">{SLOT_LABEL[id].hint}</span>
              </div>
              <CanaryButton slot={id} />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="主用">
                <ProfileSelect label={`${SLOT_LABEL[id].label} 主用`} value={slots[id].primary} profiles={view.profiles} allowNone="（不配）" onChange={(v) => setSlots({ ...slots, [id]: { ...slots[id], primary: v } })} />
              </Field>
              <Field label="备用">
                <ProfileSelect label={`${SLOT_LABEL[id].label} 备用`} value={slots[id].fallback} profiles={view.profiles} allowNone="（不配）" onChange={(v) => setSlots({ ...slots, [id]: { ...slots[id], fallback: v } })} />
              </Field>
            </div>
            <p className="text-xs text-sub mt-2">{statusText(view.status[id])}</p>
          </div>
        ))}
        <div className="flex justify-end">
          <Button variant="primary" disabled={view.forced || !dirty} busy={save.isPending} onClick={() => save.mutate()}>
            保存位置
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function EffortCard({ settings: s }: { settings: SystemSettingsView }) {
  const [effort, setEffort] = useState(s.v3.effortDefaults);
  const saver = useSectionSaver();
  return (
    <Card title="effort">
      <p className="text-xs text-sub mb-2">新书开书时写进 book.yaml；每本书在书页上可以单独改。已有的书不受影响。</p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {EFFORT_ROWS.map((r) => (
          <Field key={r.id} label={r.label}>
            <Select value={effort[r.id]} aria-label={`${r.label} effort`} onChange={(e) => setEffort({ ...effort, [r.id]: e.target.value as Effort })}>
              {EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
      <div className="flex justify-end mt-3">
        <Button variant="primary" busy={saver.isPending} onClick={() => saver.save(s.updatedAt, { v3: { effortDefaults: effort } })}>
          保存 effort
        </Button>
      </div>
    </Card>
  );
}

export function ModelsPage() {
  const [tab, setTab] = useState<Tab>('models');
  const slots = useApi<RoutingSlotsView>('/api/admin/routing/slots');
  const settings = useSettings();
  return (
    <Page>
      <PageHeader title="模型与账号" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'models', label: '位置与 effort' },
          { id: 'harness', label: 'Harness 与账号' },
          { id: 'profiles', label: 'Profile' },
          { id: 'usage', label: '用量' },
        ]}
      />
      {tab === 'models' && (
        <div className="space-y-4">
          <Q q={slots}>{(v) => <SlotsCard key={JSON.stringify(v.slots)} view={v} />}</Q>
          <Q q={settings}>{(s) => <EffortCard key={s.updatedAt ?? 'new'} settings={s} />}</Q>
        </div>
      )}
      {tab === 'harness' && <HarnessSection />}
      {tab === 'profiles' && <ProfilesSection />}
      {tab === 'usage' && <UsageSection />}
    </Page>
  );
}
