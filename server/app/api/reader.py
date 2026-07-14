"""阅读端 API：书库、目录、章节、阅读进度、EPUB、封面。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import _token_from_header, db_session, require_reader
from app.core.security import verify_token
from app.db.models import Chapter, ChapterStatus, Novel, NovelStatus, ReadingProgress
from app.services.epub import build_epub, cover_path_bytes

router = APIRouter(prefix="/api/reader", tags=["reader"])

# 阅读端可见的状态：连载中 + 已完结（不含 planning/failed/archived）
_VISIBLE = [NovelStatus.writing.value, NovelStatus.completed.value]


def _book_card(n: Novel, chapter_count: int) -> dict:
    return {
        "slug": n.slug,
        "title": n.title,
        "synopsis": n.synopsis,
        "status": n.status,
        "nsfw": n.nsfw,
        "theme": n.theme_name,
        "tone": n.tone,
        "word_count": n.word_count,
        "planned_chapters": n.planned_chapters,
        "chapter_count": chapter_count,
        "has_cover": bool(n.cover_path),
        "completed_at": n.completed_at.isoformat() if n.completed_at else None,
        "updated_at": n.updated_at.isoformat() if n.updated_at else None,
    }


@router.get("/books")
def list_books(
    session: Session = Depends(db_session),
    _: dict = Depends(require_reader),
    status: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=60, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict:
    stmt = select(Novel).where(Novel.status.in_(_VISIBLE))
    if status in _VISIBLE:
        stmt = select(Novel).where(Novel.status == status)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(Novel.title.like(like) | Novel.synopsis.like(like))
    stmt = stmt.order_by(Novel.updated_at.desc()).limit(limit).offset(offset)
    novels = session.execute(stmt).scalars().all()
    out = []
    for n in novels:
        cnt = session.execute(
            select(Chapter.id).where(
                Chapter.novel_id == n.id, Chapter.status == ChapterStatus.done.value
            )
        ).scalars().all()
        out.append(_book_card(n, len(cnt)))
    return {"books": out}


def _get_visible_novel(session: Session, slug: str) -> Novel:
    n = session.execute(select(Novel).where(Novel.slug == slug)).scalar_one_or_none()
    if n is None or n.status not in _VISIBLE:
        raise HTTPException(404, "书籍不存在或未上架")
    return n


@router.get("/books/{slug}")
def book_detail(
    slug: str, session: Session = Depends(db_session), _: dict = Depends(require_reader)
) -> dict:
    n = _get_visible_novel(session, slug)
    chapters = session.execute(
        select(Chapter).where(
            Chapter.novel_id == n.id, Chapter.status == ChapterStatus.done.value
        ).order_by(Chapter.index)
    ).scalars().all()
    card = _book_card(n, len(chapters))
    card["chapters"] = [
        {"index": c.index, "title": c.title, "word_count": c.word_count} for c in chapters
    ]
    return card


@router.get("/books/{slug}/chapters/{index}")
def chapter_content(
    slug: str, index: int,
    session: Session = Depends(db_session), _: dict = Depends(require_reader),
) -> dict:
    n = _get_visible_novel(session, slug)
    c = session.execute(
        select(Chapter).where(
            Chapter.novel_id == n.id, Chapter.index == index,
            Chapter.status == ChapterStatus.done.value,
        )
    ).scalar_one_or_none()
    if c is None:
        raise HTTPException(404, "章节不存在")
    return {"index": c.index, "title": c.title, "content": c.content, "word_count": c.word_count}


@router.get("/books/{slug}/cover")
def book_cover(
    slug: str,
    token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    session: Session = Depends(db_session),
) -> Response:
    # <img> 标签发的普通请求带不上 Authorization 头，故也接受 ?token= 查询参数
    payload = verify_token(token) if token else _token_from_header(authorization)
    if not payload or payload.get("role") not in ("reader", "admin"):
        raise HTTPException(401, "未登录或会话已过期")
    n = _get_visible_novel(session, slug)
    data = cover_path_bytes(n.cover_path)
    if not data:
        raise HTTPException(404, "无封面")
    return Response(content=data, media_type="image/png")


@router.get("/books/{slug}/epub")
def book_epub(
    slug: str, session: Session = Depends(db_session), _: dict = Depends(require_reader)
) -> Response:
    n = _get_visible_novel(session, slug)
    chapters = session.execute(
        select(Chapter).where(
            Chapter.novel_id == n.id, Chapter.status == ChapterStatus.done.value
        ).order_by(Chapter.index)
    ).scalars().all()
    data = build_epub(n, chapters, cover_path_bytes(n.cover_path))
    return Response(
        content=data,
        media_type="application/epub+zip",
        headers={"Content-Disposition": f'attachment; filename="{n.slug}.epub"'},
    )


class ProgressIn(BaseModel):
    chapter_index: int
    scroll: float = 0.0


@router.get("/progress/{slug}")
def get_progress(
    slug: str, session: Session = Depends(db_session), identity: dict = Depends(require_reader)
) -> dict:
    n = _get_visible_novel(session, slug)
    reader_id = str(identity.get("id", "anon"))
    p = session.execute(
        select(ReadingProgress).where(
            ReadingProgress.reader_id == reader_id, ReadingProgress.novel_id == n.id
        )
    ).scalar_one_or_none()
    if p is None:
        return {"chapter_index": 1, "scroll": 0.0}
    return {"chapter_index": p.chapter_index, "scroll": p.scroll}


@router.put("/progress/{slug}")
def put_progress(
    slug: str, body: ProgressIn,
    session: Session = Depends(db_session), identity: dict = Depends(require_reader),
) -> dict:
    n = _get_visible_novel(session, slug)
    reader_id = str(identity.get("id", "anon"))
    p = session.execute(
        select(ReadingProgress).where(
            ReadingProgress.reader_id == reader_id, ReadingProgress.novel_id == n.id
        )
    ).scalar_one_or_none()
    if p is None:
        p = ReadingProgress(reader_id=reader_id, novel_id=n.id)
        session.add(p)
    p.chapter_index = body.chapter_index
    p.scroll = body.scroll
    return {"ok": True}
