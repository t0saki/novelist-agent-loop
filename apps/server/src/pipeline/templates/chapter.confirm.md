# 任务：定向确认（chapter.confirm {{cid}}）

读取草稿 `{{draft_path}}`，逐条回答下列问题。只认草稿的原文：能在草稿中找到逐字引文才算 `found: true`，并在 `quote` 给出引文；需要时在 `ops` 中给出应补入账本的 op（`ev` 为逐字引文）。找不到就写 `found: false`，不要猜。

{{questions}}

产物 `confirm.json`：

```json
{ "schema": "nv.confirm/1", "answers": [ { "id": "q1", "found": true, "quote": "…", "ops": [] } ] }
```

{{op_reference}}

{{output}}{{retry}}
