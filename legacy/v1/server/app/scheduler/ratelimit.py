"""限流与预算：滑动窗口本数 + 日 token 预算 + 单本上限。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Novel, Setting, UsageLedger


def _get(session: Session, key: str, default):
    row = session.get(Setting, key)
    return row.value if row is not None else default


def _now() -> datetime:
    return datetime.now(timezone.utc)


def books_created_since(session: Session, hours: float) -> int:
    since = _now() - timedelta(hours=hours)
    return session.execute(
        select(func.count()).select_from(Novel).where(Novel.created_at >= since)
    ).scalar_one()


def tokens_used_since(session: Session, hours: float) -> int:
    since = _now() - timedelta(hours=hours)
    return session.execute(
        select(func.coalesce(func.sum(UsageLedger.total_tokens), 0)).where(
            UsageLedger.created_at >= since
        )
    ).scalar_one()


def rate_limit_status(session: Session) -> dict:
    rl = _get(session, "rate_limit", {}) or {}
    per_day = int(rl.get("books_per_day", 0) or 0)
    per_5h = int(rl.get("books_per_5h", 0) or 0)
    day_count = books_created_since(session, 24)
    h5_count = books_created_since(session, 5)
    return {
        "books_per_day": per_day, "books_today": day_count,
        "books_per_5h": per_5h, "books_last_5h": h5_count,
        "day_ok": per_day == 0 or day_count < per_day,
        "h5_ok": per_5h == 0 or h5_count < per_5h,
    }


def can_start_new_book(session: Session) -> bool:
    """限流窗口是否允许再立项一本（0 表示不限）。"""
    s = rate_limit_status(session)
    return s["day_ok"] and s["h5_ok"] and daily_budget_ok(session)


def daily_budget_ok(session: Session) -> bool:
    budget = _get(session, "token_budget", {}) or {}
    daily = int(budget.get("daily_tokens", 0) or 0)
    if daily <= 0:
        return True
    return tokens_used_since(session, 24) < daily


def per_book_over(session: Session, novel: Novel) -> bool:
    budget = _get(session, "token_budget", {}) or {}
    cap = int(budget.get("per_book_tokens", 0) or 0)
    if cap <= 0:
        return False
    return novel.tokens_total >= cap


def budget_snapshot(session: Session) -> dict:
    budget = _get(session, "token_budget", {}) or {}
    daily = int(budget.get("daily_tokens", 0) or 0)
    used = tokens_used_since(session, 24)
    return {
        "daily_tokens": daily,
        "tokens_today": used,
        "per_book_tokens": int(budget.get("per_book_tokens", 0) or 0),
        "daily_ok": daily == 0 or used < daily,
    }
