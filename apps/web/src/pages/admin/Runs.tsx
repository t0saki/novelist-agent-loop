/** run 与任务列表。Owner: lane H。 */
import { useState } from 'react';
import { RUN_STATES, TASK_STATES, type RunRow, type TaskRow } from '@novelist/shared';
import { qs } from '../../api/client';
import { usePaged } from '../../api/hooks';
import { RunTable, TaskTable } from '../../components/admin/shared';
import { Card, Field, Input, Loading, LoadMore, Page, PageHeader, Select, Tabs, ErrorBox } from '../../components/ui';
import { RUN_STATE, TASK_STATE } from '../../lib/labels';

export function RunsPage() {
  const [tab, setTab] = useState<'runs' | 'tasks'>('runs');
  const [book, setBook] = useState('');
  const [state, setState] = useState('');
  const [harness, setHarness] = useState('');
  const runs = usePaged<RunRow>(`/api/admin/runs${qs({ book, state: tab === 'runs' ? state : '', harness })}`);
  const tasks = usePaged<TaskRow>(`/api/admin/tasks${qs({ book, state: tab === 'tasks' ? state : '' })}`);
  const q = tab === 'runs' ? runs : tasks;
  return (
    <Page wide>
      <PageHeader title="运行" />
      <Tabs
        value={tab}
        onChange={(t) => {
          setTab(t);
          setState('');
        }}
        tabs={[
          { id: 'runs', label: 'Run' },
          { id: 'tasks', label: '任务' },
        ]}
      />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <Field label="书（slug）">
          <Input value={book} onChange={(e) => setBook(e.target.value.trim())} />
        </Field>
        <Field label="状态">
          <Select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">全部</option>
            {tab === 'runs' ? RUN_STATES.map((s) => <option key={s} value={s}>{RUN_STATE[s].label}</option>) : TASK_STATES.map((s) => <option key={s} value={s}>{TASK_STATE[s].label}</option>)}
          </Select>
        </Field>
        {tab === 'runs' && (
          <Field label="Harness">
            <Input value={harness} onChange={(e) => setHarness(e.target.value.trim())} placeholder="codex、agy…" />
          </Field>
        )}
      </div>
      <Card padded={false}>
        {q.error ? <ErrorBox error={q.error} retry={() => void q.refetch()} /> : q.isLoading ? <Loading /> : tab === 'runs' ? <RunTable rows={runs.items} /> : <TaskTable rows={tasks.items} />}
        <LoadMore hasNext={Boolean(q.hasNextPage)} busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
      </Card>
    </Page>
  );
}
