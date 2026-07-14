"""为逐场景生成装配上下文：按出场角色裁剪设定，注入滚动摘要与前文尾部。"""
from __future__ import annotations

import json
from typing import Any

from app.db.models import Novel


def voice_str(novel: Novel) -> str:
    voice = (novel.bible or {}).get("voice", {})
    if isinstance(voice, dict):
        return f"{voice.get('pov','第三人称')}；{voice.get('style','画面感强、节奏明快')}"
    return str(voice)


def character_cards(novel: Novel, names: list[str]) -> str:
    """只取本场景出场角色的卡片 + 当前状态，省 token 又保一致。"""
    chars = (novel.bible or {}).get("characters", [])
    picked = []
    name_set = set(names)
    for c in chars:
        if not name_set or c.get("name") in name_set:
            picked.append(
                f"- {c.get('name','')}（{c.get('role','')}）：{c.get('description','')}；"
                f"动机：{c.get('motivation','')}；当前状态：{c.get('state','')}"
            )
    return "\n".join(picked) if picked else "（无特定角色约束）"


def canon_str(novel: Novel) -> str:
    canon = (novel.bible or {}).get("canon", [])
    return "; ".join(canon) if canon else "无"


def build_scene_context(
    novel: Novel,
    chapter_blueprint: dict[str, Any],
    scene_characters: list[str],
    rolling_summary: str,
) -> str:
    """组装场景生成的上下文块。"""
    parts = [
        f"【世界观】{(novel.bible or {}).get('world','')}",
        f"【硬事实】{canon_str(novel)}",
        f"【本章出场角色】\n{character_cards(novel, scene_characters)}",
        f"【前情摘要】{rolling_summary or '（故事刚开始）'}",
        f"【本章目标】{chapter_blueprint.get('goal','')}",
    ]
    plant = chapter_blueprint.get("foreshadow_plant")
    payoff = chapter_blueprint.get("foreshadow_payoff")
    if plant:
        parts.append(f"【本章需埋伏笔】{plant}")
    if payoff:
        parts.append(f"【本章需回收伏笔】{payoff}")
    return "\n".join(parts)


def outline_context(novel: Novel) -> str:
    """给细纲阶段的全书/卷纲上下文（压缩）。"""
    outline = novel.outline or {}
    volumes = novel.volumes or []
    vol_str = "; ".join(
        f"{v.get('title','')}({v.get('chapter_count','?')}章)" for v in volumes
    )
    arc = outline.get("arc") or outline.get("summary") or ""
    return f"卷划分：{vol_str}\n主线弧光：{arc}" if (vol_str or arc) else json.dumps(outline, ensure_ascii=False)[:800]
