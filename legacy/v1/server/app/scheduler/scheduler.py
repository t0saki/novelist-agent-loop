"""常驻调度器：限流内自动立项、并发推进任务、续写优先、预算暂停。

单进程 asyncio。所有决策基于 DB 状态，进程重启后无缝接管（幂等）。
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.events import broker
from app.db.database import session_scope
from app.db.models import Job, JobStatus, Novel, NovelStatus, Setting, Theme
from app.pipeline import STAGE_WRITING
from app.pipeline.engine import PipelineEngine
from app.scheduler.ratelimit import (
    can_start_new_book,
    daily_budget_ok,
    per_book_over,
)
from app.services.novels import create_novel_with_job

logger = logging.getLogger("novelist.scheduler")


def _get(session: Session, key: str, default):
    row = session.get(Setting, key)
    return row.value if row is not None else default


def _pick_theme(session: Session) -> Theme | None:
    """按 weight 加权确定性挑选启用题材（用 usage 计数打散，避免随机不可复现）。"""
    themes = session.execute(select(Theme).where(Theme.enabled.is_(True))).scalars().all()
    if not themes:
        return None
    # 选「已产出书数 / weight」最小者，等价于加权轮转
    def score(t: Theme) -> float:
        n = session.execute(
            select(Novel).where(Novel.theme_id == t.id)
        ).scalars().all()
        return len(n) / max(t.weight, 0.01)
    return min(themes, key=score)


class Scheduler:
    def __init__(self) -> None:
        self.shutdown = asyncio.Event()
        self.running: dict[int, asyncio.Task] = {}  # job_id -> task
        self._engine_for = PipelineEngine(control=self._control)

    async def _control(self, session: Session, novel: Novel) -> str:
        """写作阶段每章之间的调度控制。"""
        if self.shutdown.is_set():
            return "stop"
        if _get(session, "scheduler_paused", False):
            return "pause"
        if per_book_over(session, novel):
            logger.info("novel=%s 超单本 token 预算，暂停待处置", novel.id)
            return "pause"
        if not daily_budget_ok(session):
            logger.info("日 token 预算耗尽，暂停 novel=%s 待窗口恢复", novel.id)
            return "pause"
        return "continue"

    def _runnable_jobs(self, session: Session) -> list[int]:
        """按优先级返回可运行的 job id：续写(writing) 优先于新书，且预算允许。"""
        rows = session.execute(
            select(Job).where(
                Job.status.in_([JobStatus.queued.value, JobStatus.paused.value]),
            )
        ).scalars().all()
        candidates: list[tuple[tuple, int]] = []
        for job in rows:
            if job.id in self.running:
                continue
            novel = session.get(Novel, job.novel_id) if job.novel_id else None
            if novel is None:
                continue
            # paused 任务：只有预算恢复后才可继续
            if job.status == JobStatus.paused.value:
                if per_book_over(session, novel) or not daily_budget_ok(session):
                    continue
            elif not daily_budget_ok(session):
                continue
            is_writing = novel.status == NovelStatus.writing.value
            # 排序键：续写优先(0)，再按 priority 降序、id 升序
            key = (0 if is_writing else 1, -job.priority, job.id)
            candidates.append((key, job.id))
        candidates.sort(key=lambda x: x[0])
        return [jid for _, jid in candidates]

    async def tick(self) -> None:
        # 清理已完成的任务槽
        for jid, task in list(self.running.items()):
            if task.done():
                self.running.pop(jid, None)
                exc = task.exception() if not task.cancelled() else None
                if exc:
                    logger.error("job=%s 任务异常：%s", jid, exc)

        # 看门狗：DB 里标记 running 但没有活任务的 job（任务异常/进程被杀导致孤儿），
        # 重新入队让其从检查点续跑；超过重试上限则判失败。防止「永远卡在某阶段」。
        self._reap_stale_running()

        with session_scope() as session:
            if _get(session, "scheduler_paused", False):
                return
            concurrency = int(_get(session, "concurrency", 1) or 1)
            capacity = concurrency - len(self.running)
            if capacity <= 0:
                return

            runnable = self._runnable_jobs(session)
            auto = bool(_get(session, "auto_generate", True))
            can_new = auto and can_start_new_book(session)

        # 先跑已有可运行任务
        for job_id in runnable[:capacity]:
            self._launch(job_id)
            capacity -= 1

        # 还有余量且允许则立项新书
        while capacity > 0 and can_new:
            with session_scope() as session:
                if not can_start_new_book(session):
                    break
                theme = _pick_theme(session)
                if theme is None:
                    # 没有启用的题材就不要凭空造一本无题材的书（避免跑偏出无关内容）
                    logger.info("无启用题材，跳过自动立项")
                    break
                novel, job = create_novel_with_job(session, theme)
                job_id = job.id
                title_hint = theme.name
            logger.info("自动立项新书 job=%s 题材=%s", job_id, title_hint)
            broker.publish("book_created", {"job_id": job_id})
            self._launch(job_id)
            capacity -= 1

    def _reap_stale_running(self) -> None:
        """把 DB 中 status=running 但没有对应活任务的 job 复位。

        这类 job 的 asyncio 任务已死（异常/取消），或进程曾被杀，DB 状态没落终态，
        而调度器只挑 queued/paused，会导致其永远卡住。每 tick 检查并回收。
        """
        with session_scope() as session:
            max_attempts = int(_get(session, "max_job_attempts", 3) or 3)
            stale = session.execute(
                select(Job).where(Job.status == JobStatus.running.value)
            ).scalars().all()
            for job in stale:
                if job.id in self.running:
                    continue  # 确有活任务，正常运行中
                job.attempts += 1
                if job.attempts >= max_attempts:
                    job.status = JobStatus.failed.value
                    job.error = (job.error or "") + " | 任务孤儿：running 无活任务，重试耗尽"
                    novel = session.get(Novel, job.novel_id) if job.novel_id else None
                    if novel is not None:
                        novel.status = NovelStatus.failed.value
                    logger.warning("孤儿任务 job=%s 重试耗尽，判失败", job.id)
                else:
                    job.status = JobStatus.queued.value
                    logger.warning("回收孤儿任务 job=%s（running→queued, stage=%s, attempts=%s）",
                                   job.id, job.stage, job.attempts)

    def _launch(self, job_id: int) -> None:
        if job_id in self.running:
            return
        task = asyncio.create_task(self._engine_for.run_job(job_id))
        self.running[job_id] = task

    async def run_forever(self) -> None:
        settings = get_settings()
        logger.info("调度器启动，tick=%ds", settings.scheduler_tick_seconds)
        self._recover_orphans()
        while not self.shutdown.is_set():
            try:
                await self.tick()
            except Exception:  # noqa: BLE001
                logger.exception("调度 tick 异常")
            try:
                await asyncio.wait_for(
                    self.shutdown.wait(), timeout=settings.scheduler_tick_seconds
                )
            except asyncio.TimeoutError:
                pass
        # 优雅停机：等待在跑任务落盘（写作阶段会在下一章边界 stop）
        logger.info("调度器停机，等待 %d 个在跑任务…", len(self.running))
        if self.running:
            await asyncio.gather(*self.running.values(), return_exceptions=True)

    def _recover_orphans(self) -> None:
        """启动时把上次进程遗留的 running 任务改回 queued，交由本轮重新调度。"""
        with session_scope() as session:
            orphans = session.execute(
                select(Job).where(Job.status == JobStatus.running.value)
            ).scalars().all()
            for job in orphans:
                job.status = JobStatus.queued.value
                logger.info("恢复孤儿任务 job=%s（stage=%s）回到队列", job.id, job.stage)

    async def stop(self) -> None:
        self.shutdown.set()


scheduler = Scheduler()
