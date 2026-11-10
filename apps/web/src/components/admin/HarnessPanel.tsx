/** Harness 安装、登录、账号、探测（模型与账号页的一节）。 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { AccountCheck, AccountView, AuthMethodSpec, AuthMode, Capabilities, CreateAccount, HarnessStatus, LoginOutputChunk, LoginSession, LoginSessionView } from '@novelist/shared';
import { del, enc, get, openEventStream, patch, post, put, qs, upload } from '../../api/client';
import { useAction, useApi, useInvalidate } from '../../api/hooks';
import { Badge, Button, Card, confirmDialog, cx, Empty, Field, Input, KV, Modal, Notice, Pre, Q, Textarea, Toggle } from '../ui';
import { toast } from '../toast';
import { accountPatch } from '../../lib/accounts';
import { stripAnsi } from '../../lib/ansi';
import { fmtBytes, fmtRel, fmtTime } from '../../lib/format';
import { AUTH_MODE_LABEL, INSTALL_TIER_LABEL } from '../../lib/labels';

const accKey = '/api/admin/accounts';

export function HarnessSection() {
  const harness = useApi<HarnessStatus[]>('/api/admin/harness');
  const accounts = useApi<AccountView[]>(accKey);
  const [adding, setAdding] = useState<HarnessStatus | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = accounts.data?.find((a) => a.id === openId) ?? null;

  return (
    <div>
      <p className="text-xs text-sub mb-3">每个 harness 可配多个账号：订阅登录、API Key + Base URL、或上传凭据文件。探测会在临时书房里试跑一次（写一个文件、读 AGENTS.md）。</p>
      <Q q={harness}>
        {(list) => (
          <div className="space-y-4">
            {list.map((h) => (
              <HarnessCard key={h.id} h={h} accounts={accounts.data?.filter((a) => a.harness === h.id) ?? []} onAdd={() => setAdding(h)} onOpen={setOpenId} />
            ))}
          </div>
        )}
      </Q>
      {adding && (
        <AddAccount
          h={adding}
          onClose={() => setAdding(null)}
          onCreated={(id) => {
            setAdding(null);
            setOpenId(id);
          }}
        />
      )}
      {open && <AccountPanel account={open} h={harness.data?.find((x) => x.id === open.harness) ?? null} onClose={() => setOpenId(null)} />}
    </div>
  );
}

interface InstallJob {
  id: string;
  state: string;
  log?: string[] | null;
}

/** 镜像不打包 harness，默认路由 agy 也要能在 UI 里装上：确认 → 后台安装 → 轮询日志 */
function InstallButton({ h }: { h: HarnessStatus }) {
  const invalidate = useInvalidate();
  const [job, setJob] = useState<InstallJob | null>(null);
  const start = useAction(() => post<InstallJob>(`/api/admin/harness/${enc(h.id)}/install`), { onDone: setJob });
  const finished = job !== null && job.state !== 'running';
  useEffect(() => {
    if (!job || finished) return;
    const id = setInterval(() => {
      void get<InstallJob>(`/api/admin/harness/install-jobs/${enc(job.id)}`).then(
        (j) => {
          setJob(j);
          if (j.state !== 'running') void invalidate('/api/admin/harness');
        },
        () => {},
      );
    }, 2000);
    return () => clearInterval(id);
  }, [job?.id, finished, invalidate]);
  async function run() {
    if (await confirmDialog({ title: `安装 ${h.displayName}？`, body: h.installHint ?? '将下载并安装到 /data/harness', okText: '开始安装' })) start.mutate();
  }
  return (
    <>
      <Button size="sm" busy={start.isPending || (job !== null && !finished)} onClick={() => void run()}>
        安装
      </Button>
      {job && (
        <Modal title={`安装 ${h.displayName}`} onClose={() => setJob(null)}>
          <p className="text-sm mb-2">{job.state === 'running' ? '安装中…' : job.state === 'done' ? '安装完成。' : '安装失败，见下方日志。'}</p>
          <Pre className="max-h-72">{(job.log ?? []).join('\n') || '（暂无输出）'}</Pre>
        </Modal>
      )}
    </>
  );
}

function HarnessCard({ h, accounts, onAdd, onOpen }: { h: HarnessStatus; accounts: AccountView[]; onAdd: () => void; onOpen: (id: string) => void }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const probe = useAction(() => post<Capabilities>(`/api/admin/harness/${enc(h.id)}/probe`), { onDone: setCaps, invalidate: ['/api/admin/harness'] });
  const listModels = useAction(() => get<string[]>(`/api/admin/harness/${enc(h.id)}/models`), { onDone: setModels });

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {h.displayName}
          {h.installed ? <Badge tone="ok">{h.versionDetected ?? '已安装'}</Badge> : <Badge tone="warn">未安装</Badge>}
          {h.install && <Badge tone={h.install.tier === 'blessed' ? 'ok' : h.install.tier === 'probed' ? 'info' : 'warn'}>{INSTALL_TIER_LABEL[h.install.tier] ?? h.install.tier}</Badge>}
        </span>
      }
      actions={
        <>
          <Button size="sm" busy={listModels.isPending} disabled={!h.installed} onClick={() => listModels.mutate()}>
            模型
          </Button>
          <Button size="sm" busy={probe.isPending} disabled={!h.installed} onClick={() => probe.mutate()}>
            探测
          </Button>
          {!h.installed && <InstallButton h={h} />}
          <Button size="sm" variant="primary" disabled={h.authMethods.length === 0} onClick={onAdd}>
            添加账号
          </Button>
        </>
      }
    >
      {!h.installed && (
        <div className="mb-3">
          <Notice tone="warn">
            未安装。支持版本 {h.supportedVersions}。点上方「安装」即可，或手动：<code className="text-xs">{h.installHint}</code>
          </Notice>
        </div>
      )}
      {h.installed && (
        <p className="text-xs text-faint mb-3">
          {h.binPath} · 支持 {h.supportedVersions}
          {h.capabilities && ` · 上次探测 ${fmtRel(h.capabilities.verifiedAt)}`}
        </p>
      )}
      {accounts.length === 0 ? (
        <Empty>还没有账号。</Empty>
      ) : (
        <ul className="divide-y divide-line -mx-4 -mb-4 border-t border-line">
          {accounts.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => onOpen(a.id)} className="w-full text-left px-4 py-2.5 hover:bg-panel2 flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{a.label || a.id}</span>
                <Badge tone="info">{AUTH_MODE_LABEL[a.authMode]}</Badge>
                {a.plan && <Badge>{a.plan}</Badge>}
                {!a.enabled && <Badge tone="warn">已停用</Badge>}
                {a.state?.sleepUntil && <Badge tone="warn">休眠至 {fmtTime(a.state.sleepUntil)}</Badge>}
                {a.state?.lastAuthCheck && <Badge tone={!a.state.lastAuthCheck.ok ? 'danger' : a.state.lastAuthCheck.configOnly ? 'warn' : 'ok'}>{!a.state.lastAuthCheck.ok ? '认证失败' : a.state.lastAuthCheck.configOnly ? '仅校验配置' : '认证正常'}</Badge>}
                {a.riskNotes.length > 0 && <Badge tone={a.riskNotes.some((n) => n.level === 'high') ? 'danger' : 'warn'}>风险说明 {a.riskNotes.length}</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {models && (
        <Modal title={`${h.displayName} 可用模型`} onClose={() => setModels(null)}>
          {models.length === 0 ? <Empty>没有列出模型。</Empty> : <Pre>{models.join('\n')}</Pre>}
        </Modal>
      )}
      {caps && (
        <Modal wide title={`${h.displayName} 能力探测`} onClose={() => setCaps(null)}>
          <CapabilityView caps={caps} />
        </Modal>
      )}
    </Card>
  );
}

function CapabilityView({ caps }: { caps: Capabilities }) {
  const yes = (v: boolean) => <Badge tone={v ? 'ok' : 'warn'}>{v ? '是' : '否'}</Badge>;
  return (
    <div className="space-y-3">
      <ul className="space-y-1">
        {caps.probeSteps.map((s) => (
          <li key={s.step} className="text-sm flex items-start gap-2">
            <Badge tone={s.ok ? 'ok' : 'danger'}>{s.ok ? '通过' : '失败'}</Badge>
            <span>
              {s.step}
              {s.detail && <span className="block text-xs text-sub">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      <KV
        items={[
          ['版本', caps.version],
          ['隔离', caps.isolation],
          ['配额信号', caps.quotaSignal],
          ['AGENTS.md 生效', yes(caps.tailNonceSurvives)],
          ['指令上限', caps.maxInstructionBytes ? fmtBytes(caps.maxInstructionBytes) : '无'],
          ['模型', caps.models.join('、') || '—'],
        ]}
      />
    </div>
  );
}

function RiskList({ notes }: { notes: { level: string; text: string }[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="space-y-2">
      {notes.map((n) => (
        <Notice key={n.text} tone={n.level === 'high' ? 'warn' : 'info'}>
          {n.text}
        </Notice>
      ))}
    </div>
  );
}

function AddAccount({ h, onClose, onCreated }: { h: HarnessStatus; onClose: () => void; onCreated: (id: string) => void }) {
  const [method, setMethod] = useState<AuthMethodSpec | null>(h.authMethods.length === 1 ? (h.authMethods[0] as AuthMethodSpec) : null);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [plan, setPlan] = useState('');
  const [env, setEnv] = useState<Record<string, string>>({});
  const [extraName, setExtraName] = useState('');
  const [models, setModels] = useState('');
  const idOk = /^[a-z0-9][a-z0-9-]*$/.test(id);
  const create = useAction((body: CreateAccount) => post<AccountView>(accKey, body), { ok: '账号已创建', invalidate: [accKey, '/api/admin/harness'], onDone: (a) => onCreated(a.id) });
  const missing = (method?.env.some((e) => e.required && !env[e.name]) ?? true) || (method?.requireOneOf ?? []).some((group) => !group.some((name) => env[name]));

  function submit() {
    if (!method) return;
    const known = new Map(method.env.map((e) => [e.name, e.secret]));
    create.mutate({
      id,
      harness: h.id,
      label,
      plan,
      authMode: method.mode as AuthMode,
      env: Object.entries(env)
        .filter(([, v]) => v)
        .map(([name, value]) => ({ name, value, secret: known.get(name) ?? true })),
      customModels: models.split(/[,，\s]+/).filter(Boolean),
    });
  }

  return (
    <Modal
      title={`添加 ${h.displayName} 账号`}
      onClose={onClose}
      footer={
        method && (
          <Button variant="primary" busy={create.isPending} disabled={!idOk || missing} onClick={submit}>
            创建
          </Button>
        )
      }
    >
      {!method ? (
        <div className="space-y-2">
          <p className="text-sm text-sub">选择认证方式：</p>
          {h.authMethods.map((m) => (
            <button key={m.mode} type="button" onClick={() => setMethod(m)} className="block w-full text-left border border-line rounded-lg p-3 hover:bg-panel2">
              <div className="text-sm font-medium">{m.label}</div>
              {m.riskNote && <div className="text-xs text-sub mt-1">{m.riskNote}</div>}
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <Notice>
            方式：{method.label}
            {method.login && '。创建后可在账号详情里发起交互登录。'}
            {method.files.length > 0 && '。创建后可上传凭据文件。'}
          </Notice>
          {method.riskNote && <Notice tone="warn">{method.riskNote}</Notice>}
          <Field label="账号 ID" hint="小写字母、数字、连字符" error={id && !idOk ? '格式不正确' : undefined}>
            <Input value={id} onChange={(e) => setId(e.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="名称">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label="订阅档位" hint="pro / max / ultra / api…">
              <Input value={plan} onChange={(e) => setPlan(e.target.value)} />
            </Field>
          </div>
          {method.env.map((e) => (
            <Field key={e.name} label={`${e.name}${e.required ? ' *' : ''}`} hint={e.hint}>
              <Input type={e.secret ? 'password' : 'text'} autoComplete="off" value={env[e.name] ?? ''} onChange={(ev) => setEnv({ ...env, [e.name]: ev.target.value })} />
            </Field>
          ))}
          {Object.keys(env)
            .filter((n) => !method.env.some((e) => e.name === n))
            .map((n) => (
              <Field key={n} label={n}>
                <Input type="password" autoComplete="off" value={env[n]} onChange={(ev) => setEnv({ ...env, [n]: ev.target.value })} />
              </Field>
            ))}
          <div className="flex gap-2 items-end">
            <Field label="其他环境变量" className="flex-1">
              <Input value={extraName} placeholder="变量名" onChange={(e) => setExtraName(e.target.value.toUpperCase())} />
            </Field>
            <Button
              disabled={!/^[A-Z_][A-Z0-9_]*$/.test(extraName)}
              onClick={() => {
                setEnv({ ...env, [extraName]: '' });
                setExtraName('');
              }}
            >
              添加
            </Button>
          </div>
          {method.allowsCustomModels && (
            <Field label="自定义模型名" hint="逗号或空格分隔，并入模型列表">
              <Input value={models} onChange={(e) => setModels(e.target.value)} />
            </Field>
          )}
        </div>
      )}
    </Modal>
  );
}

function AccountPanel({ account: a, h, onClose }: { account: AccountView; h: HarnessStatus | null; onClose: () => void }) {
  const method = h?.authMethods.find((m) => m.mode === a.authMode) ?? null;
  const path = `${accKey}/${enc(a.id)}`;
  const invalidate = useInvalidate();
  const [form, setForm] = useState({ label: a.label, plan: a.plan, enabled: a.enabled, concurrency: a.concurrency, customModels: a.customModels.join(', '), notes: a.notes, monthlyUsdCap: a.monthlyUsdCap ?? null });
  const [check, setCheck] = useState<AccountCheck | null>(null);
  const [login, setLogin] = useState<LoginSessionView | null>(null);

  const save = useAction(
    () =>
      patch<AccountView>(
        path,
        accountPatch(a, {
          label: form.label,
          plan: form.plan,
          enabled: form.enabled,
          concurrency: form.concurrency,
          customModels: form.customModels.split(/[,，\s]+/).filter(Boolean),
          notes: form.notes,
          ...(form.monthlyUsdCap === null ? {} : { monthlyUsdCap: form.monthlyUsdCap }),
        }),
      ),
    { ok: '已保存', invalidate: [accKey] },
  );
  const verify = useAction(() => post<AccountCheck>(`${path}/verify`), { onDone: setCheck, invalidate: [accKey] });
  const start = useAction((m: string) => post<LoginSessionView>(`${path}/login`, { mode: m }), { onDone: setLogin });
  const remove = useAction(() => del(path), { ok: '已删除', invalidate: [accKey, '/api/admin/harness'], onDone: onClose });
  const ack = useAction(({ id, on }: { id: string; on: boolean }) => patch(path, accountPatch(a, { riskAck: on ? [...new Set([...a.riskAck, id])] : a.riskAck.filter((x) => x !== id) })), { invalidate: [accKey] });
  const refresh = () => void invalidate(accKey);

  const envSpecs = method?.env ?? [];
  const envRows = [
    ...envSpecs.map((s) => ({ name: s.name, secret: s.secret, required: s.required, hint: s.hint, current: a.env.find((e) => e.name === s.name) })),
    ...a.env.filter((e) => !envSpecs.some((s) => s.name === e.name)).map((e) => ({ name: e.name, secret: e.secret, required: false, hint: undefined as string | undefined, current: e })),
  ];

  return (
    <Modal
      wide
      title={`账号 ${a.label || a.id}`}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="danger"
            onClick={async () => {
              if (await confirmDialog({ title: `删除账号 ${a.id}？`, body: '加密保存的密钥和凭据文件也会删除。', danger: true, okText: '删除' })) remove.mutate();
            }}
          >
            删除账号
          </Button>
          <Button busy={verify.isPending} onClick={() => verify.mutate()}>
            验证
          </Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {a.riskNotes.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs text-sub">风险说明（仅供知悉，不影响使用）</h3>
            {a.riskNotes.map((n) => (
              <div key={n.id} className="flex items-start gap-3">
                <div className="flex-1">
                  <RiskList notes={[n]} />
                </div>
                <Toggle checked={n.acked} onChange={(on) => ack.mutate({ id: n.id, on })} label="已知悉" />
              </div>
            ))}
          </section>
        )}

        {check && (
          <section>
            <Notice tone={!check.ok ? 'danger' : check.connectivity === 'config_only' || check.connectivity === 'reachable' ? 'warn' : 'info'}>
              {!check.ok ? '验证失败' : check.connectivity === 'config_only' ? '仅校验配置，未实际连通' : check.connectivity === 'reachable' ? '网关有响应，密钥未验证' : '验证通过'}：{check.detail}
            </Notice>
            <ul className="mt-2 space-y-1">
              {check.checks.map((c) => (
                <li key={c.id} className="text-sm flex gap-2">
                  <Badge tone={c.ok ? 'ok' : 'danger'}>{c.ok ? '通过' : '失败'}</Badge>
                  {c.detail}
                </li>
              ))}
            </ul>
            {check.models.length > 0 && <p className="text-xs text-sub mt-2">可用模型：{check.models.join('、')}</p>}
          </section>
        )}

        <section className="grid sm:grid-cols-2 gap-3">
          <Field label="名称">
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </Field>
          <Field label="订阅档位">
            <Input value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} />
          </Field>
          <Field label="并发上限">
            <Input type="number" min={1} value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
          <Field label="每月美元上限（可选）" hint="到了上限这个账号就不再派活；按额度窗口限用量请在书页的预算里设">
            <Input type="number" min={0} value={form.monthlyUsdCap ?? ''} onChange={(e) => setForm({ ...form, monthlyUsdCap: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          <Field label="自定义模型名" hint="逗号分隔；走自建网关时填网关的模型名" className="sm:col-span-2">
            <Input value={form.customModels} onChange={(e) => setForm({ ...form, customModels: e.target.value })} />
          </Field>
          <Field label="备注" className="sm:col-span-2">
            <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="启用此账号" />
        </section>

        <section>
          <h3 className="text-xs text-sub mb-2">环境变量（密钥加密保存，不会回显）</h3>
          <div className="space-y-2">
            {envRows.map((r) => (
              <EnvRow key={r.name} accountPath={path} {...r} onChange={refresh} />
            ))}
            <NewEnvRow accountPath={path} onChange={refresh} />
          </div>
        </section>

        <FilesSection account={a} specs={method?.files ?? []} accountPath={path} onChange={refresh} />

        {method?.login && (
          <section>
            <h3 className="text-xs text-sub mb-2">交互登录</h3>
            {login ? (
              <LoginPanel key={login.id} initial={login} onDone={refresh} />
            ) : (
              <div className="flex items-center gap-3">
                <Button busy={start.isPending} onClick={() => start.mutate(a.authMode)}>
                  开始登录
                </Button>
                <code className="text-xs text-faint truncate">{method.login.argv.join(' ')}</code>
              </div>
            )}
            {method.login.hint && <p className="text-xs text-faint mt-1">{method.login.hint}</p>}
          </section>
        )}
      </div>
    </Modal>
  );
}

function EnvRow({ accountPath, name, secret, required, hint, current, onChange }: { accountPath: string; name: string; secret: boolean; required: boolean; hint?: string; current?: AccountView['env'][number]; onChange: () => void }) {
  const [value, setValue] = useState(current?.value ?? '');
  const path = `${accountPath}/env/${enc(name)}`;
  const set = useAction(() => put(path, { value, secret }), {
    ok: '已更新',
    onDone: () => {
      if (secret) setValue('');
      onChange();
    },
  });
  const clear = useAction(() => del(path), {
    ok: '已删除',
    onDone: () => {
      setValue('');
      onChange();
    },
  });
  const isSet = current?.set ?? false;
  return (
    <div className="grid sm:grid-cols-[minmax(0,14rem)_1fr_auto] gap-2 items-center">
      <div className="min-w-0">
        <code className="text-xs block truncate">
          {name}
          {required && ' *'}
        </code>
        {hint && <span className="text-xs text-faint">{hint}</span>}
      </div>
      <Input type={secret ? 'password' : 'text'} autoComplete="off" placeholder={isSet ? (secret ? '已设置（留空不修改）' : '') : '未设置'} value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="flex gap-1">
        <Button size="sm" busy={set.isPending} disabled={!value || (!secret && value === current?.value)} onClick={() => set.mutate()}>
          保存
        </Button>
        {isSet && (
          <Button size="sm" variant="ghost" onClick={() => clear.mutate()}>
            清除
          </Button>
        )}
      </div>
    </div>
  );
}

function NewEnvRow({ accountPath, onChange }: { accountPath: string; onChange: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(true);
  const add = useAction(() => put(`${accountPath}/env/${enc(name)}`, { value, secret }), {
    ok: '已添加',
    onDone: () => {
      setName('');
      setValue('');
      onChange();
    },
  });
  return (
    <div className="grid sm:grid-cols-[minmax(0,14rem)_1fr_auto] gap-2 items-center">
      <Input placeholder="新变量名，如 ANTHROPIC_BASE_URL" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} />
      <Input type={secret ? 'password' : 'text'} autoComplete="off" placeholder="值" value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="flex items-center gap-2">
        <Toggle checked={secret} onChange={setSecret} label="秘密" />
        <Button size="sm" busy={add.isPending} disabled={!/^[A-Z_][A-Z0-9_]*$/.test(name) || !value} onClick={() => add.mutate()}>
          添加
        </Button>
      </div>
    </div>
  );
}

function FilesSection({ account: a, specs, accountPath, onChange }: { account: AccountView; specs: AuthMethodSpec['files']; accountPath: string; onChange: () => void }) {
  const [customPath, setCustomPath] = useState('');
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const remove = useAction((relPath: string) => del(`${accountPath}/files${qs({ relPath })}`), { ok: '已删除', onDone: onChange });

  async function send(e: ChangeEvent<HTMLInputElement>, relPath: string, part: 'state' | 'config') {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusyPath(relPath);
    try {
      const form = new FormData();
      form.set('relPath', relPath);
      form.set('part', part);
      form.set('file', file);
      await upload(`${accountPath}/files`, form);
      toast('凭据文件已上传', 'ok');
      setCustomPath('');
      onChange();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setBusyPath(null);
    }
  }

  const rows = [...specs.map((s) => ({ relPath: s.relPath, part: s.part, hint: s.hint })), ...a.files.filter((f) => !specs.some((s) => s.relPath === f.relPath)).map((f) => ({ relPath: f.relPath, part: f.part, hint: undefined as string | undefined }))];
  return (
    <section>
      <h3 className="text-xs text-sub mb-2">凭据文件</h3>
      <div className="space-y-2">
        {rows.map((r) => {
          const up = a.files.find((f) => f.relPath === r.relPath);
          return (
            <div key={r.relPath} className="flex flex-wrap items-center gap-2 text-sm">
              <code className="text-xs">{r.relPath}</code>
              {up ? <Badge tone="ok">{fmtBytes(up.bytes)} · {fmtRel(up.uploadedAt)}</Badge> : <Badge>未上传</Badge>}
              {r.hint && <span className="text-xs text-faint">{r.hint}</span>}
              <FileButton busy={busyPath === r.relPath} label={up ? '替换' : '上传'} onPick={(e) => void send(e, r.relPath, r.part)} />
              {up && (
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.relPath)}>
                  删除
                </Button>
              )}
            </div>
          );
        })}
        <div className="flex gap-2 items-center">
          <Input className="max-w-xs" placeholder="其他文件相对路径，如 .codex/auth.json" value={customPath} onChange={(e) => setCustomPath(e.target.value)} />
          <FileButton busy={busyPath === customPath && customPath !== ''} disabled={!/^(?!\/)(?!.*\.\.)[\w./-]+$/.test(customPath)} label="上传" onPick={(e) => void send(e, customPath, 'state')} />
        </div>
      </div>
    </section>
  );
}

function FileButton({ label, busy, disabled, onPick }: { label: string; busy: boolean; disabled?: boolean; onPick: (e: ChangeEvent<HTMLInputElement>) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" className="hidden" onChange={onPick} />
      <Button size="sm" busy={busy} disabled={disabled} onClick={() => ref.current?.click()}>
        {label}
      </Button>
    </>
  );
}

const TERMINAL: LoginSession['state'][] = ['succeeded', 'failed', 'cancelled', 'expired'];
const LOGIN_STATE: Record<LoginSession['state'], { label: string; tone: 'ok' | 'danger' | 'info' | 'warn' | 'neutral' }> = {
  starting: { label: '启动中', tone: 'info' },
  waiting_user: { label: '等待你完成登录', tone: 'warn' },
  succeeded: { label: '登录成功', tone: 'ok' },
  failed: { label: '登录失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
  expired: { label: '已过期', tone: 'danger' },
};

function LoginPanel({ initial, onDone }: { initial: LoginSessionView; onDone: () => void }) {
  const [session, setSession] = useState<LoginSession>(initial);
  const [chunks, setChunks] = useState<LoginOutputChunk[]>(initial.output);
  const [input, setInput] = useState('');
  const out = useRef<HTMLPreElement>(null);
  const sid = enc(initial.id);
  const done = TERMINAL.includes(session.state);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (TERMINAL.includes(initial.state)) return;
    return openEventStream(`/api/admin/login-sessions/${sid}/stream`, (e) => {
      if (e.type === 'login_output' && e.sessionId === initial.id) setChunks((c) => (c.some((x) => x.seq === e.chunk.seq) ? c : [...c, e.chunk].sort((a, b) => a.seq - b.seq)));
      else if (e.type === 'login_state' && e.session.id === initial.id) {
        setSession(e.session);
        if (TERMINAL.includes(e.session.state)) onDoneRef.current();
      }
    });
  }, [initial.id, initial.state, sid]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 有新输出就滚到底
  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [chunks]);

  const send = useAction((text: string) => post(`/api/admin/login-sessions/${sid}/input`, { text, newline: true }), { onDone: () => setInput('') });
  const cancel = useAction(() => post(`/api/admin/login-sessions/${sid}/cancel`));
  const state = LOGIN_STATE[session.state];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Badge tone={state.tone}>{state.label}</Badge>
        {!done && (
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>
            取消
          </Button>
        )}
      </div>
      {session.urls.map((u) => (
        <Notice key={u}>
          打开：
          <a href={u} target="_blank" rel="noreferrer" className="text-accent underline break-all">
            {u}
          </a>
        </Notice>
      ))}
      {session.codes.map((c) => (
        <div key={c} className="flex items-center gap-2">
          <span className="text-sm text-sub">验证码</span>
          <code className="text-lg font-semibold tracking-widest">{c}</code>
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(c).then(() => toast('已复制', 'ok'))}>
            复制
          </Button>
        </div>
      ))}
      <pre ref={out} className="bg-black text-neutral-200 text-xs font-mono p-3 rounded-md h-56 overflow-auto whitespace-pre-wrap">
        {chunks.map((c) => (
          <span key={c.seq} className={cx(c.stream === 'stderr' && 'text-red-300', c.stream === 'input' && 'text-sky-300', c.stream === 'system' && 'text-neutral-500')}>
            {stripAnsi(c.text)}
          </span>
        ))}
      </pre>
      {!done && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate(input);
          }}
        >
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="需要时在这里输入，回车发送" autoComplete="off" />
          <Button type="submit" busy={send.isPending}>
            发送
          </Button>
        </form>
      )}
    </div>
  );
}

