"""鉴权依赖：Bearer token -> 角色。admin 可访问一切，reader 仅只读。"""
from __future__ import annotations

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import verify_token
from app.db.database import get_db


def _token_from_header(authorization: str | None) -> dict | None:
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return verify_token(parts[1])
    return None


def current_identity(authorization: str | None = Header(default=None)) -> dict:
    payload = _token_from_header(authorization)
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "未登录或会话已过期")
    return payload


def require_reader(identity: dict = Depends(current_identity)) -> dict:
    if identity.get("role") not in ("reader", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "无阅读权限")
    return identity


def require_admin(identity: dict = Depends(current_identity)) -> dict:
    if identity.get("role") != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "需要管理员权限")
    return identity


def db_session() -> Session:  # 便于类型标注
    yield from get_db()
