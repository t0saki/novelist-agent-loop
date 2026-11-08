"""从 DB 解析「阶段 -> 模型 profile（含 fallback 链）」。

settings['stage_profiles'] 形如 {"writing": [3, 1], "outline": [2]}，
值是 profile id 的 fallback 顺序。未配置的阶段回退到默认 chat profile。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import LlmProfile, ProfileKind, Setting


@dataclass
class ProfileConfig:
    id: int
    name: str
    kind: str
    base_url: str
    api_key: str
    model: str
    temperature: float
    max_tokens: int | None
    price_prompt_per_mtok: float
    price_completion_per_mtok: float
    supports_tools: bool
    extra: dict[str, Any] = field(default_factory=dict)


def _to_config(p: LlmProfile) -> ProfileConfig:
    return ProfileConfig(
        id=p.id,
        name=p.name,
        kind=p.kind,
        base_url=p.base_url.rstrip("/"),
        api_key=p.api_key,
        model=p.model,
        temperature=p.temperature,
        max_tokens=p.max_tokens,
        price_prompt_per_mtok=p.price_prompt_per_mtok,
        price_completion_per_mtok=p.price_completion_per_mtok,
        supports_tools=p.supports_tools,
        extra=p.extra or {},
    )


def _get_setting(session: Session, key: str, default: Any = None) -> Any:
    row = session.get(Setting, key)
    return row.value if row is not None else default


def resolve_chat_profiles(session: Session, stage: str) -> list[ProfileConfig]:
    """返回某阶段的 chat profile fallback 链（至少一个，否则空）。"""
    mapping: dict[str, list[int]] = _get_setting(session, "stage_profiles", {}) or {}
    ids = mapping.get(stage) or []
    configs: list[ProfileConfig] = []
    for pid in ids:
        p = session.get(LlmProfile, pid)
        if p and p.enabled and p.kind == ProfileKind.chat.value:
            configs.append(_to_config(p))
    if configs:
        return configs
    # 回退：默认 chat profile，再退到任意启用的 chat profile
    default = session.execute(
        select(LlmProfile).where(
            LlmProfile.kind == ProfileKind.chat.value,
            LlmProfile.enabled.is_(True),
            LlmProfile.is_default.is_(True),
        )
    ).scalar_one_or_none()
    if default:
        return [_to_config(default)]
    any_chat = session.execute(
        select(LlmProfile).where(
            LlmProfile.kind == ProfileKind.chat.value, LlmProfile.enabled.is_(True)
        ).order_by(LlmProfile.id)
    ).scalars().first()
    return [_to_config(any_chat)] if any_chat else []


def resolve_kind_profile(session: Session, kind: str) -> ProfileConfig | None:
    """取某类别（image/embedding）第一个启用的 profile。"""
    p = session.execute(
        select(LlmProfile).where(
            LlmProfile.kind == kind, LlmProfile.enabled.is_(True)
        ).order_by(LlmProfile.is_default.desc(), LlmProfile.id)
    ).scalars().first()
    return _to_config(p) if p else None
