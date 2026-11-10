/**
 * 开书（docs/v3/DESIGN.md §9）：一个表单——题材（或随机）、篇幅（四档或随机）、一句话想法（可空），点一下。
 * 同页是自动开书面板：开关、未完结书上限、每日上限、篇幅分布、各篇幅档的目标字数、各题材的参与与权重。
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AUTO_LENGTHS, V3_LENGTHS, type BookSummary, type CreateBook, type GenreSummary, type SystemSettingsView, type V3Length } from '@novelist/shared';
import { post } from '../../api/client';
import { useAction, useApi } from '../../api/hooks';
import { GenreAutoRow } from '../../components/admin/GenreAuto';
import { useSectionSaver, useSettings } from '../../components/admin/settingsSave';
import { Button, Card, Details, Empty, Field, Input, Page, PageHeader, Q, Select, Textarea, Toggle } from '../../components/ui';
import { fmtCjk } from '../../lib/format';
import { V3_LENGTH_LABEL } from '../../lib/labels';

const LENGTH_DESC: Record<V3Length, string> = {
  short: '一次运行写完整本',
  medium: '开书一批，之后按批续写',
  long: '分段推进，按批续写',
  epic: '按卷推进，按批续写',
};

interface Advanced {
  title: string;
  target: string;
  batch: string;
  min: string;
}
const NO_ADVANCED: Advanced = { title: '', target: '', batch: '', min: '' };
const posInt = (s: string) => (/^\d+$/.test(s.trim()) && Number(s) > 0 ? Number(s) : null);

/** 开书请求体：没填的高级项不发，由服务器按篇幅和全站默认值补 */
export function newBookBody(genre: string, length: V3Length | 'random', idea: string, adv: Advanced, start: boolean): CreateBook {
  const body: CreateBook = { genre, length, idea: idea.trim() };
  if (adv.title.trim()) body.title = adv.title.trim();
  const t = posInt(adv.target);
  if (t !== null) body.target_cjk = t;
  const b = posInt(adv.batch);
  if (b !== null) body.batch = b;
  const m = posInt(adv.min);
  if (m !== null) body.min_chapter_cjk = m;
  if (!start) body.start = false;
  return body;
}

function NewBookForm({ genres, settings }: { genres: GenreSummary[]; settings: SystemSettingsView | undefined }) {
  const navigate = useNavigate();
  const [genre, setGenre] = useState('random');
  const [length, setLength] = useState<V3Length | 'random'>('random');
  const [idea, setIdea] = useState('');
  const [adv, setAdv] = useState<Advanced>(NO_ADVANCED);
  const [start, setStart] = useState(true);
  const visible = genres.filter((g) => !g.hidden);
  const batch = adv.batch === '' ? null : posInt(adv.batch);
  const advErr = (adv.target !== '' && posInt(adv.target) === null) || (adv.min !== '' && posInt(adv.min) === null) || (adv.batch !== '' && (batch === null || batch > 8));
  const create = useAction(() => post<BookSummary>('/api/admin/books', newBookBody(genre, length, idea, adv, start)), {
    ok: start ? '已开书，开书运行马上开始' : '已创建',
    invalidate: ['/api/admin/books'],
    onDone: (b) => void navigate({ to: '/admin/books/$slug/$tab', params: { slug: b.slug, tab: 'overview' } }),
  });
  const target = (len: V3Length) => settings?.autoStart.lengths[len].targetCjk;

  return (
    <Card title="开一本新书" className="mb-4">
      <form
        className="space-y-3 max-w-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (!advErr) create.mutate();
        }}
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="题材">
            <Select value={genre} onChange={(e) => setGenre(e.target.value)} aria-label="题材">
              <option value="random">随机（按自动开书的权重挑）</option>
              {visible.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="篇幅" hint={length === 'random' ? '按篇幅分布补缺口最大的一档' : `${LENGTH_DESC[length]}${target(length) ? `，约 ${fmtCjk(target(length) as number)}` : ''}`}>
            <Select value={length} onChange={(e) => setLength(e.target.value as V3Length | 'random')} aria-label="篇幅">
              <option value="random">随机</option>
              {V3_LENGTHS.map((l) => (
                <option key={l} value={l}>
                  {V3_LENGTH_LABEL[l]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="一句话想法（可空）" hint="写进种子；空着就由作者自己想">
          <Textarea rows={2} maxLength={300} value={idea} onChange={(e) => setIdea(e.target.value)} aria-label="一句话想法" />
        </Field>
        <Details summary={<span className="text-xs text-sub">高级（书名、目标字数、每批章数、每章下限）</span>}>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="书名" hint="可留空，由作者在设定里起名">
              <Input value={adv.title} onChange={(e) => setAdv({ ...adv, title: e.target.value })} />
            </Field>
            <Field label="目标字数（汉字，下限）" hint="空 = 按篇幅档" error={adv.target !== '' && posInt(adv.target) === null ? '需为正整数' : undefined}>
              <Input type="number" min={1} value={adv.target} onChange={(e) => setAdv({ ...adv, target: e.target.value })} />
            </Field>
            <Field label="每批章数" hint="1–8，空 = 5" error={adv.batch !== '' && (batch === null || batch > 8) ? '需为 1–8 的整数' : undefined}>
              <Input type="number" min={1} max={8} value={adv.batch} onChange={(e) => setAdv({ ...adv, batch: e.target.value })} />
            </Field>
            <Field label="每章不少于（汉字）" hint="空 = 3000" error={adv.min !== '' && posInt(adv.min) === null ? '需为正整数' : undefined}>
              <Input type="number" min={1} value={adv.min} onChange={(e) => setAdv({ ...adv, min: e.target.value })} />
            </Field>
          </div>
        </Details>
        <Toggle checked={start} onChange={setStart} label="创建后立即开书" hint="关闭则只建好书房，之后在书页上点开始" />
        <div>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={advErr}>
            开书
          </Button>
        </div>
      </form>
    </Card>
  );
}

type LengthTargets = Record<V3Length, string>;

/** 自动开书面板。开关单独保存（这是唯一会带 autoStart.enabled 的请求）；其余一起保存，不带 enabled */
export function AutoStartPanel({ settings: s, genres }: { settings: SystemSettingsView; genres: GenreSummary[] }) {
  const a = s.autoStart;
  const toggle = useSectionSaver();
  const saver = useSectionSaver();
  const [maxUnfinished, setMaxUnfinished] = useState(String(a.maxUnfinishedBooks));
  const [maxPerDay, setMaxPerDay] = useState(String(a.maxPerDay));
  const [mix, setMix] = useState<Record<V3Length, string>>(() => Object.fromEntries(AUTO_LENGTHS.map((k) => [k, String(a.lengthMix[k])])) as Record<V3Length, string>);
  const [targets, setTargets] = useState<LengthTargets>(() => Object.fromEntries(AUTO_LENGTHS.map((k) => [k, String(a.lengths[k].targetCjk)])) as LengthTargets);
  const mixNums = AUTO_LENGTHS.map((k) => Number(mix[k]));
  const mixSum = mixNums.reduce((x, y) => x + (Number.isFinite(y) ? y : 0), 0);
  const mixOk = mixNums.every((n) => Number.isFinite(n) && n >= 0 && n <= 100) && mixSum === 100;
  const unfinishedOk = posInt(maxUnfinished) !== null;
  const perDayOk = /^\d+$/.test(maxPerDay.trim());
  const targetsOk = AUTO_LENGTHS.every((k) => (posInt(targets[k]) ?? 0) >= 1000);
  const canSave = mixOk && unfinishedOk && perDayOk && targetsOk;

  function save() {
    saver.save(s.updatedAt, {
      autoStart: {
        maxUnfinishedBooks: Number(maxUnfinished),
        maxPerDay: Number(maxPerDay),
        lengthMix: Object.fromEntries(AUTO_LENGTHS.map((k) => [k, Number(mix[k])])),
        lengths: Object.fromEntries(AUTO_LENGTHS.map((k) => [k, { targetCjk: Number(targets[k]) }])),
      },
    });
  }

  return (
    <Card title="自动开书">
      <Toggle checked={a.enabled} disabled={toggle.isPending} onChange={(v) => toggle.save(s.updatedAt, { autoStart: { enabled: v } })} label="有空位时自动开新书" hint="默认关闭。开启后按题材权重和篇幅分布挑选，会持续消耗账号额度。" />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
        <Field label="未完结的书上限" hint="在写、等待和暂停的都算，旧书不算" error={unfinishedOk ? undefined : '需为正整数'}>
          <Input type="number" min={1} value={maxUnfinished} onChange={(e) => setMaxUnfinished(e.target.value)} />
        </Field>
        <Field label="24 小时内最多开几本" hint="0 表示不限" error={perDayOk ? undefined : '需为非负整数'}>
          <Input type="number" min={0} value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3">
        <div className="text-xs text-sub mb-1">篇幅分布（按本数的百分比）：看最近 20 本自动开的书，补缺口最大的一档；题材包的篇幅倾向只是加权</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {AUTO_LENGTHS.map((k) => (
            <Field key={k} label={`${V3_LENGTH_LABEL[k]} %`}>
              <Input type="number" min={0} max={100} value={mix[k]} onChange={(e) => setMix({ ...mix, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className={`text-xs mt-1 tabular-nums ${mixSum === 100 ? 'text-sub' : 'text-danger'}`}>合计 {mixSum}%{mixSum === 100 ? '' : '（要等于 100% 才能保存）'}</div>
      </div>
      <div className="mt-3">
        <div className="text-xs text-sub mb-1">各篇幅档的目标字数（手动开书和自动开书都用；只是下限，写多了照收）</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {AUTO_LENGTHS.map((k) => (
            <Field key={k} label={`${V3_LENGTH_LABEL[k]}（字）`} error={(posInt(targets[k]) ?? 0) >= 1000 ? undefined : '至少 1000'}>
              <Input type="number" min={1000} value={targets[k]} onChange={(e) => setTargets({ ...targets, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
      </div>
      <div className="flex justify-end mt-3">
        <Button variant="primary" disabled={!canSave} busy={saver.isPending} onClick={save}>
          保存自动开书设置
        </Button>
      </div>
      <div className="mt-4">
        <div className="text-xs text-sub mb-1">参与的题材包与权重（写进各包的 pack.yaml；按“自动开过的书数 ÷ 权重”最小的先开）</div>
        {genres.length === 0 ? (
          <Empty>还没有题材包。</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {genres.map((g) => (
              <GenreAutoRow key={`${g.id}-${g.auto?.weight ?? ''}`} g={g} settings={s} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export function NewBookPage() {
  const genres = useApi<GenreSummary[]>('/api/admin/genres');
  const settings = useSettings();
  return (
    <Page>
      <PageHeader title="开书" />
      <Q q={genres}>{(list) => <NewBookForm genres={list} settings={settings.data} />}</Q>
      <Q q={settings}>{(s) => <AutoStartPanel key={s.updatedAt ?? 'new'} settings={s} genres={genres.data ?? []} />}</Q>
    </Page>
  );
}
