> 历史文档（Novelist 2）。现行设计见 [docs/v3/DESIGN.md](../v3/DESIGN.md)。


# Novelist 2.0 架构设计（修订定稿）

状态：修订定稿，2026-11-08。范围：从零重写 v1。
依据：`docs/v2/research/` 下的调研文件（v1 审计、各 harness 调研、跨 harness 标准、长篇方法）、三份提案（RELIABILITY / QUALITY / PRODUCT）、上一版定稿，以及三份评审（运行时可行性、长篇质量与指令优先级、运维与完整性）。
标注 **(verify)** 的条目尚未核实，必须在 P0 用 probe 或 spike 确认。确认之前，设计不得依赖它们才能正确运行。
修订记录：2026-11-08 按用户决策 D1–D4 和同日的事实核查（订阅 headless 用法、嵌套沙箱、linux-arm64）修订；同日又按 D2（修订）、D5、D6 和 D3 的落地事实再次修订，见下一节。实现层面的落地细节以 `docs/v2/IMPL.md` 为准。

---

## 用户决策记录（2026-11-08）

以下决策由用户拍板，优先于本文其他段落里的旧推荐，相关各节已经按此改写。同一编号有修订时以修订版为准；D2 原版留在表中，只作历史记录。

| # | 决策 | 对设计的影响 | 受影响章节 |
|---|---|---|---|
| D1 | **范围**：完整实现路线图 P0→P3 的全部阶段，可靠性机制不做简化 | 路线图保持全量，可靠性基座（staging、唯一 committer、stale check、nonce、canary、熔断、准入）一项不砍。各质量档位和 opt-in 机制都照常交付，默认值见 D2（修订） | [§12](#12-分阶段路线图)、[§13](#13-待用户决策) |
| D2（原版，已被下一行取代） | **账号**：所有 harness **只用订阅**，不以 API key 计费作为方案。超长篇写作**不做重型校验**：最多用 gpt-6-luna（Codex，ChatGPT 订阅）做简单校验（轻量连续性检查和状态抽取核对）；cc、agy 等可以用廉价模型 Haiku（cc）或 Gemini 3.8 Flash（agy）做简单的**格式正确性**校验 | 默认质量档改为 **`lite`**：writer + 确定性 gates + 一次廉价 check。多评审 panel、held-out judge、bake-off、交叉抽取、pairwise 等全部保留为 **opt-in（默认关闭）**，不删除。容量估算改为以订阅窗口吞吐为主约束；认证改为逐 harness 的订阅模式 | [§3.5](#35-命令模板)、[§3.6](#36-隔离后端home-与账号)、[§3.7](#37-认证模式与限额)、[§6.0](#60-开书管线)、[§6.4](#64-单章任务图与质量档位)、[§6.6](#66-deltacheck-与账本完整性)、[§6.7](#67-防-goodhart写手选择与模型漂移)、[§6.10](#610-周期审计级联一致性与发布前审计)、[§7.4](#74-角色路由与降级阶梯)、[§7.5](#75-调度配额预算与容量估算) |
| D2（修订） | **配置全部放到 Web UI**：角色路由、账号与订阅档位、质量档位、规模、吞吐、预算都在 Web UI（和 `book.yaml`）里配置，不需要预先决定。廉价模型（codex `gpt-6-luna`、cc `claude-haiku-5-5`、agy `gemini-3.8-flash-low`）**只用于开发测试**，不是默认值 | 默认路由 preset 是 `agy-argon`：**全部角色走 agy + Gemini 4 Argon**（slug 可配置，UI 通过 `agy models` 列出可选模型，占位值 `gemini-4-argon`）。另有内置 preset `cc-only`、`codex-only`、`mixed`，以及只供测试的 `dev-cheap`、`fake`。默认质量档是 **`standard`**，`lean`/`lite`/`standard`/`key` 按书可选，关键章默认也是 `standard`。bake-off、held-out、交叉抽取、pairwise 回归等 opt-in 机制仍然默认关闭，按书开启 | [§3.5](#35-命令模板)、[§3.7](#37-认证模式与限额)、[§6.4](#64-单章任务图与质量档位)、[§6.6](#66-deltacheck-与账本完整性)、[§7.4](#74-角色路由与降级阶梯)、[§7.5](#75-调度配额预算与容量估算)、[§12](#12-分阶段路线图)、[§13](#13-待用户决策) |
| D3 | **部署主机**：用户自有 Proxmox 主机上一个能跑 Docker 的 LXC 容器。当时架构尚未确认，后来已确认，见下一行“D3（落地事实）” | Novelist 以 docker compose 运行在 LXC 内，属于嵌套容器。bwrap 和各 harness 自带的沙箱在这种环境下预期不可用；Landlock 是否可用取决于宿主机内核参数。为此新增“外层容器边界”隔离档；镜像和 installer 同时支持 amd64 和 arm64 | [§3.6](#36-隔离后端home-与账号)、[§10.2](#102-部署)、[§10.6](#106-安全与威胁模型)、[§12](#12-分阶段路线图) P0、[§13](#13-待用户决策) |
| D3（落地事实） | 目标主机是 **arm64** 的 Proxmox 主机（**PVE 9.0.10**，内核 6.12）。LXC：**特权容器**，`nesting=1`，AppArmor unconfined。v1 已部署在单机 compose 目录，主机端口 **8199**，前面是 Nginx Proxy Manager，数据库是 Postgres 16（库名 `novelist`） | 镜像必须提供 arm64。v2 用同一个 Postgres 上的新库 `novelist2`（不存在时自动创建），并提供 v1 导入器（`NOVELIST_V1_DATABASE_URL` 指向旧库）。单容器 all-in-one，隔离档默认 `container`，不按 harness 拆分 runner 容器 | [§10.2](#102-部署)、[§10.2.1](#1021-目标主机proxmox-主机-目标主机-上的-lxc-Docker LXCd3)、[§11](#11-从-v1-迁移)、[§13](#13-待用户决策) |
| D4 | **发布**：存稿后定时发布。lag 约等于一个弧（最少 15 章），`require_audited`，`max_buffer` 为 60，超过即暂停生产 | 与原推荐一致，定为默认值。存稿同时用来吸收订阅周上限造成的生产暂停 | [§9.4](#94-连载发布)、[§6.10](#610-周期审计级联一致性与发布前审计)、[§7.5](#75-调度配额预算与容量估算) |
| D5 | **凭据与风险**：agy（含 consumer OAuth）照常使用，UI 只显示风险说明。dsh 启用，用户在 UI 配 `DEEPSEEK_API_KEY`。cc 同时支持**订阅 OAuth token** 和**自定义 API**（`ANTHROPIC_BASE_URL` 加 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，自定义模型名），用户可能只用 cc 接自己的网关 | 每个 harness 账号都支持三种录入方式：env 变量（key、base URL）、上传凭据文件（如 codex、grok 的 `auth.json`）、网页“交互登录”（spawn harness 的登录命令，device-code 输出流式显示在 UI，带输入框）。秘密用 AES-256-GCM 加密存储，主密钥来自 `NOVELIST_MASTER_KEY`，或生成到 `/data/.master_key`。这推翻了“cc token 不经网页、不入库”的旧写法 | [§3.5](#35-命令模板)、[§3.7](#37-认证模式与限额)、[§10.6](#106-安全与威胁模型)、[§13](#13-待用户决策) |
| D6 | **规模**：目标字数、卷数、每卷章数、单章长度按书在 UI 配置 | 写入 `book.yaml` 的 `scale`。默认值 target 3M、hard_max 3.5M、10–12 卷、每卷 80–110 章，单章长度缺省取题材包 | [§13](#13-待用户决策) |

**决策落地时的缺口。** 前三条的处理方式已由 D5 确定：
- **dsh 没有官方订阅。** 它只能用预付费 API key（官方没有 coding plan，第三方“DeepSeek coding plans”是非官方转售）。D5：dsh 启用，用户在 Web UI 填 `DEEPSEEK_API_KEY`，可以设月度 USD 上限（每章只花几美分）。默认 preset 不依赖它。
- **agy 的 consumer 订阅不允许被第三方应用包装。** 官方 FAQ 原话：“Wrapping `agy` inside third-party coding agents or applications … is not supported under consumer plans”，并且可能导致封号。D5：agy（含 consumer OAuth）照常使用，不需要勾选确认，UI 只显示风险说明。也可以改用 Google AI Studio 或 Gemini Enterprise 的 API key。
- **cc 订阅条款的灰区。** 用户用自己的订阅登录未经修改的 `claude` 是允许的，平台托管的情况也包括在内。但订阅额度“assume ordinary, individual usage”，而且条款禁止第三方“collect, store, or intermediate”订阅凭据。D5：Novelist 是用户自己部署的，token 由用户在自己的实例里录入并加密入库；UI 显示风险说明，默认留出交互余量，并设每周占用上限（§7.5）。不想用订阅时，可以把 cc 接到自己的 API 网关。
- **codex 订阅。** ChatGPT 登录下跑 `codex exec` 没有被禁止，但 OpenAI 的指引是“API keys are still the recommended default for automation”。兜底：照常使用订阅，在 UI 上标注风险等级“中”；额度耗尽时等待重置，不自动购买 credits。
- **Docker LXC 内大概率没有 OS 级沙箱。** Docker 默认 seccomp 拦截 bwrap 需要的 `unshare`/`clone(CLONE_NEWUSER)`；Proxmox 内核默认不启用 Landlock。兜底：以外层容器为边界（§3.6 `container` 档）；想要更强的隔离，就在宿主机启用 Landlock，或者改用 Proxmox VM。

**事实核查对旧文的更正**（冲突处已在正文中改掉）：
- 五家 harness 都有 linux-arm64 构建，已在 aarch64 主机上实测。
- Docker 默认 seccomp profile 放行 `landlock_*` 三个系统调用，已核实。
- grok 的登录命令是 `grok login --device-auth`。
- Plus 档下 gpt-6-luna 每 5 小时约 350–3,000 条本地消息，额度足够开发测试使用（Luna 不进任何正式 preset，见 D2（修订））。原来的“约 15–160 条”是 gpt-6.1-sol 的数字。
- cc 的 `-p` 和 Agent SDK 仍然从订阅的普通额度池扣量，原先宣布的独立额度已暂停。
- cc 的 Haiku 是 `claude-haiku-5-5`，需要 ≥2.1.293。
- agy 的 Flash slug 是 `gemini-3.8-flash-{low,medium,high}`。agy 上的 Claude 4.6 和 GPT-OSS 于 2026-11-18 下架。

---

## 0. 定稿裁决摘要

**基座**沿用 RELIABILITY 的运行时正确性设计：
- agent 只能写 staging，编排器是唯一 committer；
- task id 按内容 hash 生成，promote 前做 stale check（区分 hard 和 soft 依赖）；
- commit trailer 用于崩溃恢复；
- nonce 证明指令已加载（首尾双 nonce，每个 run 随机生成）；
- harness 版本先 canary 再晋级；
- 按 (harness, version) 熔断，用比率阈值并要求最少样本数；
- 配额做准入控制。

在基座上嫁接两部分：
- **PRODUCT 的轻运维与 UX**：all-in-one 角色模式；nv-shim detached 运行，挂在容器内 supervisor 之下；Studio 模式；Inbox；按 harness 预览“agent 实际看到的内容”和“生效 gate 清单”；结构化 device-code 登录；blessed/probed/unknown 三档版本。
- **QUALITY 的写作方法**：卡片前置/后置条件与 knowledge 矩阵；held-out judge；写手 bake-off；pairwise 只保留更好的版本；扩写时出现新事件即拒绝；上下文包含 N−1、N−2 两章全文；`patterns.md` 和弧指纹防套路循环；伏笔上限与 closure capacity。高成本环节做成“质量档位”。按 D2（修订），默认档是 `standard`，`lite`、`key` 和各 opt-in 机制按书在 Web UI 选择。高级质量机制（stylometrics、指纹、best-of-N、MinHash）推迟到 P3 以后，并且必须有数据证明它确实在解决实际问题。

上一版的错误和本轮修订的裁决：

| 问题 | 裁决 |
|---|---|
| bwrap `--ro-bind / /` 会暴露整个 `$DATA` | 改为选择性绑定：先 `--tmpfs $DATA` 遮蔽，再只绑定本 run 需要的路径。上一版漏绑了 `$RUN`，导致所有 argv 引用的文件在沙箱内都不存在，本版补齐（§3.6）。run 目录拆成 `$RUN/in/`（只读）和 `$RUN/log/`（可写），另外只读绑定 `/opt/novelist`（gate 程序、自带 node、pi 扩展）。adapter 契约测试会检查每个 argv 路径在挂载表里可见，canary 必须在真实隔离后端里跑。 |
| 默认档完全依赖容器内嵌套 bwrap，而它在 Docker 默认 seccomp、masked `/proc`、Ubuntu 24.04 `apparmor_restrict_unprivileged_userns`、rootless 等环境下经常起不来 | 隔离做成多后端：`bwrap`（最强，可选）→ `landlock`（内核 ≥5.13，不需要特权，容器内默认可用档）→ `degraded`。`doctor` 会指出具体失败项并给出修复方法。degraded 档默认允许无人值守，但只允许没有 shell 的 harness（cc、grok、agy），并用事后审计和 git 回滚兜底（§3.6）。D3 的 Proxmox LXC 嵌套 Docker 环境下，bwrap 预期不可用，Landlock 取决于宿主机内核参数，所以新增 `container`（外层容器边界）档（§3.6、§10.2）。P0 出口条件包括在 Debian 12、Ubuntu 24.04、rootless podman、Debian 13 arm64、Proxmox LXC（Docker LXC）上实测通过。 |
| agent 只读挂载**活工作树**，committer 会在 run 期间改写它 | 每个 run 挂一份固定在 `base_commit` 的快照（`git worktree add --detach`，主 `.git` 只读挂入，内外路径一致）。committer 对每个仓库持有互斥锁，崩溃恢复只在持锁时执行。上一版“流水线不用 worktree”的裁决作废。 |
| side lane 因为派生文件每章都变而活锁 | manifest 分成 hard deps 和 soft deps。soft deps 变化时，在 HEAD 上重跑确定性 validators（rebase），通过就提交。卡片余量 ≤ min 时，写作 lane 让出一个提交窗口给 `plan.arc`（§7.2）。 |
| snapshot 和 views 每章都入库 | 派生文件**不入库**（gitignore）。由 ctx.build 按 `base_commit` 确定性生成到 run 快照里，commit 只带 `Novelist-Snapshot-Hash` trailer。实体文件里不再嵌入 progressions 区块。 |
| “所有流水线角色都禁用 shell” | 这条对 codex 和 dsh 不成立。capabilities 改为如实声明 `shellTool: disableable\|always`。对带 shell 的 harness，egress 白名单默认开启，写入审计以隔离边界加 out/ 文件清单为准，不依赖事件流。顺带利用 shell 提供沙箱内的 `nv count`（§3.5、§10.6）。 |
| 成本估算低了约 5–10 倍 | context pack **编译成一个文件**，cc、codex、dsh 内联进 stdin 的 work order，grok 走 `--prompt-file`，agy 和 pi 读一次文件。writer 目标 3–4 个 turn。修订默认新开 run，不 resume，因为跨章缓存已冷。容量估算改为来自 P0 实测账本。订阅账号以窗口吞吐（每 5 小时、每周可写章数）为主约束，API 账号按 USD 记账（§7.5）。 |
| per-beat 长度 hard gate 不收敛（agent 数不了字） | per-beat 长度降为 soft。hard 只保留总长区间（可覆盖）。所有 harness 都提供计数手段：Stop hook 回报、沙箱内 `nv count`、MCP `count_cjk`。长度类问题修订耗尽后 `accept_with_debt`，不 block（§6.5）。 |
| gates 和 lexicon 实际在用代码执行内容政策，压过用户指令 | gates 分两类：**I/O 契约 gate**（Novelist 固定）和**工艺 gate**（定义在题材包 `gates.yaml`，书层可逐条关闭、调阈值、加 allowlist）。lexicon 加 `allow:`，书层 allow 压过一切 ban（§6.5）。 |
| L4 角色层排在 L3 书层之后，导致题材或全局的 role 覆盖书层；owner 的单章笔记放在 user prompt | 按来源嵌套排序，最后一个作者块永远来自书层或 owner 本章笔记（L3.9），由 golden test 断言（§5.1）。 |
| 熔断太敏感（一次 permission_denied 就开） | 只看比率并要求最少样本数。run 内模型越权算 soft 事件。疑似问题先重跑一次 canary。主笔 harness 熔断要延迟生效并先发通知（§3.8）。 |
| 成功判定要求 `permission_denials==[]` | denial 只作遥测和违规计数。harness 层的 completed 只看终止事件和退出码，最终裁决由 validators 根据文件做出（§3.3）。 |
| grok 同时用 `streaming-json` 和 `--json-schema` | 保持上一版裁决：grok 不加 `--json-schema`，所有 harness 的 receipt 都以文件为准。 |
| grok 的 MCP、leader socket、`--agent` | 保持上一版裁决：MCP 走 `$GROK_HOME/config.toml`；每个 run 独立 `--leader-socket` **(verify)**；append 用 `--rules`。 |
| codex `developer_instructions` 用 `JSON.stringify` 生成 | JSON 字符串不总是合法的 TOML（U+007F、孤立代理项）。改用 TOML 库序列化，golden test 覆盖控制字符（§3.5）。 |
| 多份 receipt schema 用同一方言 | 按 harness 分别生成 strict 和 lenient 两种方言，probe 时实测各家是否接受（§5.5）。 |
| agy 每 run 临时 HOME | 声明 `resume:false`，修订一律新开 run。ADC 改用 `AGY_ADC_AUTH=true` 加 `GOOGLE_APPLICATION_CREDENTIALS` 指向只读绑定的凭据文件。按 D5，agy 照常启用；使用 consumer OAuth 时改为每账号持久 home（§3.7）。首次启动是否下载组件 **(verify)**；如果会下载，改为每账号持久 home，按模板重写 settings，同账号并发设为 1（§3.5）。 |
| dsh 的 `{{var}}` 模板会因用户文本里的 `{{` 失败 | 物化器转义 `{{`（转义语法 **(verify)**）。转义不可行时，预算器标记该 profile 不兼容并在 UI 提示。headless profile 在 install 时预物化，运行时禁止访问 npm registry（§3.5）。 |
| PATH 缺 node | 每个 harness 版本目录自带锁定到次版本的 node，并软链进 `bin/`（§3.5）。 |
| 账号 home 可写，agent 可以篡改 hooks/config 并影响后续 run | home 拆成**配置部分**（每 run 重新生成；bwrap 档只读覆盖，landlock 档 run 后做 hash 校验）和**状态部分**（可写）（§3.6）。 |
| `RLIMIT_AS=4G` 会让 V8/Bun 崩溃 | 不使用 RLIMIT_AS。容器档靠 `mem_limit` 加每账号并发上限；只限制 `RLIMIT_NPROC` 和 `RLIMIT_FSIZE`（§3.6）。 |
| all-in-one 下 shim 无法重新挂接 | 引入 `novelist supervise` 作为 tini 唯一的子进程，shim 挂在它下面。如实写明：容器重启会丢掉每条 lane 当前的 run（§2.3）。 |
| bwrap 不转发信号 | 用 `--info-fd` 拿到沙箱内子进程的外层 pid，shim 直接对它和它的进程组发信号（§2.3）。 |
| idle 超时一刀切 | 按 adapter × 角色分别配置，writer 至少 15–20 分钟。cc 可开 `--include-partial-messages` 作心跳，事件采样落盘（§2.3）。 |
| 网页 PTY 登录 | 原裁决是删除，改为结构化 device-code 流程。D5 改回：网页“交互登录”spawn harness 的登录命令，输出流式显示在 UI，带输入框；cc token 可以在网页录入并加密入库（§3.6、§3.7）。 |
| MCP 挂在对外监听器上 | 改为独立的内部监听器（unix socket 或 127.0.0.1），对外监听器上不注册 `/mcp`（§8）。 |
| 厂商约束要求的厂商数超过多数用户实际拥有的 | 定义确定的降级阶梯，lane 不停。开书时做路由可行性检查（§7.4）。 |
| 工程量过大 | P1 收缩到最小闭环：cc、codex 两个 adapter，回放 fixture 加通用 fake，只支持 Postgres，不做 MCP，gate 只做最小集。其余按数据推进（§12）。 |
| “单二进制” | 更正：是一个 Node 程序 `novelist`，外加两个极小的辅助二进制（`nv-shim`、`nv-jail`）。 |
| SQLite FTS5 trigram 查不到两字人名 | 保持上一版裁决：jieba BM25 + 别名 Aho-Corasick（支持歧义标记）+ ripgrep。 |
| 不写 project CLAUDE.md；work/ 被 gitignore | 保持。work order 列出完整路径；grok `read_file` 能否读 gitignore 路径 **(verify)**。 |
| dsh AGENTS.md 只是 guidance；Gemini CLI 与 pi 的认证说法 | 保持上一版更正。 |
| 数据库 | 默认 Postgres。PGlite 推迟到 P3 以后（单连接限制见 §10.1）。由用户拍板（§13）。 |
| MCP | 正确性只依赖文件。只读 MCP 是可选加速器，P3+ 交付，默认 `auto`。 |

---

## 1. 愿景与非目标

### 1.1 愿景

Novelist 2.0 是一个可以自托管、长期无人值守运行的超长篇中文网文工厂兼阅读室。单本书规模为数百到数千章、1–5M 汉字。它驱动用户手里已有的 vendor harness 来写作：Claude Code（cc）、Codex CLI（codex）、DeepSeek Harness（dsh）、Antigravity CLI（agy）、Grok Build（grok），pi 可选。章节写完后按连载节奏发布到网页阅读器。

设计不变量（按优先级排列）：

1. **文件是真相，编排器独占提交。** agent 只能写本次 attempt 的 `out/`。编排器负责校验、promote、提交和打 tag。stdout 只用作遥测和 receipt 的备用通道，绝不当作正文来源。
2. **外层确定，内层自主。** 确定性状态机掌管调度、校验、重试、配额和提交。每个 harness 进程只领一张有界的 work order。
3. **任务幂等，崩溃无聊。** task id 是输入内容的 hash，promote 走两阶段协议，以 commit trailer 为键。任何时刻 kill 任何进程，最多丢失正在跑的那一个 run。
4. **契约由校验器保证。** I/O 契约（路径、schema、编码、非空、未截断）由代码强制执行，与内容无关。**工艺规则**（长度、标记、重复、lexicon）也由代码执行，但规则属于用户可编辑的题材层和书层，可以逐条覆盖。
5. **用户指令不透明、层级最高。** Novelist 不改写、不过滤用户指令，把它们放在每个 harness 能给到的最高位置，并且书层永远排在最后。用首尾 nonce 证明指令被完整加载。所有角色（包括评审）都加载作者层，并以作者层为评判标准。
6. **把每个 harness 当作会漂移的外部依赖。** 版本锁定、能力探测、canary 晋级、按比率熔断，对未知事件保持容忍。模型串变化视为写手变更事件。
7. **配额是一等资源。** 账号类型（订阅、API key、自建网关）由用户在 Web UI 配置（D2 修订、D5）。订阅账号按 5 小时窗口和每周窗口做准入与预留，为主人的交互使用保留余量，按实测账本估算每个窗口能写几章。API 账号按 USD 记账，受上限约束。
8. **运维简单优先。** 默认一个容器加 Postgres。隔离后端按主机能力自动选择，任何一种主机上都能跑起来。

### 1.2 非目标

- 不做通用编码 agent 编排器或 LLM 网关。正文不直接调用模型 API；直连 API 只用于可选的封面和 embedding 插件。
- 不使用 harness 内部的长循环（`/goal`、`/loop`、agent teams 托管整本书、dsh 委托 cc/codex）。
- 不做多租户 SaaS：一个 owner 加任意数量的只读读者。
- Novelist 不带内容审核层。指令文件和题材包归用户所有，原样传递。厂商侧的拒答统一归为 `refusal`。
- 不做 TUI 抓屏、tmux 驱动或网页终端。
- 核心不含向量库。
- 一本书内部不并行写章。

---

## 2. 系统架构

### 2.1 组件与进程模型

产物包括一个 Node 程序 `novelist`，以及两个极小的辅助二进制（静态 Go 编写）：
- `nv-shim`：进程监管；
- `nv-jail`：Landlock 和 rlimit 启动器。

`novelist` 包含以下角色：

| 角色 | 职责 | 拆分方式 |
|---|---|---|
| `supervise` | 容器内 tini 的唯一子进程。负责拉起 serve 并在崩溃后重启，同时作为 shim 的 subreaper。代码极少，几乎不变 | 仅容器档使用 |
| `web` | 读者 API、管理 API、SSE、导出缓存、静态 SPA。**对外监听器** | `--roles web`，无状态，可多副本 |
| `orchestrator` | 状态机、DAG、调度、配额；确定性 worker（context pack、validators、delta check、fold、views、committer、publisher、indexer）；**内部监听器**（MCP，unix socket 或 127.0.0.1） | 用 `pg_advisory_lock` 选主 |
| `runner` | 认领 run、准备 run 快照和 home、启动 `nv-shim`、tail 输出、续租 lease | `novelist runner`，可多副本、多主机 |
| `cli` | 通过 PAT 调用 web API；`--local` 走 unix socket | — |

各角色之间只通过 Postgres、文件系统和内部 socket 通信，all-in-one 模式也不例外。

### 2.2 总体图

```
 readers ─https(Caddy/反代/LAN-http)─┐                          ┌─ owner（Admin UI / CLI(PAT) / Studio）
                                     ▼                          ▼
tini ─► novelist supervise ─► novelist serve (Node 24)
┌────────────────────────────────────────────────────────────────────────────────────┐
│ [web] 对外 :8000  Fastify + SPA · reader/admin API · SSE · export cache            │
│ [orchestrator] DAG · scheduler · quota · validators · delta-check · fold · views   │
│     · COMMITTER（每仓库互斥锁） · publisher · indexer · [内部] MCP(unix sock)       │
│ [runner] claim(SKIP LOCKED) · git worktree@base_commit · prepare home · spawn shim │
└──────┬───────────────────────────┬───────────────────────────────┬─────────────────┘
       │SQL                        │ git（唯一 committer，持锁）     │ setsid（父=supervise）
┌──────▼───────┐       ┌───────────▼─────────────┐     ┌───────────▼──────────────────────┐
│ Postgres 17  │       │ $DATA/books/<slug>/ live│     │ nv-shim → 隔离后端                │
└──────────────┘       │ .git ──ro──┐            │     │  bwrap | nv-jail(landlock) | none │
                       └────────────┼────────────┘     └───────────┬──────────────────────┘
                                    ▼                              ▼
                 $RUN/book（worktree@base_commit，只读）+ work/<task>/attempt-k/out（可写）
                 + $RUN/in（只读）+ $RUN/log（可写）+ 账号 home（配置只读/状态可写）
                 + /opt/harness/<id>/<ver>（只读，自带 node）+ /opt/novelist（只读）
                   claude | codex | agy | grok | dsh | pi | acp | fake
                                    ▼ egress 白名单代理（带 shell 的 harness 默认开）→ vendor APIs
```

### 2.3 nv-shim、lease 与重启语义

- runner 用 `setsid` 启动 `nv-shim --spec $RUN/in/spec.json`，stdio 重定向到文件。shim 的父进程是 `supervise`，不是 serve。shim 的职责如下：
  1. 启动隔离后端和 harness。bwrap 档使用 `--info-fd 3`，读出沙箱内 harness 在外层命名空间中的 pid，写入 `$RUN/log/pid`。landlock 档由 `nv-jail` 直接 exec，pid 就是 harness 本身。
  2. stdout 写 `$RUN/log/stdout.ndjson`，stderr 写 `$RUN/log/stderr.log`。
  3. 执行 wall 超时和 idle 超时。**idle 阈值按 adapter × 角色配置**：

     | 角色 | 默认 idle 阈值 |
     |---|---|
     | writer | 20 分钟 |
     | reviewer / extractor / checker | 10 分钟 |
     | dsh 全部角色 | 15 分钟以上 |

     cc 的 writer 可以开 `--include-partial-messages` 作为心跳。parser 把 delta 折叠成 heartbeat，原始 delta 采样落盘（每 5 秒最多 1 行），防止 stdout 膨胀。
  4. 信号**直接发给 harness 的 pid 及其进程组**，不发给 bwrap，因为 bwrap 不转发信号 **(verify)**。cc 先 SIGINT，30 秒后 SIGTERM，再 SIGKILL；grok 的 SIGTERM 宽限 ≥25 秒（`GROK_EXIT_TIMEOUT_SECS` 默认 20）。fake-harness 有对应的信号测试用例。
  5. 退出时原子写入 `$RUN/log/exit.json`。
- runner tail 输出文件，把事件归一化后写入 `run_events`，每 10 秒续租一次（TTL 60 秒）。
- **serve 崩溃或重启**：supervise 重新拉起 serve。shim 仍然存活，新的 runner 扫描 `runs/active/*`（指向 `runs/YYYY-MM/<id>` 的软链），pid 和启动时间都匹配时就重新接管。
- **容器重启或镜像升级**：所有 shim 都会被杀，每条 lane 最多丢一个 run，按幂等规则重跑。这一点如实写进文档。想做到零中断有两种做法：一是把 runner 拆成一个很少升级的独立容器（`--roles runner`），web 和 orchestrator 单独升级；二是用宿主机 runner。
- 任何数据库事务都不跨越模型调用。

### 2.4 技术栈：TypeScript / Node 24 LTS

| 选项 | 结论与理由 |
|---|---|
| **TypeScript / Node 24** | **采用**。harness 都通过 npm 分发；dsh 要求 Node ≥24.9；TS SDK 覆盖最全；前端、API、编排器共用一套 zod schema |
| Python 3.12 | 否。会出现两套语言和两套运行时 |
| Go | 只用于两个极小的辅助二进制：`nv-shim`、`nv-jail`（基于 `go-landlock`）。原因是它们需要静态链接、启动快，还要直接做 `prctl` 和 landlock 系统调用 |
| Rust | 否 |

具体选型：
- 工程：pnpm monorepo、ESM、`tsx`/`tsc`；`zod` + `zod-to-json-schema`（按 harness 生成不同方言的 schema）。
- 数据：`drizzle-orm` + `drizzle-kit`，驱动 `pg`。
- 服务端：Fastify 5。
- 前端：React 19、Vite、TanStack、Tailwind v4、CodeMirror 6。
- 中文与检索：`@node-rs/jieba`、`better-sqlite3`（FTS5，每本书一个，可重建）。
- 系统工具：`git`、`bubblewrap`（可选）、`ripgrep`、`tini`。
- 运维与加密：`pino`、`prom-client`、`libsodium-wrappers`、`@iarna/toml`（或同类 TOML 序列化库）。

### 2.5 Monorepo 布局

```
packages/
  core/          zod schema（全部规范文件，见附录 A）、CJK 计数、id、hash、nv.predicate
  state/         fold → snapshot、投影 snapshot、delta-check、views、overrides、级联复核
  validators/    contract gates、craft gates（gates.yaml 驱动）
  context/       context-pack 编译器（单文件）、alias index、BM25(jieba)
  instructions/  层解析、预算器、各 harness 物化器、首尾 nonce
  adapters/      claude-code codex agy grok dsh pi acp fake
  shim/ jail/    nv-shim、nv-jail（Go）
  runner/        隔离后端选择、run 快照、home 组装、tail/归一化
  orchestrator/  DAG、scheduler、quota、commit protocol、publisher、audits、inbox
  db/ api/ web/ cli/
  gate-cli/      nv gate / nv count（预编译单文件，供 hook 和沙箱内使用）
genres/          内置题材包
fixtures/<harness>/<version>/*.ndjson
```

---

## 3. Harness 适配层

### 3.1 类型化接口

```ts
type HarnessId = 'claude-code'|'codex'|'agy'|'grok'|'dsh'|'pi'|`acp:${string}`|'fake';

interface HarnessInstall { id: HarnessId; version: string; binPath: string; nodeVersion?: string; sha256: string;
                           sha256Source: 'tofu'|'upstream-lock';
                           tier: 'blessed'|'probed'|'unknown'; status: 'candidate'|'canary'|'active'|'disabled'; }

interface Capabilities {                       // probe() 产物，按 (harness, version, isolation) 缓存
  version: string; verifiedAt: string; isolation: 'bwrap'|'landlock'|'container'|'degraded';
  models: string[]; modelSnapshotIds?: Record<string,string>;
  structuredOutput: 'native'|'none'; schemaDialect: 'strict'|'lenient'|'none';
  systemChannel: 'append-file'|'developer'|'rules-arg'|'agent-file'|'persona-patch'|'append-arg';
  systemReplace: boolean;
  shellTool: 'disableable'|'always';           // codex、dsh(danger-full-access) = always (verify codex 关闭键)
  webTool: 'disableable'|'always'; subagentTool: 'disableable'|'always';
  honorsHttpsProxy: boolean;                   // egress 代理是否生效（canary 实测）
  workspaceDocLoaded: boolean; systemChannelLoaded: boolean; tailNonceSurvives: boolean;
  maxInstructionBytes?: number;
  sessionPreassign: boolean; resume: boolean; fork: boolean;   // agy: resume=false
  stopHook: 'verified'|'unverified'|'none'; mcpHttp: 'verified'|'unverified'|'none';
  exitZeroOnFailure: boolean; quotaSignal: 'inline'|'probe'|'error-only'|'none';
  templateEscaping?: 'braces-escaped'|'incompatible';          // dsh
  eventTypesSeen: string[];
}

interface RunSpec {
  runId: string; taskId: string; attempt: number; role: RoleId; taskKind: TaskKind;
  runDir: string;                              // $RUN = $DATA/runs/YYYY-MM/<id>
  bookDir: string;                             // $RUN/book：git worktree@base_commit，只读；cwd
  outDir: string;                              // $RUN/book/work/<task>/attempt-<k>/out，可写
  inDir: string; logDir: string;               // $RUN/in 只读；$RUN/log 可写
  workOrderFile: string;                       // 含内联的编译 context pack
  systemFile: string;                          // $RUN/in/system.md（首尾 nonce 只在这里）
  receiptSchemaFile: string;                   // 按 schemaDialect 生成
  model: string; effort?: string;
  limits: { wallMs: number; idleMs: number; maxTurns: number; maxBudgetUsd?: number };
  session: { mode: 'fresh'; id: string } | { mode: 'resume'|'fork'; id: string };
  persistSession: boolean;
  home: { stateDir: string; configFiles: {path:string; content:string}[] };
  secretsEnv: Record<string,string>;
  egress: { proxy?: string; allow: string[] };
  mcp?: { socket: string; token: string };
  subagents: boolean;
}

interface Invocation { argv: string[]; env: Record<string,string>; cwd: string;
                       stdin: 'devnull'|{file:string};
                       readPaths: string[]; writePaths: string[];   // 供挂载可见性契约测试
                       stop: {signal:'SIGINT'|'SIGTERM'; graceMs:number}[] }

interface HarnessAdapter {
  id: HarnessId; supportedVersions: string;
  prepareHome(acct: Account, inst: HarnessInstall, spec: RunSpec): Promise<HomeLayout>;   // 配置每 run 重生成
  materialize(spec: RunSpec, stack: InstructionStack, caps: Capabilities): Promise<MaterializeReport>;
  buildInvocation(spec: RunSpec, caps: Capabilities): Invocation;
  createParser(spec: RunSpec): StreamParser;
  classify(exit: ExitInfo, events: NEvent[], stderrTail: string): Outcome;
  quotaProbe?(acct: Account): Promise<QuotaSnapshot|null>;
  probe(inst: HarnessInstall, acct: Account): Promise<Capabilities>;
  login?(acct: Account, method: AuthMethod): AsyncIterable<LoginStep>;   // 结构化 device-code，无 PTY
  gcHome?(acct: Account, olderThan: Date, keep: string[]): Promise<void>;
}
```

`Outcome` 的结构为 `{status, errorClass?, retryAfter?, sessionId?, model?, usage, denials[], receipt?}`。`completed` 只说明 harness 自认为已经完成。是否验收一律由 validators 根据文件决定。

**挂载可见性契约测试**（CI 必跑）：对 `buildInvocation` 产出的每个 argv 路径、env 里的路径，以及 `readPaths`/`writePaths`，逐一断言它们在当前隔离后端的挂载表或 Landlock 规则中可见；harness 会写的路径，额外断言可写。pi 的 `--append-system-prompt` 和 agy 的 `--json-schema` 都接受“字符串或文件”，文件不存在时会被当成字面文本，造成静默错误，所以 runner 在 spawn 之前会再检查一遍这些文件是否存在。

### 3.2 归一化事件 schema

```ts
type ErrorClass = 'auth'|'quota'|'rate_limit'|'overloaded'|'billing'|'model_unavailable'|'network'
  |'timeout_wall'|'timeout_idle'|'refusal'|'context_overflow'|'max_turns'|'budget'
  |'permission_denied'|'sandbox'|'config'|'drift'|'harness_crash'|'output_contract'|'unknown';

type NEvent = { seq: number; ts: string; runId: string } & (
 | { t:'init'; sessionId?:string; model?:string; version?:string; tools?:string[];
     memoryPaths?:string[]; mcp?:{name:string; ok:boolean}[] }
 | { t:'text'; channel:'assistant'|'thinking'; delta:string }
 | { t:'tool_call'; id:string; name:string;
     kind:'read'|'write'|'edit'|'search'|'list'|'exec'|'mcp'|'subagent'|'web'|'other';
     paths?:string[]; command?:string }
 | { t:'tool_result'; id:string; ok:boolean; error?:string }
 | { t:'file_change'; path:string; op:'add'|'update'|'delete'; ok:boolean }
 | { t:'usage'; input:number; cachedInput?:number; cacheWrite?:number; output:number; reasoning?:number;
     costUsd?:number; costSource:'harness'|'computed'|'unknown'; scope:'delta'|'total' }
 | { t:'rate_limit'; window:'5h'|'7d'|'daily'|'minute'|'other'; utilization?:number; resetsAt?:string;
     status:'allowed'|'warning'|'rejected' }
 | { t:'retry'; attempt:number; delayMs?:number; cls:ErrorClass }
 | { t:'compaction' }
 | { t:'denial'; tool:string; path?:string; detail?:string }      // 遥测，不决定成败
 | { t:'subagent'; id:string; phase:'start'|'stop'; role?:string }
 | { t:'error'; cls:ErrorClass; message:string; retryable:boolean }
 | { t:'result'; status:'success'|'error'|'max_turns'|'refusal'|'cancelled'|'timeout';
     stopReason?:string; sessionId?:string; structured?:unknown; turns?:number }
 | { t:'unknown'; rawType:string }
 | { t:'heartbeat'; source:'stdout'|'stderr'|'partial' } );
```

解析规则：
- 只按 LF 切行，并持续读取。
- 未知类型不导致 run 失败。缺少终止事件判为 `drift`。
- 原始流用 zstd 归档，保留策略见 §10.1。

### 3.3 成功判定

**harness 层的 completed 只看终止事件和退出码**，denial 只是遥测：

| harness | `completed` 条件 | exit 0 但实际失败的情况 |
|---|---|---|
| cc | `result.subtype=='success'`、`stop_reason≠'refusal'`、exit 0 | Manual 模式静默拒写，所以固定设置 mode |
| codex | 最后一个事件是 `turn.completed`、exit 0 | 沙箱写入失败时仍 exit 0（#46246），所以 outDir 下有 `file_change.failed` 时判 `sandbox` |
| agy | `result.status=='SUCCESS'`、没有 `finished_reason`、exit 0 | soft-deny 时 exit 0 |
| grok | `end.stopReason=='end_turn'`、exit 0 | 未授权时 exit 0 |
| dsh | exit 0 且 `final.reason.kind=='completed'`、没有 `error` 事件 | — |
| pi | 有 `agent_settled` 且 `aborted=false`，最后一条 `stopReason ∉ {error, aborted, length}` | JSON 模式下失败也 exit 0 |

然后由文件 validators 做最终裁决：
- 产物齐全、通过校验，就验收。期间出现的 denial 只记入该 profile 的“合同违规计数”，作为熔断的比率输入之一，见 §3.8。
- 产物缺失，并且有 denial 正好落在 outDir 路径上，判为 `permission_denied`，这是配置缺陷。
- 产物缺失，但没有这类 denial，判为 `output_contract`。

### 3.4 驱动选择

| harness | 主驱动 | 备用（profile 设置 `driver: spawn\|acp`） |
|---|---|---|
| cc | spawn `claude -p --output-format stream-json --verbose` | `claude-agent-acp` |
| codex | spawn `codex exec --json`（app-server 只作配额侧信道） | `codex-acp` |
| agy | spawn `agy -p … --output-format stream-json` | `agy acp` |
| grok | spawn `grok --prompt-file`，`streaming-json` | `grok agent stdio` |
| dsh | spawn `dsh --profile headless --json`。`--json` 是否存在 **(verify)**，不存在就改走 ACP | `dsh --profile acp` |
| pi | spawn `pi --mode json` | `--mode rpc` |
| 长尾 | 通用 ACP | — |

### 3.5 命令模板

**公共约定：**
- 环境变量用 `env -i` 起步，按白名单添加：
  - `PATH=/opt/harness/<id>/<ver>/bin:/opt/novelist/bin:/usr/bin`。每个 harness 版本目录自带锁定到次版本的 node，并软链进 `bin/`。probe 第 1 步在沙箱内执行 `node --version`，校验是否满足 engines 要求（dsh 要求 ≥24.9）。
  - `LANG=C.UTF-8`、`TZ`。
  - 带 shell 的 harness 额外设置 `HTTPS_PROXY`/`NO_PROXY`。`container` 档下 runner 容器只接入 internal 网络，所有 harness 都必须经代理出网（§10.2.1）。
  - adapter 自己的变量。
- `cwd = $RUN/book`（只读快照）。
- **work order = 任务说明 + 内联的编译 context pack**（§6.3），默认上限 65k 汉字。cc、codex、dsh 走 stdin（远低于 10MB），grok 走 `--prompt-file`。agy 的 `-p` 是 argv，受单元素 128KiB 上限限制，pi 同理，所以这两家只传一句短指令：“Read `<workorder 路径>` and execute it”。完整文件仍放在 `work/<task>/workorder.md`。
- **工具面如实声明**：

  | harness | 能否关闭 shell/web/子代理 | 做法 |
  |---|---|---|
  | cc | 能 | `--tools`/`--disallowedTools` |
  | grok | 能 | `--disallowed-tools` |
  | pi | 能 | `--tools` |
  | agy | 部分能 | `permissions.deny` 完整列表，见下 |
  | codex | shell 不能（关闭键 **(verify)**）；web 和子代理用配置关闭 | 见下 |
  | dsh | `danger-full-access` 下有 shell；其余用 patch 行关闭 | 见下 |

  对 `shellTool: always` 的 profile：egress 白名单默认开启；写入审计以隔离边界和 out/ 文件清单为准；沙箱内提供 `nv count <file>`（只读计数）。路由器默认不让这类 profile 承担读取不可信文本的角色（`import.*` 的 bootstrap extract、处理用户样本的任务），除非用户显式允许（§13）。

**cc**（Tier 1，锁定 2.1.319）

```sh
HOME=$H CLAUDE_CONFIG_DIR=$H/.claude CLAUDE_CODE_PROJECT_DIR_NAME=$SLUG DISABLE_AUTOUPDATER=1 \
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"   # 订阅模式，$TOKEN 由账号加密存储解出；env -i 保证不带 ANTHROPIC_API_KEY。自定义 API 模式见下
claude -p --output-format stream-json --verbose [--include-partial-messages]   # writer：心跳
  --session-id $RUN_UUID \
  --model <dated snapshot id 优先> --effort high \
  [--fallback-model …]              # 仅非 writer
  --permission-mode acceptEdits --permission-prompts none \
  --tools "Read,Write,Edit,Glob,Grep" --disallowedTools "Bash,WebFetch,WebSearch,Agent" \
  --setting-sources project --strict-mcp-config [--mcp-config $RUN/in/mcp.cc.json] \
  --settings $RUN/in/cc.settings.json \
  --append-system-prompt-file $RUN/in/system.md \
  --json-schema "$(cat $RUN/in/receipt.strict.json)" \
  --max-turns 40 [--max-budget-usd 6] [--no-session-persistence] \   # --max-budget-usd 只在 API 模式下有意义
  < $RUN/in/workorder.md
```

- **订阅模式**：
  - 绝不加 `--bare`，因为它不读 OAuth token。
  - `-p` 模式下只要存在 `ANTHROPIC_API_KEY`，它就优先于 OAuth token，会静默切到 API 计费。adapter 因此断言 env 里没有这个变量。probe 用 `rate_limit_event` 是否出现来确认请求走的是订阅额度池。
- **自定义 API 模式**（D5）：用户可以只用 cc 接自己的网关。账号 env 设 `ANTHROPIC_BASE_URL`，加 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，模型名可以自定义。这种模式下不设 `CLAUDE_CODE_OAUTH_TOKEN`，上面“env 里不得有 `ANTHROPIC_API_KEY`”的断言只对订阅模式生效。
- **Haiku 只用于开发测试**（D2 修订，`dev-cheap` preset）：`--model claude-haiku-5-5` 需要 ≥2.1.293，当前锁定版本满足：
  - 思考无法关闭，effort 默认 medium；
  - 超过 100K token 的 prompt 单价更高，所以它的 work order 只带待校验文件和 schema，不带 context pack。

- `cc.settings.json` 设置 `blockWrites/ReadsOutsideWorkingDirectories`、`cleanupPeriodDays:14`，以及 `hooks.Stop: /opt/novelist/bin/nv gate --quick --report`。这个 hook 用预编译的单文件，会回报每个 beat 的实测字数和总字数。
- probe 必须实际触发一次 Stop 拦截。
- plan workshop 例外：允许 `Agent` 加 `--agents`。

**codex**（Tier 1，锁定 0.167.0）

```sh
HOME=$H CODEX_HOME=$H/.codex HTTPS_PROXY=$EGRESS \   # 订阅：$H/.codex/auth.json（ChatGPT 登录）；CODEX_API_KEY 只在 API key 模式下设置
codex exec --json --color never --skip-git-repo-check -C $RUN/book \
  -m <model> -c model_reasoning_effort="high" \
  -c developer_instructions=<TOML 库序列化的 basic string>   # 单个 argv 元素；≤100KB
  --dangerously-bypass-approvals-and-sandbox \               # 只在我们的隔离后端内
  --output-schema $RUN/in/receipt.strict.json -o $OUT/last-message.json \
  [--ephemeral] - < $RUN/in/workorder.md
```

- `developer_instructions` 用 TOML 库序列化：U+007F 和其他控制字符转义为 `\uXXXX`。读入时按 UTF-8 解码，不可能产生孤立代理项，但仍有断言兜底。golden test 覆盖 DEL、控制字符、超长行和 `"""`。
- `config.toml` 每个 run 由 `prepareHome` 重新生成：
  - `project_doc_max_bytes = 262144`、`project_doc_fallback_filenames = []`
  - `[memories] enabled = false`、`agents.enabled = false`、`web_search = "disabled"`（键名 **(verify)**）
  - 关闭 shell 的 `[features]`/`[tools]` 键 **(verify)**
  - 自定义 provider 写 `wire_api = "responses"`
- bwrap 档把这份 `config.toml` 只读覆盖到 `$H/.codex/config.toml`。landlock 档在 run 前原子重写，run 后做 hash 校验。
- 修订默认新开 run。只有会话不超过 30 分钟时才 `exec resume`，因为缓存还热。
- **模型选择**（D2 修订）：
  - 模型由路由决定。内置 preset 里 check 类角色走 `gpt-6.1-terra`（需要 CLI ≥0.159.0）。`gpt-6-luna` 只用于开发测试（`dev-cheap` preset），`model_reasoning_effort` 取 `low` 或 `medium`。
  - Codex 经常下线模型：`gpt-5.4-mini` 于 2026-08-31、`gpt-5.5` 于 2026-10-14 退出 ChatGPT 登录。所以 worker 启动时要列出模型、核对 slug，不匹配就让该 profile 不可用并通知。
  - Enterprise/Edu 账号需要管理员先开启 Luna。

**agy**（Tier 1，锁定 1.5.3，`resume:false`。默认 preset 走这个 harness。按 D5，consumer 订阅 OAuth 照常使用，UI 只显示风险说明；也可以在账号里配置 `GEMINI_API_KEY` 或 ADC，见 §3.7）

```sh
cd $RUN/book && HOME=$AGY_HOME GEMINI_API_KEY=$KEY \   # API key 模式；settings 需 "modelProvider":"gemini"。ADC：AGY_ADC_AUTH=true GOOGLE_APPLICATION_CREDENTIALS=$RUN/in/adc.json（只读绑定）。consumer OAuth：不设 key，用每账号持久 $AGY_HOME
agy -p "Read $WORK/workorder.md and execute it." \
  --output-format stream-json --json-schema $RUN/in/receipt.lenient.json \
  --model <caps.models 中的 slug> --effort high --agent nv-<role>-<stackhash8> \
  --print-timeout 40m --log-file $RUN/log/agy.log --dangerously-skip-permissions
```

- `$AGY_HOME` 在 API key 或 ADC 模式下每 run 由模板生成，consumer OAuth 模式下为每账号持久 home（keyring 里的 OAuth 不一定跟随 HOME 变化）。settings.json 写入：
  - `trustedWorkspaces:[$RUN/book]`
  - `permissions.deny:["command(*)","write_file(.git/)","search_web(*)","read_url_content(*)","invoke_subagent(*)","generate_image(*)"]`（工具名 **(verify)**）
- 首次启动是否下载运行时组件 **(verify)**。如果会下载，改为每账号一个持久 `$AGY_HOME`：每个 run 前按模板重写 settings，同账号并发设为 1，或者对 settings 加文件锁。
- 退出码映射：1/2 → `config`，3 → `overloaded`/`timeout_wall`，安全过滤 → `refusal`。
- 外部 watchdog 必须开启（#318）。
- 默认模型是 Gemini 4 Argon（slug 在 UI 中配置，占位值 `gemini-4-argon`，以 `agy models` 的列表为准）。`gemini-3.8-flash-low`（或 `-medium`）只用于开发测试（`dev-cheap` preset）。`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium` 于 2026-11-18 从 agy 下架，routing 不得引用它们。worker 启动时执行 `agy models` 核对 slug。

**grok**（Tier 1，锁定 1.0.77）

```sh
HOME=$H GROK_HOME=$H/.grok GROK_DISABLE_AUTOUPDATER=1 GROK_FOLDER_TRUST=0 \   # 订阅：$GROK_HOME 中缓存的 OAuth 登录，它优先于 XAI_API_KEY
GROK_CLAUDE_*_ENABLED=0 GROK_CURSOR_*_ENABLED=0 GROK_MEMORY=0 GROK_WEB_FETCH=0 GROK_SUBAGENTS=0 \
grok --no-auto-update --prompt-file $RUN/in/workorder.md --cwd $RUN/book \
  --output-format streaming-json -m <model> --reasoning-effort high \
  --always-approve --disallowed-tools "run_terminal_cmd,web_search,web_fetch,task" \
  --no-subagents --disable-web-search --no-wait-for-background --max-turns 40 \
  --leader-socket /tmp/grok-leader.sock -s $RUN_UUID \
  --rules "$(cat $RUN/in/system.md)"
```

- hook 写在 `$GROK_HOME/hooks/novelist.json`：`timeout: 30`，`failClosed: false`（只作优化）。默认超时 5 秒、fail-open，必须显式改。probe 实测 hook 确实触发、确实拦截。
- 以下两点列入 P0：
  - `GROK_HOME` 下 hooks 和 config 的实际查找路径 **(verify)**；
  - `read_file` 能否读取被 gitignore 的 `work/` **(verify)**。不能的话，grok 的 work order 改放在 `$RUN/in`（不受 ignore 影响），或者生成 `.ignore` 例外。
- 每个 (version, book) 做一次 preflight：`grok inspect --json`。花费只从 `end` 事件取。

**dsh**（Tier 2，锁定 0.2.2-rc.1）

```sh
HOME=$H DSH_HOME=$H/.dsh DSH_AGENTS_HOME=/opt/harness/dsh/$VER/agents DSH_TELEMETRY_MODE=DISABLED \
DEEPSEEK_API_KEY=$KEY HTTPS_PROXY=$EGRESS npm_config_offline=true \
dsh --profile headless --json --permission-mode danger-full-access --approval-policy never \
  --patch $RUN/in/dsh.patch.yml - < $RUN/in/workorder.md
```

- headless profile 及其依赖在 `harness install` 时预物化到 `/opt/harness/dsh/<ver>`。运行时 npm registry 不在 egress 白名单里。
- `dsh.patch.yml` 用 YAML 库生成，整行写完整：
  - `system-prompt.personaSuffix`：放作者层。其中的 `{{`/`}}` 按 dsh 模板语法转义 **(verify)**。如果无法转义，就在预算阶段把该 profile 标为 `templateEscaping: incompatible`，在 UI 提示后跳过。
  - 关闭 shell 之外能关的行：subagent、Agent Teams、workflow、`dsh-subagent-*` 委托（行名 **(verify)**）。
  - `session-log-deepseek{enabled:false}`，每个 run 校验一次。这一项上游默认开启，必须关。
- dsh 只能用 API key，没有官方订阅。按 D5 启用，用户在 Web UI 填 `DEEPSEEK_API_KEY`，可以设月度 USD 上限（§3.7）。

**pi**（Tier 2，锁定 1.5.0，P4）

```sh
pi --mode json --approve --model <provider/id> --session-id nv-$RUN --tools read,write,edit,grep,find,ls --no-mcp \
   --append-system-prompt $RUN/in/system.md -e /opt/novelist/pi-ext/nv-guard.ts \
   "Read $WORK/workorder.md and execute it." </dev/null
```

pi 没有自带沙箱，只在 bwrap 或 landlock 档运行，degraded 档拒绝运行。

**fake**：P1 只提供一个“通用 fake adapter”，有自己的简单 flags，外加 fixture 回放 parser 测试。仿冒各家 CLI 的 flags 和 wire format 推迟到 P3 以后。

### 3.6 隔离：后端、HOME 与账号

**后端选择**（`doctor` 和 runner 启动时自动探测，取可用的最强档，并记录到每个 run）：

| 档 | 条件 | 机制 | 备注 |
|---|---|---|---|
| `bwrap` | 非特权 userns 可用（宿主机，或容器设置了 `systempaths=unconfined` 加自定义 seccomp/apparmor） | mount namespace 选择性绑定；可选 `--unshare-net` 加代理桥 **(verify)** | 最强档。Docker 默认 seccomp 只在有 `CAP_SYS_ADMIN` 时才放行 `unshare`、`setns`、带命名空间标志的 `clone`/`clone3`（已核实），所以默认配置下起不来。**Proxmox LXC 嵌套 Docker（Docker LXC）下预期不可用** |
| `landlock` | 内核 ≥5.13，**内核 LSM 列表里启用了 landlock**，并且容器的 seccomp 放行 landlock 系统调用（Docker 默认 profile 已放行 `landlock_create_ruleset`、`landlock_add_rule`、`landlock_restrict_self`，已核实） | `nv-jail`：Landlock 只读集合加可写集合；ABI≥4 时只允许 TCP connect 到代理端口，从而强制 egress；`RLIMIT_NPROC`/`RLIMIT_FSIZE`；可选每 run 独立 uid（uid 池，用 file capability `cap_setuid` 切换 **(verify)**） | **普通 Docker 主机上的容器内默认档**（Docker LXC 见下一行）。Proxmox 内核用 `CONFIG_LSM=lockdown,yama,integrity,apparmor` 覆盖了 Ubuntu 的默认值，Landlock 编译进了内核但不启用（dmesg 显示 “landlock: Disabled but requested by user space”）。宿主机内核命令行加上 `lsm=landlock,lockdown,yama,integrity,apparmor` 才可用（§10.2） |
| `container`（外层容器边界） | 嵌套环境下 bwrap 和 landlock 都不可用，并且 runner 按 harness 拆成独立容器（§10.2） | 没有 run 级的 OS 边界，以 **runner 容器**为边界：<br>• 该容器只挂载本 harness 的账号 home、书库（只读）和本 harness 专属的 `runs/by-harness/<id>/` 子树；<br>• 不挂载其他 harness 的凭据和 `secrets/`；<br>• 非 root 运行，`read_only` 根文件系统；<br>• egress 在容器网络层强制：只接入 internal network，经白名单代理容器出网；<br>• harness 跑最宽松的非交互模式；<br>• 事后审计加 git 回滚 | **Docker LXC 在宿主机未启用 Landlock 时的默认档**。允许 codex 承担输入可信的角色（`checker`、`summarizer`、`auditor`）。不可信文本仍然只交给没有 shell 的 profile。更强的可选变体是 `oci`：每个 run 一个一次性容器，需要受限的 docker API（§13） |
| `degraded` | 以上都不可用 | 没有 OS 级读写边界；事后审计加回滚 | 只允许没有 shell 的 harness（cc、grok、agy）；pi、codex、dsh 拒绝运行 |

- 多个 harness 在缺少内核支持时会**静默退化为不设防**：
  - Claude Code 的沙箱只有设置 `sandbox.failIfUnavailable: true` 才会报错，否则直接不加沙箱运行；
  - grok 缺少 Landlock 时“logs a warning and continues without enforcement”；
  - dsh 在旧 ABI 上打印 `landlock-run: partial enforcement`。

  所以 runner 启动时由 `doctor` 做一次**探测**并显示在 UI 上：以 run 用户执行 `bwrap --unshare-all --ro-bind / / true`；用 `landlock_create_ruleset` 的版本查询读出 ABI；读取 `/sys/kernel/security/lsm`。探测结果决定选哪一档，并记入每个 run。设计不依赖任何 harness 自带的沙箱。

**bwrap 模板**（补齐了 `$RUN`、`/opt/novelist` 和 `.git`）：

```sh
bwrap --die-with-parent --new-session --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try \
  --info-fd 3 \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib \
  $( [ -e /usr/lib64 ] && echo --symlink usr/lib64 /lib64 ) \
  --ro-bind /etc/ssl /etc/ssl --ro-bind-try /etc/ca-certificates /etc/ca-certificates \
  --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /etc/hosts /etc/hosts \
  --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf --ro-bind-try /etc/localtime /etc/localtime \
  --ro-bind $RUN/in/etc/passwd /etc/passwd --ro-bind $RUN/in/etc/group /etc/group \
  --proc /proc --dev /dev --tmpfs /tmp \
  --tmpfs $DATA \
  --ro-bind /opt/harness/$ID/$VER /opt/harness/$ID/$VER \
  --ro-bind /opt/novelist /opt/novelist \
  --ro-bind $BOOK_LIVE/.git $BOOK_LIVE/.git \             # worktree 的 gitdir 指向这里
  --ro-bind $RUN/book $RUN/book \                          # worktree@base_commit + 派生视图
  --bind $OUT $OUT \                                       # = $RUN/book/work/<task>/attempt-k/out
  --ro-bind $RUN/in $RUN/in --bind $RUN/log $RUN/log \
  --bind $HSTATE $HSTATE \                                 # 账号 home 的状态部分
  $(for f in config files; do echo --ro-bind $RUN/in/home/$f $H/$f; done) \   # 配置部分只读覆盖
  [--ro-bind $ADC $ADC] \
  --setenv HOME $H --chdir $RUN/book -- <argv>
```

- `/proc` 在 Docker masked paths 下挂载失败时，`doctor` 会提示加 `security_opt: [systempaths=unconfined]`，或者改用 landlock 档。
- **Landlock 规则**（nv-jail）：
  - 只读：`/usr`、`/etc` 中的必需文件、`/opt/harness/<id>/<ver>`、`/opt/novelist`、`$BOOK_LIVE/.git`、`$RUN/book`、`$RUN/in`。
  - 可写：`$OUT`、`$RUN/log`、`$HSTATE`、`/tmp/nv-<run>`。
  - 其他书、其他账号的 home、`secrets/`、`runs/` 全部不可读。
  - 局限：Landlock 不能把可写目录里的单个文件设成只读，所以 home 配置文件采用“run 前重写、run 后 hash 校验，不一致就熔断”。
- **外层严格，内层宽松**：harness 内部使用最宽松的非交互模式。自带的 deny 规则仍然配置，作为纵深防御。
- **run 结束后审计**（以隔离边界为准，不依赖事件流）：
  - out/ 文件清单必须符合 work order 声明的产物集，多出来的文件拒收；
  - home 配置文件 hash 必须不变；
  - degraded 档额外检查：`git -C $BOOK_LIVE status --porcelain` 在持锁状态下必须为空，否则回滚，并把该 run 判为 `sandbox` 违规。
  - 事件流中写到 outDir 以外的路径只作遥测。
- **资源限制**：不使用 RLIMIT_AS。容器档靠 compose `mem_limit` 加每账号并发上限；宿主机 runner 档在 cgroup v2 可委派时用 `systemd-run --user --scope -p MemoryMax= -p TasksMax=`。rlimit 只设 `NPROC` 和 `FSIZE`。
- **网络**：带 shell 的 harness 默认开启 egress 白名单代理，只放行该厂商 API 的域名。强制方式：landlock ABI≥4 只允许连接代理端口；bwrap 档用 `--unshare-net` 加代理桥 **(verify)**。harness 是否遵守 `HTTPS_PROXY` 由 canary 实测，不遵守时直连会失败，属于 fail-closed。残余风险：DNS 外传，写进 §10.6。

**Home 布局与并发：**

| harness | 状态部分（持久可写） | 配置部分（每 run 生成） | 同账号并发 |
|---|---|---|---|
| cc | `$H/.claude/{projects,sessions,…}` | `settings.json`、`.claude.json` 模板 | 3 |
| codex | `auth.json`（会刷新）、sessions、sqlite（本地盘，不能用 NFS） | `config.toml`、hooks、rules | 2（#59367） |
| grok | OAuth、`sessions/` | `config.toml`、`hooks/` | 2 |
| agy | 默认临时，见上；consumer OAuth 时为每账号持久 home（登录状态） | 全部 | consumer OAuth 或持久 home 时为 1；API key 时按 API 限额 |
| dsh | sessions | profile 已预物化到 /opt | 2 |
| pi | `auth.json`、sessions | `settings.json` | 2 |

- `gcHome` 每晚执行（`grok sessions delete`、codex archive，删除 dsh/pi 的旧会话），跳过 2 小时内可能被 resume 的会话。不需要 resume 的角色默认用 `--ephemeral` 或 `--no-session-persistence`。
- **登录**（D5）走网页“交互登录”，spawn harness 的登录命令，输出流式显示在 UI，带输入框：
  - 后端执行 `codex login --device-auth`（需要先在 ChatGPT 安全设置里开启 device code 登录）和 `grok login --device-auth`，解析输出里的 URL 和验证码，在 UI 展示并轮询完成状态；
  - cc 可以在网页交互登录里运行 `claude setup-token`，也可以把本机生成的 token 粘贴到账号页。token 用 AES-256-GCM 加密入库（§3.7），UI 显示预计到期日；
  - pi 的 `/login` 也走网页交互登录，以 `HOME=<账号 home>` 执行；
  - 宿主机已有的凭据用 `--import` 拷贝，绝不直接使用 owner 正在用的 `~/.claude`。

### 3.7 认证模式与限额

按 D2（修订）和 D5，认证模式是**每个账号的用户设置**，在 Web UI 的“Harness 与账号”页配置。每种模式都带风险标签，UI 上原文展示条款依据。API key 和自建网关账号单独按 USD 记账。核查日期为 2026-11-08，置信度沿用调研报告：H 表示有官方文档或本地实测，M 表示官方但不完整或多方一致，L 表示单一来源。

| harness | 订阅模式 | 凭据交付与刷新 | 条款与风险标签 | 额度窗口 | 兜底 |
|---|---|---|---|---|---|
| cc | Pro/Max/Ultra 的 `CLAUDE_CODE_OAUTH_TOKEN`（由 `claude setup-token` 生成，有效期一年）。**H** | token 在 Web UI 录入（或在网页交互登录里运行 `claude setup-token`），AES-256-GCM 加密入库（D5）。也可以改用自定义 API：`ANTHROPIC_BASE_URL` 加 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，模型名自定义。`cred_expires_at` 记为签发日加 365 天，到期前 30 天提醒。遇到 401 归为 `auth`：该账号暂停，进 Inbox（2026-06 有一份 Max 账号 `-p` 报 401 的报告，**L**）。订阅模式下绝不使用 `--bare`，env 中不得出现 `ANTHROPIC_API_KEY` | **低–中**。用户用自己的订阅登录未经修改的 `claude` 是允许的，平台托管的情况也包括在内。但额度“assume ordinary, individual usage”，24/7 高强度运行属于灰区。token 只能发模型请求，没有 claude.ai connectors，本地 MCP 仍然可用 | Pro/Max 有 5 小时窗口加周上限；verified Ultra 只有周上限，没有 5 小时窗口；Max/Ultra 还有单独的 Fable 周上限。额度**与用户本人的 Claude 和 Claude Code 交互使用共享**。周额度的具体数字没有公开（Max 约为 Pro 的 5 倍，Ultra 约 10 倍，**M**）。`-p` 的独立额度已暂停，仍从普通额度池扣量（**M**） | 额度耗尽就等待重置（writer `on_quota: wait`）。不自动切到 API key |
| codex | ChatGPT Plus/Pro 登录，使用 `codex exec`。**H** | `codex login --device-auth`（beta，需要先在 ChatGPT 安全设置里开启），或者拷贝 `auth.json` 到每账号的 `CODEX_HOME`。`auth.json` 会刷新，所以属于可写的状态部分；同账号并发 ≤2，并对 `auth.json` 加文件锁 | **中**。OpenAI 自家客户端，没有明文禁止，但官方指引是“API keys are still the recommended default for automation” | Plus 有 5 小时窗口，可能还有周上限。gpt-6-luna 每 5 小时约 350–3,000 条，gpt-6.1-terra 约 35–285，gpt-6.1-sol 约 15–160。Pro 目前没有 5 小时上限。本地消息和云端任务共用一份额度 | 等待重置。超额后可以购买 credits（Luna 每百万 token 输入 2.5、输出 12.5 credits），但默认关闭，需要用户确认。有一份报告称 CLI 用不了“Luna Reserve”额度（**L**），所以不把它算进容量 |
| agy | consumer Google AI Pro/Ultra OAuth：按 D5 **照常使用**，UI 只显示风险说明（`agy_consumer_wrap`） | 每账号持久 home（§3.5），同账号并发 1 | **高**。FAQ 原文：“Wrapping `agy` inside third-party coding agents or applications … is not supported under consumer plans”，并且“can result in suspension or termination”。`agy -p` 本身“intended for direct scripting and CI workflows”，但 Novelist 这类应用最可能被归入“wrapping” | Pro/Ultra 每 5 小时回填一次，直到达到周上限；Free 每周回填。BYOK 不会提高订阅额度 | 额度耗尽就等待重置。用户也可以改用 Google AI Studio 或 Gemini Enterprise 的 API key，或者换一个 preset |
| grok | SuperGrok、X Premium+ 或“X Subscription”的 OAuth。**H**（headless 用法有文档） | `grok login --device-auth`，或者往 `$GROK_HOME` 预置 `auth.json`（官方文档允许容器以只读方式挂载）。缓存的 OAuth 优先于 `XAI_API_KEY` | **低–中**。没有找到明确的禁止或许可，xAI ToS 页面没能抓取到（**M**） | 一个周额度池由 Chat、Imagine、Voice、Build 共用，数字未公开，用 `grok usage --json` 查看 | 默认 preset 不依赖 grok；`mixed` preset 里它只承担 opt-in 角色 |
| dsh | **没有官方订阅**，只能用预付费 API key。**H/M** | `DEEPSEEK_API_KEY` | 价格极低：V4.1 Flash 闲时每百万 token 输入（未命中缓存）$0.15、输出 $0.60，高峰时段（UTC 工作日 01:00–04:00、06:00–10:00）翻倍为 $0.30 / $1.20。`session-log-deepseek` 上传默认开启，必须关闭 | 按 key 余额计费 | 按 D5 启用，用户在 Web UI 填 key，可以设月度 USD 上限 |
| pi | 默认不走订阅。pi 的 `/login` 技术上支持 Anthropic 订阅和 “Sign in with ChatGPT”（`openai-codex` provider） | `auth.json`（交互式登录一次后复用） | Anthropic：Consumer Terms 禁止第三方 harness 使用订阅凭据，pi 自己也会警告可能产生额外计费，**禁用**。ChatGPT：属于第三方客户端使用订阅，条款依据未核实，**高**，默认不开 | — | 用 API key 接入 |

- **凭据录入方式**（D5）：每个 harness 账号都支持 env 变量（key、base URL）、上传凭据文件（如 codex、grok 的 `auth.json`）和网页“交互登录”（spawn harness 的登录命令，device-code 输出流式显示在 UI，带输入框）。秘密用 AES-256-GCM 加密存储，主密钥来自 `NOVELIST_MASTER_KEY`，或生成到 `/data/.master_key`。
- **配额信号**：
  - cc：`rate_limit_event`、`api_retry`；
  - codex：短命 app-server 的 `account/rateLimits/read`，以及 `usageLimitExceeded` 或 429；
  - grok：`grok usage --json` 和额度错误；
  - agy：只有额度错误；
  - API 账号：按 `pricing.yaml` 计算。

  所有信号都会被解析出 `resetsAt`，账号进入 `sleep_until`。周上限可能让一个账号停好几天，调度器和存稿（§7.5、§9.4）都按这种情况设计。
- **启动核对**：worker 启动时逐家核对认证模式和模型 slug（`agy models`、codex 模型列表、cc `init.model`），确认订阅 run 确实没有带 API key，结果显示在“Harness 与账号页”。
- **条款依据随版本记录**：每种认证模式都存下核查日期和原文链接。条款变化时（例如 cc 恢复 `-p` 独立额度，或 agy 放开 consumer 包装），由用户在 UI 中重新确认。

### 3.8 版本锁定、能力探测与熔断

```yaml
# $DATA/config/harness.lock.yaml —— 初始全部 probed/unknown，P0 通过后才晋级
claude-code: { version: 2.1.319, node: null, source: "npm:@anthropic-ai/claude-code@2.1.319", sha256: "…", sha256_source: tofu, tier: probed, status: candidate }
codex:       { version: 0.167.0, node: "24.11.1", source: "npm:@openai/codex@0.167.0", sha256: "…", sha256_source: tofu, tier: probed, status: candidate }
agy:         { version: 1.5.3, source: "installer:…", sha256: "…", sha256_source: tofu, tier: unknown, status: candidate }
grok:        { version: 1.0.77, node: "24.11.1", source: "npm:@xai-official/grok@1.0.77", sha256: "…", sha256_source: tofu, tier: unknown, status: candidate }
dsh:         { version: 0.2.2-rc.1, node: "24.11.1", source: "npm:@deepseek-ai/dsh@0.2.2-rc.1", sha256: "…", sha256_source: tofu, tier: unknown, status: candidate }
pi:          { version: 1.5.0, source: "npm:…", sha256: "…", sha256_source: tofu, tier: unknown, status: disabled }
```

- **安装**：
  - compose 里的 `harness-installer` 服务（profile 化）以读写方式挂载 harness 卷，可以联网，执行 `novelist harness install <id>@<ver>` 后退出。
  - 安装内容包括锁定的 node、预物化的 dsh profile，以及从 sha256 派生的只读目录。
  - sha256 首次安装走 TOFU 并记录；有上游 blessed lock 时以上游为准。
  - UI 上的“安装”按钮默认只生成待执行的命令。是否允许挂载 docker.sock 由用户决定（§13）。
- **probe** 在真实隔离后端内执行：
  1. `--version`、扫描 `--help` 中的必需 flags、`node --version`；
  2. 列出模型；
  3. fixture 回放；
  4. **canary**：
     - 写文件，写 receipt；
     - 回显首尾 nonce（canary 中禁止 Read AGENTS.md，确保 nonce 不是读文件读到的）；
     - 合规探针：在被引用文件末尾放一条可观测的指令，检查产物是否遵守；
     - Stop hook 确实触发；
     - receipt schema 方言被接受；
     - `HTTPS_PROXY` 被遵守；
     - 越界读写全部失败（沙箱一致性套件）；
  5. 写出 `capabilities.json`，并把原始流录成新 fixture。
- **晋级**：`unknown → probed`（canary 通过）→ `canary`（真实模型写 5 章，受订阅窗口占用上限约束）→ `active`/`blessed`。`unknown` 状态拒绝任何无人值守运行。
- **熔断**：按 (harness, version, isolation) 统计，24 小时滑动窗口，**至少 20 个 run 才判定**。触发条件：
  - `drift` 超过 2%；
  - unknown 事件占比超过 5%；
  - `output_contract` 率达到上一版本的 2 倍以上，并且绝对值超过 10%；
  - `config`、`sandbox`（越界写或 home 配置被改）占比超过 5%；
  - 某层 TAIL nonce 缺失率超过 20%（先交叉核对 cc 的 `init.memory_paths` 和 `system_prompt` 快照，以及 grok 的 `inspect --json`，排除模型漏回显）。

  单个 run 中模型越权属于 run 级 soft 事件。出现疑似问题时先**自动重跑一次 canary**，canary 失败才开熔断。**主笔所在 harness 的熔断**要先发 Inbox 和通知，30 分钟后才生效，期间 owner 可以否决。

---

## 4. 书库布局

### 4.1 目录树（每本书一个独立 git 仓库）

```
$DATA/books/<slug>/
├── book.yaml                       # format_version、题材包引用、规模、质量档位、gates.overrides、路由覆盖、发布计划（附录 A）
├── AGENTS.md                       # GENERATED, committed。首行可见：“本文件由 Novelist 生成；你的书层指令在 instructions/AGENTS.md”
├── .agents/skills/<name>/SKILL.md  # GENERATED
├── .claude/skills -> ../.agents/skills
├── .gitignore                      # work/ .index/ .cache/ views/ state/snapshot.json
├── instructions/                   # USER-OWNED、不透明（只放用户文件）
│   ├── AGENTS.md
│   ├── roles/<role>.md   tasks/<kind>.md   skills/<name>/SKILL.md
├── style/ { voice.md, samples/*.md, lexicon.yaml(ban/watch/allow) }
├── gates.yaml                      # 可选：书层 gate 覆盖（也可写在 book.yaml）
├── bible/
│   ├── premise.md  glossary.yaml
│   ├── world/{rules.yaml(含历法、体系、受控状态词表), systems/*.md, geography.md, history.md}
│   ├── entities/{characters,locations,factions,items,concepts}/<id>.md
│   └── secrets/<id>.md             # 作者真相 + 揭示计划 + leak_signatures
├── plan/
│   ├── compass.yaml  volumes/v03.yaml  arcs/a0012.yaml  cards/c00421.yaml
│   ├── character-arcs/<id>.yaml  strands.yaml  obligations.yaml
│   └── changes.jsonl
├── state/
│   ├── ledger/c00421.json          # CANONICAL
│   ├── overrides.jsonl             # CANONICAL
│   └── arc-fingerprints.jsonl      # CANONICAL（audit.arc 产出）
├── manuscript/c00421.md
├── summaries/{arcs/a0012.md, volumes/v03.md, book.md}
├── reviews/c00421.json   audits/*.json   debt.jsonl   notes/inbox.md
├── work/                           # gitignored（live 树中用于 Studio/手动 step）
├── views/                          # DERIVED, gitignored（live 树缓存，供 UI/Studio；run 内由 ctx.build 生成）
│   ├── snapshot.json context-card.md cast.md obligations.md timeline.md knowledge.md relations.md
│   ├── patterns.md progress.md aliases.json
│   └── instructions/<role>.md      # 编译镜像（不含 nonce，仅供审计）
└── .index/  .cache/                # gitignored，可重建
```

- 派生文件不入库。commit 带 `Novelist-Snapshot-Hash`，`reindex` 和 chaos 测试断言 `snapshot == fold(ledger, overrides)`。
- **根 AGENTS.md 的归属**：如果检测到根 AGENTS.md 被手工修改（UI 或 Studio 提交），committer 拒收，并提供“一键迁移”：把修改的 diff 追加到 `instructions/AGENTS.md` 末尾。
- 体积估算：去掉派生文件后，每百万字的仓库约 5–15MB（正文压缩后约 3–5MB，加 ledger、reviews、plan）。soak 测试断言上限，容量表见 §10.1。

### 4.2 规范状态格式

**实体文件**：

```yaml
---
id: char.lin-feng
kind: character
name: 林枫
aliases:
  - { text: 枫哥 }
  - { text: 林三公子 }
  - { text: 小林, ambiguous: true }        # 只在消歧条件满足时计为提及
  - { text: 师兄, scope: { pov: char.su-wan }, ambiguous: true }
identities: [{ id: ident.black-robe, alias: 黑袍人, known_by_fact: fact.lin-feng-is-black-robe }]
tier: major
born: { year: -18, calendar: 天元历 }
first_ch: c00001
contract_by_stage:
  s1: { voice: "克制、冷幽默，短句", never: ["长篇说教"], limits: ["不会主动伤害无辜"] }
  s3: { voice: "更冷、话更少", never: ["长篇说教"], limits: [] }
arc: plan/character-arcs/lin-feng.yaml     # tier=major 必须有
relations: [{ to: char.su-wan, type: 师兄妹 }]
---
（描述、历史、欲望/需要、矛盾。progressions 不再嵌入此文件，见 views/cast.md）
```

- **ID 分配**由编排器负责：planner 和 extractor 只提交 `tmp:<局部名>`，committer 在 promote 时映射成正式 id 并回写所有引用。拼音冲突时加序号（`lin-feng-2`），并检查与别名索引是否冲突。F-id 同样由编排器分配。
- **状态词表**：条件类状态（`cond`）必须使用 `bible/world/rules.yaml: vocab.conditions` 中的受控词条（例如 `injury.arm.left.fracture`，显示为“左臂骨折”），extractor 从词表中选取。不在词表里的条件进入 `vocab.proposals`，由 showrunner 批准。

**Delta**（`nv.delta/1`）：

```json
{ "schema":"nv.delta/1", "chapter":"c00421", "card_blob":"<sha>", "base_ledger_hash":"<sha>", "mode":"full",
  "summary":[{"s":"林枫夜渡黑水，伤臂换船。","anchors":["op:2","ev:他左臂吊着绷带"]}, "…"],
  "beats_realized":[{"beat":"b3","ev":"……原来是她"}],
  "ops":[
    {"op":"entity.create","ent":"tmp:old-boatman","kind":"character","name":"老艄公","aliases":["艄公"],"declared":true,"ev":"…"},
    {"op":"entity.update","ent":"char.lin-feng","from":{"loc":"loc.qingyun"},"set":{"loc":"loc.black-ferry","cond+":["injury.arm.left.fracture"]},"ev":"他左臂吊着绷带"},
    {"op":"event","id":"tmp:e1","who":["char.lin-feng","char.su-wan"],"what":"夜渡遇袭","loc":"loc.black-ferry","ev":"…"},
    {"op":"knowledge.learn","who":"char.lin-feng","fact":"fact.su-wan-spy","how":"overheard","ev":"……原来是她"},
    {"op":"obligation.open","id":"tmp:f1","kind":"foreshadow","weight":"major","due":["c00460","c00540"],"text":"老艄公认得铜牌","ev":"…"},
    {"op":"obligation.pay","id":"F0057","ev":"…"},
    {"op":"arc.stage","who":"char.lin-feng","stage":"s3-doubt","ev":"…"},
    {"op":"arc.resolve","arc":"a0012","ev":"…"},
    {"op":"offscreen.update","ent":"char.zhao-heng","set":{"loc":"loc.capital"},"declared_by_card":true},
    {"op":"time.advance","to":{"year":3,"day":412,"hour":23},"flashback":false},
    {"op":"power.change","who":"char.lin-feng","system":"cultivation","from":"筑基三层","to":"筑基四层","ev":"…"}
  ],
  "uses_knowledge":[{"who":"char.lin-feng","fact":"fact.x","ev":"…"}] }
```

- op 类型在上一版基础上新增 `arc.resolve`、`offscreen.update`、`contract.amend`（只能由 planner 提议），以及 `identity.reveal`。
- 摘要的每个关键句都必须带锚点（op 序号或 ev）。
- `snapshot = fold(ledger[*], overrides)` 是纯函数，用属性测试保证确定性。**投影 snapshot** = snapshot 加上缓冲卡 `post` 的依次叠加（§6.2）。

### 4.3 派生视图

与上一版相同，有以下改动：
- `cast.md` 附 progressions，以及 major 角色自动收集的 3–5 句代表性台词（voice 锚点）。
- `patterns.md` 改为从 review 或 extractor 标注的**实际写出的类型**生成，不再用卡片计划的类型。
- `progress.md` 增加“里程碑完成度 vs 字数位置”曲线。

视图生成器是确定性的，有 golden test。

### 4.4 Git 使用

- 唯一 committer 是编排器，每个仓库一把互斥锁（`pg_advisory_lock(hash(book))` 加文件锁）。
- trailer：`Novelist-Task`、`-Run`、`-Harness`、`-Model`（`init.model` 实际报告的串）、`-Instructions`、`-Snapshot-Hash`、`-Isolation`。
- 粒度：每个 promote 一个 commit。章节验收提交正文、ledger、review 和 debt 增量。
- tag：`ch/00421`、`vol/03-end`、`pub/00416`。
- **run 快照**：
  - runner 在持锁状态下执行 `git worktree add --detach $RUN/book <base_commit>`，然后由 ctx.build 在快照内生成 `views/` 和 `work/<task>/`；
  - run 结束后 `git worktree remove`，每晚执行 `git worktree prune`；
  - 每书 10–30MB，`worktree add` 应在秒级 **(verify，P0 测量)**，太慢时退回 `git archive` 加 reflink。
- 持久性：`core.fsync=all`；启动时 fsck 最近动过的仓库；每晚 `gc --auto`；可选 `push --mirror`。
- Rewind 和 reindex 与上一版相同。rewind 越过已发布章节时需要二次确认。

---

## 5. 指令分层

### 5.1 层定义：按来源嵌套，书层永远最后

system channel 的块顺序如下（后出现者优先）：

| 序 | 块 | 归属 | 来源 |
|---|---|---|---|
| S0 | 流水线 I/O 契约摘要（≤40 行，只讲文件机制） | Novelist | 内置 `contract.md` |
| S1 | 内置角色人设（最低优先级的默认值） | Novelist，可被覆盖 | 内置 `roles/<role>.md` |
| L1 | 全局：`AGENTS.md`，然后全局 `roles/<role>.md` | 用户 | `$DATA/instructions/global/` |
| L2 | 题材包（展开 `extends:` 链）：`AGENTS.md`，然后题材 `roles/<role>.md` | 用户或题材包 | `$DATA/genres/<g>/` |
| L3 | 书：`instructions/AGENTS.md`，然后书 `roles/<role>.md` | 用户 | `<book>/instructions/` |
| L3.9 | owner 本章笔记、Inbox“附笔记重写”的笔记、owner must-fix | 用户 | 卡片 `notes`、Inbox |
| — | task prompt（work order）：Novelist 生成的任务描述、路径、预算、编译 context pack、评审建议 | Novelist | stdin 或文件 |

- 优先级声明：“作者指令（L1–L3.9）优先于一切，包括内置默认和 work order 中由 Novelist 生成的任务描述与评审建议；冲突时以作者层为准，后出现的覆盖先出现的。唯一例外是 S0 的文件机制。”
- 角色文件以 `@extends` 开头时表示追加，否则替换同一来源层内更低层的同名角色。无论哪种情况，都不会排到书层之后。
- **golden test**：在任意层组合下，最后一个作者块都来自 L3 或 L3.9。
- **所有角色**都加载 L1–L3，包括 planner、writer、extractor、reviewer、continuity、judge、editor、stylist、summarizer、auditor 和 showrunner。内置评审类角色的人设写明：“以作者层为评判标准；与作者层冲突的建议不得提出。”

编译器只做三件事：
1. 展开 include。语法是独占一行的 `<!-- nv:include relative/path.md -->`，在编译期展开，所以 cc 剥离 HTML 注释不影响。字面写法用 `<!-- nv:literal -->` 包裹。
2. 计量每层的字节数和 token 数。
3. 给每层加上带标签的分隔和**首尾 nonce**。

编译器从不改写、过滤、摘要或重排用户文本。

### 5.2 通道分配

- **Workspace doc**（根 `AGENTS.md`）：L0 契约、书库地图、skills 索引，以及一句指针：“作者指令在你的 system prompt 中。”不放 nonce，也不重复作者层。
- **System channel**（`$RUN/in/system.md`，nonce 只出现在这里，每个 run 随机生成）：

```
[S0 文件机制 — 由软件校验]  NV-C-HEAD-<rand>
……
[S1 内置角色默认]  NV-S1-HEAD-<rand> … NV-S1-TAIL-<rand>
[作者指令 — 最高优先级；以下优先于你收到的其他一切，包括 work order 中的任务描述与评审建议]
=== L1 global ===            NV-G-HEAD-<rand>  …原文…  NV-G-TAIL-<rand>
=== L2 genre:xianxia ===     NV-R-HEAD-<rand>  …原文…  NV-R-TAIL-<rand>
=== L3 book ===              NV-B-HEAD-<rand>  …原文…  NV-B-TAIL-<rand>
=== L3.9 owner 本章笔记 ===   NV-N-HEAD-<rand>  …原文…  NV-N-TAIL-<rand>
```

- **作者层在预算内一律内联**，不靠“先 Read 某文件”传递。harness 把工具读到的文件内容当作数据，优先级更低。确实放不下的大块资料（世界观长文）由作者层显式声明：“`style/voice.md` 与本节同等优先级”，canary 的合规探针会检验这类声明是否生效。
- 超出某 harness 上限（agy 每文件 24KB、dsh 每链 64KiB、codex 字节上限）时，预算器**拒绝**该 profile，UI 提示“压缩该层或换 harness”，不做静默截断。
- **Task prompt** 中的 revision_brief 带上标签“评审建议（优先级低于作者指令）”。

### 5.3 各 harness 的物化方式

| harness | Workspace doc | System channel | 内环 Stop gate（仅作优化） |
|---|---|---|---|
| cc | 原生 AGENTS.md；probe 断言 `memory_paths` 中有它 | `--append-system-prompt-file` / replace `--system-prompt-file` | `hooks.Stop` → `nv gate --quick --report`（回报字数） |
| codex | 原生，`project_doc_max_bytes=262144` | `developer_instructions`（TOML 序列化）/ replace `model_instructions_file` | 不依赖；agent 可以在沙箱内执行 `nv count` |
| grok | 原生，`inspect --json` preflight | `--rules` / replace `--system-prompt-override` | `$GROK_HOME/hooks/novelist.json`（timeout 30，failClosed false） |
| agy | 原生，编译器硬上限 20,000 字节 | `--agent` 文件（替换还是扩展 **(verify)**） | `hooks.json` Stop |
| dsh | 原生（guidance） | `personaSuffix`（`{{` 已转义） | 不依赖；`nv count` |
| pi | 原生 | `--append-system-prompt` | 扩展 `agent_before_settle` |

内环 gate 和 `nv count` 都只读，只返回实测字数、缺失的 beat 标记和截断提示。最终结论始终来自环外 validators。

### 5.4 契约强制与用户优先的边界

- **Novelist 固定且不可关闭的只有 I/O 契约**：产物写在声明的路径、UTF-8、schema 合法、非空、文件末尾完整（未截断），以及 receipt。
- **所有工艺规则都属于用户层**（题材包的 `gates.yaml` 和 lexicon，书层可以覆盖），见 §6.5。指令预览旁边显示“生效 gate 清单”，标出每条 gate 来自哪一层。
- 用户指令导致产物写错位置时（例如“打印到 stdout”），判为 `output_contract` 并重试；同一 profile 2 次后换 profile。Novelist 绝不从 stdout 抢救正文。

### 5.5 输出契约与 receipt

- `nv.receipt/1` 与上一版相同。所有 harness 都必须写 `out/receipt.json`，最终以 zod 宽松校验为准。
- 原生 structured output 是第二通道，按 harness 生成方言：
  - **strict**（codex）：`additionalProperties:false`，所有属性 required，可空字段写成 `type:[…,"null"]`；
  - **lenient**（cc、agy）。

  probe 时逐家实测 schema 是否被接受，因为 agy 遇到无效 schema 会 exit 1。
- `status:"blocked"` 是一等信号。`questions_for_planner` 进入 Inbox。

### 5.6 用 nonce 证明指令已加载

- 每层首尾各一个 nonce，**每个 run 随机生成，只存在于 `$RUN/in/system.md`**。书库镜像和 workspace doc 里都没有 nonce。
- 校验 receipt 时对照 `tool_call` 事件（包括 codex 的 `command_execution.command`）：如果 agent 读过 `$RUN/in/*`，这次回显不计入证明，并记录违规。
- workspace doc 的加载用旁证：cc 看 `memory_paths`，grok 看 `inspect --json`；codex、agy、dsh、pi 在 canary 中禁止 Read AGENTS.md 后再要求回显。
- **生产规则**：writer、checker、reviewer、judge 的 run 中（lite 档下 checker 的 delta 是下一章的硬依赖），L1–L3.9 任一 **TAIL** nonce 缺失，判 `output_contract`，attempt 作废后重跑。重跑一次仍缺失，就把该 profile 标为对这一层“不可承载”：路由跳过，并通知 UI。HEAD 在而 TAIL 缺失，说明尾部被截断。其他角色缺失 nonce 只记 warning。

### 5.7 Skills

与上一版相同：只放在 `.agents/skills` 下，只用 6 个 spec 字段，优先级为 书 > 题材 > 全局 > 内置。流水线不依赖 skills。

### 5.8 Studio 模式

与上一版相同。物化时引用 `views/instructions/<role>.md`（不含 nonce）。`accept` 生成 `chapter.ingest`，走完整流程，同时锁定对应章节区间。Studio 中对 bible 或 plan 的修改，accept 时按三方合并（base 是 Studio 打开时的 commit），有冲突就进 Inbox。合并策略由用户决定（§13）。

---

## 6. 超长篇写作方法

### 6.0 开书管线

```
book new --seed seed.md [--interview]
  → plan.interview（可选；UI 问答 ≤12 题，答案写入 bible/premise.md 附录）
  → plan.premise ─► plan.compass [approve] ─► plan.bible（实体/world rules/历法/状态词表/secrets）
  → plan.volumes（全卷骨架 + 里程碑位置）─► plan.volume(v01) [approve_first] ─► plan.arc(a0001) ─► cards c00001..c00012
  → routing.feasibility（用当前账号模拟全部角色，展示降级项）
  → [opt-in，默认关] bakeoff：K 个候选写手 × {c00001, c00002, c00011(中段 dramatize 卡)} ─► bakeoff.judge(pairwise + delta.check 违规率)
  → owner 确认主笔（默认是路由 writer 链的第一个 profile；开启 bake-off 时看并排对比页）─► 校准阈值 ─► 写作 lane 启动
```

- 主笔选出之前，规划由 `planner` 链负责（与写手无关）。
- 按 D2（修订），bake-off 默认关闭，主笔直接用路由 writer 链的第一个 profile。不开 bake-off 时，“校准阈值”只用前 3 章的确定性 gate 数据。
- 每一步的 schema 和 validators 见附录 B。

### 6.1 规划层级

**Compass**（`ending` 块锁定）：

```yaml
schema: nv.compass/1
logline: "…"
genre: xianxia
promises: ["…"]
themes: ["…"]
protagonist_arc: { lie: "…", want: "…", need: "…", truth: "…", stages: [s1, s2, s3, s4, s5] }
scale: { target_cjk: 3000000, hard_max_cjk: 3500000, volumes: [10, 12], chapters_per_volume: [80, 110] }
                                                          # 单章长度取自题材包 pacing.yaml
phases: { opening: [c00001, c00003] }
ending:
  direction: "…"
  required_closures: [F0001, F0002, F0007]
  final_state:                                            # nv.predicate/1；实体引用延迟到 endgame 解析
    - { eq: [{ attr: [char.lin-feng, title] }, 宗主] }
    - { obligation: F0001, status: paid }
    - { manual: "主角与师门和解" }                         # owner 签字
main_threads:
  - { id: T1, desc: "…", not_before_volume: v10,
      milestones: [{ id: T1.m1, at: 0.15 }, { id: T1.m2, at: 0.40 }, { id: T1.m3, at: 0.75 }] }
escalation_ladder:
  - { vol: v01, stakes: "…", power_range: [练气, 筑基], novelty: ["首次出现：宗门大比"] }
strand_policy: { quest: 0.6, fire: 0.2, constellation: 0.2, max_quest_run: 5, max_gap_fire: 10, min_strands_per_ch: 2 }
invariants: ["…"]
limits: { open_major_per_volume: 6, open_total: 60, minor_max_age_ch: 120 }
```

**谓词语言 `nv.predicate/1`**：一组有限的 AST，包括 `eq/ne/in`（实体属性）、`knows/knows_not`、`obligation{status}`、`stage`、`at_loc`、`alive`、`has_cond`（只接受受控词条）、`and/or/not`，以及显式的 `{manual}`。用 zod 定义并导出 JSON Schema，planner 的 work order 附带速查表。compass 审批时校验语法；实体引用的解析时机按谓词所在位置决定：卡片 `pre` 在写前，`post` 在抽取后，`final_state` 在 endgame。

**卷与弧**：在上一版基础上增加以下字段：
- 卷：`title`、`novelty`、`power_range`、`milestones_due`；
- 弧：`question` 和 `resolve_by`（弧收尾时必须有 `arc.resolve` op）。

**章卡**（只列有改动的字段）：

```yaml
schema: nv.card/1
id: c00421
title: "雨夜渡口"                                    # planner 建议；writer 可在 receipt.title_proposal 提议
base_ledger_hash: "<sha>"
length: { min: 2600, target: 3000, max: 3800, count_mode: han }   # 默认取自 pacing.yaml；UI 同时显示平台口径
pre:
  - { has_cond: [char.lin-feng, injury.arm.left.fracture] }
  - { knows_not: [char.lin-feng, fact.su-wan-spy] }
post:
  - { op: knowledge.learn, who: char.lin-feng, fact: fact.su-wan-spy }
must_not: [{ op: reader.reveal, fact: fact.lin-feng-heir }]
offscreen: [{ ent: char.zhao-heng, set: { loc: loc.capital } }]
beats:
  - { id: b1, mode: dramatize, cjk: 600, goal: "…" }
  - { id: b2, mode: dramatize, cjk: 800, goal: "…" }
  - { id: b3, mode: dramatize, cjk: 800, goal: "…" }
  - { id: b4, mode: interior,  cjk: 450, goal: "…" }
  - { id: b5, mode: dramatize, cjk: 350, goal: "…" }
callbacks: [{ query: "渡口 雨夜" }, { quote: "青铜铃响三声", from: c00087 }]   # quote 不计入重复 gate
notes: "（owner 本章笔记 → 渲染为 system channel L3.9）"
```

### 6.2 滚动规划视野

| 层 | 视野 | 何时重新生成 |
|---|---|---|
| Compass | 全书 | 只能通过 amendment 修改 |
| 卷 | 当前卷和下一卷细化，其余只有骨架 | 卷中点修订当前卷后半段；卷末细化下一卷 |
| 弧 | 当前弧细化，下一弧出提纲 | 每个弧结束时；或漂移触发时 |
| 卡片 | 写作游标之前 ≥12 张（最少 6） | 每章验收后，用**投影 snapshot** 校验**全部**缓冲卡的 `pre` 和 `must_not`。delta 中计划外的 op 触及某张未来卡涉及的实体或伏笔时，把该卡标为 stale，交给 `card.repair` 批量处理 |

- **side lane 不活锁**：`plan.arc` 的 hard deps 是 compass、目标区间的卡片、被引用的 bible 实体文件，以及 owner 编辑过的路径；ledger、摘要和 patterns 都是 soft deps（§7.2）。卡片余量 ≤ min 时，写作 lane 暂停派发 `chapter.write`，让 `plan.arc` 独占一个提交窗口。
- **规划 validators**：上一版的全部规则，加上以下几条：
  - 弧指纹相似度：新弧与 `arc-fingerprints.jsonl` 中所有历史弧比较，超过阈值就拒收；
  - 每张卡必须有 `title`；
  - 谓词语法合法；
  - 里程碑落后检查。
- **plan_judge**（opt-in，默认关；不开启时只跑规划 validators）输入全书弧目录，按新鲜度打分，并新增一项“向 `ending.direction` 推进度”。
- **重规划触发条件**：上一版的条件，加上：
  - 里程碑完成度落后字数位置超过 10%；
  - 弧到达 `resolve_by` 仍然没有 `arc.resolve`；
  - forward 类债务超过上限。
- 每次细化卷规划时，对所有 open 的 main/major 伏笔做 re-validation：重新确认或修改 `payoff_plan` 和 `due`，结果写入 `changes.jsonl`。

### 6.3 记忆、一致性与 context pack

记忆分层与上一版相同，有以下改动：
- 章摘要带锚点并做确定性校验：无锚点句子占比超过 30% 就拒收。
- `lite` 档下，章摘要由 `chapter.check` 和 delta 一起产出，用同一个 run。standard 和 key 档下，摘要与 extractor 分开路由。弧和卷的摘要由 summarizer 角色生成，auditor 在弧审计时抽样对照账本核对。
- “当前卷至今”改为“当前卷滚动摘要（≤3k，每弧重建）”。

**Context pack** 编译成单个文件，内联进 work order。各 section 有**固定配额**，在 section 内按相关性截断，不允许跨 section 挤占（默认合计 65k 汉字）：

| section | 配额（字） | 内容与截断规则 |
|---|---|---|
| card | 4k | 渲染卡片。owner 笔记**不放这里**，放在 L3.9 |
| prev | 13k | N−1、N−2 全文（超长时保留尾部 3k），加最近 10 章摘要 |
| cast | 12k | 在场实体：当前阶段的 contract、状态、最近 3 次 progression、voice 锚点台词。`last_seen` 距今超过 50 章的实体附 **re-entry brief**：离场时的状态、最后一次出场的 1–2 段原文、离场期间的相关事件 |
| knowledge | 4k | 只列与 `entities_present` 相关的、在 pre/post/must_not 中出现的、最近 20 章被提及的事实，加上 must_not 清单和读者当前认知 |
| obligations | 4k | 卡片指定的伏笔、紧迫度前 5、逾期前 5 加总数（逾期超过 5 条触发 `plan.fix`）。带 `pay` 的伏笔附埋设时的 ev 和历次 advance |
| story | 10k | 全书摘要（≤5k）、当前卷滚动摘要（≤3k）、当前弧摘要 |
| world | 4k | 当前地点和体系相关的规则、历法 |
| retrieval | 6k | BM25 前 8 段。命中已被 override 的段落时，附“[已更正：见 override #x，正确为…]” |
| patterns | 2k | — |
| style | 6k | **不可截断**：voice 卡、风格样本（按 `hash(chapter_id) mod N` 确定性轮换）、lexicon 摘要（ban 与 allow） |

- CI golden 测试：用合成的 1500 章 fixture（5000 个事实、800 个实体、300 条 open 伏笔）断言每个 section 的字节数和总量。
- **别名歧义**：`ambiguous` 别名只在满足以下任一条件时计为提及，否则不参与 cast 自动挂载和 `last_seen` 更新：
  - 附近有对话或动作动词；
  - 同句出现其他实体；
  - 卡片的 `entities_present` 包含该实体。
- **Agentic lookback**：写手可以 Read `manuscript/**`，读到的是快照中的版本，所以是固定的。work order 写明“overrides 优先于 manuscript 原文”。预算为 ≤4 次整章阅读、≤8 次检索，作为软指标。

### 6.4 单章任务图与质量档位

**默认档是 `standard`（D2 修订），`lite`、`key` 按书可选。** 下面先写最省的 `lite` 档，再写 `standard` / `key`。

**`lite` 档**：一个 writer run、确定性 gates、一次 check run，然后验收。只有 hard 失败才修订。

```
ctx.build ─pre 失败(投影校验)─► card.repair
    ▼
chapter.write（writer，路由 writer 链第一个 profile，粘性）─► gate.contract ─失败─► 重试（output_contract）
    ▼
gate.craft（确定性，gates.yaml）─hard 失败─► chapter.revise(mech) ─► gate（≤2；长度类耗尽 → accept_with_debt）
    ▼
chapter.check（一次 run，走 checker 路由）：
    产出 nv.delta/1（含带锚点的摘要）＋ continuity_flags[]（≤10 条，每条带逐字引文）
    ─schema 不合法─► format.repair（走 format_checker 路由，只修格式，不加语义）─► 仍不合法 ─► 重跑 check（≤1）
    ▼
delta.check + recall.probe + leak 签名 + quotes.verify（全部确定性）
    ├─ 关键 op 的 ev 缺失 ─► 定向补抽（并入一次 check run，≤1）
    ├─ 确定性规则判出 hard 正典冲突，或经引文证实的 continuity_flag ─► chapter.revise(canon) ─► gate ─► check(diff)（≤1）
    └─ ok ─► chapter.accept
```

- `chapter.check` 是 extractor 角色加上一段轻量连续性检查，合成一个 run，只用一个 work order。它的输入是草稿、卡片、`snapshot` 中在场实体的切片，以及 must_not 清单，**不带**完整的 context pack。
  - 产出 delta，也就是状态抽取。
  - 产出 `continuity_flags[]`：死者复现、知识越界、地点或时间跳跃、物品持有冲突这类**可以用引文证实的**硬问题。文风和审美不在检查范围内。
  - 每条 flag 都要经过 `quotes.verify` 逐字校验，并用 delta.check 的确定性规则复核。复核成立才触发修订，否则只记为 soft 债务。
- `format.repair` 只在 check 的结构化输出未通过 zod 校验时触发：
  - 输入是原始输出加 schema，输出是修好的 JSON；
  - 确定性验证：修复后的 op 集合必须是原输出的子集或等价改写，ev 必须逐字出现在草稿里；
  - 不满足就丢弃修复结果，重跑 check。
- 可选的 `chapter.formatcheck`（format_checker，**默认关**）只检查确定性 gate 难以判定的排版和格式：对白标点、分段、全角半角混用、残留的 markdown 或标记。它只产出 span 级建议，并且要经过书层 lexicon 和 allow 检查。
- lite 档下**不跑**：reviewer、judge panel、pairwise、deslop（模型版）、交叉抽取、confirm.query 的单独 run。soft 问题一律记债，或只计入仪表盘。

**`standard`（默认）与 `key`**（按书或按卡片设置，任务图保留上一版；图中的 pairwise 和 deslop 由 `optin.pairwise_regression`、`optin.deslop` 控制，默认关）：

```
ctx.build ─pre 失败(投影校验)─► card.repair
    ▼
chapter.write ─► gate.contract ─失败─► 重试（output_contract）
    ▼
gate.craft ─hard 失败─► chapter.revise(mech) ─► gate（≤2；长度类耗尽 → accept_with_debt）
    ▼
chapter.extract ─► delta.check + recall.probe ─extractor 错─► 定向补抽（≤2）
    │                 └─疑似 writer 问题─► confirm.query ─确认─► chapter.revise(canon)
    ▼ ok
chapter.review [standard：continuity+judge 一个 run，输入含 delta，输出 missing_ops[]]
              [key：continuity ∥ judge×2 → 分歧仲裁]
    ─► quotes.verify ─► missing_ops 逐字校验后并入 delta ─► 再跑 delta.check
    ├─ pass ─► [soft 命中 → deslop] ─► chapter.accept
    └─ revise ─► chapter.revise(findings) ─► gate ─► extract(diff) ─► 继承 op 复核 + summary 重生成
                 ─► delta.check ─► pairwise ─► 保留胜者 ─► …（≤2，key ≤3）
```

| 档位 | 适用 | 每章 run 数 | 模型 run 构成 |
|---|---|---|---|
| `lite`（可选） | 用户按书开启 | **约 2.3–2.5** | writer 1 + check 1；期望值另加约 0.3–0.5（hard 失败修订 + diff check 约 0.3，format.repair 约 0.05，定向补抽约 0.1） |
| `lean` | 旧名，等同于 `lite`，保留作别名 | 同上 | — |
| **`standard`（默认，D2 修订）** | 全部章节，包括关键章，除非显式调整 | 约 4–5 | writer + extract + review(continuity+judge) + 修订 + summary |
| `key`（可选） | 用户开启 `tiers.key_chapters: key` 后，用于第 1–3 章、卷首卷末、弧高潮、`card.key`、最终章（约 6%） | 约 10–14（best-of-N 在 P3 之后才有） | 上一版的完整图 |

- `book.yaml`：`tier: standard`（默认）`| lean | lite | key`；`tiers.key_chapters: standard`（默认）`| lean | lite | key`。这些都可以在 Web UI 的新建书页和书设置里改。关键章在 lite 下沿用 lite 流程，耗尽策略仍按下表“关键章”一列处理：长度类和工艺类 hard 问题 `hold`；只剩 soft 问题时的例外见表后说明。
- 不论在哪一档，I/O 契约 gate、工艺 gate、delta.check、账本 fold 与级联重放这些**确定性机制都完整保留**（D1）。降档只去掉模型评审类的 run。

**修订规则：**
- 修订**默认新开 run**：草稿复制进新的 `out/`，附上发现。只有会话不超过 30 分钟、同一 profile、并且 `caps.resume` 为真时才 resume。
- diff 模式抽取之后，继承来的每条 op 都用新稿逐字校验 ev，找不到的移除。summary 每次修订后都重新生成：lite 档下随 check(diff) 一起产出，其他档用一个廉价 run。编辑比例超过 35% 时退回 full 模式。
- 评审：所有评审角色都加载作者层。review schema 增加 `conflicts_with_author_layer`，标为 true 的建议**不进入** revision_brief。stylist 和 editor 的 span-patch 应用后，重跑一次书层 lexicon 和 allow 检查。
- 带 `pay` 的章节自动追加 criteria：“回收是否兑现了埋设”。judge 会拿到埋设时的 ev 和 payoff_plan，引文需逐字校验。

**耗尽策略**（`book.yaml: policy.on_exhausted`）：

| 问题类型 | 普通章 | 关键章 |
|---|---|---|
| 只剩 soft 问题 | `accept_with_debt` | `hold`，进 Inbox |
| 长度类、工艺类 hard 问题 | `accept_with_debt`（forward 类） | `hold` |
| 正典 hard 冲突（确认查询后仍成立）、I/O 契约失败 | `block` 本书 lane | `block` 本书 lane |

lite 档不产出评审类的 soft 发现，所以关键章“只剩 soft 问题”时默认也按 `accept_with_debt` 处理，避免 Inbox 积压。需要人工把关时，可以在 `policy.on_exhausted` 中改回 `hold`。

**债务分两类：**
- **forward-payable**（连续性、伏笔类）：有上限（默认 20 条）。超过上限时，向下一弧注入修补 beat，或者触发 `plan.fix`。偿还以对应 op 落账为准。
- **metric-only**（文风类）：只计入仪表盘。

### 6.5 Gates：I/O 契约 gate 与工艺 gate

**I/O 契约 gate**（Novelist 固定，不可关闭）：
- 产物路径正确、只有声明的产物；
- UTF-8、非空、schema 合法；
- 文件末尾完整：最后一个字符不能处在未闭合的结构里（未闭合引号、半个 UTF-8 序列），最后一段不能被截断在句中。

**工艺 gate**：定义在题材包 `gates.yaml`，优先级为 书层 `gates.overrides` > 题材 > 全局 > 内置默认。每条规则都可以 `disable`、改阈值或加 `allow`。以下是内置题材的默认配置：

| 规则 | 默认级别 | 说明 |
|---|---|---|
| `length.total` | hard | 字数在 `[card.min, card.max]` 内，按 `count_mode` 计数；修订耗尽后转为 debt |
| `length.beat` | **soft** | 每节在预算 ±40% 内，用作 expand 的定向依据 |
| `beat.markers` | hard | 每个有预算的 beat 都要有锚点（promote 时剥离）；计数工具会回报缺失 |
| `end.markers` | hard | 结尾标记只在 `is_final` 时允许；书层可加 allowlist（例如作者要求“每章末写（本章完）”） |
| `placeholder` | hard | `TODO\|XXX\|此处省略…`；`【…】` 默认算 soft，书层可整条关闭 |
| `meta.text` | hard | `作为AI\|以下是…`，可覆盖 |
| `repeat.intra` | hard | 章内 50 字以上的逐字重复 |
| `repeat.cross` | **soft** | 与近 30 章的 8-gram MinHash 比较。计算前先把 glossary 和别名替换成占位符，并排除卡片 callbacks 引文；只有 50 字以上的逐字复制段落升为 hard（P3+） |
| `lexicon` | soft | 分层 ban 与 `allow:`，书层 allow 压过模型级和全局 ban |
| `dramatize`、单句成段、对白比例、开头结尾套路 | soft | P3+ |

**计数手段**（所有 harness 都有）：
- cc、grok、agy、pi：Stop hook 回报每个 beat 的实测字数和总字数；
- codex、dsh：沙箱内 `nv count <file>`；
- 启用 MCP 时：`count_cjk`。

**P1 出口指标**：在 fake 和 P0 实测数据上，统计各 profile 一次通过 gate 的概率，要求 ≥90%。

**长度策略：**
- 偏短：发起 `expand`，并按 diff 模式抽取；新增 `event`、`fact.assert`、`entity.create`、`obligation.open` 时由状态引擎拒收。
- 偏长：超出不到 25% 时做一次 `compress`，超出更多则修订。
- 不做 padding。

### 6.6 `delta.check` 与账本完整性

账本完整性靠**确定性机制**保证，这部分完整保留，不随档位降级：
- ev 逐字和模糊匹配；
- `entity.update.from` 比对；
- 规则集（死亡、持有、power、time、伏笔、must_not）；
- 确定性召回探针和泄漏签名；
- `snapshot == fold(ledger, overrides)`，以及级联重放。

**模型侧**：`standard` / `key` 档由 `chapter.extract` 产出 delta，`lite` 档由一次 `chapter.check` 产出。下面带“opt-in”标记的模型类机制默认关闭。

**精确率（每条发现归因到 extractor 或 writer）：**
- **ev 匹配**：先逐字匹配（统一空白和标点）；失败后做模糊匹配（最长公共子串 ≥80%），由程序自动替换成原文片段；仍然失败时，次要 op 直接丢弃，关键 op（knowledge、obligation、entity.create/retire、reader.reveal）定向补抽这一条，不重跑整次抽取。
- **`entity.update.from`**：只比较 id 类和枚举类字段（loc、owner、status、title、realm）。条件类状态使用受控词表，按集合比较。不一致时判为 writer 矛盾，除非有 override 覆盖。
- **post 或 must_happen 未满足**：先做确定性检查，用别名索引加事件词族在草稿里找候选句。仍不能确定时跑 `confirm.query`：“草稿中是否有 X 得知 Y？请给出逐字引文。”有引文就补 op，没有才修订。lite 档下，同一章的所有 confirm 问题和定向补抽**合并成一次** checker run（每章最多 1 次）。
- 其余规则与上一版相同：死亡和退场、物品唯一持有、power 倒退、time 单调、伏笔状态、`may_open`、`must_not`。另外两条有调整：
  - 地点跳跃要同时参考故事内经过的时间和 `offscreen.update`；
  - `power.change` 超出本卷 `power_range` 判 soft，交给 planner。
- `ev` 或 `uses_knowledge` 引用了已被 override 的事实时，判 soft。

**召回率（新增）：**
1. **确定性召回探针**：用别名索引扫正文，找出提到了但既不在 `entities_present`、也没有任何 op 的实体。在实体名附近用题材包的事件词族匹配，例如 `死|陨落|断气`、`交给|夺走`、`原来是|竟然是`、`突破|晋入`。命中但没有对应 op 时判 `extract_incomplete`，然后定向补抽。
2. **continuity 的 `missing_ops[]`**（standard/key 档）：逐字校验后合并进 delta。lite 档下由 `chapter.check` 的 `continuity_flags[]` 承担轻量版本。
3. **交叉抽取**（opt-in，默认关）：关键章和每 20 章随机一章，用两个不同厂商各抽一次，对 op 集合做 diff，差异交给仲裁，结果计入 extractor profile 的召回统计。不开启时，召回统计只来自确定性召回探针的命中率。
4. **泄漏签名**：每个 `bible/secrets/<id>.md` 声明 `leak_signatures`。用确定性 grep 检查，命中时无论是否有 `reader.reveal` op，都按 `must_not` 处理。
5. extractor 的路由在 Web UI 配置。默认 preset 下走 `agy-argon`，`mixed` preset 下走 `cx-terra` 并降级到 `agy-argon`。`lite` 档下 extractor 并入 `checker`。与写手同厂商时在 review 中标黄。dsh-flash 只在用户开启交叉抽取时作为第二路抽取。

### 6.7 防 Goodhart、写手选择与模型漂移

- 按 D2（修订），本节中的 held-out judge、bake-off 和 pairwise 回归都是 **opt-in，默认关闭**。代码在 P3 照常交付（D1）。不开启时，质量信号来自确定性指标（gate 一次通过率、check flag 率、债务增长率、里程碑曲线）、`standard` / `key` 档的评审结果，再加上 owner 抽读。
- **Held-out judge**（opt-in）：只受一条约束：“不在本次被评章节用过的 judge 里”，必要时按 §7.4 降级。每 50 章评一次，样本为最近 3 章、随机 3 章，以及基线。基线是**前 50 章中随机抽取的 3 章该书设定档位的章节**，不用经过打磨的第 1–3 章。
- **bake-off**（opt-in）：比较对象包括第 1、2 章和一张中段 dramatize 卡。评分时计入 pairwise、delta.check 违规率和 continuity 发现率。
- 一本书固定一个主笔。
- **模型漂移**：routing 尽量使用带日期的 snapshot id。每个 run 从 `init.model` 记录实际模型串，一旦变化就视为**写手变更事件**：
  - 在固定的 20 张卡上做 pairwise 回归（opt-in；默认改为比较变更前后各 10 章的确定性指标）；
  - 重算指纹（P3+）；
  - 3 章后做风格检查（默认只用确定性 lexicon 和重复指标）；
  - 通知 Inbox，请 owner 抽读。

  模型被下架时的继任策略由用户决定（§13）。

### 6.8 风格控制与去 AI 味

与上一版相同，有以下改动：
- lexicon 增加 `allow:`。
- **模型指纹提议默认不自动批准**，并且永远不能覆盖书层 allow。
- stylometrics、指纹、跨厂商 editor 都推迟到 P3 以后，按数据决定是否启用。

### 6.9 人物弧光、契约演进与伏笔账本

- **人物契约随弧光阶段演进**：当 `arc.stage` 推进时，planner 可以提出 `contract.amend`，由 showrunner 审批（可配置为 owner 审批）。OOC 检查只对照当前阶段的 contract。
- tier=major 的角色必须有 arc 文件。配角自动收集代表性台词作为 voice 锚点。
- **伏笔规则**：
  - 全书 open 伏笔总量上限：`limits.open_total`。
  - minor 伏笔超过 `minor_max_age_ch` 后，自动提交 triage（回收、降级或 abandon），由 showrunner 处理。
  - main 级伏笔的 abandon 需要 owner 批准。
  - 其余规则与上一版相同。

### 6.10 周期审计、级联一致性与发布前审计

周期审计**以确定性为主，模型审计少而便宜**：

| 触发 | 任务 | 默认 | 成本 |
|---|---|---|---|
| 每 5 章 | `audit.window`，**确定性版**：<br>• 重放 `fold` 并核对 `Novelist-Snapshot-Hash`；<br>• 对窗口内 delta 重跑 delta.check；<br>• 检查逾期伏笔、`limits.*`、泄漏签名、时间单调性；<br>• 统计债务和 check flag 的增长率 | 开 | 0 个模型 run |
| 每 5 章 | `audit.window` 模型版（滚动的“截至当前章”审计） | opt-in | 1 run |
| 每卷 40–60% 处 | 15 章窗口的模型审计 | opt-in | 1 run |
| 弧结束 | `summary.arc`（summarizer）；`audit.arc` 轻量版（auditor，一个 run，同时生成弧指纹写入 `arc-fingerprints.jsonl`，并对照账本抽样核对弧摘要） | 开 | 每弧约 2 run |
| 弧结束 | fresh-reader 测试 | opt-in | 1 run |
| 卷结束 | `summary.volume`（summarizer）、`audit.volume`（auditor）、`book.blurb` 刷新 | 开 | 每卷约 3 run |
| 每 50 章 | held-out judge | opt-in | 1–2 run |

**审计门控发布**：publisher 只发布 `audited_through ≥ 章号` 的章节，即覆盖该章的确定性 `audit.window` 和 `audit.arc` 都已通过；开启了模型版 window 审计时，它也必须通过。D4 的 lag ≥ 一个弧，保证一个弧的首章发布之前，该弧的 `audit.arc` 已经完成。UI 展示“已审计前沿”和“发布前沿”。

**级联一致性**（`chapter.repair`、owner 手改正文、override 生效后）：
1. 手改正文一律触发 `chapter.reextract`（diff 模式）。
2. 用新 delta 替换 ledger，**从 k+1 起按顺序重放所有下游 delta 的 delta.check**（纯确定性，成本低）。
3. delta diff 为空（只改了文字）：直接替换。
4. diff 不为空，且下游出现冲突：冲突章节标记 `needs_repair`。缓冲区内的章节自动排 `chapter.repair`；已发布章节只生成 override 和后文补圆。如果冲突链长度超过 3，降级为“只写 override”。
5. 编辑器保存前显示“将影响 c00401–c00420 的 N 条 delta”。
6. 有专门的属性测试覆盖这一流程。

已发布正文绝不自动修改。

### 6.11 结尾与完结控制

- **closure capacity**：每次 `plan.arc` 时估算 `需要的章数 = Σ(open main/major × 该类平均回收章数) + 收尾章数`。当 `剩余预算章数 ≤ 需要的章数 × 1.3` 时，提前进入 endgame。
- **投影触发**：`当前字数 + 预计剩余字数 ≥ hard_max × 0.9` 时触发 endgame。另外保留“达到 target 的 85%”和“进入最终卷”两个触发条件，三者以先到者为准。
- endgame 期间：
  - `plan.arc` 必须把 required_closures 和所有 open 的 major/main 排进计划；
  - 不得新开 major；
  - minor 进入批量 triage。
- 最终章验收要求：
  - 所有 open 项都已关闭，或已显式 abandon 并写明理由（minor 可以由 showrunner 批量处理）；
  - `final_state` 谓词成立，`manual` 项由 owner 签字；
  - 主角弧到达最终阶段。
- 防止无限扩张和过早完结：沿用上一版机制，另外加上里程碑曲线。

---

## 7. 编排

### 7.1 谁来编排

与上一版相同：外层由确定性编排器负责，单个创作或分析单元交给 agent，语义决策由 showrunner 以 schema 约束的提案形式给出，子代理只开放给 `plan.*` 和 `audit.*`。

### 7.2 任务模型、幂等与 stale check

```sql
tasks(id text pk, -- sha256(book, kind, target, hard_manifest_hash, stack_hash, config_hash, pipeline_ver)
      book_id, kind, target, lane, tier, priority, deps text[], state, base_commit,
      hard_manifest jsonb, soft_manifest jsonb, rebase_validators text[],
      attempts, max_attempts default 6, last_error_class, not_before, created_at, updated_at)
```

（完整 DDL 见附录 C。）

- `config_hash` **只覆盖影响产物内容的配置**：gates 阈值、质量档位、长度区间、题材包版本、pipeline 版本。routing、accounts、并发和预算不计入。
- **stale check（两类依赖）**：
  - hard deps 有变化：结果作废，按新 id 重新派发；
  - 只有 soft deps 变化：执行 **rebase**，在 HEAD 上重跑该任务声明的确定性 validators（例如卡片的投影 pre、伏笔窗口、编号连续）。通过就提交；不通过时转 `card.repair`，或者在补丁较小时由 showrunner 处理。
- 各任务的 hard/soft 划分见附录 B。用 chaos 和 e2e 测试覆盖“写作与规划并发 200 章不活锁”。
- `pipeline_ver` 变化时，不中断进行中的 run，新任务使用新 id（§10.5）。

### 7.3 Lane 与并行

- 每本书一条写作 lane。side lane 在各自的 run 快照上运行，并且受 committer 互斥锁约束。
- 卡片余量 ≤ min 时，写作 lane 让出提交窗口（§6.2）。
- 缓冲区超过 `max_buffer` 时，暂停该书生产（§9.4）。
- 推测流水线默认关闭。跨书完全并行。

### 7.4 角色路由与降级阶梯

**Profile 定义**（内置，可在 Web UI 增删改；slug 已于 2026-11-08 核实，worker 启动时再核对一次；`gemini-4-argon` 是占位值，以 `agy models` 的列表为准）：

```yaml
profiles:
  agy-argon:  { harness: agy,         model: gemini-4-argon,  effort: high }   # 默认 preset；需要 Google AI Pro/Ultra
  cc-opus:    { harness: claude-code, model: claude-opus-5-5, effort: high }   # 订阅或自建网关
  cx-sol:     { harness: codex, model: gpt-6.1-sol,   effort: high }
  cx-terra:   { harness: codex, model: gpt-6.1-terra, effort: medium }
  grok-47:    { harness: grok,  model: grok-4.7, effort: high, enabled: false }
  dsh-flash:  { harness: dsh,   model: deepseek-flash }                        # API key
  # 以下只用于开发测试（tags: [dev]），不进入任何正式 preset
  cc-haiku:   { harness: claude-code, model: claude-haiku-5-5 }
  cx-luna:    { harness: codex, model: gpt-6-luna }
  agy-flash:  { harness: agy,   model: gemini-3.8-flash-low }
  fake:       { harness: fake,  model: fake-model }
```

**默认路由**（preset `agy-argon`，全部角色走同一个 profile，首次启动写入 DB，之后可在 Web UI 任意修改，`book.yaml` 的 `routing` 可以按书覆盖）：

```yaml
roles:
  writer:     { chain: [agy-argon], sticky: book, on_quota: wait,
                failover_after: 6h, failover_on: [auth, circuit_open, model_unavailable],   # 额度窗口不触发 failover
                failover_requires_approval: true }
  confirm:    { chain: [agy-argon], same_as: checker }
  # planner、showrunner、checker、extractor、format_checker、summarizer、auditor、
  # reviewer、continuity、judge、plan_judge、extractor_cross、heldout、editor、stylist：
  <其余角色>: { chain: [agy-argon] }
```

**其他内置 preset：**

| preset | 内容 |
|---|---|
| `cc-only` | 全部角色走 `cc-opus`（订阅或自建 API 网关，在账号页配置） |
| `codex-only` | 全部角色走 `cx-sol`；checker、summarizer、auditor 走 `[cx-terra, cx-sol]` |
| `mixed` | cc 主笔，codex 校验，评审要求与写手不同厂商，见下 |
| `dev-cheap` | **仅开发测试**：`cx-luna`、`cc-haiku`、`agy-flash` |
| `fake` | **仅测试**：fake adapter，不调用任何模型 |

`mixed` preset 的角色链：

```yaml
roles:
  writer:     { chain: [cc-opus], sticky: book, on_quota: wait, failover_chain: [cx-sol], failover_requires_approval: true }
  planner:    [cc-opus, cx-sol]
  showrunner: [cc-opus, cx-sol]
  checker:    { chain: [cx-terra], degrade_to: [agy-argon, cc-opus] }
  extractor:  { chain: [cx-terra], degrade_to: [agy-argon] }
  format_checker: [agy-argon, cc-opus]
  summarizer: [cx-terra, agy-argon]
  auditor:    [cx-terra, agy-argon]
  reviewer:   { chain: [cx-sol, agy-argon, grok-47], constraint: vendor_ne_writer }
  continuity: { chain: [cx-sol, agy-argon], constraint: vendor_ne_writer }
  judge:      { chain: [cx-sol, agy-argon, grok-47], constraint: vendor_ne_writer, panel: 2, distinct_vendors: true }
  plan_judge: { chain: [cx-sol, agy-argon, grok-47], constraint: vendor_ne_planner }
  heldout:    { chain: [grok-47, agy-argon, cx-sol], constraint: not_in_judges }
  editor:     { chain: [grok-47, cx-sol], constraint: vendor_ne_writer }
  extractor_cross: [agy-argon, cx-terra, dsh-flash]
```

- **writer 粘在书上**，默认是路由 writer 链的第一个 profile。额度窗口（5 小时或每周）耗尽时一律 `wait`，由存稿吸收（§7.5、§9.4），**不因额度切换写手**，避免风格断层。只有 auth 失效、熔断或模型下架时，6 小时后才生成 failover 提案，并且要 owner 批准。用户持有 Fable 额度时可以把主笔设为 Fable，但它的周上限是单独计算的。
- **单 profile 的 preset 不设厂商约束**：`agy-argon`、`cc-only` 下，评审和写手来自同一模型，靠新开 session 隔离。需要跨厂商评审时用 `mixed`，或者自己配角色链。
- **廉价模型只用于开发测试**（D2 修订）：`cx-luna`、`cc-haiku`、`agy-flash` 带 `tags: [dev]`，只出现在 `dev-cheap` preset。
- **降级阶梯**：约束不可满足或额度耗尽时，按确定顺序放宽，lane 不停：
  1. 非写手角色：按 `chain` 和 `degrade_to` 换下一个 profile，与写手同厂商时在 review 中标黄，并计入写手池的预留；
  2. 所有 profile 都没有额度：该章停在 `awaiting_check`，lane 等待最早的重置时间。delta 是下一章 context 的硬依赖，所以**不允许跳过 check 直接验收**。默认 preset 只有一个 profile，额度耗尽时直接走这一步；
  3. 评审角色沿用上一版的阶梯：不同厂商 → 同厂商不同模型 → 同模型加 fresh session 加盲评 → 减少 panel 人数。

  每一次降级都记录到章节的 review 中，UI 标黄。
- **开书路由可行性检查**：用当前账号集合模拟全部默认角色和已开启的 opt-in 角色。检查内容包括 slug 是否存在、认证模式是否有效，并估算每个窗口能写几章（§7.5）。结果展示为“以你现有的账号，以下机制会降级或不可用”。Argon 的 slug 不在 `agy models` 列表里时只给 warning，不硬失败。
- 账号顺序与上一版相同。failover 之后，opt-in 评审角色的约束按新写手重新计算，并走降级阶梯。

### 7.5 调度、配额、预算与容量估算

调度、错峰、退避与上一版相同。吞吐和预算在 Web UI 按书配置（D2 修订）。订阅账号的**主约束是窗口吞吐**（每 5 小时、每周能写几章），书级预算用“窗口占用率”表示；API 账号按 USD 记账，受上限约束。

**配额模型**：
- 每个订阅账号有一组窗口 `{5h?, 7d, model_specific?}`：
  - cc Pro/Max 有 5 小时和每周两个窗口，verified Ultra 只有每周窗口，Fable 另有一个每周窗口；
  - codex Plus 有 5 小时窗口，可能还有每周窗口，Pro 没有 5 小时窗口；
  - grok 和 agy 是每周额度池。
- 窗口占用率来自配额信号（§3.7）：cc 的 `rate_limit_event.utilization`、codex 的 `account/rateLimits/read`、grok 的 `grok usage --json`。agy 只有报错，按“剩余未知”保守处理。
- **单位换算由 P0 实测得出**：每种 (profile, task kind) 都记录一次 run 让各窗口占用率上升多少（`util_delta`），写入 `usage_ledger`。token 只作为辅助指标。厂商没有公开周额度的数字，所以 UI 里的所有吞吐估算都来自实测账本。

**准入与预留**（`quota_reservations`）：
- 派发 `chapter.write` 之前，按这一章所在档位的**完整期望消耗**，同时向所有涉及的账号**预留**额度：writer 1 次，抽取或 check 1 次，`standard` / `key` 档再加评审，修订、补抽、format.repair 按期望值计入，planning 摊销也算在内。只要有一项预留放不下，就不开写这一章。这样可以避免“正文写完了，check 却没有额度”的半成品。
- run 结束后按实测 `util_delta` 结算并释放预留。预留超过 2 小时未结算就自动作废。
- **为主人保留余量**：订阅额度和用户本人的交互使用共享（cc 与 Claude、Claude Code 共用一份额度；ChatGPT 本地消息与云端任务共用）。默认 `reserve_pct: 30`（§13），可以按账号设置每周占用上限，例如 `max_weekly_util: 70%`。
- **窗口耗尽**：解析 `resetsAt`，账号进入 `sleep_until`。如果是每周窗口，书的写作 lane 可能暂停好几天，这时发 Inbox 通知，但不切换写手（§7.4）。D4 的存稿（lag ≥ 一个弧，最少 15 章）让发布在这段时间不断档：按每天 2 章计算，15 章存稿可以覆盖约 7 天的生产暂停。
- 多本书之间按书的优先级和 `max_buffer`（§9.4）分配窗口：存稿越多的书优先级越低。

**容量估算**（量级估计，P0 实测后由账本替换）：
- 单个 run 的输入 = harness 基础 prompt 和指令层（约 25k token）+ work order 内联的 pack（65k 汉字约 70–100k token）。之后每个 turn 都会重发整段会话。check run 不带完整 pack，输入约 15–30k token。
- **lite 档**每章消耗（按“cc 写手 + codex check”的组合估算，只作量级参考；默认 preset 下全部落在 agy 账号上）：

  | 环节 | 订阅池 | 每章 token |
  |---|---|---|
  | writer（3–4 turn） | cc（Opus） | 0.4–0.6M |
  | check（1–2 turn） | codex | 0.05–0.1M |
  | hard 失败修订（约 30% × 0.6M）+ diff check | cc + codex | 约 0.2M |
  | format.repair（约 5%） | format_checker 路由 | 可忽略 |
  | planning、弧与卷的摘要和审计（摊销） | cc + codex | 约 0.05–0.1M |
  | 合计 | — | **约 0.7–1.0M**，其中 cc 池约 0.6–0.8M |

- 瓶颈几乎总在**写手所在的订阅池**。默认 preset 下所有角色共用 agy 账号，写手和校验都从同一个池扣量，实际消耗以实测账本为准。
- **每个窗口可写章数** ≈ `(1 − reserve_pct) × 100% ÷ 每章的写手池窗口占用率`，对 5 小时窗口和每周窗口分别计算，取较小值。举例（仅示意，数字待 P0 实测）：如果一章在写手池的周窗口上占 0.5%，`reserve_pct` 为 30%，那么每周约可写 140 章，约合 42 万字。
- standard 档（默认）每章约 1.2–1.8M token，key 档约为它的 3 倍，按总 token 计分别是 lite 的约 1.2–2.6 倍和 3.6–7.7 倍。每窗口章数下降多少，取决于新增的评审 run 落在哪个订阅池（设了 `vendor_ne` 约束的 preset 里，评审不占写手池；单 profile 的 preset 全部落在同一个池）。可行性检查（§7.4）会在开启前给出估算。
- 各章之间隔 15–40 分钟，prompt cache 早已过期，缓存命中只在单个 run 内部成立。
- 墙钟上限约每条 lane 每天 40–90 章，实际吞吐由订阅窗口决定。UI 显示“每个订阅窗口实测可写章数”和“距下次重置”。
- **API 账号用 USD 记账**（dsh、API key、自建网关）。dsh flash 每章只要几美分（价格见 §3.7，注意高峰时段翻倍），按 `pricing.yaml` 计算，受月度 USD 上限约束。

### 7.6 错误类到动作的固定表

与上一版相同，以下几行有改动：

| 类别 | 动作 |
|---|---|
| permission_denied（产物缺失，且 denial 落在 outDir） / sandbox / config / drift | 计入熔断比率；先重跑一次 canary，canary 失败才开熔断；换 profile |
| run 内模型越权（产物合格） | 记为 soft 违规，不重跑 |
| harness_crash | 重试 2 次，计入熔断比率（OOM 时检查是否误用了 rlimit） |
| refusal | 不原样重发；是否跨厂商重试受书级厂商白名单约束（§13） |

### 7.7 提交协议与崩溃恢复

1. 对 `attempt-k/out` 运行 validators，写出 `VALIDATED.json`。
2. 获取仓库互斥锁。
3. stale check 或 rebase。
4. 在内存中算好目标文件集：正文（去掉 beat 标记）、ledger、review、debt 增量、`tmp:` id 映射回写。
5. 写临时文件、fsync、rename。
6. `git commit`（带 trailer），打 tag。
7. 释放锁，更新数据库，NOTIFY，增量更新 `.index/` 和 live `views/` 缓存，排入周期任务。

崩溃恢复在**持锁状态下**进行：先用 `git log --grep "Novelist-Task: <id>"` 判断是否已提交。已提交就重放第 7 步；否则 `git reset --hard HEAD && git clean -fd -e work/ -e .index/ -e .cache/ -e views/`，然后用已有的 `VALIDATED.json` 重来。磁盘和数据库保护与上一版相同。

### 7.8 人在回路与 Inbox

- **审批门**与上一版相同。每个门增加 `timeout` 和 `on_timeout: wait|auto_approve|skip`（默认 `wait`，由用户选择）。
- **通知**：ntfy、webhook，附带签名的一次性审批链接（15 分钟有效，需 owner 会话或 TOTP 二次确认）。Inbox 页面适配手机。
- **随时编辑**：修改会让待执行任务失效。预计重跑成本超过阈值（默认 20 个 run，或任一订阅周窗口的 5% 以上；API 账号另加 $5）时，需要二次确认并显示估算。
- Inbox 的事项和动作与上一版相同。“附笔记重写”的笔记进入 L3.9。

---

## 8. MCP “novel-state” 服务

**决策：正确性只依赖文件。只读 MCP 在 P3+ 交付，默认 `auto`。**

- **监听隔离**：MCP 只挂在 orchestrator 的**内部监听器**上，以 unix socket `$DATA/run/mcp.sock` 形式绑入沙箱；不支持 socket 的 harness 用 `127.0.0.1:<internal-port>`。对外监听器上不注册 `/mcp`。拆分档通过 `NOVELIST_INTERNAL_URL` 加共享密钥或 mTLS 连接。
- run token 为 256 位随机值，绑定书、任务、可见章上限和检索预算，run 结束即吊销。
- 工具集在上一版基础上新增 `count_cjk(path, by_beat?)`。返回的检索结果统一带 override 标注。
- 注入方式与上一版相同（codex 的 dotted override、grok 的 token 注入都标 **(verify)**）。

---

## 9. 产品界面

### 9.1 网页阅读器

与上一版相同。各项内容的来源说明：
- 章节标题来自 `card.title` 或 writer 的提议，卷名来自卷 yaml 的 `title`。
- 书籍简介来自 `book.blurb`，每卷末刷新。
- 封面由可选插件 `media.cover` 生成。

### 9.2 管理控制台

与上一版相同，以下几项有改动：
- **指令页**：增加“生效 gate 清单”，按层来源着色；增加首尾 nonce 状态矩阵；超出预算时显示“该 profile 不可承载”。
- **Harness 与账号页**：
  - 账号录入（D5）：env 变量、上传凭据文件、网页交互登录（输出流式显示，带输入框）；
  - cc token 可以在此录入，加密入库，显示预计到期日（§3.7）；
  - 每个账号的认证模式和风险标签，以及 UI 显示的风险说明（agy consumer、API 账号）；
  - 模型 slug 核对结果；
  - 当前隔离后端和 `doctor` 的探测结果；
  - 安装操作默认只生成命令。
- **路由页**：可行性检查和降级项展示；“每窗口实测章数”；各订阅窗口的占用率、预留量和重置时间。
- **质量页**：里程碑 vs 字数位置曲线、弧指纹相似度、extractor 召回统计、已审计前沿和发布前沿。
- 界面语言为中文，组件设计为可扩展 i18n。

### 9.3 CLI

与上一版相同，有以下改动：
- 认证：owner 在 UI 签发可吊销的 PAT，存放在 `~/.config/novelist`。`--local` 走 unix socket，只在本机可用。
- 新增命令：`novelist supervise`、`novelist backup|restore`、`novelist secrets rotate-master-key|export-master-key`、`novelist migrate-book <slug>`、`novelist doctor --fix-hints`、`novelist routing check <slug>`。
- 删除网页 PTY 相关命令。

### 9.4 连载发布

**D4 已确认以下配置为默认值**：存稿后定时发布，lag 约等于一个弧（最少 15 章），要求已审计，存稿上限 60 章，超过即暂停生产。

```yaml
publish:
  mode: scheduled            # 默认（D4）。immediate（lag=0，v1 行为）只作为显式选项
  cadence: "0 8,20 * * *"
  per_slot: 1
  lag: auto                  # auto = max(当前弧长, 15)；可显式设数字，但不得小于 15
  require_audited: true      # audited_through ≥ 章号才发布（§6.10）
  max_buffer: 60             # 缓冲超过即暂停该书生产，把订阅窗口让给其他书
  resume_buffer: 45          # 回落到此值以下才恢复生产，避免在 60 附近反复启停
  freeze_on_publish: true
```

- 存稿还承担一个职责：吸收订阅周上限造成的生产暂停（§7.5）。UI 显示“按当前存稿可以维持发布的天数”，低于 3 天时发 Inbox 提醒。
- 存稿不足 lag 时，publisher 不追赶发布，宁可暂停定时槽位，也不发布未审计的章节。

`immediate` 模式下，弧审计发现的问题只能通过 override 和后文补圆处理。UI 会说明这一点。

### 9.5 导出

与上一版相同。

### 9.6 多读者访问与 HTTPS

- 读者支持“仅密码”单框登录，兼容 v1。实现方式是按独立的 lookup id 查找（密码以 HMAC 前缀索引），不遍历 hash。label 为可选项。
- **TLS 三档**，由用户选择：
  - (a) compose 内置 Caddy，自动 HTTPS；
  - (b) 用户自带反向代理（`NOVELIST_TRUST_PROXY=1`）；
  - (c) 仅局域网 http（`NOVELIST_INSECURE_COOKIES=1`，cookie 不设 Secure，UI 常驻红色警示）。

  `doctor` 和首页会检测访问协议，不匹配时给出提示。
- 其余与上一版相同：argon2id、按 IP 和 label 限速、签名 URL、同源 CORS。

### 9.7 API 契约

- 用 zod 生成 OpenAPI 3.1，前端、CLI、MCP 共用。
- 端点分组：
  - `/api/reader/*`：书库、章节、进度、导出、feed；
  - `/api/admin/books|plan|chapters|entities|obligations`；
  - `/api/admin/tasks|runs`：日志、kill、retry；
  - `/api/admin/inbox`；
  - `/api/admin/instructions`：render、预览、生效 gate；
  - `/api/admin/harness|accounts|routing|budget|genres|readers|settings`。
- 分页用 cursor。错误格式为 RFC 9457 problem+json。
- **SSE 事件**：沿用 v1 词表，新增 `run_started`、`run_event`、`run_exit`、`quota_wait`、`inbox_new`、`chapter_accepted`、`chapter_published`、`circuit_changed`。

---

## 10. 数据、部署、可观测性、测试、安全

### 10.1 存储、保留与容量

文件系统 `$DATA` 的目录与上一版相同，有以下变化：
- `runs/YYYY-MM/<id>/{in/, log/}`，活跃 run 用 `runs/active/<id>` 软链指向。
- `homes/` 拆成 state 和 config 两部分。

**保留策略：**
- `run_events` 保留 30 天。
- 原始流默认只保留**已验收章节对应的 run**，其余 30 天后删除。保留时长和是否删除思考内容由用户决定（§13）。

**容量表**（估算，1000 章 soak 测试中实测后断言上限）：

| 项 | 每百万字 |
|---|---|
| 书库 git（不含派生文件） | 5–15MB |
| run 原始流（zstd，只保留验收章节） | 0.5–2GB |
| Postgres（run_events 30 天） | 1–3GB |
| `.index/`（BM25 + 别名） | 50–150MB |

**Postgres 17**：表与上一版相同，完整 DDL 见附录 C。P1 只支持 Postgres。PGlite 推迟到 P3 以后，它只允许单连接单进程，所以 embedded 档下 CLI 必须经过 serve 的 API 或 socket，`--local` 只在 serve 停止时可用。P0 增加一项：PGlite 在同进程共享单连接时的吞吐，以及崩溃后的 WAL 恢复。

**备份**（`novelist backup`，每晚执行）：
- 所有 git 仓库（books、config、instructions/global、genres）做 `git bundle`；
- `secrets/` 和 `homes/*/state`（排除 sessions）加密打包；
- `media/`；
- `pg_dump`。

恢复用 `novelist restore`。chaos 测试包含“从备份恢复到新主机”的演练。master key 可以导出成纸质或密码管理器副本，用 `secrets rotate-master-key` 轮换。master key 丢失意味着所有密钥都无法恢复，这一点在 `init` 时明确提示。

### 10.2 部署

> **D3 落地**：下面的 compose 和 §10.2.1 的拆分写法是设计原稿。目标主机上实际是单容器 all-in-one，复用现有 Postgres 16（新库 `novelist2`），cc token 在 Web UI 录入，不用 secret 文件。实际部署要点见 `docs/v2/IMPL.md` §11。镜像只由 GitHub Actions 构建，不在部署机或开发机上本地构建。

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    healthcheck: { test: ["CMD", "pg_isready"] }
    volumes: ["./pgdata17:/var/lib/postgresql/data"]          # 不复用 v1 的 ./pgdata（PG16）
  novelist:
    image: ghcr.io/<owner>/novelist:2.x
    command: ["supervise", "--", "serve"]
    restart: unless-stopped
    stop_grace_period: 90s
    ports: ["${NOVELIST_PORT:-8000}:8000"]
    volumes: ["./data2:/srv/novelist", "harness:/opt/harness:ro"]
    environment:
      NOVELIST_DATABASE_URL: postgres://novelist:${NOVELIST_PG_PASSWORD}@postgres/novelist
      NOVELIST_MASTER_KEY: ${NOVELIST_MASTER_KEY}
      NOVELIST_ISOLATION: auto                                 # auto|bwrap|landlock|container|degraded
    secrets: ["cc_oauth_token"]                                # 用户提供的文件，挂到 /run/secrets/（§3.7）
    # 想用 bwrap 档时取消注释（doctor 会给出具体建议）：
    # security_opt: ["seccomp=./seccomp-bwrap.json", "apparmor=unconfined", "systempaths=unconfined"]
    mem_limit: 8g
    read_only: true
    tmpfs: ["/tmp"]
    user: "10001:10001"
    init: true
    depends_on: { postgres: { condition: service_healthy } }
  harness-installer:
    profiles: ["install"]
    image: ghcr.io/<owner>/novelist:2.x
    command: ["harness", "install-from-lock"]
    volumes: ["harness:/opt/harness", "./data2/config:/srv/novelist/config:ro"]
  caddy:
    profiles: ["https"]
    image: caddy:2
    ports: ["443:443", "80:80"]
volumes: { harness: {} }
secrets: { cc_oauth_token: { file: ./secrets/cc_oauth_token } }   # chmod 600，不入任何 git 仓库
```

- **镜像**：`node:24-bookworm-slim`（按 digest 锁定），加 git、ripgrep、bubblewrap、tini，以及 `/opt/novelist/bin/{nv-shim,nv-jail,nv}`。非 root 运行。镜像**不内置**专有 harness，由 installer 在用户本机下载。
- **多架构**：镜像按 `linux/amd64,linux/arm64` 构建。五家 harness 都有 linux-arm64 构建，已在 aarch64 主机上实测：
  - claude 2.1.319 是原生 aarch64 ELF；
  - codex 通过 `@openai/codex-linux-arm64`（musl）提供；
  - agy 1.5.3 是 aarch64 ELF；
  - grok 通过 `@xai-official/grok-linux-arm64` 提供；
  - dsh 是 Node 包（Node ≥24.9），`node-pty` 的预编译产物包含 linux-arm64。

  installer 按主机架构拉取锁定版本，并关闭自动更新（`DISABLE_AUTOUPDATER=1`、`GROK_DISABLE_AUTOUPDATER=1`，agy 和 codex 锁定版本）。
- **拆分档**：runner 单独成一个很少升级的容器，以实现零中断升级。
- **宿主机 runner**：适用于需要宿主机登录、cgroup 委派，或想用最强 bwrap 档的情况。
- **CI**：与上一版相同，加上沙箱一致性套件。CI 同时构建 amd64 和 arm64。

#### 10.2.1 目标主机：Proxmox 主机上的 Docker LXC（D3）

**实际环境（D3 落地事实）**：目标主机是 arm64，PVE 9.0.10，内核 6.12。Docker LXC 是**特权 LXC**，`nesting=1`，AppArmor unconfined，compose 目录 部署目录，主机端口 8199，前面是 Nginx Proxy Manager。本节下面关于“推荐非特权 LXC”和“架构未确认”的内容是早期分析，以这里的事实为准。

Novelist 以 docker compose 运行在 Docker LXC 里，嵌套层级是 Proxmox 宿主机 → LXC → Docker → harness。

**LXC 要求：**
- 推荐非特权 LXC，设置 `features: nesting=1,keyctl=1`；`fuse=1` 可选。
- **PVE ≥9.1**。2025 年 11 月 containerd 1.7.28-2 / runc 的一次更新导致 Docker 在 LXC 中报 `open sysctl net.ipv4.ip_unprivileged_port_start … permission denied`。论坛反馈 PVE 9.1 已修复（runc #4968，PVE bug 7006，**M**）。
- 特权 LXC 加 `lxc.apparmor.profile: unconfined`、`lxc.cap.drop:` 也能跑，但它等同于宿主机 root，**不推荐**。有一篇 PVE 9.0 的文章声称非特权 LXC 跑 Docker 29 走不通（**L/M**），这与 9.1 已修复的说法冲突，需要在 P0 实测。
- AppArmor：Proxmox 的 `nesting=1` 会替换自定义的 AppArmor profile。在非特权 LXC 里，Docker 通常无法加载 `docker-default`，所以真正拦住 bwrap 的是 seccomp，不是 AppArmor。

**嵌套环境下各隔离档的预期**（`doctor` 实测为准，结果显示在 UI 上）：

| 档 | Docker LXC 中的预期 | 怎样才能可用 |
|---|---|---|
| `bwrap` | **不可用**。Docker 默认 seccomp 拦截 `unshare`/`clone(CLONE_NEWUSER)`，masked `/proc` 让 bwrap 挂不上新的 `/proc`；PVE 8 的 LXC 里还出现过 `/proc/sys/user/max_user_namespaces: Read-only file system`（**M**，那次失败可能来自 flatpak 用的 `--disable-userns` 路径） | 让 novelist 容器使用放行 `unshare` 和 `clone(CLONE_NEWUSER)` 的自定义 seccomp profile，加上 `apparmor=unconfined`、`systempaths=unconfined`；LXC 设置 `nesting=1,keyctl=1`。即便如此仍可能失败，属于高级选项 |
| `landlock` | **默认不可用**，因为 PVE 内核的 `CONFIG_LSM` 不含 landlock | 在 宿主机的内核命令行加 `lsm=landlock,lockdown,yama,integrity,apparmor` 并重启。启用后，Landlock 在 LXC 和 Docker 内都能用，不需要特权，Docker 默认 seccomp 也放行它。代价是这会影响宿主机上的所有 guest；Proxmox 员工表示 AppArmor 与 Landlock 叠加“in theory supported but might not work well in practice” |
| `container` | **默认档**（宿主机未启用 Landlock 时） | 采用拆分部署：按 harness 拆出 runner 容器（`--roles runner --harness codex` 等），每个容器只挂载本 harness 的账号 home 和 `runs/by-harness/<id>/`，书库只读挂入；接入 `internal: true` 的网络，经 `egress` 白名单代理容器出网 |
| `degraded` | 兜底 | — |

- **harness 自带沙箱一律不依赖**。在 Docker LXC 里，harness 统一跑最宽松的非交互模式（§3.5），隔离由外层负责：
  - 可选的 `oci` 变体：每个 run 起一个一次性容器，非 root，只有本书工作区可写，凭据只读挂载。它需要一个只放行 create、start、wait、rm 操作和固定镜像的受限 docker API 代理，是否采用见 §13。
  - 如果想用 harness 自带的沙箱（cc 设置 `sandbox.enableWeakerNestedSandbox: true` 和 `failIfUnavailable: true`，以及 `allowNestedUserNamespaces`，需要 ≥2.1.305），需要上面那组 seccomp/apparmor/systempaths 放开，并且仍有失败报告（**L**）。所以**推荐改用 Proxmox VM**，而不是 LXC。
- **架构**：目标主机的架构未确认（§13）。
  - Proxmox VE 官方只提供 amd64，arm64 只有社区移植。如果目标主机是 Oracle Cloud 的 Ampere ARM VM，它跑的就是社区版 PVE，内核配置可能和官方不同，`doctor` 的 LSM 探测因此更加重要。
  - 镜像是多架构的，两种情况都支持。
- **Docker LXC 的 compose 覆盖文件**（`compose.lxc.yml`）：

```yaml
services:
  postgres:
    networks: [default, internal]                  # runner 容器经 internal 网络认领任务、续租
  novelist:
    command: ["supervise", "--", "serve", "--roles", "web,orchestrator"]   # 主容器不跑任何 harness
    secrets: !reset []                              # cc token 只挂进 runner-cc（Compose ≥2.24 的 !reset）
    networks: [default, internal]
  runner-cc:
    image: ghcr.io/<owner>/novelist:2.x
    command: ["supervise", "--", "runner", "--harness", "claude-code"]
    read_only: true
    user: "10001:10001"
    environment: { NOVELIST_ISOLATION: auto, NOVELIST_DATABASE_URL: "${NOVELIST_RUNNER_DB_URL}", HTTPS_PROXY: "http://egress:3128" }
                                                    # auto：宿主机已启用 Landlock 时选 landlock，否则选 container
    secrets: ["cc_oauth_token"]
    volumes: ["./data2/books:/srv/novelist/books:ro", "./data2/runs/by-harness/claude-code:/srv/novelist/runs/by-harness/claude-code",
              "./data2/homes/claude-code:/srv/novelist/homes/claude-code", "harness:/opt/harness:ro"]
    networks: [internal]
  runner-codex:
    image: ghcr.io/<owner>/novelist:2.x
    command: ["supervise", "--", "runner", "--harness", "codex"]
    read_only: true
    user: "10001:10001"
    environment: { NOVELIST_ISOLATION: auto, NOVELIST_DATABASE_URL: "${NOVELIST_RUNNER_DB_URL}", HTTPS_PROXY: "http://egress:3128" }
    volumes: ["./data2/books:/srv/novelist/books:ro", "./data2/runs/by-harness/codex:/srv/novelist/runs/by-harness/codex",
              "./data2/homes/codex:/srv/novelist/homes/codex", "harness:/opt/harness:ro"]
    networks: [internal]
  egress:
    image: ghcr.io/<owner>/novelist-egress:2.x     # 白名单正向代理，按 harness 放行厂商 API 域名
    networks: [internal, default]
networks: { internal: { internal: true } }
```

- runner 容器之间不共享凭据：cc token 的 secret 只挂进 runner-cc。主容器（web、orchestrator）持有全部书库、`secrets/` 和 master key，所以**不在主容器里跑任何 harness**，否则 `container` 档的边界就不成立。
- runner 容器用 `NOVELIST_RUNNER_DB_URL` 连接一个**权限受限的 Postgres 角色**：只能认领任务、续租 lease、写 `run_events` 和 run 状态，不能改其他表。正典在 git 里，只有 orchestrator 能提交。
- codex run 的快照（worktree）和 `in/` 由 orchestrator 在 `runs/by-harness/codex/<id>/` 下准备好；runner-codex 只负责认领、spawn、tail 和续租。容器内外路径保持一致，`git worktree` 的 gitdir 指向只读挂入的 `.git`。

### 10.3 可观测性

与上一版相同，新增以下指标：
- `nv_isolation_backend`
- `nv_denials_total{harness,role}`
- `nv_extract_recall{profile}`
- `nv_rebase_total{result}`
- `nv_stale_total{kind,dep}`
- `nv_gate_first_pass_ratio{profile,rule}`
- `nv_tokens_per_chapter{profile,tier}`
- `nv_model_changed_total`
- `nv_audited_frontier{book}`
- `nv_quota_util{account,window}`、`nv_quota_reserved{account,window}`
- `nv_chapters_per_window{profile,window}`
- `nv_buffer_days{book}`（按当前存稿能维持发布的天数）

### 10.4 测试策略

与上一版相同，以下几项有调整：
1. **单元与属性测试**：新增 fold 级联重放、投影 snapshot、tmp id 映射、ev 模糊匹配、受控词表、谓词 AST、TOML 序列化（DEL、控制字符）、dsh `{{` 转义、层顺序（最后一个块来自书层）。
2. **Golden 测试**：新增 1500 章合成 fixture 的 section 配额断言，以及各 harness argv 挂载可见性。
3. **fake**：P1 只做通用 fake adapter 加 fixture 回放，故障注入包括信号处理、慢速滴出、越界读写、改写 home 配置、读取 `$RUN/in` 偷 nonce。
4. **沙箱一致性套件**：在每种隔离后端里实际执行越界尝试，断言全部失败。尝试内容包括：读其他书、读 `secrets/`、读其他账号 home、写 out/ 以外的路径、修改 home 配置（landlock 档断言 hash 校验能抓到）、访问非白名单域名。CI 和 `doctor` 都运行。
5. e2e 与 chaos：新增“写作与规划并发 200 章不活锁”和“备份恢复演练”。
6. live canary 和质量回归与上一版相同（P4）。

### 10.5 升级与书库格式演进

- `book.yaml: format_version`。启动时发现格式版本旧的书，该书暂停并进 Inbox。`novelist migrate-book` 是幂等的，单独成一个 commit，带 `Novelist-Migration` trailer。
- **升级手册**：drain lanes（停止派发，等当前 run 结束）→ backup → 迁移 → canary → resume。
- drizzle 迁移只前进不后退，回滚靠备份恢复。
- `pipeline_ver` 或 L0 契约变化时：进行中的 run 不受影响；新任务使用新 id；根 AGENTS.md 在下一次 promote 时重新生成。

### 10.6 安全与威胁模型

| 资产 | 攻击者 / 入口 | 可达面 | 缓解 |
|---|---|---|---|
| 厂商凭据（env、账号 home） | 导入文本或用户样本里的 prompt 注入 → agent | 带 shell 的 harness 能读 env 和 home；其余能用 Read 读 home | 隔离后端只放行本账号 home；带 shell 的 harness 默认 egress 白名单；不可信文本默认不交给带 shell 的 profile；cc `blockReads…`；残余风险是 DNS 外传 |
| 后续 run 的配置（hooks、config、MCP） | 同上 | 可写的 home | 配置每个 run 重新生成，bwrap 档只读覆盖，landlock 档做 hash 校验并熔断 |
| 其他书和 secrets | 同上 | 无（被遮蔽或不在 Landlock 允许集） | 沙箱一致性套件 |
| 书库正典 | agent 越界写 | 只有 out/ | 唯一 committer，产物清单校验 |
| 管理面 | 公网攻击者 | 对外监听器 | argon2id、限速、TOTP、Origin 校验、CSP；MCP 不在对外监听器上 |
| 手稿隐私 | 厂商侧 | 所有模型调用 | 遥测、记忆、会话上传全部关闭，每个 run 校验；可设书级厂商白名单 |

- **Docker LXC（`container` 档）的残余风险**：
  - 带 shell 的 codex 能读到本 runner 容器内的全部内容：codex 账号 home、所有书的只读副本、codex 的 run 目录。它读不到 cc token 和 `secrets/`。
  - codex 只承担输入可信的角色（草稿、卡片、snapshot 切片），不读 v1 导入文本和用户样本。
  - 出网在容器网络层强制白名单。
  - codex 的 shell 能读到同容器 runner 进程的环境变量，因此 runner 的 DB 凭据只对应受限角色（§10.2.1）。它最多能伪造本 harness 的 run 状态，伪造的产物仍要经过 orchestrator 的 validators 和唯一 committer。
- **凭据**（D5）：cc token、API key 等秘密在 Web UI 录入，AES-256-GCM 加密入库，主密钥来自 `NOVELIST_MASTER_KEY` 或 `/data/.master_key`。主密钥要单独备份，丢失后已入库的秘密无法解密。codex 和 grok 的 `auth.json` 属于账号 home 的状态部分，按 §10.1 加密备份。

其余（密钥管理、供应链、Web 防护、审计日志）与上一版相同。

---

## 11. 从 v1 迁移

> **目标主机上的实际做法（D3 落地）**：v2 用现有 Postgres 16 上的新库 `novelist2`，不新建 PG17 数据目录。导入器从 `NOVELIST_V1_DATABASE_URL` 指向的旧库 `novelist` 读 v1 表，v1 的数据不动，也不需要 `pg_dump`。可以在 Web UI 的“v1 导入”页操作，也可以用 `novelist import-v1`。下面的步骤是 v1 和 v2 不共用 Postgres 时的通用路径。

**升级步骤：**
1. 停掉 v1（`docker compose down`），保留 v1 的镜像和卷 N 天（默认 30 天）用于回滚。
2. `pg_dump` v1 数据库。
3. v2 使用新卷 `./pgdata17` 和新目录 `./data2`，不复用 `./pgdata` 和 `./data`，因为 PG17 不能直接打开 PG16 的数据目录，v1 目录的属主也是 root。
4. `novelist import-v1 --pg <v1 url 或 dump 恢复到的临时实例>` 或 `--sqlite`。
5. `chown -R 10001 ./data2`，验证后启动。

**导入内容：**
1. **读者**：保留“仅密码”登录。PBKDF2 hash 加上前缀后保留，首次登录成功时重新 hash 为 argon2id，同时建立 lookup 索引。阅读进度按章序号映射。管理员密码重置。
2. **主题 → 题材包**；v1 的内容分级元数据原样保留。
3. **书**：处理方式与上一版相同。角色 id 用拼音，冲突时加序号。v1 中 `status=writing` 的半成品章节默认丢弃，并在报告中列出（可选择导入为草稿）。
4. **状态**：已完结的书归档只读，未完结的书暂停。`--bootstrap-extract` 时：
   - 把章节原文**内联进 work order**，每次抽取一批（默认 5 章），以减少 turn 数；
   - 执行前显示**按 P0 实测值计算**的成本估算（多 turn 方式下每章可能达到 150–300k token，批量内联后预计显著降低）；
   - 导入的 v1 文本按不可信数据处理，默认路由给没有 shell 的 profile。
5. **不导入**：与上一版相同。

---

## 12. 分阶段路线图

按 D1，下面 P0→P3 的全部内容都要实现，可靠性机制不做简化。阶段顺序只是交付顺序，默认值以 D2（修订）为准：默认质量档是 `standard`，默认路由 preset 是 `agy-argon`；`key` 档和 opt-in 机制照常交付，按书开启。

**P0：Spike 与验证（2–3 周）。**
- 锁定版本，录制 fixtures。
- 实测：
  - 每个 profile 的每章 token 数；
  - **每个订阅窗口能写几章**：按账号实测 writer 和校验类角色的每章 `util_delta`（5 小时窗口和每周窗口）；
  - 各 profile 一次过 gate 的概率；
  - 订阅 headless 的实际行为：
    - cc `setup-token` 在 `-p` 下能否稳定使用（有 401 报告），以及 `ANTHROPIC_API_KEY` 不存在时确实走订阅池；
    - codex device-auth、`auth.json` 刷新和并发；
    - grok device-auth 和缓存登录；
    - 各家额度信号的格式。
  - **Docker LXC 实测**：
    - 目标主机的架构和 PVE 版本；
    - 非特权 LXC 加 `nesting=1,keyctl=1` 能否跑 Docker；
    - `/sys/kernel/security/lsm` 的内容，以及 bwrap 和 Landlock 的探测结果；
    - `container` 档的挂载和 egress 强制；
    - 启用 `lsm=landlock,…` 之后 Landlock 在 LXC+Docker 内是否生效。
- 验证以下 (verify) 项：
  - dsh：`--json` 是否存在；`{{` 的转义写法；profile 依赖；禁用 shell 以外工具的 patch 行名。
  - codex：关闭 shell、web、子代理的配置键；`-c` 的 TOML 传值方式；dotted MCP override。
  - grok：`--leader-socket`；`GROK_HOME` 下的 hooks 路径；`read_file` 能否读 gitignore 路径；hook 是否触发。
  - agy：首次启动是否下载组件；custom agent 是替换还是扩展；deny 规则中的工具名；Argon 能否用 API key 访问。arm64 版本已核实存在。
  - cc：`memory_paths`；Stop hook 是否生效。
  - bwrap：信号是否转发，`--info-fd` 是否可用。
  - Landlock：ABI≥4 的网络限制。Docker 默认 seccomp 放行 landlock 系统调用这一点已核实，但 Proxmox 内核默认不启用 Landlock。
  - 各 harness 是否遵守 `HTTPS_PROXY`。
  - `git worktree add` 的耗时。
  - receipt schema 方言是否被各家接受。
- **出口条件**：
  - 每个 harness 都有在真实隔离后端里 canary 通过的 `capabilities.json`，并且首尾 nonce 都正常；
  - 隔离后端在 Debian 12、Ubuntu 24.04、rootless podman、Debian 13 arm64、**Proxmox LXC（Docker LXC）** 上实测可选出可用档；
  - 每章的订阅窗口消耗账本已经建立。

**P1：最小可靠闭环（6–8 周）。**
- monorepo、Postgres schema 与迁移、书库格式、指令编译器（cc 和 codex 两个物化目标，含层顺序 golden test）。
- **cc、codex 两个 adapter**，加通用 fake 和 fixture 回放。这两家足够先跑通 lite 档全流程。默认 preset 需要的 agy adapter 排在 P2，实际实现时各 adapter 同时交付（见 IMPL）。
- **账号凭据与最小配额闭环**：env 变量、上传凭据文件、网页交互登录（D5）；解析额度信号并 `sleep_until` 重置；`quota_reservations` 准入与预留；`reserve_pct`。没有额度管理就无法无人值守，所以这部分从 P2 提前。
- nv-shim、supervise、lease；bwrap、landlock、`container`、degraded 四种隔离后端，包括 Docker LXC 的拆分 runner 和 egress 代理；run 快照（worktree）。
- 开书管线（不含 bake-off，主笔手选）；**单章流水线先交付 `lite` 档**：`chapter.check`、`format.repair`、确定性 `audit.window`、轻量 `audit.arc`（弧指纹在 P3 补上）、`summary.arc/volume`。
- checker 的最小降级链（按 `chain` 和 `degrade_to` 降级，最后 `awaiting_check`，§7.4）。完整的角色链、多账号降级阶梯和可行性检查在 P2。
- **最小 gate 集**：I/O 契约 gate，加工艺 gate 中的总长、截断、占位、结尾标记、章内重复，全部可覆盖。
- delta.check 包括 ev 模糊匹配、confirm.query（合并成一次 run）、召回探针。
- 存稿定时发布（D4 默认）：lag、`require_audited`、`max_buffer` / `resume_buffer`。
- 级联一致性；两类依赖的 stale check 与 rebase。
- 提交协议与崩溃恢复；CLI（PAT）；device-code 登录；阅读器迁移（仅密码登录）；基础管理界面（runs、Inbox、指令预览）；all-in-one 镜像；备份与恢复。
- **出口条件**：在 Docker LXC 上用 Web UI 配置的路由和档位无人值守写 100 章，跨越至少一次周窗口重置，系统状态零人工修复；fake 200 章 e2e、chaos 测试和沙箱一致性套件全绿；gate 一次通过率 ≥90%。

**P2：多 harness 与配额（4–6 周）。**
- grok、agy、dsh 三个 adapter。每家都必须先通过 nonce canary 和沙箱一致性套件。
  - agy 照常启用，UI 显示 consumer OAuth 的风险说明（D5）；
  - dsh 启用，用户在 UI 配 `DEEPSEEK_API_KEY`（D5）。
- ACP 备用驱动；账号与 home 拆分；完整的多账号配额管理与跨书窗口分配；角色链；降级阶梯与可行性检查；写手粘性与 failover 提案；按比率熔断；canary 晋级；通知与签名审批链接。
- **`standard` 档交付（D2 修订后是默认档）**：reviewer、单 judge、修订 pairwise。
- **出口条件**：用户实际持有的订阅组合下，3 本书并行运行 14 天，除审批外不需要人工干预。

**P3：百万字质量（按数据推进）。**
- 伏笔看板与上限、closure capacity、里程碑曲线；
- 默认开启：弧指纹、摘要锚点审计；
- **opt-in 交付**（默认关）：交叉抽取、held-out、bake-off、`key` 档、judge panel、模型版 window 审计、fresh-reader 测试、pairwise 漂移回归；
- 按卷 EPUB；import-v1 bootstrap。
- **出口条件**：一本书以该书设定的档位突破 1M 字，没有未解决的 hard 级发现，确定性指标（gate 一次通过率、check flag 率、债务增长率）没有持续恶化。每 300 章 held-out 退化 <0.5 这一条只在开启 held-out 时考核。

**P3+ / P4（每项都要先有数据证明它在解决实际问题）。** stylometrics、模型指纹、MinHash 跨章重复、best-of-N、跨厂商 editor、只读 MCP、PGlite、Studio 模式、pi adapter、通用 ACP registry、分 CLI 仿冒的 fake、PWA、分页、Atom、TOTP、每晚 live canary、质量回归 Elo、题材包市场。

**P5（可选）。** 推测流水线、embedding、多主机 runner、读者 persona 评审、插图。

MVP（P0+P1）约 2–2.5 个月。最小配额闭环和 `container` 档提前到 P1，可能多出约 1 周。所有阶段都要跟随几家 CLI 的频繁发版持续维护，订阅条款也要定期复核（§3.7）。

---

## 13. 待用户决策

### 13.1 已决定（2026-11-08，D1–D6）

- ✅ **已决定：账号与认证方式**（原第 1、5 项的方式部分）。D2（修订）+ D5：账号和认证方式都在 Web UI 配置，不需要预先决定。
  - 每个账号支持 env 变量、上传凭据文件、网页交互登录，秘密加密入库；
  - cc 同时支持订阅 OAuth token 和自定义 API；
  - agy（含 consumer OAuth）照常使用，UI 只显示风险说明；
  - dsh 启用，用户在 UI 配 `DEEPSEEK_API_KEY`。

  §3.7。
- ✅ **已决定：范围与默认质量档位**（原第 7 项）。D1 + D2（修订）：
  - 完整实现 P0→P3；
  - 默认 `standard` 档，`lean`/`lite`/`standard`/`key` 按书可选；
  - held-out、bake-off、交叉抽取、pairwise 回归等是 opt-in，默认关闭。

  §6.4、§12。
- ✅ **已决定：默认路由**（D2 修订）。默认 preset 是 `agy-argon`，全部角色走 agy + Gemini 4 Argon，另有 `cc-only`、`codex-only`、`mixed`。廉价模型只用于开发测试。§7.4。
- ✅ **已决定：发布策略**（原第 8 项）。D4：存稿后定时发布，`lag: auto`（≥ 弧长，最少 15 章）、`require_audited: true`、`max_buffer: 60`（超过即暂停生产），另加 `resume_buffer: 45` 防止反复启停。§9.4。
- ✅ **已决定：extractor 的档位与交叉抽取**（原第 12 项）。D2（修订）：extractor 按路由配置，默认走 `agy-argon`，`lite` 档下并入 `checker`；交叉抽取是 opt-in，默认关闭。§6.6。
- ✅ **已决定：部署主机**（原第 3 项的主机部分）。D3：目标主机的 Docker LXC，用 docker compose 部署，arm64、特权 LXC，端口 8199，新库 `novelist2`。§10.2.1。隔离档的细节见 ★5。
- ✅ **已决定：预算口径**（原第 2 项的口径部分）。D2（修订）：吞吐和预算在 Web UI 按书配置。订阅账号以窗口占用率计，API 账号可以设 USD 上限。
- ✅ **已决定：规模**（D6）。目标字数、卷数、每卷章数、单章长度按书在 UI 配置。
- ✅ **已决定：主笔选择方式**（原第 17 项）。D2（修订）：
  - 不做开书 bake-off（opt-in）。主笔默认是路由 writer 链的第一个 profile，由你确认。
  - 额度窗口耗尽时不 failover，一律等待重置。
  - 只有 auth 失效、熔断或模型下架时，6 小时后生成 failover 提案，由你批准。

  §6.0、§7.4。

### 13.2 待决定

按重要性排序。标 ★ 的原本需要你拍板。D2（修订）、D3（落地事实）、D5、D6 之后，第 1、2、3、4、6、8 项已有结论，见各条的“已决定”；第 5、7 项的推荐默认仍然有效。其余可以采用推荐默认。

1. ★ **你实际持有哪些订阅档位**
   - **已决定（D2 修订）**：不需要预先决定，账号和档位都在 Web UI 配置。下面的内容只作配置参考。
   - 问题：
     - cc 是 Pro、Max 还是 Ultra？verified Ultra 没有 5 小时窗口，周额度约为 Pro 的 10 倍；Max 约为 5 倍。
     - ChatGPT 是 Plus 还是 Pro？Pro 没有 5 小时窗口。
     - 是否还持有 SuperGrok / X Subscription、Google AI Pro/Ultra？
   - 推荐默认：写手账号选额度最高的档位，其余按所选 preset 配置。
   - 影响：每个窗口能写几章（§7.5），以及 opt-in 评审机制能否满足厂商约束。

2. ✅ **目标主机的架构与 Proxmox 版本**（已确认，D3 落地事实）
   - 目标主机是 arm64，PVE 9.0.10，内核 6.12。
   - Docker LXC 是特权 LXC，`nesting=1`，AppArmor unconfined。
   - 影响：镜像必须提供 arm64；`doctor` 的探测基线按这个环境确认。

3. ✅ **agy consumer 订阅的包装风险**（已决定，D5）
   - 官方 FAQ 明确说把 agy 包装进第三方应用“not supported under consumer plans”，并且可能封号。
   - 结论：agy（含 consumer OAuth）照常使用，默认 preset 就走 agy，UI 只显示风险说明。也可以在账号页改用 Google AI Studio 或 Gemini Enterprise 的 API key。

4. ✅ **dsh 没有订阅**（已决定，D5）
   - 结论：dsh 启用，用户在 Web UI 填 `DEEPSEEK_API_KEY`，可以设月度 USD 上限。默认 preset 不依赖它。

5. ★ **Docker LXC 中的隔离档，以及带 shell 的 harness 的边界**（合并原第 3、4、30 项）
   - 问题：
     - 嵌套环境下 bwrap 预期不可用。
     - Landlock 需要在 宿主机内核命令行加 `lsm=landlock,…` 并重启，这会影响宿主机上的所有 guest。
     - codex 无法关闭 shell，选用 codex 的 preset 里它要承担校验类角色。
   - 选项：
     - (a) 接受 `container` 档：按 harness 拆分 runner 容器，在网络层强制 egress 白名单，codex 只处理可信输入；
     - (b) 在宿主机启用 Landlock，得到 run 级的 OS 边界；
     - (c) 再加 `oci` 变体，每个 run 一个一次性容器。这需要给 Novelist 一个受限的 docker API 代理，即原第 30 项的 docker.sock 问题；
     - (d) 改用 Proxmox VM，以便使用 bwrap 和 harness 自带的沙箱。
   - 推荐默认：先用 (a)，P0 实测后再决定是否加 (b)（D3 落地：目标主机上是单容器 `container` 档，不拆 runner）；不挂载裸 docker.sock。degraded 档仍然允许无人值守，但只限没有 shell 的 harness；v1 导入文本和用户样本只交给没有 shell 的 profile。
   - 影响：安全强度、对宿主机其他 guest 的影响，以及部署复杂度。

6. ★ **吞吐目标与订阅占用上限**（合并原第 2、33 项）
   - **已决定（D2 修订）**：吞吐、预算在 Web UI 按书配置，不需要预先决定。下面的内容只作配置参考。
   - 问题：
     - 同时写几本书？每本每天多少章？
     - 给你自己的交互使用留多少额度？Claude 和 Claude Code 与 Novelist 共用 cc 额度，ChatGPT 也是一样。
     - 周上限导致写作暂停几天，是否可以接受？
     - 每晚 live canary 会占用订阅窗口，要不要开？
   - 推荐默认：`reserve_pct: 30`、`max_weekly_util: 70%`；1–2 本书；每天发布 2 章，由存稿缓冲；先不开 live canary。P0 测出每个窗口能写几章之后再定。
   - 影响：写作速度，与你日常使用 Claude 和 ChatGPT 的余量之间的取舍。

7. ★ **cc 订阅长时间无人值守运行的条款灰区**（新增，来自 D2）
   - 问题：条款允许你用自己的订阅登录未经修改的 `claude`，但额度是按“ordinary, individual usage”设定的，并且第三方不得存储或转递订阅凭据。
   - 选项：
     - (a) 接受。token 在 Web UI 录入并加密入库（D5），设每周占用上限；
     - (b) 写手只在你设定的时段运行（duty cycle）；
     - (c) 写手改用 API key 或自建网关（D5 支持）。
   - 推荐默认：(a)，可以再叠加 (b)。
   - 影响：账号风险与吞吐之间的取舍。

8. ★ **目标规模与卷章结构**
   - **已决定（D6）**：规模按书在 UI 配置，写入 `book.yaml` 的 `scale`。下面的推荐值就是默认值。
   - 问题：你提到约 300 万字。
   - 选项：每卷 80–110 章（10–12 卷），或每卷 30–50 章（20–30 卷）。
   - 推荐默认：target 3M、hard_max 3.5M、10–12 卷、每卷 80–110 章。审计窗口和 lag 随弧长自动缩放。
   - 影响：卷越长，卷中审计和摘要的压力越大；卷越短，规划开销越大。规模直接决定需要多少周的订阅窗口。

9. **工艺 gate 的默认值与归属**
   - 问题：哪些属于不可关闭的 I/O 契约，哪些放在题材或书层（结尾标记、【】、meta 词、重复、长度区间、lexicon）。
   - 推荐默认：只有路径、编码、schema、非空、未截断是固定的，其余全部可在书层覆盖（§6.5）。
   - 影响：用户指令与代码规则之间的冲突由谁说了算。

10. **作者层与评审角色的关系**
    - 推荐默认：所有角色都加载 L1–L3；与作者层冲突的评审建议一律丢弃；revision_brief 标注为低优先级。
    - 影响：避免评审绕过作者指令，代价是评审的独立审美会受限。

11. **作者层 TAIL nonce 缺失时的处理**
    - 选项：判失败并重跑；只告警。
    - 推荐默认：writer、reviewer、judge 判失败并重跑，重跑一次仍缺失就标为“不可承载”；其他角色只告警。
    - 影响：可靠性与配额消耗之间的取舍。

12. **修订耗尽策略，以及你处理 Inbox 的频率**
    - 问题：你每周能投入多少时间处理 Inbox？
    - 推荐默认：长度、工艺、soft 问题记债；正典 hard 冲突和 I/O 失败 block；关键章的长度、工艺类 hard 问题 hold，lite 档下关键章只剩 soft 问题时也记债（§6.4）。
    - 影响：如果你很少在线，应该更多地选择记债。

13. **审批门超时与通知渠道**
    - 选项：`wait`、`auto_approve`、`skip`；ntfy、webhook、邮件、Telegram。
    - 推荐默认：compass 和第一卷规划需要审批，超时一律 `wait`；ntfy 推送加签名审批链接；Inbox 适配手机。
    - 影响：你出差期间书是否会停写。

14. **refusal 后的跨厂商重试，以及书级厂商白名单**
    - 选项：不重试；换下一家重试 1 次；按书限定可以发给哪些厂商。
    - 推荐默认：按书设厂商白名单（默认不限制），在白名单内重试 1 次。
    - 影响：吞吐与“内容发给哪些厂商”之间的取舍。

15. **写手模型中途被更新或下架时**
    - 选项：自动继续并做回归检查；暂停 lane 等你确认；自动 bake-off 选出继任者。
    - 推荐默认：静默更新时自动继续，用确定性指标做回归检查并通知你；下架时暂停，生成继任提案，默认是同一厂商的下一代订阅模型（bake-off 是 opt-in），由你确认。
    - 影响：风格连续性与能否继续推进之间的取舍。

16. **minor 伏笔的结尾策略与全书总量上限**
    - 推荐默认：`open_total: 60`；minor 超过 120 章后自动 triage；完结时允许批量 abandon 并写明理由，main 级需要你批准。
    - 影响：完结时的整洁度与规划负担之间的取舍。

17. **人物契约演进由谁审批**
    - 选项：showrunner 自动审批；你审批。
    - 推荐默认：major 角色由你审批，其余由 showrunner 审批。

18. **未计划发明的严格程度**
    - 问题：写手写出卡片未计划的事件或新实体时，管得多严。
    - 推荐默认：次要角色算 soft；地点、势力、体系也算 soft，但必须由 planner 事后追认，否则下一卡 stale。
    - 影响：创作自由度与正典稳定性之间的取舍。

19. **字数口径与单章长度**
    - 选项：只计汉字（`han`），或按平台口径（`platform`，含标点）。
    - 推荐默认：`han`，目标 3000、区间 2600–3800（约等于平台 3400–4300 字），UI 同时显示两种口径。

20. **章节标题、卷名、番外、续作**
    - 推荐默认：planner 给出标题，writer 可以提议修改，由 committer 采纳；暂不支持番外和续作（可作为新书 fork）。

21. **已发布章节的 retcon 政策**
    - 推荐默认：永不自动修改，经人工审批的勘误可以改正文，并标记“已修订”。

22. **根 AGENTS.md 被手改时的处理**
    - 推荐默认：拒收，并提供一键迁移到 `instructions/AGENTS.md`。

23. **派生文件是否入库**
    - 推荐默认：不入库（只带 trailer hash），live 树中保留缓存供 Studio 和 UI 使用。

24. **run 原始流保留**
    - 推荐默认：只保留已验收章节对应的 run，保留 1 年；思考内容 90 天后删除。
    - 影响：磁盘占用、隐私，以及排障能力。

25. **项目是否分发给他人或开源**
    - 影响：D2 的订阅模式只适用于自用。分发给他人时，Novelist 作为第三方，不得代替用户中转订阅凭据（cc 条款）。此外还涉及镜像能否内置 harness（推荐不内置），以及上游 blessed lock 由谁维护。
    - 推荐默认：只供自用；你在本地晋级版本。

26. **对外访问方式**
    - 选项：内置 Caddy、自带反向代理、仅局域网 http。
    - 推荐默认：需要公网访问时用 Caddy，否则用局域网 http 档并显示警示。

27. **v1 迁移的范围与窗口**
    - 推荐默认：全部导入，保留“仅密码”登录，v1 写到一半的章节丢弃，v1 保留 30 天用于回滚，不做双跑。

28. **persona 模式**
    - 推荐默认：append；replace 按题材包开启，需经 canary 验证。

29. **数据库**
    - 推荐默认：只用 Postgres；PGlite 放到 P3 以后。

30. **Studio 合并策略**
    - 推荐默认：三方合并，冲突进 Inbox。

31. **修改 instructions 导致大面积重跑时**
    - 推荐默认：预计超过 20 个 run，或任一订阅周窗口的 5% 时，二次确认。API 账号另加 $5 的门槛。

32. **首发内置哪些题材包，以及参照语料**
    - 推荐默认：内置仙侠和都市两个包；由你按题材提供人类写作样本，没有样本时退回内置 lexicon。

33. **读者反馈是否回流到规划**
    - 推荐默认：暂不回流；预留评分和评论表。

34. **MCP、embedding、推测流水线、自动开书**
    - 推荐默认：全部关闭；MCP 在 P3+ 用 `auto`。

35. **pi 和 Gemini CLI**
    - 推荐默认：pi 放在 P4，并且不能使用 Anthropic 订阅（Consumer Terms 不允许第三方 harness 使用订阅凭据）；它的 ChatGPT 登录条款依据未核实，默认也不用。只能以 API key 例外的方式接入。Gemini CLI 只通过通用 ACP 接入。

36. **读者可见范围与管理端语言**
    - 推荐默认：读者默认可见全部已发布的书，支持按读者设白名单；管理端为中文界面，预留 i18n。

---

## 附录 A：规范 schema 目录

| 文件 | zod 名 / 版本 | 生产者 → 消费者 | 是否入库 |
|---|---|---|---|
| `book.yaml` | `nv.book/1`：format_version、genre、scale、tier、policy、gates.overrides、routing、publish、budgets、vendors_allow；合并语义为“书 > 题材 > 全局 > 内置”，按键深合并，数组整体替换 | owner → 全体 | 是 |
| `gates.yaml`（题材或书） | `nv.gates/1`：rule、level、阈值、allow | 题材包或 owner → validators | 是 |
| `pack.yaml` | `nv.pack/1`：extends、catalogs、rubric 权重、pacing、lexicon、事件词族 | 题材包 → planner、validators | 是（genres 仓库） |
| `lexicon.yaml` | `nv.lexicon/1`：ban、watch、allow、patterns（带权重） | owner → gate | 是 |
| `compass.yaml` | `nv.compass/1` | planner（需审批）→ 全体 | 是 |
| `volumes/vNN.yaml`、`arcs/aNNNN.yaml` | `nv.volume/1`、`nv.arc/1` | planner → planner、validators | 是 |
| `cards/cNNNNN.yaml` | `nv.card/1`（含 `nv.predicate/1`） | planner → ctx、delta.check | 是 |
| `character-arcs/<id>.yaml`、`strands.yaml`、`obligations.yaml` | `nv.charc/1`、`nv.strands/1`、`nv.oblig/1` | planner → audits | 是 |
| 实体 `.md` frontmatter | `nv.entity/1` | planner、owner → 全体 | 是 |
| `rules.yaml` | `nv.world/1`：历法、体系、vocab.conditions | planner、owner → delta.check | 是 |
| `secrets/<id>.md` | `nv.secret/1`：truth、reveal_plan、leak_signatures | planner → delta.check | 是 |
| `ledger/cN.json` | `nv.delta/1` | extractor → fold | 是 |
| `overrides.jsonl`、`debt.jsonl`、`changes.jsonl`、`arc-fingerprints.jsonl` | `nv.override/1`、`nv.debt/1`、`nv.change/1`、`nv.arcfp/1` | 审计、owner、committer → fold、planner | 是 |
| `reviews/cN.json`、`audits/*.json` | `nv.review/1`、`nv.audit/1` | review、audit → UI、planner | 是 |
| `receipt.json`、`pairwise.json`、`patches.json`、`VALIDATED.json` | `nv.receipt/1`、`nv.pairwise/1`、`nv.patches/1`、`nv.validated/1` | agent、validators → 编排器 | 否（work/） |
| `snapshot.json`、views | `nv.snapshot/1` | fold → ctx、UI | 否（派生） |
| `config/routing.yaml`、`accounts.yaml`、`pricing.yaml`、`harness.lock.yaml`、`novelist.yaml` | `nv.routing/1` 等 | owner → 编排器 | 是（config 仓库） |

所有 schema 都导出 JSON Schema 和 golden 样例，这是 P1 的出口条件之一。环境变量清单从 `novelist.yaml` 的 schema 生成。

## 附录 B：任务目录

| TaskKind | 角色 | hard deps | soft deps（变化时 rebase） | 产出 | validators | lane | 重试 |
|---|---|---|---|---|---|---|---|
| `plan.premise/compass/bible/volumes/volume/arc` | planner（+ plan_judge，opt-in） | compass、目标区间的卡片、被引用的实体、owner 编辑过的路径 | ledger、摘要、patterns | yaml 文件 | 规划 validators、弧指纹 | side | 6 |
| `card.repair` | planner | 目标卡、相关实体 | ledger | 卡片 | 投影 pre、谓词 | side | 4 |
| `ctx.build` | 确定性 | 卡、ledger@base | — | 编译后的 pack | 配额、hash | write | — |
| `chapter.write/revise/expand/compress` | writer | 卡、N−1/N−2、ledger@base、指令栈 | — | draft | contract、craft | write | 6 |
| `chapter.extract/reextract` | extractor（standard/key；lite 下由 `chapter.check` 承担） | draft、卡、ledger@base | — | delta | delta.check、召回探针 | write | 4 |
| `chapter.check`（lite 档） | checker | draft、卡、ledger@base | — | delta（含摘要）＋ continuity_flags | delta.check、召回探针、quotes.verify | write | 4 |
| `format.repair`、`chapter.formatcheck`（opt-in） | format_checker | check 原始输出 + schema / draft | — | 修复后的 JSON / span 建议 | zod、op 子集与 ev 逐字校验 / lexicon、allow | write | 2 |
| `chapter.confirm` | extractor（lite 下为 checker，与补抽合并） | draft | — | 引文 | 逐字校验 | write | 2 |
| `chapter.review/pairwise` | reviewer / judge | draft、delta | — | review | quotes.verify | write | 4 |
| `chapter.deslop` | stylist | draft | — | patches | find 唯一命中、lint 下降 | write | 2 |
| `chapter.accept/ingest` | committer | 全部产物 | — | commit | §7.7 | write | — |
| `chapter.repair` | writer + extractor | 目标章、下游 delta | 摘要 | 正文、delta | 级联重放 | side | 4 |
| `summary.arc/volume`、`book.blurb` | summarizer | 区间内章节 | snapshot | 摘要 | 锚点校验 | side | 4 |
| `audit.window/arc/volume/heldout` | 确定性（window 默认）/ auditor/ judge（heldout，opt-in） | 区间内章节 | 摘要 | audit 与发现 | quotes.verify | side | 4 |
| `bakeoff.write/judge` | 候选写手 / judges | 卡片 | — | 草稿、排名 | gates | side | 3 |
| `import.bootstrap` | extractor（无 shell） | v1 章节批次 | — | delta | delta.check | side | 4 |
| `index.rebuild`、`slop.fingerprint`、`media.cover` | 确定性 / 插件 | — | — | 索引等 | — | side | 2 |

## 附录 C：DB DDL 概要

```sql
tasks(...)                                  -- §7.2；idx(book_id,state,priority)、idx(state,not_before)
runs(id uuid pk, task_id, attempt, role, profile_id, account_id, harness, harness_version, isolation,
     driver, session_id, model_reported, state, lease_owner, lease_expires_at, heartbeat_at,
     shim_pid, shim_start, started_at, ended_at, exit_code, outcome jsonb, usage jsonb,
     nonce_report jsonb, denials int, run_dir)          -- idx(state,lease_expires_at)
run_events(run_id, seq, ts, t, body jsonb) PARTITION BY RANGE(ts)   -- 按月分区，保留 30 天
usage_ledger(ts, account_id, profile_id, task_kind, tier, book_id, input, cached, output,
             util_delta jsonb,                -- 各窗口占用率增量（订阅，主口径）
             usd)                             -- 仅 API 账号
quota_reservations(id, account_id, window, book_id, task_id, amount, created_at, settled_at, expires_at)   -- §7.5 准入与预留
accounts_state(account_id pk, auth_mode, risk_ack jsonb, disabled, sleep_until, util jsonb, cred_expires_at)
quota_snapshots(account_id, ts, window, utilization, resets_at)
harness_installs(id, version, sha256, sha256_source, tier, status, node_version)
capabilities(harness, version, isolation, body jsonb, verified_at)
circuit_breakers(harness, version, isolation, state, opened_at, effective_at, reason, samples)
books_index(book_id pk, slug, title, status, cursor, audited_through, published_through, format_version)
chapters_index(book_id, ch, title, cjk, accepted_commit, published_at, volume)   -- 可重建
publish_queue(book_id, ch, not_before)   inbox(id, book_id, kind, body jsonb, state, created_at)
readers(id, label, lookup_id, pw_hash, token_version, allow_books)   sessions(id, reader_id, expires_at)
reading_progress(reader_id, book_id, ch, scroll, updated_at)
pats(id, owner, hash, scopes, revoked_at)   notifications(...)   audit_log(...)
book_events(book_id, ts, kind, body)        -- append-only
```

所有与书相关的表都可以用 `novelist reindex` 从书库 git 重建。
