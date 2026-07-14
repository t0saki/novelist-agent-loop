"""调度器测试：自动立项、限流、预算暂停、孤儿恢复。"""
import asyncio

from sqlalchemy import delete, select

from app.db.database import session_scope
from app.db.models import (
    Chapter,
    Image,
    Job,
    JobStatus,
    Novel,
    NovelEmbedding,
    NovelStatus,
    ReadingProgress,
    Setting,
    UsageLedger,
)
from app.scheduler.scheduler import Scheduler


def _wipe():
    with session_scope() as s:
        for model in (UsageLedger, NovelEmbedding, Image, ReadingProgress, Chapter, Job, Novel):
            s.execute(delete(model))


def _set(key, value):
    with session_scope() as s:
        row = s.get(Setting, key)
        if row is None:
            s.add(Setting(key=key, value=value))
        else:
            row.value = value


async def _drain(sched: Scheduler):
    """反复 tick 直到没有新任务被启动，并等待在跑任务完成。"""
    for _ in range(30):
        await sched.tick()
        if sched.running:
            await asyncio.gather(*sched.running.values(), return_exceptions=True)
            sched.running.clear()
        else:
            break


async def test_scheduler_respects_rate_limit():
    _wipe()
    _set("rate_limit", {"books_per_day": 2, "books_per_5h": 2})
    _set("token_budget", {"daily_tokens": 0, "per_book_tokens": 0})
    _set("concurrency", 1)
    _set("auto_generate", True)
    _set("scheduler_paused", False)

    sched = Scheduler()
    await _drain(sched)

    with session_scope() as s:
        novels = s.execute(select(Novel)).scalars().all()
        assert len(novels) == 2, f"限流应只产 2 本，实得 {len(novels)}"
        assert all(n.status == NovelStatus.completed.value for n in novels)


async def test_per_book_budget_pauses():
    _wipe()
    _set("rate_limit", {"books_per_day": 1, "books_per_5h": 1})
    # 单本预算极低：写完设定/大纲阶段就会超，写作阶段第 2 章前暂停
    _set("token_budget", {"daily_tokens": 0, "per_book_tokens": 1})
    _set("concurrency", 1)
    _set("auto_generate", True)

    sched = Scheduler()
    await _drain(sched)

    with session_scope() as s:
        job = s.execute(select(Job)).scalars().first()
        assert job is not None
        # 预算=1 token，写作阶段每章间检查即暂停
        assert job.status == JobStatus.paused.value, f"应暂停，实为 {job.status}"

    # 放开预算后应能续跑到完成
    _set("token_budget", {"daily_tokens": 0, "per_book_tokens": 0})
    await _drain(sched)
    with session_scope() as s:
        novel = s.execute(select(Novel)).scalars().first()
        assert novel.status == NovelStatus.completed.value


async def test_orphan_recovery():
    _wipe()
    _set("rate_limit", {"books_per_day": 0, "books_per_5h": 0})  # 0=不限
    _set("auto_generate", False)
    # 造一个卡在 running 的孤儿任务
    with session_scope() as s:
        from app.services.novels import create_novel_with_job
        novel, job = create_novel_with_job(s, None)
        job.status = JobStatus.running.value
        job_id = job.id

    sched = Scheduler()
    sched._recover_orphans()
    with session_scope() as s:
        job = s.get(Job, job_id)
        assert job.status == JobStatus.queued.value, "孤儿任务应回到 queued"
