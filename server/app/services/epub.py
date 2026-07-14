"""最小 EPUB3 生成（stdlib zipfile，无第三方依赖）。"""
from __future__ import annotations

import html
import io
import zipfile
from pathlib import Path

from app.db.models import Chapter, Novel

_CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def _chapter_xhtml(title: str, content: str) -> str:
    paras = "".join(
        f"<p>{html.escape(p.strip())}</p>" for p in content.split("\n") if p.strip()
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" lang="zh"><head>'
        f"<title>{html.escape(title)}</title>"
        '<meta charset="utf-8"/></head><body>'
        f"<h2>{html.escape(title)}</h2>{paras}</body></html>"
    )


def build_epub(novel: Novel, chapters: list[Chapter], cover_bytes: bytes | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        # mimetype 必须第一个且不压缩
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", _CONTAINER)

        manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
        spine = []
        cover_meta = ""
        if cover_bytes:
            z.writestr("OEBPS/cover.png", cover_bytes)
            manifest.append('<item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>')
            cover_meta = '<meta name="cover" content="cover-img"/>'

        nav_items = []
        for c in chapters:
            fname = f"chap{c.index}.xhtml"
            title = c.title or f"第{c.index}章"
            z.writestr(f"OEBPS/{fname}", _chapter_xhtml(title, c.content))
            manifest.append(f'<item id="chap{c.index}" href="{fname}" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="chap{c.index}"/>')
            nav_items.append(f'<li><a href="{fname}">{html.escape(title)}</a></li>')

        nav = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh">'
            "<head><title>目录</title></head><body>"
            '<nav epub:type="toc" id="toc"><h1>目录</h1><ol>'
            + "".join(nav_items)
            + "</ol></nav></body></html>"
        )
        z.writestr("OEBPS/nav.xhtml", nav)

        opf = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            f"<dc:identifier id=\"bookid\">novel-{novel.slug}</dc:identifier>"
            f"<dc:title>{html.escape(novel.title)}</dc:title>"
            f"<dc:language>{novel.language}</dc:language>"
            f"<dc:description>{html.escape(novel.synopsis or '')}</dc:description>"
            f"{cover_meta}"
            "</metadata>"
            f"<manifest>{''.join(manifest)}</manifest>"
            f"<spine>{''.join(spine)}</spine>"
            "</package>"
        )
        z.writestr("OEBPS/content.opf", opf)
    return buf.getvalue()


def cover_path_bytes(path: str | None) -> bytes | None:
    if not path:
        return None
    p = Path(path)
    return p.read_bytes() if p.exists() else None
