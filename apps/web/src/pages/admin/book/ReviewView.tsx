import type { Review } from '@novelist/shared';
import { Badge, Notice } from '../../../components/ui';
import { VERDICT } from '../../../lib/labels';

export function ReviewView({ review: r }: { review: Review }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={VERDICT[r.verdict]?.tone}>{VERDICT[r.verdict]?.label ?? r.verdict}</Badge>
        <span className="text-xs text-sub">
          {r.chapter} · {r.tier} · 修订 {r.revisions} 次
        </span>
        {Object.entries(r.scores).map(([k, v]) => (
          <span key={k} className="text-xs text-sub tabular-nums">
            {k} {v}
          </span>
        ))}
      </div>
      {r.degraded.length > 0 && (
        <Notice tone="warn">
          {r.degraded.map((d) => (
            <div key={`${d.role}-${d.to}`}>
              {d.role} 降级：{d.from} → {d.to}（{d.reason}）
            </div>
          ))}
        </Notice>
      )}
      {r.findings.length > 0 && (
        <ul className="space-y-2">
          {r.findings.map((f) => (
            <li key={f.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={f.severity === 'hard' ? 'danger' : 'warn'}>{f.severity === 'hard' ? '硬伤' : '软问题'}</Badge>
                <span className="text-xs text-faint">{f.category}</span>
                {f.conflicts_with_author_layer && <Badge tone="info">与作者层冲突，已忽略</Badge>}
              </div>
              <p className="mt-0.5">{f.message}</p>
              {f.quote && <blockquote className="text-xs text-sub border-l-2 border-line pl-2 mt-1">{f.quote}</blockquote>}
              {f.suggestion && <p className="text-xs text-sub mt-1">建议：{f.suggestion}</p>}
            </li>
          ))}
        </ul>
      )}
      {r.continuity_flags.length > 0 && (
        <ul className="space-y-1.5">
          {r.continuity_flags.map((f) => (
            <li key={`${f.kind}:${f.quote}`} className="text-sm">
              <Badge tone="warn">{f.kind}</Badge> {f.message}
              <blockquote className="text-xs text-sub border-l-2 border-line pl-2 mt-1">{f.quote}</blockquote>
            </li>
          ))}
        </ul>
      )}
      {r.reviewers.length > 0 && <p className="text-xs text-faint">评审：{r.reviewers.map((x) => `${x.role}（${x.profile}）`).join('、')}</p>}
    </div>
  );
}
