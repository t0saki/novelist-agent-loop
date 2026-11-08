/** 管理端多页共用的展示组件：run/task 表格、前沿条、发布表单、可行性报告。Owner: lane H。 */
import { Link } from '@tanstack/react-router';
import type { BookSummary, FeasibilityReport, Frontiers, PublishConfig, RunRow, TaskRow } from '@novelist/shared';
import { post } from '../../api/client';
import { useAction } from '../../api/hooks';
import { fmtNum, fmtRel, runDuration } from '../../lib/format';
import { RUN_STATE, TASK_STATE, ROLE_LABEL } from '../../lib/labels';
import { Badge, Button, Empty, Field, Input, Notice, Select, Toggle } from '../ui';

export function RunTable({ rows, showBook = true }: { rows: RunRow[]; showBook?: boolean }) {
  if (rows.length === 0) return <Empty>没有 run。</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>任务</th>
            {showBook && <th>书</th>}
            <th>角色</th>
            <th>Harness / 模型</th>
            <th>状态</th>
            <th>开始</th>
            <th>耗时</th>
            <th className="text-right">Token 入/出</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to="/admin/runs/$id" params={{ id: r.id }} className="text-accent hover:underline">
                  {r.kind}
                </Link>
                <span className="text-xs text-faint"> #{r.attempt}</span>
              </td>
              {showBook && <td className="text-sub">{r.bookSlug ?? '—'}</td>}
              <td className="whitespace-nowrap">{ROLE_LABEL[r.role] ?? r.role}</td>
              <td className="text-xs">
                {r.harness}
                <span className="block text-faint">{r.modelReported ?? r.model ?? '—'}</span>
              </td>
              <td>
                <Badge tone={RUN_STATE[r.state]?.tone}>{RUN_STATE[r.state]?.label ?? r.state}</Badge>
                {r.errorClass && (
                  <span className="block mt-0.5">
                    <Badge tone="danger">{r.errorClass}</Badge>
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap text-sub">{fmtRel(r.startedAt)}</td>
              <td className="whitespace-nowrap text-sub tabular-nums">{runDuration(r.startedAt, r.endedAt)}</td>
              <td className="text-right tabular-nums text-sub whitespace-nowrap">
                {fmtNum(r.usage.input)} / {fmtNum(r.usage.output)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const RETRYABLE: TaskRow['state'][] = ['failed', 'blocked', 'stale', 'cancelled'];
const CANCELLABLE: TaskRow['state'][] = ['pending', 'ready', 'waiting', 'blocked', 'leased', 'running'];

export function TaskTable({ rows, showBook = true }: { rows: TaskRow[]; showBook?: boolean }) {
  const retry = useAction((id: string) => post(`/api/admin/tasks/${id}/retry`), { ok: '已重新排队', invalidate: ['/api/admin/tasks', '/api/admin/runs'] });
  const cancel = useAction((id: string) => post(`/api/admin/tasks/${id}/cancel`), { ok: '已取消', invalidate: ['/api/admin/tasks'] });
  if (rows.length === 0) return <Empty>没有任务。</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>类型</th>
            <th>目标</th>
            {showBook && <th>书</th>}
            <th>Lane</th>
            <th>状态</th>
            <th>重试</th>
            <th>更新</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="whitespace-nowrap">{t.kind}</td>
              <td className="text-sub">{t.target}</td>
              {showBook && <td className="text-sub">{t.bookSlug ?? '—'}</td>}
              <td>{t.lane}</td>
              <td>
                <Badge tone={TASK_STATE[t.state]?.tone}>{TASK_STATE[t.state]?.label ?? t.state}</Badge>
                {t.waitReason && <span className="block text-xs text-faint mt-0.5">{t.waitReason}</span>}
                {t.lastErrorClass && <span className="block text-xs text-danger mt-0.5">{t.lastErrorClass}</span>}
              </td>
              <td className="tabular-nums text-sub">
                {t.attempts}/{t.maxAttempts}
              </td>
              <td className="whitespace-nowrap text-sub">{fmtRel(t.updatedAt)}</td>
              <td className="whitespace-nowrap">
                {RETRYABLE.includes(t.state) && (
                  <Button size="sm" onClick={() => retry.mutate(t.id)}>
                    重试
                  </Button>
                )}
                {CANCELLABLE.includes(t.state) && (
                  <Button size="sm" variant="ghost" onClick={() => cancel.mutate(t.id)}>
                    取消
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 嵌套进度条：规划 ⊇ 验收 ⊇ 审计 ⊇ 发布，文字图例带数字。 */
export function FrontierBar({ f }: { f: Frontiers }) {
  const total = Math.max(f.cardsPlanned, f.accepted, 1);
  const width = (n: number) => `${Math.min(100, (n / total) * 100)}%`;
  const items: [string, number, string][] = [
    ['规划', f.cardsPlanned, 'bg-panel2 border border-line'],
    ['验收', f.accepted, 'bg-chart/30'],
    ['审计', f.audited, 'bg-chart/60'],
    ['发布', f.published, 'bg-chart'],
  ];
  return (
    <div>
      <div className="relative h-2.5 rounded-sm bg-panel2 overflow-hidden" role="img" aria-label={`规划 ${f.cardsPlanned}，验收 ${f.accepted}，审计 ${f.audited}，发布 ${f.published}`}>
        {items.slice(1).map(([label, n, cls]) => (
          <div key={label} className={`absolute inset-y-0 left-0 ${cls}`} style={{ width: width(n) }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-sub mt-1.5 tabular-nums">
        {items.map(([label, n, cls]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className={`size-2 inline-block rounded-sm ${cls}`} />
            {label} {n}
          </span>
        ))}
      </div>
    </div>
  );
}

export function WaitingNote({ book }: { book: Pick<BookSummary, 'waiting'> }) {
  if (!book.waiting) return null;
  return (
    <span className="text-xs text-warn">
      等待：{book.waiting.reason}
      {book.waiting.until && `（${fmtRel(book.waiting.until)}恢复）`}
    </span>
  );
}

export function PublishFields({ value, onChange }: { value: PublishConfig; onChange: (v: PublishConfig) => void }) {
  const set = <K extends keyof PublishConfig>(k: K, v: PublishConfig[K]) => onChange({ ...value, [k]: v });
  const int = (s: string, fallback: number) => {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const auto = value.lag === 'auto';
  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="发布模式" hint={value.mode === 'immediate' ? '立即模式下，弧审计发现的问题只能靠 override 和后文补圆。' : undefined}>
          <Select value={value.mode} onChange={(e) => set('mode', e.target.value as PublishConfig['mode'])}>
            <option value="scheduled">按排期（推荐）</option>
            <option value="immediate">验收后立即</option>
            <option value="manual">手动</option>
          </Select>
        </Field>
        <Field label="发布时刻（cron）" hint="默认每天 8 点、20 点">
          <Input value={value.cadence} onChange={(e) => set('cadence', e.target.value)} />
        </Field>
        <Field label="时区">
          <Input value={value.timezone} onChange={(e) => set('timezone', e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="每次发布章数">
          <Input type="number" min={1} value={value.per_slot} onChange={(e) => set('per_slot', Math.max(1, int(e.target.value, 1)))} />
        </Field>
        <Field label="发布滞后（章）" hint="自动 = max(当前弧长, 最小滞后)">
          <div className="flex gap-1">
            <Select value={auto ? 'auto' : 'n'} onChange={(e) => set('lag', e.target.value === 'auto' ? 'auto' : value.min_lag)} className="w-20 shrink-0">
              <option value="auto">自动</option>
              <option value="n">固定</option>
            </Select>
            {!auto && <Input type="number" min={value.min_lag} value={value.lag} onChange={(e) => set('lag', int(e.target.value, value.min_lag))} />}
          </div>
        </Field>
        <Field label="最小滞后（章）">
          <Input type="number" min={0} value={value.min_lag} onChange={(e) => set('min_lag', int(e.target.value, 15))} />
        </Field>
        <Field label="存稿低于（天）提醒">
          <Input type="number" min={0} step={0.5} value={value.low_buffer_days_alert} onChange={(e) => set('low_buffer_days_alert', Number(e.target.value) || 0)} />
        </Field>
        <Field label="存稿上限（章）" hint="超过后暂停生产">
          <Input type="number" min={1} value={value.max_buffer} onChange={(e) => set('max_buffer', Math.max(1, int(e.target.value, 60)))} />
        </Field>
        <Field label="恢复阈值（章）" hint="存稿降到此值恢复生产">
          <Input type="number" min={1} value={value.resume_buffer} onChange={(e) => set('resume_buffer', Math.max(1, int(e.target.value, 45)))} />
        </Field>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        <Toggle checked={value.require_audited} onChange={(v) => set('require_audited', v)} label="只发布已通过审计的章节" />
        <Toggle checked={value.freeze_on_publish} onChange={(v) => set('freeze_on_publish', v)} label="发布后冻结章节（后续修改走 override）" />
      </div>
      {value.resume_buffer >= value.max_buffer && <Notice tone="warn">恢复阈值应小于存稿上限，否则生产会反复启停。</Notice>}
    </div>
  );
}

export function FeasibilityView({ report }: { report: FeasibilityReport }) {
  return (
    <div className="space-y-3">
      {report.problems.length > 0 ? (
        <ul className="space-y-1">
          {report.problems.map((p) => (
            <li key={`${p.role}:${p.message}`} className="text-sm flex gap-2 items-start">
              <Badge tone={p.severity === 'error' ? 'danger' : p.severity === 'warning' ? 'warn' : 'info'}>{p.severity === 'error' ? '错误' : p.severity === 'warning' ? '警告' : '提示'}</Badge>
              <span>
                {p.role && <code className="text-xs mr-1">{p.role}</code>}
                {p.message}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Notice>路由可行，没有发现问题。</Notice>
      )}
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>角色</th>
              <th>Profile</th>
              <th>账号</th>
              <th>模型</th>
              <th>情况</th>
            </tr>
          </thead>
          <tbody>
            {report.roles.map((r) => (
              <tr key={r.role}>
                <td className="whitespace-nowrap">{ROLE_LABEL[r.role] ?? r.role}</td>
                <td>{r.profile ?? <Badge tone="danger">无可用</Badge>}</td>
                <td className="text-sub">{r.account ?? '—'}</td>
                <td className="text-xs text-sub">{r.model ?? '—'}</td>
                <td className="text-xs">
                  {r.degraded.map((d) => (
                    <span key={`${d.from}-${d.to}`} className="block text-warn">
                      降级 {d.from} → {d.to}：{d.reason}
                    </span>
                  ))}
                  {r.sameVendorAsWriter && <span className="block text-warn">与主笔同厂商</span>}
                  {r.waitUntil && <span className="block text-sub">等到 {fmtRel(r.waitUntil)}</span>}
                  {r.reason && <span className="block text-sub">{r.reason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.chaptersPerWindow.length > 0 && (
        <div>
          <h3 className="text-xs text-sub mb-1">每窗口实测可写章数</h3>
          <ul className="text-sm space-y-0.5">
            {report.chaptersPerWindow.map((c) => (
              <li key={`${c.accountId}-${c.window}`}>
                {c.accountId} · {c.window}：{c.chapters === null ? '暂无数据' : `约 ${c.chapters} 章`} <span className="text-xs text-faint">{c.basis}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

