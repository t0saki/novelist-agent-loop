/**
 * 书库布局（DESIGN §4.1；v3 见 docs/v3/DESIGN.md §4）。纯函数与常量。
 * 所有路径均为“相对书根”的 POSIX 路径；需要绝对路径时 path.join(bookDir, rel)。
 * 旧流程的规划 / 正典 / 账本路径已删除；旧书磁盘上的这些文件原样留着。
 */
import { chapterId } from '@novelist/shared';

/** 已有书里的 views/、state/snapshot.json 两行是旧流程留下的忽略规则：无害，照写（旧布局的 .gitignore 不变） */
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
  /** 旧书的种子（v3 书是 seed.md） */
  premise: 'bible/premise.md',
  /** 旧书的卷文件（v1 导入写的骨架；卷标题回填到 chapters.volume_title） */
  volume: (id: string) => `plan/volumes/${id}.yaml`,
  overrides: 'state/overrides.jsonl',
  manuscript: (no: number) => `manuscript/${chapterId(no)}.md`,
  manuscriptDir: 'manuscript',
  notesInbox: 'notes/inbox.md',
  /** 工作区（gitignored）：live 树中保存收割后的 attempt 产物 */
  work: (taskId: string, attempt: number) => `work/${taskId}/attempt-${attempt}`,
  workOut: (taskId: string, attempt: number) => `work/${taskId}/attempt-${attempt}/out`,
  /** 运行快照照旧复制它（v3 运行的快照与之前逐字节相同） */
  indexDir: '.index',
} as const;

/** 路径归属（UI 着色）：canonical / user / generated / derived */
export function pathOwner(rel: string): 'canonical' | 'user' | 'generated' | 'derived' {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  // 派生（gitignored、可重建）
  if (/^(views|\.index|\.cache|work)(\/|$)/.test(p) || p === 'state/snapshot.json') return 'derived';
  // Novelist 生成并入库
  if (p === P.agentsMd || p === P.gitignore || /^\.agents\/skills(\/|$)/.test(p) || /^\.claude(\/|$)/.test(p)) return 'generated';
  // 用户所有、不透明
  if (p === P.bookYaml || p === 'gates.yaml' || p === P.premise || /^instructions(\/|$)/.test(p) || /^style(\/|$)/.test(p) || /^notes(\/|$)/.test(p))
    return 'user';
  return 'canonical';
}

/** 旧布局（initBookRepo layout 'legacy'）在磁盘上建的目录（git 不跟踪空目录） */
export const BOOK_DIRS = [
  'instructions/roles',
  'instructions/tasks',
  'instructions/skills',
  '.agents/skills',
  'style/samples',
  'bible/world',
  'bible/entities/characters',
  'bible/entities/locations',
  'bible/entities/factions',
  'bible/entities/items',
  'bible/entities/concepts',
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
