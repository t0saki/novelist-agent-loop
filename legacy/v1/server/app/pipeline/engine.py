"""流水线引擎：把一个 generate 任务从当前阶段推进到成书。

- 阶段顺序确定（STAGE_SEQUENCE），逐阶段执行并落 job.stage 检查点。
- 崩溃/重启后由调度器重新调用 run_job，从 job.stage 续跑；写作阶段按章续跑。
- 阶段抛异常则累加 attempts，超过上限标记 failed，否则回到 queued 等待重试。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.core.events import broker
from app.db.database import session_scope
from app.db.models import Job, JobStatus, JobType, Novel, NovelStatus, Setting
from app.pipeline import (
    STAGE_BIBLE,
    STAGE_CONCEPT,
    STAGE_FINALIZE,
    STAGE_IDEATION,
    STAGE_LABELS,
    STAGE_OUTLINE,
    STAGE_SEQUENCE,
    STAGE_WRITING,
)
from app.pipeline.llm import PipelineLLM
from app.pipeline.stages.finalize import stage_finalize
from app.pipeline.stages.planning import (
    stage_bible,
    stage_concept,
    stage_ideation,
    stage_outline,
)
from app.pipeline.stages.writing import ControlFn, stage_writing

logger = logging.getLogger("novelist.pipeline.engine")


def _now() -> datetime:
    return datetime.now(timezone.utc)


class PipelineEngine:
    def __init__(self, control: ControlFn | None = None) -> None:
        self.control = control

    async def run_job(self, job_id: int) -> str:
        with session_scope() as session:
            job = session.get(Job, job_id)
            if job is None:
                return "missing"
            novel = session.get(Novel, job.novel_id) if job.novel_id else None
            if novel is None:
                job.status = JobStatus.failed.value
                job.error = "关联小说不存在"
                return JobStatus.failed.value

            max_attempts = int(_get_setting(session, "max_job_attempts", 3) or 3)
            job.status = JobStatus.running.value
            job.started_at = job.started_at or _now()
            job.error = None
            session.commit()
            broker.publish("job_started", {"job_id": job.id, "novel_id": novel.id, "title": novel.title})

            llm = PipelineLLM(session, novel.id)

            # 封面/插图任务：独立简单流程
            if job.type == JobType.cover.value:
                try:
                    from app.pipeline.stages.cover import run_cover_job
                    await run_cover_job(session, llm, novel)
                    job.status = JobStatus.done.value
                    job.finished_at = _now()
                    session.commit()
                    broker.publish("cover_done", {"novel_id": novel.id, "title": novel.title})
                    return JobStatus.done.value
                except Exception as e:  # noqa: BLE001
                    logger.exception("cover job=%s 失败", job.id)
                    session.rollback()
                    job = session.get(Job, job_id)
                    if job:
                        job.attempts += 1
                        job.error = str(e)[:1000]
                        job.status = (JobStatus.failed.value if job.attempts >= max_attempts
                                      else JobStatus.queued.value)
                        session.commit()
                    return job.status if job else "missing"

            start_idx = STAGE_SEQUENCE.index(job.stage) if job.stage in STAGE_SEQUENCE else 0

            try:
                for stage in STAGE_SEQUENCE[start_idx:]:
                    job.stage = stage
                    if stage == STAGE_WRITING:
                        novel.status = NovelStatus.writing.value
                    session.commit()
                    broker.publish("stage", {
                        "job_id": job.id, "novel_id": novel.id,
                        "stage": stage, "label": STAGE_LABELS.get(stage, stage),
                    })

                    outcome = await self._dispatch(stage, session, llm, novel, job)
                    if outcome in ("paused", "stopped"):
                        job.status = JobStatus.paused.value
                        session.commit()
                        broker.publish("job_paused", {"job_id": job.id, "novel_id": novel.id})
                        return JobStatus.paused.value

                job.status = JobStatus.done.value
                job.finished_at = _now()
                job.progress = {"chapter": novel.planned_chapters, "total": novel.planned_chapters}
                # 成书后若启用图像流水线，排一个封面任务
                from app.pipeline.stages.cover import image_pipeline_enabled
                if image_pipeline_enabled(session):
                    session.add(Job(
                        novel_id=novel.id, type=JobType.cover.value,
                        stage="cover", priority=1,
                    ))
                session.commit()
                broker.publish("job_done", {
                    "job_id": job.id, "novel_id": novel.id, "title": novel.title,
                    "words": novel.word_count,
                })
                return JobStatus.done.value

            except Exception as e:  # noqa: BLE001
                logger.exception("job=%s stage=%s 失败", job.id, job.stage)
                try:
                    session.rollback()
                except Exception:  # noqa: BLE001
                    pass
                # 关键：用**全新会话**记账失败，避免当前会话被 flush 异常（如
                # database is locked）污染后连状态都写不回，导致 job 永远卡在 running。
                # 若这次写回也失败，调度器看门狗仍会把 running 孤儿回收。
                status = self._record_failure(job_id, str(e)[:1000], max_attempts)
                return status

    def _record_failure(self, job_id: int, err: str, max_attempts: int) -> str:
        for attempt in range(3):
            try:
                with session_scope() as s:
                    job = s.get(Job, job_id)
                    if job is None:
                        return "missing"
                    novel = s.get(Novel, job.novel_id) if job.novel_id else None
                    job.attempts += 1
                    job.error = err
                    if job.attempts >= max_attempts:
                        job.status = JobStatus.failed.value
                        if novel is not None:
                            novel.status = NovelStatus.failed.value
                            novel.error = err
                    else:
                        job.status = JobStatus.queued.value  # 稍后重试
                    final = job.status == JobStatus.failed.value
                    attempts = job.attempts
                    jid = job.id
                broker.publish("job_error", {
                    "job_id": jid, "attempts": attempts, "error": err, "final": final,
                })
                return JobStatus.failed.value if final else JobStatus.queued.value
            except Exception:  # noqa: BLE001
                logger.warning("记账失败重试 %d/3（job=%s）", attempt + 1, job_id)
        return JobStatus.running.value  # 记账彻底失败，交由看门狗回收

    async def _dispatch(self, stage, session, llm, novel, job) -> str | None:
        if stage == STAGE_IDEATION:
            await stage_ideation(session, llm, novel)
        elif stage == STAGE_CONCEPT:
            await stage_concept(session, llm, novel)
        elif stage == STAGE_BIBLE:
            await stage_bible(session, llm, novel)
        elif stage == STAGE_OUTLINE:
            await stage_outline(session, llm, novel)
        elif stage == STAGE_WRITING:
            return await stage_writing(session, llm, novel, job, self.control)
        elif stage == STAGE_FINALIZE:
            await stage_finalize(session, llm, novel)
        return None


def _get_setting(session, key: str, default):
    row = session.get(Setting, key)
    return row.value if row is not None else default
