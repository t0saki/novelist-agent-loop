/** 管理端多页共用的展示组件：运行表格。 */
import { Link } from '@tanstack/react-router';
import type { RunRow } from '@novelist/shared';
import { fmtNum, fmtRel, runDuration } from '../../lib/format';
import { RUN_STATE, taskKindLabel } from '../../lib/labels';
import { Badge, Empty } from '../ui';

export function RunTable({ rows, showBook = true }: { rows: RunRow[]; showBook?: boolean }) {
  if (rows.length === 0) return <Empty>没有运行。</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>种类</th>
            {showBook && <th>书</th>}
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
                  {taskKindLabel(r.kind)}
                </Link>
                <span className="text-xs text-faint"> #{r.attempt}</span>
              </td>
              {showBook && <td className="text-sub">{r.bookSlug ?? '—'}</td>}
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
