"""小说立项与查询辅助。"""
from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Job, JobType, Novel, NovelStatus, Theme
from app.pipeline import STAGE_IDEATION


def _unique_slug(session: Session) -> str:
    while True:
        slug = secrets.token_hex(4)
        exists = session.execute(select(Novel.id).where(Novel.slug == slug)).first()
        if not exists:
            return slug


def create_novel_with_job(
    session: Session, theme: Theme | None, *, priority: int = 0
) -> tuple[Novel, Job]:
    """创建一本待生成的小说 + 对应 generate 任务。"""
    novel = Novel(
        slug=_unique_slug(session),
        theme_id=theme.id if theme else None,
        theme_name=theme.name if theme else "",
        nsfw=bool(theme and theme.nsfw),
        status=NovelStatus.planning.value,
    )
    session.add(novel)
    session.flush()
    job = Job(
        novel_id=novel.id,
        type=JobType.generate.value,
        stage=STAGE_IDEATION,
        priority=priority,
    )
    session.add(job)
    session.flush()
    return novel, job
