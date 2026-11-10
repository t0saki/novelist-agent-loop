/**
 * 题材包参与自动开书的设置（P3 D31）：唯一的来源是 pack.yaml 的 auto.*，经 PATCH /api/admin/genres/:id/auto 写回（服务器整份校验、保留注释）。
 * 旧设置里的覆盖（autoStart.genres / autoStart.genreWeights）照旧优先，这里只显示为“覆盖”，只能清除。
 * 开书页的自动开书面板和题材页共用。
 */
import { useState } from 'react';
import type { GenreSummary, PatchGenreAuto, SystemSettingsView } from '@novelist/shared';
import { enc, patch } from '../../api/client';
import { useAction } from '../../api/hooks';
import { Badge, Button, Input } from '../ui';
import { useSectionSaver } from './settingsSave';

export function useGenreAutoPatch() {
  return useAction(({ id, body }: { id: string; body: PatchGenreAuto }) => patch<GenreSummary>(`/api/admin/genres/${enc(id)}/auto`, body), { ok: '已保存', invalidate: ['/api/admin/genres'] });
}

/** 实际生效的参与与权重（覆盖优先） */
export function effectiveAuto(g: GenreSummary): { enabled: boolean; weight: number } {
  const enabled = g.override.listed ?? g.auto?.enabled ?? false;
  const weight = g.override.weight ?? g.auto?.weight ?? 1;
  return { enabled: enabled && weight > 0 && !g.hidden, weight };
}

/** “覆盖（来自旧设置）”提示和清除按钮 */
export function OverrideNote({ g, settings }: { g: GenreSummary; settings: SystemSettingsView | undefined }) {
  const saver = useSectionSaver('已清除覆盖');
  if (g.override.listed === null && g.override.weight === null) return null;
  const base = settings?.updatedAt ?? null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs">
      <Badge tone="warn" title="旧版设置页写下的覆盖，优先于 pack.yaml">
        覆盖
        {g.override.listed !== null ? `：${g.override.listed ? '在清单里' : '不在清单里'}` : ''}
        {g.override.weight !== null ? `${g.override.listed !== null ? '，' : '：'}权重 ${g.override.weight}` : ''}
      </Badge>
      {g.override.listed !== null && (
        <Button size="sm" variant="ghost" busy={saver.isPending} disabled={!settings} title="清除旧设置里的题材清单（对所有题材包生效）" onClick={() => saver.save(base, { autoStart: { genres: null } })}>
          清除清单覆盖
        </Button>
      )}
      {g.override.weight !== null && settings && (
        <Button
          size="sm"
          variant="ghost"
          busy={saver.isPending}
          onClick={() => {
            const { [g.id]: _dropped, ...rest } = settings.autoStart.genreWeights;
            saver.save(base, { autoStart: { genreWeights: rest } });
          }}
        >
          清除覆盖
        </Button>
      )}
    </span>
  );
}

/** 开书页自动开书面板里的一行：参与开关 + 权重 */
export function GenreAutoRow({ g, settings }: { g: GenreSummary; settings: SystemSettingsView | undefined }) {
  const save = useGenreAutoPatch();
  const [weight, setWeight] = useState(String(g.auto?.weight ?? 1));
  const commitWeight = () => {
    const n = Number(weight);
    if (weight === '' || Number.isNaN(n) || n < 0 || n > 100) return setWeight(String(g.auto?.weight ?? 1));
    if (n !== (g.auto?.weight ?? 1)) save.mutate({ id: g.id, body: { weight: n } });
  };
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm py-1">
      <label className="flex items-center gap-2 min-w-0">
        <input type="checkbox" checked={g.auto?.enabled ?? false} disabled={save.isPending} aria-label={`${g.name} 参与自动开书`} onChange={(e) => save.mutate({ id: g.id, body: { enabled: e.target.checked } })} />
        <span className="truncate">{g.name}</span>
      </label>
      {g.hidden && <span className="text-xs text-faint whitespace-nowrap">已停用</span>}
      <span className="text-xs text-faint whitespace-nowrap">
        {g.books} 本{g.auto?.lengthHint ? ` · ${g.auto.lengthHint}` : ''}
        {g.auto?.adultOnly ? ' · 成人' : ''}
      </span>
      <OverrideNote g={g} settings={settings} />
      <span className="flex-1" />
      <Input type="number" min={0} max={100} step="any" className="!w-20 !py-0.5 text-xs" aria-label={`${g.name} 的权重`} title="权重（0 = 不参与）" value={weight} onChange={(e) => setWeight(e.target.value)} onBlur={commitWeight} />
    </li>
  );
}
