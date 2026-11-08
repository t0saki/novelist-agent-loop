# 任务：弧审计（audit.arc {{arc}}）

审计弧 {{arc}}（{{range}}）：对照账本抽样核对弧摘要，并检查弧问题是否解决、伏笔是否按计划推进、人物阶段是否到位。把结果写入 `audit.json`（schema `nv.audit/1`，`kind: arc`，`range: {{range_json}}`），每条 finding 尽量带正文逐字引文 `quote`。只报有依据的问题，以作者层为准绳。

## 弧摘要

{{summary}}

## 账本摘录

{{sources}}

{{output}}{{retry}}
