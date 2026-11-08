/**
 * 轻量 SVG 图表（单系列，无图表库）。规则：细柱、圆角数据端、次要网格、悬停出提示、总有表格视图。
 * 单系列不画图例（标题即系列名）。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Button, cx } from './ui';

export interface BarDatum {
  key: string;
  value: number;
  /** 提示框内的多行明细 */
  detail?: ReactNode;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

/** 横向条形：类目名长、可能很多时比竖柱好读 */
export function BarChart({ data, format, title, keyHeader = '项目' }: { data: BarDatum[]; format: (v: number) => string; title: string; keyHeader?: string }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const max = useMemo(() => niceMax(Math.max(0, ...data.map((d) => d.value))), [data]);
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs text-sub">{title}</span>
        <Button size="sm" variant="ghost" onClick={() => setTable((t) => !t)}>
          {table ? '图表' : '表格'}
        </Button>
      </figcaption>
      {table ? (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>{keyHeader}</th>
                <th className="text-right">数值</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.key}>
                  <td>{d.key}</td>
                  <td className="text-right tabular-nums">{format(d.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-1.5" role="img" aria-label={title}>
          {data.map((d) => (
            <div key={d.key} className="grid grid-cols-[minmax(4rem,9rem)_1fr_auto] items-center gap-2 text-xs relative py-0.5" onMouseEnter={() => setHover(d.key)} onMouseLeave={() => setHover(null)}>
              <span className="text-sub truncate" title={d.key}>
                {d.key}
              </span>
              <div className="h-3">
                <div className={cx('h-3 bg-chart rounded-r', hover && hover !== d.key && 'opacity-50')} style={{ width: `${Math.max(d.value > 0 ? 0.5 : 0, (d.value / max) * 100)}%` }} />
              </div>
              <span className="tabular-nums text-ink">{format(d.value)}</span>
              {hover === d.key && d.detail && <div className="absolute z-10 left-24 top-full bg-panel border border-line rounded-md shadow-lg px-2.5 py-1.5 text-xs pointer-events-none">{d.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

/** 里程碑：计划位置 vs 实际字数位置。x = 计划位置，y = 实际位置，落在对角线上最好。 */
export function MilestoneChart({ points }: { points: { id: string; at: number; position: number; done: boolean }[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const W = 420;
  const H = 220;
  const P = { l: 36, r: 10, t: 10, b: 26 };
  const sx = (v: number) => P.l + v * (W - P.l - P.r);
  const sy = (v: number) => H - P.b - v * (H - P.t - P.b);
  const norm = (v: number) => Math.max(0, Math.min(1, v > 1 ? v / 100 : v));
  const active = points.find((p) => p.id === hover);
  return (
    <figure>
      <figcaption className="text-xs text-sub mb-1">里程碑：计划位置 vs 实际字数位置（越贴近对角线越准）</figcaption>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-lg" role="img" aria-label="里程碑位置图">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} stroke="var(--line)" strokeWidth={1} />
              <text x={P.l - 5} y={sy(t) + 3} textAnchor="end" fontSize={10} fill="var(--faint)">
                {t * 100}%
              </text>
              <text x={sx(t)} y={H - 10} textAnchor="middle" fontSize={10} fill="var(--faint)">
                {t * 100}%
              </text>
            </g>
          ))}
          <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="var(--faint)" strokeWidth={1} strokeDasharray="4 4" />
          {points.map((p) => (
            <g key={p.id} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)}>
              <circle cx={sx(norm(p.at))} cy={sy(norm(p.position))} r={12} fill="transparent" />
              <circle cx={sx(norm(p.at))} cy={sy(norm(p.position))} r={5} fill={p.done ? 'var(--chart)' : 'var(--panel)'} stroke="var(--chart)" strokeWidth={2} />
            </g>
          ))}
        </svg>
        {active && (
          <div className="absolute top-1 right-1 bg-panel border border-line rounded-md shadow px-2 py-1 text-xs">
            {active.id}：计划 {Math.round(norm(active.at) * 100)}% · 实际 {Math.round(norm(active.position) * 100)}% · {active.done ? '已达成' : '未达成'}
          </div>
        )}
      </div>
      <div className="flex gap-4 text-xs text-sub mt-1">
        <span className="inline-flex items-center gap-1">
          <span className="size-2.5 rounded-full bg-chart inline-block" />
          已达成
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2.5 rounded-full border-2 border-chart inline-block" />
          未达成
        </span>
      </div>
    </figure>
  );
}
