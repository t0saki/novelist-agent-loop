/** run 实时视图：SSE 事件流（文本、工具调用、文件写入、用量）+ 终止/重试。Owner: lane H。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { NEvent, RunDetail } from '@novelist/shared';
import { enc, get, openEventStream, post, qs } from '../../api/client';
import { useAction, useApi, useInvalidate } from '../../api/hooks';
import { Badge, Button, Card, confirmDialog, cx, Details, Empty, KV, Modal, Page, PageHeader, Pre, Q, Tabs, Toggle } from '../../components/ui';
import { fmtBytes, fmtNum, fmtTime, fmtUsd, runDuration } from '../../lib/format';
import { ACTIVE_RUN_STATES, ROLE_LABEL, RUN_STATE } from '../../lib/labels';
import { backfillAfter, buildTimeline, describeEvent, fileChanges, mergeEvents, sortedEvents, totalUsage, type TimelineItem } from '../../lib/runEvents';

const FLUSH_MS = 250;
/** 服务端 run 事件按 1s 批量落库；连流后再等一拍把订阅前尚未落库的事件补回来 */
const SETTLE_BACKFILL_MS = 1500;

/** 拉历史 + 订阅流，按 seq 去重；高频事件合并成每 250ms 一次渲染 */
function useRunEvents(id: string, live: boolean, onExit: () => void) {
  const store = useRef(new Map<number, NEvent>());
  const [events, setEvents] = useState<NEvent[]>([]);
  const [status, setStatus] = useState<'connecting' | 'open' | 'error' | 'closed'>('connecting');
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换 run 时清空事件
  useEffect(() => {
    store.current = new Map();
    setEvents([]);
  }, [id]);

  const flush = useCallback(() => setEvents(sortedEvents(store.current)), []);

  const backfill = useCallback(async () => {
    let after = backfillAfter(store.current);
    // 流重连期间丢的事件靠 after 补齐；每页 5000，循环到取完
    for (let guard = 0; guard < 20; guard++) {
      const page = await get<NEvent[]>(`/api/admin/runs/${enc(id)}/events${qs({ after, limit: 5000 })}`);
      if (page.length === 0) break;
      mergeEvents(store.current, page);
      after = page[page.length - 1]!.seq;
      if (page.length < 5000) break;
    }
    flush();
  }, [id, flush]);

  useEffect(() => {
    void backfill().catch(() => undefined);
    if (!live) {
      setStatus('closed');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hadError = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer === null)
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, FLUSH_MS);
    };
    const close = openEventStream(
      `/api/admin/runs/${enc(id)}/stream`,
      (e) => {
        if (e.type === 'run_event' && e.runId === id) {
          store.current.set(e.event.seq, e.event);
          schedule();
        } else if (e.type === 'run_exit' && e.runId === id) {
          setStatus('closed');
          void backfill().catch(() => undefined);
          onExitRef.current();
        }
      },
      (s) => {
        setStatus(s);
        if (s === 'error') hadError = true;
        else if (s === 'open' && hadError) {
          hadError = false;
          void backfill().catch(() => undefined);
        }
        if (s === 'open') {
          if (settleTimer !== null) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => void backfill().catch(() => undefined), SETTLE_BACKFILL_MS);
        }
      },
    );
    return () => {
      close();
      if (timer !== null) clearTimeout(timer);
      if (settleTimer !== null) clearTimeout(settleTimer);
    };
  }, [id, live, backfill, flush]);

  return { events, status };
}

export function RunDetailPage({ id }: { id: string }) {
  const path = `/api/admin/runs/${enc(id)}`;
  const q = useApi<RunDetail>(path);
  const run = q.data;
  const live = run ? ACTIVE_RUN_STATES.includes(run.state) : false;
  const invalidate = useInvalidate();
  const onExit = useCallback(() => void invalidate(path), [invalidate, path]);
  const { events, status } = useRunEvents(id, live, onExit);
  const [tab, setTab] = useState<'stream' | 'files' | 'info'>('stream');

  const kill = useAction(() => post(`${path}/kill`), { ok: '已发送终止信号', invalidate: [path, '/api/admin/runs'] });
  const retry = useAction((taskId: string) => post(`/api/admin/tasks/${enc(taskId)}/retry`), { ok: '已重新排队', invalidate: ['/api/admin/tasks', '/api/admin/runs'] });
  const usage = useMemo(() => totalUsage(events), [events]);

  async function confirmKill() {
    if (await confirmDialog({ title: '终止这个 run？', body: '任务会按错误处理重新调度或进入 Inbox。', danger: true, okText: '终止' })) kill.mutate();
  }

  return (
    <Page wide>
      <Q q={q}>
        {(r) => (
          <>
            <PageHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {r.kind}
                  <Badge tone={RUN_STATE[r.state]?.tone}>{RUN_STATE[r.state]?.label ?? r.state}</Badge>
                  {r.errorClass && <Badge tone="danger">{r.errorClass}</Badge>}
                  {live && <Badge tone={status === 'open' ? 'ok' : 'warn'}>{status === 'open' ? '实时' : '连接中'}</Badge>}
                </span>
              }
              sub={
                <>
                  {r.bookSlug && (
                    <Link to="/admin/books/$slug/$tab" params={{ slug: r.bookSlug, tab: 'runs' }} className="hover:underline">
                      {r.bookSlug}
                    </Link>
                  )}{' '}
                  · {ROLE_LABEL[r.role] ?? r.role} · {r.profileId} · {r.harness} {r.harnessVersion} · {r.modelReported ?? r.model ?? '—'}
                </>
              }
              actions={
                live ? (
                  <Button variant="danger" busy={kill.isPending} onClick={() => void confirmKill()}>
                    终止
                  </Button>
                ) : (
                  <Button busy={retry.isPending} onClick={() => retry.mutate(r.taskId)}>
                    重试任务
                  </Button>
                )
              }
            />
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-sm">
              <Mini label="耗时" value={runDuration(r.startedAt, r.endedAt)} />
              <Mini label="输入 Token" value={fmtNum(Math.max(usage.input, r.usage.input))} />
              <Mini label="缓存" value={fmtNum(Math.max(usage.cached, r.usage.cached))} />
              <Mini label="输出 Token" value={fmtNum(Math.max(usage.output, r.usage.output))} />
              <Mini label="费用" value={fmtUsd(usage.costUsd ?? r.usage.costUsd)} />
            </div>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'stream', label: `事件流（${events.length}）` },
                { id: 'files', label: `文件（${r.files.length}）` },
                { id: 'info', label: '详情' },
              ]}
            />
            {tab === 'stream' && <EventStream events={events} live={live} />}
            {tab === 'files' && <RunFiles run={r} events={events} />}
            {tab === 'info' && <RunInfo run={r} />}
          </>
        )}
      </Q>
    </Page>
  );
}

const Mini = ({ label, value }: { label: string; value: string }) => (
  <div className="bg-panel border border-line rounded-lg px-3 py-2">
    <div className="text-xs text-sub">{label}</div>
    <div className="tabular-nums font-medium">{value}</div>
  </div>
);

function EventStream({ events, live }: { events: NEvent[]; live: boolean }) {
  const [thinking, setThinking] = useState(false);
  const [usageRows, setUsageRows] = useState(false);
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const shown = useMemo(() => timeline.filter((i) => (i.kind === 'text' && i.channel === 'thinking' ? thinking : i.kind === 'event' && i.event.t === 'usage' ? usageRows : true)), [timeline, thinking, usageRows]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 有新事件就滚到底
  useEffect(() => {
    if (live && follow) bottom.current?.scrollIntoView({ block: 'end' });
  }, [shown, live, follow]);

  return (
    <div>
      <div className="flex flex-wrap gap-4 mb-3">
        <Toggle checked={thinking} onChange={setThinking} label="显示思考" />
        <Toggle checked={usageRows} onChange={setUsageRows} label="显示用量事件" />
        {live && <Toggle checked={follow} onChange={setFollow} label="跟随最新" />}
      </div>
      {shown.length === 0 ? <Empty>{live ? '等待事件…' : '没有事件记录。'}</Empty> : <div className="space-y-2">{shown.map((i) => <Row key={i.key} item={i} />)}</div>}
      <div ref={bottom} />
    </div>
  );
}

function Row({ item }: { item: TimelineItem }) {
  if (item.kind === 'text')
    return <div className={cx('text-sm whitespace-pre-wrap leading-7', item.channel === 'thinking' ? 'text-faint italic border-l-2 border-line pl-3' : '')}>{item.text}</div>;
  if (item.kind === 'tool') {
    const { call, result } = item;
    const target = call.paths?.join(', ') || call.command;
    return (
      <div className="bg-panel border border-line rounded-md px-3 py-1.5 text-xs flex items-start gap-2">
        <Badge tone={result === null ? 'info' : result.ok ? 'ok' : 'danger'}>{result === null ? '进行中' : result.ok ? '成功' : '失败'}</Badge>
        <div className="min-w-0">
          <span className="font-medium">{call.name}</span> <span className="text-faint">{call.kind}</span>
          {target && <code className="block text-sub truncate">{target}</code>}
          {result?.error && <span className="block text-danger">{result.error}</span>}
        </div>
      </div>
    );
  }
  const d = describeEvent(item.event);
  return (
    <div className="flex items-start gap-2 text-xs">
      <Badge tone={d.tone}>{d.label}</Badge>
      <span className="text-sub min-w-0">{d.detail}</span>
    </div>
  );
}

function RunFiles({ run, events }: { run: RunDetail; events: NEvent[] }) {
  const [open, setOpen] = useState<{ area: string; path: string } | null>(null);
  const changes = useMemo(() => fileChanges(events), [events]);
  const content = useApi<string>(open ? `/api/admin/runs/${enc(run.id)}/file${qs(open)}` : null);
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card title="产物与日志" padded={false}>
        {run.files.length === 0 ? (
          <Empty>暂无文件。</Empty>
        ) : (
          <ul>
            {run.files.map((f) => (
              <li key={`${f.area}/${f.path}`}>
                <button type="button" onClick={() => setOpen({ area: f.area, path: f.path })} className="w-full text-left flex items-center gap-2 px-4 py-1.5 text-sm hover:bg-panel2">
                  <Badge>{f.area}</Badge>
                  <code className="text-xs truncate flex-1">{f.path}</code>
                  <span className="text-xs text-faint shrink-0">{fmtBytes(f.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="文件写入事件" padded={false}>
        {changes.length === 0 ? (
          <Empty>agent 还没有写文件。</Empty>
        ) : (
          <ul>
            {changes.map((c) => (
              <li key={c.seq} className="flex items-center gap-2 px-4 py-1.5 text-xs">
                <Badge tone={c.ok ? 'ok' : 'danger'}>{{ add: '新建', update: '修改', delete: '删除' }[c.op]}</Badge>
                <code className="truncate">{c.path}</code>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {open && (
        <Modal wide title={open.path} onClose={() => setOpen(null)}>
          <Q q={content}>{(text) => <Pre className="max-h-[70vh]">{typeof text === 'string' ? text : JSON.stringify(text, null, 2)}</Pre>}</Q>
        </Modal>
      )}
    </div>
  );
}

function RunInfo({ run }: { run: RunDetail }) {
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card title="运行参数">
        <KV
          items={[
            ['Run ID', <code key="id" className="text-xs">{run.id}</code>],
            ['任务', <code key="t" className="text-xs">{run.taskId}</code>],
            ['尝试', run.attempt],
            ['账号', run.accountId ?? '—'],
            ['隔离', run.isolation],
            ['开始', fmtTime(run.startedAt)],
            ['结束', fmtTime(run.endedAt)],
            ['退出码', run.exitCode ?? '—'],
            ['越权次数', run.denials],
          ]}
        />
        {run.argvPreview.length > 0 && (
          <div className="mt-3">
            <Details summary="启动命令">
              <Pre>{run.argvPreview.join(' \\\n  ')}</Pre>
            </Details>
          </div>
        )}
      </Card>
      <Card title="指令 nonce 回显">
        {run.nonceReport && run.nonceReport.length > 0 ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>层</th>
                <th>头</th>
                <th>尾</th>
              </tr>
            </thead>
            <tbody>
              {run.nonceReport.map((n) => (
                <tr key={n.layer}>
                  <td>{n.layer}</td>
                  <td>
                    <Badge tone={n.head ? 'ok' : 'danger'}>{n.head ? '有' : '缺失'}</Badge>
                  </td>
                  <td>
                    <Badge tone={n.tail ? 'ok' : 'danger'}>{n.tail ? '有' : '缺失'}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>暂无 nonce 报告。</Empty>
        )}
      </Card>
      {run.outcome && (
        <Card title="Outcome" className="lg:col-span-2">
          <Pre className="max-h-96">{JSON.stringify(run.outcome, null, 2)}</Pre>
        </Card>
      )}
    </div>
  );
}
