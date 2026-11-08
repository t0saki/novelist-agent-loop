/** 阅读器的纯函数：分段、滚动比例、偏好夹取。 */
export function splitParagraphs(text: string, title?: string): string[] {
  const lines = text
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 正文首行可能重复章节标题（markdown 标题），已在页头显示
  if (lines[0]?.startsWith('#')) {
    const h = lines[0].replace(/^#+\s*/, '');
    if (!title || title.includes(h) || h.includes(title)) lines.shift();
    else lines[0] = h;
  }
  return lines.map((l) => l.replace(/^#+\s*/, ''));
}

export function scrollRatio(scrollY: number, scrollHeight: number, viewport: number): number {
  const max = scrollHeight - viewport;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, scrollY / max));
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type ReaderTheme = 'paper' | 'sepia' | 'green' | 'dark' | 'black';
export type ReaderFamily = 'serif' | 'sans' | 'kai';
export interface ReaderPrefs {
  font: number;
  lineHeight: number;
  theme: ReaderTheme;
  family: ReaderFamily;
  width: number;
}
export const READER_THEMES: { id: ReaderTheme; label: string; swatch: string }[] = [
  { id: 'paper', label: '素白', swatch: '#fbfaf6' },
  { id: 'sepia', label: '羊皮', swatch: '#f3e7cd' },
  { id: 'green', label: '护眼', swatch: '#d9e8d5' },
  { id: 'dark', label: '夜间', swatch: '#1a1916' },
  { id: 'black', label: '纯黑', swatch: '#000000' },
];
export const READER_FAMILIES: Record<ReaderFamily, { label: string; css: string }> = {
  serif: { label: '宋体', css: 'var(--font-serif)' },
  sans: { label: '黑体', css: 'var(--font-sans)' },
  kai: { label: '楷体', css: '"Kaiti SC", "STKaiti", "AR PL UKai CN", KaiTi, serif' },
};
export const stepPrefs = {
  font: (v: number, d: number) => clamp(v + d, 14, 32),
  lineHeight: (v: number, d: number) => +clamp(v + d, 1.4, 2.6).toFixed(1),
  width: (v: number, d: number) => clamp(v + d, 28, 60),
};

export function coverGradient(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return `linear-gradient(160deg, hsl(${h} 38% 34%), hsl(${(h + 40) % 360} 42% 18%))`;
}
