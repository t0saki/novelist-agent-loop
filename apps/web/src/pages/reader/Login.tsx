/** 单框密码登录：管理员或读者密码。Owner: lane H。 */
import { useState, type FormEvent } from 'react';
import type { MeResponse } from '@novelist/shared';
import { ApiError, post } from '../../api/client';
import { queryClient } from '../../api/queryClient';
import { Button, Input, Toggle } from '../../components/ui';

/** 只允许站内跳转，防止 next 参数被用作开放重定向 */
export function safeNext(next: string | null | undefined): string | null {
  return next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : null;
}

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await post<MeResponse>('/api/auth/login', { password, remember });
      queryClient.clear();
      queryClient.setQueryData(['/api/auth/me'], me);
      const next = safeNext(new URLSearchParams(window.location.search).get('next'));
      window.location.assign(next ?? (me.role === 'admin' ? '/admin' : '/'));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? '密码不正确' : err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm bg-panel border border-line rounded-xl p-6 space-y-4">
        <div className="text-center">
          <h1 className="font-serif text-2xl font-semibold">Novelist</h1>
          <p className="text-sm text-sub mt-1">输入密码进入阅读室</p>
        </div>
        <Input type="password" autoFocus autoComplete="current-password" aria-label="密码" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Toggle checked={remember} onChange={setRemember} label="在此设备上保持登录" />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" busy={busy} disabled={!password}>
          进入
        </Button>
      </form>
    </div>
  );
}
