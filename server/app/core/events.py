"""进程内 SSE 事件广播。

调度器/流水线在同一事件循环里 publish 进度事件，管理端 SSE 端点 subscribe。
纯内存、单进程，符合单容器部署形态。
"""
from __future__ import annotations

import asyncio
import json
from typing import Any


class EventBroker:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()

    def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subscribers.discard(q)

    def publish(self, event: str, data: dict[str, Any]) -> None:
        """非阻塞广播；订阅者队列满则丢弃最旧（进度事件可丢）。"""
        payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        for q in list(self._subscribers):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass


broker = EventBroker()
