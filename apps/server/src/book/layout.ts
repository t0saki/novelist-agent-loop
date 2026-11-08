/**
 * 书库布局（DESIGN §4.1）。Owner: lane B。纯函数与常量。
 * 所有路径均为“相对书根”的 POSIX 路径；需要绝对路径时 path.join(bookDir, rel)。
 */
import { chapterId } from '@novelist/shared';

export const BOOK_GITIGNORE = ['work/', '.index/', '.cache/', 'views/', 'state/snapshot.json'] as const;

export const P = {
  bookYaml: 'book.yaml',
  agentsMd: 'AGENTS.md',
  skillsDir: '.agents/skills',
  claudeSkillsLink: '.claude/skills',
  gitignore: '.gitignore',
  instructionsDir: 'instructions',
  instructionsAgents: 'instructions/AGENTS.md',
  instructionsRole: (role: string) => `instructions/roles/${role}.md`,
  instructionsTask: (kind: string) => `instructions/tasks/${kind}.md`,
  styleVoice: 'style/voice.md',
  styleSamplesDir: 'style/samples',
  styleLexicon: 'style/lexicon.yaml',
  bookGates: 'gates.yaml',
  premise: 'bible/premise.md',
  glossary: 'bible/glossary.yaml',
  worldRules: 'bible/world/rules.yaml',
  worldDir: 'bible/world',
  entitiesDir: 'bible/entities',
  entity: (kindDir: string, slug: string) => `bible/entities/${kindDir}/${slug}.md`,
  secretsDir: 'bible/secrets',
  compass: 'plan/compass.yaml',
  volume: (id: string) => `plan/volumes/${id}.yaml`,
  arc: (id: string) => `plan/arcs/${id}.yaml`,
  card: (no: number) => `plan/cards/${chapterId(no)}.yaml`,
  characterArc: (slug: string) => `plan/character-arcs/${slug}.yaml`,
  strands: 'plan/strands.yaml',
  obligations: 'plan/obligations.yaml',
  changes: 'plan/changes.jsonl',
  ledger: (no: number) => `state/ledger/${chapterId(no)}.json`,
  ledgerDir: 'state/ledger',
  overrides: 'state/overrides.jsonl',
  arcFingerprints: 'state/arc-fingerprints.jsonl',
  manuscript: (no: number) => `manuscript/${chapterId(no)}.md`,
  manuscriptDir: 'manuscript',
  summaryArc: (id: string) => `summaries/arcs/${id}.md`,
  summaryVolume: (id: string) => `summaries/volumes/${id}.md`,
  summaryBook: 'summaries/book.md',
  review: (no: number) => `reviews/${chapterId(no)}.json`,
  audit: (name: string) => `audits/${name}.json`,
  debt: 'debt.jsonl',
  notesInbox: 'notes/inbox.md',
  /** 工作区（gitignored）：live 树中保存收割后的 attempt 产物 */
  work: (taskId: string, attempt: number) => `work/${taskId}/attempt-${attempt}`,
  workOut: (taskId: string, attempt: number) => `work/${taskId}/attempt-${attempt}/out`,
  workOrder: (taskId: string) => `work/${taskId}/workorder.md`,
  validated: (taskId: string, attempt: number) => `work/${taskId}/attempt-${attempt}/VALIDATED.json`,
  viewsDir: 'views',
  view: (name: string) => `views/${name}`,
  viewsInstructions: (role: string) => `views/instructions/${role}.md`,
  indexDir: '.index',
  cacheDir: '.cache',
} as const;

/** 实体 kind → 目录名 */
export const ENTITY_DIRS = { character: 'characters', location: 'locations', faction: 'factions', item: 'items', concept: 'concepts' } as const;

/** 路径归属（UI 着色、committer 拒收规则）：canonical / user / generated / derived */
export function pathOwner(rel: string): 'canonical' | 'user' | 'generated' | 'derived' {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  // 派生（gitignored、可重建）
  if (/^(views|\.index|\.cache|work)(\/|$)/.test(p) || p === 'state/snapshot.json') return 'derived';
  // Novelist 生成并入库（手改会被 committer 拒收或提示迁移）
  if (p === P.agentsMd || p === P.gitignore || /^\.agents\/skills(\/|$)/.test(p) || /^\.claude(\/|$)/.test(p)) return 'generated';
  // 用户所有、不透明
  if (p === P.bookYaml || p === P.bookGates || p === P.premise || /^instructions(\/|$)/.test(p) || /^style(\/|$)/.test(p) || /^notes(\/|$)/.test(p))
    return 'user';
  return 'canonical';
}

/** 实体目录名 → kind */
export const ENTITY_KIND_BY_DIR: Record<string, keyof typeof ENTITY_DIRS> = {
  characters: 'character',
  locations: 'location',
  factions: 'faction',
  items: 'item',
  concepts: 'concept',
};

/** 书根初始目录（git 不跟踪空目录；initBookRepo 在磁盘上建好，快照内由使用方 mkdir -p） */
export const BOOK_DIRS = [
  'instructions/roles',
  'instructions/tasks',
  'instructions/skills',
  '.agents/skills',
  'style/samples',
  'bible/world',
  ...Object.values(ENTITY_DIRS).map((d) => `bible/entities/${d}`),
  'bible/secrets',
  'plan/volumes',
  'plan/arcs',
  'plan/cards',
  'plan/character-arcs',
  'state/ledger',
  'manuscript',
  'summaries/arcs',
  'summaries/volumes',
  'reviews',
  'audits',
  'notes',
] as const;
