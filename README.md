# 书阁 · Novelist 2.0

自托管的超长篇网文工厂兼阅读室。Novelist 不直接调用模型 API，而是驱动 Claude Code、Codex 等 agent harness 写作，目标是无人值守地写到百万字以上，同时保证设定和情节前后一致。写好的章节在自带的网页阅读器里连载。

当前版本是 `2.0.0-alpha`。v1（直接调用 OpenAI 兼容接口的 FastAPI 版）已移到 [`legacy/v1/`](./legacy/v1)，只作参考，导入方法见 [从 v1 迁移](#从-v1-迁移)。

## 主要特点

- **多 harness**：同一条流水线可以跑在 Claude Code、Codex、Antigravity CLI、Grok Build、DeepSeek Harness、pi 上，每个角色单独路由。
- **配置都在网页上**：账号、路由、质量档位、规模、吞吐、预算都在 Web UI 里设置，不需要事先写配置文件。
- **指令归你所有**：全局、题材、书三层自定义 `AGENTS.md`，Novelist 不改写、不过滤，书层永远最后加载、优先级最高。
- **输出只认文件**：agent 把产物写到文件，stdout 只作遥测。校验器按文件验收，通过后由编排器统一提交。
- **每本书一个 git 仓库**：正文、设定、大纲、状态账本都在仓库里，可以审计、回滚，也可以手改。
- **任何时刻崩溃都能恢复**：任务按内容 hash 幂等，提交走两阶段协议，最多丢失正在跑的那一个 run。
- **存稿后定时发布**：默认保留约一个弧的存稿（最少 15 章），审计通过才发布，存稿超过 60 章暂停生产。

## 架构概览

```
浏览器（阅读器 / 管理台）
        │ HTTP + SSE
        ▼
┌────────────────── Novelist 容器 ──────────────────┐
│  web（Fastify API + React SPA）                   │
│  orchestrator（调度、路由、配额、唯一 committer） │
│  pipeline（决定做什么、怎么验收）                 │
│  validators（确定性 gate、delta.check）           │
│  runner → nv-shim → harness CLI（detached）       │
└───────┬───────────────────────────┬───────────────┘
        ▼                           ▼
   Postgres（任务、运行、      $DATA/books/<slug>/
   账号、读者、配额账本）      每本书一个 git 仓库（正典）
```

一章的流程：

1. `ctx.build` 把卡片、前文、状态账本编译成一个 context pack。
2. harness 在固定于 `base_commit` 的 git worktree 快照里运行，只往 `out/` 写文件。
3. 校验器检查 I/O 契约和工艺 gate，不通过就重试或修订。
4. 模型抽取状态变化（delta），确定性规则核对引文和设定。
5. 默认的 `standard` 档再跑一次评审。
6. 编排器 stale check 后提交，并把 commit trailer 作为崩溃恢复的依据。

技术栈：TypeScript（ESM、strict）、Node 24、Fastify 5、drizzle（Postgres；开发和测试用 PGlite）、React 19、Vite 8、Tailwind 4、TanStack Router/Query、CodeMirror 6，pnpm workspace。

隔离档位：`container`（默认）以 Novelist 容器为边界，越界写入随 run 快照丢弃，只收割 `out/`；`bwrap` 仅在启动探测通过时使用；`degraded` 兜底。

## 支持的 harness

| harness | CLI | 认证方式 |
|---|---|---|
| Claude Code（`claude-code`） | `claude` | 订阅 OAuth token；自定义 API（`ANTHROPIC_BASE_URL` 加 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，模型名自定义） |
| Codex（`codex`） | `codex` | ChatGPT 登录（device-code）；上传 `auth.json`；API key；自定义 provider |
| Antigravity CLI（`agy`） | `agy` | Google 账号登录；上传 OAuth token 文件；Gemini API key；ADC / Vertex；自定义 Gemini 兼容端点 |
| Grok Build（`grok`） | `grok` | SuperGrok / X Premium+ 登录（device-code）；上传 `auth.json`；`XAI_API_KEY` |
| DeepSeek Harness（`dsh`） | `dsh` | `DEEPSEEK_API_KEY` |
| pi（`pi`） | `pi` | 各家 provider 的 API key；登录后复用 `auth.json` |
| fake（`fake`） | 内置 | 只用于测试，不调用模型 |

harness 不打进镜像，在“Harness 与账号”页一键安装到 `/data/harness`。

使用订阅账号时，UI 会显示各家的条款风险说明（例如 agy 的 consumer 订阅），是否使用由你决定。

## 快速开始（docker compose）

镜像由 GitHub Actions 构建（`linux/amd64` 和 `linux/arm64`），发布到 `ghcr.io/t0saki/novelist-agent-loop`。部署时直接拉镜像，**不要在本机执行 `docker build`**，构建很吃内存。

1. 新建目录，写一个 `docker-compose.yml`：

   ```yaml
   services:
     postgres:
       image: postgres:16-alpine
       restart: unless-stopped
       environment:
         POSTGRES_USER: novelist
         POSTGRES_PASSWORD: ${NOVELIST_PG_PASSWORD}
       volumes: ["./pgdata:/var/lib/postgresql/data"]
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -U novelist"]
         interval: 5s
         retries: 20

     novelist:
       image: ghcr.io/t0saki/novelist-agent-loop:latest
       restart: unless-stopped
       init: true
       stop_grace_period: 90s
       ports: ["${NOVELIST_PORT:-8199}:8000"]
       volumes: ["./data2:/data"]
       environment:
         NOVELIST_DATABASE_URL: postgresql://novelist:${NOVELIST_PG_PASSWORD}@postgres:5432/novelist2
         NOVELIST_MASTER_KEY: ${NOVELIST_MASTER_KEY:-}
         NOVELIST_ADMIN_PASSWORD: ${NOVELIST_ADMIN_PASSWORD:-}
       depends_on:
         postgres: { condition: service_healthy }
   ```

2. 写 `.env`，准备数据目录（容器以 uid 10001 运行），然后启动：

   ```bash
   cat > .env <<EOF
   NOVELIST_PG_PASSWORD=$(openssl rand -hex 16)
   NOVELIST_MASTER_KEY=$(openssl rand -hex 32)
   NOVELIST_ADMIN_PASSWORD=换成你自己的密码
   EOF
   mkdir -p data2 && sudo chown -R 10001:10001 data2   # compose 挂载 ./data2:/data；不要动 v1 正在用的 ./data
   docker compose pull
   docker compose up -d
   ```

   `novelist2` 数据库不存在时会自动创建。`NOVELIST_ADMIN_PASSWORD` 留空时，首次启动会生成随机密码并打印到日志。**`NOVELIST_MASTER_KEY` 要单独备份**，丢失后已加密的账号凭据无法解密。

3. 打开 `http://<主机>:${NOVELIST_PORT:-8199}`（默认 8199，容器内仍监听 8000），用管理员密码登录，进入 `/admin`：

   1. **Harness 与账号**：安装要用的 harness，添加账号（填 env、上传凭据文件，或者用网页交互登录）。
   2. **路由与 Profile**：确认路由 preset。默认是 `agy-argon`，全部角色走 agy + Gemini 4 Argon。先在这里核对模型 slug（列表来自 `agy models`）。如果只用 Claude Code 接自己的网关，切到 `cc-only` 并改模型名。
   3. **系统与 Doctor**：查看隔离档和各项探测结果。
   4. **书 → 新建**：选题材包，设定规模和质量档位，写种子设定，开书。
   5. **Inbox**：审批总纲和第一卷，之后写作 lane 自动运行。

## 配置（Web UI）

| 页面 | 配置内容 |
|---|---|
| Harness 与账号 | 安装和探测 harness；账号的 env 变量、凭据文件、网页交互登录；风险说明 |
| 路由与 Profile | 模型 profile；角色链；preset；开书前的路由可行性检查 |
| 配额与用量 | 各账号窗口占用率、重置时间、用量账本 |
| 全局指令 / 题材包 | 全局层和题材层的指令、gates、lexicon、节奏 |
| 书（新建 / 设置） | 规模（目标字数、卷数、每卷章数、单章长度）；质量档位；路由覆盖；发布计划；预算；opt-in 机制 |
| 发布排期 | 定时发布、存稿、发布前沿 |
| 读者 | 只读密码（各自保留阅读进度） |
| 系统与 Doctor | 隔离档、环境探测、系统设置 |
| v1 导入 | 从 v1 数据库导入 |

书级设置写入该书的 `book.yaml`，合并顺序是书 > 题材 > 全局 > 内置。

**路由 preset**：

| preset | 内容 |
|---|---|
| `agy-argon`（默认） | 全部角色走 agy + Gemini 4 Argon，模型 slug 可改 |
| `cc-only` | 全部角色走 Claude Code（订阅或自建网关） |
| `codex-only` | 全部角色走 Codex |
| `mixed` | cc 主笔，codex 校验，评审要求与写手不同厂商 |
| `dev-cheap`、`fake` | 只用于开发测试，不要用来正式写书 |

**质量档位**（按书选择）：

| 档位 | 内容 | 每章 run 数（约） |
|---|---|---|
| `lean` / `lite` | 写手 + 确定性 gates + 一次 check | 2.3–2.5 |
| `standard`（默认） | 写手 + 抽取 + 评审 + 修订 + 摘要 | 4–5 |
| `key` | 完整评审 panel，一般只给关键章开 | 10–14 |

少量启动参数仍然走环境变量：

| 变量 | 说明 |
|---|---|
| `NOVELIST_DATABASE_URL` | 生产用 Postgres；留空时用 `$DATA/pglite` |
| `NOVELIST_V1_DATABASE_URL` | v1 导入源 |
| `NOVELIST_MASTER_KEY` | 凭据加密主密钥（base64 32 字节或 64 位 hex），留空时生成到 `/data/.master_key` |
| `NOVELIST_ADMIN_PASSWORD` | 初始管理员密码 |
| `NOVELIST_PORT` | compose 的主机端口 |
| `NOVELIST_ISOLATION` | `auto`（默认）、`container`、`bwrap`、`landlock`、`degraded` |
| `NOVELIST_TRUST_PROXY` | 信任的反向代理网段（CIDR 或别名，逗号分隔），默认 `loopback,uniquelocal`；`1`/`true` 等同默认值，`0`/`false` 关闭 |
| `NOVELIST_INSECURE_COOKIES` | 局域网 http 访问时设为 `true` |

完整列表见 [`docs/v2/IMPL.md`](./docs/v2/IMPL.md) §7。

## 指令分层

指令文件完全由你掌控，Novelist 只加载，不改写、不过滤、不做摘要。每个角色（包括评审）都加载全部作者层。

| 序 | 层 | 位置 |
|---|---|---|
| S0 | 内置 I/O 契约（只讲文件机制） | 内置 |
| S1 | 内置角色人设（可覆盖的默认值） | 内置 |
| L1 | 全局 | `$DATA/instructions/global/AGENTS.md`、`roles/<role>.md`、`tasks/<kind>.md` |
| L2 | 题材包 | `$DATA/genres/<id>/AGENTS.md`、`roles/<role>.md` |
| L3 | 书 | `<book>/instructions/AGENTS.md`、`roles/<role>.md`、`tasks/<kind>.md` |
| L3.9 | 本章笔记、Inbox 重写笔记 | 卡片 `notes`、Inbox |

- 后出现的层覆盖先出现的，**最后一个作者块永远来自书层或本章笔记**，有 golden test 保证。
- 角色文件以 `@extends` 开头表示追加，否则替换下层的同名角色。
- 用独占一行的 `<!-- nv:include relative/path.md -->` 引入其他文件。
- 每层带首尾 nonce，验证指令被完整加载。
- 管理台可以按 harness 预览 agent 实际看到的内容。

**agent 始终把产物写到文件**（`out/` 下的正文、delta、receipt），stdout 只作遥测。文件机制（S0）是唯一不可覆盖的部分；长度、标记、重复、lexicon 等工艺规则都定义在题材层和书层，可以逐条关闭或调整。

## 书库结构

每本书是 `$DATA/books/<slug>/` 下的一个 git 仓库：

```
<slug>/
├── book.yaml            书的配置：题材、规模、档位、路由覆盖、发布计划
├── instructions/        你的书层指令（AGENTS.md、roles/、tasks/、skills/）
├── style/               文风：voice.md、samples/、lexicon.yaml
├── bible/               设定：premise、世界观、实体、秘密
├── plan/                规划：compass、volumes/、arcs/、cards/
├── state/               正典：ledger/（每章 delta）、overrides.jsonl
├── manuscript/          正文：c00421.md
├── summaries/           弧、卷、全书摘要
├── reviews/  audits/    评审与审计结果
└── work/ views/ .index/ 中间产物、派生视图和索引（不入库，可重建）
```

根目录的 `AGENTS.md` 由 Novelist 生成，你的指令写在 `instructions/AGENTS.md`。完整结构见 [DESIGN §4](./docs/v2/DESIGN.md#4-书库布局)。

## 开发

需要 Node ≥24.9 和 pnpm 10（可以用 `npx -y pnpm@10` 代替）。

```bash
pnpm install
pnpm --filter @novelist/server dev   # 后端，默认用 PGlite，不需要 Postgres
pnpm --filter @novelist/web dev      # 前端 http://localhost:5173，/api 代理到 8000
```

没有 harness 时，设 `NOVELIST_FAKE_HARNESS=1`，全部角色都会走 fake adapter，可以不调用模型跑通整个流程（fake 账号和路由会自动配置）。

```
apps/server/      后端：api、orchestrator、pipeline、harness、validators、book、state、context、instructions、genres
apps/web/         前端：阅读器与管理台
packages/shared/  zod schema、类型、API DTO、内置 preset
legacy/v1/        v1 代码，只读参考
```

CLI：`novelist serve | migrate | doctor | book new/status/run | import-v1 | harness install/probe | routing check | reindex`。

## 测试

```bash
pnpm -r typecheck
pnpm -r test                               # 全部测试
pnpm --filter @novelist/server test        # 只跑后端
npx biome lint .
```

测试只用 fake harness 和内存 PGlite，不需要 Postgres，也不调用模型。设 `NOVELIST_LIVE_TESTS=1` 时才会调用真实 CLI，并且只允许用测试用的廉价模型（`claude-haiku-5-5`、`gpt-6-luna`、`gemini-3.8-flash-low`）。这些廉价模型不是任何正式 preset 的默认值。

## 从 v1 迁移

v2 和 v1 可以共用一个 Postgres：v2 用新库 `novelist2`，v1 的库 `novelist` 只读取，不修改。

1. 在 v2 容器上设置 `NOVELIST_V1_DATABASE_URL=postgresql://novelist:<密码>@postgres:5432/novelist`。
2. 打开 `/admin/import`，预览后导入，也可以用 CLI：`novelist import-v1`。
3. 确认无误后再停掉 v1。

导入内容：题材转成题材包；已完成的章节转入书仓库；读者密码和阅读进度保留（读者首次登录时重新计算密码 hash）。已完结的书归档只读，未完结的书暂停。未完成的章节默认丢弃，并在报告里列出。导入可以重复执行，已导入的内容会跳过。

## 文档

- [`docs/v2/DESIGN.md`](./docs/v2/DESIGN.md)：架构设计与用户决策记录
- [`docs/v2/IMPL.md`](./docs/v2/IMPL.md)：实现契约、模块归属、环境变量、API 路由
- [`docs/v2/research/`](./docs/v2/research)：各 harness 调研

## License

MIT，见 [LICENSE](./LICENSE)。
