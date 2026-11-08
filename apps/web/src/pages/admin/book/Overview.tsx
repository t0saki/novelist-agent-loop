import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { BOOK_FORMAT_VERSION, type BookOverview } from '@novelist/shared';
import { del, enc, post } from '../../../api/client';
import { useAction, useInvalidate } from '../../../api/hooks';
import { FrontierBar, WaitingNote } from '../../../components/admin/shared';
import { MilestoneChart } from '../../../components/charts';
import { Badge, Button, Card, confirmDialog, Empty, Field, Input, Meter, Modal, Stat } from '../../../components/ui';
import { toast } from '../../../components/toast';
import { fmtCjk, fmtRel } from '../../../lib/format';
import { CHAPTER_STATE } from '../../../lib/labels';

export function OverviewTab({ book: b }: { book: BookOverview }) {
  const base = `/api/admin/books/${enc(b.slug)}`;
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [rewind, setRewind] = useState<number | null>(null);
  const act = useAction((body: { action: string; to?: number; confirm?: boolean }) => post(`${base}/actions`, body), { ok: '已提交', invalidate: ['/api/admin/books', '/api/admin/tasks'], onDone: () => setRewind(null) });
  const f = b.frontiers;
  const target = b.config.scale.target_cjk;

  async function danger(action: string, title: string, body: string) {
    if (await confirmDialog({ title, body, danger: true, okText: '继续' })) act.mutate({ action, confirm: true });
  }
  async function removeBook() {
    if (!(await confirmDialog({ title: `删除《${b.title}》？`, body: '书库、章节和运行记录都会删除，无法恢复。', danger: true, okText: '永久删除', typeToConfirm: b.slug }))) return;
    try {
      await del(`${base}?confirm=${enc(b.slug)}`);
      toast('已删除', 'ok');
      await invalidate('/api/admin/books');
      void navigate({ to: '/admin/books' });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'danger');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {b.status === 'draft' && (
          <Button variant="primary" onClick={() => act.mutate({ action: 'start' })}>
            启动
          </Button>
        )}
        {(b.status === 'active' || b.status === 'planning') && <Button onClick={() => act.mutate({ action: 'pause' })}>暂停</Button>}
        {b.status === 'paused' && (
          <Button variant="primary" onClick={() => act.mutate({ action: 'resume' })}>
            恢复
          </Button>
        )}
        <Button onClick={() => act.mutate({ action: 'drain' })} title="写完手头任务后不再派发新任务">
          收尾暂停
        </Button>
        <Button onClick={() => void danger('reindex', '重建索引？', '会重新计算派生状态和检索索引，不改动正典文件。')}>重建索引</Button>
        <Button onClick={() => setRewind(f.accepted)}>回退</Button>
        {b.formatVersion < BOOK_FORMAT_VERSION && <Button onClick={() => void danger('migrate', '迁移书库格式？', '会生成一个迁移提交。')}>迁移格式</Button>}
        <div className="flex-1" />
        <Button variant="danger" onClick={() => void removeBook()}>
          删除书
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="字数" value={fmtCjk(b.totalCjk)} sub={`目标 ${fmtCjk(target)}`} />
        <Stat label="发布前沿" value={`第 ${f.published} 章`} sub={`已审计到第 ${f.audited} 章`} />
        <Stat label="存稿" value={`${f.buffer} 章`} sub={f.bufferDays === null ? '未排期' : `可维持约 ${f.bufferDays.toFixed(1)} 天`} />
        <Stat label="活跃任务" value={b.activeTasks} sub={b.currentChapter ? `第 ${b.currentChapter.no} 章 · ${CHAPTER_STATE[b.currentChapter.state as keyof typeof CHAPTER_STATE]?.label ?? b.currentChapter.state}` : '无进行中的章节'} />
      </div>

      {b.waiting && (
        <div className="text-sm">
          <WaitingNote book={b} />
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="进度">
          <div className="space-y-4">
            <FrontierBar f={f} />
            <Meter label="全书字数" ratio={target > 0 ? b.totalCjk / target : 0} />
            <Meter label={`前向债务（上限 ${b.debts.cap}）`} ratio={b.debts.cap > 0 ? b.debts.forwardOpen / b.debts.cap : 0} detail={`${b.debts.forwardOpen} / ${b.debts.cap}`} />
            <p className="text-xs text-sub">
              指标债务 {b.debts.metricOpen} 条（只计入仪表盘）；主笔 Profile：{b.writerProfile ?? '路由默认'}；格式版本 {b.formatVersion}
            </p>
          </div>
        </Card>
        <Card title="里程碑">{b.milestones.length === 0 ? <Empty>规划完成后显示里程碑。</Empty> : <MilestoneChart points={b.milestones} />}</Card>
      </div>

      <Card title="最近提交" actions={<Link to="/admin/books/$slug/$tab" params={{ slug: b.slug, tab: 'runs' }} className="text-xs text-sub hover:text-ink">运行记录</Link>}>
        {b.recentCommits.length === 0 ? (
          <Empty>暂无提交。</Empty>
        ) : (
          <ul className="space-y-1.5">
            {b.recentCommits.map((c) => (
              <li key={c.sha} className="text-sm flex items-baseline gap-2">
                <code className="text-xs text-faint shrink-0">{c.sha.slice(0, 7)}</code>
                <span className="truncate flex-1">{c.subject}</span>
                {c.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
                <span className="text-xs text-faint shrink-0">{fmtRel(c.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {rewind !== null && (
        <Modal
          title="回退到指定章节"
          onClose={() => setRewind(null)}
          footer={
            <Button variant="danger" busy={act.isPending} onClick={() => act.mutate({ action: 'rewind', to: rewind, confirm: true })}>
              回退
            </Button>
          }
        >
          <Field label="回退到第几章" hint="这一章之后的验收、状态和待执行任务都会作废。">
            <Input type="number" min={0} max={f.accepted} value={rewind} onChange={(e) => setRewind(Number(e.target.value) || 0)} />
          </Field>
        </Modal>
      )}
    </div>
  );
}
