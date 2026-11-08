# 任务：细化弧与章卡（plan.arc {{arc}}）

为弧 {{arc}} 写 `plan/arcs/{{arc}}.yaml`（`nv.arc/1`，`detail: detailed`）和章卡 `plan/cards/cNNNNN.yaml`（`nv.card/1`）。

- 章号从 {{start}} 起连续编号，共 {{card_min}}–{{card_max}} 张；弧的 `chapters` 与之一致；`resolve_by` 落在区间内，弧收尾章必须规划 `arc.resolve`。
- 每卡必须有 `title`、`beats`（目标字数合计约 {{length_target}} 字，单章区间 {{length_range}}，beat 数 {{beats_range}}）、`pre`/`post`/`must_not`。`pays`/`advances` 引用已存在的伏笔，`post` 中新埋设用 `tmp:` id（`obligation.open`），`may_open` 列出允许新开的伏笔。
- 新实体用 `tmp:` id 并在 `post` 中 `entity.create`。
- 与此前弧的场面类型、结构不要重复。
{{endgame}}

## 当前卷

```yaml
{{volume_yaml}}
```

## compass（节选）

{{compass_brief}}

## 账本现状

{{state_brief}}

## 已有弧目录

{{arcs_index}}

{{predicates}}

{{output}}{{retry}}
