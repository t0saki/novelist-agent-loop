"""默认配置与管理员初始化。幂等：只在缺失时写入。"""
from __future__ import annotations

import logging
import secrets

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import hash_password
from app.db.models import LlmProfile, Setting, Theme

logger = logging.getLogger("novelist.seed")

DEFAULT_SETTINGS: dict[str, object] = {
    # 限流：滑动窗口
    "rate_limit": {"books_per_day": 5, "books_per_5h": 2},
    # 预算
    "token_budget": {"daily_tokens": 5_000_000, "per_book_tokens": 800_000},
    # 同时写作的书数量
    "concurrency": 1,
    # 查重相似度阈值（余弦），高于则提示但不硬禁
    "dedup_threshold": 0.92,
    # 场景字数达标下限比例
    "scene_floor_ratio": 0.85,
    # 阶段级重试上限
    "max_job_attempts": 3,
    # 阶段 -> profile fallback 链
    "stage_profiles": {},
    # 插图密度：none / cover / every_n
    "illustration_density": "cover",
    "illustration_every_n": 5,
    # 是否自动立项新书
    "auto_generate": True,
    # 全局暂停调度
    "scheduler_paused": False,
}

EXAMPLE_THEMES = [
    {"name": "都市异能", "keywords": ["觉醒", "隐藏身份", "逆袭"],
     "style_prompt": "快节奏，爽感强，现代都市背景", "length_hint": "中篇", "weight": 1.0},
    {"name": "玄幻修仙", "keywords": ["宗门", "天才", "复仇", "机缘"],
     "style_prompt": "宏大世界观，境界体系清晰", "length_hint": "长篇", "weight": 1.0},
    {"name": "悬疑推理", "keywords": ["密室", "反转", "人性"],
     "style_prompt": "冷峻克制，线索缜密", "length_hint": "短篇", "weight": 0.8},
]


def _get(session: Session, key: str):
    return session.get(Setting, key)


def seed_defaults(session: Session) -> None:
    for key, value in DEFAULT_SETTINGS.items():
        if _get(session, key) is None:
            session.add(Setting(key=key, value=value))
    # 首次无题材则播种示例题材（方便试跑；管理员可删）
    count = session.execute(select(func.count()).select_from(Theme)).scalar_one()
    if count == 0:
        for t in EXAMPLE_THEMES:
            session.add(Theme(**t))
    session.commit()


def ensure_admin(session: Session, plain_password: str | None = None) -> str | None:
    """确保管理员密码存在。返回新生成的明文密码（若是随机生成），否则 None。"""
    if _get(session, "admin_password_hash") is not None and not plain_password:
        return None
    settings = get_settings()
    pw = plain_password or settings.admin_password or secrets.token_urlsafe(12)
    row = _get(session, "admin_password_hash")
    if row is None:
        session.add(Setting(key="admin_password_hash", value=hash_password(pw)))
    else:
        row.value = hash_password(pw)
    session.commit()
    if not plain_password and not settings.admin_password:
        logger.warning("已生成随机管理员密码：%s（请尽快登录修改）", pw)
        return pw
    return None
