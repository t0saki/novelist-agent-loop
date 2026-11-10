/**
 * 指令编辑器 + 根 AGENTS.md 预览（全局 / 题材 / 书层共用；builtin 只读）。
 * 指令内容归用户所有，这里只原样编辑和传递。
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { V3_LENGTHS, type GenreSummary, type ImpactEstimate, type InstructionFileEntry, type InstructionPreviewV3, type InstructionPreviewV3Request, type RepoFile, type V3Length } from '@novelist/shared';
import { del, post, put, qs } from '../../api/client';
import { useApi, useInvalidate } from '../../api/hooks';
import { fmtBytes, fmtNum } from '../../lib/format';
import { V3_LENGTH_LABEL } from '../../lib/labels';
import { CodeEditor, langForPath } from '../CodeEditor';
import { Badge, Button, confirmDialog, cx, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, Pre, Q, Select, useDebounced } from '../ui';
import { toast } from '../toast';
import { saveErrorText, saveWithImpact } from './saveFlow';

const NEW_HINT: Record<string, string> = {
  global: '如 AGENTS.md、roles/writer.md、skills/<name>/SKILL.md',
  genre: '如 AGENTS.md、roles/writer.md',
  book: '如 instructions/AGENTS.md',
};

/** filter：只列出符合的文件（篇幅档查看器只看 v3/length-*.md）；preview=false 不显示预览 */
export function InstructionWorkbench({ scope, book, genre, filter, preview = true }: { scope: string; book?: string; genre?: string; filter?: (path: string) => boolean; preview?: boolean }) {
  const readOnly = scope === 'builtin';
  const listPath = `/api/admin/instructions/files${qs({ scope })}`;
  const files = useApi<InstructionFileEntry[]>(listPath);
  const [path, setPath] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newFile, setNewFile] = useState<string | null>(null);
  const [created, setCreated] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidate();

  const filePath = path && !created.has(path) ? `/api/admin/instructions/file${qs({ scope, path })}` : null;
  const file = useApi<RepoFile>(filePath);
  const baseContent = path && created.has(path) ? '' : (file.data?.content ?? '');
  const content = path ? (drafts[path] ?? baseContent) : '';
  const dirty = path !== null && drafts[path] !== undefined && drafts[path] !== baseContent;

  const grouped = useMemo(() => {
    const m = new Map<string, InstructionFileEntry[]>();
    for (const f of (files.data ?? []).filter((x) => !filter || filter(x.path))) m.set(f.layer, [...(m.get(f.layer) ?? []), f]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files.data, filter]);

  const clearDraft = (p: string) =>
    setDrafts((d) => {
      const { [p]: _dropped, ...rest } = d;
      return rest;
    });

  async function save() {
    if (!path) return;
    setBusy(true);
    try {
      const isNew = created.has(path);
      const r = await saveWithImpact<RepoFile>((confirm) => put<RepoFile | ImpactEstimate>('/api/admin/instructions/file', { scope, path, content, baseSha: isNew ? null : (file.data?.sha ?? null), confirm }));
      if (r) {
        toast('已保存', 'ok');
        clearDraft(path);
        setCreated((s) => {
          const n = new Set(s);
          n.delete(path);
          return n;
        });
        await invalidate('/api/admin/instructions');
      }
    } catch (e) {
      toast(saveErrorText(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!path || !(await confirmDialog({ title: `删除 ${path}？`, danger: true, okText: '删除' }))) return;
    try {
      await del(`/api/admin/instructions/file${qs({ scope, path })}`);
      toast('已删除', 'ok');
      clearDraft(path);
      setPath(null);
      await invalidate('/api/admin/instructions');
    } catch (e) {
      toast(saveErrorText(e), 'danger');
    }
  }

  const prefix = scope.split(':')[0] ?? scope;
  const visible = [...new Set([...(files.data?.map((f) => f.path).filter((p) => !filter || filter(p)) ?? []), ...created])];

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-[240px_1fr] gap-4">
        <div className="bg-panel border border-line rounded-lg p-2 max-h-[40vh] md:max-h-[70vh] overflow-y-auto">
          {!readOnly && (
            <div className="flex justify-end mb-1">
              <Button size="sm" variant="ghost" onClick={() => setNewFile('')}>
                ＋ 新建
              </Button>
            </div>
          )}
          <Q q={files}>
            {() =>
              visible.length === 0 ? (
                <Empty>这一层还没有指令文件。</Empty>
              ) : (
                <>
                  {grouped.map(([layer, list]) => (
                    <div key={layer} className="mb-2">
                      <div className="text-xs text-faint px-2 py-1">{layer}</div>
                      {list.map((f) => (
                        <FileRow key={f.path} path={f.path} active={path === f.path} dirty={drafts[f.path] !== undefined} size={f.size} onClick={() => setPath(f.path)} />
                      ))}
                    </div>
                  ))}
                  {[...created].map((p) => (
                    <FileRow key={p} path={p} active={path === p} dirty onClick={() => setPath(p)} />
                  ))}
                </>
              )
            }
          </Q>
        </div>
        <div className="min-w-0">
          {!path ? (
            <Empty>从左侧选择文件开始编辑。</Empty>
          ) : file.isLoading ? (
            <Loading />
          ) : file.error ? (
            <ErrorBox error={file.error} />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <code className="text-xs truncate">{path}</code>
                <div className="flex gap-2">
                  {readOnly && <Badge tone="warn">内置，只读</Badge>}
                  {!readOnly && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => void remove()}>
                        删除
                      </Button>
                      {dirty && (
                        <Button size="sm" variant="ghost" onClick={() => clearDraft(path)}>
                          撤销
                        </Button>
                      )}
                      <Button size="sm" variant="primary" busy={busy} disabled={!dirty && !created.has(path)} onClick={() => void save()}>
                        保存
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <CodeEditor key={path} value={content} lang={langForPath(path)} readOnly={readOnly} height="60vh" onChange={readOnly ? undefined : (v) => setDrafts((d) => ({ ...d, [path]: v }))} />
            </>
          )}
        </div>
      </div>

      {preview && <PreviewPanel scope={scope} book={book} genre={genre} drafts={drafts} />}

      {newFile !== null && (
        <Modal
          title="新建指令文件"
          onClose={() => setNewFile(null)}
          footer={
            <Button
              variant="primary"
              disabled={!newFile.trim() || newFile.endsWith('/')}
              onClick={() => {
                const p = newFile.trim();
                setCreated((s) => new Set(s).add(p));
                setDrafts((d) => ({ ...d, [p]: '' }));
                setPath(p);
                setNewFile(null);
              }}
            >
              创建
            </Button>
          }
        >
          <Field label="路径" hint={NEW_HINT[prefix]}>
            <Input value={newFile} onChange={(e) => setNewFile(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </div>
  );
}

function FileRow({ path, active, dirty, size, onClick }: { path: string; active: boolean; dirty: boolean; size?: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx('w-full text-left flex items-center justify-between gap-2 px-2 py-1 text-sm rounded hover:bg-panel2', active && 'bg-panel2 font-medium')}>
      <span className="truncate">
        {path}
        {dirty && <span className="text-accent"> ●</span>}
      </span>
      {size !== undefined && <span className="text-xs text-faint shrink-0">{fmtBytes(size)}</span>}
    </button>
  );
}

/** 根 AGENTS.md 预览：和运行时同一个渲染器（按书，或按题材包 + 篇幅），带各层字节数；未保存的修改也算在内 */
function PreviewPanel({ scope, book, genre, drafts }: { scope: string; book?: string; genre?: string; drafts: Record<string, string> }) {
  const genres = useApi<GenreSummary[]>(book || genre ? null : '/api/admin/genres');
  const [pickedGenre, setPickedGenre] = useState<string | null>(null);
  const [length, setLength] = useState<V3Length>('medium');
  const genreId = genre ?? pickedGenre ?? genres.data?.find((g) => !g.hidden)?.id ?? null;
  const scoped = useMemo(() => Object.fromEntries(Object.entries(drafts).map(([p, v]) => [`${scope}:${p}`, v])), [drafts, scope]);
  const debounced = useDebounced(scoped, 800);
  const q = useQuery<InstructionPreviewV3>({
    queryKey: ['instruction-preview', scope, book, genreId, length, debounced],
    enabled: Boolean(book) || genreId !== null,
    placeholderData: (prev) => prev,
    staleTime: 0,
    queryFn: () => {
      const req: InstructionPreviewV3Request = book ? { book, drafts: debounced } : { genre: genreId as string, length, drafts: debounced };
      return post<InstructionPreviewV3>('/api/admin/instructions/preview', req);
    },
  });
  const p = q.data;

  return (
    <section className="bg-panel border border-line rounded-lg">
      <header className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 border-b border-line">
        <div>
          <h2 className="text-sm font-semibold">预览：作者看到的根 AGENTS.md</h2>
          <p className="text-xs text-faint mt-0.5">未保存的修改也算在内。{book ? '按这本书的题材和篇幅。' : ''}</p>
        </div>
        {!book && (
          <div className="flex gap-2">
            {!genre && (
              <Field label="题材包">
                <Select value={genreId ?? ''} onChange={(e) => setPickedGenre(e.target.value)} aria-label="预览用的题材包">
                  {genres.data?.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="篇幅">
              <Select value={length} onChange={(e) => setLength(e.target.value as V3Length)} aria-label="预览用的篇幅">
                {V3_LENGTHS.map((l) => (
                  <option key={l} value={l}>
                    {V3_LENGTH_LABEL[l]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </header>
      <div className="p-4 space-y-3">
        {q.error && !p && <ErrorBox error={q.error} retry={() => void q.refetch()} />}
        {!p && !q.error && (genreId !== null || book ? <Loading text="渲染中…" /> : <Empty>没有可用的题材包。</Empty>)}
        {p && (
          <>
            <p className={cx('text-sm tabular-nums', p.over ? 'text-danger' : 'text-sub')}>
              共 {fmtBytes(p.bytes)} / 上限 {fmtBytes(p.limit)}
              {p.over ? '：超过了，请精简全局、题材或本书指令' : ''}
            </p>
            {p.over && <Notice tone="danger">AGENTS.md 超过 {fmtBytes(p.limit)}，有的 harness 会截断或拒绝启动。</Notice>}
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>层</th>
                    <th className="text-right">字节</th>
                  </tr>
                </thead>
                <tbody>
                  {p.layers.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.label} <code className="text-xs text-faint">{l.id}</code>
                      </td>
                      <td className="text-right tabular-nums">{fmtNum(l.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pre className="max-h-[60vh]">{p.text || '（空）'}</Pre>
          </>
        )}
      </div>
    </section>
  );
}
