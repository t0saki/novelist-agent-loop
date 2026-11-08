# 依赖申请

并行阶段禁止 `pnpm add`。需要新依赖时在下表追加一行，先针对它写代码；集成时由 architect / lane G 统一安装。

| 日期 | lane | 包（含版本范围） | 安装到 | 理由 |
|---|---|---|---|---|
| 2026-11-08 | B | `pinyin-pro@^3` | apps/server | `state/ids.ts slugifyName`：中文名 → 拼音 slug（DESIGN §4.2 实体 id 分配）。代码用 `createRequire` 可选加载；未安装时退回 `u<码点>` 编码（确定性，但 id 不可读）。 |
