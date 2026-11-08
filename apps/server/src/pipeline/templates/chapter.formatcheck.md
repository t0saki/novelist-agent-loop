# 任务：排版格式检查（chapter.formatcheck {{cid}}）

读取草稿 `{{draft_path}}`。只检查排版与格式：对白标点、分段、全角半角混用、残留的 markdown 或标记。给出 span 级建议写入 `patches.json`（schema `nv.patches/1`），每条 `find` 必须唯一命中。不改内容、不改文风。

{{output}}{{retry}}
