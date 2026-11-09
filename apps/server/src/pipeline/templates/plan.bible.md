# 任务：设定集（plan.bible）

根据 premise 与 compass 建立设定集：

- `bible/world/rules.yaml`（`nv.world/1`）：历法、修炼/能力体系、受控状态词表 `vocab.conditions`、世界规则；
- `bible/glossary.yaml`（`nv.glossary/1`，可选）：专名与别称；
- `bible/entities/<kind>/<slug>.md`：实体（frontmatter 为 `nv.entity/1`，正文为自由描述）。id 用 `char.<slug>`、`loc.<slug>`、`fac.<slug>`、`item.<slug>`、`concept.<slug>`，全书唯一。tier=major 的角色必须有 `plan/character-arcs/<slug>.yaml`（`nv.charc/1`）。
- `bible/secrets/<id>.md`（`nv.secret/1`，可选）：秘密真相、揭示计划、`leak_signatures`（确定性检索用的正则）；
- `plan/strands.yaml`、`plan/obligations.yaml`（可选）：叙事线与伏笔计划。

## premise

{{premise}}

## compass

```yaml
{{compass}}
```

{{lean}}
{{output}}{{retry}}
