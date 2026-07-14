"""各阶段提示词模板（中文网文口径，规划前移 + 反偷懒硬约束）。

真实模式使用这些 prompt；mock 模式忽略。所有结构化阶段要求严格 JSON。
"""
from __future__ import annotations

import json
from typing import Any

SYSTEM_BASE = (
    "你是一位高产的中文类型小说家与故事策划，擅长网络文学的强情节、快节奏与情绪张力。"
    "你只输出被要求的内容，不寒暄、不解释。"
)

SYSTEM_JSON = SYSTEM_BASE + "当被要求输出 JSON 时，只输出一个合法 JSON 对象，不要 markdown 代码围栏。"

SYSTEM_WRITER = (
    SYSTEM_BASE
    + "写正文时遵守：①用具体场景与细节展示，不要概述、不要一笔带过；"
    "②对白、动作、心理、环境交替推进；③严格贴合给定设定与前文，不制造矛盾；"
    "④除非明确告知这是最后一章，否则结尾必须留有悬念或钩子，绝不写「全书完」之类的收尾语。"
)


def premise_prompt(theme_name: str, keywords: list[str], style: str, recent_titles: list[str]) -> str:
    return (
        f"题材：{theme_name}\n关键词：{', '.join(keywords)}\n风格提示：{style}\n"
        f"近期已写作品（避免撞题）：{', '.join(recent_titles) or '无'}\n\n"
        "请头脑风暴 3 个不同方向的小说创意。输出 JSON："
        '{"candidates":[{"title":"暂定书名","logline":"一句话故事梗概","selling_point":"核心卖点/爽点"}]}'
    )


def concept_prompt(premise: dict[str, Any], length_hint: str, avg_recent_words: int | None) -> str:
    nudge = ""
    if avg_recent_words is not None and avg_recent_words < 8000:
        nudge = "（注意：近期产出普遍偏短，请规划更充实的篇幅与足够的情节容量。）"
    return (
        f"已选定创意：{json.dumps(premise, ensure_ascii=False)}\n"
        f"篇幅参考：{length_hint or '由你根据题材与情节容量自主决定'} {nudge}\n\n"
        "请据此完成立项：确定正式书名、一段 150 字左右的简介、基调、目标读者，"
        "并**自主决定**章节数与卷/幕划分（短篇 1-5 章、中篇 6-20 章、长篇 20-60 章、超长篇 60+ 章，"
        "以情节容量为准，不要为省事而压缩）。每章目标字数建议 2500-4000。输出 JSON："
        '{"title":"","synopsis":"","tone":"","audience":"","planned_chapters":整数,'
        '"target_chapter_words":整数,"volumes":[{"title":"卷名","chapter_count":整数}]}'
    )


def bible_prompt(novel_title: str, synopsis: str) -> str:
    return (
        f"书名：{novel_title}\n简介：{synopsis}\n\n"
        "请构建这部小说的设定集（story bible）。characters 必须**列全本书所有重要登场人物**"
        "（主角、关键配角、反派等，一般 5-12 人，命名具体到姓名）——这是全书唯一的权威人物表，"
        "后续大纲与正文只能使用这里定义的角色与姓名。输出 JSON："
        '{"world":"世界观与核心规则","characters":[{"name":"具体姓名","role":"主角/配角/反派",'
        '"description":"外貌性格","motivation":"核心动机","relationships":"与其他角色的关系","state":"故事开始时的处境"}],'
        '"canon":["不可违背的硬事实"],"voice":{"pov":"叙事视角","style":"文风特征"},'
        '"foreshadowing":[{"item":"伏笔","plant_hint":"何时埋","payoff_hint":"何时收"}]}'
    )


def blueprint_prompt(
    novel_title: str,
    synopsis: str,
    outline_ctx: str,
    characters_block: str,
    start: int,
    count: int,
    total: int,
) -> str:
    opening_rule = ""
    if start == 1:
        opening_rule = (
            "第 1 章是全书开篇：要循序渐进，单个场景只聚焦少数在场角色，"
            "**严禁**出现「逐一介绍所有人物」「集中登场」这类会写成流水账的场景要求；"
            "主要人物应在随后的章节里随情节自然登场。\n"
        )
    return (
        f"书名：{novel_title}\n简介：{synopsis}\n全书/卷纲：{outline_ctx}\n"
        f"【权威人物表】只能使用以下已定义角色，不得另起新名；确需新增次要角色时须保持风格一致：\n{characters_block}\n"
        f"全书共 {total} 章。请为第 {start} 到第 {start + count - 1} 章生成详细细纲。\n"
        f"{opening_rule}"
        "每章拆成 3-6 个场景，每个场景写明：概要、必须发生的事件、出场角色（从权威人物表里选，单场景不宜过多）、目标字数（600-1200）。"
        f"只有第 {total} 章是最后一章（is_final=true）可以收尾，其余章必须在 hook 里留下钩子。输出 JSON："
        '{"chapters":[{"index":整数,"title":"第N章 标题","goal":"本章主线目标",'
        '"characters":["出场角色"],"foreshadow_plant":"本章埋设的伏笔","foreshadow_payoff":"本章回收的伏笔",'
        '"scenes":[{"summary":"","must_happen":"","characters":[],"target_words":整数}],'
        '"hook":"结尾钩子","is_final":布尔}]}'
    )


def scene_prompt(
    novel_title: str,
    voice: str,
    context_block: str,
    chapter_title: str,
    scene: dict[str, Any],
    prev_tail: str,
    is_final_chapter: bool,
    is_final_scene: bool,
    is_opening: bool,
    attempt: int,
    shortfall: int | None,
) -> str:
    ending_rule = (
        "这是全书最后一章的最后一个场景，可以收束全书。"
        if (is_final_chapter and is_final_scene)
        else "这不是结尾，场景末尾要自然过渡或留有张力，绝不能出现完结语。"
    )
    opening_rule = ""
    if is_opening:
        opening_rule = (
            "\n【这是全书的第一段文字 · 冷开场】读者对这个故事一无所知。请从一个**具体的时刻与画面**切入"
            "（某个人物正在做的某件事、某个地点的此刻），用动作、对白、感官细节把读者带进场景。"
            "严禁用「通知来得突然」「他本是应邀前来」这种回溯式概述来交代背景，也不要把尚未在正文出现过的前情、"
            "身份、关系当作读者已知来陈述——这些要靠情节逐渐揭示。人物按需要一两位自然登场即可，不要在开场罗列或集中介绍多人。"
        )
    expand = ""
    if attempt > 0 and shortfall:
        expand = (
            f"\n【扩写要求】上一稿字数不足，还差约 {shortfall} 字。请在**不新增情节、不改变已发生事件**的前提下，"
            "通过增加感官细节、人物心理、对白与环境描写把本场景写足，不要复读已有句子。"
        )
    return (
        f"书名：{novel_title}\n文风：{voice}\n\n{context_block}\n\n"
        f"当前章节：{chapter_title}\n"
        f"本场景概要：{scene.get('summary','')}\n"
        f"本场景必须发生：{scene.get('must_happen','')}\n"
        f"出场角色：{', '.join(scene.get('characters', []))}\n"
        f"目标字数：约 {scene.get('target_words', 900)} 字（这是下限，宁多勿少）。\n"
        f"衔接上文结尾：…{prev_tail[-200:] if prev_tail else '（本章开头）'}\n"
        f"{ending_rule}{opening_rule}{expand}\n\n"
        "现在直接写这个场景的正文，只输出正文，不要标题、不要场景编号、不要任何说明。"
    )


def chapter_summary_prompt(index: int, chapter_text: str, characters: list[str]) -> str:
    tail = chapter_text[-1500:]
    return (
        f"以下是第 {index} 章的正文（节选结尾）：\n{tail}\n\n"
        f"相关角色：{', '.join(characters)}\n"
        "请输出本章的滚动摘要与角色状态更新，供后续章节保持连贯。输出 JSON："
        '{"summary":"本章 120 字内摘要","character_updates":[{"name":"","state":"最新状态"}],'
        '"foreshadow_updates":[{"item":"","status":"planted/paid_off"}]}'
    )


def review_prompt(index: int, chapter_text: str, canon: list[str], char_states: str) -> str:
    return (
        f"第 {index} 章正文：\n{chapter_text[:4000]}\n\n"
        f"硬事实（canon）：{'; '.join(canon)}\n角色当前状态：{char_states}\n\n"
        "请检查本章是否与设定/前文矛盾，以及是否有明显的复读、注水、逻辑断裂。输出 JSON："
        '{"consistency_issues":["..."],"style_issues":["..."],"verdict":"pass/needs_fix"}'
    )


def book_synopsis_prompt(title: str, summaries: str) -> str:
    return (
        f"书名：{title}\n各章摘要：\n{summaries}\n\n"
        "请写一段 200 字以内、有吸引力的成书简介（用于书库展示），只输出简介正文。"
    )


def cover_prompt_prompt(title: str, synopsis: str, tone: str) -> str:
    return (
        f"书名：{title}\n基调：{tone}\n简介：{synopsis}\n\n"
        "请为这部小说设计一张封面。用一段英文描述画面（风格、构图、光线、主体、氛围），"
        "适合作为文生图模型的 prompt，只输出这段英文 prompt。"
    )
