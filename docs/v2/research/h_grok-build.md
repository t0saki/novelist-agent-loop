
# Grok Build (xAI): harness research report for a Novelist 2.0 adapter

**Research date:** 2026-11-08. **Version tested:** `grok 1.0.77 (50ca579fa996)`, the npm `latest`. The `alpha` tag is 1.0.78, published 2026-11-06.

**How it was checked:** I read the official docs at docs.x.ai/build. I also installed the binary into the scratchpad with an isolated `GROK_HOME`/`HOME` and ran `--help`, `inspect --json`, and unauthenticated `-p` runs. The binary ships a 28-file, roughly 866 KB user guide, which it unpacks to `$GROK_HOME/docs/user-guide/` on first launch. It is far more detailed than the website and is kept locally at `<scratch>/grokhome/docs/user-guide/`.

**Confidence tags:**
- **[V]** verified on the 1.0.77 binary.
- **[D]** official docs only.
- **[3P]** third-party sources only, so low confidence.

Information is not thin. This is a mature, heavily documented CLI.

---

## 1. Identity

**Product**
- **Name and vendor:** "Grok Build" by xAI. The docs now brand the company "SpaceXAI"/"SpaceXSI". **[D]**
- **Description:** a coding agent with a TUI, a headless mode, and an ACP mode. **[D]**
- **Binary:** `grok`. **[V]**
- **Help banner:** "Grok Build TUI". **[V]**

**Install** **[D]**
- `curl -fsSL https://x.ai/cli/install.sh | bash`
- Windows: `irm https://x.ai/cli/install.ps1 | iex`
- npm: `npm install -g @xai-official/grok`. This is a wrapper plus per-platform packages such as `@xai-official/grok-linux-arm64`. Each holds a brotli-compressed Rust binary (`grok.br`, about 52 MB compressed) that `postinstall.js` unpacks. **[V]**

**Versions and timeline**
- First npm publish: 0.1.0 on 2025-10-22. **[V]**
- 1.0.0 published 2026-08-07. **[V]**
- 1.0.77 published 2026-11-05. **[V]**
- Releases land almost daily. Update channels are `stable`, `alpha` and `enterprise` (`[cli] channel`). **[D]**
- Public early beta opened 2026-05-14 for SuperGrok Heavy, and widened roughly 10 days later. **[3P]**

**License**
- The npm metadata says `Apache-2.0` for the 1.0.x packages; early alphas said `Proprietary`. **[V]**
- No public source repository is listed (`repository: null`). Treat it as a closed-source binary that is free to redistribute through npm. **[V]**

**Implementation**
- Written in Rust, using rustls (no OpenSSL). **[D]**
- Two internal execution backends appear throughout the docs: the "shell route" (the in-process agent) and the "daemon route" (a background service or "leader" at `~/.grok/leader.sock`). Some behavior differs between them. **[D]**

**Docs**
- Website: https://docs.x.ai/build/overview, with an index at https://docs.x.ai/llms.txt.
- Append `.md` to any page URL to get raw markdown. A plain WebFetch returned 404, but `curl` with a browser user-agent returns 200.

## 2. Non-interactive / headless mode

**Prompt input**
- `grok -p "<prompt>"` (long form `--single`). **[V]**
- `--prompt-file <PATH>` and `--prompt-json <JSON content blocks>` also trigger headless mode. **[V]**
- Piped stdin is NOT read into the prompt. **[D]**
- `--verbatim` sends the prompt exactly as given. **[V]**

**Key flags** **[V]**
- `--cwd`, `-m`, `--reasoning-effort`/`--effort`, `--max-turns <N>` (headless only)
- `--tools`, `--disallowed-tools`, `--allow`, `--deny`
- `--permission-mode`, `--always-approve`/`--yolo`, `--sandbox`
- `--rules`, `--system-prompt-override`
- `--agent`, `--agents <JSON>`
- `--no-plan`, `--no-subagents`, `--disable-web-search`
- `--json-schema <SCHEMA>`: constrained structured output; implies `json`.
- `--add-dir`, `-w/--worktree`
- `--trust` (hidden in `--help`, but accepted and documented) **[V]**
- `--no-auto-update` **[D]**
- `--no-wait-for-background` and `--background-wait-timeout <secs>` **[D]**

**Output formats** (`--output-format`) **[V]**

- `plain` (the default)
- `json`: one object at the end. **[D]**
  - Fields: `text`, `stopReason`, `sessionId`, `requestId`, `cwd`, `thought?`, `num_turns`.
  - `usage{input_tokens(uncached), cache_read_input_tokens, cache_creation_input_tokens, output_tokens, reasoning_tokens, total_tokens}`
  - `modelUsage{<model>:{inputTokens, outputTokens, cacheReadInputTokens, modelCalls, costUSD}}`
  - `total_cost_usd` and `total_cost_usd_ticks` (1 USD = 10^10 ticks).
  - Flags `cost_is_partial` and `usage_is_incomplete`. Cost is present only when complete, and is usually stamped only for API-key traffic; OAuth or subscription runs often omit it.
- `streaming-json`: NDJSON derived from ACP updates. Switch on `type`. **[D]**
  - Types: `text`, `thought`, `tool_call` (`toolCallId`, `toolName`, `kind`, `status`, `rawInput`, `locations`), `tool_call_update`, `usage` (one per model response), `plan`, `available_commands`.
  - The run ends with `end` (session id, cwd and spend) or `error`.
  - Non-exhaustive: `max_turns_reached` and `auto_compact_*` events can also appear.
  - `end.stopReason` is one of `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
  - Do not add the `usage` lines to `end`; `end` is already the total.
- `streaming-messages-json`: Claude-Code-compatible `stream-json`. **[V]** **[D]**
  - Lines: `system/init`, then `assistant` and `user` (tool_result), then `result`.
  - `result` subtypes: `success`, `error_max_turns`, `error_during_execution`, `error_max_structured_output_retries`.
  - `--include-partial-messages` adds `stream_event` deltas.
  - An all-zero `usage` here means "unknown", not "free".
  - Practically, an adapter written for Claude Code's stream-json parses this with little change.

**Errors and exit codes**
- On error, the output is `{"type":"error","message":"..."}` and the exit code is non-zero. **[V]**
- Unauthenticated example: exit 1, `"Not signed in. To authenticate without a browser, run: grok login --device-code ..."`. It returns immediately and does not hang. **[V]**
- Exit codes: `0` success, `1` error (auth, network, runtime, a failed background workflow, or background-wait timeout), `130` SIGINT, `143` SIGTERM. **[D]**

**Completion detection:** wait for the `end`/`error` line (or the `result` line), then the process exit. **[D]**

**Background work**
- After the turn, the process waits up to 10 minutes for background shells or subagents it started. **[D]**
- On timeout it exits 1. **[D]**

**Token usage after the fact:** `grok usage <session-id> [turn]` gives persisted per-session and per-turn token and cost totals. `grok usage --json` gives the plan's usage limit. **[V]** **[D]**

## 3. Session management

**Storage and resume**
- Every run, headless included, is persisted to `~/.grok/sessions/<url-encoded-cwd>/<session-id>/`. **[D]**
  - `updates.jsonl` holds the ACP events; `chat_history.jsonl` the raw messages; `system_prompt.txt` the rendered system prompt (useful for debugging injection).
  - Also: `summary.json`, `plan.json`, `signals.json`, `compaction_checkpoints/`, `subagents/`.
- `-r/--resume [<ID|title>]` resumes; with no argument it takes the most recent for the cwd. Titles match case-insensitively, so prefer UUIDs. **[V]**
- `-c/--continue` continues the most recent session for the cwd. **[V]**
- `-s/--session-id <UUID>` creates a NEW session with a caller-chosen UUID. It errors if the UUID exists, and it does not resume. **[V]** **[D]**
- `--fork-session` (with `-r`/`-c`) branches into a new ID. **[V]**
- Choose the ID up front with `-s` when you need to resume a failed run, because the error object may not include `sessionId`. **[D]**

**Compaction** **[D]**
- Auto-compaction triggers at `[session] auto_compact_threshold_percent` (default 85).
- The threshold is also settable per model (`model.<id>.auto_compact_threshold_percent`), driven by `model.<id>.context_window`.
- Manual `/compact [instructions]` exists in the TUI.
- Over ACP: `x.ai/compact_conversation`.
- Hooks: `PreCompact` and `PostCompact`.

**Context windows** (docs.x.ai models page) **[D]**
- `grok-4.7`, `grok-4.6`, `grok-4.5`: 500k
- `grok-4.3`, `grok-4.20-*`: 1M
- `grok-build-0.1`: 256k
- Prompts of 200k tokens or more are billed at double rate.

**Other** **[D]**
- Rewind restores files.
- `grok export <id>` exports Markdown.
- `grok import` imports Claude Code sessions.

## 4. Instruction files

**Filenames read in each directory**
- `Agents.md`, `Claude.md`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENT.md`, `AGENTS.md`. All matches load. **[D]**
- Plus every `*.md` in `.grok/rules/`, `.claude/rules/` and `.cursor/rules/`, and `.claude/CLAUDE.md` at each level. **[D]**
- **Verified load order** in a test dir: `CLAUDE.md`, `AGENTS.md`, `.grok/rules/*.md`. **[V]**
- No `GEMINI.md`. Custom names such as `AGENTS.local.md` are ignored outside the rules directories. **[D]**

**Hierarchy, in load order** **[D]**
1. Home rules: `$GROK_HOME/rules/*.md`, then `~/.claude/` (CLAUDE.md and rules) and `~/.cursor/`, then each `[paths] extra_rule_dirs` entry. `extra_rule_dirs` loads regardless of trust or gitignore.
2. Repo rules: every directory from the git root down to the cwd. Outside a git repo, only the cwd.

Later (deeper) files win on conflicts. Nested files outside the initial set are discovered lazily when the agent touches those directories. The project root is found by walking up to the nearest `.git`.

**Gating rules**
- **Folder trust is required for project instructions at startup.** In an untrusted folder, `inspect` showed `Project Instructions (None)`. **[V]**
  - Grant trust with `--trust`. It persists to `$GROK_HOME/trusted_folders.toml` (`[folders."<path>"] trusted=true`). **[V]**
  - Or disable gating with `GROK_FOLDER_TRUST=0`; `inspect` then listed CLAUDE.md, AGENTS.md and `.grok/rules/style.md` with sizes and token counts. **[V]**
  - The same trust gate also covers project hooks, MCP, LSP, skills and workflows. **[D]**
- Files ignored by `.gitignore` are skipped. **[D]**
- Symlinked project rule files load only if their target is inside the repo. **[D]**

**Size and imports**
- No size cap; files are loaded in full. **[D]**
- No `@import` syntax for instruction files. `@path` is only a prompt-time file attachment in the TUI. **[D]** (I searched the full guide.)

**Overrides** **[V]** **[D]**
- `--rules <TEXT>` (alias `--append-system-prompt`) appends to the system prompt, wrapped in `<human_rules>`.
- `--system-prompt-override <TEXT>` (alias `--system-prompt`) replaces it verbatim. When both are given, `--rules` is appended after the override.
- Over ACP: `session/new` `_meta.rules` and `_meta.systemPromptOverride`.

**Verification:** `grok inspect --json` returns `projectInstructions[]` with `{path, scope, fileType, sizeBytes, approxTokens}`. Top-level keys: `agents`, `configSources`, `externalCompat`, `hooks`, `mcpServers`, `permissions`, `plugins`, `projectInstructions`, `projectTrusted`, `skills`, and others. **[V]**

## 5. Extensibility

**Subagents**
- Built-in types: `general-purpose`, `explore`, `plan`. **[V]**
- Custom agents are `.md` files with YAML frontmatter (name, description, tools, model, mcpServers, hooks, …) in `.grok/agents/` or `~/.grok/agents/`. Claude agents are also read. **[D]**
- `--agents <JSON>` defines subagents inline; `--agent <name|path>` sets the primary agent. **[V]**
- Config: `[subagents] enabled/toggle/models` (per-subagent model routing), personas, and `max_depth`. **[D]**
- Disable with `--no-subagents`, `GROK_SUBAGENTS=0`, or `--disallowed-tools "Agent(explore)"`. **[V]** **[D]**
- Third parties report "up to 8 parallel". **[3P]**

**Skills**
- `SKILL.md` with YAML frontmatter: `name`, `description`, `when-to-use`, `paths`, `allowed-tools` (informational only), `argument-hint`, `user-invocable`, `disable-model-invocation`, `metadata`. **[D]**
- Discovered from `./.grok/skills/` (walked up to the repo root), `~/.grok/skills/`, `~/.agents/skills/`, Claude and Cursor skill directories, plugins, and `[skills] paths`. User-invocable skills become `/name` slash commands, which can also be invoked headless (`grok -p '/name args'`). **[D]**
- Commands are also read from `~/.agents/commands/`. **[D]**

**Hooks** (Claude-Code-compatible JSON) **[D]**
- Locations: `~/.grok/hooks/*.json` and `.grok/hooks/*.json` (needs trust). Claude's `.claude/settings.json` and Cursor's `hooks.json` are also read.
- Events: `SessionStart`/`SessionEnd`, `UserPromptSubmit` (can block), `PreToolUse` (can deny or rewrite via `updatedInput`), `PostToolUse` (can replace output or add context), `PostToolUseFailure`, `PermissionDenied`, `Stop`/`SubagentStop` (can block the stop to keep the agent working, as in Claude), `StopCancelled`, `StopFailure`, `Notification`, `SubagentStart`, `Pre/PostCompact`.
- Handler types: `command` or `http`. Default timeout 5 s. Hooks are fail-open unless `failClosed: true`. Exit code 2 means deny.
- Stdin carries both camelCase and Claude snake_case keys.

**MCP client**
- Transports: stdio and HTTP/SSE (with OAuth).
- Commands: `grok mcp add|list|remove|doctor`.
- Config: `[mcp_servers.<name>]` in user config or project `.grok/config.toml`. It also reads `~/.claude.json`, `.mcp.json` and `.cursor/mcp.json`.
- Tools are named `<server>__<tool>`.
- Timeouts: `startup_timeout_sec` (default 30) and `tool_timeout_sec` (default 6000).
- **[D]**

**Other features** **[D]**
- Plugins and marketplaces (Claude-Code plugin compatible): `grok plugin ...` and `--plugin-dir`.
- LSP: `.grok/lsp.json`.
- Workflows: `.grok/workflows/*.js` on the daemon route, legacy `.rhai`. Run with `/workflow <name>`.
- `/loop` and `/goal`.
- Cross-session memory is off by default (`GROK_MEMORY`).

## 6. Permissions and sandbox

**Permission modes** (`--permission-mode`) **[V]**
- `default`, `acceptEdits`, `auto` (classifier), `dontAsk` (deny anything not allowlisted), `bypassPermissions`, `plan`.
- `--always-approve` = `--yolo` = `bypassPermissions` = `--dangerously-skip-permissions`. Deny rules and PreToolUse hooks still apply. **[D]**
- Over ACP: `_meta.yoloMode: true`.

**Rules** **[D]**
- Per invocation: `--allow` / `--deny` with patterns `Bash(git *)`, `Edit(chapters/**)`, `Write(...)`, `Read(...)`, `Grep(...)`, `WebFetch(domain:host)`, `MCPTool(server__*)`. Precedence is deny > ask > allow.
- Allow rules are not a closed allowlist; use `dontAsk` for deny-by-default.
- Config: `[permission] allow/deny/ask/rules` in user or project config.
- Bash allow rules are conjunctive across `&&` segments.

**Sandbox** (`--sandbox` / `GROK_SANDBOX`; Landlock on Linux, Seatbelt on macOS) **[D]**

| Profile | Read | Write | Child network |
| --- | --- | --- | --- |
| `off` (default) | anywhere | anywhere | allowed |
| `workspace` | anywhere | cwd + `~/.grok` + temp | allowed |
| `read-only` | anywhere | `~/.grok` + temp | blocked |
| `strict` | cwd + system paths | cwd + `~/.grok` + temp | blocked |
| `devbox` | anywhere | top-level dirs except `/data` | allowed |

- Custom profiles go in `.grok/sandbox.toml` or `~/.grok/sandbox.toml`: `extends`, `restrict_network`, `read_only`, `read_write`, `deny` globs. Kernel-level read-deny on Linux needs bubblewrap.
- Child-network blocking is Linux-only.
- In-process model and web tool traffic is never blocked.
- `strict` cannot create worktrees.

**Two headless gotchas**
- Without always-approve, a tool call that needs approval is refused, stderr prints `permission required: ...`, and the **exit code stays 0**. A silent no-op write is possible. **[D]**
- Tool kill switches: `GROK_WEB_FETCH=0` (the default), `--disable-web-search`, `GROK_WRITE_FILE=0`. Built-in tool IDs: `read_file`, `grep`, `list_dir`, `write`, `search_replace`, `run_terminal_cmd`, `task`, `web_search`, `web_fetch`. **[D]**

## 7. Model and provider config

**Selecting a model**
- `-m/--model <id>`, `GROK_DEFAULT_MODEL`, or `[models] default` in `~/.grok/config.toml`. **[V]** **[D]**
- `grok models` lists the catalog. **[V]**
- The recommended default is `grok-build` (the agent and model alias). The API catalog lists `grok-build-0.1` ($1/$2 per Mtok, 256k context), `grok-4.7` (latest frontier, 500k), `grok-4.6`, `grok-4.5`, `grok-4.3` (1M) and `grok-4.20-*`. **[D]**
- `grok-code-fast-1` was retired 2026-05-15 and now redirects to `grok-4.3`. Source: https://docs.x.ai/developers/migration/may-15-retirement.md. **[D]**

**Reasoning effort** **[D]**
- `--reasoning-effort`/`--effort` with levels `none|minimal|low|medium|high|xhigh|max`. Models accept only the levels they advertise.
- `[models] default_reasoning_effort` sets a default.
- Over ACP: `session/set_config_option` with `configId: reasoning_effort`.

**Bring your own key** (`[model.<id>]` in user config only) **[D]**
- Keys: `model`, `base_url`, `env_key`/`api_key`, `api_backend = chat_completions|responses|messages`, `context_window`, `max_completion_tokens`, `temperature`, `top_p`, `extra_headers`, `query_params`, `stream_tool_calls`, `supports_reasoning_effort`, `max_retries`, `inference_idle_timeout_secs`.
- So any OpenAI-compatible or Anthropic Messages endpoint works.
- Global alternatives: `GROK_MODELS_BASE_URL` and `GROK_XAI_API_BASE_URL`.
- Project `.grok/config.toml` cannot define models; it can only carry `[mcp_servers]`, `[plugins]` and `[permission]`.

## 8. Programmatic SDK / protocol

**ACP, the primary programmatic path** **[D]** **[V]**
- Run `grok agent [--always-approve] [-m M] stdio`: JSON-RPC 2.0 over stdio, NDJSON.
- Flow: `initialize` (protocolVersion 1) → `authenticate` (methodId `xai.api_key` or `cached_token`, `_meta.headless:true`) → `session/new {cwd, mcpServers, _meta:{yoloMode, rules, systemPromptOverride, agentProfile}}` → `session/prompt`.
- Streaming arrives as `session/update` notifications: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`.
- `session/load` resumes a session.
- Usage arrives in `_meta.usage`.
- Extension methods: `x.ai/session/fork`, `x.ai/compact_conversation`, `x.ai/rewind/*`, `x.ai/fs/*`, `x.ai/git/*`, `x.ai/terminal/*`.
- Other transports: `grok agent serve --bind 127.0.0.1:2419 --secret <tok>` (WebSocket) and `grok agent headless --grok-ws-url` (relay).

**Client libraries** **[D]**
- Use generic ACP SDKs: `@agentclientprotocol/sdk` (TypeScript), `agent-client-protocol` (Rust), `agent-client-protocol-python`, `acp-go-sdk`.

**No grok-specific SDK found**
- The guide mentions a "grok-agent-sdk" in passing, but I found no such package on npm (`@xai-official/grok-agent-sdk`: 404) and only a placeholder on PyPI. Treat it as internal or unreleased. **[V]**

**Not supported**
- No MCP-server mode, meaning Grok exposing itself as an MCP server. **[D]** (None is documented.)

## 9. Content and instruction configurability (mechanism only)

**System prompt** **[V]** **[D]**
- Fully replaceable: `--system-prompt-override` (or `--system-prompt`), or ACP `_meta.systemPromptOverride`.
- Appendable: `--rules` / `--append-system-prompt`.
- The rendered prompt is saved to `sessions/.../system_prompt.txt` for audit.

**Agent definitions** **[D]**
- `--agent <path.md>`, `GROK_AGENT=<abs path>` or `[agent] definition=` replace the whole primary agent: prompt body, tools, model and skills.
- Personas add per-subagent overlays.

**User-controlled rule files** **[D]**
- AGENTS.md and CLAUDE.md at the project level.
- `extra_rule_dirs` pulls rules from any absolute directory, with no trust gating.
- No size cap.

**Residual layers you cannot strip**
- The model provider's own server-side behavior still applies. Inference goes through `cli-chat-proxy.grok.com` on OAuth, or `api.x.ai` on an API key. **[D]**

## 10. Auth, rate limits and long-run pitfalls

**Authentication** **[D]**
- Methods: browser OAuth (`grok login`), device code (`grok login --device-auth`/`--device-code`), external `auth_provider_command`, enterprise OIDC, and the API key (`XAI_API_KEY`).
- Resolution order: `model.api_key` > `model.env_key` > session token > `XAI_API_KEY`.
- **A cached OAuth login takes precedence over `XAI_API_KEY`.**
- OAuth tokens auto-refresh, with a 30-day fallback lifetime.
- Note: third-party guides cite `GROK_CODE_XAI_API_KEY`, which is stale. The 1.0.x docs use only `XAI_API_KEY`.

**Subscription vs API key** **[3P]**
- Subscription (OAuth) usage draws from a shared weekly pool across Chat, Imagine, Voice and Build.
- Plans: SuperGrok about $30, X Premium+ about $40, SuperGrok Heavy about $300. A plan reportedly renamed "The X Subscription" in October 2026.
- API-key usage is pay-per-token and separate from the pool.

**Retry settings** **[D]**
- 429 retries: `[models] max_retries`, `rate_limit_retry_threshold`, `subagent_rate_limit_max_attempts`. The subagent wait budget is 150 s.
- Inference idle timeout: 600 s per SSE chunk (`inference_idle_timeout_secs`). Set proxies to at least a 10-minute idle timeout.

**Pitfalls for long unattended runs** **[D]** **[V]**
1. **Trust gate.** Project AGENTS.md, hooks, skills and MCP silently do not load headless without `--trust` or `GROK_FOLDER_TRUST=0`. **[V]**
2. **Silent permission refusal.** Without `--always-approve`, a needed edit is refused and the run still exits 0.
3. **Leaks from the user's own config.** Grok reads the user's `~/.claude/` CLAUDE.md, rules, skills, hooks and MCP, plus `~/.cursor`, by default. In this environment that means the user's global Chinese-language `~/.claude/CLAUDE.md` and Claude plugin hooks would be injected into Grok runs. Disable with:
   - `GROK_CLAUDE_{SKILLS,RULES,AGENTS,MCPS,HOOKS}_ENABLED=0` and `GROK_CURSOR_*_ENABLED=0`
   - or `[compat.claude]`/`[compat.cursor]` set to false in an isolated `GROK_HOME`
   - Confirm the result with `grok inspect --json` → `externalCompat`. **[V]**
4. **Gitignored instruction files are skipped.** Do not gitignore a generated AGENTS.md.
5. **Root discovery climbs to the nearest `.git`.** A novel project nested inside a larger repo inherits that repo's rules and scans slowly. `git init` each book directory, or keep it outside any repo.
6. **Background-work wait.** The run waits up to 10 minutes and then exits 1; use `--no-wait-for-background`.
7. **Auto-updates.** Pass `--no-auto-update` and set `GROK_DISABLE_AUTOUPDATER=1`. Pin the npm version, because releases land almost daily.
8. **SIGTERM.** Grace can exceed 10 s; wait longer before SIGKILL. `GROK_EXIT_TIMEOUT_SECS` defaults to 20.
9. **Bash tool limits.** Foreground timeout defaults to 120 s; output is capped at 20000 bytes.
10. **Session growth.** Long sessions grow `updates.jsonl`; use `grok du` and `grok sessions delete`.
11. **Shared leader.** A shared leader process or daemon can be used by default. For isolation, use `--leader-socket` with a separate `GROK_HOME`. A non-`off` sandbox refuses leader mode.
12. **Shell vs daemon route.** Behavior differs between the two (usage accounting, tool names, workflows). Pin the version and test.

## 11. Other notes for a multi-harness orchestrator

**Compatibility surface** **[D]**
- Grok was built as a Claude Code drop-in. It accepts the flag aliases `--allowedTools`, `--disallowedTools`, `--append-system-prompt`, `--system-prompt` and `--dangerously-skip-permissions`.
- It reads `CLAUDE.md`, `.claude/rules`, `.claude/settings.json` hooks, `.mcp.json`, Claude skills, agents and plugins.
- Its `streaming-messages-json` output mirrors Claude's stream-json.
- So one Claude-oriented project layout (`CLAUDE.md` + `.claude/skills` + hooks) serves both cc and grok, and the AGENTS.md family also serves Codex and others.

**Useful extras**
- `--json-schema` gives schema-constrained final output, useful for structured "chapter manifest" returns. **[V]**
- `-w/--worktree` isolates parallel writers per git worktree. **[V]**
- `grok inspect --json` can be a preflight assertion that the expected rules, skills and MCP are loaded before a long run. **[V]**
- OpenTelemetry export: `GROK_EXTERNAL_OTEL` / `[telemetry] otel_*`. **[D]**
- Enterprise policy pinning via `/etc/grok/requirements.toml` could lock always-approve off on some hosts (`disable_bypass_permissions_mode`); detect this. **[D]**

---

## Adapter implications

**Recommended invocation** (one chapter or task = one call):
```bash
env XAI_API_KEY=... GROK_HOME=<orchestrator-owned dir> GROK_DISABLE_AUTOUPDATER=1 \
    GROK_FOLDER_TRUST=0  # or pass --trust once per book dir
    GROK_CLAUDE_RULES_ENABLED=0 GROK_CLAUDE_AGENTS_ENABLED=0 GROK_CLAUDE_HOOKS_ENABLED=0 \
    GROK_CLAUDE_SKILLS_ENABLED=0 GROK_CLAUDE_MCPS_ENABLED=0 GROK_CURSOR_RULES_ENABLED=0 ... \
    GROK_MEMORY=0 GROK_WEB_FETCH=0 \
  grok --no-auto-update -p "<task>"   # or --prompt-file task.md for long prompts
    --cwd <book_dir> --output-format streaming-json   # or streaming-messages-json to reuse the Claude parser
    -m <model> --reasoning-effort high
    --always-approve --sandbox workspace               # or --permission-mode dontAsk + --allow 'Write(chapters/**)' 'Edit(bible/**)' ...
    --deny 'Bash(rm *)' --disable-web-search
    --max-turns N --no-wait-for-background
    [-s <pre-generated uuid>] | [-r <uuid> [--fork-session]]
    [--rules "<per-call addendum>"] [--system-prompt-override "<full writer prompt>"]
```

**Event parsing**
- Read stdout line by line as NDJSON and switch on `type`.
- Treat `end` or `error` (or `result` for the messages format) as authoritative.
- Take spend only from `end`/`result`. Respect `usage_is_incomplete` and `cost_is_partial`; a missing cost does not mean zero.
- Treat stderr as logs, including update notices and `permission required:` lines. Scan stderr for `permission required:` and fail the job even when the exit code is 0.
- Map exit codes: 0 ok, 1 error, 130/143 interrupted.
- Verify the outputs exist on disk: the expected chapter file, size and checksum. The agent writes files, and stdout is only the event trace.

**Resume**
- Pre-generate a UUID and pass `-s` on the first call, so the ID is known even on failure.
- Continue with `-r <uuid>`. Use `--fork-session` to branch, for example to retry a chapter from a checkpoint.
- Sessions live under `$GROK_HOME/sessions`. Use `grok usage <id>` for after-the-fact accounting.
- For very long books, prefer fresh sessions per chapter, with state in files (bible, outline, summaries). Rely on auto-compaction (threshold 85%, tunable) only within a single chapter's work.

**Instruction-file injection**
- Write one generated `AGENTS.md`, from the user's per-project or per-genre template, at the book root.
- Use `.grok/rules/*.md` (or `.claude/rules/`) for modular rule packs such as style, POV and continuity checklist.
- Optionally use a `[paths] extra_rule_dirs` entry in the orchestrator's `GROK_HOME/config.toml` for global, user-editable packs. These are not subject to trust or gitignore.
- For hard control, pass the full writer persona via `--system-prompt-override` or an `--agent <writer.md>` definition. This replaces the default coding-agent prompt, which is likely beneficial for fiction.
- Keep the book directory its own git repo, or outside any repo, so discovery does not climb into a parent repo. Never gitignore AGENTS.md.
- Preflight every job with `grok inspect --json` in the book dir. Assert that `projectInstructions` contains the expected paths, and that `externalCompat` and `hooks` show no leakage from the user's `~/.claude`.

**Gotchas checklist**
- Trust gate and silent exit-0 refusals.
- `~/.claude` and `~/.cursor` compat leakage, especially on this host.
- An OAuth token overrides `XAI_API_KEY`; with an isolated `GROK_HOME`, only the key is used.
- Daily releases: pin the version.
- 10-minute background wait.
- 600 s SSE idle timeout and the proxy timeouts around it.
- Bash defaults: 120 s timeout, 20 KB output cap.
- `-s` cannot resume.
- Stdin is not read; use `--prompt-file`.
- Possible enterprise lock on always-approve.

**Optional richer integration:** drive it through ACP (`grok agent --always-approve stdio`) with the TypeScript or Python ACP SDK. This gives one long-lived process per book with multiple sessions, live `session/update` streaming, `session/load` resume, per-session `_meta.rules` / `systemPromptOverride`, and `x.ai/compact_conversation`. The same adapter shape also works for any other ACP-speaking harness.

---

**Sources:**
- [docs.x.ai/build/overview](https://docs.x.ai/build/overview)
- [Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting)
- [CLI Reference](https://docs.x.ai/build/cli/reference.md)
- [AGENTS.md](https://docs.x.ai/build/features/project-rules.md)
- [Sessions](https://docs.x.ai/build/features/sessions.md)
- [Hooks](https://docs.x.ai/build/features/hooks.md)
- [MCP](https://docs.x.ai/build/features/mcp-servers.md)
- [Permissions](https://docs.x.ai/build/features/permissions.md)
- [Sandbox](https://docs.x.ai/build/features/sandbox.md)
- [Subagents](https://docs.x.ai/build/features/subagents.md)
- [Skills/Plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces.md)
- [Settings](https://docs.x.ai/build/settings.md)
- [Settings Reference](https://docs.x.ai/build/settings/reference.md)
- [Enterprise](https://docs.x.ai/build/enterprise.md)
- [Models & pricing](https://docs.x.ai/developers/models.md)
- [May 15 2026 retirement](https://docs.x.ai/developers/migration/may-15-retirement.md)
- [docs index llms.txt](https://docs.x.ai/llms.txt)
- [npm @xai-official/grok](https://www.npmjs.com/package/@xai-official/grok)
- [ACP spec](https://agentclientprotocol.com)
- Third-party, low confidence: [codeagentswarm pricing guide](https://www.codeagentswarm.com/en/guides/grok-build-pricing), [Warp Grok subscription docs](https://docs.warp.dev/agents/inference/grok-subscription/), [mer.vin launch writeup](https://mer.vin/2026/05/grok-build-cli-xai-terminal-coding-agent-with-plan-mode-subagents-and-headless-ci/), [verdent install guide](https://www.verdent.ai/zh-CN/guides/grok-build-install), [noqta.tn](https://noqta.tn/en/news/xai-grok-build-coding-cli-agent-2026)
- Bundled user guide, extracted from the 1.0.77 binary: `<scratch>/grokhome/docs/user-guide/`, especially `14-headless-mode.md`, `12-project-rules.md`, `15-agent-mode.md`, `10-hooks.md`, `22-permissions-and-safety.md` and `26-config-reference.md`.
- Test binary: `<scratch>/grokbin/grok`.
