"""OpenAI 兼容图像客户端（/images/generations）。返回 PNG/JPEG 字节。"""
from __future__ import annotations

import base64

import httpx

from app.core.config import get_settings
from app.providers.base import ProviderError
from app.providers.registry import ProfileConfig


class ImageClient:
    async def generate(self, cfg: ProfileConfig, prompt: str, size: str = "1024x1536") -> bytes:
        timeout = get_settings().llm_timeout_seconds
        body: dict = {
            "model": cfg.model,
            "prompt": prompt,
            "n": 1,
            "size": size,
        }
        body.update(cfg.extra)
        headers = {"Content-Type": "application/json"}
        if cfg.api_key:
            headers["Authorization"] = f"Bearer {cfg.api_key}"
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{cfg.base_url}/images/generations", json=body, headers=headers
            )
            if resp.status_code >= 400:
                raise ProviderError(f"image HTTP {resp.status_code}: {resp.text[:300]}")
            data = resp.json()
            item = data["data"][0]
            if item.get("b64_json"):
                return base64.b64decode(item["b64_json"])
            if item.get("url"):
                img = await client.get(item["url"])
                img.raise_for_status()
                return img.content
        raise ProviderError("图像响应中既无 b64_json 也无 url")
