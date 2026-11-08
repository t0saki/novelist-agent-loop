/** 质量页（DESIGN §9.2）：审计前沿、弧指纹相似度、extractor 召回统计。Owner: lane H。 */
import type { BookQuality } from '@novelist/shared';
import { enc } from '../../../api/client';
import { useApi } from '../../../api/hooks';
import { Badge, Card, Empty, Q } from '../../../components/ui';
import { fmtRel } from '../../../lib/format';

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function QualityTab({ slug }: { slug: string }) {
  const q = useApi<BookQuality>(`/api/admin/books/${enc(slug)}/quality`);
  return (
    <Q q={q}>
      {(d) => (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Card title="已验收">第 {d.frontiers.accepted} 章</Card>
            <Card title="已审计">第 {d.frontiers.audited} 章</Card>
            <Card title="已发布">第 {d.frontiers.published} 章</Card>
          </div>
          <Card title="弧指纹相似度">
            {d.arcs.length === 0 ? (
              <Empty>还没有完成的弧。</Empty>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-sub text-left">
                  <tr>
                    <th className="py-1">弧</th>
                    <th>与上一弧</th>
                    <th>最相似的历史弧</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {d.arcs.map((a) => (
                    <tr key={a.arc} className="border-t border-line">
                      <td className="py-1.5">{a.arc}</td>
                      <td>{a.similarityToPrev === null ? '—' : <Badge tone={a.similarityToPrev > 0.8 ? 'warn' : 'neutral'}>{pct(a.similarityToPrev)}</Badge>}</td>
                      <td>{a.topMatch ? `${a.topMatch.arc}（${pct(a.topMatch.similarity)}）` : '—'}</td>
                      <td className="text-xs text-sub">{fmtRel(a.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title={`extractor 召回缺口（共 ${d.recallTotal} 处）`}>
            {d.recall.length === 0 ? (
              <Empty>没有记录到召回缺口。</Empty>
            ) : (
              <ul className="text-sm grid grid-cols-2 sm:grid-cols-4 gap-1">
                {d.recall.map((r) => (
                  <li key={r.chapter}>
                    {r.chapter}：{r.misses} 处
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="审计记录">
            {d.audits.length === 0 ? (
              <Empty>还没有审计记录。</Empty>
            ) : (
              <ul className="text-sm divide-y divide-line">
                {d.audits.map((a) => (
                  <li key={a.name} className="py-1.5 flex flex-wrap items-center gap-2">
                    <Badge tone={a.passed ? 'ok' : 'danger'}>{a.passed ? '通过' : '未通过'}</Badge>
                    <span>{a.kind}</span>
                    <span className="text-sub">
                      {a.range[0]}–{a.range[1]}
                    </span>
                    {(a.hard > 0 || a.soft > 0) && <span className="text-xs text-sub">hard {a.hard} · soft {a.soft}</span>}
                    <span className="text-xs text-sub ml-auto">{fmtRel(a.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </Q>
  );
}
