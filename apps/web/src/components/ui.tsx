/** 通用 UI 组件（中文界面）。Owner: lane H。 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Tone } from '../lib/labels';
import { dismissToast, useToasts } from './toast';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

type BtnVariant = 'primary' | 'default' | 'ghost' | 'danger';
const BTN: Record<BtnVariant, string> = {
  primary: 'bg-accent text-on-accent hover:opacity-90',
  default: 'bg-panel border border-line text-ink hover:bg-panel2',
  ghost: 'text-sub hover:bg-panel2 hover:text-ink',
  danger: 'bg-panel border border-danger/50 text-danger hover:bg-danger/10',
};

export function Button({ variant = 'default', size = 'md', busy, className, children, disabled, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button type="button" {...p} disabled={disabled || busy} className={cx('inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition disabled:opacity-50 disabled:cursor-not-allowed', size === 'sm' ? 'text-xs px-2.5 py-1 min-h-7' : 'text-sm px-3.5 py-1.5 min-h-9', BTN[variant], className)}>
      {busy && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span role="status" aria-label="加载中" className={cx('inline-block rounded-full border-2 border-current border-r-transparent animate-spin', className ?? 'size-5')} />;
}

const BADGE: Record<Tone, string> = {
  neutral: 'bg-faint/20 text-sub',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
  info: 'bg-info/15 text-info',
  accent: 'bg-accent/15 text-accent',
};
export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs whitespace-nowrap', BADGE[tone])}>
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('bg-panel border border-line rounded-lg min-w-0', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-line">
          <h2 className="text-sm font-semibold min-w-0">{title}</h2>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {sub && <p className="text-sm text-sub mt-0.5">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export const Page = ({ children, wide }: { children: ReactNode; wide?: boolean }) => <div className={cx('mx-auto p-4 md:p-6', wide ? 'max-w-[1500px]' : 'max-w-6xl')}>{children}</div>;

const inputCls = 'w-full rounded-md border border-line bg-panel text-ink px-2.5 py-1.5 text-sm placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60';
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, className)} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(inputCls, className)} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={cx(inputCls, className)}>
    {children}
  </select>
);

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: children 就是控件
    <label className={cx('block min-w-0', className)}>
      <span className="block text-xs text-sub mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint mt-1">{hint}</span>}
      {error && <span className="block text-xs text-danger mt-1">{error}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start gap-2 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" className="mt-0.5 accent-[var(--accent)] size-4 shrink-0" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-xs text-faint">{hint}</span>}
      </span>
    </label>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const titleId = useId();
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx('bg-panel border border-line w-full rounded-t-xl sm:rounded-xl flex flex-col max-h-[92dvh]', wide ? 'sm:max-w-4xl' : 'sm:max-w-lg')}>
        <header className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h3 id={titleId} className="font-semibold text-sm">
            {title}
          </h3>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
            ✕
          </Button>
        </header>
        <div className="p-4 overflow-y-auto flex-1 min-h-0">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 px-4 py-3 border-t border-line">{footer}</footer>}
      </div>
    </div>
  );
}

// 命令式确认框：await confirm({...})
interface ConfirmReq {
  title: string;
  body?: ReactNode;
  okText?: string;
  danger?: boolean;
  /** 要求输入此文字才能确认（删除书等） */
  typeToConfirm?: string;
  resolve: (ok: boolean) => void;
}
let confirmReq: ConfirmReq | null = null;
const confirmSubs = new Set<() => void>();
export function confirmDialog(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    confirmReq = { ...opts, resolve };
    for (const s of confirmSubs) s();
  });
}

function ConfirmHost() {
  const req = useSyncExternalStore(
    (s) => {
      confirmSubs.add(s);
      return () => confirmSubs.delete(s);
    },
    () => confirmReq,
  );
  const [typed, setTyped] = useState('');
  const finish = useCallback(
    (ok: boolean) => {
      req?.resolve(ok);
      confirmReq = null;
      setTyped('');
      for (const s of confirmSubs) s();
    },
    [req],
  );
  if (!req) return null;
  const blocked = req.typeToConfirm !== undefined && typed !== req.typeToConfirm;
  return (
    <Modal
      title={req.title}
      onClose={() => finish(false)}
      footer={
        <>
          <Button onClick={() => finish(false)}>取消</Button>
          <Button variant={req.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => finish(true)}>
            {req.okText ?? '确认'}
          </Button>
        </>
      }
    >
      <div className="text-sm space-y-3">
        {req.body}
        {req.typeToConfirm !== undefined && (
          <Field label={`输入 ${req.typeToConfirm} 以确认`}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </Field>
        )}
      </div>
    </Modal>
  );
}

const TOAST_CLS = { ok: 'border-ok/50', danger: 'border-danger/60', info: 'border-line' };
export function GlobalOverlays() {
  const toasts = useToasts();
  return (
    <>
      <ConfirmHost />
      <div className="fixed z-[60] bottom-4 left-4 right-4 sm:left-auto sm:w-80 space-y-2 pointer-events-none" aria-live="polite">
        {toasts.map((t) => (
          <button type="button" key={t.id} onClick={() => dismissToast(t.id)} className={cx('pointer-events-auto block w-full text-left bg-panel text-sm rounded-md border-l-4 border px-3 py-2 shadow-lg', TOAST_CLS[t.tone])}>
            {t.text}
          </button>
        ))}
      </div>
    </>
  );
}

export const Loading = ({ text = '加载中…' }: { text?: string }) => (
  <div className="flex items-center justify-center gap-2 p-10 text-sm text-sub">
    <Spinner className="size-4" /> {text}
  </div>
);

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-md border border-danger/40 bg-danger/10 text-sm p-3 flex items-center justify-between gap-3">
      <span>出错了：{message}</span>
      {retry && (
        <Button size="sm" onClick={retry}>
          重试
        </Button>
      )}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="text-sm text-faint text-center py-8 px-4">{children}</div>;

/** 查询三态：加载 / 错误 / 数据 */
export function Q<T>({ q, children, loading }: { q: Pick<UseQueryResult<T>, 'data' | 'error' | 'isLoading' | 'refetch'>; children: (d: T) => ReactNode; loading?: ReactNode }) {
  if (q.data !== undefined) return <>{children(q.data)}</>;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  return <>{loading ?? <Loading />}</>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line overflow-x-auto no-scrollbar mb-4">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)} className={cx('px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px', t.id === value ? 'border-accent text-ink font-medium' : 'border-transparent text-sub hover:text-ink')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="bg-panel border border-line rounded-lg px-4 py-3 min-w-0">
      <div className="text-xs text-sub">{label}</div>
      <div className="text-xl font-semibold mt-0.5 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-faint mt-0.5">{sub}</div>}
    </div>
  );
}

/** 占用率：越满越接近告警色；同时总有百分比文字，不只靠颜色 */
export function Meter({ ratio, label, detail, reserved }: { ratio: number | null; label?: ReactNode; detail?: ReactNode; reserved?: number }) {
  const r = ratio === null ? 0 : Math.max(0, Math.min(1, ratio));
  const color = r >= 0.9 ? 'bg-danger' : r >= 0.7 ? 'bg-warn' : 'bg-chart';
  return (
    <div className="min-w-0">
      {(label || detail) && (
        <div className="flex justify-between gap-2 text-xs mb-1">
          <span className="text-sub truncate">{label}</span>
          <span className="tabular-nums text-sub shrink-0">{detail ?? (ratio === null ? '未知' : `${Math.round(r * 100)}%`)}</span>
        </div>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: 原生 <meter> 无法画预留刻度 */}
      <div className="relative h-1.5 rounded-full bg-panel2 overflow-hidden" role="meter" aria-valuenow={Math.round(r * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cx('h-full rounded-full', ratio === null ? 'bg-faint/40 w-full' : color)} style={ratio === null ? undefined : { width: `${r * 100}%` }} />
        {reserved !== undefined && reserved > 0 && <div className="absolute top-0 bottom-0 w-0.5 bg-ink/50" style={{ left: `${Math.min(100, (1 - reserved) * 100)}%` }} title={`预留 ${Math.round(reserved * 100)}%`} />}
      </div>
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态的定义列表，顺序不变
        <div key={i} className="contents">
          <dt className="text-sub whitespace-nowrap">{k}</dt>
          <dd className="min-w-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LoadMore({ hasNext, busy, onClick }: { hasNext: boolean; busy: boolean; onClick: () => void }) {
  if (!hasNext) return null;
  return (
    <div className="text-center p-3">
      <Button size="sm" busy={busy} onClick={onClick}>
        加载更多
      </Button>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger'; children: ReactNode }) {
  const c = { info: 'border-info/40 bg-info/10', warn: 'border-warn/40 bg-warn/10', danger: 'border-danger/40 bg-danger/10' }[tone];
  return <div className={cx('rounded-md border text-sm px-3 py-2', c)}>{children}</div>;
}

export const Pre = ({ children, className }: { children: ReactNode; className?: string }) => <pre className={cx('text-xs font-mono bg-panel2 rounded-md p-3 overflow-auto whitespace-pre-wrap', className)}>{children}</pre>;

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Details({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group">
      <summary className="cursor-pointer text-sm select-none list-none flex items-center gap-1">
        <span className="text-faint group-open:rotate-90 transition-transform">▸</span>
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
