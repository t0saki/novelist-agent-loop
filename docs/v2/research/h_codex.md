# OpenAI Codex CLI 调研报告（面向 Novelist 2.0 多 harness 编排）

调研日期：2026-11-08。本机装的是 `codex-cli 0.165.0`，`~/.codex` 里的配置已经在用一个自定义 Responses provider。flag 都按本机 `--help` 核对过，又在 scratchpad 里实跑了 4 次 `codex exec`，验证 JSONL 事件、resume、退出码和沙箱行为。官方文档 `developers.openai.com/codex/*` 已经 308 跳转到 `learn.chatgpt.com/docs/*`，下文引用的是跳转后的 URL。源码依据来自 `github.com/openai/codex`（`codex-rs/exec/src/lib.rs`、`exec_events.rs`）。

---

## 1. 基本信息
- **产品名**：OpenAI Codex CLI。厂商是 OpenAI，二进制叫 `codex`。
- **许可**：开源，Apache-2.0。仓库是 https://github.com/openai/codex，约 13.3 万 star，主体用 Rust 写（`codex-rs/`）。
- **安装**：`npm i -g @openai/codex`（另有 brew 和 GitHub release 二进制）。自更新用 `codex update`，诊断用 `codex doctor`。
- **版本**：最新稳定版是 **0.167.0**，2026-11-06 发布。预发布已经到 0.169.0-alpha.3（2026-11-07）。发版很频繁，几乎每天都有 alpha（https://github.com/openai/codex/releases）。
- **相关包**：TS SDK `@openai/codex-sdk` 0.167.0，Python SDK `openai-codex`（`pip install openai-codex`）。
- **当前模型**：`gpt-6-astra`、`gpt-6.1-sol`（默认上下文 500k）、`gpt-6.1-terra`（需要 ≥0.159.0）、`gpt-6-luna`。gpt-5.5 已于 2026-10-14 在 ChatGPT 登录下退役（https://learn.chatgpt.com/docs/models）。

## 2. 无头模式
- **基本命令**：`codex exec [OPTIONS] [PROMPT]`，别名 `codex e`。
- **prompt 来源**：PROMPT 写 `-` 或省略时从 stdin 读。如果 stdin 是管道又同时给了 PROMPT，stdin 内容会作为 `<stdin>` 块追加进去。
- **输出流向**：默认只有最终消息写到 stdout，进度走 stderr。
  - `--json`：stdout 变成 JSONL 事件流。
  - `-o/--output-last-message <FILE>`：把最终消息另写一份到文件。
  - `--output-schema <FILE>`：强制最终回复符合给定的 JSON Schema。
  - `--ephemeral`：不落盘 rollout。
  - `--color never`：关掉颜色。
  - 文档：https://learn.chatgpt.com/docs/non-interactive-mode
- **事件类型**（源码 `exec_events.rs`）：
  - 顶层事件：`thread.started{thread_id}`、`turn.started`、`turn.completed{usage}`、`turn.failed{error{message}}`、`item.started|item.updated|item.completed{item}`、`error{message}`。
  - `item.type` 取值：`agent_message`、`reasoning`、`command_execution`（含 command、aggregated_output、exit_code，status 为 in_progress/completed/failed/declined）、`file_change`（含 changes[{path, kind:add|delete|update}]，status 为 in_progress/completed/failed）、`mcp_tool_call`、`collab_tool_call`（子代理操作 spawn_agent/send_input/wait/close_agent）、`web_search`、`todo_list`、`error`。
- **实测 usage**：`{"input_tokens":24217,"cached_input_tokens":20992,"cache_write_input_tokens":0,"output_tokens":71,"reasoning_output_tokens":0}`。输出里只有 token 数，**不给费用**，费用要自己按价目表算。
  - resume 之后 `input_tokens` 计的是这一 turn 发送的全部上下文：第二轮实测 46927，包含了历史。
- **退出码**（源码确认）：
  - 出现以下情况退出 1：本 turn 收到 `error` 通知且 `will_retry=false`；`turn.completed` 的 status 是 Failed 或 Interrupted；exec 拒绝了 server request（审批、request_user_input 等）；配置加载失败；resume 的 id 不存在（实测报 `thread/resume failed: no rollout found ... (code -32600)`）；`required=true` 的 MCP 初始化失败。
  - 其余情况退出 0。
  - **注意**：退出码 0 不代表任务完成。实测沙箱在这台机器上写文件失败，`file_change` 两次 `status:"failed"`，模型回复 "Couldn't create out.md"，进程仍然退出 0。issue #46246 也报告了同样问题（https://github.com/openai/codex/issues/46246）。

## 3. 会话管理
- **存储位置**：rollout 存在 `$CODEX_HOME/sessions/`，另有 `session_index.jsonl` 和若干 sqlite 文件（state、thread_history）。
- **resume**：`codex exec resume <SESSION_ID|thread name> [PROMPT]`，或者用 `--last`（默认只看当前 cwd 下的会话，加 `--all` 取消过滤）。实测 resume 后 `thread_id` 不变，上下文延续。resume 子命令同样支持 `--json`、`-o`、`--output-schema`、`-m` 和 bypass flag。
- **fork**：`codex exec fork <SESSION_ID> [PROMPT]`。app-server 的 `thread/fork` 还支持 `lastTurnId` 和 `ephemeral`。
- **其他会话命令**：`codex queue --thread <id> --message`（往已有会话排队消息），以及 `codex archive|delete|unarchive`。
- **上下文压缩**：自动 compaction，阈值配置项是 `model_auto_compact_token_limit`，上下文窗口配置项是 `model_context_window`。可以用 `compact_prompt` / `experimental_compact_prompt_file` 自定义压缩提示词。app-server 侧有 `thread/compact/start` 和 `thread/compacted` 通知，hooks 有 `PreCompact`/`PostCompact`。
  - **坑**：OpenAI 端用的是 remote compaction（会产生 `compaction` item）。第三方 Responses provider 在 resume 或切换时可能报 `item type "compaction" is not supported`（#45393、#48085、#38930，均未关闭）。
- **上下文上限**：gpt-6.1-sol 默认 500k token。

## 4. 指令文件
官方文档：https://learn.chatgpt.com/docs/agent-configuration/agents-md

- **全局层**：`$CODEX_HOME/AGENTS.override.md` 优先于 `$CODEX_HOME/AGENTS.md`，只取第一个非空文件。
- **项目层**：从项目根（一般是 git root，可用 `project_root_markers` 改）逐级走到 cwd。每个目录按 `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`（例如 `["CLAUDE.md","GEMINI.md"]`，需要显式配置）的顺序最多取 1 个。从根到 cwd 依次拼接，越靠近 cwd 越靠后，后面的覆盖前面的。整条链每次运行只构建一次。
- **大小限制**：`project_doc_max_bytes` 默认 32 KiB，超过后就不再追加文件。
- **不支持的东西**：不支持 `@import`，也没有关闭开关（只会跳过空文件）。**不会自动读 CLAUDE.md**，除非把它加进 fallback 列表。
- **替换系统提示**：`model_instructions_file = "<path>"` 会替换 Codex 内置的 base instructions（旧名 `experimental_instructions_file`）。`developer_instructions = "..."` 会额外注入 developer 消息。两者都能用 `-c` 在单次调用里覆盖。app-server 的 `thread/start` 参数里有 `baseInstructions` 和 `developerInstructions`（已用 `generate-json-schema` 确认）。
- **隔离办法**：`--ignore-user-config` 跳过 `$CODEX_HOME/config.toml`，但 auth 仍然从 `CODEX_HOME` 读。也可以给每个项目单独设一个 `CODEX_HOME`，彻底隔离全局 AGENTS.md、skills 和 sessions。

## 5. 扩展能力
- **子代理**（默认开启，配置项 `agents.enabled`）：https://learn.chatgpt.com/docs/agent-configuration/subagents
  - 自定义代理放在 `~/.codex/agents/*.toml` 或 `.codex/agents/*.toml`，每个文件一个代理。必填 `name`、`description`、`developer_instructions`，可选 `model`、`model_reasoning_effort`、`model_reasoning_summary`、`model_verbosity`。
  - 内置代理有 `default`、`worker`、`explorer`。
  - `[agents]` 下的配置：`max_concurrent_threads_per_session`（旧名 `max_threads`）、`default_subagent_model`、`default_subagent_reasoning_effort`。
  - 子代理继承父会话的 sandbox 和审批设置。非交互模式下，需要新审批的动作会直接失败。
  - 触发方式是在 prompt 或 AGENTS.md 里要求，在 JSONL 里表现为 `collab_tool_call` item。
- **Skills**：遵循 agentskills.io 开放标准（https://learn.chatgpt.com/docs/build-skills）。
  - `SKILL.md` frontmatter 需要 `name` 和 `description`，目录里可以放 `scripts/`、`references/`、`assets/`。
  - 搜索位置：`$CWD/.agents/skills`（向上到 repo root）、`~/.agents/skills`、`/etc/codex/skills`，以及系统内置的 skill。
  - 采用渐进加载，初始清单占约 2% 上下文，`skills.max_context_tokens` 最大 10000。
  - 调用方式：显式用 `$skill-name`，或者按 description 隐式匹配。`agents/openai.yaml` 里的 `policy.allow_implicit_invocation` 控制是否允许隐式匹配。`[[skills.config]]` 可以按 name 或 path 禁用。
- **Custom prompts**：`~/.codex/prompts/*.md`，调用写 `/prompts:name`，参数用 `$1..$9`、`$ARGUMENTS`。**已弃用**，官方推荐改用 skills（https://learn.chatgpt.com/docs/custom-prompts）。
- **Hooks**：默认开启，`features.hooks` 控制（https://learn.chatgpt.com/docs/hooks）。
  - 事件：`SessionStart`、`SessionEnd`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreModelRequest`、`PostModelRequest`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`、`Interrupt`。
  - 配置写在 `~/.codex/hooks.json`、`<repo>/.codex/hooks.json` 或 config.toml 的 `[hooks]` 里。
  - hook 从 stdin 收到 JSON，字段有 `session_id`、`transcript_path`、`cwd`、`hook_event_name`、`turn_id` 等。
  - `Stop` hook 返回 `{"decision":"block","reason":"..."}` 时，reason 会作为续写 prompt 让 agent 继续干活；hook 退出码为 2 时 reason 取 stderr。可以拿它在 harness 内部校验"章节文件是否真的写出来了"。
  - 默认超时 600 秒。非托管 hook 要先经 `/hooks` 信任（按文件 hash 绑定）；无人值守时用 `--dangerously-bypass-hook-trust`。
  - **未验证**：hook 在 `codex exec` 下是否触发，文档没有写明，需要实测。
- **MCP 客户端**：用 `codex mcp add|list|get|remove|login` 管理，配置在 `[mcp_servers.<id>]`。
  - stdio 方式用 `command`/`args`/`env`，Streamable HTTP 方式用 `url`/`bearer_token_env_var`。
  - 其他键：`startup_timeout_sec`（默认 10）、`tool_timeout_sec`（默认 60）、`required`、`enabled`。exec 模式下 MCP elicitation 会被自动 cancel。
- **MCP server 模式**：旧版的 `codex mcp-server` 在 0.165 里已经不是子命令了，仓库里也没有对应的 crate。替代方案是 app-server。
- **插件**：`codex plugin add|list|remove|marketplace`，插件可以打包 skills、MCP 和 hooks。
- **Goals**：`/goal`（features.goals 现为 stable）提供长时间自主循环，有 get_goal/create_goal/update_goal 三个工具。这部分来自二手博客（https://codex.danielvaughan.com/2026/07/23/codex-cli-goal-mode-long-horizon-autonomous-workflows-ralph-loop-token-budgets/），据说 compaction 后有丢目标的问题，不建议编排器依赖。

## 6. 权限与沙箱
- **exec 默认值**：沙箱是 **read-only**，审批策略被强制为 `never`（源码里 `approval_policy: Some(AskForApproval::Never)`）。凡是需要审批的请求，exec 一律拒绝，并且退出码变成 1。
- **`-s/--sandbox` 取值**：
  - `read-only`
  - `workspace-write`：可写 cwd 和 `--add-dir`；额外可写路径用 `sandbox_workspace_write.writable_roots`；网络默认关，用 `sandbox_workspace_write.network_access=true` 打开。
  - `danger-full-access`
- **全无人值守**：`--dangerously-bypass-approvals-and-sandbox`，等价于 danger-full-access 加 never，官方要求外层自己做隔离。
- **其他审批选项**：`--approve-for-me` 把审批交给 auto-review 代理，配合 workspace-write 使用。`approvals_reviewer="auto_review"` 是对应的配置项。
- **已移除**：`--full-auto` 已经删除，0.165 实测报 `unexpected argument`。
- **新版权限 profile**：`default_permissions = "<name>"` 配合 `[permissions.<name>]`，可以 `extends` 内置的 `:read-only`、`:workspace`、`:danger-full-access`。
  - 文件规则写在 `filesystem` 下，取值 read/write/deny，支持 glob deny。
  - 网络规则写在 `network.enabled` 和 `network.domains`，要真正生效还得开 `features.network_proxy=true`。
  - 新旧两套不能混用：只要出现 `sandbox_mode` 或 `--sandbox`，就会回退到旧机制（https://learn.chatgpt.com/docs/permissions）。
- **Linux 沙箱实现**：基于 bubblewrap，优先用 PATH 里的 `bwrap`，找不到就退回内置 helper（需要非特权 user namespace）。
  - 在容器、gVisor 或加固过的环境里经常失败（#29908、#51555、#52260、#46246）。本机实测 workspace-write 写文件失败，但退出码是 0。
  - 结论：在 Docker 容器里跑时，用 bypass 加容器自身的隔离。
- **其他限制**：`--skip-git-repo-check` 允许在非 git 目录运行；`--ignore-rules` 忽略 execpolicy 的 `.rules`。

## 7. 模型与 provider
- **选模型**：`-m <model>`，或 `-c model="..."`，或 config 里写 `model`。
- **推理强度**：`-c model_reasoning_effort="low|medium|high|xhigh|max|ultra"`（可用档位取决于模型），另有 `model_reasoning_summary` 和 `model_verbosity`。
- **profile**：`-p/--profile <name>` 会在基础配置上叠加 `$CODEX_HOME/<name>.config.toml`（新的 V2 文件式 profile）。
- **第三方 provider**：在 `[model_providers.<id>]` 下配置，然后用 `model_provider="<id>"` 选择。
  - 可用键：`name`、`base_url`、`env_key`、`wire_api`、`query_params`、`http_headers`、`env_http_headers`、`request_max_retries`（默认 4）、`stream_max_retries`（默认 5）、`stream_idle_timeout_ms`（默认 300000）、`requires_openai_auth`。
  - **重要限制**：`wire_api` 现在只支持 `"responses"`，Chat Completions 已移除；config 里如果还留着 `wire_api="chat"`，加载配置就会失败（#41816）。所以第三方端点必须兼容 OpenAI **Responses API**，只支持 /chat/completions 的服务（很多国产兼容端点）得在前面加一层转换代理。
- **本地模型**：`--oss --local-provider lmstudio|ollama`。另有 Vertex/Bedrock 的接入向导。
- 配置参考：https://learn.chatgpt.com/docs/config-file/config-reference

## 8. 程序化接口
- **TS SDK `@openai/codex-sdk`**：内部是 spawn `codex exec --json` 并解析 JSONL。
  - 主要 API：`new Codex({env, config, configOverrides, baseUrl})`、`startThread({workingDirectory, skipGitRepoCheck, ...})`、`thread.run()`（返回 finalResponse 和 items）、`runStreamed()`（async generator）、`resumeThread(id)`、按 turn 传 `outputSchema`。
  - README：https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- **Python SDK `openai-codex`**：通过 JSON-RPC 驱动本地 app-server。
  - 提供同步的 `Codex` 和异步的 `AsyncCodex`；主要方法有 `thread_start(model=, sandbox=Sandbox.workspace_write)`、`thread_resume`、`thread_fork`（可传 `include_turns=False`）。
  - 发布包自带锁定版本的 CLI，也可以用 `CodexConfig(codex_bin=...)` 指定自己的 CLI。
  - 文档：https://learn.chatgpt.com/docs/codex-sdk
- **`codex app-server`**（标注 experimental）：JSON-RPC 2.0，线上不带 `jsonrpc` 字段。
  - 传输：stdio JSONL（默认）、`unix://`、`ws://`（不受支持）。
  - 握手：先发 `initialize` 请求，再发 `initialized` 通知。
  - 主要方法：`thread/start`（参数有 cwd、model、modelProvider、sandbox、approvalPolicy、baseInstructions、developerInstructions、config、ephemeral、serviceTier）、`thread/resume`、`thread/fork`、`turn/start`（参数有 threadId、input、effort、outputSchema、sandboxPolicy、model）、`turn/steer`、`turn/interrupt`、`thread/compact/start`、`model/list`、`config/*`、`account/rateLimits/read`。
  - 主要通知：`turn/started|completed`（status 为 completed/failed/interrupted）、`item/started|completed`、`item/agentMessage/delta`、`thread/tokenUsage/updated`（字段 total、last、modelContextWindow）、`account/rateLimits/updated`（字段 usedPercent、windowDurationMins、resetsAt）、`thread/compacted`、`error{willRetry, codexErrorInfo}`。`codexErrorInfo` 的取值有 contextWindowExceeded、usageLimitExceeded、unauthorized、sandboxError、httpConnectionFailed 等。
  - 服务端会反向发审批请求 `item/commandExecution/requestApproval` 和 `item/fileChange/requestApproval`，客户端回 `accept|acceptForSession|decline|cancel`。
  - 生成 schema：`codex app-server generate-json-schema --out DIR` 或 `generate-ts --out DIR`，产物按版本锁定。
  - 文档：https://learn.chatgpt.com/docs/app-server
- **架构备注**：0.16x 的 exec 内部本身就是一个 in-process app-server 客户端，所以 exec 的 JSONL 和 app-server 的语义一致。
- **ACP**：不是官方原生支持，只有社区适配器。本次没有深入核实。

## 9. 内容与指令定制
- `model_instructions_file` 可以**整个替换**内置系统提示。这是实现"agent 只写文件、不在 stdout 输出正文"这类定制规则最干净的入口，也适合放题材专用的 AGENTS 规则。
- `developer_instructions` 追加 developer 层指令；AGENTS.md 层层叠加；skills 和自定义代理的 `developer_instructions` 也能注入。
- 用户可以完全接管自己能控制的那部分指令。OpenAI 服务端的模型策略不可配置；app-server 有 `turn/moderationMetadata` 和 `model/safetyBuffering/updated` 通知。
- 第三方 provider 只走用户自己的端点，不受 OpenAI 服务端策略约束。

## 10. 认证、限额与长跑坑点
- **认证方式**（https://learn.chatgpt.com/docs/auth）：
  - ChatGPT 订阅登录 `codex login`，token 会自动刷新；无头环境用 `codex login --device-auth`（beta）。
  - API key：`codex login --with-api-key`，或者单次运行时设 `CODEX_API_KEY=...`。
  - Enterprise 访问令牌：`--with-access-token`。
  - 凭据存储由 `cli_auth_credentials_store` 决定，取值 file/keyring/auto/ephemeral；`auth.json` 等同于密码，要妥善保管。
- **订阅限额**（https://learn.chatgpt.com/docs/pricing）：
  - Plus 和 Business 是 5 小时窗口，可能还有周上限。Plus 用 gpt-6.1-sol 时约每 5 小时 15–160 条消息，gpt-6-luna 约 350–3000 条。
  - Pro 目前没有 5 小时上限。
  - 超限时当前 turn 可以跑完，之后可以买 credits 或改用 API key。
  - API key 按标准 API 价格计费。
- **长跑坑点**：
  1. stdin 是非 TTY 管道且没人写入时，exec 会一直挂住（#20919）。实测 stderr 出现 `Reading additional input from stdin...`。**必须 `</dev/null`**，或者 `stdin=DEVNULL`。
  2. 退出码 0 可能是假成功，例如沙箱失败或者模型自称完成（#46246）。必须在编排器这边校验产物文件。
  3. 文件式 fs sandbox helper 没有超时，可能永久挂住（#53537）；外层一定要加 wall-clock timeout。
  4. 需要审批的动作在 exec 里直接失败，exit 1。
  5. 第三方 provider 的 compaction 不兼容。
  6. 必须在 git 仓库里运行，否则要加 `--skip-git-repo-check`。
  7. 版本迭代快，flag 会变，比如 `--full-auto` 被删、`[profiles]` 换成文件式。要锁版本，并在启动时跑 `--strict-config`。
  8. `memories` 功能默认关，保持关闭，避免跨项目串味。
  9. 共享 `CODEX_HOME` 时并发会话写 sqlite；NFS/CephFS 上可能出问题（#59367）。

## 11. 其他要点
- `--output-schema` 很适合让 agent 交一张结构化的"交付回执"，例如 `{chapter_file, word_count, summary_file, status}`，正文仍然写进文件。
- 实测 `file_change` 和 `command_execution` item 带绝对路径。编排器可以据此做一份写入审计：agent 是否只改了允许的文件。
- 自定义代理（`.codex/agents/*.toml`）和 skills（`.agents/skills/`）都能放在项目目录里随项目分发。`.agents/skills` 是跨 harness 的开放标准目录，cc、agy 等也在向它靠拢，可以作为多 harness 共享 skill 的公共目录。
- 本次测试在 `~/.codex/sessions` 留下了 2 个测试会话，带 `--ephemeral` 的那次除外。测试目录是 `<scratch>/cx`。

---

## 适配器要点

**命令模板（容器内无人值守）：**
```
CODEX_HOME=<per-project-home> codex exec --json --skip-git-repo-check \
  -C <novel_workspace> --dangerously-bypass-approvals-and-sandbox \
  -m <model> -c model_reasoning_effort="<effort>" \
  -c model_instructions_file="<abs path>" -c developer_instructions="<task contract>" \
  --output-schema <receipt.schema.json> -o <run_dir>/last.json \
  "<prompt>" </dev/null
```
- 宿主机上的安全版本：把 bypass 换成 `-s workspace-write --add-dir <dir>`，前提是 bwrap 可用。
- 续写：`codex exec resume <thread_id> --json ... "<prompt>" </dev/null`。
- 分支实验：`codex exec fork <thread_id> ...`。

**事件解析：**
- 逐行 JSON 解析，取第一条 `thread.started.thread_id` 并持久化，作为 resume 的 key。
- 汇总所有 `turn.completed.usage`，费用自己按价目表算。
- 成功条件同时满足三点：最后是 `turn.completed`、退出码为 0、产物文件存在且校验通过。
- `turn.failed`、`error`、退出码 1、超时都算失败。
- `file_change` 的 status 为 failed 时，按"沙箱或写入失败"告警。

**指令注入：**
- 给每个项目或题材生成一份 `AGENTS.md`，放在 workspace 根，子目录可以再放，比如 `chapters/AGENTS.md`。
- 如果希望多个 harness 共用 `CLAUDE.md`，就在 per-project 的 `CODEX_HOME/config.toml` 里设 `project_doc_fallback_filenames=["CLAUDE.md"]`，并把 `project_doc_max_bytes` 调到 65536 或以上。
- 需要彻底控制时，用 `model_instructions_file` 替换内置提示词。
- 每次任务的约束（比如"只写到 `chapters/0123.md`，stdout 只返回 JSON 回执"）放进 `developer_instructions` 或 prompt。

**隔离：**
- 给每个项目单独设 `CODEX_HOME`，里面放 `config.toml`，`auth.json` 用符号链接或复制。这样 sessions、skills、全局 AGENTS 都不会串。
- 关掉 memories，必要时加 `--ignore-user-config`。

**健壮性：**
- 外层加硬超时并在超时后 kill 进程组；按 `usageLimitExceeded` 或 429 做退避。
- 优先在 rollout 里查到 thread_id 后再 resume；遇到 "no rollout found" 就开新线程，并从文件重建上下文。
- 长篇的记忆不要依赖 Codex 的 compaction，应当放在文件里：bible、大纲、摘要。每章开一个新 thread（或者每卷 fork 一次）最稳，对第三方 provider 也规避了 compaction 兼容问题。

**深度集成：**
- 需要流式进度、中途 steer/interrupt、读取限额或强类型协议时，改用 `codex app-server --listen stdio://` 或 Python SDK `openai-codex`。用 `generate-json-schema` 锁定协议版本，审批请求自动回 `accept`。
- TS SDK 只是 exec 的一层包装，和自己写一个 exec 适配器能力差不多。

**版本：**
- 锁定 `@openai/codex@0.167.x`，启动时跑 `codex --version` 和 `--strict-config` 做探测。
- flag 兼容层要能应对 `--full-auto` 已删除、profile 改成文件式（V2）、`wire_api` 只剩 `responses` 这些变化。

**来源：**
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Skills](https://learn.chatgpt.com/docs/build-skills)
- [Custom prompts](https://learn.chatgpt.com/docs/custom-prompts)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [App server](https://learn.chatgpt.com/docs/app-server)
- [Auth](https://learn.chatgpt.com/docs/auth)
- [Pricing](https://learn.chatgpt.com/docs/pricing)
- [Models](https://learn.chatgpt.com/docs/models)
- [Sandboxing](https://learn.chatgpt.com/docs/sandboxing)
- [Permissions](https://learn.chatgpt.com/docs/permissions)
- [GitHub releases](https://github.com/openai/codex/releases)
- [TS SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- Issues：[#20919](https://github.com/openai/codex/issues/20919)、[#46246](https://github.com/openai/codex/issues/46246)、[#53537](https://github.com/openai/codex/issues/53537)、[#45393](https://github.com/openai/codex/issues/45393)、[#41816](https://github.com/openai/codex/issues/41816)
- Goal mode 二手资料：[Daniel Vaughan 博客](https://codex.danielvaughan.com/2026/07/23/codex-cli-goal-mode-long-horizon-autonomous-workflows-ralph-loop-token-budgets/)
