/** 导出（§9.5）：EPUB（jszip，按卷可选）与 TXT。只导出已发布章节（读者端）或全部已验收章节（管理端）。Owner: lane G。 */
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import JSZip from 'jszip';
import type { AppDeps } from '../app.js';
import { bookFiles, openRepo, type BookRepo } from '../book/index.js';
import { chapters } from '../db/schema.js';
import type { BookRow } from '../api/helpers.js';
import { bookDir } from '../api/helpers.js';
import { collectManuscripts } from './books.js';

export interface ExportChapter {
  no: number;
  title: string;
  volumeTitle: string;
  text: string;
}

export interface ExportBook {
  slug: string;
  title: string;
  author: string;
  blurb: string;
  cover?: Buffer;
  chapters: ExportChapter[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 正文（markdown 段落）→ 段落数组：去掉标题行与空行 */
function paragraphs(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function chapterXhtml(ch: ExportChapter): string {
  const body = paragraphs(ch.text)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>${esc(ch.title)}</title></head><body><h2>${esc(ch.title)}</h2>
${body}
</body></html>`;
}

export async function buildEpub(book: ExportBook): Promise<Buffer> {
  const zip = new JSZip();
  // EPUB 规范：mimetype 必须是第一个条目且不压缩
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);

  const name = (no: number) => `c${String(no).padStart(5, '0')}.xhtml`;
  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
  ];
  const spine: string[] = [];
  if (book.cover) {
    zip.file('OEBPS/cover.jpg', book.cover);
    manifest.push(`<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`);
  }
  for (const ch of book.chapters) {
    zip.file(`OEBPS/${name(ch.no)}`, chapterXhtml(ch));
    manifest.push(`<item id="c${ch.no}" href="${name(ch.no)}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${ch.no}"/>`);
  }

  const groups: { title: string; chapters: ExportChapter[] }[] = [];
  for (const ch of book.chapters) {
    const last = groups[groups.length - 1];
    if (last?.title === ch.volumeTitle) last.chapters.push(ch);
    else groups.push({ title: ch.volumeTitle, chapters: [ch] });
  }
  const navItems = groups
    .map((g) => {
      const inner = g.chapters.map((c) => `<li><a href="${name(c.no)}">${esc(c.title)}</a></li>`).join('');
      return g.title ? `<li><span>${esc(g.title)}</span><ol>${inner}</ol></li>` : inner;
    })
    .join('');
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${navItems}</ol></nav></body></html>`);

  const points = book.chapters.map((c, i) => `<navPoint id="p${c.no}" playOrder="${i + 1}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="${name(c.no)}"/></navPoint>`).join('');
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${esc(book.slug)}"/></head><docTitle><text>${esc(book.title)}</text></docTitle><navMap>${points}</navMap></ncx>`);

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:novelist:${esc(book.slug)}</dc:identifier><dc:title>${esc(book.title)}</dc:title><dc:creator>${esc(book.author)}</dc:creator><dc:language>zh-CN</dc:language><dc:description>${esc(book.blurb)}</dc:description><meta property="dcterms:modified">${modified}</meta></metadata><manifest>${manifest.join('')}</manifest><spine toc="ncx">${spine.join('')}</spine></package>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/epub+zip' });
}

export function buildTxt(book: ExportBook): string {
  const lines = [book.title, `作者：${book.author}`];
  if (book.blurb) lines.push('', book.blurb);
  let volume = '';
  for (const ch of book.chapters) {
    if (ch.volumeTitle && ch.volumeTitle !== volume) {
      volume = ch.volumeTitle;
      lines.push('', '', `【${volume}】`);
    }
    lines.push('', '', ch.title, '', paragraphs(ch.text).map((p) => `　　${p}`).join('\n'));
  }
  return `${lines.join('\n')}\n`;
}

/** 读者端：published=true 只含已发布；管理端 ?scope=accepted 含全部已验收。vol 限定单卷。 */
export async function collectExport(deps: AppDeps, book: BookRow, opts: { published: boolean; volume?: string | undefined; author: string; blurb: string; cover?: Buffer | undefined }): Promise<ExportBook> {
  const repo: BookRepo = openRepo(bookDir(deps, book.slug));
  const where = opts.published ? and(eq(chapters.bookId, book.id), isNotNull(chapters.publishedAt)) : and(eq(chapters.bookId, book.id), eq(chapters.state, 'accepted'));
  const rows = await deps.db.select({ no: chapters.no, title: chapters.title, volume: chapters.volume }).from(chapters).where(where).orderBy(asc(chapters.no));
  const selected = opts.volume ? rows.filter((r) => r.volume === opts.volume) : rows;
  const volumes = await bookFiles(repo).volumes().catch(() => []);
  const titles = new Map(volumes.map((v) => [v.id, v.title]));
  const texts = await collectManuscripts(repo, selected.map((r) => r.no));
  const chaptersOut: ExportChapter[] = [];
  for (const r of selected) {
    const text = texts.get(r.no);
    if (text === undefined) continue;
    chaptersOut.push({ no: r.no, title: r.title || `第${r.no}章`, volumeTitle: titles.get(r.volume) ?? r.volume, text });
  }
  return { slug: book.slug, title: opts.volume ? `${book.title} ${titles.get(opts.volume) ?? opts.volume}` : book.title, author: opts.author, blurb: opts.blurb, chapters: chaptersOut, ...(opts.cover ? { cover: opts.cover } : {}) };
}
