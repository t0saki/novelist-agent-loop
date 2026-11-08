/** 书设置：常用表单（直接改 book.yaml 草稿）+ 原始 YAML + 发布配置 + 路由可行性。Owner: lane H。 */
import { useState } from 'react';
import { QUALITY_TIERS, type BookConfigDoc, type BookOverview, type FeasibilityReport, type Profile, type PublishConfig, type PublishOverview, type RoutingPreset } from '@novelist/shared';
import { enc, put } from '../../../api/client';
import { useAction, useApi } from '../../../api/hooks';
import { CodeEditor } from '../../../components/CodeEditor';
import { FeasibilityView, PublishFields } from '../../../components/admin/shared';
import { Badge, Button, Card, Field, Input, Notice, Q, Select, Toggle } from '../../../components/ui';
import { toast } from '../../../components/toast';
import { fmtCjk } from '../../../lib/format';
import { TIER_INFO } from '../../../lib/labels';
import { getYaml, parseRange, setYaml } from '../../../lib/yamlEdit';

const OPTIN: [string, string, boolean?][] = [
  ['bakeoff', '多写手比稿'],
  ['heldout', '留出审计'],
  ['formatcheck', '模型格式检查'],
  ['pairwise_regression', '成对回归'],
  ['deslop', '去模板腔'],
  // 下面四项后端还没有实现，开了也不生效，不能让人以为它们在工作
  ['cross_extract', '交叉抽取', true],
  ['plan_judge', '规划评委', true],
  ['model_window_audit', '模型版窗口审计', true],
  ['fresh_reader', '新读者视角审计', true],
];

export function SettingsTab({ book }: { book: BookOverview }) {
  const base = `/api/admin/books/${enc(book.slug)}`;
  const configQ = useApi<BookConfigDoc>(`${base}/config`);
  const publishQ = useApi<PublishOverview>(`${base}/publish`);
  const feasQ = useApi<FeasibilityReport>(`${base}/feasibility`);
  return (
    <div className="space-y-4">
      <Q q={configQ}>{(doc) => <ConfigEditor key={doc.sha} doc={doc} base={base} />}</Q>
      <Q q={publishQ}>{(p) => <PublishCard key={JSON.stringify(p.config)} overview={p} base={base} />}</Q>
      <Card title="路由可行性">
        <Q q={feasQ}>{(r) => <FeasibilityView report={r} />}</Q>
      </Card>
    </div>
  );
}

function PublishCard({ overview, base }: { overview: PublishOverview; base: string }) {
  const [value, setValue] = useState<PublishConfig>(overview.config);
  const save = useAction(() => put(`${base}/publish`, value), { ok: '已保存到 book.yaml', invalidate: [`${base}`, '/api/admin/schedule'] });
  return (
    <Card
      title="发布配置"
      actions={
        <Button size="sm" variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          保存
        </Button>
      }
    >
      <PublishFields value={value} onChange={setValue} />
    </Card>
  );
}

function ConfigEditor({ doc, base }: { doc: BookConfigDoc; base: string }) {
  const presets = useApi<RoutingPreset[]>('/api/admin/routing/presets');
  const profiles = useApi<Profile[]>('/api/admin/profiles');
  const [raw, setRaw] = useState(doc.raw);
  const dirty = raw !== doc.raw;
  const save = useAction(() => put<BookConfigDoc>(`${base}/config`, { raw, baseSha: doc.sha }), {
    invalidate: [base],
    onDone: (r) => {
      if (r.errors.length === 0) toast('已保存并提交', 'ok');
    },
  });
  const p = doc.parsed;
  const errors = save.data?.errors.length ? save.data.errors : doc.errors;

  const update = (path: string[], value: string | null) => {
    const next = setYaml(raw, path, value);
    if (next === null) toast(`${path.join('.')} 的写法太复杂，请直接在下方 YAML 里改`, 'danger');
    else setRaw(next);
  };
  const scalar = (path: string[], fallback: string) => getYaml(raw, path) ?? fallback;
  const numberField = (path: string[], label: string, fallback: number | undefined, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" min={0} value={getYaml(raw, path) ?? ''} placeholder={fallback === undefined ? '未设置' : String(fallback)} onChange={(e) => update(path, e.target.value === '' ? null : e.target.value)} />
    </Field>
  );
  const rangeField = (key: 'volumes' | 'chapters_per_volume', label: string) => {
    const current = parseRange(getYaml(raw, ['scale', key])) ?? p?.scale[key] ?? [0, 0];
    const write = (a: number, b: number) => update(['scale', key], `[${a}, ${b}]`);
    return (
      <>
        <Field label={`${label} 最少`}>
          <Input type="number" min={1} value={current[0]} onChange={(e) => write(Number(e.target.value) || 0, current[1])} />
        </Field>
        <Field label={`${label} 最多`}>
          <Input type="number" min={1} value={current[1]} onChange={(e) => write(current[0], Number(e.target.value) || 0)} />
        </Field>
      </>
    );
  };
  const target = Number(scalar(['scale', 'target_cjk'], String(p?.scale.target_cjk ?? 0)));

  return (
    <div className="space-y-4">
      <Card title="常用设置" actions={dirty && <span className="text-xs text-warn">未保存</span>}>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="质量档">
            <Select value={scalar(['tier'], p?.tier ?? 'standard')} onChange={(e) => update(['tier'], e.target.value)}>
              {QUALITY_TIERS.map((t) => (
                <option key={t} value={t}>
                  {TIER_INFO[t].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="关键章质量档">
            <Select value={scalar(['tiers', 'key_chapters'], p?.tiers.key_chapters ?? 'standard')} onChange={(e) => update(['tiers', 'key_chapters'], e.target.value)}>
              {QUALITY_TIERS.map((t) => (
                <option key={t} value={t}>
                  {TIER_INFO[t].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="路由 Preset">
            <Select value={getYaml(raw, ['routing', 'preset']) ?? ''} onChange={(e) => update(['routing', 'preset'], e.target.value || null)}>
              <option value="">跟随系统</option>
              {presets.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="主笔 Profile">
            <Select value={getYaml(raw, ['routing', 'writer_profile']) ?? ''} onChange={(e) => update(['routing', 'writer_profile'], e.target.value || null)}>
              <option value="">路由默认</option>
              {profiles.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.id}
                </option>
              ))}
            </Select>
          </Field>
          {numberField(['scale', 'target_cjk'], '目标字数', p?.scale.target_cjk, Number.isFinite(target) ? fmtCjk(target) : undefined)}
          {numberField(['scale', 'hard_max_cjk'], '硬上限', p?.scale.hard_max_cjk)}
          {rangeField('volumes', '卷数')}
          {rangeField('chapters_per_volume', '每卷章数')}
          {numberField(['scale', 'chapter_length', 'min'], '单章 最短', p?.scale.chapter_length?.min)}
          {numberField(['scale', 'chapter_length', 'target'], '单章 目标', p?.scale.chapter_length?.target)}
          {numberField(['scale', 'chapter_length', 'max'], '单章 最长', p?.scale.chapter_length?.max)}
          {numberField(['budgets', 'priority'], '调度优先级', p?.budgets.priority)}
          {numberField(['budgets', 'monthly_usd_cap'], '每月美元上限', p?.budgets.monthly_usd_cap)}
          {numberField(['budgets', 'chapters_per_day_cap'], '每日章数上限', p?.budgets.chapters_per_day_cap)}
          {numberField(['budgets', 'max_window_util_pct'], '窗口占用上限 %', p?.budgets.max_window_util_pct)}
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-4">
          {OPTIN.map(([key, label, unimplemented]) => {
            if (unimplemented) return <Toggle key={key} checked={false} disabled onChange={() => undefined} label={<>{label} <Badge tone="warn">尚未实现</Badge></>} hint={key} />;
            const on = scalar(['optin', key], String(p?.optin[key as keyof typeof p.optin] ?? false)) === 'true';
            return <Toggle key={key} checked={on} onChange={(v) => update(['optin', key], v ? 'true' : null)} label={label} hint={key} />;
          })}
        </div>
      </Card>

      <Card
        title="book.yaml"
        actions={
          <>
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => setRaw(doc.raw)}>
                撤销
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={!dirty} busy={save.isPending} onClick={() => save.mutate()}>
              保存
            </Button>
          </>
        }
      >
        {errors.length > 0 && (
          <div className="mb-3">
            <Notice tone="danger">
              {errors.map((e) => (
                <div key={`${e.path}-${e.message}`}>
                  <code className="text-xs">{e.path}</code>：{e.message}
                </div>
              ))}
            </Notice>
          </div>
        )}
        <CodeEditor value={raw} onChange={setRaw} lang="yaml" height="50vh" />
      </Card>
    </div>
  );
}
