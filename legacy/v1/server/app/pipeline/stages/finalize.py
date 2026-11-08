"""成书阶段：刷新简介、汇总字数、标记完成。EPUB 由 services 按需生成。"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Chapter, Novel, NovelStatus, NovelEmbedding
from app.pipeline import prompts
from app.pipeline.llm import PipelineLLM
from app.pipeline.stages.planning import _embed


async def stage_finalize(session: Session, llm: PipelineLLM, novel: Novel) -> None:
    summaries = session.execute(
        select(Chapter.index, Chapter.summary)
        .where(Chapter.novel_id == novel.id).order_by(Chapter.index)
    ).all()
    summary_block = "\n".join(f"第{i}章：{s}" for i, s in summaries if s)

    new_syn = await llm.text(
        "book_synopsis", "finalize",
        system=prompts.SYSTEM_BASE,
        user=prompts.book_synopsis_prompt(novel.title, summary_block),
        ctx={"seed": f"n{novel.id}"},
    )
    if new_syn:
        novel.synopsis = new_syn

    # 大纲向量入库，供后续查重（若有 embedding 能力）
    vecs = await _embed(session, [novel.synopsis or novel.premise])
    if vecs:
        session.add(NovelEmbedding(
            novel_id=novel.id, kind="outline",
            text=novel.synopsis[:500], vector=vecs[0],
        ))

    counts = session.execute(
        select(Chapter.word_count).where(Chapter.novel_id == novel.id)
    ).scalars().all()
    novel.word_count = sum(counts)
    novel.status = NovelStatus.completed.value
    novel.completed_at = datetime.now(timezone.utc)
