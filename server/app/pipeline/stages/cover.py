"""封面 / 插图流水线（独立 job，成书后触发，失败不影响可读性）。"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import Chapter, Image, Novel, Setting
from app.pipeline import prompts
from app.pipeline.llm import PipelineLLM
from app.providers.images import ImageClient
from app.providers.mock import MockImageClient
from app.providers.registry import resolve_kind_profile

logger = logging.getLogger("novelist.pipeline.cover")


def _get(session: Session, key: str, default=None):
    row = session.get(Setting, key)
    return row.value if row is not None else default


def image_pipeline_enabled(session: Session) -> bool:
    """density != none 且配置了 image profile（mock 模式恒可用）。"""
    density = _get(session, "illustration_density", "cover")
    if density == "none":
        return False
    if get_settings().mock_llm:
        return True
    return resolve_kind_profile(session, "image") is not None


async def _gen_image(session: Session, prompt: str, size: str) -> bytes | None:
    if get_settings().mock_llm:
        return await MockImageClient().generate(prompt, size)
    cfg = resolve_kind_profile(session, "image")
    if not cfg:
        return None
    try:
        return await ImageClient().generate(cfg, prompt, size)
    except Exception as e:  # noqa: BLE001
        logger.warning("图像生成失败：%s", e)
        return None


# 图像生成的硬性 SFW 后缀：即便小说是成人向，封面/插图始终保持全年龄安全
_SFW_SUFFIX = ", SFW, safe for work, tasteful, fully clothed, no nudity, no sexual content, no explicit content, atmospheric illustration"


async def run_cover_job(session: Session, llm: PipelineLLM, novel: Novel) -> None:
    settings = get_settings()
    settings.ensure_dirs()

    # 封面
    cover_prompt = await llm.text(
        "cover_prompt", "cover",
        system=prompts.SYSTEM_BASE,
        user=prompts.cover_prompt_prompt(novel.title, novel.synopsis, novel.tone),
        ctx={"seed": f"n{novel.id}"},
    )
    data = await _gen_image(session, cover_prompt + _SFW_SUFFIX, "1024x1536")
    if data:
        path = settings.covers_dir / f"{novel.slug}.png"
        path.write_bytes(data)
        novel.cover_path = str(path)
        session.add(Image(novel_id=novel.id, kind="cover", path=str(path), prompt=cover_prompt))
        logger.info("novel=%s 封面已生成", novel.id)

    # 插图（按密度）
    density = _get(session, "illustration_density", "cover")
    if density == "every_n":
        every = int(_get(session, "illustration_every_n", 5) or 5)
        chapters = session.execute(
            select(Chapter).where(Chapter.novel_id == novel.id).order_by(Chapter.index)
        ).scalars().all()
        for c in chapters:
            if c.index % every != 0:
                continue
            illo_prompt = f"Illustration for chapter '{c.title}': {c.summary}. Cinematic, atmospheric."
            img = await _gen_image(session, illo_prompt + _SFW_SUFFIX, "1024x1024")
            if img:
                p = settings.illustrations_dir / f"{novel.slug}-{c.index}.png"
                p.write_bytes(img)
                session.add(Image(novel_id=novel.id, chapter_id=c.id, kind="illustration",
                                  path=str(p), prompt=illo_prompt))
