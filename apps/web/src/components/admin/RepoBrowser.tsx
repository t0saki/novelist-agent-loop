/** 书库文件浏览 + 编辑（规划 / 设定 / 状态共用）。Owner: lane H。 */
import { useRef, useState } from 'react';
import type { ImpactEstimate, RepoEntry, RepoFile } from '@novelist/shared';
import { enc, post, put } from '../../api/client';
import { useApi, useInvalidate } from '../../api/hooks';
import { childrenOf, type TreeNode } from '../../lib/repoTree';
import { fmtBytes } from '../../lib/format';
import { CodeEditor, langForPath } from '../CodeEditor';
import { Badge, Button, confirmDialog, cx, Empty, Field, Input, Loading, Modal } from '../ui';
import { toast } from '../toast';
import { saveErrorText, saveWithImpact } from './saveFlow';

const OWNER: Record<RepoEntry['owner'], string> = { canonical: '正典', user: '用户', generated: '生成', derived: '派生' };

function TreeLevel({ slug, dir, depth, selected, onPick }: { slug: string; dir: string; depth: number; selected: string | null; onPick: (n: TreeNode) => void }) {
  const q = useApi<RepoEntry[]>(`/api/admin/books/${enc(slug)}/tree?dir=${enc(dir)}`);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (q.isLoading) return <div className="text-xs text-faint py-1" style={{ paddingLeft: depth * 12 + 8 }}>加载中…</div>;
  if (q.error) return <div className="text-xs text-danger py-1 px-2">{q.error.message}</div>;
  const nodes = childrenOf(q.data ?? [], dir);
  if (nodes.length === 0 && depth === 0) return <Empty>这里还没有文件。</Empty>;
  return (
    <ul>
      {nodes.map((n) => (
        <li key={n.path}>
          <button
            type="button"
            className={cx('w-full text-left flex items-center gap-1 py-1 pr-2 text-sm rounded hover:bg-panel2', selected === n.path && 'bg-panel2 font-medium')}
            style={{ paddingLeft: depth * 12 + 8 }}
            onClick={() => {
              if (n.type === 'dir')
                setOpen((s) => {
                  const next = new Set(s);
                  if (next.has(n.path)) next.delete(n.path);
                  else next.add(n.path);
                  return next;
                });
              else onPick(n);
            }}
          >
            <span className="text-faint w-3 text-xs">{n.type === 'dir' ? (open.has(n.path) ? '▾' : '▸') : ''}</span>
            <span className="truncate">{n.name}</span>
          </button>
          {n.type === 'dir' && open.has(n.path) && <TreeLevel slug={slug} dir={n.path} depth={depth + 1} selected={selected} onPick={onPick} />}
        </li>
      ))}
    </ul>
  );
}

function FileEditor({ slug, path, isNew, readOnly, entry, dirtyRef, height, onCreated }: { slug: string; path: string; isNew: boolean; readOnly: boolean; entry: RepoEntry | null; dirtyRef: { current: boolean }; height?: string; onCreated: () => void }) {
  const base = `/api/admin/books/${enc(slug)}`;
  const q = useApi<RepoFile>(isNew ? null : `${base}/file?path=${enc(path)}`);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidate();
  const original = q.data?.content ?? '';
  const content = draft ?? original;
  const dirty = isNew ? content !== '' : draft !== null && draft !== original;
  dirtyRef.current = dirty;

  async function save() {
    setBusy(true);
    try {
      const body = { path, content, baseSha: isNew ? null : (q.data?.sha ?? null) };
      const r = await saveWithImpact<RepoFile>(
        (confirm) => put<RepoFile | ImpactEstimate>(`${base}/file`, { ...body, confirm }),
        () => post<ImpactEstimate>(`${base}/file/impact`, { ...body, confirm: false }),
      );
      if (r) {
        toast('已保存并提交', 'ok');
        setDraft(null);
        dirtyRef.current = false;
        await invalidate(`${base}/file`, `${base}/tree`, `${base}/plan`, `${base}/state`);
        if (isNew) onCreated();
      }
    } catch (e) {
      toast(saveErrorText(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (!isNew && q.isLoading) return <Loading />;
  if (!isNew && q.error) return <div className="text-sm text-danger p-3">{q.error.message}</div>;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0 text-sm">
          <code className="truncate text-xs">{path}</code>
          {entry && <Badge>{OWNER[entry.owner]}</Badge>}
          {entry && <span className="text-xs text-faint">{fmtBytes(entry.size)}</span>}
          {readOnly && <Badge tone="warn">只读</Badge>}
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                撤销
              </Button>
            )}
            <Button size="sm" variant="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>
              保存
            </Button>
          </div>
        )}
      </div>
      <CodeEditor value={content} onChange={readOnly ? undefined : setDraft} lang={langForPath(path)} readOnly={readOnly} height={height ?? '65vh'} />
    </div>
  );
}

export function RepoBrowser({ slug, dir, readOnly, emptyHint, newPlaceholder, height }: { slug: string; dir: string; readOnly?: boolean; emptyHint?: string; newPlaceholder?: string; height?: string }) {
  const [node, setNode] = useState<TreeNode | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [newPath, setNewPath] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const invalidate = useInvalidate();
  const treeKey = `/api/admin/books/${enc(slug)}/tree`;

  async function guard(): Promise<boolean> {
    if (!dirtyRef.current) return true;
    return confirmDialog({ title: '放弃未保存的修改？', okText: '放弃', danger: true });
  }
  async function pick(n: TreeNode) {
    if (await guard()) {
      dirtyRef.current = false;
      setCreating(null);
      setNode(n);
    }
  }
  const path = creating ?? node?.path ?? null;
  const isReadOnly = Boolean(readOnly) || node?.entry?.owner === 'derived' || node?.entry?.owner === 'generated';

  return (
    <div className="grid md:grid-cols-[260px_1fr] gap-4">
      <div className="bg-panel border border-line rounded-lg p-2 max-h-[40vh] md:max-h-[75vh] overflow-y-auto">
        {!readOnly && (
          <div className="flex justify-end mb-1">
            <Button size="sm" variant="ghost" onClick={() => setNewPath(`${dir}/`)}>
              ＋ 新建文件
            </Button>
          </div>
        )}
        <TreeLevel slug={slug} dir={dir} depth={0} selected={path} onPick={(n) => void pick(n)} />
      </div>
      <div className="min-w-0">
        {path ? <FileEditor key={`${path}:${creating ? 'new' : 'old'}`} slug={slug} path={path} isNew={creating !== null} readOnly={isReadOnly && creating === null} entry={creating ? null : (node?.entry ?? null)} dirtyRef={dirtyRef} height={height} onCreated={() => { setCreating(null); setNode({ name: path.split('/').pop() ?? path, path, type: 'file', entry: null }); void invalidate(treeKey); }} /> : <Empty>{emptyHint ?? '从左侧选择文件。'}</Empty>}
      </div>
      {newPath !== null && (
        <Modal
          title="新建文件"
          onClose={() => setNewPath(null)}
          footer={
            <Button
              variant="primary"
              disabled={!newPath.startsWith(`${dir}/`) || newPath.endsWith('/')}
              onClick={async () => {
                if (await guard()) {
                  dirtyRef.current = false;
                  setCreating(newPath);
                  setNode(null);
                  setNewPath(null);
                }
              }}
            >
              创建
            </Button>
          }
        >
          <Field label="路径（相对书库根目录）" hint={newPlaceholder}>
            <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </div>
  );
}


/** 单文件编辑（章节详情里的卡片等） */
export function RepoFilePane({ slug, path, height }: { slug: string; path: string; height?: string }) {
  const dirtyRef = useRef(false);
  return <FileEditor slug={slug} path={path} isNew={false} readOnly={false} entry={null} dirtyRef={dirtyRef} height={height} onCreated={() => undefined} />;
}
