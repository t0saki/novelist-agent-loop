# 任务：重新抽取状态增量（chapter.reextract {{cid}}）

本章正文被人工修改或修补。读取新稿 `{{draft_path}}` 与旧账本 `{{base_delta_path}}`，输出完整的 `nv.delta/1` 到 `delta.json`，保持与未改动内容一致的 op 不变，只修改确实变化的内容。每条 `ev` 必须是新稿中的逐字引文。

{{check_slice}}

{{op_reference}}

{{output}}{{retry}}
