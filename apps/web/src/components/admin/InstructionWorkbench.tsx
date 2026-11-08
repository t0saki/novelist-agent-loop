/**
 * 指令编辑器 + 按 harness 的编译预览 + 生效 gate（全局 / 题材 / 书层共用）。Owner: lane H。
 * 指令内容归用户所有，这里只原样编辑和传递。
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ROLE_IDS, type HarnessStatus, type ImpactEstimate, type InstructionFileEntry, type InstructionPreview, type InstructionPreviewRequest, type RepoFile, type RoleId } from '@novelist/shared';
import { del, post, put, qs } from '../../api/client';
import { useApi, useInvalidate } from '../../api/hooks';
import { fmtBytes, fmtNum } from '../../lib/format';
import { GATE_SOURCE, ROLE_LABEL } from '../../lib/labels';
import { CodeEditor, langForPath } from '../CodeEditor';
import { Badge, Button, confirmDialog, cx, Empty, ErrorBox, Field, Input, Loading, Modal, Notice, Pre, Q, Select, Tabs, useDebounced } from '../ui';
import { toast } from '../toast';
import { saveErrorText, saveWithImpact } from './saveFlow';

type PreviewTab = 'system' | 'workspace' | 'files' | 'argv' | 'gates' | 'layers';

const NEW_HINT: Record<string, string> = {
  global: '如 AGENTS.md、roles/writer.md、tasks/chapter.write.md、skills/<name>/SKILL.md',
  genre: '如 AGENTS.md、roles/writer.md、pacing.yaml、gates.yaml、lexicon.yaml',
  book: '如 instructions/AGENTS.md、instructions/roles/writer.md、style/voice.md',
};

export function InstructionWorkbench({ scope, book, genre }: { scope: string; book?: string; genre?: string }) {
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
    for (const f of files.data ?? []) m.set(f.layer, [...(m.get(f.layer) ?? []), f]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files.data]);

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
  const visible = [...new Set([...(files.data?.map((f) => f.path) ?? []), ...created])];

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

      <PreviewPanel scope={scope} book={book} genre={genre} drafts={drafts} />

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

function PreviewPanel({ scope, book, genre, drafts }: { scope: string; book?: string; genre?: string; drafts: Record<string, string> }) {
  const harness = useApi<HarnessStatus[]>('/api/admin/harness');
  const [role, setRole] = useState<RoleId>('writer');
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<PreviewTab>('system');
  const harnessId = picked ?? harness.data?.find((h) => h.installed && h.id !== 'fake')?.id ?? harness.data?.[0]?.id ?? null;

  const scoped = useMemo(() => Object.fromEntries(Object.entries(drafts).map(([p, v]) => [`${scope}:${p}`, v])), [drafts, scope]);
  const debounced = useDebounced(scoped, 800);
  const q = useQuery<InstructionPreview>({
    queryKey: ['instruction-preview', scope, book, genre, role, harnessId, debounced],
    enabled: harnessId !== null,
    placeholderData: (prev) => prev,
    staleTime: 0,
    queryFn: () => {
      const req: InstructionPreviewRequest = { book, genre, role, harness: harnessId as never, drafts: debounced };
      return post<InstructionPreview>('/api/admin/instructions/preview', req);
    },
  });
  const p = q.data;

  return (
    <section className="bg-panel border border-line rounded-lg">
      <header className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 border-b border-line">
        <div>
          <h2 className="text-sm font-semibold">编译预览：agent 实际看到的内容</h2>
          <p className="text-xs text-faint mt-0.5">未保存的修改也算在内；这里的 nonce 是占位值。</p>
        </div>
        <div className="flex gap-2">
          <Field label="角色">
            <Select value={role} onChange={(e) => setRole(e.target.value as RoleId)}>
              {ROLE_IDS.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}（{r}）
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Harness">
            <Select value={harnessId ?? ''} onChange={(e) => setPicked(e.target.value)}>
              {harness.data?.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.displayName}
                  {h.installed ? '' : '（未安装）'}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </header>
      <div className="p-4">
        {q.error && !p && <ErrorBox error={q.error} retry={() => void q.refetch()} />}
        {!p && !q.error && <Loading text="编译中…" />}
        {p && (
          <>
            {!p.budget.ok && (
              <div className="mb-3">
                <Notice tone="danger">
                  该 profile 不可承载：指令 {fmtBytes(p.budget.bytes)}，上限 {p.budget.limit === null ? '未知' : fmtBytes(p.budget.limit)}。{p.budget.reason ?? '请压缩该层或换 harness。'}
                </Notice>
              </div>
            )}
            <Tabs<PreviewTab>
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'system', label: 'System 通道' },
                { id: 'workspace', label: '工作区文档' },
                { id: 'files', label: `物化文件（${p.materialized.files.length}）` },
                { id: 'argv', label: '命令与环境' },
                { id: 'gates', label: `生效 Gate（${p.effectiveGates.length}）` },
                { id: 'layers', label: '层与预算' },
              ]}
            />
            {tab === 'system' && <Pre className="max-h-[60vh]">{p.systemMd || '（空）'}</Pre>}
            {tab === 'workspace' && <Pre className="max-h-[60vh]">{p.workspaceDoc || '（空）'}</Pre>}
            {tab === 'files' && (
              <div className="space-y-3">
                {p.materialized.files.map((f) => (
                  <div key={f.path}>
                    <code className="text-xs">{f.path}</code>
                    <Pre className="mt-1 max-h-72">{f.content}</Pre>
                  </div>
                ))}
                {p.materialized.files.length === 0 && <Empty>该 harness 不需要额外文件。</Empty>}
              </div>
            )}
            {tab === 'argv' && (
              <div className="space-y-3">
                <Pre>{p.materialized.argv.join(' \\\n  ')}</Pre>
                <Pre>{Object.entries(p.materialized.env).map(([k, v]) => `${k}=${v}`).join('\n') || '（无额外环境变量）'}</Pre>
              </div>
            )}
            {tab === 'gates' && <GateTable gates={p.effectiveGates} />}
            {tab === 'layers' && (
              <div className="space-y-2">
                <p className="text-sm text-sub">
                  总计 {fmtBytes(p.budget.bytes)}
                  {p.budget.limit !== null && ` / 上限 ${fmtBytes(p.budget.limit)}`}；最后一层作者块：<code className="text-xs">{p.lastAuthorBlock}</code>
                </p>
                {p.replaced.length > 0 && (
                  <p className="text-sm text-sub">
                    已被替换、不生效的层：
                    {p.replaced.map((l) => (
                      <code key={l.id} className="text-xs ml-1" title={l.source}>
                        {l.id}
                      </code>
                    ))}
                  </p>
                )}
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>层</th>
                        <th>来源</th>
                        <th>模式</th>
                        <th className="text-right">字节</th>
                        <th className="text-right">Token</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.layers.map((l) => (
                        <tr key={l.id}>
                          <td>
                            {l.id} <span className="text-xs text-faint">{l.label}</span>
                          </td>
                          <td>
                            <code className="text-xs">{l.source}</code>
                          </td>
                          <td>{l.mode === 'replace' ? '替换' : '继承'}</td>
                          <td className="text-right tabular-nums">{fmtBytes(l.bytes)}</td>
                          <td className="text-right tabular-nums">{fmtNum(l.tokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function GateTable({ gates }: { gates: InstructionPreview['effectiveGates'] }) {
  const [only, setOnly] = useState<string>('');
  const sources = [...new Set(gates.map((g) => g.source))];
  const shown = only ? gates.filter((g) => g.source === only) : gates;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setOnly('')} className={cx('text-xs rounded px-2 py-0.5 border border-line', only === '' && 'bg-panel2')}>
          全部
        </button>
        {sources.map((s) => (
          <button key={s} type="button" onClick={() => setOnly(s)} className={cx('text-xs rounded px-2 py-0.5', GATE_SOURCE[s]?.cls, only === s && 'ring-1 ring-current')}>
            {GATE_SOURCE[s]?.label ?? s}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>规则</th>
              <th>类别</th>
              <th>级别</th>
              <th>来源</th>
              <th>参数</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.rule}>
                <td>
                  <code className="text-xs">{g.rule}</code>
                </td>
                <td>{g.family === 'contract' ? '契约' : '手艺'}</td>
                <td>
                  <Badge tone={g.level === 'hard' ? 'danger' : g.level === 'soft' ? 'warn' : 'neutral'}>{g.level}</Badge>
                </td>
                <td>
                  <span className={cx('text-xs rounded px-1.5 py-0.5', GATE_SOURCE[g.source]?.cls)}>{GATE_SOURCE[g.source]?.label ?? g.source}</span>
                </td>
                <td className="text-xs text-sub">
                  {Object.keys(g.params).length > 0 && <code>{JSON.stringify(g.params)}</code>}
                  {g.allow.length > 0 && <span> 允许：{g.allow.join('、')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

