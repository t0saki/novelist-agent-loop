"""流水线 LLM 门面：统一真实/mock、结构化解析、用量记账。

每次调用都需传 task（供 mock 派发 + 记账阶段名）与真实 prompt（system/user）。
真实模式用 system/user；mock 模式忽略 prompt、按 task+ctx 生成。
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import Novel, UsageLedger
from app.pipeline.jsonutil import parse_json
from app.providers.base import LLMResult
from app.providers.llm import ChatClient
from app.providers.mock import MockChatClient
from app.providers.registry import resolve_chat_profiles

logger = logging.getLogger("novelist.pipeline.llm")


class PipelineLLM:
    def __init__(self, session: Session, novel_id: int | None) -> None:
        self.session = session
        self.novel_id = novel_id
        self.mock = get_settings().mock_llm
        self._chat: ChatClient | MockChatClient = (
            MockChatClient() if self.mock else ChatClient()
        )

    async def _raw(
        self,
        task: str,
        stage: str,
        *,
        system: str,
        user: str,
        ctx: dict[str, Any] | None,
        json_mode: bool,
        chapter_id: int | None,
    ) -> LLMResult:
        if self.mock:
            assert isinstance(self._chat, MockChatClient)
            result = await self._chat.complete_task(task, ctx or {})
        else:
            assert isinstance(self._chat, ChatClient)
            configs = resolve_chat_profiles(self.session, stage)
            messages = [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ]
            rf = {"type": "json_object"} if json_mode else None
            result = await self._chat.complete(configs, messages, response_format=rf)
        self._record(result, stage, chapter_id)
        return result

    async def structured(
        self,
        task: str,
        stage: str,
        *,
        system: str = "",
        user: str = "",
        ctx: dict[str, Any] | None = None,
        chapter_id: int | None = None,
        repair_attempts: int = 2,
    ) -> dict[str, Any]:
        result = await self._raw(
            task, stage, system=system, user=user, ctx=ctx,
            json_mode=True, chapter_id=chapter_id,
        )
        parsed = parse_json(result.content)
        if parsed is not None:
            return parsed
        # 真实模式下 JSON 无法解析：追加修复指令重试
        for _ in range(repair_attempts if not self.mock else 0):
            repair = await self._raw(
                task, stage,
                system=system,
                user=user + "\n\n上一次输出不是合法 JSON。请只输出一个合法的 JSON 对象，不要任何解释或代码围栏。",
                ctx=ctx, json_mode=True, chapter_id=chapter_id,
            )
            parsed = parse_json(repair.content)
            if parsed is not None:
                return parsed
        logger.error("structured task=%s stage=%s 无法解析为 JSON", task, stage)
        return {}

    async def text(
        self,
        task: str,
        stage: str,
        *,
        system: str = "",
        user: str = "",
        ctx: dict[str, Any] | None = None,
        chapter_id: int | None = None,
    ) -> str:
        result = await self._raw(
            task, stage, system=system, user=user, ctx=ctx,
            json_mode=False, chapter_id=chapter_id,
        )
        return result.content.strip()

    def _record(self, result: LLMResult, stage: str, chapter_id: int | None) -> None:
        u = result.usage
        self.session.add(UsageLedger(
            novel_id=self.novel_id,
            chapter_id=chapter_id,
            stage=stage,
            profile_id=result.profile_id,
            model=result.model,
            prompt_tokens=u.prompt_tokens,
            completion_tokens=u.completion_tokens,
            total_tokens=u.total_tokens,
            cost=result.cost,
        ))
        if self.novel_id is not None:
            novel = self.session.get(Novel, self.novel_id)
            if novel is not None:
                novel.tokens_total += u.total_tokens
                novel.cost_total += result.cost
