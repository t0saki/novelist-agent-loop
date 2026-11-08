
# Cross-Harness Standards and Orchestration for Novelist 2.0 (research as of 2026-11-08)

Sources were checked live on 2026-11-08. Items marked *(2nd-hand)* come only from third-party pages. The rest come from official docs or vendor repos read through `gh api`.

---

## 0. TL;DR

- **AGENTS.md** covers instruction files for most of the targets. Codex, Grok Build, Antigravity CLI (agy), DeepSeek Harness (dsh) and pi read it natively. Claude Code (CC) reads it natively from v2.1.277, but only when no `CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or above it. No bridging symlinks are needed anymore, apart from CC's `--bare` mode and older CC versions.
- **Agent Skills (SKILL.md)** is supported by all five targets plus pi. `.agents/skills/` is the shared project path for Codex, agy, Grok, dsh and pi. CC documents only `.claude/skills/`, so it needs a symlink or generated copy.
- **ACP** has reached v1 with a registry, and every target harness has an ACP entry point. It is the only protocol that standardizes injecting MCP servers per session (`session/new.mcpServers`) and answering permissions in code. However, its adapters lag the native CLIs, and budget, turn, structured-output and cost controls are not uniform. Use it as a secondary driver, not the only one.
- **MCP as the shared "novel state" layer** works on all targets. Run one long-lived localhost Streamable-HTTP server owned by the orchestrator, and inject it per run through each harness's CLI or config.
- **Prior art.** Harbor, vibe-kanban and Orchestrator.inc all converge on the same design: a native adapter per top-tier harness, a generic ACP adapter for the long tail, and normalization into one internal event/trajectory schema. rulesync already generates config for all five targets, DeepSeek Harness included.

---

## 1. AGENTS.md

**Governance.** AGENTS.md was contributed by OpenAI and is now a founding project of the Agentic AI Foundation (AAIF) under the Linux Foundation, alongside MCP and goose. AAIF was announced 2025-12-09; its platinum members include Anthropic, Google, OpenAI and Microsoft.
- https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- https://agents.md/

**Rule semantics.** The nearest file wins, nested files are allowed, and explicit chat prompts override everything.

| Harness | Native AGENTS.md | Other files read | Size limits / quirks | Source |
|---|---|---|---|---|
| **Claude Code** | Yes, v2.1.277+, via the built-in plugin `cc-plugin-agents-md@builtin`. Default mode `claude-md-or-agents-md`: AGENTS.md loads only when there is no CLAUDE.md, `.claude/CLAUDE.md` or CLAUDE.local.md at or above the cwd. Can be set to `claude-md-and-agents-md` in `~/.claude/settings.json` or a `--settings` file (ignored in project settings). | CLAUDE.md, CLAUDE.local.md, `.claude/rules/`, `@path` imports | Does not read `AGENTS.local.md`, `AGENTS.override.md` or anything under `.agents/`. **`--bare` skips CLAUDE.md and AGENTS.md**, so pass `--append-system-prompt-file`. | https://code.claude.com/docs/en/memory#agents-md , https://code.claude.com/docs/en/headless |
| **Codex** | Yes | `AGENTS.override.md` first, then `AGENTS.md`, then `project_doc_fallback_filenames`; at most one file per directory, root to cwd; global `$CODEX_HOME/AGENTS.md` | `project_doc_max_bytes` defaults to **32 KiB** for the combined chain | https://learn.chatgpt.com/docs/agent-configuration/agents-md |
| **Grok Build** | Yes | Also `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE*.md`, `.grok/rules/*.md`, `.claude/rules/*.md`, `~/.grok/rules`, `extra_rule_dirs`. Loads every matching file per directory; deeper files win. | **Startup loading requires folder trust (`--trust`)**. `--rules <TEXT>` appends to the system prompt. | https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/12-project-rules.md |
| **Antigravity CLI (agy)** | Yes | `<dir>/AGENTS.md` or `GEMINI.md`, `<dir>/.agents/AGENTS.md`, `.agents/rules/*.md` (needs `trigger` frontmatter or the file is silently dropped), global `~/.gemini/AGENTS.md`, `~/.gemini/config/rules/` | Workspace and parent directories only; subfolders are not loaded. Rules are cumulative. 24,000-byte limit per rule file (per rulesync). | https://antigravity.google/docs/rules |
| **DeepSeek Harness (dsh)** | Yes | Candidates `AGENTS.md` and `CLAUDE.md`, local overlays `AGENTS.local.md` and `CLAUDE.local.md`, global `$DSH_HOME/AGENTS.md` and `~/.agents/AGENTS.md`. Byte-identical files and symlinks are deduplicated. | 65,536-byte budget per chain | https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/context/agent-instructions/README.md |
| **pi** | Yes | `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`; `.pi/SYSTEM.md` replaces the system prompt; `.pi/APPEND_SYSTEM.md` appends | — | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md |

**Implications for Novelist 2.0**
- Generate a single `AGENTS.md` per book workspace and **never write a project `CLAUDE.md`**. That keeps CC on AGENTS.md. If a CLAUDE.md is ever needed, make it `@AGENTS.md`.
- Keep AGENTS.md small: role, file contract, style rules, under ~16 KB. Codex's 32 KiB cap and agy's 24 KB-per-file cap make it the wrong place for the story bible. Agents should pull the bible through MCP or read files on demand.
- User-level files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.grok/rules`, `~/.dsh/AGENTS.md`) leak into every run. For reproducible runs and per-project policy, give each run its own home: `CLAUDE_CONFIG_DIR` or `--bare --settings`, `CODEX_HOME` or `--ignore-user-config`, `GROK_HOME`, `DSH_HOME`/`DSH_AGENTS_HOME`, and for agy an isolated `~/.gemini` through `HOME`.

---

## 2. Agent Skills (SKILL.md)

**Spec** (https://agentskills.io/specification). Required frontmatter is `name` (≤64 chars, kebab-case, must equal the directory name) and `description` (≤1024 chars). Optional fields are `license`, `compatibility`, `metadata`, and the experimental `allowed-tools`. Skills load by progressive disclosure: metadata first, then the body (<500 lines recommended), then `scripts/`, `references/` and `assets/`. Validate with `skills-ref validate`. The format came from Anthropic and is now an open standard.

| Harness | Project skill dirs | User dirs | Notes |
|---|---|---|---|
| CC | `.claude/skills/`, nested `<subdir>/.claude/skills/`, `--add-dir` targets, `--plugin-dir/skills` | `~/.claude/skills/` | `.agents/skills` is **not documented**, so symlink it. Adds many extensions (`context: fork`, `disable-model-invocation`, `paths`, `hooks`, `model` and others); these are rejected outside CC. https://code.claude.com/docs/en/skills |
| Codex | `.agents/skills/` from cwd up to repo root | `$HOME/.agents/skills`, `/etc/codex/skills` | Follows symlinks. Invoke with `$skill` or implicitly; `allow_implicit_invocation` lives in `agents/openai.yaml`. https://learn.chatgpt.com/docs/build-skills |
| Grok Build | `.grok/skills/`, `.agents/skills/`, `.claude/skills/`, `.cursor/skills/` (cwd up to repo root) | `~/.grok/skills`, `~/.claude/skills` | Deduplicated by name with priority. Ignores `.gitignore`. https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/08-skills.md |
| agy | `.agents/skills/` (and parents); legacy `.agent/skills` | `~/.gemini/config/skills/`, `~/.gemini/antigravity-cli/skills/`, `~/.gemini/skills/` | https://antigravity.google/docs/skills |
| dsh | `.dsh/skills`, `.agents/skills` (project first, first match wins) | `~/.dsh/skills`, `~/.agents/skills` | Accepts `<name>/SKILL.md` or `<name>.md`. Does not parse `allowed-tools` or `context: fork`. https://github.com/deepseek-ai/deepseek-harness/blob/main/.agents/notes/archived/feature/2026-07-05-skill-system.md |
| pi | `.pi/skills`, `.agents/skills` | `~/.agents/skills` | Implements the spec; invalid fields produce warnings. https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md |

**Recommendation.** Keep canonical skills in `.agents/skills/<name>/SKILL.md` using only the six spec fields, and symlink `.claude/skills -> ../.agents/skills`. Good skill candidates: `write-chapter`, `revise-chapter`, `continuity-audit`, `update-bible`, `outline-arc`. Put the per-genre or per-project custom instructions you want inside skills and the AGENTS.md template, not in harness-specific files.

---

## 3. Agent Client Protocol (ACP)

**Status**
- Org: https://github.com/agentclientprotocol. Spec repo: https://github.com/agentclientprotocol/agent-client-protocol (about 4.6k stars).
- Latest releases: v1.15.1, schema-v1.29.1, and **schema-v2.0.0-alpha.13** (2026-11-02). Official SDKs exist for TypeScript, Python, Rust, Kotlin and Java.
- A conformance kit, `acp-tck`, is new (2026-10).
- A registry (https://github.com/agentclientprotocol/registry) lists about 47 agents with distribution metadata (npx, binary with sha256 per platform, args).

**Entry points for the target harnesses**

| Harness | ACP entry | Type |
|---|---|---|
| CC | `npx @agentclientprotocol/claude-agent-acp@0.101.0` (wraps the Claude Agent SDK; authors Anthropic, Zed, JetBrains) | Adapter |
| Codex | `npx @agentclientprotocol/codex-acp@2.5.0`. The old `zed-industries/codex-acp` repo is archived. | Adapter |
| Grok Build | `grok agent [--always-approve] stdio` (also `serve`/WebSocket) | **Native** — https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md |
| agy | Docs: `agy acp`, ACP v1 over stdio, with load/resume/list/close sessions, steering, cancel, and `--process-per-session`. The registry instead ships a separate proprietary `agy-acp-server` binary (1.4.5). | Native — https://antigravity.google/docs/ide/extensions/acp |
| dsh | `dsh --profile acp`. Not in the registry, but has design notes on multi-session, terminal and subagent support. dsh also offers `--profile sdk`, a JSON-RPC stdio SDK. | Native — https://github.com/deepseek-ai/deepseek-harness/blob/main/apps/cli/README.md |
| pi | `npx pi-acp@0.0.34` (community, 0.0.x) | Adapter |
| Gemini CLI | `gemini --acp` (formerly `--experimental-acp`) | Native |

**What ACP gives an unattended orchestrator**
- **Per-session MCP injection.** `session/new` takes `cwd` (absolute) and `mcpServers`. Every agent must support stdio; `http` is gated by `mcpCapabilities.http`. This is the only cross-harness standard for injecting the "novel-state" server without writing each harness's config files. https://agentclientprotocol.com/protocol/session-setup
- **Permissions answered in code.** `session/request_permission` reaches the client (allow_once, allow_always, reject_once, reject_always), and the spec says clients may decide automatically. The orchestrator can enforce a path allowlist, for example "writes only under `chapters/` and `notes/`", instead of using yolo flags. https://agentclientprotocol.com/protocol/tool-calls
- **Session lifecycle.** `session/load` (with history replay), `session/resume`, `session/close` and `session/cancel` are all capability-gated. Streaming `session/update` events cover tool calls, diffs and plans in a single schema.
- **Optional `systemPrompt` and `additionalDirectories`**, but only when the agent advertises them.

**Weaknesses for headless batch work**
1. Adapters wrap SDKs and lag the CLIs. Features vary by agent: CC's `--max-budget-usd`, `--max-turns`, `--json-schema` and cost totals; Codex `--output-schema`; Grok `--max-turns`.
2. Usage and cost reporting is not uniform across agents.
3. `auth_required` flows differ per agent.
4. Some agents implement only stdio MCP, or ignore client-supplied servers. Check `mcpCapabilities` at `initialize`.
5. Processes are long-lived, so the orchestrator must handle crashes, reconnects and memory growth.
6. ACP was designed for interactive editors.
7. v2 is in alpha, so expect schema churn.

**Verdict.** ACP is viable as a universal *secondary* driver, and it is the best option for dsh, pi and any future harness. Harbor ships a generic `acp.py` runner driven by the registry, and vibe-kanban drives Gemini, Qwen and others through ACP. Both still use native protocols for CC and Codex.

---

## 4. MCP as the shared tool layer

**Spec.** The current revision is **2026-07-28**, the first since 2025-11-25. It adds per-request `_meta` with version and capabilities, `server/discover`, and OTel trace propagation. One secondary source says protocol-level sessions and `Mcp-Session-Id` were removed; verify that before relying on session headers. *(changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog)*

**Architecture.** The orchestrator runs **one** `novelist-mcp` server on `http://127.0.0.1:<port>/mcp` (Streamable HTTP) and owns the single database writer. This avoids v1's concurrent SQLite lock deadlocks. Each run is bound by a per-run token in a URL path segment or header, e.g. `/mcp/run/<run_id>`, so `commit_chapter` knows the book, chapter and attempt. Fall back to a stdio shim (`novelist mcp-stdio --run <id>` proxying to the daemon) for harnesses or ACP agents without HTTP support.

**Suggested tools**
- Read: `get_chapter_context(ch)`, `query_canon(q)`, `get_outline(arc)`.
- Write: `propose_bible_patch` (validated diff, not free-form), `commit_chapter(path, summary, facts[])`, `report_issue`.
- Gating: `commit_chapter` validates length, required sections and file existence, then records the commit atomically. **Completion is judged from MCP/DB state, never from stdout.**

**Per-harness injection** (prefer CLI or per-run config so the user's global config is untouched)

| Harness | Injection | Auto-approve MCP tools |
|---|---|---|
| CC | `--mcp-config '<json>' --strict-mcp-config`. In `-p` mode, project `.mcp.json` loads without approval; `--strict-mcp-config` ignores it. `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`; `MAX_MCP_OUTPUT_TOKENS` defaults to 25k. The `system/init` event lists `mcp_servers` and `mcp_server_errors`, so the orchestrator can fail fast. | `--allowedTools "mcp__novel__*"` plus `--permission-mode` (`acceptEdits`/`auto`) and `--permission-prompts none` (v2.1.259+). https://code.claude.com/docs/en/mcp |
| Codex | `[mcp_servers.novel]` in `$CODEX_HOME/config.toml` (per-run CODEX_HOME), or project `.codex/config.toml` (**only loaded if the project is trusted**). `-c` dotted overrides also work; check `codex --help`. | `--sandbox workspace-write`, `--approve-for-me`. `--full-auto` is removed. |
| Grok | `[mcp_servers.novel]` in `~/.grok/config.toml` or repo `.grok/config.toml` (trusted only). Also reads compat sources (`.mcp.json`, Claude, Cursor). `MCP_TIMEOUT`, `GROK_MAX_MCP_OUTPUT_BYTES` (default 20,000 B). | `--allow "MCPTool(novel*)"`, `--permission-mode bypassPermissions` or `--yolo` |
| agy | `<workspace>/.agents/mcp_config.json` with `{"mcpServers":{"novel":{"serverUrl":"http://127.0.0.1:…/mcp"}}}`. Streamable HTTP only; SSE is not supported. https://antigravity.google/docs/mcp | `--dangerously-skip-permissions` or `permissions.allow` in settings |
| dsh | `--patch overlay.yml` adding an `mcp-client`/`mcp-manager` row (`transport: streamable-http`, `url`), or ACP `session/new.mcpServers` | Default preset is `workspace-write`; `DSH_PERMISSION_MODE` |
| pi | `pi mcp add -l novel --url …` (project config) | — |

**Large outputs.** Tool-result caps differ: CC 25k tokens, Grok 20 KB. `get_chapter_context` should return a compact digest plus file paths, and the agent reads full files with its own file tools.

---

## 5. Existing multi-harness orchestrators: how they abstract CLIs

| Project | Abstraction | Lessons |
|---|---|---|
| **Harbor** (harbor-framework/harbor, about 6.9k★, active) — agent eval framework; successor to the terminal-bench harness | One Python class per harness (`claude_code.py`, `codex.py`, `grok_build.py`, `antigravity_cli.py`, `pi.py`, …), plus a generic `acp.py`/`acp_runner.py` resolved from the ACP registry. Typed `Cli(...)` option fields map to flags. Every trajectory is normalized to **ATIF** (`trajectory.json`). | **Exit watchdog that kills orphaned child processes**, since Grok can leave background tasks holding the pipe. Error classification reads JSONL (`filter_jsonl_events`), not exit codes. Auth preflight fails early instead of letting agy hang on sign-in. agy needs `GEMINI_API_KEY` plus `"modelProvider":"gemini"` in `~/.gemini/antigravity-cli/settings.json` to skip OAuth. Harbor works around a 5-minute agy print timeout, while official docs say `--print-timeout` defaults to `0s` (no limit); set it explicitly. Resume is done by synthesizing native session JSONL files. https://github.com/harbor-framework/harbor/tree/main/src/harbor/agents/installed |
| **vibe-kanban** (BloopAI, about 28.6k★) — Rust | `crates/executors`. CC uses bidirectional `--input-format=stream-json --output-format=stream-json --permission-prompt-tool=stdio --replay-user-messages`. Codex uses **app-server JSON-RPC** (`codex_app_server_protocol`). OpenCode uses its SDK. Gemini, Qwen and others use a shared `AcpAgentHarness` with a `normalize_logs` module per executor. | Use the richest native protocol for the top 2–3 harnesses and ACP for the rest; normalize everything into one log/event model. https://github.com/BloopAI/vibe-kanban/tree/main/crates/executors/src/executors |
| **Orchestrator.inc / agent-orchestrator** (about 14k★) | Desktop app with planner and worker agents. Each task gets its own agent, branch and git worktree. 35+ agents including Grok, Pi, Kimi; per-agent capability matrix for worker, chat and reviewer roles. | One worktree per task, and failures go back to the owning worker. https://github.com/OrchestratorInc/agent-orchestrator |
| **claude-squad** (about 8.7k★, last push 2026-08) | Runs TUI agents in tmux, one worktree each. | The terminal-scraping approach; not suitable for unattended structured runs. |
| **coder/agentapi** (**archived** 2026-09) | Wrapped TUIs behind HTTP by emulating a terminal. | Screen scraping lost to native headless and ACP. |
| **rulesync** (about 1.6k★, active) | Generates rules, MCP config, skills, subagents, hooks and permissions per target. Supports **Claude Code, Codex CLI, Grok CLI, Antigravity CLI/IDE, DeepSeek Harness**, plus an `AgentsSkills` standard target. | Can be used as a library or CLI, or as a reference for file paths. https://github.com/dyoshikawa/rulesync |
| **ruler** (about 3k★) | `.ruler/` mapped to per-agent files and MCP configs. | Its Antigravity row (`.agent/rules`) looks stale; prefer rulesync. https://github.com/intellectronica/ruler |
| **vercel-labs/skills** (`npx skills`, about 38k★) | Installs skills into each harness's directory. | Useful for distributing skill packs. |
| **OpenHands** | Its own agent SDK and runtime, not a driver for other CLIs. Appears in the ACP registry list. | Not directly reusable. |

---

## 6. Per-harness native headless surface (input to the adapter layer)

| Harness | One-shot command | Event stream | Resume | Structured final | Key gotchas |
|---|---|---|---|---|---|
| **CC** | `claude -p … --output-format stream-json --verbose [--bare]` | `system/init` (tools, mcp_servers, `capabilities`), assistant/user/stream_event, `system/api_retry` (typed error categories such as `rate_limit` and `billing_error`), `permission_denied`, final `result` (cost, session_id) | `--resume <id>` or a path to the `.jsonl` transcript | `--json-schema` gives `structured_output` | SIGTERM exits 143 and abandons the turn; send SIGINT first. `--bare` is recommended for scripts (it will become the default) but needs `ANTHROPIC_API_KEY`. From v2.1.302, `-p` starts in Manual mode. Stdin is capped at 10 MB. The **Agent SDK** (Python/TS) offers the same loop with `canUseTool`. https://code.claude.com/docs/en/headless |
| **Codex** | `codex exec --json -o last.md [--output-schema f] --sandbox workspace-write [--ephemeral] [--ignore-user-config] [--skip-git-repo-check]` | `thread.started`, `turn.started/completed/failed`, `item.started/completed` (agent_message, reasoning, command_execution, file_change, mcp_tool_call, …), `error` | `codex exec resume <id>` or `--last` | `--output-schema` | `--full-auto` removed. **app-server** (JSON-RPC over stdio; threads and turns; `turn/interrupt`; error -32001 means back off; schema marked unstable; `generate-json-schema`). The TS SDK `@openai/codex-sdk` spawns the CLI with JSONL. https://learn.chatgpt.com/docs/non-interactive-mode , https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md |
| **Grok Build** | `grok -p … --output-format streaming-json [--cwd] [--max-turns] [--yolo] [--trust] [--rules]` | `streaming-json` / `streaming-messages-json`; `json` envelope includes text, stopReason, sessionId, usage, num_turns, cost | `-r <id>`, `-c`, `-s <uuid>` (new session with a fixed id), `--fork-session` | — | Tool ids are internal (`run_terminal_cmd`, `search_replace`). Background-task wait applies. Open source (Apache-2.0); repo `xai-org/grok-build`. https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md |
| **agy** | `agy -p "<prompt>" --output-format stream-json --print-timeout 30m --dangerously-skip-permissions` (`-p` must be **immediately** followed by the prompt) | `init`, `step_update` (step_type, tool_info, text_delta, usage), `result`; statuses SUCCESS, ERROR, CANCELED, … | `--conversation <id>`, `-c`; `--input-format stream-json` for multi-turn over stdin | `--json-schema` | Exit 0 even for soft-denied approvals, so check `status`. Old builds (1.0.x) printed nothing when stdout was not a TTY (issue #76); fixed in newer builds. https://antigravity.google/docs/cli/headless |
| **dsh** | `dsh --profile headless "<task>"` | Final text on stdout, reasoning on stderr. **No JSONL event stream**; use `--profile sdk` (JSON-RPC) or `--profile acp` for events. | Persisted sessions | — | Exit 0 only if `completed`. Developer preview with breaking changes. **Session-log upload to DeepSeek is on by default** (disable the `session-log-deepseek` row with `enabled:false`); `DSH_TELEMETRY_MODE=DISABLED` disables OTel. https://github.com/deepseek-ai/deepseek-harness/blob/main/apps/cli/reference/README.md |
| **pi** | print / `--mode json`, `--mode rpc`, TS SDK | JSON events | sessions | — | https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs |

**Auth and terms risks** (these are user decisions)
- **Antigravity FAQ:** running `agy` inside third-party apps is "not supported under consumer plans", and third-party access may lead to suspension. Use a Gemini API key or Enterprise. https://antigravity.google/docs/faq
- **Anthropic:** February 2026 terms bar consumer OAuth tokens in third-party tools. Since 2026-06-15, `claude -p` and Agent SDK usage reportedly draws on a separate monthly "Agent SDK credit" *(2nd-hand: https://venturebeat.com/ai/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch/ , https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)*. An API key is the safe default. A set `ANTHROPIC_API_KEY` silently takes precedence over the subscription.
- **Grok headless:** billed to an xAI API key *(2nd-hand)*.
- **Privacy:** for private manuscripts, review dsh's default log upload. A July 2026 Grok CLI working-directory upload incident is reported by one source only and is unconfirmed *(2nd-hand: https://s.amplifying.ai/coding-agents/grok-build)*.

---

## 7. Recommendations: abstraction layer for a long-running unattended orchestrator

**Option comparison**

| Approach | Pros | Cons |
|---|---|---|
| **A. Process spawn plus native headless JSONL** (one adapter per harness) | Exposes every native control: budget, max-turns, json-schema, cost, typed retry errors, sandbox. One short-lived process per task, so crash isolation is free. Most reliable and best documented. Used by Harbor and vibe-kanban. | 5–6 parsers to maintain against changing schemas. MCP and permission configuration differ per harness. dsh has no event stream in headless mode. |
| **B. ACP everywhere** | One protocol. Standard MCP injection, programmatic permission policy, cancel, and load/resume. Registry with checksums. Covers dsh and pi cleanly. | Adapters lag the CLIs. Controls are uneven (no uniform budget, turns, schema or cost). Long-lived process management. v2 alpha churn. Interactive-first design. |
| **C. Vendor SDKs** (Claude Agent SDK, Codex SDK or app-server, pi SDK, dsh SDK profile) | Richest control (`canUseTool`, interrupts, typed messages). | Not universal; Grok and agy have no comparable SDK. Codex app-server schema is marked unstable. Language lock-in (TS/Python). |
| D. TUI or tmux scraping (agentapi, claude-squad) | Works with anything. | Fragile; agentapi is archived. Reject. |

**Recommended design: a hybrid driver behind one interface**

```
HarnessDriver.run(RunSpec{workspace, prompt_file, instructions, skills, mcp_endpoint,
                          policy, limits{wall, idle, turns, budget}, model, resume_id?})
  -> AsyncIterator[NormalizedEvent]  (init | text_delta | tool_call | tool_result |
                                      file_change | usage | retry | error | result)
```

**1. Tier 1, native adapters.** Use these for CC (`claude -p --bare --output-format stream-json`, or the Agent SDK if the orchestrator is TS/Python), Codex (`codex exec --json`), Grok (`grok -p --output-format streaming-json`) and agy (`agy -p --output-format stream-json`). Declare each adapter in data: a command template, a flag map, an event-mapping table and an error classifier.

**2. Tier 2, generic ACP adapter.** Use it for dsh (`dsh --profile acp`), pi (`pi-acp`) and any registry agent. Optionally run it in parallel with Tier 1 for CC and Codex as a fallback.

**3. Truth lives in files and MCP, not stdout.**
- The agent writes `chapters/NNNN.md` and notes in an isolated git workspace, then calls `commit_chapter`.
- The orchestrator validates the result, auto-commits to git (giving per-chapter rollback), and marks the job done only after the MCP commit plus validation succeed. Stdout is used only for telemetry and failure classification.

**4. Hermetic runs.**
- Give each run its own config home: `CLAUDE_CONFIG_DIR` or `--bare`, `CODEX_HOME`, `GROK_HOME`, `DSH_HOME`, and an isolated `HOME` for agy.
- Generate `AGENTS.md`, `.agents/skills/`, the `.claude/skills` symlink and the per-harness MCP stanzas from one source; rulesync can serve as a library or reference.
- Pass `--trust` for Grok, and make sure Codex trusts the project, or use CLI overrides instead.

**5. Supervision.**
- Wall-clock and idle-stream timeouts.
- Kill the whole process group, not only the PID (Harbor's orphan-child lesson).
- For CC, send SIGINT before SIGTERM.
- Map typed errors (`rate_limit`, `billing_error`, quota, `auth_required`) to backoff, then failover to another harness or model, then pausing the job.
- Probe auth before each run.
- Pin harness versions and keep contract tests per adapter: replay recorded JSONL fixtures in CI, and record each harness's version from `system/init` or `--version`.

**6. Session strategy for million-character novels.** Start a **fresh session per chapter task**, with context assembled by `get_chapter_context` (rolling summaries, canon facts, outline slice). Use resume (`--resume`, `exec resume`, `-r`, `--conversation`, ACP `session/load`) only for a repair loop inside one chapter. This avoids compaction drift and keeps harnesses interchangeable between chapters.

**7. Permissions.** Prefer allowlists over yolo flags:
- CC: `--allowedTools "Read,Edit,Write,mcp__novel__*" --permission-prompts none`
- Grok: `--allow` and `--deny`
- Codex: `--sandbox workspace-write`

Under ACP, the orchestrator's policy engine answers `request_permission`; for example, it allows writes only to `chapters/**` and `notes/**`.

**Open decisions for the user**
1. Auth mode per harness: API keys (safe for terms) or subscriptions (cheaper, but Anthropic, Google and xAI each have restrictions).
2. Orchestrator language: Python keeps v1 FastAPI and gets the Claude Agent SDK and ACP python-sdk; TypeScript gets the Codex SDK, the ACP TS SDK and native dsh/pi SDKs.
3. Whether to include dsh and agy in tier 1 at launch, or start with CC, Codex and Grok and add agy and dsh through ACP.
4. Whether to accept dsh's default log upload or force it off.
5. Whether to depend on rulesync or ship a small in-house config generator.
