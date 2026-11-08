# 任务：校对章节（chapter.check {{cid}}，模式 {{mode}}）

读取草稿 `{{draft_path}}`，在一次 run 内完成两件事，把结果写入 `check.json`（schema `nv.check/1`）：
1. `delta`：本章状态增量（`nv.delta/1`）。摘要每句带锚点（`op:<下标>` 或 `ev:<逐字引文>`）。
2. `continuity_flags`：能用原文证实的硬问题（死者复现、知识越界、地点或时间跳跃、物品归属冲突、违反 must_not），至多 10 条，每条 `quote` 必须是草稿逐字引文。拿不准的不要报，文风审美不在范围内。

{{mode_rules}}

{{check_slice}}

{{op_reference}}

{{output}}{{retry}}
