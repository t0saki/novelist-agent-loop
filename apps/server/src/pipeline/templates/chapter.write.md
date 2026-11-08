# 任务：写作章节 {{cid}}「{{title}}」

只写这一章。严格按章卡的节拍推进，长度区间 {{length_range}}（{{count_mode}} 计数），目标 {{length_target}} 字。

节拍（每个节拍开头单独一行放置 beat 锚点，锚点在定稿时由程序剥离）：

{{beats}}

要求：
- 只写故事正文，不写任何说明、标题注解、章末小结或作者按。
- 结尾标记只在最终章允许。
- 上下文包内的 overrides 优先于 manuscript 原文；需要更多前文时可读 `manuscript/**`（最多 {{max_reads}} 次整章阅读、{{max_searches}} 次检索）。
- 写完用 receipt 的 `self_count` 回报实测字数；若想改章节标题，在 `title_proposal` 提议。

{{output}}{{retry}}

---

{{context}}
