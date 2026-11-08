/** c00421 → 421；不匹配返回 null */
export function parseChapterNo(id: string): number | null {
  const m = /^c(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}
