import { useState } from 'react';
import type { Review, RunRow, TaskRow } from '@novelist/shared';
import { enc } from '../../../api/client';
import { usePaged } from '../../../api/hooks';
import { RunTable, TaskTable } from '../../../components/admin/shared';
import { Card, Empty, ErrorBox, Loading, LoadMore, Tabs } from '../../../components/ui';
import { ReviewView } from './ReviewView';

export function ReviewsTab({ slug }: { slug: string }) {
  const q = usePaged<Review>(`/api/admin/books/${enc(slug)}/reviews`);
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  if (q.isLoading) return <Loading />;
  if (q.items.length === 0) return <Empty>还没有评审记录。</Empty>;
  return (
    <div className="space-y-3">
      {q.items.map((r) => (
        <Card key={r.chapter}>
          <ReviewView review={r} />
        </Card>
      ))}
      <LoadMore hasNext={Boolean(q.hasNextPage)} busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
    </div>
  );
}

export function RunsTab({ slug }: { slug: string }) {
  const [tab, setTab] = useState<'runs' | 'tasks'>('runs');
  const runs = usePaged<RunRow>(`/api/admin/runs?book=${enc(slug)}`);
  const tasks = usePaged<TaskRow>(`/api/admin/tasks?book=${enc(slug)}`);
  const q = tab === 'runs' ? runs : tasks;
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'runs', label: 'Run' },
          { id: 'tasks', label: '任务' },
        ]}
      />
      <Card padded={false}>
        {q.error ? <ErrorBox error={q.error} retry={() => void q.refetch()} /> : q.isLoading ? <Loading /> : tab === 'runs' ? <RunTable rows={runs.items} showBook={false} /> : <TaskTable rows={tasks.items} showBook={false} />}
        <LoadMore hasNext={Boolean(q.hasNextPage)} busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
      </Card>
    </>
  );
}
