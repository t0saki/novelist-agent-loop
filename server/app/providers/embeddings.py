"""OpenAI 兼容 embedding 客户端（/embeddings）。"""
from __future__ import annotations

import httpx

from app.core.config import get_settings
from app.providers.base import ProviderError
from app.providers.registry import ProfileConfig


class EmbeddingClient:
    async def embed(self, cfg: ProfileConfig, texts: list[str]) -> list[list[float]]:
        timeout = get_settings().llm_timeout_seconds
        body: dict = {"model": cfg.model, "input": texts}
        body.update(cfg.extra)
        headers = {"Content-Type": "application/json"}
        if cfg.api_key:
            headers["Authorization"] = f"Bearer {cfg.api_key}"
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{cfg.base_url}/embeddings", json=body, headers=headers
            )
            if resp.status_code >= 400:
                raise ProviderError(f"embedding HTTP {resp.status_code}: {resp.text[:300]}")
            data = resp.json()
            return [row["embedding"] for row in data["data"]]
