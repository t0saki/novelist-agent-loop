"""登录：管理员密码 / 只读密码，返回签名 token。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_identity, db_session
from app.core.security import create_token, verify_password
from app.db.models import ReaderPassword, Setting

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    password: str


class LoginOut(BaseModel):
    token: str
    role: str
    identity: str


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, session: Session = Depends(db_session)) -> LoginOut:
    # 先试管理员
    admin_row = session.get(Setting, "admin_password_hash")
    if admin_row and verify_password(body.password, admin_row.value):
        return LoginOut(token=create_token("admin", "admin"), role="admin", identity="admin")
    # 再试只读密码
    readers = session.execute(
        select(ReaderPassword).where(ReaderPassword.enabled.is_(True))
    ).scalars().all()
    for r in readers:
        if verify_password(body.password, r.password_hash):
            ident = f"reader:{r.id}"
            return LoginOut(token=create_token("reader", ident), role="reader", identity=ident)
    raise HTTPException(401, "密码错误")


@router.get("/me")
def me(identity: dict = Depends(current_identity)) -> dict:
    return {"role": identity.get("role"), "identity": identity.get("id")}
