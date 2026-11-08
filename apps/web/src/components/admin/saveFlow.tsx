/** 保存书库/指令文件的二次确认流程（§7.8）：估算影响，needsConfirm 时展示后确认。 */
import type { ImpactEstimate } from '@novelist/shared';
import { ApiError, isImpact } from '../../api/client';
import { confirmDialog, KV } from '../ui';
import { fmtUsd } from '../../lib/format';

export function ImpactSummary({ i }: { i: ImpactEstimate }) {
  const windows = Object.entries(i.windowPct);
  return (
    <div className="space-y-2">
      <KV
        items={[
          ['作废任务', `${i.invalidatedTasks} 个`],
          ['预计重跑', `${i.estimatedRuns} 个 run`],
          ['受影响章节', i.affectedChapters ? `第 ${i.affectedChapters[0]}–${i.affectedChapters[1]} 章` : '无'],
          ['受影响 delta', `${i.affectedDeltas} 条`],
          ['预计花费', fmtUsd(i.usd)],
          ...windows.map(([w, v]): [string, string] => [`窗口 ${w}`, `约占 ${v}%`]),
        ]}
      />
      {i.notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-sub">
          {i.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const confirmImpact = (i: ImpactEstimate) => confirmDialog({ title: '这次修改的影响较大', body: <ImpactSummary i={i} />, okText: '仍然保存', danger: true });

/**
 * doSave(confirm) 发 PUT。有 estimate 时先估算；否则靠服务端 409/ImpactEstimate 响应触发确认。
 * 返回 null 表示用户取消。
 */
export async function saveWithImpact<T>(doSave: (confirm: boolean) => Promise<T | ImpactEstimate>, estimate?: () => Promise<ImpactEstimate>): Promise<T | null> {
  let confirmed = false;
  if (estimate) {
    const i = await estimate();
    if (i.needsConfirm) {
      if (!(await confirmImpact(i))) return null;
      confirmed = true;
    }
  }
  try {
    const r = await doSave(confirmed);
    if (!isImpact(r)) return r;
    if (!(await confirmImpact(r))) return null;
  } catch (e) {
    if (!(e instanceof ApiError) || !e.impact) throw e;
    if (!(await confirmImpact(e.impact))) return null;
  }
  const r = await doSave(true);
  if (isImpact(r)) throw new Error('服务端仍要求确认，保存未完成');
  return r;
}

export function saveErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) return '文件已被其他操作修改，请重新加载后再保存';
  return e instanceof Error ? e.message : String(e);
}
