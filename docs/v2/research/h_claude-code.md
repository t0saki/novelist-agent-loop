
# Claude Code ("cc") as a writing engine for Novelist 2.0: harness research report

I checked this against the local install, `claude` **2.1.319**, published to npm on 2026-11-06, and against code.claude.com docs fetched on 2026-11-08. I also ran one real headless test (`claude -p`, Haiku 5.5, stream-json, Write tool) to capture the actual event shapes. Wherever this report says "observed", it means that run, not the docs.

---

## 1. Identity

- **Product:** Claude Code, by Anthropic. The binary is `claude`.
- **Install options:**
  - Native installer: `curl -fsSL https://claude.ai/install.sh | bash`. It installs to `~/.local/bin/claude`, which points into `~/.local/share/claude/versions/`, and auto-updates.
  - Homebrew: `brew install --cask claude-code` (stable) or `claude-code@latest`.
  - WinGet: `Anthropic.ClaudeCode`.
  - Signed apt/dnf/apk repos.
  - npm: `npm i -g @anthropic-ai/claude-code`. This ships the same native binary through per-platform optional deps; Node 22+ is needed only for the install.
  - Pinning: `claude install <ver|stable|latest>`. Release channels are set with `autoUpdatesChannel` (`latest` default, or `stable`, about one week behind). Turn off auto-update with `DISABLE_AUTOUPDATER=1`, or block all updates with `DISABLE_UPDATES`. https://code.claude.com/docs/en/setup
- **License:** proprietary. The npm license field reads "SEE LICENSE IN README.md" and use falls under Anthropic Commercial Terms. The source is not open. github.com/anthropics/claude-code holds issues, the CHANGELOG and plugins.
- **SDKs:**
  - TypeScript: `@anthropic-ai/claude-agent-sdk` **0.3.319**, version-locked to the CLI.
  - Python: `claude-agent-sdk` **0.2.179**, MIT, Python 3.10 or later.
  - Both bundle the native binary. https://code.claude.com/docs/en/agent-sdk/overview
- **Plans:** Claude Code needs a paid plan (Pro, Max, Ultra, Team or Enterprise), a Console account, or Bedrock / Google Agent Platform / Foundry. The free plan doesn't include it.

## 2. Headless mode

- **How to run it:** `claude -p "<prompt>"` (`--print`). Stdin is read too and capped at **10 MB**; larger input exits non-zero. `-p` skips the workspace-trust dialog, and settings files that fail validation are **silently ignored** in this mode. https://code.claude.com/docs/en/headless
- **Output formats** (`--output-format`):
  - `text`.
  - `json`: one object with `result`, `session_id`, `usage`, `total_cost_usd`, `modelUsage` and so on.
  - `stream-json`: NDJSON. It needs `--verbose`; add `--include-partial-messages` for `stream_event` token deltas.
- **Other output options:**
  - `--json-schema '<schema>'` returns the result in `structured_output`. That field is missing if the run fails, so check for it before reading.
  - Bidirectional streaming: `--input-format stream-json` keeps one process alive and accepts multi-turn input. `--replay-user-messages` echoes user messages back.
  - `--include-hook-events` and `--forward-subagent-text` add hook events and subagent text/thinking to the stream; subagent messages are tagged with `parent_tool_use_id`.
- **Observed event sequence in 2.1.319:**
  1. `system/hook_started` and `system/hook_response` (from user-level hooks that leaked into the run; see §10)
  2. `system/init`, carrying `session_id`, `cwd`, `model`, `permissionMode`, `tools[]`, `mcp_servers[]`, `plugins`, `agents`, `skills`, `apiKeySource`, `claude_code_version`, `capabilities[]` (for feature detection) and `memory_paths`
  3. `system/thinking_tokens`
  4. `assistant` messages (content at `.message.content[]`; text, tool_use and thinking blocks)
  5. `rate_limit_event`
  6. `user` (tool_result, plus `tool_use_result`)
  7. `result`
- **Documented events not seen in this run:** `system/api_retry` (`attempt`, `max_retries`, `retry_delay_ms`, `error_status`, and `error` ∈ authentication_failed | rate_limit | overloaded | billing_error | model_not_found | server_error | max_output_tokens | …), `system/compact_boundary`, `system/permission_denied`, `system/informational` and `system/plugin_install`.
- **The `result` event:**
  - `subtype` is one of `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution` or `error_max_structured_output_retries`.
  - Other fields: `is_error`, `result` (on success only), `stop_reason` (`end_turn` | `max_tokens` | `refusal` | null), `terminal_reason` (observed: `completed`), `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage` (input, output, cache_read and cache_creation tokens; main loop only) and `modelUsage{model:{inputTokens, outputTokens, cacheRead…, costUSD, contextWindow, maxOutputTokens}}` (whole tree, subagents included).
  - It also carries `permission_denials[]`, `subagent_stats`, `api_error_status` and, observed, `credential_expires_at`.
  - Trailing events such as `prompt_suggestion` can arrive after `result`, so read until EOF. https://code.claude.com/docs/en/agent-sdk/agent-loop
- **Observed `rate_limit_event`:** `{"rate_limit_info":{"status":"allowed","resetsAt":…,"rateLimitType":"seven_day","unifiedWindows":{"seven_day":{"utilization":0.06}}}}`. A scheduler can use this to throttle.
- **Exit codes:**
  - `0` on success.
  - Non-zero on a failed run, including error result subtypes. A failure inside the run (for example, auth) is still printed as the result on stdout.
  - An invalid flag prints to stderr before the run starts.
  - SIGTERM gives `143` and leaves the in-flight turn unrecorded; send SIGINT to end the turn cleanly.
  - `1` when a resume fails or the session is running in the background.
- **Costs:** `total_cost_usd` is a client-side estimate. On `--resume`/`--continue` it is cumulative across runs. `--max-budget-usd N` caps spend (it can overshoot by about one response), and `--max-turns N` caps turns (print mode only; no limit by default).

## 3. Sessions

- **Transcripts:** stored at `~/.claude/projects/<cwd with non-alphanumerics → ->/<session-id>.jsonl`. The format is internal and not stable. They are kept for **30 days** by default (`cleanupPeriodDays`). `CLAUDE_CONFIG_DIR` relocates them, and `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+, only together with `CLAUDE_CONFIG_DIR`) sets the project folder name. `--no-session-persistence` disables persistence. https://code.claude.com/docs/en/sessions
- **Resume, continue, fork:**
  - `--session-id <uuid>` pre-assigns the ID, which is ideal for an orchestrator.
  - `-r/--resume <id|name|/abs/path.jsonl>` resumes, and works from any directory.
  - `-c/--continue` picks up the most recent session in the cwd. `-p`/SDK sessions are skipped by an interactive `--continue` but included by `-p --continue`.
  - `--fork-session` (with `--resume`) branches a session under a new ID.
  - Two processes resuming the same session without forking will interleave its transcript.
- **What a resume restores:** history, model and agent. It does **not** restore `--mcp-config`, `--settings`, `--plugin-dir`, `--add-dir` or `--fallback-model`, so pass them again. `-p --resume` starts in the default `-p` permission mode, not the mode the session had.
- **System prompt snapshot (important):** the system prompt, including any `--append-system-prompt`, is recorded on the first request and reused on resume **until compaction**, even if a later launch passes different text. `--system-prompt-snapshot off` disables this. https://code.claude.com/docs/en/cli-reference#system-prompt-flags
- **Compaction:**
  - Auto-compact runs near the context limit. Adjust it with `--autocompact <auto|100k–1M>`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or the subagent field `autoCompactWindow`. `/compact [focus]` works in `-p` as a prompt.
  - Stream events: `compact_boundary`. Hooks: `PreCompact` and `PostCompact`.
  - Survives compaction: the system prompt and output style, the project-root CLAUDE.md and unscoped rules (re-injected from disk), auto memory, up to five recently touched files (each 5k tokens or less) and invoked skill bodies (5k tokens per skill, 25k total).
  - Lost: anything that was only in early messages, plus path-scoped rules and nested CLAUDE.md files until they reload on demand. https://code.claude.com/docs/en/context-window
- **Context window:** 1M natively on Fable 5/5.1, Sonnet 5+, Haiku 5.5 and Opus 4.7+. Opus 4.6 and Sonnet 4.6 need the `[1m]` suffix. Observed: `contextWindow: 1000000` and `maxOutputTokens: 128000` for claude-haiku-5-5. https://code.claude.com/docs/en/model-config

## 4. Instruction files

https://code.claude.com/docs/en/memory

- **What loads:** `CLAUDE.md` in the cwd and every ancestor directory, plus `.claude/CLAUDE.md` and `CLAUDE.local.md` alongside each. All of them are concatenated, root first, so files closer to the cwd come last. There is also a user file `~/.claude/CLAUDE.md`, a managed file at `/etc/claude-code/CLAUDE.md` (Linux), and `.claude/rules/**/*.md`. Rules with `paths:` frontmatter load only when Claude touches a matching file. Subdirectory CLAUDE.md files load lazily when Claude reads or edits a file there.
- **AGENTS.md is native from v2.1.277**, through the built-in plugin `cc-plugin-agents-md@builtin`:
  - The default `claude-md-or-agents-md` reads AGENTS.md (and `.claude/AGENTS.md`, in the cwd and above) **only if no CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md exists in the cwd or above**. A user-level `~/.claude/CLAUDE.md` doesn't block it.
  - Other values: `claude-md-and-agents-md`, `claude-md` and `managed-only`. They are set in `pluginConfigs` in `~/.claude/settings.json` or a `--settings` file; project and local settings files are ignored for this key.
  - Caveats: `InstructionsLoaded` hooks don't fire for an AGENTS.md read this way, and an `--add-dir` directory doesn't load its AGENTS.md.
  - Most robust option, which works on any version: put a `CLAUDE.md` containing `@AGENTS.md` next to it. It is never read twice.
- **Imports:** `@path/to/file`, relative to the importing file or absolute, nested up to **4 hops**. Imports from outside the project need approval in interactive mode.
- **Size limits:** a launch-time CLAUDE.md is loaded in full if it is 4 MiB or smaller and skipped entirely above that. Path-scoped and subdirectory files have a smaller per-file cap. The recommendation is under 200 lines. Auto memory `MEMORY.md` loads its first 200 lines or 25 KB.
- **Other controls:**
  - HTML block comments are stripped before injection.
  - `claudeMdExcludes` (glob list) skips files.
  - `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` makes `--add-dir` load that directory's CLAUDE.md and rules.
  - `--bare` turns off all CLAUDE.md auto-discovery.
  - `omitClaudeMd: true` in a subagent definition skips CLAUDE.md for that subagent.

## 5. Extensibility

- **Subagents** (https://code.claude.com/docs/en/sub-agents):
  - Defined in `.claude/agents/*.md`, `~/.claude/agents/`, a plugin's `agents/`, or `--agents '<json>'` (a file path is also accepted with `-p`, v2.1.281+).
  - Frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `isolation: worktree`, `effort` and `omitClaudeMd`.
  - The tool that spawns them is `Agent` (the old name `Task` still works as an alias).
  - Each subagent starts with a fresh context and its own system prompt (not Claude Code's) plus CLAUDE.md, and returns only a summary.
  - Nesting goes 3 levels deep by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), with at most 20 running at once (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).
  - Subagents start in the background by default. Use `--append-subagent-system-prompt[-file]` (`-p` only) to add text to every subagent's prompt. `--agent <name>` runs the main session as that agent.
- **Skills** (https://code.claude.com/docs/en/skills): `.claude/skills/<name>/SKILL.md` or `~/.claude/skills/`, following the Agent Skills standard (agentskills.io). Custom commands in `.claude/commands/*.md` are merged into skills. Supported:
  - Frontmatter: `description`, `allowed-tools`, `disable-model-invocation`, `user-invocable`, `context: fork`, `agent`, `model`, `effort`, `paths` and `arguments`.
  - Substitutions: `$ARGUMENTS`, `$N`, and `` !`cmd` `` for shell output injected before the prompt.
  - In `-p` you invoke one with `/skill-name args` in the prompt.
- **Hooks** (https://code.claude.com/docs/en/hooks):
  - Events: SessionStart/End, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, PermissionRequest/Denied, Stop, StopFailure, SubagentStart/Stop, PreCompact/PostCompact, InstructionsLoaded, FileChanged, Notification, among others.
  - Handler types: `command`, `http`, `mcp_tool`, `prompt` and `agent`.
  - Exit code `2` blocks. On `Stop`, exit 2 or `{"decision":"block","reason":…}` forces Claude to continue, which gives a completion gate such as "chapter file must exist and be ≥N chars". `PreToolUse` can return `permissionDecision` allow/deny or `updatedInput`.
  - Default timeout is 600 s. Hooks are configured in settings.json under `hooks`, in plugin `hooks/hooks.json`, or in skill/agent frontmatter.
  - Hooks do **not** run under `--bare`.
- **MCP client:** stdio, HTTP, SSE and WebSocket transports, via `claude mcp add`, `.mcp.json`, or `--mcp-config <file|json>` plus `--strict-mcp-config`. With `-p`, the run waits up to `MCP_TIMEOUT` (30 s) for servers to connect, and invalid entries are reported in `mcp_server_errors` in `init`. `claude mcp serve` exposes Claude Code's tools as an MCP server, but not its agent loop.
- **Plugins:** a directory with `.claude-plugin/plugin.json` plus `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json` and `output-styles/`. Load one per session with `--plugin-dir <dir|zip>` or `--plugin-url`, or install from a marketplace (`/plugin marketplace add`, `claude plugin install`). https://code.claude.com/docs/en/plugins
- **Output styles:** `.claude/output-styles/*.md` or `~/.claude/output-styles/`, selected with the `outputStyle` setting or `/output-style <name>` (works in `-p` from v2.1.269). A custom style drops the built-in software-engineering section unless it sets `keep-coding-instructions: true`. https://code.claude.com/docs/en/output-styles

## 6. Permissions and sandbox

https://code.claude.com/docs/en/permission-modes

- **Modes** (`--permission-mode`):
  - `default`/`manual`: reads only.
  - `acceptEdits`: file edits plus mkdir, touch, mv, cp and similar inside the working directories.
  - `plan`.
  - `auto`: a classifier reviews actions.
  - `dontAsk`: pre-approved tools only; everything else is denied.
  - `bypassPermissions`: everything. `--dangerously-skip-permissions` is the same thing.
- **Since v2.1.302, `-p` starts in Manual**, so anything that would need approval is **denied** unless an allow rule or hook approves it. `--permission-prompts none` (v2.1.259+) denies without waiting for a host, removes `AskUserQuestion`, and lists the denials in `permission_denials`.
- **Rules:** `--allowedTools "Read,Write,Edit,Bash(python3 tools/*)"` and `--disallowedTools "WebFetch,WebSearch,mcp__*"`. `--tools` restricts the built-in tool set itself.
- **Confining writes:** setting `permissions.blockWritesOutsideWorkingDirectories` (v2.1.314+) makes Write, Edit and NotebookEdit refuse paths outside the working directories in every mode. It doesn't cover shell commands. `blockReadsOutsideWorkingDirectories` does the same for reads. Working directories are the cwd plus `--add-dir`. `--restricted` (v2.1.248+) removes Bash and other code-running tools plus WebFetch, confines file tools, ignores user and project settings, and refuses bypass.
- **Protected paths:** `.git`, `.claude`, `.vscode`, shell rc files, `.mcp.json` and similar are never auto-approved, except in bypass mode. **Agents must not write their outputs under `.claude/`.**
- **Bypass mode:** refused when running as root or under sudo unless inside a recognized sandbox. I couldn't confirm the detection mechanism; older reports mention `IS_SANDBOX=1`, but treat that as unverified. Use a non-root container user. Managed settings can block bypass with `disableBypassPermissionsMode`.
- **Bash sandbox** (https://code.claude.com/docs/en/sandboxing): `sandbox.enabled`. It uses bubblewrap + socat on Linux and Seatbelt on macOS, based on `@anthropic-ai/sandbox-runtime`.
  - Keys: `filesystem.allowWrite/denyWrite/denyRead/allowRead`, `network.allowedDomains/deniedDomains`, `autoAllowBashIfSandboxed` (true by default), `allowUnsandboxedCommands:false` and `failIfUnavailable:true`.
  - It wraps only Bash, PowerShell and Monitor. The file tools and WebFetch are governed by permission rules instead.

## 7. Models and providers

- **Selecting a model:** `--model <alias|id>`, `ANTHROPIC_MODEL`, the `model` setting, or `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`.
- **Aliases today:** `fable` → Fable 5.1, `opus` → Opus 5.5, `sonnet` → Sonnet 5.5, `haiku` → Haiku 5.5, plus `best` and `opusplan`. Pin full IDs, for example `claude-opus-5-5`.
- **Fallback:** `--fallback-model a,b` switches models when the primary is overloaded.
- **Subagent model:** `CLAUDE_CODE_SUBAGENT_MODEL`.
- **Effort:** `--effort low|medium|high|xhigh|max`, `CLAUDE_CODE_EFFORT_LEVEL`, or the settings `effortLevel`/`modelSettings`. The default is `medium` on the 5.5 models. Thinking can't be turned off on 5.5 or Fable models. https://code.claude.com/docs/en/model-config
- **Endpoints:**
  - `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` (bearer) or `ANTHROPIC_API_KEY`, and `ANTHROPIC_CUSTOM_HEADERS`.
  - The gateway must speak **Anthropic Messages**, Bedrock or Vertex format. There is no native OpenAI chat-completions support, and Anthropic doesn't support routing to non-Claude models.
  - Third-party Anthropic-compatible endpoints are common practice but unsupported, and I didn't verify any here.
  - Bedrock, Vertex and Foundry are enabled with `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY`.
  - If you only set `BASE_URL` with no credential, the subscription login is still what gets used. https://code.claude.com/docs/en/llm-gateway

## 8. Programmatic control

- **Agent SDK, TypeScript:** `query({prompt, options})` returns an async generator of SDKMessages. The control methods include `interrupt()`, `streamInput()`, `setPermissionMode()`, `setModel()`, `getContextUsage()`, `rewindFiles()`, `mcpServerStatus()` and others.
- **Agent SDK, Python:** `query()` and `ClaudeSDKClient`.
- **Options:** `systemPrompt` (string, or `{type:'preset',preset:'claude_code',append}`; the default is a *minimal* prompt), `settingSources` (`[]` disables user/project/local), `permissionMode`, `allowDangerouslySkipPermissions`, `canUseTool`, in-process `hooks`, `agents`, `mcpServers` (including in-process SDK MCP tools), `resume`, `forkSession`, `maxTurns`, `maxBudgetUsd`, `cwd`, `additionalDirectories`, `env` (which *replaces* the environment), `sandbox`, `plugins`, and `outputFormat:{type:'json_schema'}`. A `sessionStore` adapter mirrors transcripts to your own backend.
- **Session helpers:** `listSessions()` and `getSessionMessages()`. https://code.claude.com/docs/en/agent-sdk/typescript
- **Other languages:** the documented route is a subprocess running `-p --output-format stream-json`, with `--input-format stream-json` for a long-lived process.
- **ACP:** `@agentclientprotocol/claude-agent-acp` v0.101.0, Apache-2.0, published 2026-11-06. It wraps the Agent SDK and serves ACP v1 by default, with draft v2 on request (session new/list/resume/fork/cancel, permission requests, MCP). https://github.com/agentclientprotocol/claude-agent-acp
- **Not available:** an app-server or JSON-RPC mode built into the CLI itself.

## 9. System prompt customization (mechanism only)

- **`--system-prompt` / `--system-prompt-file`** replace the entire default prompt. That drops the coding identity, the tool guidance, the default safety text and the git snapshot.
- **`--append-system-prompt` / `--append-system-prompt-file`** keep the default prompt and add to it. You can combine them with a replacement; file contents come before inline text.
- **Prompt caching:** a line containing only `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` splits a custom prompt into a cached static part and a dynamic part (v2.1.275+).
- **Middle ground:** custom output styles replace the software-engineering section and keep the rest.
- **Layering:** CLAUDE.md, AGENTS.md, rules and skills stack on top as context. Subagents get their own prompt from the agent file, which is fully user-definable.
- **Not configurable:** server-side model policy is outside the harness.
- **Implication:** each user's custom instructions (AGENTS.md plus a role prompt file) can fully define the writer persona. No coding-assistant framing is required.

## 10. Auth, rate limits and pitfalls for long unattended runs

- **Auth precedence:**
  1. Cloud-provider environment variables
  2. `ANTHROPIC_AUTH_TOKEN`
  3. `ANTHROPIC_API_KEY` (always used in `-p`)
  4. `apiKeyHelper`
  5. `CLAUDE_CODE_OAUTH_TOKEN` (a **1-year** subscription token from `claude setup-token`)
  6. Profiles
  7. `/login` OAuth (on Linux, `~/.claude/.credentials.json`)
  
  `--bare` reads only the API key or `apiKeyHelper`; it never uses OAuth or `CLAUDE_CODE_OAUTH_TOKEN`. Use `CLAUDE_CONFIG_DIR` to isolate accounts. https://code.claude.com/docs/en/authentication
- **Login expiry:** when the login expires, every request fails with `Login expired · Please run /login`. Check `credential_expires_at` in `result` (observed).
- **Subscription limits:** a rolling 5-hour window plus a weekly cap. `-p` and the SDK draw from the same plan limits. A planned separate credit for programmatic use was reported as paused in mid-2026; these sources are third-party, so check `/usage` (for example https://alexcloudstar.com/blog/claude-code-usage-limits-2026/, https://redreamality.com/blog/claude-code-usage-limits-cost-2026/). Detect limits through `rate_limit_event` and `api_retry` with `error: rate_limit`, and then sleep until `resetsAt`.
- **Policy note:** Anthropic says it doesn't allow third-party developers to offer claude.ai login or rate limits in their products unless previously approved. A self-hosted tool that drives the user's own CLI under their own login is the user's call; a distributed product should use API keys.
- **Pitfalls:**
  - **Config leakage:** a plain `-p` run loads user hooks, plugins and claude.ai connector MCP tools. In my test, the user's OpenViking hooks ran and its MCP tools appeared. Isolate with `--bare` (API key only), or with `CLAUDE_CONFIG_DIR=<clean>` plus `--setting-sources project --strict-mcp-config`.
  - **Silent denials:** in Manual mode the writes are denied without an error. Always set a mode or allow rules, and check `permission_denials`.
  - **Write tool:** it refuses to overwrite an existing file the session hasn't Read (documented under tools-reference "Edit tool behavior"). The prompt must say "Read then Write/Edit". It also refuses to write through a symlink.
  - **Background waits:** a `-p` run waits for background subagents and commands to finish, with a 10-minute idle cap (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). Wrap every run in a wall-clock timeout and send SIGINT before SIGTERM.
  - **Resuming a running session:** `-p --resume` on a session that is still running in the background exits 1.
  - **Concurrent resumes:** running the same session in parallel corrupts the history; fork it instead.
  - **Auto-updates** mid-campaign can change behaviour. Pin the version and set `DISABLE_AUTOUPDATER=1`.
  - **Transcript retention:** after 30 days, sessions you can resume are deleted.
  - **Snapshot:** a role prompt doesn't change on resume (see §3).
  - **Settings errors:** invalid settings are silently ignored in `-p`; check with `claude doctor`.
  - **MCP startup:** servers can delay the first turn by up to 30 s.

## 11. Other notes for a multi-harness orchestrator

- `system/init.capabilities[]` lets you detect features instead of parsing version strings.
- `modelUsage` gives per-model cost and token accounting, including subagents.
- `--json-schema` is useful for machine-readable step outputs, such as continuity-check verdicts, alongside file outputs.
- Subagent definitions can be passed per run with `--agents <file>`, so the orchestrator can define writer, critic and continuity roles for cc in one place.
- Stop hooks are a native "done" gate. A PostToolUse hook on Write can trigger the orchestrator's validators over HTTP (`type:"http"`).
- `-w/--worktree` and `isolation: worktree` work only with git.
- Built-in task tools and the background `claude agents` / `--bg` exist, but an orchestrator should own scheduling rather than use them.

---

## Adapter implications

**Recommended command template** (one stateless invocation per task, for example "write chapter 137"):

```
env CLAUDE_CONFIG_DIR=$NOVELIST_HOME/cc-profile  DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_OAUTH_TOKEN=…  (or ANTHROPIC_API_KEY=… and add --bare) \
claude -p \
  --output-format stream-json --verbose \
  --session-id $UUID            # new run; use --resume $UUID [--fork-session] to continue
  --model claude-opus-5-5 --effort high --fallback-model sonnet \
  --permission-mode acceptEdits --permission-prompts none \
  --allowedTools "Read Write Edit Glob Grep" --disallowedTools "WebFetch WebSearch Bash" \
  --setting-sources project --strict-mcp-config [--mcp-config novelist-mcp.json] \
  --settings '{"permissions":{"blockWritesOutsideWorkingDirectories":true},"cleanupPeriodDays":365}' \
  --append-system-prompt-file $RUN_DIR/role.md      # or --system-prompt-file for a full persona
  --max-turns 60 --max-budget-usd 4 \
  --add-dir $PROJECT/bible  (read-only intent; enforce with a deny rule Edit(//abs/bible/**) if needed) \
  < $RUN_DIR/task.md
```

- **cwd:** the per-novel workspace.
- **Bash:** enable it only with the sandbox on, or inside a container under a non-root user.
- **Bypass mode:** use it only in a non-root container.

**Event parsing:**
- Read NDJSON line by line. Take `init` for the session ID, model and MCP/plugin errors.
- Stream `assistant` tool_use blocks to the UI (Write/Edit `file_path`).
- On `api_retry` and `rate_limit_event`, apply backoff or pause the scheduler.
- On `compact_boundary`, log it.
- `result` is terminal: check `subtype`, `is_error`, `stop_reason` (refusal), `permission_denials`, `total_cost_usd` and `modelUsage`. Keep reading to EOF, then take the exit code.
- **Success is judged by validators, not by stdout:** the expected files exist, are non-empty and meet length and frontmatter requirements. Text output is only a log.

**Resume strategy:**
- Prefer **stateless per-task runs**, where context is rebuilt from files: bible, outline, rolling summaries and the previous chapter's tail. That is robust to compaction, the 30-day cleanup and crashes.
- Use `--resume` only for short repair loops, such as "fix the validator errors", and always with a pre-assigned `--session-id`.
- Never resume the same session from two processes at once; fork instead.
- A role change needs a new session, or `--system-prompt-snapshot off`.

**Instruction-file injection:**
- Keep the harness-neutral, user-editable `AGENTS.md` at the workspace root (per project or genre template).
- For cc, also generate a `CLAUDE.md` that contains `@AGENTS.md`, plus cc-only notes such as "always Read before overwriting; write outputs only to `chapters/`, `notes/`; never write under `.claude/`". This works on any version and with any AGENTS.md setting.
- Put per-role and per-step instructions in `--append-system-prompt-file`: stable text goes above `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` so it caches.
- Generate role subagents with `--agents <json-file>`.
- Under `--bare`, nothing is auto-discovered. Pass AGENTS.md content through `--append-system-prompt-file` or tell the agent to Read it.

**Gotchas checklist:**
- Isolate the config dir.
- Set the permission mode explicitly (`-p` defaults to Manual and denies writes).
- Tell agents to Read before overwriting.
- Keep outputs out of protected paths.
- Use a non-root user.
- Wrap every run in a wall-clock timeout with SIGINT first.
- Pin the version.
- Handle the 5-hour/weekly limits through `rate_limit_event`.
- Watch `credential_expires_at` and alert before expiry.
- Raise `cleanupPeriodDays` if you rely on resume.
- Keep stdin under 10 MB: pass big context as files and reference the paths.

Test artifacts from the live run: <scratch>/cctest/stream.jsonl
