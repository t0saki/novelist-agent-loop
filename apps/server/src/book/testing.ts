/**
 * 测试夹具：生成一个小而合法的书仓库（lane B 优先实现——D/E/F 的测试依赖它）。Owner: lane B。
 * 内容：book.yaml（genre=xianxia）、compass、v01、a0001、c00001–c00006 卡、3 个实体（含 ambiguous 别名）、
 * world rules（含 vocab.conditions）、1 个 secret（leak_signatures）、前 accepted 章的 manuscript + ledger、overrides 空。
 *
 * 默认 accepted=2、cards=6。故事线（供其他 lane 的测试引用 FIXTURE 常量）：
 * - c00001 青云初雪：林枫与苏婉在青云宗；埋伏笔 F0001（铜牌之谜）；事实 fact.copper-token。
 * - c00002 后山遇袭：林枫左臂骨折（cond injury.arm.left.fracture），时间推进。
 * - c00003 雨夜渡口：pre 有伤 + 不知苏婉是卧底；post 林枫得知 fact.su-wan-spy；must_not 向读者揭示黑袍人身份。
 * - c00004 铜牌：推进 F0001；c00005 对峙：relation.set 敌对；c00006 真相（关键章）：回收 F0001。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import type { Card, Delta, Review } from '@novelist/shared';
import { chapterId, tags as gitTags, zCard, zDelta } from '@novelist/shared';
import { ledgerHash } from '../state/fold.js';
import { formatFrontmatter } from './canonical.js';
import { P } from './layout.js';
import { type BookRepo, initBookRepo } from './repo.js';
import { TRAILER } from './trailers.js';

export interface FixtureBookOptions {
  slug?: string;
  /** 已验收章数（写 manuscript + ledger + tag） */
  accepted?: number;
  /** 卡片数（≥ accepted） */
  cards?: number;
}

export const FIXTURE = {
  genre: 'xianxia',
  title: '青云志',
  entities: { linFeng: 'char.lin-feng', suWan: 'char.su-wan', qingyun: 'loc.qingyun' },
  facts: { suWanSpy: 'fact.su-wan-spy', copperToken: 'fact.copper-token', blackRobe: 'fact.lin-feng-is-black-robe' },
  conds: { armFracture: 'injury.arm.left.fracture', poison: 'poison.mild', exhausted: 'exhausted' },
  obligations: { copper: 'F0001' },
  secret: 'su-wan-spy',
  /** 卡片长度（fixture 正文约 1000–1300 汉字；其他 lane 的测试自己造草稿） */
  length: { min: 2600, target: 3000, max: 3800, count_mode: 'han' as const },
} as const;

const yaml = (v: unknown) => yamlStringify(v, { lineWidth: 0 });

function entityFiles(): { path: string; content: string }[] {
  return [
    {
      path: P.entity('characters', 'lin-feng'),
      content: formatFrontmatter(
        {
          id: 'char.lin-feng',
          kind: 'character',
          name: '林枫',
          aliases: [
            { text: '枫哥' },
            { text: '林三公子' },
            { text: '小林', ambiguous: true },
            { text: '师兄', scope: { pov: 'char.su-wan' }, ambiguous: true },
          ],
          identities: [{ id: 'ident.black-robe', alias: '黑袍人', known_by_fact: 'fact.lin-feng-is-black-robe' }],
          tier: 'major',
          born: { year: -18, calendar: '天元历' },
          first_ch: 'c00001',
          contract_by_stage: {
            s1: { voice: '克制、冷幽默，短句', never: ['长篇说教'], limits: ['不会主动伤害无辜'] },
            s3: { voice: '更冷、话更少', never: ['长篇说教'], limits: [] },
          },
          arc: 'plan/character-arcs/lin-feng.yaml',
          relations: [{ to: 'char.su-wan', type: '师兄妹' }],
          initial: { loc: 'loc.qingyun', stage: 's1', 'power.cultivation': '练气九层' },
        },
        '青云宗外门弟子，林家三子。表面散漫，实则心细如发。\n\n想要：查清父亲失踪的真相。需要：学会信任他人。\n',
      ),
    },
    {
      path: P.entity('characters', 'su-wan'),
      content: formatFrontmatter(
        {
          id: 'char.su-wan',
          kind: 'character',
          name: '苏婉',
          aliases: [{ text: '婉儿' }, { text: '师妹', ambiguous: true }],
          tier: 'major',
          first_ch: 'c00001',
          contract_by_stage: { s1: { voice: '温和，带一点狡黠', never: ['直接承认身份'], limits: [] } },
          arc: 'plan/character-arcs/su-wan.yaml',
          initial: { loc: 'loc.qingyun', 'power.cultivation': '练气七层' },
        },
        '青云宗内门弟子，林枫的师妹。性情温和，药理精通。\n',
      ),
    },
    {
      path: P.entity('locations', 'qingyun'),
      content: formatFrontmatter(
        { id: 'loc.qingyun', kind: 'location', name: '青云宗', aliases: ['青云山'], tier: 'minor' },
        '东境第一大宗，坐落于青云山七峰之间。外门在山脚，内门在云海之上。\n',
      ),
    },
  ];
}

function worldRules(): unknown {
  return {
    schema: 'nv.world/1',
    calendar: { name: '天元历', epoch: '天元元年' },
    systems: [{ id: 'cultivation', name: '修为', ranks: ['练气', '筑基', '金丹', '元婴'], rules: ['突破需要灵石与心境双重积累', '越级战斗代价极大'] }],
    vocab: {
      conditions: [
        { id: 'injury.arm.left.fracture', label: '左臂骨折' },
        { id: 'poison.mild', label: '轻度中毒' },
        { id: 'exhausted', label: '力竭' },
      ],
      proposals: [],
    },
    rules: ['宗门内禁止私斗', '魔门功法会在经脉留下黑纹'],
  };
}

function secretFile(): { path: string; content: string } {
  return {
    path: `${P.secretsDir}/su-wan-spy.md`,
    content: formatFrontmatter(
      {
        schema: 'nv.secret/1',
        id: 'su-wan-spy',
        fact: 'fact.su-wan-spy',
        truth: '苏婉是魔门安插在青云宗的卧底。',
        reveal_plan: [{ at: 'c00003', to: 'char.lin-feng', how: '渡口偷听' }],
        leak_signatures: ['苏婉.{0,8}(卧底|奸细)', '魔门.{0,4}卧底'],
      },
      '苏婉十岁被魔门收养，十四岁送入青云宗。她对林枫的感情是真的。\n',
    ),
  };
}

const BEATS = (no: number) => [
  { id: 'b1', mode: 'dramatize', cjk: 700, goal: `第${no}章开场：建立处境` },
  { id: 'b2', mode: 'dialogue', cjk: 800, goal: '人物交锋，推动冲突' },
  { id: 'b3', mode: 'dramatize', cjk: 900, goal: '转折' },
  { id: 'b4', mode: 'interior', cjk: 600, goal: '余波与钩子' },
];

const TITLES = ['青云初雪', '后山遇袭', '雨夜渡口', '铜牌', '对峙', '真相'];

export function fixtureCard(no: number): Card {
  const id = chapterId(no);
  const base: Record<string, unknown> = {
    schema: 'nv.card/1',
    id,
    title: TITLES[no - 1] ?? `第${no}章`,
    volume: 'v01',
    arc: 'a0001',
    length: FIXTURE.length,
    pov: 'char.lin-feng',
    entities_present: ['char.lin-feng', 'char.su-wan'],
    beats: BEATS(no),
  };
  if (no === 1) base.post = [{ op: 'obligation.open', id: 'F0001' }];
  if (no === 2) base.post = [{ has_cond: ['char.lin-feng', 'injury.arm.left.fracture'] }];
  if (no === 3) {
    base.pre = [{ has_cond: ['char.lin-feng', 'injury.arm.left.fracture'] }, { knows_not: ['char.lin-feng', 'fact.su-wan-spy'] }];
    base.post = [{ op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.su-wan-spy' }];
    base.must_not = [{ op: 'reader.reveal', fact: 'fact.lin-feng-is-black-robe' }];
    base.callbacks = [{ query: '铜牌 青云' }];
    base.notes = '这一章节奏放慢。';
  }
  if (no === 4) {
    base.pre = [{ knows: ['char.lin-feng', 'fact.su-wan-spy'] }];
    base.advances = ['F0001'];
  }
  if (no === 5) base.post = [{ op: 'relation.set', a: 'char.lin-feng', b: 'char.su-wan', type: '敌对' }];
  if (no === 6) {
    base.pays = ['F0001'];
    base.key = true;
  }
  return zCard.parse(base);
}

/** 第 no 章的正文段落（含 ev 引文） */
const EV: Record<number, string[]> = {
  1: ['青云山下了今冬第一场雪', '林枫把那枚铜牌收进袖中', '“师兄，你又偷懒。”苏婉笑道'],
  2: ['他左臂吊着绷带', '后山的林子里忽然窜出三道黑影', '林枫咬牙硬接了一掌'],
  3: ['……原来是她', '雨点砸在渡口的船篷上', '林枫贴着船舷，听见苏婉低声说话'],
};

const FILLER = [
  '山风从檐角卷过，吹得灯火一阵摇晃。',
  '远处传来钟声，一声接一声，沉沉地落进云海里。',
  '他没有说话，只是低头看着掌心的纹路。',
  '石阶上的积水映出半轮残月。',
  '药炉里的火还没熄，苦涩的气味弥漫开来。',
  '几个外门弟子从廊下走过，压低声音议论着什么。',
  '她把茶盏推到他面前，指尖在杯沿上停了一瞬。',
  '夜色渐深，山门外的石灯一盏盏亮起。',
  '他想起父亲离开那天，也是这样的天气。',
  '剑鞘上的旧痕在灯下泛着暗光。',
  '有人在远处喊了一声，很快又安静下来。',
  '“明日还要早课。”他说，“早些歇着吧。”',
];

export function fixtureManuscript(no: number): string {
  const evs = EV[no] ?? [`第${no}章的事情渐渐有了眉目`];
  const paras: string[] = [`# 第${no}章 ${TITLES[no - 1] ?? ''}`.trim()];
  for (let i = 0; i < 24; i++) {
    const a = FILLER[(no * 7 + i) % FILLER.length] as string;
    const b = FILLER[(no * 3 + i * 5 + 1) % FILLER.length] as string;
    const ev = i % 8 === 2 ? `${evs[Math.floor(i / 8) % evs.length]}。` : '';
    paras.push(`${ev}${a}${b}`);
  }
  return `${paras.join('\n\n')}\n`;
}

export function fixtureDelta(no: number, prevLedger: Delta[] = []): Delta {
  const id = chapterId(no);
  const ops: unknown[] = [];
  const summary: unknown[] = [];
  if (no === 1) {
    ops.push(
      { op: 'fact.assert', fact: 'fact.copper-token', text: '林枫持有父亲留下的铜牌', about: ['char.lin-feng'], ev: '林枫把那枚铜牌收进袖中' },
      { op: 'obligation.open', id: 'F0001', kind: 'mystery', weight: 'major', due: ['c00005', 'c00012'], text: '铜牌的来历', ev: '林枫把那枚铜牌收进袖中' },
      { op: 'time.advance', to: { year: 3, day: 300, calendar: '天元历' }, flashback: false, ev: '青云山下了今冬第一场雪' },
      { op: 'event', id: 'ev.c00001.e1', who: ['char.lin-feng', 'char.su-wan'], what: '初雪重逢', loc: 'loc.qingyun', ev: '“师兄，你又偷懒。”苏婉笑道' },
    );
    summary.push({ s: '初雪日林枫与苏婉重逢，收起父亲的铜牌。', anchors: ['op:1', 'ev:林枫把那枚铜牌收进袖中'] });
  } else if (no === 2) {
    ops.push(
      { op: 'event', id: 'ev.c00002.e1', who: ['char.lin-feng'], what: '后山遇袭', loc: 'loc.qingyun', ev: '后山的林子里忽然窜出三道黑影' },
      { op: 'entity.update', ent: 'char.lin-feng', from: { loc: 'loc.qingyun' }, set: { 'cond+': ['injury.arm.left.fracture'] }, ev: '他左臂吊着绷带' },
      { op: 'time.advance', to: { year: 3, day: 302, calendar: '天元历' }, flashback: false },
    );
    summary.push({ s: '林枫在后山遇袭，左臂骨折。', anchors: ['op:1', 'ev:他左臂吊着绷带'] });
  } else if (no === 3) {
    ops.push(
      { op: 'knowledge.learn', who: 'char.lin-feng', fact: 'fact.su-wan-spy', how: 'overheard', ev: '……原来是她' },
      { op: 'event', id: 'ev.c00003.e1', who: ['char.lin-feng', 'char.su-wan'], what: '渡口偷听', loc: 'loc.qingyun', ev: '林枫贴着船舷，听见苏婉低声说话' },
    );
    summary.push({ s: '雨夜渡口，林枫偷听到苏婉的密谈。', anchors: ['op:0', 'ev:……原来是她'] });
  } else {
    ops.push({ op: 'event', id: `ev.${id}.e1`, who: ['char.lin-feng'], what: `第${no}章事件`, ev: `第${no}章的事情渐渐有了眉目` });
    if (no === 4) ops.push({ op: 'obligation.advance', id: 'F0001', note: '铜牌纹样与魔门有关', ev: `第${no}章的事情渐渐有了眉目` });
    if (no === 5) ops.push({ op: 'relation.set', a: 'char.lin-feng', b: 'char.su-wan', type: '敌对', ev: `第${no}章的事情渐渐有了眉目` });
    if (no === 6) ops.push({ op: 'obligation.pay', id: 'F0001', ev: `第${no}章的事情渐渐有了眉目` });
    summary.push({ s: `第${no}章推进主线。`, anchors: ['op:0'] });
  }
  void prevLedger;
  return zDelta.parse({
    schema: 'nv.delta/1',
    chapter: id,
    mode: 'full',
    summary,
    ops,
    entities_present: ['char.lin-feng', 'char.su-wan'],
    realized_patterns: no % 2 ? ['重逢', '对话'] : ['战斗'],
  });
}

function fixtureReview(no: number): Review {
  return {
    schema: 'nv.review/1',
    chapter: chapterId(no),
    tier: 'standard',
    verdict: 'pass',
    scores: {},
    findings: [],
    missing_ops: [],
    continuity_flags: [],
    reviewers: [],
    degraded: [],
    revisions: 0,
    gate_summary: [],
  };
}

export async function createFixtureBook(dir: string, opts?: FixtureBookOptions): Promise<{ repo: BookRepo; head: string }> {
  const slug = opts?.slug ?? 'fixture';
  const nCards = Math.max(opts?.cards ?? 6, opts?.accepted ?? 2);
  const accepted = Math.min(opts?.accepted ?? 2, nCards);
  const { repo } = await initBookRepo(dir, {
    config: { slug, title: FIXTURE.title, genre: FIXTURE.genre },
    premise: '少年林枫在青云宗追查父亲失踪之谜，却发现身边最亲近的师妹另有身份。\n',
  });
  const files: { path: string; content: string }[] = [
    ...entityFiles(),
    secretFile(),
    { path: P.worldRules, content: yaml(worldRules()) },
    {
      path: P.compass,
      content: yaml({
        schema: 'nv.compass/1',
        logline: '外门弟子追查父亲失踪，揭开宗门与魔门的百年旧账。',
        genre: 'xianxia',
        promises: ['师门恩怨', '身份反转'],
        themes: ['信任'],
        protagonist_arc: { lie: '只能靠自己', want: '查清真相', need: '学会信任', truth: '信任是力量', stages: ['s1', 's2', 's3', 's4', 's5'] },
        scale: { target_cjk: 3000000, hard_max_cjk: 3500000, volumes: [10, 12], chapters_per_volume: [80, 110] },
        phases: { opening: ['c00001', 'c00003'] },
        ending: {
          direction: '林枫成为青云宗主，与苏婉和解',
          required_closures: ['F0001'],
          final_state: [{ obligation: 'F0001', status: 'paid' }, { manual: '主角与师门和解' }],
        },
        main_threads: [
          {
            id: 'T1',
            desc: '父亲失踪之谜',
            milestones: [
              { id: 'T1.m1', at: 0.15 },
              { id: 'T1.m2', at: 0.4 },
            ],
          },
        ],
      }),
    },
    {
      path: P.volume('v01'),
      content: yaml({
        schema: 'nv.volume/1',
        id: 'v01',
        title: '青云卷',
        detail: 'detailed',
        goal: '入门与第一次背叛',
        chapters: ['c00001', 'c00080'],
        arcs: [{ id: 'a0001', title: '初雪', question: '铜牌从何而来？' }],
      }),
    },
    {
      path: P.arc('a0001'),
      content: yaml({
        schema: 'nv.arc/1',
        id: 'a0001',
        volume: 'v01',
        title: '初雪',
        detail: 'detailed',
        question: '铜牌从何而来？',
        resolve_by: 'c00012',
        chapters: ['c00001', 'c00012'],
        goal: '林枫发现苏婉的秘密',
        opens: ['F0001'],
      }),
    },
    {
      path: P.characterArc('lin-feng'),
      content: yaml({
        schema: 'nv.charc/1',
        who: 'char.lin-feng',
        lie: '只能靠自己',
        want: '查清真相',
        need: '学会信任',
        stages: [
          { id: 's1', desc: '独行' },
          { id: 's3', desc: '怀疑' },
        ],
      }),
    },
    { path: P.characterArc('su-wan'), content: yaml({ schema: 'nv.charc/1', who: 'char.su-wan', stages: [{ id: 's1', desc: '潜伏' }] }) },
    { path: P.styleVoice, content: '叙述克制，多用短句；对话推动情节，少用形容词堆砌。\n' },
    { path: `${P.styleSamplesDir}/sample-01.md`, content: '雪落无声。他站在山门前，看着石阶一级一级没入白色里。\n' },
    { path: P.styleLexicon, content: yaml({ schema: 'nv.lexicon/1', ban: ['不禁', '仿佛'], watch: ['淡淡的'], allow: [] }) },
    { path: P.glossary, content: yaml({ schema: 'nv.glossary/1', terms: [{ term: '外门', def: '宗门外围弟子' }] }) },
  ];
  for (let n = 1; n <= nCards; n++) files.push({ path: P.card(n), content: yaml(stripUndefined(fixtureCard(n))) });
  await repo.writeFiles(files);
  await repo.commit({ message: 'plan: fixture bible and cards', trailers: { [TRAILER.task]: 'fixture.plan' } });

  const ledger: Delta[] = [];
  for (let n = 1; n <= accepted; n++) {
    const d = fixtureDelta(n, ledger);
    ledger.push(d);
    await repo.writeFiles([
      { path: P.manuscript(n), content: fixtureManuscript(n) },
      { path: P.ledger(n), content: `${JSON.stringify(d, null, 2)}\n` },
      { path: P.review(n), content: `${JSON.stringify(fixtureReview(n), null, 2)}\n` },
    ]);
    await repo.commit({
      message: `chapter: accept ${chapterId(n)}`,
      trailers: { [TRAILER.task]: `fixture.accept.${chapterId(n)}`, [TRAILER.snapshotHash]: ledgerHash(ledger, []) },
      tags: [gitTags.chapter(n)],
    });
  }
  return { repo, head: await repo.head() };
}

function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// =============================================================================================
// 合成大书（性能 / 配额 golden 测试）：不建 git，直接写文件树。确定性。
// =============================================================================================

export interface SyntheticBookOptions {
  chapters?: number;
  entities?: number;
  facts?: number;
  openObligations?: number;
  /** 每章正文字数（最后 3 章固定加长到 7000，用来测截断） */
  chapterChars?: number;
}

const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳'.split('');
const GIVEN = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔'.split('');
const PLACE = '山峰谷岭城镇阁殿楼台湖海川原林泽关渡'.split('');

function synthName(i: number, kind: string): string {
  if (kind === 'character') return `${SURNAMES[i % SURNAMES.length]}${GIVEN[(i * 7) % GIVEN.length]}${GIVEN[(i * 13 + 3) % GIVEN.length]}`;
  const a = GIVEN[(i * 11) % GIVEN.length] as string;
  const b = GIVEN[(i * 17 + 5) % GIVEN.length] as string;
  if (kind === 'location') return `${a}${b}${PLACE[i % PLACE.length]}`;
  if (kind === 'faction') return `${a}${b}${['宗', '门', '派', '盟', '帮'][i % 5]}`;
  if (kind === 'item') return `${a}${b}${['剑', '鼎', '珠', '镜', '符'][i % 5]}`;
  return `${a}${b}${['诀', '阵', '典', '律', '道'][i % 5]}`;
}

/** 合成一本 N 章的大书（默认 1500 章 / 800 实体 / 5000 事实 / 300 条未回收伏笔），返回关键 id */
export async function createSyntheticBook(
  dir: string,
  opts: SyntheticBookOptions = {},
): Promise<{ dir: string; chapters: number; entityIds: string[]; reentryEntity: string; nextCard: number }> {
  const N = opts.chapters ?? 1500;
  const NE = opts.entities ?? 800;
  const NF = opts.facts ?? 5000;
  const NO = opts.openObligations ?? 300;
  const chars = opts.chapterChars ?? 1800;
  const root = path.resolve(dir);
  const write = async (rel: string, content: string) => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  };
  const kinds: [string, string, string, number][] = [
    ['character', 'char', 'characters', Math.round(NE * 0.4)],
    ['location', 'loc', 'locations', Math.round(NE * 0.25)],
    ['faction', 'fac', 'factions', Math.round(NE * 0.12)],
    ['item', 'item', 'items', Math.round(NE * 0.12)],
  ];
  kinds.push(['concept', 'concept', 'concepts', NE - kinds.reduce((a, k) => a + k[3], 0)]);
  const ents: { id: string; kind: string; name: string }[] = [];
  const writes: Promise<void>[] = [];
  for (const [kind, prefix, kdir, count] of kinds) {
    for (let i = 0; i < count; i++) {
      const id = `${prefix}.e${String(i).padStart(4, '0')}`;
      const name = `${synthName(i, kind)}${i >= GIVEN.length * 4 ? String(i) : ''}`;
      ents.push({ id, kind, name });
      const tier = kind === 'character' ? (i < 20 ? 'major' : i < 150 ? 'minor' : 'extra') : 'minor';
      const fm: Record<string, unknown> = {
        id,
        kind,
        name,
        aliases: kind === 'character' ? [{ text: `${name.slice(0, 1)}兄${i}` }, { text: `阿${name.slice(-1)}`, ambiguous: true }] : [],
        tier,
        contract_by_stage: kind === 'character' && tier === 'major' ? { s1: { voice: '沉稳少言', never: ['背叛同门'], limits: [] } } : {},
        initial: kind === 'character' ? { loc: `loc.e${String(i % 50).padStart(4, '0')}`, 'power.cultivation': '练气一层' } : {},
      };
      writes.push(
        write(
          `bible/entities/${kdir}/${id.split('.')[1]}.md`,
          formatFrontmatter(fm, `${name}的设定。${'山高水长，风云际会，'.repeat(12)}\n\n${'此人心思深沉，旧事难忘。'.repeat(30)}\n`),
        ),
      );
    }
  }
  await Promise.all(writes);
  const chars_ = ents.filter((e) => e.kind === 'character');
  const locs = ents.filter((e) => e.kind === 'location');
  const reentry = (chars_[30] as { id: string }).id;
  await write(
    P.worldRules,
    yaml({
      schema: 'nv.world/1',
      calendar: { name: '天元历' },
      systems: [{ id: 'cultivation', name: '修为', ranks: ['练气', '筑基', '金丹', '元婴', '化神'], rules: ['突破需要心境'] }],
      vocab: { conditions: Array.from({ length: 50 }, (_, i) => ({ id: `cond.c${i}`, label: `状态${i}` })), proposals: [] },
      rules: Array.from({ length: 40 }, (_, i) => `世界规则第${i + 1}条：${'天道有常，'.repeat(5)}`),
    }),
  );
  await write(P.bookYaml, yaml({ schema: 'nv.book/1', slug: 'synthetic', title: '合成大书', genre: 'xianxia' }));
  // 规划：15 卷 × 100 章，弧 20 章
  const perVol = 100;
  const perArc = 20;
  const vols = Math.ceil((N + 20) / perVol);
  for (let v = 1; v <= vols; v++) {
    const a0 = (v - 1) * perVol + 1;
    await write(
      P.volume(`v${String(v).padStart(2, '0')}`),
      yaml({ schema: 'nv.volume/1', id: `v${String(v).padStart(2, '0')}`, title: `第${v}卷`, chapters: [chapterId(a0), chapterId(a0 + perVol - 1)], arcs: [] }),
    );
    await write(P.summaryVolume(`v${String(v).padStart(2, '0')}`), `${'本卷风云变幻，群雄并起。'.repeat(400)}\n`);
  }
  const arcs = Math.ceil((N + 20) / perArc);
  for (let a = 1; a <= arcs; a++) {
    const c0 = (a - 1) * perArc + 1;
    const vid = `v${String(Math.ceil(c0 / perVol)).padStart(2, '0')}`;
    const aid = `a${String(a).padStart(4, '0')}`;
    await write(
      P.arc(aid),
      yaml({
        schema: 'nv.arc/1',
        id: aid,
        volume: vid,
        title: `第${a}弧`,
        question: `第${a}弧的问题`,
        resolve_by: chapterId(c0 + perArc - 1),
        chapters: [chapterId(c0), chapterId(c0 + perArc - 1)],
      }),
    );
    if (c0 + perArc - 1 <= N) await write(P.summaryArc(aid), `${'此弧之中，众人各怀心思。'.repeat(150)}\n`);
  }
  await write(P.summaryBook, `${'少年出山，历经磨难，终成一代宗师。'.repeat(600)}\n`);
  await write(P.styleVoice, `${'叙述克制，短句为主。'.repeat(40)}\n`);
  for (let i = 1; i <= 3; i++) await write(`${P.styleSamplesDir}/s${i}.md`, `${'雪落无声，山门寂寂。'.repeat(i === 3 ? 900 : 200)}\n`);
  await write(P.styleLexicon, yaml({ schema: 'nv.lexicon/1', ban: ['不禁', '仿佛', '嘴角微扬'], watch: [], allow: [] }));

  // 账本与正文
  let factNo = 0;
  let oblNo = 0;
  const openObl: string[] = [];
  const totalOpen = NO + 300; // 开 600 条、回收 300 条
  const sentence = (no: number, k: number) => {
    const who = (chars_[(no + k) % chars_.length] as { name: string }).name;
    if (k % 6 === 1) return `${who}低声说道：“第${no}夜的事情，${['不可再拖', '我自有分寸', '你不必多问'][no % 3]}。”`;
    return `${who}${['走过长廊', '低声说道', '望向远山', '握紧了剑', '沉默良久', '冷笑一声'][k % 6]}，${'风声渐紧，云气翻涌'.slice(0, 4 + (k % 5))}。`;
  };
  const ledgerWrites: Promise<void>[] = [];
  for (let no = 1; no <= N; no++) {
    const ch = chapterId(no);
    const ops: unknown[] = [];
    const present = [0, 1, 2, 3].map((k) => (chars_[(no * 3 + k) % chars_.length] as { id: string }).id).filter((id) => id !== reentry || no <= 100);
    if (no === 100) present.push(reentry);
    const factsHere = Math.floor((no * NF) / N) - Math.floor(((no - 1) * NF) / N);
    for (let k = 0; k < factsHere; k++) {
      const f = `fact.f${factNo++}`;
      ops.push({
        op: 'fact.assert',
        fact: f,
        text: `事实${factNo}：${(ents[factNo % ents.length] as { name: string }).name}与旧事有关`,
        about: [present[0]],
        ev: sentence(no, 0),
      });
      if (k < 2) ops.push({ op: 'knowledge.learn', who: present[k % present.length], fact: f, ev: sentence(no, 1) });
    }
    ops.push({ op: 'entity.update', ent: present[0], set: { loc: (locs[no % locs.length] as { id: string }).id }, ev: sentence(no, 2) });
    ops.push({
      op: 'event',
      id: `ev.${ch}.e1`,
      who: present.slice(0, 2),
      what: `第${no}章事件`,
      loc: (locs[no % locs.length] as { id: string }).id,
      ev: sentence(no, 3),
    });
    ops.push({ op: 'time.advance', to: { year: 1 + Math.floor(no / 365), day: no % 365 }, flashback: false });
    if (oblNo < totalOpen && no % 2 === 0) {
      const id = `F${String(++oblNo).padStart(4, '0')}`;
      ops.push({
        op: 'obligation.open',
        id,
        kind: 'foreshadow',
        weight: oblNo % 10 === 0 ? 'major' : 'minor',
        due: [chapterId(no + 20), chapterId(no + 200)],
        text: `伏笔${oblNo}`,
        ev: sentence(no, 4),
      });
      openObl.push(id);
    }
    if (no % 4 === 1 && openObl.length > 0 && oblNo - openObl.length < totalOpen - NO) {
      const id = openObl.shift() as string;
      ops.push({ op: 'obligation.pay', id, ev: sentence(no, 5) });
    }
    if (no % 7 === 0 && openObl.length) ops.push({ op: 'obligation.advance', id: openObl[openObl.length - 1], note: '线索浮现', ev: sentence(no, 1) });
    const delta = {
      schema: 'nv.delta/1',
      chapter: ch,
      mode: 'full',
      summary: [{ s: `第${no}章：${(chars_[no % chars_.length] as { name: string }).name}遭遇变故，局势生变。`, anchors: ['op:0'] }],
      beats_realized: [],
      ops,
      uses_knowledge: [],
      realized_patterns: [['战斗', '对话', '修炼', '探索', '宴会'][no % 5], ['悬念', '反转'][no % 2]],
      entities_present: present,
    };
    const len = no > N - 3 ? 7000 : chars;
    const paras: string[] = [];
    let n = 0;
    let k = 0;
    while (n < len) {
      const p = `${sentence(no, k)}${sentence(no, k + 1)}${sentence(no, k + 2)}${no === 100 && k === 0 ? `${(chars_[30] as { name: string }).name}转身离去。` : ''}`;
      paras.push(p);
      n += p.length;
      k += 3;
    }
    ledgerWrites.push(write(P.ledger(no), JSON.stringify(delta)));
    ledgerWrites.push(write(P.manuscript(no), `${paras.join('\n')}\n`));
    if (ledgerWrites.length > 400) await Promise.all(ledgerWrites.splice(0));
  }
  await Promise.all(ledgerWrites);
  await write(
    P.overrides,
    `${JSON.stringify({ schema: 'nv.override/1', id: 'o1', ts: '2026-01-01T00:00:00Z', effective_from: chapterId(N - 10), target: { kind: 'entity', ent: present0(chars_), field: 'title' }, action: 'set', value: '长老', note: '正确为长老', author: 'owner' })}\n`,
  );
  // 缓冲卡
  for (let c = N + 1; c <= N + 12; c++) {
    const card: Record<string, unknown> = {
      schema: 'nv.card/1',
      id: chapterId(c),
      title: `第${c}章`,
      volume: `v${String(Math.ceil(c / perVol)).padStart(2, '0')}`,
      arc: `a${String(Math.ceil(c / perArc)).padStart(4, '0')}`,
      pov: (chars_[0] as { id: string }).id,
      entities_present: [...chars_.slice(0, 15).map((e) => e.id), reentry],
      beats: BEATS(c),
      pre: [{ alive: (chars_[0] as { id: string }).id }],
      must_not: [{ dead: (chars_[1] as { id: string }).id }],
      callbacks: [{ query: '旧事 伏笔' }, { quote: sentence(50, 3).slice(0, 8), from: chapterId(50) }],
    };
    if (openObl[0]) card.pays = [openObl[0]];
    await write(P.card(c), yaml(card));
  }
  return { dir: root, chapters: N, entityIds: ents.map((e) => e.id), reentryEntity: reentry, nextCard: N + 1 };
}

function present0(chars_: { id: string }[]): string {
  return (chars_[0] as { id: string }).id;
}
