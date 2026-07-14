"""封面流水线测试（mock 图像）。"""
from sqlalchemy import select

from app.db.database import session_scope
from app.db.models import Image, Job, JobType, Novel, Setting
from app.pipeline.engine import PipelineEngine
from app.services.novels import create_novel_with_job


def _set(key, value):
    with session_scope() as s:
        row = s.get(Setting, key)
        if row is None:
            s.add(Setting(key=key, value=value))
        else:
            row.value = value


async def test_cover_job_created_and_runs():
    _set("illustration_density", "cover")
    with session_scope() as s:
        novel, job = create_novel_with_job(s, None)
        novel_id, job_id = novel.id, job.id

    assert await PipelineEngine().run_job(job_id) == "done"

    # 成书后应排了封面任务
    with session_scope() as s:
        cover_job = s.execute(
            select(Job).where(Job.novel_id == novel_id, Job.type == JobType.cover.value)
        ).scalar_one_or_none()
        assert cover_job is not None
        cover_job_id = cover_job.id

    assert await PipelineEngine().run_job(cover_job_id) == "done"

    with session_scope() as s:
        novel = s.get(Novel, novel_id)
        assert novel.cover_path, "封面路径未写入"
        imgs = s.execute(select(Image).where(Image.novel_id == novel_id)).scalars().all()
        assert any(i.kind == "cover" for i in imgs)


async def test_no_cover_when_density_none():
    _set("illustration_density", "none")
    with session_scope() as s:
        novel, job = create_novel_with_job(s, None)
        novel_id, job_id = novel.id, job.id
    await PipelineEngine().run_job(job_id)
    with session_scope() as s:
        cover_job = s.execute(
            select(Job).where(Job.novel_id == novel_id, Job.type == JobType.cover.value)
        ).scalar_one_or_none()
        assert cover_job is None
    _set("illustration_density", "cover")  # 复原
