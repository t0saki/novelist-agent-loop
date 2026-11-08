/** tmp id 解析的上下文（committer 与 chapter.accept 共用同一口径，避免 F 号串号）。Owner: lane B。 */
import type { BookRepo } from '../book/repo.js';
import { P } from '../book/layout.js';
import type { IdContext } from './ids.js';
import { aliasEntities, loadBookState } from './load.js';

export async function buildTmpIdContext(repo: BookRepo): Promise<IdContext> {
  const state = await loadBookState(repo.dir);
  const existing = new Set<string>(state.entities.map((e) => e.entity.id));
  const names = new Map<string, string>();
  for (const e of aliasEntities(state)) {
    names.set(e.name, e.id);
    for (const alias of e.aliases ?? []) names.set(typeof alias === 'string' ? alias : alias.text, e.id);
  }
  const blob = JSON.stringify(state.snapshot) + ((await repo.readFile(P.obligations)) ?? '');
  let maxObligation = 0;
  for (const m of blob.matchAll(/\b(F\d{4,})\b/g)) {
    existing.add(m[1] as string);
    maxObligation = Math.max(maxObligation, Number((m[1] as string).slice(1)));
  }
  for (const m of blob.matchAll(/\b((?:fact|world)\.[A-Za-z0-9_.:-]+)/g)) existing.add(m[1] as string);
  return { existing, names, nextObligationNo: maxObligation + 1 };
}
