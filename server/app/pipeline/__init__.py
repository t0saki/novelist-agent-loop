"""生成流水线包。

STAGE_SEQUENCE 定义 generate 任务的确定性阶段顺序；engine 逐阶段推进并落检查点。
"""

STAGE_IDEATION = "ideation"
STAGE_CONCEPT = "concept"
STAGE_BIBLE = "bible"
STAGE_OUTLINE = "outline"
STAGE_WRITING = "writing"
STAGE_FINALIZE = "finalize"

STAGE_SEQUENCE = [
    STAGE_IDEATION,
    STAGE_CONCEPT,
    STAGE_BIBLE,
    STAGE_OUTLINE,
    STAGE_WRITING,
    STAGE_FINALIZE,
]

STAGE_LABELS = {
    STAGE_IDEATION: "选题",
    STAGE_CONCEPT: "构思",
    STAGE_BIBLE: "设定集",
    STAGE_OUTLINE: "分层大纲",
    STAGE_WRITING: "逐章生成",
    STAGE_FINALIZE: "成书",
}
