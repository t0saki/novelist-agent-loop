/** 发布排期：所有书的前沿、存稿、下一批发布，以及配置。Owner: lane H。 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { PublishConfig, PublishOverview } from '@novelist/shared';
import { enc, post, put } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { FrontierBar, PublishFields } from '../../components/admin/shared';
import { Badge, Button, confirmDialog, Empty, Field, Input, Modal, Page, PageHeader, Q, Toggle } from '../../components/ui';
import { fmtTime } from '../../lib/format';

const key = '/api/admin/schedule';

export function PublishNowButton({ slug, published, defaultThrough }: { slug: string; published: number; defaultThrough?: number }) {
  const [open, setOpen] = useState(false);
  const [through, setThrough] = useState(defaultThrough ?? published + 1);
  const [ignoreAudit, setIgnoreAudit] = useState(false);
  const act = useAction(() => post(`/api/admin/books/${enc(slug)}/publish/now`, { through, ignoreAudit }), { ok: '已加入发布队列', invalidate: [key, '/api/admin/books'], onDone: () => setOpen(false) });
  async function submit() {
    if (!ignoreAudit || (await confirmDialog({ title: '跳过审计发布？', body: `将发布到第 ${through} 章并跳过审计，发布后的问题只能靠 override 和后文补圆。`, danger: true, okText: '仍要发布' }))) act.mutate();
  }
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        立即发布
      </Button>
      {open && (
        <Modal
          title="立即发布"
          onClose={() => setOpen(false)}
          footer={
            <Button variant="primary" busy={act.isPending} onClick={() => void submit()}>
              发布
            </Button>
          }
        >
          <div className="space-y-3">
            <Field label="发布到第几章" hint={`当前已发布到第 ${published} 章`}>
              <Input type="number" min={published + 1} value={through} onChange={(e) => setThrough(Number(e.target.value) || published + 1)} />
            </Field>
            <p className="text-sm text-sub">{through > published + 1 ? `将发布第 ${published + 1}–${through} 章，共 ${through - published} 章。` : `将发布第 ${through} 章。`}</p>
            <Toggle checked={ignoreAudit} onChange={setIgnoreAudit} label="跳过审计要求" />
          </div>
        </Modal>
      )}
    </>
  );
}

function EditPublish({ row, onClose }: { row: PublishOverview; onClose: () => void }) {
  const [value, setValue] = useState<PublishConfig>(row.config);
  const save = useAction(() => put(`/api/admin/books/${enc(row.slug)}/publish`, value), { ok: '已保存', invalidate: [key, '/api/admin/books'], onDone: onClose });
  return (
    <Modal
      wide
      title={`《${row.title}》发布配置`}
      onClose={onClose}
      footer={
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          保存
        </Button>
      }
    >
      <PublishFields value={value} onChange={setValue} />
    </Modal>
  );
}

export function SchedulePage() {
  const q = useApi<PublishOverview[]>(key);
  const [editing, setEditing] = useState<PublishOverview | null>(null);
  return (
    <Page>
      <PageHeader title="发布排期" />
      <Q q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>还没有书。</Empty>
          ) : (
            <div className="space-y-3">
              {rows.map((r) => (
                <article key={r.slug} className="bg-panel border border-line rounded-lg p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link to="/admin/books/$slug/$tab" params={{ slug: r.slug, tab: 'overview' }} className="font-medium hover:underline">
                        {r.title}
                      </Link>
                      <div className="text-xs text-sub mt-0.5">
                        {{ scheduled: '按排期', immediate: '验收后立即', manual: '手动' }[r.config.mode]} · {r.config.cadence} · 每次 {r.config.per_slot} 章
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {r.paused && <Badge tone="warn">已暂停{r.pausedReason ? `：${r.pausedReason}` : ''}</Badge>}
                      <PublishNowButton slug={r.slug} published={r.frontiers.published} />
                      <Button size="sm" onClick={() => setEditing(r)}>
                        配置
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3">
                    <FrontierBar f={r.frontiers} />
                  </div>
                  <div className="text-xs text-sub mt-2">
                    存稿 {r.frontiers.buffer} 章{r.frontiers.bufferDays !== null && `，可维持约 ${r.frontiers.bufferDays.toFixed(1)} 天`}
                    {r.nextSlots.length > 0 && ` · 接下来：${r.nextSlots.slice(0, 3).map(fmtTime).join('、')}`}
                  </div>
                </article>
              ))}
            </div>
          )
        }
      </Q>
      {editing && <EditPublish row={editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}
