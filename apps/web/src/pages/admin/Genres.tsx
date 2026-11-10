/**
 * 题材与指令（docs/v3/DESIGN.md §9）：每个题材包一张表单（是否参与自动开书、权重、关键词、篇幅倾向）和一个指令编辑器；
 * 另有全局层的编辑器，和篇幅档（内置，只读）的查看器。
 */
import { useState } from 'react';
import { V3_LENGTHS, type GenreSummary, type SystemSettingsView } from '@novelist/shared';
import { del, enc, post } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { effectiveAuto, OverrideNote, useGenreAutoPatch } from '../../components/admin/GenreAuto';
import { InstructionWorkbench } from '../../components/admin/InstructionWorkbench';
import { useSettings } from '../../components/admin/settingsSave';
import { Badge, Button, Card, confirmDialog, cx, Field, Input, Modal, Notice, Page, PageHeader, Q, Select, Tabs, Textarea, Toggle } from '../../components/ui';
import { toast } from '../../components/toast';
import { V3_LENGTH_LABEL } from '../../lib/labels';

type Tab = 'packs' | 'global' | 'length';

const isLengthFile = (p: string) => /^v3\/length-[a-z]+\.md$/.test(p);

/** 关键词：逗号、顿号或换行分隔 */
export const splitKeywords = (s: string) => [...new Set(s.split(/[,，、\n]+/).map((x) => x.trim()).filter(Boolean))];

export function GenreAutoForm({ g, settings }: { g: GenreSummary; settings: SystemSettingsView | undefined }) {
  const save = useGenreAutoPatch();
  const [enabled, setEnabled] = useState(g.auto?.enabled ?? false);
  const [weight, setWeight] = useState(String(g.auto?.weight ?? 1));
  const [keywords, setKeywords] = useState((g.auto?.keywordList ?? []).join('、'));
  const [hint, setHint] = useState(g.auto?.lengthHint ?? '');
  const w = Number(weight);
  const weightOk = weight !== '' && Number.isFinite(w) && w >= 0 && w <= 100;
  const eff = effectiveAuto(g);
  // 服务器按文字认篇幅倾向（含“超长”“长篇”“中篇”，其余按短篇）：选项就是这四个词
  const hintOptions = [...new Set(['', ...V3_LENGTHS.map((l) => V3_LENGTH_LABEL[l]), hint])];
  return (
    <Card title="自动开书">
      <div className="space-y-3">
        <Toggle checked={enabled} onChange={setEnabled} label="参与自动开书" />
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="权重" hint="越大开得越多；0 = 不参与" error={weightOk ? undefined : '0–100'}>
            <Input type="number" min={0} max={100} step="any" value={weight} onChange={(e) => setWeight(e.target.value)} />
          </Field>
          <Field label="篇幅倾向" hint="只是加权，不是限定">
            <Select value={hint} onChange={(e) => setHint(e.target.value)}>
              {hintOptions.map((h) => (
                <option key={h} value={h}>
                  {h === '' ? '无' : h}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="关键词" hint="开书时随机抽 1–2 个必用；用逗号、顿号或换行分隔">
          <Textarea rows={3} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
        </Field>
        <p className="text-xs text-sub">
          成人题材：{g.auto?.adultOnly ? '是（种子里保留“所有角色都是成年人”的声明）' : '否'} · 最少章数：{g.auto?.minChapters ?? '不限'}（这两项在 pack.yaml 里改）
        </p>
        <p className="text-xs text-sub flex flex-wrap items-center gap-2">
          实际生效：{eff.enabled ? `参与，权重 ${eff.weight}` : '不参与'}
          <OverrideNote g={g} settings={settings} />
        </p>
        <div className="flex justify-end">
          <Button variant="primary" disabled={!weightOk} busy={save.isPending} onClick={() => save.mutate({ id: g.id, body: { enabled, weight: w, keywords: splitKeywords(keywords), length_hint: hint } })}>
            保存
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PacksTab() {
  const q = useApi<GenreSummary[]>('/api/admin/genres');
  const settings = useSettings();
  const [picked, setPicked] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string; name: string; copyFrom: string } | null>(null);
  const create = useAction((f: { id: string; name: string; copyFrom: string }) => post<GenreSummary>('/api/admin/genres', { id: f.id, name: f.name, copyFrom: f.copyFrom || undefined }), {
    ok: '已创建',
    invalidate: ['/api/admin/genres'],
    onDone: (g) => {
      setForm(null);
      setPicked(g.id);
    },
  });
  const remove = useAction((id: string) => del(`/api/admin/genres/${enc(id)}`), { ok: '已移到回收站', invalidate: ['/api/admin/genres'], onDone: () => setPicked(null) });
  const visibility = useAction((a: { id: string; hidden: boolean }) => post<GenreSummary>(`/api/admin/genres/${enc(a.id)}/visibility`, { hidden: a.hidden }), { invalidate: ['/api/admin/genres'], onDone: (g) => toast(g.hidden ? '已停用' : '已恢复', 'ok') });
  const current = q.data?.find((g) => g.id === (picked ?? q.data?.[0]?.id));
  const idOk = form ? /^[a-z0-9][a-z0-9-]*$/.test(form.id) : false;
  // 没有书在用、也没有包继承 → 可以删除（内置包也可以）；否则只能停用
  const extendedBy = current ? (q.data ?? []).filter((g) => g.extends.includes(current.id)) : [];
  const deletable = !!current && current.books === 0 && extendedBy.length === 0;
  const keepReason = current && !deletable ? [current.books > 0 ? `${current.books} 本书在用` : '', extendedBy.length > 0 ? `被 ${extendedBy.map((g) => g.name).join('、')} 继承` : ''].filter(Boolean).join('，') : '';

  async function onDelete(g: GenreSummary) {
    const ok = await confirmDialog({ title: `删除题材包 ${g.name}？`, body: `目录移到回收站，不会自动恢复。${g.builtin ? '内置包删除后不会再被拷回。' : ''}`, danger: true, okText: '删除' });
    if (ok) remove.mutate(g.id);
  }
  async function onHide(g: GenreSummary) {
    const ok = await confirmDialog({ title: `停用题材包 ${g.name}？`, body: `停用后不再出现在开书页和自动开书里；已有的 ${g.books} 本书照常使用，文件保留。`, okText: '停用' });
    if (ok) visibility.mutate({ id: g.id, hidden: true });
  }

  return (
    <Q q={q}>
      {(list) => (
        <div className="grid md:grid-cols-[220px_1fr] gap-4">
          <div className="space-y-2">
            <Button variant="primary" className="w-full" onClick={() => setForm({ id: '', name: '', copyFrom: '' })}>
              新建题材包
            </Button>
            <ul className="bg-panel border border-line rounded-lg divide-y divide-line">
              {list.map((g) => (
                <li key={g.id}>
                  <button type="button" onClick={() => setPicked(g.id)} className={cx('w-full text-left px-3 py-2 text-sm hover:bg-panel2', current?.id === g.id && 'bg-panel2 font-medium')}>
                    {g.name}
                    <span className="block text-xs text-faint">
                      {g.books} 本{g.hidden ? ' · 已停用' : ''}
                      {effectiveAuto(g).enabled ? ' · 自动开书' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {current ? (
            <div className="space-y-4 min-w-0">
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
                      <Button size="sm" busy={visibility.isPending} onClick={() => void onHide(current)}>
                        停用
                      </Button>
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
                {keepReason && <p className="text-xs text-faint mt-1">不能删除：{keepReason}；可以停用。</p>}
              </Card>
              <GenreAutoForm key={`${current.id}-${JSON.stringify(current.auto)}`} g={current} settings={settings.data} />
              <InstructionWorkbench key={current.id} scope={`genre:${current.id}`} genre={current.id} />
            </div>
          ) : (
            <Notice>还没有题材包。</Notice>
          )}
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
                    {list.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </Modal>
          )}
        </div>
      )}
    </Q>
  );
}

export function GenresPage() {
  const [tab, setTab] = useState<Tab>('packs');
  return (
    <Page wide>
      <PageHeader title="题材与指令" sub="指令层序：内置 → 全局 → 题材 → 本书；本书层最后加载、优先级最高。" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'packs', label: '题材包' },
          { id: 'global', label: '全局层' },
          { id: 'length', label: '篇幅档' },
        ]}
      />
      {tab === 'packs' && <PacksTab />}
      {tab === 'global' && <InstructionWorkbench key="global" scope="global" />}
      {tab === 'length' && (
        <div className="space-y-3">
          <Notice>
            篇幅档的内置指引（短篇 / 中篇 / 长篇 / 超长篇）在这个版本里只能查看、不能改。想给某一档加要求，写在能改的层里：题材包的 AGENTS.md，或者某本书的 instructions/AGENTS.md，例如“本书是长篇：……”。全局层对所有篇幅都生效。
          </Notice>
          <InstructionWorkbench key="length" scope="builtin" filter={isLengthFile} preview={false} />
        </div>
      )}
    </Page>
  );
}
