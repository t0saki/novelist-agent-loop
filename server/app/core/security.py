"""密码哈希与会话令牌。

- 密码：pbkdf2_hmac(sha256)，stdlib，无需编译型依赖。
- 会话：HMAC 签名的无状态 token（role + identity + 过期时间），避免会话表。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from pathlib import Path

from app.core.config import get_settings

_PBKDF2_ROUNDS = 200_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2${_PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, rounds_s, salt_hex, dk_hex = stored.split("$")
        if scheme != "pbkdf2":
            return False
        rounds = int(rounds_s)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(dk_hex)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, rounds)
        return hmac.compare_digest(dk, expected)
    except (ValueError, AttributeError):
        return False


# ---------- 会话 token ----------

def _secret() -> bytes:
    settings = get_settings()
    if settings.session_secret:
        return settings.session_secret.encode()
    # 持久化随机密钥到 data 目录，重启后会话不失效
    f: Path = settings.secret_file
    if f.exists():
        return f.read_bytes()
    key = secrets.token_bytes(32)
    f.write_bytes(key)
    return key


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def create_token(role: str, identity: str) -> str:
    """role: 'admin' | 'reader'；identity: reader 密码标签或 'admin'。"""
    settings = get_settings()
    payload = {
        "role": role,
        "id": identity,
        "exp": int(time.time()) + settings.session_ttl_hours * 3600,
    }
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64e(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_token(token: str) -> dict | None:
    try:
        body, sig = token.split(".")
        expected = _b64e(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_b64d(body))
        if payload.get("exp", 0) < int(time.time()):
            return None
        return payload
    except (ValueError, KeyError, json.JSONDecodeError):
        return None
