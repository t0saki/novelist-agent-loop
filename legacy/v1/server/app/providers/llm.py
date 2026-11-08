"""OpenAI 兼容 chat 客户端：工具调用、fallback 链、用量与成本。

对外只暴露 complete()；结构化 JSON 解析、任务派发在 pipeline 层封装。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from app.core.config import get_settings
from app.providers.base import LLMResult, ProviderError, Usage
from app.providers.registry import ProfileConfig

logger = logging.getLogger("novelist.llm")


def _cost(cfg: ProfileConfig, usage: Usage) -> float:
    return (
        usage.prompt_tokens * cfg.price_prompt_per_mtok / 1_000_000
        + usage.completion_tokens * cfg.price_completion_per_mtok / 1_000_000
    )


class ChatClient:
    """真实 OpenAI 兼容后端。给定 profile fallback 链，逐个尝试直到成功。"""

    def __init__(self, retries_per_profile: int = 5) -> None:
        self.retries = retries_per_profile

    async def complete(
        self,
        configs: list[ProfileConfig],
        messages: list[dict[str, Any]],
        *,
        tools: list[dict] | None = None,
        response_format: dict | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> LLMResult:
        if not configs:
            raise ProviderError("没有可用的 chat profile，请先在管理端配置模型。")

        last_err: Exception | None = None
        timeout = get_settings().llm_timeout_seconds
        async with httpx.AsyncClient(timeout=timeout) as client:
            for cfg in configs:
                for attempt in range(self.retries):
                    try:
                        return await self._call(
                            client, cfg, messages, tools, response_format,
                            temperature, max_tokens,
                        )
                    except (httpx.HTTPError, ProviderError, KeyError) as e:
                        last_err = e
                        # 限流（429）/网关错误（5xx）退避更久，避免继续冲击代理
                        msg = str(e)
                        throttled = "429" in msg or "502" in msg or "503" in msg or "504" in msg
                        wait = min(30.0, (6.0 if throttled else 1.5) * (attempt + 1))
                        logger.warning(
                            "chat profile=%s attempt=%d failed: %s (retry in %.1fs)",
                            cfg.name, attempt, e, wait,
                        )
                        await asyncio.sleep(wait)
        raise ProviderError(f"所有 profile 均失败：{last_err}")

    async def _call(
        self,
        client: httpx.AsyncClient,
        cfg: ProfileConfig,
        messages: list[dict[str, Any]],
        tools: list[dict] | None,
        response_format: dict | None,
        temperature: float | None,
        max_tokens: int | None,
    ) -> LLMResult:
        body: dict[str, Any] = {
            "model": cfg.model,
            "messages": messages,
            "temperature": cfg.temperature if temperature is None else temperature,
            # 显式非流式：部分 OpenAI 兼容代理默认返回 SSE 流，会破坏 resp.json()
            "stream": False,
        }
        mt = max_tokens if max_tokens is not None else cfg.max_tokens
        if mt:
            body["max_tokens"] = mt
        if tools and cfg.supports_tools:
            body["tools"] = tools
        if response_format:
            body["response_format"] = response_format
        body.update(cfg.extra)

        headers = {"Content-Type": "application/json"}
        if cfg.api_key:
            headers["Authorization"] = f"Bearer {cfg.api_key}"

        resp = await client.post(
            f"{cfg.base_url}/chat/completions", json=body, headers=headers
        )
        if resp.status_code >= 400:
            raise ProviderError(f"HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        choice = data["choices"][0]
        msg = choice.get("message", {})
        u = data.get("usage", {}) or {}
        usage = Usage(
            prompt_tokens=u.get("prompt_tokens", 0),
            completion_tokens=u.get("completion_tokens", 0),
            total_tokens=u.get("total_tokens", 0),
        )
        return LLMResult(
            content=msg.get("content") or "",
            tool_calls=msg.get("tool_calls") or [],
            usage=usage,
            model=cfg.model,
            profile_id=cfg.id,
            cost=_cost(cfg, usage),
        )
