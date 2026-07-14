# 书阁 · Novelist Agent Loop

全自动、无人值守的 AI 小说生产与在线阅读系统。以每天几本的频率自动**选题 → 构思 → 多步生成 → 审校 → 成书**，产物通过自带 WebUI 在线阅读。小说长度由模型自主决定（1 章短篇到上百章超长篇），配可选封面/插图流水线。

## 特性

- **全自动闭环**：从题材关键词自动选题、立项、分层大纲、逐章生成到成书，无需人工介入。
- **无人值守调度**：常驻调度器 + 滑动窗口限流（每天/每 5h 本数）+ token 日预算/单本上限 + 失败自愈 + **崩溃续跑**（检查点持久化在 SQLite，进程重启无缝接管）。
- **反偷懒长度控制**：逐场景生成 + 规划前移的硬指标 + **确定性字数校验重写循环** + 完结/快进检测。不依赖模型自评。
- **一致性记忆层**：设定集（world bible）+ 角色卡按出场裁剪强注入 + 滚动摘要 + canon 硬事实 + 伏笔账本；超长篇卷级动态细化 + embedding 查重。
- **连载上架**：章节写完即可读，书标「连载中 / 已完结」；调度器优先续写在写的书。
- **多模型 profile**：OpenAI 兼容 chat / image / embedding 端点，流水线各阶段可分配不同模型（大纲用强模型、正文用便宜模型），带 fallback 链。
- **权限**：管理员密码 + 多个具名只读密码（各自阅读进度）。
- **阅读器**：封面墙书库、目录、字号/暗色/进度记忆、EPUB 导出，移动端适配。

## 技术栈

FastAPI + SQLite（sqlite-vec 备用）+ 进程内 asyncio 调度器 · React + Vite + TS · 单容器 Docker · uv 管理 Python 环境。

## 快速开始

### Docker（推荐）

```bash
cp .env.example .env          # 可选：设置管理员密码等
docker compose up --build -d
docker compose logs -f        # 若未设密码，日志会打印随机管理员密码
```

打开 http://localhost:8000 ，用管理员密码登录，到「模型」页配置一个 OpenAI 兼容 chat 端点即可开始自动生产。

### 零成本演练（Mock LLM）

无需任何真实模型，用脚本化假 LLM 跑通全流程（含反偷懒长度控制的模拟）：

```bash
NOVELIST_MOCK_LLM=true docker compose up --build
```

### 本地开发

后端：

```bash
cd server
uv sync --extra dev
NOVELIST_MOCK_LLM=true NOVELIST_ADMIN_PASSWORD=admin \
  PYTHONPATH=. uv run uvicorn app.main:app --reload
```

前端（另开终端，dev server 代理 /api 到 8000）：

```bash
cd web
pnpm install && pnpm dev   # http://localhost:5173
```

## 配置（管理端网页）

- **题材**：名称、关键词、风格提示词、篇幅参考、权重、内容标签、最少章数兜底。自动选题按权重加权轮转。
- **模型**：多个 OpenAI 兼容端点；阶段级分配 + fallback；含单价用于成本估算。
- **限流与预算**：每天/每 5h 本数上限、日 token 上限、单本 token 上限、并发写作本数。
- **插图**：密度（不生成 / 仅封面 / 每 N 章一图），需配置 image 端点。
- **只读密码**：分发给不同的人，权限等同。

## 生成流水线

```
选题(brainstorm+查重) → 构思(书名/简介/自主定篇幅结构) → 设定集(world bible/角色卡/canon/文风)
  → 分层大纲(卷纲→章纲→场景细纲, 超长篇动态细化) → 逐章逐场景生成 → 章级审校 → 成书 → (可选)封面/插图
```

设计依据 Re3 / DOC / DOME / RecurrentGPT 等长文本生成方法，核心原则：**规划前移、结构化状态强注入、一次只写一个场景、确定性校验重写、外部信号而非模型自评**。详见 `.claude/plans` 中的实施计划。

## 测试

```bash
cd server && PYTHONPATH=. uv run pytest -q
```

覆盖：端到端流水线成书、长度控制收敛、完结检测、调度限流、预算暂停/恢复、孤儿恢复、封面流水线。

## 目录结构

```
server/app/{core,db,providers,pipeline,scheduler,services,api}   后端
web/src/{pages,admin}                                            前端
data/                                                            SQLite + 封面/插图/EPUB（挂载卷）
```

## License

MIT，见 [LICENSE](./LICENSE)。
