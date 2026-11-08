# 任务：评审章节 {{cid}}「{{title}}」（{{slot_label}}）

阅读草稿 `{{draft_path}}` 与状态增量 `{{delta_path}}`，写 `review.json`（schema `nv.review/1`）。

- `findings`：每条有 `severity`（hard/soft）、`category`、`message`、`suggestion`，尽量带草稿逐字引文 `quote`（程序会校验）。与作者层冲突的建议必须把 `conflicts_with_author_layer` 设为 true，这类建议不会交给写手。
- `missing_ops`：草稿写了但增量漏掉的 op（`ev` 逐字），程序校验后并入账本。
- `verdict`：`pass` 或 `revise`；hard 问题才需要 revise。
{{review_focus}}

{{check_slice}}

{{output}}{{retry}}
