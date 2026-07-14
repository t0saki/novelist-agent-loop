"""管理端 API：仪表盘、配置、题材/模型/只读密码、任务与书籍管理、SSE。"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.deps import db_session, require_admin
from app.core.events import broker
from app.core.security import hash_password, verify_token
from app.db.models import (
    Chapter,
    Job,
    JobStatus,
    LlmProfile,
    Novel,
    NovelStatus,
    ReaderPassword,
    Setting,
    Theme,
    UsageLedger,
)
from app.scheduler.ratelimit import budget_snapshot, rate_limit_status
from app.services.novels import create_novel_with_job

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _get(session: Session, key: str, default=None):
    row = session.get(Setting, key)
    return row.value if row is not None else default


def _set(session: Session, key: str, value: Any) -> None:
    row = session.get(Setting, key)
    if row is None:
        session.add(Setting(key=key, value=value))
    else:
        row.value = value


# ---------- 仪表盘 ----------

@router.get("/stats")
def stats(session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    from datetime import datetime, timedelta, timezone
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    by_status = dict(session.execute(
        select(Novel.status, func.count()).group_by(Novel.status)
    ).all())
    books_today = session.execute(
        select(func.count()).select_from(Novel).where(Novel.created_at >= since)
    ).scalar_one()
    cost_today = session.execute(
        select(func.coalesce(func.sum(UsageLedger.cost), 0.0)).where(UsageLedger.created_at >= since)
    ).scalar_one()
    queue = dict(session.execute(
        select(Job.status, func.count()).group_by(Job.status)
    ).all())
    return {
        "novels_by_status": by_status,
        "books_today": books_today,
        "cost_today": round(cost_today, 4),
        "queue": queue,
        "rate_limit": rate_limit_status(session),
        "budget": budget_snapshot(session),
        "scheduler_paused": bool(_get(session, "scheduler_paused", False)),
        "auto_generate": bool(_get(session, "auto_generate", True)),
    }


# ---------- 配置 ----------

_SETTINGS_KEYS = {
    "rate_limit", "token_budget", "concurrency", "dedup_threshold",
    "scene_floor_ratio", "max_job_attempts", "stage_profiles",
    "illustration_density", "illustration_every_n", "auto_generate", "scheduler_paused",
}


@router.get("/settings")
def get_settings_all(session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    return {k: _get(session, k) for k in _SETTINGS_KEYS}


@router.put("/settings")
def update_settings(
    body: dict[str, Any], session: Session = Depends(db_session), _: dict = Depends(require_admin)
) -> dict:
    for k, v in body.items():
        if k in _SETTINGS_KEYS:
            _set(session, k, v)
    return {"ok": True}


class PasswordIn(BaseModel):
    new_password: str


@router.put("/password")
def change_password(
    body: PasswordIn, session: Session = Depends(db_session), _: dict = Depends(require_admin)
) -> dict:
    if len(body.new_password) < 4:
        raise HTTPException(400, "密码太短")
    _set(session, "admin_password_hash", hash_password(body.new_password))
    return {"ok": True}


# ---------- 题材 ----------

class ThemeIn(BaseModel):
    name: str
    keywords: list[str] = []
    style_prompt: str = ""
    length_hint: str = ""
    min_chapters: int | None = None
    weight: float = 1.0
    nsfw: bool = False
    enabled: bool = True


def _theme_out(t: Theme) -> dict:
    return {
        "id": t.id, "name": t.name, "keywords": t.keywords, "style_prompt": t.style_prompt,
        "length_hint": t.length_hint, "min_chapters": t.min_chapters, "weight": t.weight,
        "nsfw": t.nsfw, "enabled": t.enabled,
    }


@router.get("/themes")
def list_themes(session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    themes = session.execute(select(Theme).order_by(Theme.id)).scalars().all()
    return {"themes": [_theme_out(t) for t in themes]}


@router.post("/themes")
def create_theme(body: ThemeIn, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    t = Theme(**body.model_dump())
    session.add(t)
    session.flush()
    return _theme_out(t)


@router.put("/themes/{theme_id}")
def update_theme(theme_id: int, body: ThemeIn, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    t = session.get(Theme, theme_id)
    if not t:
        raise HTTPException(404, "题材不存在")
    for k, v in body.model_dump().items():
        setattr(t, k, v)
    return _theme_out(t)


@router.delete("/themes/{theme_id}")
def delete_theme(theme_id: int, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    session.execute(delete(Theme).where(Theme.id == theme_id))
    return {"ok": True}


# ---------- 模型 profile ----------

class ProfileIn(BaseModel):
    name: str
    kind: str = "chat"
    base_url: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = ""
    temperature: float = 0.9
    max_tokens: int | None = None
    price_prompt_per_mtok: float = 0.0
    price_completion_per_mtok: float = 0.0
    supports_tools: bool = True
    extra: dict[str, Any] = {}
    enabled: bool = True
    is_default: bool = False


def _profile_out(p: LlmProfile) -> dict:
    return {
        "id": p.id, "name": p.name, "kind": p.kind, "base_url": p.base_url,
        "api_key_set": bool(p.api_key), "model": p.model, "temperature": p.temperature,
        "max_tokens": p.max_tokens, "price_prompt_per_mtok": p.price_prompt_per_mtok,
        "price_completion_per_mtok": p.price_completion_per_mtok,
        "supports_tools": p.supports_tools, "extra": p.extra,
        "enabled": p.enabled, "is_default": p.is_default,
    }


@router.get("/profiles")
def list_profiles(session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    profiles = session.execute(select(LlmProfile).order_by(LlmProfile.id)).scalars().all()
    return {"profiles": [_profile_out(p) for p in profiles]}


@router.post("/profiles")
def create_profile(body: ProfileIn, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    if body.is_default:
        _clear_default(session, body.kind)
    p = LlmProfile(**body.model_dump())
    session.add(p)
    session.flush()
    return _profile_out(p)


@router.put("/profiles/{profile_id}")
def update_profile(profile_id: int, body: ProfileIn, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    p = session.get(LlmProfile, profile_id)
    if not p:
        raise HTTPException(404, "profile 不存在")
    data = body.model_dump()
    # api_key 留空表示不改动
    if not data.get("api_key"):
        data.pop("api_key")
    if data.get("is_default"):
        _clear_default(session, data.get("kind", p.kind))
    for k, v in data.items():
        setattr(p, k, v)
    return _profile_out(p)


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: int, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    session.execute(delete(LlmProfile).where(LlmProfile.id == profile_id))
    return {"ok": True}


def _clear_default(session: Session, kind: str) -> None:
    for p in session.execute(select(LlmProfile).where(LlmProfile.kind == kind, LlmProfile.is_default.is_(True))).scalars():
        p.is_default = False


# ---------- 只读密码 ----------

class ReaderIn(BaseModel):
    label: str = "reader"
    password: str
    enabled: bool = True


@router.get("/readers")
def list_readers(session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    rows = session.execute(select(ReaderPassword).order_by(ReaderPassword.id)).scalars().all()
    return {"readers": [{"id": r.id, "label": r.label, "enabled": r.enabled} for r in rows]}


@router.post("/readers")
def create_reader(body: ReaderIn, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    r = ReaderPassword(label=body.label, password_hash=hash_password(body.password), enabled=body.enabled)
    session.add(r)
    session.flush()
    return {"id": r.id, "label": r.label, "enabled": r.enabled}


@router.delete("/readers/{reader_id}")
def delete_reader(reader_id: int, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    session.execute(delete(ReaderPassword).where(ReaderPassword.id == reader_id))
    return {"ok": True}


# ---------- 任务与书籍 ----------

@router.get("/jobs")
def list_jobs(
    session: Session = Depends(db_session), _: dict = Depends(require_admin),
    limit: int = Query(default=50, le=200),
) -> dict:
    rows = session.execute(select(Job).order_by(Job.updated_at.desc()).limit(limit)).scalars().all()
    out = []
    for j in rows:
        n = session.get(Novel, j.novel_id) if j.novel_id else None
        out.append({
            "id": j.id, "novel_id": j.novel_id, "novel_title": n.title if n else "",
            "slug": n.slug if n else None, "type": j.type, "stage": j.stage,
            "status": j.status, "attempts": j.attempts, "progress": j.progress,
            "error": j.error, "updated_at": j.updated_at.isoformat() if j.updated_at else None,
        })
    return {"jobs": out}


@router.get("/novels")
def list_all_novels(
    session: Session = Depends(db_session), _: dict = Depends(require_admin),
    status: str | None = Query(default=None), limit: int = Query(default=100, le=500),
) -> dict:
    stmt = select(Novel).order_by(Novel.id.desc()).limit(limit)
    if status:
        stmt = select(Novel).where(Novel.status == status).order_by(Novel.id.desc()).limit(limit)
    novels = session.execute(stmt).scalars().all()
    out = []
    for n in novels:
        done = session.execute(
            select(func.count()).select_from(Chapter).where(Chapter.novel_id == n.id)
        ).scalar_one()
        out.append({
            "id": n.id, "slug": n.slug, "title": n.title, "status": n.status,
            "theme": n.theme_name, "nsfw": n.nsfw, "planned_chapters": n.planned_chapters,
            "chapters_written": done, "word_count": n.word_count,
            "tokens_total": n.tokens_total, "cost_total": round(n.cost_total, 4),
            "quality_debt": len(n.quality_debt or []), "error": n.error,
            "created_at": n.created_at.isoformat() if n.created_at else None,
        })
    return {"novels": out}


class ManualBookIn(BaseModel):
    theme_id: int | None = None


@router.post("/novels")
def manual_create(body: ManualBookIn, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    theme = session.get(Theme, body.theme_id) if body.theme_id else None
    novel, job = create_novel_with_job(session, theme, priority=5)  # 手动立项优先
    session.flush()
    return {"novel_id": novel.id, "slug": novel.slug, "job_id": job.id}


@router.post("/novels/{slug}/archive")
def archive_novel(slug: str, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    n = session.execute(select(Novel).where(Novel.slug == slug)).scalar_one_or_none()
    if not n:
        raise HTTPException(404, "书籍不存在")
    n.status = NovelStatus.archived.value
    return {"ok": True}


@router.delete("/novels/{slug}")
def delete_novel(slug: str, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    n = session.execute(select(Novel).where(Novel.slug == slug)).scalar_one_or_none()
    if not n:
        raise HTTPException(404, "书籍不存在")
    session.execute(delete(Job).where(Job.novel_id == n.id))
    session.delete(n)  # cascade 章节
    return {"ok": True}


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: int, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    j = session.get(Job, job_id)
    if not j:
        raise HTTPException(404, "任务不存在")
    j.status = JobStatus.queued.value
    j.attempts = 0
    j.error = None
    n = session.get(Novel, j.novel_id) if j.novel_id else None
    if n and n.status == NovelStatus.failed.value:
        n.status = NovelStatus.planning.value if j.stage != "writing" else NovelStatus.writing.value
        n.error = None
    return {"ok": True}


@router.get("/novels/{slug}")
def admin_novel_detail(slug: str, session: Session = Depends(db_session), _: dict = Depends(require_admin)) -> dict:
    n = session.execute(select(Novel).where(Novel.slug == slug)).scalar_one_or_none()
    if not n:
        raise HTTPException(404, "书籍不存在")
    chapters = session.execute(
        select(Chapter).where(Chapter.novel_id == n.id).order_by(Chapter.index)
    ).scalars().all()
    return {
        "id": n.id, "slug": n.slug, "title": n.title, "status": n.status,
        "premise": n.premise, "synopsis": n.synopsis, "bible": n.bible,
        "outline": n.outline, "volumes": n.volumes, "quality_debt": n.quality_debt,
        "planned_chapters": n.planned_chapters, "word_count": n.word_count,
        "tokens_total": n.tokens_total, "cost_total": round(n.cost_total, 4),
        "chapters": [
            {"index": c.index, "title": c.title, "word_count": c.word_count, "status": c.status}
            for c in chapters
        ],
    }


# ---------- SSE ----------

@router.get("/events")
async def events(token: str = Query(...)) -> StreamingResponse:
    payload = verify_token(token)
    if not payload or payload.get("role") != "admin":
        raise HTTPException(401, "未授权")

    async def gen():
        q = broker.subscribe()
        try:
            yield "event: hello\ndata: {}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25)
                    yield msg
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # 心跳保持连接
        finally:
            broker.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream")
