/** v1 导入：预览 → 勾选 → 启动 → 看进度。Owner: lane H。 */
import { useEffect, useState } from 'react';
import type { V1ImportJob, V1ImportPreview } from '@novelist/shared';
import { enc, post } from '../../api/client';
import { useAction, useApi, useInvalidate } from '../../api/hooks';
import { Badge, Button, Card, Field, Input, Notice, Page, PageHeader, Pre, Toggle } from '../../components/ui';
import { fmtCjk } from '../../lib/format';

export function ImportPage() {
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [preview, setPreview] = useState<V1ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [readers, setReaders] = useState(true);
  const [themes, setThemes] = useState(true);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [bootstrapExtract, setBootstrapExtract] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const url = databaseUrl.trim() || undefined;

  const load = useAction(() => post<V1ImportPreview>('/api/admin/import-v1/preview', { databaseUrl: url }), {
    onDone: (p) => {
      setPreview(p);
      setSelected(new Set(p.novels.map((n) => n.id)));
    },
  });
  const start = useAction(
    () => {
      const all = preview !== null && selected.size === preview.novels.length;
      return post<V1ImportJob>('/api/admin/import-v1', { databaseUrl: url, novels: all ? 'all' : [...selected], readers, themes, includeDrafts, bootstrapExtract });
    },
    { ok: '导入已开始', onDone: (j) => setJobId(j.id) },
  );

  const toggle = (id: number, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  return (
    <Page>
      <PageHeader title="v1 导入" sub="从旧版数据库导入书、章节、题材和读者。旧库只读，不会被修改。" />
      <div className="space-y-4">
        <Card title="1. 连接旧库">
          <Field label="数据库地址（可选）" hint="留空使用服务器的 NOVELIST_V1_DATABASE_URL">
            <Input value={databaseUrl} autoComplete="off" placeholder="postgresql://novelist:***@postgres:5432/novelist" onChange={(e) => setDatabaseUrl(e.target.value)} />
          </Field>
          <Button className="mt-3" busy={load.isPending} onClick={() => load.mutate()}>
            读取预览
          </Button>
          {preview && !preview.ok && (
            <div className="mt-3">
              <Notice tone="danger">连接失败：{preview.error ?? '未知错误'}</Notice>
            </div>
          )}
        </Card>

        {preview?.ok && (
          <Card title={`2. 选择内容（${preview.source}）`}>
            <div className="overflow-x-auto mb-4">
              <table className="tbl">
                <thead>
                  <tr>
                    <th />
                    <th>书名</th>
                    <th>状态</th>
                    <th>题材</th>
                    <th className="text-right">章节</th>
                    <th className="text-right">字数</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.novels.map((n) => (
                    <tr key={n.id}>
                      <td>
                        <input type="checkbox" aria-label={`选择 ${n.title}`} className="size-4 accent-[var(--accent)]" checked={selected.has(n.id)} onChange={(e) => toggle(n.id, e.target.checked)} />
                      </td>
                      <td>{n.title}</td>
                      <td className="text-sub">{n.status}</td>
                      <td className="text-sub">{n.theme}</td>
                      <td className="text-right tabular-nums">
                        {n.doneChapters}/{n.chapters}
                      </td>
                      <td className="text-right tabular-nums">{fmtCjk(n.words)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              <Toggle checked={readers} onChange={setReaders} label={`导入读者与进度（${preview.readers} 位读者，${preview.progressRows} 条进度）`} />
              <Toggle checked={themes} onChange={setThemes} label={`把题材导入为题材包（${preview.themes.length} 个）`} />
              <Toggle checked={includeDrafts} onChange={setIncludeDrafts} label="包含未完成的草稿章节" />
              <Toggle checked={bootstrapExtract} onChange={setBootstrapExtract} label="导入后回溯抽取状态账本" hint="会消耗模型额度" />
            </div>
            <Button className="mt-4" variant="primary" busy={start.isPending} disabled={selected.size === 0 || jobId !== null} onClick={() => start.mutate()}>
              开始导入 {selected.size} 本
            </Button>
          </Card>
        )}

        {jobId && <JobView id={jobId} />}
      </div>
    </Page>
  );
}

function JobView({ id }: { id: string }) {
  const path = `/api/admin/import-v1/jobs/${enc(id)}`;
  const q = useApi<V1ImportJob>(path, { refetchMs: (d) => (d && d.state !== 'running' ? false : 1500), staleMs: 0 });
  const invalidate = useInvalidate();
  const job = q.data;
  const finished = job !== undefined && job.state !== 'running';
  useEffect(() => {
    if (finished) void invalidate('/api/admin/books');
  }, [finished, invalidate]);
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          3. 导入进度
          {job && <Badge tone={job.state === 'done' ? 'ok' : job.state === 'failed' ? 'danger' : 'info'}>{{ running: '进行中', done: '完成', failed: '失败' }[job.state]}</Badge>}
        </span>
      }
    >
      {q.error && <Notice tone="danger">{q.error.message}</Notice>}
      {job && (
        <>
          {job.report && (
            <ul className="text-sm space-y-0.5 mb-3">
              {job.report.books.map((b) => (
                <li key={b.slug}>
                  {b.slug}：{b.chapters} 章{b.dropped > 0 && <span className="text-warn">，丢弃 {b.dropped} 章</span>}
                </li>
              ))}
              <li className="text-sub">
                读者 {job.report.readers} 位；题材包 {job.report.genres.join('、') || '无'}
              </li>
            </ul>
          )}
          <Pre className="max-h-80">{job.log.join('\n') || '等待输出…'}</Pre>
        </>
      )}
    </Card>
  );
}
