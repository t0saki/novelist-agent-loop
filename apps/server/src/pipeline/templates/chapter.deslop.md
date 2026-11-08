# 任务：去 AI 味润色（chapter.deslop {{cid}}）

读取草稿 `{{draft_path}}`。只针对下面列出的问题片段给出 span 级替换，写入 `patches.json`（schema `nv.patches/1`）：每条 `find` 必须在草稿中唯一命中，`replace` 为替换后的文字。作者层允许的表达（书层 allow）不得改动，不得改变情节和事实。

{{issues}}

{{output}}{{retry}}
