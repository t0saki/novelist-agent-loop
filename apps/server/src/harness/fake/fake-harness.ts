#!/usr/bin/env node
/**
 * fake harness 可执行入口（见 adapters/fake.ts 的行为说明）。Owner: lane A。
 * 用法：node fake-harness.js --v3 --launch <file> [--scenario <json file>] [--model <m>] [--session <id>]
 *                                               （目录模式：cwd = 书快照，读 ORDER.md，见 dirMain）
 *       node fake-harness.js --login            （交互登录演示：打印 URL + 验证码，读一行输入后写 $HOME/.fake/auth.json）
 *
 * 单文件、只依赖 node 内置模块；只用可擦除 TS 语法（开发/测试时 node 直接 type-strip 运行 .ts）。
 * stdout 每行一个 NEventBody（{t:'init'…}…{t:'result'}）；文件直接写在 cwd（书快照）里。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 故障注入（$RUN/in/fake.json；数组时取第一个） */
export interface FakeScenario {
  fail?: string;
  failMessage?: string;
  exitCode?: number;
  sleepMs?: number;
  dripMs?: number;
  ignoreSigterm?: boolean;
  malformedJson?: boolean;
  rateLimit?: { window?: string; utilization?: number; resetsAt?: string; status?: string };
  noResult?: boolean;
  /** 写完文件后再失败（文件在，但 harness 报错） */
  failAfterWrite?: boolean;
  /** v3 目录模式（--v3）的混沌开关；serverFault 只由服务端读取（测试钩子） */
  v3?: FakeV3Chaos;
  /** 目录探测：'skipAgents' = canary.txt 不写 AGENTS.md 里的暗号（模拟指令文件没被读到） */
  canary?: 'skipAgents';
}

/** v3 目录模式的混沌开关（p1-plan §3 Harness） */
export interface FakeV3Chaos {
  /** 什么都不写（零改动） */
  zeroOutput?: boolean;
  /** 本批第 n 章（1 起）写短：完整但不到下限 */
  shortChapter?: number;
  /** 最后一章停在半句话 */
  truncateLast?: boolean;
  /** 正文写到 chapters/00k.md，笔记写到根目录 notes.md */
  wrongDir?: boolean;
  /** 全部章节写进 manuscript/batch.md */
  oneFile?: boolean;
  /** 未经允许改写已入库的第 k 章 */
  rewriteAccepted?: number;
  /** 另写一个旧章号 k 的 chapters/00k.md */
  oldNumberElsewhere?: number;
  /** 往不入库的目录写 views/scratch.md */
  ignoredDir?: boolean;
  /** 不写笔记 */
  noNotes?: boolean;
  /** 写完 k 章后 SIGKILL 自己 */
  killAfter?: number;
  /** 非结局批也写“（全书完）” */
  endMarkerEarly?: boolean;
  /** 结局批不写“（全书完）” */
  noMarker?: boolean;
  /** 覆盖本批章数 */
  chapters?: number;
  /** 多发这么多个读文件的 tool_call 事件（工具步数测试） */
  extraSteps?: number;
  /** 把这个说法插进每一段（重复统计测试） */
  repeatPhrase?: string;
  /** 复盘时改写 manuscript/c{k}.md（不该生效） */
  retroEditChapter?: number;
  /** 复盘什么都不写 */
  retroZero?: boolean;
  /** 同 endMarkerEarly：普通批也写“（全书完）”（结局测试用的别名） */
  markerAlways?: boolean;
  /**
   * 任务单允许改写的每一章都改（不只补短章）：append = 末尾加一段；shorten = 保留标题和正文前 60%（截在句末）；
   * shorten-hard = 只留 20%（“主人要求的改写太短 → 保留原版”）
   */
  rewriteAllowed?: 'append' | 'shorten' | 'shorten-hard';
  serverFault?: 'finalize' | 'promote' | 'crashAfterHarvest';
}

// ───────── 计数（与 shared/text.ts 一致） ─────────
const HAN_RE = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2ebef}\u{30000}-\u{3134f}]/gu;
const CJK_PUNCT_RE = /[　-〿＀-￯—…“”‘’]/gu;
export function fakeCount(text: string, mode: 'han' | 'platform' = 'han'): number {
  const han = text.match(HAN_RE)?.length ?? 0;
  if (mode === 'han') return han;
  return han + (text.match(CJK_PUNCT_RE)?.length ?? 0) + (text.match(/[A-Za-z0-9]+/g)?.length ?? 0);
}

// ───────── 确定性随机 ─────────
function rng(seed: string): () => number {
  let h = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1_000_000) / 1_000_000;
  };
}

const SENTENCES = [
  '山风从峡谷深处卷上来，带着潮湿的松脂气味，吹得檐下的铜铃叮当作响。',
  '他把手里的旧信又看了一遍，指尖在那枚模糊的印章上停了很久。',
  '远处的钟声一共敲了七下，像是有人在雾里数着什么。',
  '“你若真想知道答案，就别在这里站着。”她头也不回地说。',
  '灯芯爆了一下，屋里的影子跟着晃动，墙上的地图仿佛活了过来。',
  '他没有立刻回答，只是把茶碗推到桌子另一头，示意对方先坐下。',
  '院子里的老槐树已经落尽了叶子，枝杈在月光下伸得很远。',
  '那一刻他忽然明白，自己一直追的并不是仇人，而是当年那个没能开口的自己。',
  '石阶湿滑，每一步都要踩稳，否则就会连人带剑滚进下面的黑水里。',
  '她把袖口往上挽了挽，露出手腕上一道浅浅的旧疤。',
  '街口卖糖人的老人收了摊，推着车慢慢消失在巷子尽头。',
  '风停了，四下里安静得只剩下彼此的呼吸声。',
  '他记得师父说过，真正的难处从来不在剑上，而在出剑之前的那一息。',
  '雨点落在瓦上，先是稀稀拉拉，后来连成一片，把整座城都罩了进去。',
  '“明日卯时，城东旧渡口。”纸条上只有这一行字，墨迹还未全干。',
  '火盆里的炭渐渐暗下去，屋里慢慢冷了，可谁也没有起身添柴。',
  '他握紧缰绳，回头望了一眼，城墙上那面旗子还在风里翻卷。',
  '少年第一次看见海，竟一时说不出话来，只觉得胸口被什么东西填满了。',
  '她笑了一下，那笑意却没有到眼底，像水面上一闪而过的光。',
  '门外传来三声轻叩，节奏和昨夜一模一样。',
];

const WHEN = ['入夜时分', '天刚蒙蒙亮', '午后不久', '三更刚过', '雨歇之后', '黄昏将尽', '次日清早', '月上中天', '晌午前后', '暮鼓响过', '春寒料峭时', '霜降那天', '灯火初上', '鸡鸣头遍'];
/** 单句 ≤48 字（16 字前缀 + ≤32 字正文），单句永远够不到 repeat 的 50 字窗口 */
const SHORT_SENTENCES = SENTENCES.filter((s) => s.length <= 32);
const WHO = ['少年', '老掌柜', '师姐', '守门人', '游方道士', '药童', '渡船人', '巡夜人', '说书人', '小沙弥', '铁匠', '账房先生'];
const WHERE = ['在青石巷里', '在渡口边上', '于藏书楼下', '在后山竹林', '于演武场旁', '在城隍庙前', '在酒肆二楼', '于断崖之上', '在药圃尽头', '在驿站门外', '于寒潭左近', '在旧宅廊下', '于山门石阶', '在集市东头'];

/** 生成带 beat 标记的中文草稿：总长落在 length 区间（默认取 target） */
export function generateDraft(opts: { beats: string[]; chars: number; seed: string; countMode?: 'han' | 'platform'; title?: string }): string {
  const r = rng(opts.seed);
  const mode = opts.countMode ?? 'han';
  const per = Math.max(20, Math.floor(opts.chars / Math.max(1, opts.beats.length)));
  const parts: string[] = [];
  if (opts.title) parts.push(`# ${opts.title}`, '');
  let total = 0;
  opts.beats.forEach((b, i) => {
    parts.push(`<!-- beat:${b} -->`);
    const goal = i === opts.beats.length - 1 ? opts.chars - total : per;
    let para = '';
    let n = 0;
    let guard = 0;
    while (n < goal && guard++ < 10_000) {
      // 每句带一个组合前缀：逐字重复不会达到 repeat.intra 的 50 字阈值（mock 模式下默认 gate 全开）
      const s = `${WHEN[Math.floor(r() * WHEN.length)]!}${WHERE[Math.floor(r() * WHERE.length)]!}，${WHO[Math.floor(r() * WHO.length)]!}，${SHORT_SENTENCES[Math.floor(r() * SHORT_SENTENCES.length)]!}`;
      const room = goal - n;
      const c = fakeCount(s, mode);
      if (c > room) {
        // 截取汉字补足（以句号收尾，避免触发截断检测），保证不超过目标
        const budget = mode === 'platform' ? room - 1 : room;
        let cut = '';
        for (const ch of s) {
          if (/[，。！？“”、]/.test(ch)) continue;
          if (fakeCount(cut + ch, mode) > budget) break;
          cut += ch;
        }
        if (cut && budget > 0) {
          para = `${para.replace(/\n+$/, '')}${cut}。`;
          n += fakeCount(`${cut}。`, mode);
        }
        break;
      }
      para += s;
      n += c;
      if (r() < 0.25) para += '\n\n';
    }
    total += n;
    parts.push(para.trim(), '');
  });
  return `${parts.join('\n').trim()}\n`;
}

// ───────── 主流程 ─────────
function emit(e: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(e)}\n`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function loginDemo(): Promise<number> {
  const home = process.env.HOME ?? '/tmp';
  process.stdout.write('请在浏览器打开 https://fake.example.invalid/device 并输入验证码 FAKE-1234\n');
  process.stdout.write('然后在此粘贴授权码：');
  const line = await new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d.toString();
      const i = buf.search(/[\r\n]/);
      if (i >= 0) resolve(buf.slice(0, i));
    });
    process.stdin.on('end', () => resolve(buf));
  });
  if (!line.trim() || line.trim() === 'bad') {
    process.stdout.write('\n授权码无效\n');
    return 1;
  }
  fs.mkdirSync(path.join(home, '.fake'), { recursive: true });
  fs.writeFileSync(path.join(home, '.fake', 'auth.json'), JSON.stringify({ token: `fake-${line.trim()}`, ts: new Date().toISOString() }), { mode: 0o600 });
  process.stdout.write('\n登录成功 token=fake-oauth-SECRETVALUE123\n');
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--version')) {
    process.stdout.write('fake-harness 1.0.0\n');
    return 0;
  }
  if (argv.includes('--login')) return loginDemo();
  // 旧的工作单模式已删除：一律按目录模式跑（adapter 总是传 --v3）
  return dirMain(argv);
}

function failWith(fake: FakeScenario, sessionId: string): number {
  const cls = fake.fail ?? 'unknown';
  const message = fake.failMessage ?? `fake 注入失败：${cls}`;
  if (cls === 'rate_limit' || cls === 'quota') {
    emit({ t: 'rate_limit', window: cls === 'quota' ? '5h' : 'minute', status: 'rejected', resetsAt: new Date(Date.now() + 3600_000).toISOString() });
  }
  if (cls !== 'refusal' && cls !== 'max_turns') emit({ t: 'error', cls, message, retryable: ['rate_limit', 'quota', 'overloaded', 'network'].includes(cls) });
  const status = cls === 'refusal' ? 'refusal' : cls === 'max_turns' ? 'max_turns' : 'error';
  emit({ t: 'result', status, sessionId, text: message });
  return fake.exitCode ?? 1;
}

// ───────── v3 目录模式（--v3）：cwd 就是书快照，读 ORDER.md，直接在目录里写书 ─────────

export type FakeOrderMode = 'open-short' | 'open-long' | 'write' | 'finale' | 'retro';
export interface FakeOrder {
  mode: FakeOrderMode;
  from: number;
  count: number;
  /** 计划总章数（写进 outline.md 的“计划：共 N 章”） */
  planned: number;
  minChars: number;
  allowRewrite: number[];
  /** P3：接手任务单（先补笔记再续写） */
  takeover?: boolean;
}

/** 解析 ORDER.md 的固定“任务：”行（模板见 flow/templates/order.*.md）；认不出返回 null */
export function parseOrderText(text: string): FakeOrder | null {
  const minChars = Number(text.match(/每章不少于 (\d+) 字/)?.[1] ?? 3000);
  const rewriteLine = text.match(/^允许改写的旧章：(.*)$/m)?.[1] ?? '';
  const allowRewrite = [...rewriteLine.matchAll(/第 (\d+) 章/g)].map((m) => Number(m[1]));
  const suggested = Number(text.match(/建议 (\d+) 章/)?.[1] ?? 0);
  let m = text.match(/^任务：开书，并写完整本（约 (\d+) 章）/m);
  if (m) {
    const n = Number(m[1]);
    return { mode: 'open-short', from: 1, count: n, planned: suggested || n, minChars, allowRewrite };
  }
  m = text.match(/^任务：开书，并写第 1–(\d+) 章/m);
  if (m) {
    const n = Number(m[1]);
    return { mode: 'open-long', from: 1, count: n, planned: suggested || n, minChars, allowRewrite };
  }
  // 接手的旧书的第一次写作正好是结局批（短篇、剩得不多）：和结局批一样写完全书
  m = text.match(/^任务：接手这本书，然后从第 (\d+) 章写到全书结束（计划还剩约 (\d+) 章/m);
  if (m) {
    const from = Number(m[1]);
    const count = Math.max(1, Number(m[2]));
    const planned = Number(text.match(/计划共 (\d+) 章/)?.[1] ?? from + count - 1);
    return { mode: 'finale', from, count, planned, minChars, allowRewrite, takeover: true };
  }
  // 接手的旧书的第一次写作（P3）：和写作批一样往下写
  m = text.match(/^任务：(?:接手这本书，然后)?新写第 (\d+)–(\d+) 章/m);
  if (m) {
    const from = Number(m[1]);
    const count = Math.max(1, Number(m[2]) - from + 1);
    const planned = Number(text.match(/计划共 (\d+) 章/)?.[1] ?? from + count - 1);
    return { mode: 'write', from, count, planned, minChars, allowRewrite, ...(/^任务：接手这本书/m.test(text) ? { takeover: true } : {}) };
  }
  m = text.match(/^任务：复盘第 (\d+)–(\d+) 章/m);
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    const planned = Number(text.match(/计划共 (\d+) 章/)?.[1] ?? to);
    return { mode: 'retro', from, count: Math.max(1, to - from + 1), planned, minChars, allowRewrite: [] };
  }
  m = text.match(/^任务：结局批，从第 (\d+) 章写到全书结束（计划还剩约 (\d+) 章/m);
  if (m) {
    const from = Number(m[1]);
    const count = Math.max(1, Number(m[2]));
    const planned = Number(text.match(/计划共 (\d+) 章/)?.[1] ?? from + count - 1);
    return { mode: 'finale', from, count, planned, minChars, allowRewrite };
  }
  return null;
}

const FAKE_CHAPTER_TITLES = ['雨夜', '旧信', '渡口', '山门', '归途', '灯火', '长街', '残局', '故人', '霜降', '孤城', '远行', '暗潮', '回声', '晚钟'];
export const FAKE_END_MARKER = '（全书完）';
const pad5 = (n: number) => String(n).padStart(5, '0');

/** 去掉 beat 标记的正文段落（约 chars 个汉字，以句号收尾） */
export function fakeProse(chars: number, seed: string): string {
  return generateDraft({ beats: ['b1', 'b2', 'b3'], chars: Math.max(20, chars), seed })
    .replace(/^<!--\s*beat:b\d+\s*-->\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readJsonScenario(p: string): FakeScenario {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    const one = Array.isArray(v) ? v[0] : v;
    return one && typeof one === 'object' ? (one as FakeScenario) : {};
  } catch {
    return {};
  }
}

/**
 * v3 目录模式：开书写 bible/outline/notes，每章 manuscript/cNNNNN.md（“# 第k章 标题” + 正文，长度 max(min+200, 1.2·min)），
 * notes/chapters.md 每章一行；结局批 / 短篇开书在最后一章末尾单独一行写“（全书完）”；允许改写的旧章补到下限以上。
 * fake.v3 的混沌开关见 FakeV3Chaos；fail / failAfterWrite / sleepMs 照旧（sleepMs 在正文写完、笔记写之前）。
 */
export async function dirMain(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const model = argOf(argv, '--model') ?? 'fake-model';
  const sessionId = argOf(argv, '--session') ?? `fake-${Date.now()}`;
  const launch = argOf(argv, '--launch');
  const scenarioPath = argOf(argv, '--scenario') ?? (launch ? path.join(path.dirname(launch), 'fake.json') : '');
  const fake: FakeScenario = scenarioPath ? readJsonScenario(scenarioPath) : {};
  const chaos: FakeV3Chaos = fake.v3 ?? {};
  let cancelled = false;
  if (fake.ignoreSigterm) {
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
  } else {
    const onSig = (sig: string) => {
      if (cancelled) return;
      cancelled = true;
      emit({ t: 'result', status: 'cancelled', stopReason: sig, sessionId });
      process.exit(sig === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGTERM', () => onSig('SIGTERM'));
    process.on('SIGINT', () => onSig('SIGINT'));
  }

  if (fake.malformedJson) process.stdout.write('this is {not json\n');
  emit({ t: 'init', sessionId, model, version: 'fake-1.0.0', tools: ['read', 'write', 'edit'] });
  if (fake.rateLimit) {
    emit({
      t: 'rate_limit',
      window: fake.rateLimit.window ?? '5h',
      ...(fake.rateLimit.utilization !== undefined ? { utilization: fake.rateLimit.utilization } : {}),
      ...(fake.rateLimit.resetsAt ? { resetsAt: fake.rateLimit.resetsAt } : {}),
      status: fake.rateLimit.status ?? 'warning',
    });
  }
  let tid = 0;
  const readEv = (rel: string) => {
    const id = `r${++tid}`;
    emit({ t: 'tool_call', id, name: 'read', kind: 'read', paths: [path.join(cwd, rel)] });
    emit({ t: 'tool_result', id, ok: true });
  };
  readEv('AGENTS.md');
  readEv('ORDER.md');
  let orderText = '';
  try {
    orderText = fs.readFileSync(path.join(cwd, 'ORDER.md'), 'utf8');
  } catch {
    /* 没有 ORDER.md */
  }
  // 目录探测（harness/probe.ts#runDirectoryCanary）：只写 canary.txt（第一行标记，第二行 AGENTS.md 里的暗号）
  const canaryLine = orderText.split('\n').find((l) => /^在当前目录写一个文件 canary\.txt/.test(l));
  if (canaryLine) {
    const marker = canaryLine.match(/NOVELIST-CANARY-[A-Z0-9]+/)?.[0] ?? 'NOVELIST-CANARY';
    let agents = '';
    try {
      agents = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
    } catch {
      /* 没有 AGENTS.md */
    }
    const code = fake.canary === 'skipAgents' ? '' : (agents.match(/NV-CANARY-[0-9a-f]+/)?.[0] ?? '');
    const abs = path.join(cwd, 'canary.txt');
    emit({ t: 'tool_call', id: 'w1', name: 'write', kind: 'write', paths: [abs] });
    fs.writeFileSync(abs, `${marker}\n${code}\n`);
    emit({ t: 'tool_result', id: 'w1', ok: true });
    emit({ t: 'file_change', path: abs, op: 'add', ok: true });
    if (fake.fail) return failWith(fake, sessionId);
    emit({ t: 'usage', input: 500, cachedInput: 0, output: 20, reasoning: 0, costUsd: 0, costSource: 'harness', scope: 'total' });
    emit({ t: 'result', status: 'success', stopReason: 'end_turn', sessionId, turns: 1 });
    return fake.exitCode ?? 0;
  }
  const order = parseOrderText(orderText);
  if (!order) {
    emit({ t: 'error', cls: 'config', message: 'ORDER.md 缺失或认不出任务行', retryable: false });
    emit({ t: 'result', status: 'error', sessionId });
    return 2;
  }
  if (fake.fail && !fake.failAfterWrite) return failWith(fake, sessionId);
  if (fake.noResult && !fake.failAfterWrite) {
    emit({ t: 'text', channel: 'assistant', delta: '（没有终止事件就退出）' });
    return fake.exitCode ?? 0;
  }

  for (let i = 0; i < (chaos.extraSteps ?? 0); i++) readEv(`notes/progress.md`);

  let written = 0;
  const write = (rel: string, content: string) => {
    const abs = path.join(cwd, rel);
    const id = `w${++tid}`;
    emit({ t: 'tool_call', id, name: 'write', kind: 'write', paths: [abs] });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, content);
    emit({ t: 'tool_result', id, ok: true });
    emit({ t: 'file_change', path: abs, op: existed ? 'update' : 'add', ok: true });
    written++;
  };
  const readRel = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const seed = createHash('sha256').update(`${sessionId}:${cwd}`).digest('hex');
  if (order.mode === 'retro') {
    // 复盘：读笔记和这几章，重写 notes/retro.md，大纲记一笔，线索标上去处；不写正文
    const to = order.from + order.count - 1;
    for (const rel of ['notes/progress.md', 'outline.md', 'bible.md', 'notes/cast.md', 'notes/threads.md', 'notes/retro.md', 'notes/chapters.md']) if (readRel(rel) !== null) readEv(rel);
    for (let k = order.from; k <= to; k++) if (readRel(`manuscript/c${pad5(k)}.md`) !== null) readEv(`manuscript/c${pad5(k)}.md`);
    if (!chaos.retroZero && !chaos.zeroOutput) {
      write('notes/retro.md', `# 复盘意见（第 ${order.from}–${to} 章）\n\n1. 师姐的戏份偏少，接下来几章让她多出场。\n2. 渡口的描写重复了几次，换个角度写。\n3. 旧信的线索快被忘了，近期要推进一次。\n`);
      const outline = readRel('outline.md');
      if (outline !== null) write('outline.md', `${outline.replace(/\n*$/, '\n')}\n（复盘：第 ${order.from}–${to} 章已对照）\n`);
      const threads = readRel('notes/threads.md');
      if (threads !== null) {
        write(
          'notes/threads.md',
          threads
            .split('\n')
            .map((l) => (/^\s*[-*]\s/.test(l) && !l.includes('计划第') ? `${l} → 计划第 ${to + 3} 章前后收` : l))
            .join('\n'),
        );
      }
      if (chaos.retroEditChapter !== undefined) {
        const rel = `manuscript/c${pad5(chaos.retroEditChapter)}.md`;
        const old = readRel(rel);
        if (old !== null) write(rel, `${old.trimEnd()}\n\n${fakeProse(300, `${seed}:retro${chaos.retroEditChapter}`)}\n`);
      }
    }
    emit({ t: 'text', channel: 'assistant', delta: `复盘完成，改了 ${written} 个文件。` });
    if (fake.fail) return failWith(fake, sessionId);
    emit({ t: 'usage', input: Math.ceil(orderText.length / 2) + 2000, cachedInput: 0, output: written * 400 + 50, reasoning: 0, costUsd: 0, costSource: 'harness', scope: 'total' });
    emit({ t: 'result', status: 'success', stopReason: 'end_turn', sessionId, turns: 1 });
    return fake.exitCode ?? 0;
  }
  const isOpen = order.mode === 'open-short' || order.mode === 'open-long';
  const isFinale = order.mode === 'finale' || order.mode === 'open-short';
  const count = chaos.chapters ?? order.count;
  const last = order.from + count - 1;
  const noteLines: string[] = [];

  if (!chaos.zeroOutput) {
    // 1. 开书：设定、大纲、笔记骨架
    if (isOpen) {
      if (readRel('bible.md') === null) {
        write(
          'bible.md',
          [`# 《假书名·${seed.slice(0, 6)}》`, '一句话：一个少年在雨夜的渡口收到一封旧信，从此卷进一桩旧案。', '标签：悬疑、成长、江湖', '', '与《X》《Y》的区别：没有系统，没有重生。', '', '## 人物', '', '少年、师姐、渡船人。', '', '## 结局', '', '旧案真相大白，少年留在渡口。', ''].join('\n'),
        );
      }
      if (readRel('outline.md') === null) {
        const lines = ['# 大纲', '', '骨架：起于雨夜旧信，终于渡口重逢。', `计划：共 ${order.planned} 章`, ''];
        for (let k = 1; k <= Math.min(order.planned, order.mode === 'open-short' ? order.planned : order.count); k++) lines.push(`- 第${k}章 ${FAKE_CHAPTER_TITLES[(k - 1) % FAKE_CHAPTER_TITLES.length]}：推进主线。`);
        write('outline.md', `${lines.join('\n')}\n`);
      }
      if (!chaos.noNotes && !chaos.wrongDir && order.mode === 'open-long') {
        write('notes/cast.md', '# 人物\n\n- 少年：在场。\n- 师姐：在场。\n');
        write('notes/threads.md', '# 线索\n\n- 旧信的来历：第1章埋，计划第10章前后收。\n');
      }
    }

    // 1a. 接手的旧书（P3）：先建自己的笔记（设定、大纲、人物、线索）
    if (order.takeover && !chaos.noNotes) {
      if (readRel('bible.md') === null) write('bible.md', ['# 《接手的书》', '一句话：旧书接着往下写。', '标签：接手、续写', '', '## 人物', '', '林枫（沿用旧设定）。', ''].join('\n'));
      if (readRel('outline.md') === null) write('outline.md', ['# 大纲', '', '骨架：沿用旧资料。', `计划：共 ${order.planned} 章`, ''].join('\n'));
      write('notes/cast.md', '# 人物\n\n- 林枫：在场。\n');
      write('notes/threads.md', '# 线索\n\n- 山门的旧事：旧章埋，计划后面收。\n');
    }

    // 1b. 收尾阶段的写作批：任务单要求先写结局章节清单
    if (!isOpen && orderText.includes('加一节"## 结局章节清单"')) {
      const outline = readRel('outline.md') ?? '# 大纲\n';
      if (!/^#{1,6}\s*结局(?:章节)?清单/m.test(outline)) {
        const items = Array.from({ length: Math.max(1, order.planned - order.from + 1) }, (_, i) => `- 第${order.from + i}章：……`).join('\n');
        write('outline.md', `${outline.replace(/\n*$/, '\n')}\n## 结局章节清单\n${items}\n`);
      }
    }

    // 2. 正文
    const batchParts: string[] = [];
    if (chaos.killAfter === 0) process.kill(process.pid, 'SIGKILL');
    for (let i = 0; i < count; i++) {
      const k = order.from + i;
      const title = FAKE_CHAPTER_TITLES[(k - 1) % FAKE_CHAPTER_TITLES.length]!;
      let chars = Math.ceil(Math.max(order.minChars + 200, 1.2 * order.minChars));
      if (chaos.shortChapter === i + 1) chars = Math.max(Math.min(150, order.minChars - 1), Math.floor(order.minChars / 2));
      let body = fakeProse(chars, `${seed}:c${k}`);
      if (chaos.repeatPhrase) body = body.split('\n').map((l) => (l.trim() ? `${chaos.repeatPhrase}，${l}` : l)).join('\n');
      const isLast = k === last;
      if (isLast && chaos.truncateLast) body = `${body.replace(/[。！？”]+$/u, '')}，他刚要开口，门外却`;
      const marker = isLast && !chaos.truncateLast && ((isFinale && !chaos.noMarker) || (!isFinale && (chaos.endMarkerEarly || chaos.markerAlways)));
      const text = `# 第${k}章 ${title}\n\n${body}\n${marker ? `\n${FAKE_END_MARKER}\n` : ''}`;
      if (chaos.oneFile) {
        batchParts.push(text);
        write('manuscript/batch.md', batchParts.join('\n'));
      } else if (chaos.wrongDir) write(`chapters/${String(k).padStart(3, '0')}.md`, text);
      else write(`manuscript/c${pad5(k)}.md`, text);
      noteLines.push(`第${k}章 ${title}：少年追查旧信，${i % 2 ? '师姐登场' : '埋下新线索'}。`);
      if (chaos.killAfter !== undefined && i + 1 === chaos.killAfter) process.kill(process.pid, 'SIGKILL');
    }

    // 3. 允许改写的旧章：补到下限以上
    for (const k of order.allowRewrite) {
      const rel = `manuscript/c${pad5(k)}.md`;
      const old = readRel(rel);
      if (old === null) continue;
      if (chaos.rewriteAllowed === 'append') {
        write(rel, `${old.trimEnd()}\n\n${fakeProse(400, `${seed}:rwa${k}`)}\n`);
        continue;
      }
      if (chaos.rewriteAllowed === 'shorten' || chaos.rewriteAllowed === 'shorten-hard') {
        const nl = old.indexOf('\n');
        const head = nl >= 0 ? old.slice(0, nl) : '';
        const body = (nl >= 0 ? old.slice(nl + 1) : old).trim();
        const cut = body.slice(0, Math.floor(body.length * (chaos.rewriteAllowed === 'shorten' ? 0.6 : 0.2)));
        const end = cut.lastIndexOf('。');
        write(rel, `${head}\n\n${end >= 0 ? cut.slice(0, end + 1) : cut}\n`);
        continue;
      }
      const have = fakeCount(old);
      if (have >= order.minChars) continue;
      write(rel, `${old.trimEnd()}\n\n${fakeProse(order.minChars - have + 200, `${seed}:rw${k}`)}\n`);
    }

    // 4. 混沌：越权改写、旧章号另存、不入库目录
    if (chaos.rewriteAccepted !== undefined) {
      const rel = `manuscript/c${pad5(chaos.rewriteAccepted)}.md`;
      const old = readRel(rel);
      if (old !== null) write(rel, `${old.trimEnd()}\n\n${fakeProse(300, `${seed}:bad${chaos.rewriteAccepted}`)}\n`);
    }
    if (chaos.oldNumberElsewhere !== undefined) {
      const k = chaos.oldNumberElsewhere;
      write(`chapters/${String(k).padStart(3, '0')}.md`, `# 第${k}章 重写\n\n${fakeProse(Math.ceil(order.minChars * 1.2), `${seed}:old${k}`)}\n`);
    }
    if (chaos.ignoredDir) write('views/scratch.md', '草稿笔记：下一章让师姐先出场。\n');

    if (fake.sleepMs) {
      const until = Date.now() + fake.sleepMs;
      while (Date.now() < until) {
        const step = fake.dripMs ? Math.min(fake.dripMs, until - Date.now()) : until - Date.now();
        await sleep(Math.max(1, step));
        if (fake.dripMs) emit({ t: 'heartbeat', source: 'stdout' });
      }
    }

    // 5. 笔记：一批写完后一次性更新
    if (!chaos.noNotes) {
      const progress = `# 进度\n\n写到第 ${last} 章。\n\n前情提要：少年收到旧信，一路追查到渡口。\n\n下一步打算：接着 outline.md 往下写。\n`;
      if (chaos.wrongDir) write('notes.md', `${progress}\n${noteLines.join('\n')}\n`);
      else {
        if (order.mode !== 'open-short') {
          const prev = readRel('notes/chapters.md');
          write('notes/chapters.md', `${prev ? prev.replace(/\n*$/, '\n') : '# 每章一行\n\n'}${noteLines.join('\n')}\n`);
        }
        write('notes/progress.md', progress);
      }
    }
  } else if (fake.sleepMs) await sleep(fake.sleepMs);

  emit({ t: 'text', channel: 'assistant', delta: `已写出 ${written} 个文件。` });
  if (fake.fail) return failWith(fake, sessionId);
  if (fake.noResult) return fake.exitCode ?? 0;
  emit({ t: 'usage', input: Math.ceil(orderText.length / 2) + 2000, cachedInput: 0, output: written * 800 + 50, reasoning: 0, costUsd: 0, costSource: 'harness', scope: 'total' });
  emit({ t: 'result', status: 'success', stopReason: 'end_turn', sessionId, turns: 1 });
  return fake.exitCode ?? 0;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.stdout.write('', () => process.exit(code));
    },
    (err) => {
      console.error(err);
      process.exit(70);
    },
  );
}
