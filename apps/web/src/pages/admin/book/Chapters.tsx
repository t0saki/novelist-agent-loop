import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ChapterRow } from '@novelist/shared';
import { enc } from '../../../api/client';
import { usePaged } from '../../../api/hooks';
import { Badge, Card, Empty, ErrorBox, Input, Loading, LoadMore, Toggle } from '../../../components/ui';
import { fmtRel } from '../../../lib/format';
import { CHAPTER_STATE, VERDICT } from '../../../lib/labels';

const PROBLEM = new Set(['held', 'blocked', 'needs_repair']);

export function ChaptersTab({ slug }: { slug: string }) {
  const q = usePaged<ChapterRow>(`/api/admin/books/${enc(slug)}/chapters`, 200);
  const [text, setText] = useState('');
  const [problems, setProblems] = useState(false);
  const rows = useMemo(() => q.items.filter((c) => (!text || c.title.includes(text) || String(c.no) === text) && (!problems || PROBLEM.has(c.state) || c.degraded || c.debts > 0)), [q.items, text, problems]);
  return (
    <Card
      padded={false}
      title={`章节（已加载 ${q.items.length}）`}
      actions={
        <>
          <Toggle checked={problems} onChange={setProblems} label="只看有问题的" />
          <Input className="w-36" placeholder="章号或标题" value={text} onChange={(e) => setText(e.target.value)} aria-label="搜索章节" />
        </>
      }
    >
      {q.error ? (
        <ErrorBox error={q.error} retry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>没有章节。</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>章</th>
                <th>标题</th>
                <th>状态</th>
                <th>评审</th>
                <th className="text-right">字数</th>
                <th className="text-right">修订</th>
                <th>发布</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.no}>
                  <td className="tabular-nums text-sub">{c.no}</td>
                  <td>
                    <Link to="/admin/books/$slug/chapters/$no" params={{ slug, no: String(c.no) }} className="text-accent hover:underline">
                      {c.title}
                    </Link>
                  </td>
                  <td>
                    <span className="inline-flex flex-wrap gap-1">
                      <Badge tone={CHAPTER_STATE[c.state]?.tone}>{CHAPTER_STATE[c.state]?.label ?? c.state}</Badge>
                      {c.degraded && <Badge tone="warn">降级</Badge>}
                      {c.debts > 0 && <Badge tone="warn">债 {c.debts}</Badge>}
                    </span>
                  </td>
                  <td>{c.verdict ? <Badge tone={VERDICT[c.verdict]?.tone}>{VERDICT[c.verdict]?.label ?? c.verdict}</Badge> : <span className="text-faint">—</span>}</td>
                  <td className="text-right tabular-nums text-sub">{c.cjk.toLocaleString('zh-CN')}</td>
                  <td className="text-right tabular-nums text-sub">{c.revisions}</td>
                  <td className="text-xs text-sub whitespace-nowrap">
                    {c.publishedAt ? fmtRel(c.publishedAt) : c.audited ? '已审计' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LoadMore hasNext={Boolean(q.hasNextPage)} busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
    </Card>
  );
}
