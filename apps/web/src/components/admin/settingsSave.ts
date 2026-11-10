/**
 * 系统设置按节保存（P3 D30）：每张卡片只发自己那一节，带上读到的 updatedAt（baseUpdatedAt）。
 * 设置在别处被改过 → 服务器 409 stale_settings：重新读一遍，请主人再改一次。
 */
import type { SystemSettingsView } from '@novelist/shared';
import { ApiError, put } from '../../api/client';
import { useAction, useApi, useInvalidate } from '../../api/hooks';
import { toast } from '../toast';

export const SETTINGS_PATH = '/api/admin/settings';

export const useSettings = () => useApi<SystemSettingsView>(SETTINGS_PATH);

/** section 是 SystemSettings 的一部分（例如 `{ autoStart: { enabled } }`）；baseUpdatedAt 自动带上 */
export function useSaveSettings(ok = '已保存') {
  const invalidate = useInvalidate();
  return useAction(({ base, section }: { base: string | null; section: Record<string, unknown> }) => put<SystemSettingsView>(SETTINGS_PATH, { baseUpdatedAt: base, ...section }), {
    silentError: true,
    onDone: () => {
      toast(ok, 'ok');
      void invalidate(SETTINGS_PATH, '/api/admin/genres');
    },
  });
}

/** useSaveSettings 的错误提示：过期的设置单独说明，并重新读取 */
export function settingsErrorText(e: unknown): string {
  if (e instanceof ApiError && e.problem.code === 'stale_settings') return '设置在别处改过了，已重新读取，请再改一次';
  return e instanceof Error ? e.message : String(e);
}

/** 包一层：失败时提示并刷新设置 */
export function useSectionSaver(ok?: string) {
  const save = useSaveSettings(ok);
  const invalidate = useInvalidate();
  return {
    isPending: save.isPending,
    save: (base: string | null, section: Record<string, unknown>) =>
      save.mutate(
        { base, section },
        {
          onError: (e) => {
            toast(settingsErrorText(e), 'danger');
            void invalidate(SETTINGS_PATH);
          },
        },
      ),
  };
}
