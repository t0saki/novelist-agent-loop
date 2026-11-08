"""脚本化假 LLM：零成本跑通全流水线，并可模拟「偷懒」以测试长度控制。

按 task 派发生成对应结构；scene 任务在 attempt 0 故意写短（触发一次扩写循环），
attempt>=1 写足目标，从而验证「确定性字数校验 + 重写循环」会收敛。
"""
from __future__ import annotations

import hashlib
from typing import Any

from app.providers.base import LLMResult, Usage

_SENTENCES = [
    "夜色像一块浸了墨的绸缎，缓缓覆在城墙之上",
    "他握紧手中的剑，指节因用力而泛白",
    "风从长街尽头卷来，带着雨后泥土与铁锈的气味",
    "她没有回头，只是把披风裹得更紧了一些",
    "远处的钟声一下一下地敲，像是替谁数着最后的时辰",
    "灯火在窗纸后摇曳，映出两道交叠又分开的人影",
    "他忽然明白，有些话一旦说出口，便再也收不回来了",
    "血珠顺着刀锋滑落，在青石板上砸出一朵暗红的花",
    "记忆如潮水般涌来，把他淹没在十年前那个雪夜",
    "她笑了笑，那笑意却没能抵达眼底",
    "空气骤然凝滞，连呼吸都成了一种冒犯",
    "命运的齿轮在此刻悄然咬合，发出细不可闻的一声轻响",
    "他知道自己没有退路，可他从未想过退路",
    "月光漫过窗棂，把整间屋子浸成一片清冷的银白",
    "那道身影在长廊尽头停住，仿佛在等一个注定不会来的人",
    "话音落下的刹那，满座皆惊",
]


def _rng(seed: str) -> int:
    return int(hashlib.sha256(seed.encode()).hexdigest(), 16)


def _pick(seed: str, options: list) -> Any:
    return options[_rng(seed) % len(options)]


def _zh_filler(target_chars: int, seed: str) -> str:
    """拼接中文句子直到达到目标汉字数，分段输出。"""
    out: list[str] = []
    para: list[str] = []
    count = 0
    i = 0
    while count < target_chars:
        s = _SENTENCES[_rng(f"{seed}:{i}") % len(_SENTENCES)]
        para.append(s)
        count += len(s)
        i += 1
        if len(para) >= 3 + (_rng(f"{seed}:p:{i}") % 3):
            out.append("　　" + "，".join(para) + "。")
            para = []
    if para:
        out.append("　　" + "，".join(para) + "。")
    return "\n\n".join(out)


def _count_zh(text: str) -> int:
    return sum(1 for c in text if "一" <= c <= "鿿")


class MockChatClient:
    """与真实 ChatClient 接口一致，但用 task/ctx 派发脚本化输出。"""

    async def complete_task(
        self, task: str, ctx: dict[str, Any] | None = None
    ) -> LLMResult:
        ctx = ctx or {}
        content = self._dispatch(task, ctx)
        usage = Usage(
            prompt_tokens=200,
            completion_tokens=max(50, _count_zh(content) or len(content) // 2),
        )
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
        return LLMResult(content=content, usage=usage, model="mock", profile_id=None, cost=0.0)

    def _dispatch(self, task: str, ctx: dict[str, Any]) -> str:
        import json

        seed = ctx.get("seed", task)
        if task == "premise_candidates":
            kw = ctx.get("keywords", ["江湖", "复仇"])
            cands = []
            for i in range(3):
                cands.append({
                    "title": f"{_pick(f'{seed}:{i}:t', ['孤','逆','血','夜','剑'])}"
                             f"{_pick(f'{seed}:{i}:t2', ['影','途','诺','city','归途'])}",
                    "logline": f"围绕「{kw[i % len(kw)]}」展开的一段命运纠葛。",
                    "selling_point": "反转密集，情绪浓烈。",
                })
            return json.dumps({"candidates": cands}, ensure_ascii=False)

        if task == "concept":
            length_class = ctx.get("length_class", "short")
            chapters = {"short": 3, "medium": 12, "long": 40, "epic": 120}.get(length_class, 3)
            return json.dumps({
                "title": ctx.get("title", "无名之刃"),
                "synopsis": "一个背负旧仇的浪人，在追寻真相的路上逐渐揭开笼罩全城的阴谋。",
                "tone": "冷峻、宿命",
                "audience": "偏爱硬核情节的成年读者",
                "planned_chapters": chapters,
                "target_chapter_words": 3000,
                "volumes": [{"title": "第一卷 暗涌", "chapter_count": chapters}],
            }, ensure_ascii=False)

        if task == "bible":
            return json.dumps({
                "world": "架空的九州大陆，武力与权谋交织。",
                "characters": [
                    {"name": "沈约", "role": "主角", "description": "沉默寡言的浪人",
                     "motivation": "为灭门之仇追凶", "relationships": "与故人之女苏晚有旧",
                     "state": "初入城，身份未明"},
                    {"name": "苏晚", "role": "关键配角", "description": "药铺女掌柜",
                     "motivation": "守护家族秘密", "relationships": "沈约旧识",
                     "state": "对沈约存有戒心"},
                ],
                "canon": ["主角左肩有旧伤", "全城由四大家族暗中把持"],
                "voice": {"pov": "第三人称限制视角", "style": "短句为主，画面感强"},
                "foreshadowing": [{"item": "沈约的旧伤来历", "plant_hint": "早期埋设", "payoff_hint": "结局揭示"}],
            }, ensure_ascii=False)

        if task == "chapter_blueprints":
            start = ctx.get("start", 1)
            count = ctx.get("count", 1)
            total = ctx.get("total", count)
            chapters = []
            for k in range(count):
                idx = start + k
                is_final = idx >= total
                chapters.append({
                    "index": idx,
                    "title": f"第{idx}章 {_pick(f'{seed}:{idx}:ct', ['夜行','故人','杀机','迷局','抉择'])}",
                    "goal": f"推进主线第 {idx} 步：揭露一条线索并引出新的冲突。",
                    "characters": ["沈约", "苏晚"],
                    "foreshadow_plant": "留下一处可供后续回收的细节" if not is_final else "",
                    "foreshadow_payoff": "回收此前伏笔" if is_final else "",
                    "scenes": [
                        {"summary": "开场情境铺陈与人物登场", "must_happen": "确立本章处境",
                         "characters": ["沈约"], "target_words": 1000},
                        {"summary": "冲突升级与信息揭露", "must_happen": "推进主线一步",
                         "characters": ["沈约", "苏晚"], "target_words": 1200},
                        {"summary": "本章收束并留下钩子", "must_happen": "抛出悬念" if not is_final else "收束全书",
                         "characters": ["沈约"], "target_words": 900},
                    ],
                    "hook": "" if is_final else "一个意外的访客出现在门外。",
                    "is_final": is_final,
                })
            return json.dumps({"chapters": chapters}, ensure_ascii=False)

        if task == "scene":
            target = int(ctx.get("target_words", 900))
            attempt = int(ctx.get("attempt", 0))
            is_final_scene = ctx.get("is_final_scene", False)
            is_final_chapter = ctx.get("is_final_chapter", False)
            # 模拟偷懒：首轮写到 ~70%，触发一次扩写；扩写轮写足 ~115%
            ratio = 0.7 if attempt == 0 else 1.15
            body = _zh_filler(int(target * ratio), f"{seed}:scene:{attempt}")
            if ctx.get("simulate_premature_end") and attempt == 0 and not is_final_chapter:
                body += "\n\n　　全书完。"  # 故意的越界完结，供完结检测测试
            elif is_final_scene and is_final_chapter:
                body += "\n\n　　（全书完）"
            return body

        if task == "chapter_summary":
            idx = ctx.get("index", 1)
            return json.dumps({
                "summary": f"第{idx}章：主角推进了调查，与关键人物的关系发生微妙变化，留下新的悬念。",
                "character_updates": [{"name": "沈约", "state": f"完成第{idx}章目标，掌握新线索"}],
                "foreshadow_updates": [],
            }, ensure_ascii=False)

        if task == "review":
            return json.dumps({
                "consistency_issues": [],
                "style_issues": [],
                "verdict": "pass",
            }, ensure_ascii=False)

        if task == "book_synopsis":
            return "一部关于复仇、真相与救赎的故事，主角在层层阴谋中走向宿命的终点。"

        if task == "cover_prompt":
            return "A lone swordsman standing on ancient city walls at night, moody cinematic lighting, ink-wash style, dramatic composition"

        return "{}"


class MockEmbeddingClient:
    """确定性哈希向量，用于查重逻辑的离线测试。"""

    dim = 64

    async def embed(self, texts: list[str]) -> list[list[float]]:
        vecs = []
        for t in texts:
            h = hashlib.sha256(t.encode()).digest()
            # 用文本里的字符扩展成稳定向量
            base = [((h[i % len(h)] + ord(c)) % 97) / 97.0 for i, c in enumerate(t[: self.dim])]
            base = (base + [0.0] * self.dim)[: self.dim]
            vecs.append(base)
        return vecs


class MockImageClient:
    async def generate(self, prompt: str, size: str = "1024x1536") -> bytes:
        # 返回一个 1x1 PNG 占位（真实实现见 images.py）
        import base64
        png_b64 = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
            "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        )
        return base64.b64decode(png_b64)
