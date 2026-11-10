# 书阁 · Novelist

自托管的网文写作机兼阅读室。Novelist 不直接调用模型 API，而是驱动 Claude Code、Codex、Antigravity CLI 等 agent harness 写书；写好的章节在自带的网页阅读器里连载。

**书的目录就是作者的书房。** 每次运行是作者干的一班活：读自己需要的文件，写下一批章节，更新自己的笔记。服务器只做六件事：排班、递任务单、收稿、数字数、提交、发布。设计见 [`docs/v3/DESIGN.md`](./docs/v3/DESIGN.md)。

v1（直接调用 OpenAI 兼容接口的 FastAPI 版）在 [`legacy/v1/`](./legacy/v1)，只作参考，导入方法见 [旧书与导入](#旧书与导入)。

## 运行只有三种

| 运行 | 何时 | 作者做什么 |
|---|---|---|
| **开书** | 新书 | 读种子；写设定（`bible.md`）、全书大纲（`outline.md`，写明结局和计划章数）、笔记，然后直接写正文。短篇一次写完整本，其他篇幅写第一批 |
| **写作** | 书没写完、存稿没满 | 读笔记和上一章，连续写完一批（默认 5 章，可调 1–8），批末更新笔记。最后一批是结局批 |
| **复盘** | 长篇和超长篇，每写完 4 批一次 | 通读最近几批，修正笔记和大纲，标出未收线索 |

- 篇幅四档：短篇（≥1.5 万字）、中篇（≥6 万字）、长篇（≥20 万字）、超长篇（≥50 万字）。字数只是下限，写多了照收；每章不少于 3000 字（可调）。
- **先收稿，后判断**：运行不管怎么结束（正常、超时、被杀、限流），都先把写好的东西收下；每章一个提交并打标签。
- 服务器只做数得出来的检查：字数、截断、大段重复、文件在不在。不审稿，不拦内容。
- 主人运行期间改过的文件以主人为准；主人直接改过的章节会锁定，作者不能再覆盖。
- 存稿到上限就暂停写这本书；章节入库后满 24 小时（或后面又有章节入库、全书完结）才可发布，按节奏放出。

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
   NOVELIST_ADMIN_PASSWORD=<password>
   EOF
   mkdir -p data2 && sudo chown -R 10001:10001 data2   # compose 挂载 ./data2:/data
   docker compose pull
   docker compose up -d
   ```

   `novelist2` 数据库不存在时会自动创建。`NOVELIST_ADMIN_PASSWORD` 留空时，首次启动会生成随机密码并打印到日志。**`NOVELIST_MASTER_KEY` 要单独备份**，丢失后已加密的账号凭据无法解密。

3. 打开 `http://<主机>:${NOVELIST_PORT:-8199}`（容器内监听 8000），用管理员密码登录，进入 `/admin`：
   1. **模型与账号 → Harness 与账号**：安装要用的 harness，添加账号（填 env、上传凭据文件，或者在网页上交互登录）。
   2. **模型与账号 → 位置与 effort**：确认“写作用的模型”的主用 profile（默认 `agy-argon`，agy + Gemini 4 Argon；模型 slug 以 `agy models` 的列表为准），可选配一个备用；点“试跑”确认能写文件、读到 AGENTS.md。
   3. **开书**：选题材（或随机）、篇幅（或随机），写一句话想法（可空），点“开书”。

## 控制台

导航只有五项：

| 页面 | 内容 |
|---|---|
| 首页 | 待办（平时为空：账号登录失效、harness 不可用、连续空跑、额度长时间耗尽、某本书连续写不出正文……条件消失自动关闭）；每本书一行：书名、题材、篇幅、已写/计划、一句状态、存稿/已发布、累计花费。默认只列在写的书，已完结和旧书另有筛选 |
| 开书 | 开书表单；自动开书面板（开关、未完结书上限、每日上限、篇幅分布、各篇幅档目标字数、各题材的参与与权重） |
| 题材与指令 | 每个题材包的自动开书设置（参与、权重、关键词、篇幅倾向）和指令编辑器；全局层编辑器；篇幅档（内置，只读）；根 AGENTS.md 预览 |
| 模型与账号 | 两个位置（写作 / 杂活）的主备；effort 表；harness 安装、登录、探测；profile；用量 |
| 系统 | 默认发布节奏与存稿上限、失控兜底、并发、时限、隔离、保留期、读者账号、通知、v1 导入、密码与令牌、Doctor |

另有书页（概览、章节、故事资料、草稿、花费、指令、设置）、章节页（读、直接改、带意见重写、从这里起重写、立即发布）和运行日志页。书页上的“给作者的话”只用一次，下次运行读到后会标出在哪一批读的。

系统设置每张卡片只保存自己那一节；别处改过设置时保存会被拒绝，页面重新读取后再改即可。

## 无人值守

**自动开书默认关闭**，只有主人在开书页上打开开关才会启用。打开后：未完结的书少于上限、写手真的闲着（所有书存稿已满，没有账号在等额度或故障冷却）、没超每日上限时开一本；题材按“自动开过的书数 ÷ 权重”挑，篇幅按分布补缺口。带成人标记的题材包，种子里会保留“所有角色都是成年人”的声明。

出错与等待：有结构化限流信号的 harness 睡到恢复时间，其余按阶梯等待；运行失败又什么都没改的算在账号头上（同一账号连续两次暂停该账号并进待办）；运行正常结束却没写正文的算在书头上（按 10 分钟、30 分钟、2 小时、6 小时、之后每天重试，连续 5 次进待办）。主用 profile 不可用且没有备用时，任务就等。

## 旧书与导入

旧书指导入的书和旧流程写的书（`book.yaml` 里没有 `flow: v3`）。它们**只读**：可以在控制台和阅读器里读（按卷分组，带卷标题）、导出 TXT / EPUB、直接改正文、在 `notes/` 下写批注、删除（移到回收站），不会被排进任何运行，也不会再发布新章。

想续写某一本时，在书页上点 **“接手续写”**：选篇幅、目标字数、每批章数、每章下限。接手只改 `book.yaml`（加上新流程的设置，旧键原样保留），不移动、不删除任何文件；第一次写作先读最后三章和旧设定、补出新流程的笔记，再从下一章接着写。已有章节不会被改写，也不能回退到接手之前；已发布的章节不会重发，新章按新流程的节奏接着发布。

从 v1 导入：

1. 在容器上设置 `NOVELIST_V1_DATABASE_URL=postgresql://novelist:<password>@postgres:5432/novelist`（v1 的库只读，不修改）。
2. 打开 **系统 → v1 导入**，预览后导入；也可以用 CLI：`novelist import-v1`。
3. 确认无误后再停掉 v1。

导入内容：题材转成题材包；已完成的章节转入书仓库（卷标题当场回填）；读者密码和阅读进度保留。导入的书都是旧书，不排任何任务。导入可以重复执行，已导入的内容会跳过；上一次没导完的残留目录会移到回收站。

## 升级到这一版（P3）的说明

- **开机迁移**：serve 启动时（只在带 orchestrator 角色的进程里）跑一次迁移，结果写进日志的 `p3 boot migration` 一行，也存在设置 `migration.p3` 里：
  - 统计新流程的书和旧书；`book.yaml` 和数据库对不上的只列出来，不自动改；
  - 取消旧种类的任务和旧书的任务，关闭旧流程留下的待办（审批、暂扣、熔断……）；
  - 从旧路由 preset 换算出两个位置（写作 / 杂活）；旧 preset 里已经不存在的 profile 会被丢掉，并在模型与账号页上提示。旧 preset 的写手是“粘住、不可用就等”的，所以写作位置不会自动配上备用（需要的话在模型与账号页上自己配）；
  - 给旧书的章节回填卷标题（从 `plan/volumes/*.yaml`）；仓库读不出来的书下次启动再试；
  - 之后（崩溃恢复完成后）把升级前就是新流程的书上旧的写作模型覆盖搬进 `book.yaml` 的 `routing.writer_profile`；当时正在写的书等这一批写完再搬（每分钟重试），在那之前照旧用原来的写手。接手过来的旧书不搬：旧流程留下的写手不算主人的选择。

  迁移不删任何行、文件或设置，也不碰自动开书开关。
- **删书进回收站**：删除的书目录移到 `$DATA/trash/books/<slug>-<时间>/`，里面的 `.novelist-trash.json` 记着删除时间和数据库里原来的样子；回收站从不自动清理。要恢复，把目录移回 `$DATA/books/<slug>/`，按墓碑里的信息重建这本书的数据库行，再执行 `novelist reindex <slug>` 重建章节索引。
- **书级预算**（优先级、每月花费上限、额度窗口上限）照旧生效，现在在新流程书页的“设置”里改。
- **账号的“配额预留 %”和“周用量上限 %”已删除**（随配额预留一起），页面上不再出现，存着的值不再起作用；账号的每月美元上限照旧生效。要限制用量，用书级预算的额度窗口上限。
- **篇幅档的内置指引在这一版只能查看、不能改**（题材与指令 → 篇幅档）。想给某一档加要求，写在能改的层里：题材包的 `AGENTS.md`，或者某本书的 `instructions/AGENTS.md`（例如“本书是长篇：……”）；全局层对所有篇幅都生效。让篇幅档可编辑需要在指令栈里多加一层，留待主人决定。
- **回滚**：上一版镜像可以直接对同一个数据库启动（这一版只加列、加设置行，不删表、不删列；运行中的会话两版都读得懂）。上一版不认识两个位置，会继续按旧的 `routing.active` 路由；它运行期间如果又给旧书建了任务或待办，再换回这一版时开机迁移会重新取消、关闭。

## 书房结构

每本书是 `$DATA/books/<slug>/` 下的一个 git 仓库：

```
<slug>/
├── AGENTS.md            服务器拼出的指令（每次运行前生成，不入库）
├── ORDER.md             本次任务单（不入库）
├── book.yaml            服务器配置：篇幅档、目标字数、计划章数、每章下限、每批章数、发布、模型覆盖
├── seed.md              种子
├── bible.md             设定：书名、一句话、标签；人物、世界、文风、结局方向
├── outline.md           全书骨架（写明结局）、计划章数、接下来几章的细纲
├── notes/               progress.md、chapters.md（每章一行）、cast.md、threads.md、from-owner.md、retro.md、archive/
├── instructions/        你的本书指令（AGENTS.md）
├── drafts/              没写完的残稿、作者擅自改写的旧章（可在书页一键采用）
└── manuscript/          正文：c00001.md …
```

旧书保留它们原来的目录（`bible/`、`plan/`、`notes/v1/` 等），接手后也原样留着。

## 指令分层

服务器把各层按顺序拼成书房根目录的 `AGENTS.md`：内置约定 → 篇幅档的写作要领 → 全局（`$DATA/instructions/global/AGENTS.md`）→ 题材（`$DATA/genres/<id>/AGENTS.md`）→ 本书（`<book>/instructions/AGENTS.md`）。后面的优先，本书层最高。Claude Code 另有一行 `@AGENTS.md` 的 `CLAUDE.md`。

指令内容归你所有：Novelist 只拼接，不改写、不过滤。总长上限 16 KB，保存超了直接拒绝并显示各层字数，运行时绝不截断。可以用独占一行的 `<!-- nv:include relative/path.md -->` 引入其他文件。启动命令只有一句“阅读 AGENTS.md 和 ORDER.md 并执行”。

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

harness 不打进镜像，在“模型与账号”页一键安装到 `/data/harness`。使用订阅账号时，UI 会显示各家的条款风险说明，是否使用由你决定。

隔离档位：`container`（默认）以 Novelist 容器为边界；`bwrap` 仅在启动探测通过时使用；`degraded` 兜底。每次运行在书仓库当前版本的一份独立副本里进行。

## 环境变量

配置都在网页上，少量启动参数走环境变量：

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
| `NOVELIST_FAKE_HARNESS` | 开发用：两个位置都走 fake harness，不调用模型 |

## 开发

需要 Node ≥24.9 和 pnpm 10（可以用 `npx -y pnpm@10` 代替）。

```bash
pnpm install
pnpm --filter @novelist/server dev   # 后端，默认用 PGlite，不需要 Postgres
pnpm --filter @novelist/web dev      # 前端 http://localhost:5173，/api 代理到 8000
```

没有 harness 时设 `NOVELIST_FAKE_HARNESS=1`：fake harness 照任务单改目录（带故障开关：空跑、短章、截断、放错目录、改旧章、不记笔记、写一半被杀），可以不调用模型跑通整个流程。

```
apps/server/      后端：api、orchestrator、runtime、flow（决定下一步、任务单、收稿与检查）、harness、book、instructions、genres、boot
apps/web/         前端：阅读器与管理台
packages/shared/  zod schema、类型、API DTO、内置 profile
legacy/v1/        v1 代码，只读参考
```

CLI：`novelist serve | migrate | doctor | book new/status/run/takeover | import-v1 | harness install/probe | routing slots | reindex | secrets | backup | restore`。

## 测试

```bash
pnpm -r typecheck
pnpm -r test                               # 全部测试
pnpm --filter @novelist/server test        # 只跑后端（含 test/e2e.*：进程内的流程、结局、旧书接手，和真实 serve 子进程的崩溃恢复）
npx biome lint .
```

测试只用 fake harness 和内存 PGlite，不需要 Postgres，也不调用模型。设 `NOVELIST_LIVE_TESTS=1` 时才会调用真实 CLI，并且只允许用测试用的廉价模型（`claude-haiku-5-5`、`gpt-6-luna`、`gemini-3.8-flash-low`）。

## 文档

- [`docs/v3/DESIGN.md`](./docs/v3/DESIGN.md)：现行设计（流程与交互）
- [`docs/v2/`](./docs/v2)：Novelist 2 的历史文档（旧流水线），只作参考

## License

MIT，见 [LICENSE](./LICENSE)。
