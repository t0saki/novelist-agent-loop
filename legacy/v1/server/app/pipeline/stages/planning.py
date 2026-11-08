"""规划阶段：选题 → 构思 → 设定集 → 分层大纲。

产出全部固化到 Novel 上，成为后续写作阶段的硬约束。
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import Novel, NovelEmbedding, Setting, Theme
from app.pipeline import prompts
from app.pipeline.context import outline_context
from app.pipeline.llm import PipelineLLM
from app.providers.base import cosine
from app.providers.embeddings import EmbeddingClient
from app.providers.mock import MockEmbeddingClient
from app.providers.registry import resolve_kind_profile

logger = logging.getLogger("novelist.pipeline.planning")

_BLUEPRINT_BATCH = 8  # 每批细化的章数（超长篇动态细化）


def _length_class(theme: Theme | None) -> str:
    hint = (theme.length_hint if theme else "") or ""
    for key, cls in (("超长", "epic"), ("长篇", "long"), ("中篇", "medium"), ("短篇", "short")):
        if key in hint:
            return cls
    return "short"


async def _embed(session: Session, texts: list[str]) -> list[list[float]] | None:
    """返回向量；无 embedding 能力则 None。mock 模式用确定性假向量。"""
    if get_settings().mock_llm:
        return await MockEmbeddingClient().embed(texts)
    cfg = resolve_kind_profile(session, "embedding")
    if not cfg:
        return None
    try:
        return await EmbeddingClient().embed(cfg, texts)
    except Exception as e:  # noqa: BLE001
        logger.warning("embedding 失败，跳过查重：%s", e)
        return None


def _get_setting(session: Session, key: str, default):
    row = session.get(Setting, key)
    return row.value if row is not None else default


async def stage_ideation(session: Session, llm: PipelineLLM, novel: Novel) -> None:
    theme = session.get(Theme, novel.theme_id) if novel.theme_id else None
    keywords = (theme.keywords if theme else []) or []
    style = (theme.style_prompt if theme else "") or ""
    recent = session.execute(
        select(Novel.title).order_by(Novel.id.desc()).limit(20)
    ).scalars().all()

    data = await llm.structured(
        "premise_candidates", "ideation",
        system=prompts.SYSTEM_JSON,
        user=prompts.premise_prompt(theme.name if theme else "自由发挥", keywords, style, recent),
        ctx={"keywords": keywords or ["命运", "抉择"], "seed": f"n{novel.id}"},
    )
    candidates = data.get("candidates") or [{"title": "无题", "logline": "一个待展开的故事。", "selling_point": ""}]

    # 查重：对候选 logline 取向量，与历史 premise 向量比较，选最不相似的
    threshold = float(_get_setting(session, "dedup_threshold", 0.92) or 0.92)
    loglines = [c.get("logline", "") for c in candidates]
    vecs = await _embed(session, loglines)
    chosen_idx = 0
    chosen_vec: list[float] | None = None
    if vecs:
        existing = session.execute(select(NovelEmbedding.vector)).scalars().all()
        best_score = 2.0
        for i, v in enumerate(vecs):
            max_sim = max((cosine(v, e) for e in existing), default=0.0)
            if max_sim < best_score:
                best_score, chosen_idx = max_sim, i
        chosen_vec = vecs[chosen_idx]
        if best_score > threshold:
            logger.info("novel=%s 选题与历史高度相似(%.2f)，仍继续（允许重复）", novel.id, best_score)

    chosen = candidates[chosen_idx]
    novel.premise = f"{chosen.get('title','')}｜{chosen.get('logline','')}｜卖点：{chosen.get('selling_point','')}"
    novel.title = chosen.get("title") or novel.title
    if chosen_vec is not None:
        session.add(NovelEmbedding(novel_id=novel.id, kind="premise",
                                   text=chosen.get("logline", ""), vector=chosen_vec))


async def stage_concept(session: Session, llm: PipelineLLM, novel: Novel) -> None:
    theme = session.get(Theme, novel.theme_id) if novel.theme_id else None
    # 反偏短：近期产出平均字数作为软提示
    recent_words = session.execute(
        select(Novel.word_count).where(Novel.word_count > 0).order_by(Novel.id.desc()).limit(10)
    ).scalars().all()
    avg = int(sum(recent_words) / len(recent_words)) if recent_words else None

    data = await llm.structured(
        "concept", "concept",
        system=prompts.SYSTEM_JSON,
        user=prompts.concept_prompt(
            {"premise": novel.premise, "title": novel.title},
            theme.length_hint if theme else "",
            avg,
        ),
        ctx={"length_class": _length_class(theme), "title": novel.title, "seed": f"n{novel.id}"},
    )
    novel.title = data.get("title") or novel.title
    novel.synopsis = data.get("synopsis", "")
    novel.tone = data.get("tone", "")
    novel.target_audience = data.get("audience", "")
    planned = max(1, int(data.get("planned_chapters", 1) or 1))
    # 题材级兜底下限（防系统性偏短）
    if theme and theme.min_chapters:
        planned = max(planned, theme.min_chapters)
    novel.planned_chapters = planned
    novel.target_chapter_words = max(800, int(data.get("target_chapter_words", 3000) or 3000))
    novel.volumes = data.get("volumes") or [{"title": "第一卷", "chapter_count": planned}]
    novel.nsfw = novel.nsfw or bool(theme and theme.nsfw)


async def stage_bible(session: Session, llm: PipelineLLM, novel: Novel) -> None:
    data = await llm.structured(
        "bible", "bible",
        system=prompts.SYSTEM_JSON,
        user=prompts.bible_prompt(novel.title, novel.synopsis),
        ctx={"seed": f"n{novel.id}"},
    )
    novel.bible = data or {}


async def _make_blueprints(session: Session, llm: PipelineLLM, novel: Novel, start: int, count: int) -> None:
    """生成 [start, start+count) 章的细纲，存入 novel.outline['blueprints']。"""
    total = novel.planned_chapters
    count = min(count, total - start + 1)
    if count <= 0:
        return
    chars = (novel.bible or {}).get("characters", [])
    characters_block = "\n".join(
        f"- {c.get('name','')}（{c.get('role','')}）：{c.get('description','')}"
        for c in chars
    ) or "（设定集未提供角色，请据简介自拟并保持全书一致）"
    data = await llm.structured(
        "chapter_blueprints", "outline",
        system=prompts.SYSTEM_JSON,
        user=prompts.blueprint_prompt(
            novel.title, novel.synopsis, outline_context(novel),
            characters_block, start, count, total,
        ),
        ctx={"start": start, "count": count, "total": total, "seed": f"n{novel.id}"},
    )
    outline = dict(novel.outline or {})
    blueprints = dict(outline.get("blueprints", {}))
    for ch in data.get("chapters", []):
        idx = int(ch.get("index", 0))
        if start <= idx < start + count:
            blueprints[str(idx)] = ch
    outline["blueprints"] = blueprints
    novel.outline = outline


async def stage_outline(session: Session, llm: PipelineLLM, novel: Novel) -> None:
    # 记录一句主线弧光（便于后续细纲上下文），并生成首批细纲
    outline = dict(novel.outline or {})
    outline.setdefault("arc", novel.synopsis)
    novel.outline = outline
    await _make_blueprints(session, llm, novel, 1, _BLUEPRINT_BATCH)


async def ensure_blueprint(session: Session, llm: PipelineLLM, novel: Novel, index: int) -> dict:
    """写作阶段按需动态细化：确保第 index 章有细纲。"""
    blueprints = (novel.outline or {}).get("blueprints", {})
    if str(index) not in blueprints:
        await _make_blueprints(session, llm, novel, index, _BLUEPRINT_BATCH)
        blueprints = (novel.outline or {}).get("blueprints", {})
    return blueprints.get(str(index), {})
