/** 新流程书的一句状态和累计花费（首页、书页共用；p2-plan §2.10）。 */
import type { V3Cost, V3Status } from '@novelist/shared';
import { Badge } from '../ui';
import { fmtNum } from '../../lib/format';
import { V3_STATUS_TONE } from '../../lib/labels';

const DOT: Record<string, string> = { accent: 'bg-accent', info: 'bg-info', warn: 'bg-warn', danger: 'bg-danger', ok: 'bg-ok', neutral: 'bg-faint' };

export function V3StatusLine({ status, compact }: { status: V3Status; compact?: boolean }) {
  const tone = V3_STATUS_TONE[status.kind] ?? 'neutral';
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-sm">
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${DOT[tone] ?? 'bg-faint'}`} aria-hidden />
        <span className={tone === 'danger' ? 'text-danger' : undefined}>{status.sentence}</span>
        {tone === 'danger' && !compact && <Badge tone="danger">等你处理</Badge>}
      </div>
      {!compact && status.notes.length > 0 && (
        <ul className="mt-1 text-xs text-sub space-y-0.5">
          {status.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function V3CostLine({ cost }: { cost: V3Cost }) {
  return (
    <span className="text-xs text-sub tabular-nums">
      {cost.runs} 次运行 · {cost.hours.toFixed(1)} 小时 · 输出 {fmtNum(cost.outputTokens)} token{cost.tokensPer1kChars !== null ? ` · 每千字 ${fmtNum(cost.tokensPer1kChars)}` : ''}
    </span>
  );
}
