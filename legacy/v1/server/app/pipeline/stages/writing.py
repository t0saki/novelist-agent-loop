"""写作阶段：逐章 → 逐场景生成。反偷懒长度控制的核心实现。

每章完成即 commit（连载上架，读者立即可见）；job.checkpoint 记录已完成章号，
进程重启后从下一章续跑。场景级用确定性字数校验 + 扩写循环，绝不靠模型自评。
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.events import broker
from app.db.models import Chapter, ChapterStatus, Novel, Setting
from app.pipeline import prompts
from app.pipeline.context import build_scene_context, voice_str
from app.pipeline.length import (
    count_words,
    has_ending_marker,
    scene_ok,
)
from app.pipeline.llm import PipelineLLM
from app.pipeline.stages.planning import ensure_blueprint

logger = logging.getLogger("novelist.pipeline.writing")

MAX_SCENE_ATTEMPTS = 3
MAX_ROLLING_CHAPTERS = 10

# control 回调：在每章之间调用，返回 "continue" / "pause" / "stop"
ControlFn = Callable[[Session, Novel], Awaitable[str]]


def _get_setting(session: Session, key: str, default):
    row = session.get(Setting, key)
    return row.value if row is not None else default


def _strip_ending(text: str) -> str:
    for marker in ("全书完", "全文完", "（完）", "(完)", "剧终", "本书完", "全书终"):
        text = text.replace(marker, "")
    return text.strip()


def _rolling_summary(session: Session, novel_id: int, upto_index: int) -> str:
    rows = session.execute(
        select(Chapter.index, Chapter.summary)
        .where(Chapter.novel_id == novel_id, Chapter.index < upto_index, Chapter.summary != "")
        .order_by(Chapter.index.desc())
        .limit(MAX_ROLLING_CHAPTERS)
    ).all()
    rows = sorted(rows, key=lambda r: r[0])
    return "\n".join(f"第{i}章：{s}" for i, s in rows)


async def _generate_scene(
    llm: PipelineLLM,
    novel: Novel,
    chapter_bp: dict,
    scene: dict,
    prev_tail: str,
    rolling_summary: str,
    is_final_chapter: bool,
    is_final_scene: bool,
    is_opening: bool,
    chapter_id: int,
    floor_ratio: float,
) -> tuple[str, bool]:
    """生成单个场景，返回 (正文, 是否达标)。带扩写循环与完结检测。"""
    target = int(scene.get("target_words", 900))
    lang = novel.language
    ctx_block = build_scene_context(
        novel, chapter_bp, scene.get("characters", []), rolling_summary
    )
    voice = voice_str(novel)
    best_text = ""
    best_words = 0
    for attempt in range(MAX_SCENE_ATTEMPTS):
        shortfall = max(0, target - best_words) if attempt > 0 else None
        user = prompts.scene_prompt(
            novel.title, voice, ctx_block, chapter_bp.get("title", ""),
            scene, prev_tail, is_final_chapter, is_final_scene, is_opening, attempt, shortfall,
        )
        out = await llm.text(
            "scene", "writing",
            system=prompts.SYSTEM_WRITER, user=user,
            ctx={
                "target_words": target, "attempt": attempt,
                "is_final_scene": is_final_scene, "is_final_chapter": is_final_chapter,
                "seed": f"n{novel.id}c{chapter_id}s{scene.get('summary','')[:8]}",
            },
            chapter_id=chapter_id,
        )
        # 完结检测：非结尾却出现完结语 -> 视为偷懒，剥离后重试
        if not (is_final_chapter and is_final_scene) and has_ending_marker(out):
            out = _strip_ending(out)
        w = count_words(out, lang)
        if w > best_words:
            best_text, best_words = out, w
        if scene_ok(out, target, lang, floor_ratio):
            return out, True
    return best_text, False


async def stage_writing(
    session: Session,
    llm: PipelineLLM,
    novel: Novel,
    job=None,
    control: ControlFn | None = None,
) -> str:
    """返回结束原因：'done' / 'paused' / 'stopped'。"""
    floor_ratio = float(_get_setting(session, "scene_floor_ratio", 0.85) or 0.85)
    total = novel.planned_chapters
    done_indices = set(session.execute(
        select(Chapter.index).where(
            Chapter.novel_id == novel.id, Chapter.status == ChapterStatus.done.value
        )
    ).scalars().all())

    for index in range(1, total + 1):
        if index in done_indices:
            continue

        # 每章之间的调度/预算控制
        if control is not None and index > 1:
            decision = await control(session, novel)
            if decision == "pause":
                return "paused"
            if decision == "stop":
                return "stopped"

        chapter_bp = await ensure_blueprint(session, llm, novel, index)
        scenes = chapter_bp.get("scenes") or [
            {"summary": "推进本章情节", "must_happen": chapter_bp.get("goal", ""),
             "characters": chapter_bp.get("characters", []),
             "target_words": novel.target_chapter_words}
        ]
        is_final_chapter = index >= total

        chapter = session.execute(
            select(Chapter).where(Chapter.novel_id == novel.id, Chapter.index == index)
        ).scalar_one_or_none()
        if chapter is None:
            chapter = Chapter(novel_id=novel.id, index=index)
            session.add(chapter)
            session.flush()
        chapter.title = chapter_bp.get("title", f"第{index}章")
        chapter.blueprint = chapter_bp
        chapter.status = ChapterStatus.writing.value

        rolling = _rolling_summary(session, novel.id, index)
        # 提交章壳，释放上面 SELECT 触发的 autoflush 写锁，避免跨 LLM 调用长时间持锁
        session.commit()

        scene_texts: list[dict] = []
        prev_tail = ""
        for si, scene in enumerate(scenes):
            is_final_scene = si >= len(scenes) - 1
            is_opening = index == 1 and si == 0
            text, ok = await _generate_scene(
                llm, novel, chapter_bp, scene, prev_tail, rolling,
                is_final_chapter, is_final_scene, is_opening, chapter.id, floor_ratio,
            )
            scene_texts.append({"summary": scene.get("summary", ""), "text": text, "ok": ok})
            prev_tail = text
            if not ok:
                _add_debt(novel, {
                    "chapter": index, "scene": si, "type": "short",
                    "detail": f"场景字数未达标（目标{scene.get('target_words')}）",
                })
            # 每个场景后落库并提交：写锁只在 commit 瞬间持有，不跨下一个场景的 LLM 调用
            chapter.scenes = list(scene_texts)
            chapter.content = "\n\n".join(s["text"] for s in scene_texts)
            session.commit()

        content = "\n\n".join(s["text"] for s in scene_texts)
        chapter.content = content
        chapter.scenes = scene_texts
        chapter.word_count = count_words(content, novel.language)
        chapter.status = ChapterStatus.done.value

        # 章末：滚动摘要 + 角色状态更新
        await _summarize_chapter(llm, novel, chapter)

        counts = session.execute(
            select(Chapter.word_count).where(Chapter.novel_id == novel.id)
        ).scalars().all()
        novel.word_count = sum(counts)

        if job is not None:
            job.checkpoint = {"last_chapter": index}
            job.progress = {"chapter": index, "total": total, "words": novel.word_count}
        session.commit()

        broker.publish("chapter_done", {
            "novel_id": novel.id, "title": novel.title,
            "chapter": index, "total": total, "words": novel.word_count,
        })
        logger.info("novel=%s 第%d/%d章完成（%d字）", novel.id, index, total, chapter.word_count)

    return "done"


def _add_debt(novel: Novel, item: dict) -> None:
    debt = list(novel.quality_debt or [])
    debt.append(item)
    novel.quality_debt = debt


async def _summarize_chapter(llm: PipelineLLM, novel: Novel, chapter: Chapter) -> None:
    data = await llm.structured(
        "chapter_summary", "writing",
        system=prompts.SYSTEM_JSON,
        user=prompts.chapter_summary_prompt(
            chapter.index, chapter.content, chapter.blueprint.get("characters", [])
        ),
        ctx={"index": chapter.index, "seed": f"n{novel.id}c{chapter.index}"},
        chapter_id=chapter.id,
    )
    chapter.summary = data.get("summary", "")
    # 合并角色状态回 bible
    updates = {u.get("name"): u.get("state") for u in data.get("character_updates", []) if u.get("name")}
    if updates:
        bible = dict(novel.bible or {})
        chars = [dict(c) for c in bible.get("characters", [])]
        for c in chars:
            if c.get("name") in updates:
                c["state"] = updates[c["name"]]
        bible["characters"] = chars
        novel.bible = bible
