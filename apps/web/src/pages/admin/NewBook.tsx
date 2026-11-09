/** 开书向导：种子 → 题材 → 规模 → 档位与路由 → 发布 → 确认。Owner: lane H。 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { QUALITY_TIERS, zPublishConfig, type BookSummary, type CreateBook, type GenreSummary, type PublishConfig, type QualityTier, type RoutingPreset, type SystemSettings } from '@novelist/shared';
import { enc, post, put } from '../../api/client';
import { useApi, useInvalidate } from '../../api/hooks';
import { PublishFields } from '../../components/admin/shared';
import { Badge, Button, Card, cx, Empty, Field, Input, Notice, Page, PageHeader, Q, Textarea, Toggle } from '../../components/ui';
import { toast } from '../../components/toast';
import { fmtCjk } from '../../lib/format';
import { TIER_INFO } from '../../lib/labels';

const STEPS = ['种子', '题材', '规模', '档位与路由', '发布', '确认'] as const;

interface Scale {
  target_cjk: number;
  hard_max_cjk: number;
  volMin: number;
  volMax: number;
  chMin: number;
  chMax: number;
  lenMin: number;
  lenTarget: number;
  lenMax: number;
  countMode: 'han' | 'platform';
  /** 关闭时不写入，单章字数取题材包 pacing */
  customLength: boolean;
}
const DEFAULT_SCALE: Scale = { target_cjk: 3_000_000, hard_max_cjk: 3_500_000, volMin: 10, volMax: 12, chMin: 80, chMax: 110, lenMin: 2600, lenTarget: 3000, lenMax: 3800, countMode: 'han', customLength: false };

export function NewBookPage() {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const genres = useApi<GenreSummary[]>('/api/admin/genres');
  const presets = useApi<RoutingPreset[]>('/api/admin/routing/presets');
  const settings = useApi<SystemSettings>('/api/admin/settings');

  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [seed, setSeed] = useState('');
  const [interview, setInterview] = useState(false);
  const [genre, setGenre] = useState('');
  const [scale, setScale] = useState<Scale>(DEFAULT_SCALE);
  const [pickedTier, setTier] = useState<QualityTier | null>(null);
  const tier: QualityTier = pickedTier ?? settings.data?.defaultTier ?? 'lite';
  const [preset, setPreset] = useState<string | null>(null);
  const [publish, setPublish] = useState<PublishConfig>(() => zPublishConfig.parse({}));
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);

  const slugOk = slug === '' || /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
  const presetId = preset ?? settings.data?.activePreset ?? '';
  const estChapters = Math.round(scale.target_cjk / Math.max(1, scale.lenTarget));
  const planChapters: [number, number] = [scale.volMin * scale.chMin, scale.volMax * scale.chMax];
  const scaleWarn = estChapters < planChapters[0] || estChapters > planChapters[1];

  const canNext = useMemo(() => {
    if (step === 0) return title.trim() !== '' && slugOk;
    if (step === 1) return genre !== '';
    if (step === 2) return scale.target_cjk > 0 && scale.hard_max_cjk >= scale.target_cjk && scale.volMin <= scale.volMax && scale.chMin <= scale.chMax && (!scale.customLength || (scale.lenMin <= scale.lenTarget && scale.lenTarget <= scale.lenMax));
    return true;
  }, [step, title, slugOk, genre, scale]);

  async function submit() {
    setBusy(true);
    let createdSlug: string | null = null;
    try {
      const body: CreateBook = {
        title: title.trim(),
        slug: slug || undefined,
        genre,
        seed,
        tier,
        preset: preset ?? undefined,
        interview,
        start: false,
        scale: {
          target_cjk: scale.target_cjk,
          hard_max_cjk: scale.hard_max_cjk,
          volumes: [scale.volMin, scale.volMax],
          chapters_per_volume: [scale.chMin, scale.chMax],
          ...(scale.customLength ? { chapter_length: { min: scale.lenMin, target: scale.lenTarget, max: scale.lenMax, count_mode: scale.countMode } } : {}),
        },
      };
      const book = await post<BookSummary>('/api/admin/books', body);
      createdSlug = book.slug;
      const base = `/api/admin/books/${enc(book.slug)}`;
      await put(`${base}/publish`, publish);
      if (start) await post(`${base}/actions`, { action: 'start', interview });
      toast(start ? '已开书，规划开始' : '已创建', 'ok');
      await invalidate('/api/admin/books');
      void navigate({ to: '/admin/books/$slug/$tab', params: { slug: book.slug, tab: 'overview' } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (createdSlug) {
        // 书已创建，只是后续步骤失败：去设置页补做，不要重复开书
        toast(`书已创建，但后续配置失败：${msg}。请在设置页补做。`, 'danger');
        void navigate({ to: '/admin/books/$slug/$tab', params: { slug: createdSlug, tab: 'settings' } });
      } else toast(msg, 'danger');
    } finally {
      setBusy(false);
    }
  }

  const num = (k: keyof Scale) => ({
    type: 'number',
    min: 0,
    value: scale[k] as number,
    onChange: (e: { target: { value: string } }) => setScale((s) => ({ ...s, [k]: Number(e.target.value) || 0 })),
  });

  return (
    <Page>
      <PageHeader title="开新书" actions={<Link to="/admin/books" className="text-sm text-sub hover:text-ink">返回</Link>} />
      <ol className="flex gap-1 mb-4 overflow-x-auto no-scrollbar">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" disabled={i > step} onClick={() => setStep(i)} className={cx('text-xs px-2.5 py-1 rounded-full whitespace-nowrap', i === step ? 'bg-accent text-on-accent' : i < step ? 'bg-panel2 text-ink' : 'text-faint')}>
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      <Card>
        {step === 0 && (
          <div className="space-y-3 max-w-2xl">
            <Field label="书名">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            </Field>
            <Field label="Slug（可选，用于网址）" hint="小写字母、数字、连字符；留空自动生成" error={slugOk ? undefined : '格式不正确'}>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
            </Field>
            <Field label="种子 / 设想" hint="premise、灵感或参考，原样写入 bible/premise.md">
              <Textarea rows={10} value={seed} onChange={(e) => setSeed(e.target.value)} />
            </Field>
            <Toggle checked={interview} onChange={setInterview} label="规划前先访谈" hint="规划师会提最多 12 个问题，答案写入 premise 附录" />
          </div>
        )}

        {step === 1 && (
          <Q q={genres}>
            {(list) =>
              list.length === 0 ? (
                <Empty>
                  还没有题材包，先去
                  <Link to="/admin/genres" className="text-accent mx-1">
                    题材包
                  </Link>
                  页创建。
                </Empty>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {list.map((g) => (
                    <button key={g.id} type="button" onClick={() => setGenre(g.id)} className={cx('text-left border rounded-lg p-3 hover:bg-panel2', genre === g.id ? 'border-accent ring-1 ring-accent' : 'border-line')}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm">{g.name}</span>
                        {g.builtin && <Badge>内置</Badge>}
                      </div>
                      <p className="text-xs text-sub mt-1">{g.description || g.id}</p>
                    </button>
                  ))}
                </div>
              )
            }
          </Q>
        )}

        {step === 2 && (
          <div className="space-y-4 max-w-2xl">
            <div className="grid grid-cols-2 gap-3">
              <Field label="目标字数（汉字）" hint={fmtCjk(scale.target_cjk)}>
                <Input {...num('target_cjk')} />
              </Field>
              <Field label="硬上限（汉字）" hint={fmtCjk(scale.hard_max_cjk)} error={scale.hard_max_cjk < scale.target_cjk ? '不能小于目标字数' : undefined}>
                <Input {...num('hard_max_cjk')} />
              </Field>
              <Field label="卷数 最少">
                <Input {...num('volMin')} />
              </Field>
              <Field label="卷数 最多" error={scale.volMin > scale.volMax ? '不能小于最少值' : undefined}>
                <Input {...num('volMax')} />
              </Field>
              <Field label="每卷章数 最少">
                <Input {...num('chMin')} />
              </Field>
              <Field label="每卷章数 最多" error={scale.chMin > scale.chMax ? '不能小于最少值' : undefined}>
                <Input {...num('chMax')} />
              </Field>
            </div>
            <Toggle checked={scale.customLength} onChange={(v) => setScale((s) => ({ ...s, customLength: v }))} label="自定义单章字数" hint="关闭时使用题材包的节奏设置" />
            {scale.customLength && <div className="grid grid-cols-3 gap-3">
              <Field label="单章 最短">
                <Input {...num('lenMin')} />
              </Field>
              <Field label="单章 目标">
                <Input {...num('lenTarget')} />
              </Field>
              <Field label="单章 最长" error={scale.lenMin > scale.lenTarget || scale.lenTarget > scale.lenMax ? '需满足 最短 ≤ 目标 ≤ 最长' : undefined}>
                <Input {...num('lenMax')} />
              </Field>
            </div>}
            {scale.customLength && <Toggle checked={scale.countMode === 'platform'} onChange={(v) => setScale((s) => ({ ...s, countMode: v ? 'platform' : 'han' }))} label="按平台口径计字" hint="默认按纯汉字计数" />}
            <p className="text-sm text-sub">
              按目标字数和单章约 {scale.lenTarget} 字，约 {estChapters.toLocaleString('zh-CN')} 章；卷章设置给出 {planChapters[0].toLocaleString('zh-CN')}–{planChapters[1].toLocaleString('zh-CN')} 章。
            </p>
            {scaleWarn && <Notice tone="warn">两个估算对不上，规划师会很难同时满足，建议调整卷数、每卷章数或单章字数。</Notice>}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-xs text-sub mb-2">质量档位</h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {QUALITY_TIERS.map((t) => (
                  <button key={t} type="button" onClick={() => setTier(t)} className={cx('text-left border rounded-lg p-3 hover:bg-panel2', tier === t ? 'border-accent ring-1 ring-accent' : 'border-line')}>
                    <div className="font-medium text-sm">{TIER_INFO[t].label}</div>
                    <p className="text-xs text-sub mt-1">{TIER_INFO[t].desc}</p>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-xs text-sub mb-2">路由 Preset（开书后可随时修改）</h3>
              <Q q={presets}>
                {(list) => (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {list.map((p) => (
                      <button key={p.id} type="button" onClick={() => setPreset(p.id)} className={cx('text-left border rounded-lg p-3 hover:bg-panel2', presetId === p.id ? 'border-accent ring-1 ring-accent' : 'border-line')}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">{p.name}</span>
                          {settings.data?.activePreset === p.id && <Badge tone="ok">系统默认</Badge>}
                        </div>
                        <p className="text-xs text-sub mt-1">{p.description}</p>
                      </button>
                    ))}
                  </div>
                )}
              </Q>
            </div>
          </div>
        )}

        {step === 4 && <PublishFields value={publish} onChange={setPublish} />}

        {step === 5 && (
          <div className="space-y-3 max-w-2xl text-sm">
            <p>
              <b>{title}</b> · {genres.data?.find((g) => g.id === genre)?.name ?? genre}
            </p>
            <p className="text-sub">
              目标 {fmtCjk(scale.target_cjk)}，{scale.volMin}–{scale.volMax} 卷，每卷 {scale.chMin}–{scale.chMax} 章，单章 {scale.customLength ? `${scale.lenTarget} 字` : '按题材包'}。
            </p>
            <p className="text-sub">
              质量档 {TIER_INFO[tier].label}；路由 {presets.data?.find((p) => p.id === presetId)?.name ?? presetId}；发布 {publish.mode === 'scheduled' ? `按排期（${publish.cadence}）` : publish.mode === 'immediate' ? '验收后立即' : '手动'}。
            </p>
            <Toggle checked={start} onChange={setStart} label="创建后立即开始规划" hint="关闭则只建好书库，之后在概览页手动启动" />
          </div>
        )}

        <div className="flex justify-between mt-6">
          <Button disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            上一步
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              下一步
            </Button>
          ) : (
            <Button variant="primary" busy={busy} onClick={() => void submit()}>
              开书
            </Button>
          )}
        </div>
      </Card>
    </Page>
  );
}
