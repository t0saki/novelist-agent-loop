"""长度控制与反偷懒的确定性校验（不依赖模型自评）。"""
from __future__ import annotations

import re

# 完结/快进类语气标记：非末章出现即判为「提前收尾」
_ENDING_MARKERS = [
    "全书完", "全文完", "（完）", "(完)", "剧终", "本书完",
    "故事到此结束", "the end", "全书终",
]
_FASTFORWARD_MARKERS = [
    "此处省略", "一笔带过", "不再赘述", "略过不表",
]

_CJK = re.compile(r"[一-鿿]")


def count_words(text: str, language: str = "zh") -> int:
    """中文按汉字计；其他语言按空白分词计。"""
    if language == "zh":
        return len(_CJK.findall(text))
    return len(text.split())


def has_ending_marker(text: str) -> bool:
    low = text.lower()
    return any(m.lower() in low for m in _ENDING_MARKERS)


def has_fastforward_marker(text: str) -> bool:
    return any(m in text for m in _FASTFORWARD_MARKERS)


def repetition_ratio(text: str) -> float:
    """按句去重，返回重复句占比（粗略的注水/复读检测）。"""
    sentences = [s.strip() for s in re.split(r"[。！？\n]", text) if len(s.strip()) > 6]
    if not sentences:
        return 0.0
    unique = len(set(sentences))
    return 1.0 - unique / len(sentences)


def scene_ok(text: str, target_words: int, language: str, floor_ratio: float = 0.85) -> bool:
    """场景是否达标：字数 >= 目标*floor_ratio。"""
    return count_words(text, language) >= int(target_words * floor_ratio)
