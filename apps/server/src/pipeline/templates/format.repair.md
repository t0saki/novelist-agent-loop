# 任务：修复输出格式（format.repair {{cid}}）

上一次校对/抽取的原始输出不是合法的 `{{schema_name}}`。只修复格式，不增删语义内容：不新增 op，不修改 `ev` 引文。把修好的结果写到 `{{target_file}}`。

原始输出：`{{raw_path}}`

校验错误：

{{errors}}

JSON Schema：

```json
{{json_schema}}
```

{{output}}{{retry}}
