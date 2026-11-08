# 任务：抽取状态增量（chapter.extract {{cid}}，模式 {{mode}}）

读取草稿 `{{draft_path}}`，抽取 `nv.delta/1` 写入 `delta.json`。只记录正文实际发生的变化，每条 op 的 `ev` 必须是草稿中的逐字引文。摘要 `summary` 每句带锚点（`op:<下标>` 或 `ev:<逐字引文>`）。

{{mode_rules}}

{{check_slice}}

{{op_reference}}

{{output}}{{retry}}
