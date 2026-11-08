"""mock 模式下的流水线与长度控制测试。"""
from sqlalchemy import select

from app.db.database import session_scope
from app.db.models import Chapter, Novel, NovelStatus, Theme
from app.pipeline.engine import PipelineEngine
from app.pipeline.length import (
    count_words,
    has_ending_marker,
    scene_ok,
)
from app.pipeline.stages.planning import _length_class
from app.providers.mock import MockChatClient
from app.services.novels import create_novel_with_job


async def _run_new_book(theme_name: str) -> int:
    with session_scope() as s:
        theme = s.execute(select(Theme).where(Theme.name == theme_name)).scalar_one()
        novel, job = create_novel_with_job(s, theme)
        novel_id, job_id = novel.id, job.id
    status = await PipelineEngine().run_job(job_id)
    assert status == "done"
    return novel_id


async def test_full_pipeline_completes():
    novel_id = await _run_new_book("悬疑推理")
    with session_scope() as s:
        novel = s.get(Novel, novel_id)
        chapters = s.execute(
            select(Chapter).where(Chapter.novel_id == novel_id).order_by(Chapter.index)
        ).scalars().all()
        assert novel.status == NovelStatus.completed.value
        assert len(chapters) == novel.planned_chapters
        assert all(c.word_count > 0 for c in chapters)
        assert novel.word_count == sum(c.word_count for c in chapters)


async def test_length_control_reaches_target():
    """每章应达到接近目标字数（逐场景 + 扩写循环生效）。"""
    novel_id = await _run_new_book("玄幻修仙")
    with session_scope() as s:
        chapters = s.execute(
            select(Chapter).where(Chapter.novel_id == novel_id)
        ).scalars().all()
        for c in chapters:
            targets = sum(sc.get("target_words", 0) for sc in c.blueprint.get("scenes", []))
            # 场景达标下限 0.85，整章应 >= 目标和的 0.85
            assert c.word_count >= targets * 0.85, f"第{c.index}章偏短 {c.word_count}/{targets}"


async def test_no_premature_ending_in_non_final_chapters():
    novel_id = await _run_new_book("悬疑推理")
    with session_scope() as s:
        novel = s.get(Novel, novel_id)
        chapters = s.execute(
            select(Chapter).where(Chapter.novel_id == novel_id).order_by(Chapter.index)
        ).scalars().all()
        for c in chapters:
            if c.index < novel.planned_chapters:
                assert not has_ending_marker(c.content), f"第{c.index}章出现越界完结语"


def test_completion_detector_strips_premature_ending():
    """写作循环的完结剥离逻辑：非末章的完结语应被去除。"""
    from app.pipeline.stages.writing import _strip_ending
    assert "全书完" not in _strip_ending("正文内容\n\n全书完")
    assert _strip_ending("正文内容\n\n全书完").startswith("正文内容")


def test_length_helpers():
    assert count_words("你好世界，hello", "zh") == 4
    assert has_ending_marker("……全书完")
    assert not has_ending_marker("他继续前行")
    assert scene_ok("字" * 90, 100, "zh", 0.85)
    assert not scene_ok("字" * 50, 100, "zh", 0.85)


async def test_mock_scene_expands_on_retry():
    """直接验证 mock：attempt0 偏短、attempt1 达标。"""
    mock = MockChatClient()
    ctx = {"target_words": 1000, "attempt": 0, "seed": "t"}
    short = (await mock.complete_task("scene", ctx)).content
    ctx["attempt"] = 1
    long = (await mock.complete_task("scene", ctx)).content
    assert count_words(short) < count_words(long)
    assert count_words(long) >= 1000 * 0.85


def test_length_class():
    assert _length_class(Theme(length_hint="超长篇连载")) == "epic"
    assert _length_class(Theme(length_hint="短篇")) == "short"
    assert _length_class(None) == "short"
