
# Research report: "dsh" (DeepSeek Harness) and "pi" (Earendil / Mario Zechner) as engines for Novelist 2.0

Sources were checked on 2026-11-08. For dsh I cloned the repository (HEAD `fcc0ad4`, 2026-11-04) and checked the npm registry. For pi I read the docs shipped inside the npm tarball `@earendil-works/pi-coding-agent@1.5.0`. Repo-relative paths below point into `https://github.com/deepseek-ai/deepseek-harness/blob/main/`. pi doc names point to `https://cdn.jsdelivr.net/npm/@earendil-works/pi-coding-agent@1.5.0/docs/<name>`.

---

# Part A — "dsh"

## A0. What "dsh" is: candidates and confidence

| Candidate | Evidence | Confidence |
|---|---|---|
| **DeepSeek Harness**, the official DeepSeek open-source agent harness. CLI `dsh`, npm `@deepseek-ai/dsh` | Repo https://github.com/deepseek-ai/deepseek-harness (MIT). The README is "DeepSeek Harness: Everything is a Plugin". Launcher help reads "dsh: boot a DeepSeek Harness profile". npm `latest` = `0.2.2-rc.1`, published 2026-11-05. A third-party plugin ecosystem uses the name "DSH" (https://github.com/dingminhua/dsh-sub-cli). Secondary explainer: https://www.eesel.ai/de/blog/deepseek-harness-erklaert | **~95%**. This is clearly the "dsh" listed next to cc/codex/agy/grok build |
| Community DeepSeek CLIs (yinshuo-thu/deepseek-cli, Venompool888/deepseek-cli, a Claude Code fork) | They expose `deepseek` / `ds`, not `dsh`. https://github.com/yinshuo-thu/deepseek-cli/wiki, https://github.com/Venompool888/deepseek-cli | <3% |
| `dsh-sub-cli` | A DSH plugin that dispatches tasks to the Codex and Claude Code CLIs. It is not a harness | n/a |
| Classic "dancer's shell" `dsh` (distributed shell, a Debian package; from my own knowledge, not verified) | An unrelated parallel-ssh tool | <2% |

## A1. Identity
- Product: DeepSeek Harness, by DeepSeek AI. License MIT; third-party licenses are in `THIRD_PARTY_NOTICES.md`. Developer preview: the README warns "THERE WILL BE COMPATIBILITY-BREAKING CHANGES".
- Binary: `dsh`.
- Install options:
  - `npx @deepseek-ai/dsh <profile>`, or a global npm install. Requires Node `>=24.9.0` (root `package.json` `engines`).
  - Python wheel `pip install deepseek-harness-sdk`. It bundles a native runtime and the `dsh` command, so no system Node is needed (`docs/user/guide/python-sdk.md`).
  - Desktop app for macOS and Windows only; there is no Linux desktop build.
- Version: npm dist-tags `latest`/`next` = `0.2.2-rc.1`, `alpha` = `0.2.2-alpha.3`. Git tags run up to `dsh-v0.2.2-rc.1`.
- Architecture: built on the **Cordis** plugin framework. A *profile* is an ordered stack of bundle patch layers under `$DSH_HOME/profiles/<name>/`, which holds a `package.json` and `cordis.patch.yml`.
  - Shipped profiles: `web`, `headless`, `sdk`, `sdk-minimal`, `acp`. `desktop` is reserved.
  - Layer precedence, later wins: bundle patches, then profile `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch <file>` (repeatable).
  - **A patch replaces a row's entire `config` block. It does not deep-merge.** (`apps/cli/README.md`)
- The model layer reuses **pi-ai** from the pi project (`dsh-llm-pi-ai`) plus a native DeepSeek adapter.
- Docs site: https://deepseek-harness.github.io/deepseek-harness/. Generated CLI help: `docs/cli-help.md`.

## A2. Non-interactive / headless
- Command: `dsh --profile headless [options] [task...]`. `dsh headless ...` is the same.
- Task input: a positional argument, or stdin when the argument is omitted or is a lone `-`. A blank argument or an empty pipe is a usage error and exits 1.
- Flags (`docs/cli-help.md#dsh-headless`):
  - `--json`: NDJSON run events on stdout.
  - `--session-id <id>`: adopt an existing persisted session. An unknown id is an error.
  - `--permission-mode <preset>`
  - `--approval-policy ask|never`
  - `--add-dir <abs path>`: repeatable. Grants an extra writable root under `workspace-write`.
- Default output: final answer on stdout. Streamed reasoning goes to stderr under a `dsh: reasoning:` heading. A failure prints `dsh: <code>: <message>` to stderr.
- `--json` event vocabulary (`packages/bundle/headless/README.md`, `src/json-stream.ts`):
  - `{"type":"session","sessionId","cwd"}` comes first.
  - `status` events with `phase`: `turn_start`, `step_start`, `step_end` (carries `usage`), and `turn_end` (carries `reason`).
  - `text`, `thinking`, `tool_call`, `tool_result` (with `error:{name,code,reason?}`).
  - `{"type":"final","sessionId","reason","text"}` comes last.
  - `error` is emitted for runner failures outside a turn; in that case there is no `final`.
- `text`/`thinking` are emitted per *committed step*, not per token. Every string except `final.text` is capped at 8 KiB, and each line is capped at 32 KiB.
- Exit codes: 0 only when the final `turn/end` is `completed`. Aborted, errored, or no-turn runs exit 1. Profile-load failures exit nonzero with stderr only.
- Recommended success test (stated in the docs): exit 0 **and** `final.reason.kind === "completed"`. A `tool_result` status of `completed` does not mean the shell command inside it succeeded.
- Usage: on `status/step_end.usage` = `{inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}`, summed across retried attempts. It is omitted if any attempt reported no usage. There is **no cost field**; compute cost from DeepSeek pricing.
- Pricing (secondary source, eesel; check before relying on it):
  - V4.1 Flash: $0.15 cache-miss input / $0.60 output per 1M tokens off-peak. Peak hours double the price: weekdays 01:00–04:00 and 06:00–10:00 UTC.
  - Model limits: 1M context, 384K max output.

## A3. Sessions
- Persistence: JSONL logs under `$DSH_HOME/sessions/`. The default `DSH_HOME` is `~/.dsh`. The default session id is `session-<uuid>`, reported in the opening `session` event.
- Resume: `--session-id <id>`. Adoption is refused when:
  - the cwd differs from the recorded cwd,
  - the session is a subagent session,
  - the preset does not match,
  - the id is already live in the process.
- After killing a run, wait for the process to exit before resuming. `--add-dir` and the policy flags must be repeated on every resume.
- Fork: ACP does not support it. Internally, `subagent-fork-in-process` and `ctx.agents.create({seed})` exist; there is no headless fork flag.
- Compaction: `dsh-compaction-basic` is automatic.
  - Trigger: `floor(min(W×0.8, W−O−65536))`, where W is the context window and O is the output cap.
  - It keeps the newest 16% of `W−O` verbatim. Configure with `thresholdRatio`, `retainRatio`/`retainTokens`, `headroomTokens`, `modelPolicies[]`. `/compact` runs it manually.
  - A tool-result pruner also runs. The full log is preserved.
  - Source: `packages/compaction/compaction-basic/README.md`.

## A4. Instruction files (`packages/context/agent-instructions/README.md`)
- Two chains are loaded on the first request as one durable user-role `<system-reminder>` message:
  - User-global: `$DSH_HOME/AGENTS.md`, then `$DSH_AGENTS_HOME/AGENTS.md` (default `~/.agents`).
  - Project: every candidate file from the project root (`.git` marker) down to the cwd, broad to specific.
- Candidates: `AGENTS.md`, `CLAUDE.md`, plus local overlays `AGENTS.local.md`, `CLAUDE.local.md`. Configurable via `instructionFileCandidates`, `localInstructionFileCandidates`, `projectRootMarkers`.
- Size: `maxBytes` (base = 65536) applies **per chain**. `maxSourceBytes` = 1 MiB per file. Broader files are dropped before the most specific file is truncated.
- Not supported: `@path` imports, lowercase names, and `.claude/rules/`.
- Nested files are discovered only when first-party `read`/`write`/`edit` touch deeper directories. A shell `cd` does not count.
- The text is framed as guidance that "does not override system, developer, or direct user instructions".
- There is no CLI flag to override instruction files. Use a `--patch` overlay on the `agent-instructions` row.

## A5. Extensibility
- Everything is a Cordis plugin. Manage plugins with `dsh plugin --profile <p> add <pkg>` (forwarded to pnpm).
- Skills: `<root>/<name>/SKILL.md` or `<root>/<name>.md`, with YAML frontmatter `name`/`description`. Roots, in rank order:
  1. `<proj>/.dsh/skills`
  2. `<proj>/.agents/skills`
  3. `customSkillDirs`
  4. `$DSH_HOME/skills`
  5. `~/.agents/skills`
  - Roots are hot-watched; discovery is one level deep.
- Subagents: `subagent` tool, Agent Teams (up to 16 teammates), and a workflow tool (model-written orchestration scripts). External backends exist: `dsh-subagent-claude-code`, `dsh-subagent-codex`, `dsh-subagent-acp`, `dsh-subagent-dsh-sdk`. **dsh can itself delegate to Claude Code or Codex.**
- Hooks: `@deepseek-ai/dsh-hooks-claude-code` runs an existing Claude Code `hooks.json`/settings hooks (prompt/tool block, add context, Stop forcing continuation, SubagentStop). There is also `hooks-codex` and an experimental Claude Code mods bridge. All are experimental packages.
- MCP client: `dsh-mcp-client`, transports `stdio` and `streamable-http`, MCP protocol 2026-07-28 with legacy fallback. **No server is enabled by default.**
- Commands: a human-command registry. `/compact` exists; slash commands are UI-level.

## A6. Permissions / sandbox
- Presets (base bundle): `read-only` (sandbox read-only, approval `ask`), `workspace-write` (`ask`), `danger-full-access` (`never`). `auto` (experimental model-reviewed) is opt-in.
- Headless default: `workspace-write`. It can be overridden with env `DSH_PERMISSION_MODE`, or with `--permission-mode` / `--approval-policy`.
- Headless has no live approval channel. With `ask`, the answerer becomes `unavailable` and the call is denied (fail-closed); with `never`, the call is rejected outright. **Neither hangs.**
- Write boundary: the session cwd, plus `--add-dir` roots, plus platform temp directories.
- Sandbox backends:
  - Linux: `bwrap` (hides host processes) or Landlock.
  - macOS: Seatbelt.
  - Windows: ACL.
- **Reads and network are not restricted.**
- `sdk-minimal` pins `danger-full-access`.

## A7. Model / provider
- Default: provider `deepseek-official`, model `deepseek-flash` (V4.1 Flash; the alias `deepseek-v4-flash` still works).
- **Headless has no `--model` flag.** Select the model by overlaying the `agent-default-model` row with `{provider, model, reasoningEffort?}` through `--patch`. On resume, the runner records the current route.
- Third-party providers come from a catalog (e.g. `anthropic`, `openai`, `moonshotai`, `zai`). Custom endpoints go in the `llm-pi-ai.providers.<id>` row with:
  - `api: openai-completions | openai-responses | anthropic-messages`
  - `baseURL`, `apiKeyEnv`, `models[]`, `reasoningEfforts`
  - `compat` options: `supportsDeveloperRole`, `maxTokensField`, `thinkingFormat: deepseek`
  - Source: `docs/user/guide/providers.md`.
- DeepSeek effort levels: `off`, `low`, `high`, `max` (`llm-deepseek.reasoningEffort`).
- Credentials in headless: env, then `<cwd>/.env`, then `$DSH_HOME/.env`. Keys saved in the GUI are ignored. Env names include `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL`.

## A8. Programmatic control
- `dsh --profile sdk` / `sdk-minimal`: stdio JSON-RPC.
  - Python: `deepseek_harness.DeepSeekHarness(provider, model, max_tokens, cwd, dsh_home, profile, patches=(...))` with `.run(prompt, session_id=)`, `start_session`, `resume_session`.
  - TypeScript packages: `@deepseek-ai/dsh-sdk-client`, `-protocol`, `-jsonrpc-server`.
- `dsh --profile acp`: standard ACP v1 over stdio. Supports create/resume/list/close sessions, model and effort selection, attaching MCP servers, and cancel. Not supported: fork, delete, transcript replay, extra directories.
- `dsh web`: HTTP UI on 127.0.0.1:3080.

## A9. Prompt customization
- The `system-prompt` row config takes:
  - `includeHarnessIdentity` (default true; this is the fixed opener "You are an AI agent powered by DeepSeek Harness.")
  - `personaPrefix` (order 0)
  - `personaSuffix` (order 10200)
  - `includeRuntimeContext`, `toolOrder`
- The headless bundle sets `personaPrefix: "You are a coding agent powered by the {{model}} model."`.
- Full replacement requires a plugin contributing a `complete: true` section. Config alone leaves the first-party guidance sections in place.
- `sdk-minimal` reads `DSH_SYSTEM_PROMPT`.
- `{{cwd}}` is not a valid variable in persona templates; it fails prompt assembly.

## A10. Auth, limits, pitfalls
- Auth is API-key based (pay-per-token). DeepSeek account sign-in exists in the GUI but is disabled in headless.
- **Privacy:** `session-log-deepseek` is ON in base. It uploads session-log suffixes, up to 8 MiB per request, with official DeepSeek API requests. Disable it with the row `session-log-deepseek` set to `enabled: false` (or `disabled: true`).
- Telemetry: set `DSH_TELEMETRY_MODE=DISABLED`.
- Event and progress caveats:
  - No pre-token heartbeat.
  - `--json` text arrives only at step commit.
  - Event strings are truncated to 8 KiB.
  - Background jobs may not settle before exit.
- Breaking changes happen between 0.2.x releases.
- Starting the headless profile without the `dsh` launcher fails.

## A11. Other notes
- `DSH_HOME` isolates profiles, credentials, and sessions. Use one per novel project or worker.
- The headless README itself recommends a supervisor pattern: worktree per task, `--json` log, read `session.sessionId`, send revisions via `--session-id`.

---

# Part B — "pi" (pi coding agent)

## B1. Identity
- Author: Mario Zechner. Originally `badlogic/pi-mono` with npm `@mariozechner/pi-coding-agent` (last version 0.73.1, 2026-05-07).
- Now `@earendil-works/pi-coding-agent`. Repository URL: `https://github.com/earendil-works/pi` (Earendil took over stewardship in 2026; secondary sources such as https://www.eesel.ai/blog/pi-coding-agent give conflicting details).
- License MIT. Binary `pi`. Install with `npm i -g @earendil-works/pi-coding-agent`.
- Latest: **1.5.0 (2026-11-02)**. There is also a `legacy-node20` tag at 0.74.2.
- Site and model catalog: https://pi.dev.

## B2. Headless
- `pi -p|--print "..."`: final text on stdout.
  - Exits **nonzero** when the stop reason is `error`, `aborted`, or `length` (for `length`, the partial text is still printed).
  - Non-TTY stdin or stdout auto-selects print mode. Piped stdin is prepended to the prompt. `@file` attaches files.
- `pi --mode json "..."`: JSONL events.
  - First record is the session header `{"type":"session","version":3,"id","timestamp","cwd"}`.
  - Then `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `turn_end`, `agent_end{willRetry}`, `agent_settled{aborted}`.
  - Tool events: `tool_execution_start`, `tool_execution_update`, `tool_execution_end{isError,durationMs}`.
  - Also `compaction_start/end`, `auto_retry_start/end`, `queue_update`.
- **In JSON mode a failed or aborted response still exits 0.** Detect failure from the last assistant `message_end.message.stopReason` and `agent_settled.aborted`. Only `agent_settled` means done; `agent_end` can be followed by retries.
- Usage:
  - `message_update.usage` = `{input, output, cacheRead, cacheWrite, totalTokens, cost:{input,output,cacheRead,cacheWrite,total}}`, cumulative per assistant response.
  - `Usage.cost.totalFromProvider` (added in 1.5.0) separates billed cost from catalog estimates.
  - RPC `get_session_stats` gives `tokens`, `cost`, and `contextUsage`.
- Framing: split only on LF. Do **not** use Node `readline`, because of U+2028/U+2029. Read stdout continuously, or backpressure stalls pi.
- Doc refs: `cli.md`, `cli-integration.md`, `json.md`.

## B3. Sessions
- Storage: JSONL trees under `~/.pi/agent/sessions/`, grouped by cwd. Override with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting.
- Flags:
  - `-c/--continue`
  - `-r/--resume`: picker; interactive only.
  - `--session <path|id>`: resumes in that session's own cwd.
  - `--session-id <id>`: opens the id, or **creates it** if absent. The id must use `[A-Za-z0-9._-]` and start and end alphanumeric. An adapter can therefore pick deterministic ids.
  - `--fork <path|id>`: fork into the current cwd. Can be combined with `--session-id` to name the new session.
  - `--no-session`, `-n/--name`.
- RPC: `fork`, `clone`, `switch_session`, `new_session`, `get_tree`.
- Compaction settings:
  - `compaction.enabled` (default true)
  - `compaction.reserveTokens` (16384)
  - `compaction.keepRecentTokens` (20000)
  - `compaction.modelOverrides`
  - Reasons: `threshold`, `overflow` (auto-retry after compaction), `manual`.
- Max context depends on the model (e.g. Codex GPT-6.1 at 500K).

## B4. Instruction files
- Context files are loaded from the agent directory (`~/.pi/agent/` or `PI_CODING_AGENT_DIR`), then the cwd **and all parent directories**.
- Names: `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. `AGENTS.override.md` replaces AGENTS/CLAUDE in the same directory only.
- Context files are put into the **system prompt**, and they load **without project trust**.
- Disable with `-nc/--no-context-files`. No size limit or `@import` syntax is documented.
- System prompt files:
  - `SYSTEM.md` replaces the default prompt.
  - `APPEND_SYSTEM.md` appends to it.
  - Either can live in the agent dir or in `.pi/`; the trusted project file wins over the agent-dir file.
- Doc ref: `configuration.md`.

## B5. Extensibility
- Extensions: TypeScript modules in `~/.pi/agent/extensions`, `.pi/extensions`, or loaded with `-e path` or `builtin:mcp`. They can register tools, commands, flags, providers, MCP servers, and renderers. Hook events:
  - `input`, `before_agent_start`, `context`, `context_with_system`, `before_provider_request`
  - `tool_call`: can block or mutate, `{block, reason, terminate}`.
  - `tool_result`: can modify the result.
  - `turn_end`: can request continuation.
  - `agent_before_settle`: continuation, the equivalent of a Stop hook.
  - `session_before_compact`: can customize compaction.
  - `project_trust`
  - Doc ref: `extensions.md`.
- Skills: `SKILL.md`, discovered recursively in `~/.pi/agent/skills`, `.pi/skills`, `~/.agents/skills`, and `.agents/skills` (cwd up to the repo root). Load extra skills with `--skill`; disable with `-ns`. Invoke as `/skill:name`.
- Prompt templates: `prompts/`, used as `/template`.
- Packages: `pi install <npm|git>`.
- MCP is **now built in**: `pi mcp add|list|login`, `~/.pi/agent/mcp.json` and `.pi/mcp.json`, stdio and streamable HTTP, with OAuth. Disable with `--no-mcp`.
- `codemode` tool (QuickJS sandbox) and `tool_search`.
- **No built-in subagents.** A subagent example extension (`registerTool` + `exec`) exists; in-process subagents can be built via the SDK.

## B6. Permissions / sandbox
- **No approval system and no sandbox.** Tools run with the OS user's permissions. The docs recommend containers or VMs (`security.md`, `containerization.md`). Unattended use is effectively "yolo" by default.
- Project trust only gates loading of `.pi/*` resources and project `.agents/skills`. In print, JSON, and RPC modes the trust prompt cannot appear, and with the default `defaultProjectTrust: "ask"` those resources are **silently skipped**. Pass `-a/--approve`, or set `"always"` in the agent-dir settings.
- Restrict tools with `--tools read,write,edit`, `-xt` exclusions, or `--no-tools`.
- `--offline` / `PI_OFFLINE=1` disables automatic network activity. Model calls still go out, and bash still has network access.

## B7. Model / provider
- Flags: `--model <pattern|provider/id[:thinking]>`, `--provider`, `--thinking off|minimal|low|medium|high|xhigh|max`, `--api-key`, `--models`, `--list-models`.
- Settings: `defaultProvider`, `defaultModel`, `defaultThinkingLevel`.
- Environment keys include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`, and others.
- OpenAI, Anthropic, or Google compatible endpoints go in `~/.pi/agent/models.json` (`providers.<id>.{baseUrl, api: "openai-completions"|…, apiKey: "$ENV"|"!cmd", models[]}`, plus `modelOverrides`).

## B8. Programmatic control
- RPC: `pi --mode rpc [--no-session]`.
  - JSONL commands: `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_messages`, `set_model`, `set_thinking_level`, `compact`, `set_auto_compaction`, `set_auto_retry`, `bash`, `get_session_stats`, `fork`, `clone`, `switch_session`, `get_last_assistant_text`, `export_html`, `get_commands`.
  - Responses are matched to commands by `id`. The `prompt` response means "accepted"; wait for `agent_settled`.
  - There is an extension-UI subprotocol.
  - TypeScript client: `RpcClient` with `promptAndWait()`.
- SDK: `createAgentSession({cwd, sessionManager, agentDir…})`, `session.prompt()`, `getLastAssistantText()`, `AgentSessionRuntime.fork()`.
- ACP: not native. Only third-party adapters exist (e.g. `ExMCP.ACP.Adapters.Pi`, https://hexdocs.pm/ex_mcp/ExMCP.ACP.Adapters.Pi.html).
- Rebrandable fork via `package.json` `piConfig.{name, configDir}`.

## B9. Prompt customization
- `--system-prompt <text|file>` replaces the prompt entirely.
- `--append-system-prompt <text|file>` is repeatable.
- `SYSTEM.md` / `APPEND_SYSTEM.md` as above.
- Extensions can rewrite the full transcript or system prompt (`context_with_system`, `before_provider_request`).
- Net effect: pi gives the user **full control** of the instructions, the most of any harness here.

## B10. Auth, limits, pitfalls
- Subscription OAuth through `/login` (stored in `auth.json`). It includes "Sign in with ChatGPT" (`openai-codex` provider), GitHub Copilot device code, and Anthropic.
  - The `warnings.anthropicExtraUsage` setting shows that pi itself warns Anthropic subscription use may bill paid extra usage. Treat third-party use of a subscription as a policy and billing risk; prefer API keys for long runs.
  - Sign-in is interactive, and OAuth callbacks fail on headless machines unless the redirect URL is pasted. Do the login once, then reuse `auth.json`.
- Retry: `retry.maxRetries` (3), `retry.provider.*`, `httpIdleTimeoutMs` (300000).
- Telemetry: `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`.
- Long-run pitfalls:
  - JSON mode exits 0 on model failure.
  - Stdout backpressure.
  - Silent trust skipping.
  - `--session <id>` resumes in a different cwd.

---

# Adapter implications (orchestrator)

**dsh adapter**
- Command:
  `DSH_HOME=<proj>/.engine/dsh DSH_TELEMETRY_MODE=DISABLED dsh --profile headless --json --permission-mode workspace-write --approval-policy never [--session-id <id>] --patch <run.patch.yml> - < task.md`
  Set cwd to the novel workspace (with a `.git` root).
- Per-run `run.patch.yml`:
  - `agent-default-model` with provider, model, and reasoningEffort.
  - `system-prompt` with personaPrefix/personaSuffix for the writer persona.
  - `session-log-deepseek` with `enabled: false`.
  - Optionally `agent-instructions` with `maxBytes` raised, and extra candidate names.
  - Write **complete** row configs, because patches replace whole rows.
- Parse NDJSON:
  - Take `session.sessionId` and persist it.
  - Sum `status.step_end.usage`.
  - Success = exit 0 and `final.reason.kind=="completed"`.
  - An `error` event or a missing `final` means failure.
- Watchdog: there is no heartbeat, so use a wall-clock plus idle timeout that `status` events reset.
- Instructions: write a generated `AGENTS.md` at the workspace root. Optional per-genre overlay: `AGENTS.local.md`. Optional global: `$DSH_HOME/AGENTS.md`.
- Treat event text as lossy (8 KiB cap). Chapter content must come from files the agent wrote, verified on disk.

**pi adapter**
- Command:
  `PI_CODING_AGENT_DIR=<proj>/.engine/pi PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 pi --mode json --approve --model <provider/id> --thinking <lvl> --session-id <deterministic-id> --tools read,write,edit,grep,find,ls[,bash] [--append-system-prompt <file>] -- "<task>"`
  `--session-id` both creates and resumes the session.
- Parse JSONL with an LF-only splitter:
  - Usage from the last `message_end` / `message_update.usage`.
  - Done on `agent_settled`.
  - Failure on `stopReason` in {`error`, `aborted`, `length`}, or `agent_settled.aborted`, or nonzero exit.
- For a long-lived engine, prefer `--mode rpc`: `prompt`, wait for `agent_settled`, then `get_session_stats`.
- Instructions: `AGENTS.md` in the workspace, or `AGENTS.override.md` per directory. Use `--system-prompt <file>` for full replacement, or `SYSTEM.md` / `APPEND_SYSTEM.md` in the isolated agent dir.
- Hooks for the orchestrator: a bundled extension (`-e`) can implement write-path guards (`tool_call` block outside the novel directory) and completion checks (`agent_before_settle` continuation).
- Isolation: pi has no sandbox, so run it in a container or a dedicated user, with the novel directory as the only writable mount.

**Common gotchas for both**
- Both resume only within the same cwd. Keep one stable workspace per novel.
- Kill a run only after its process has exited, then resume.
- Per-project `DSH_HOME` / `PI_CODING_AGENT_DIR` isolate credentials and sessions.
- Neither emits a per-token text stream in a form suitable for capturing the manuscript, which matches the "agent writes files" design.
- dsh can also act as an orchestrator, delegating to Claude Code or Codex subagents. pi can be embedded in-process via its TypeScript SDK if the orchestrator is written in Node.

The cloned repo and the unpacked package are at `<scratch>/dsh/repo` and `<scratch>/pi/package`.

Sources:
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness docs](https://deepseek-harness.github.io/deepseek-harness/)
- [eesel: DeepSeek Harness explained (de)](https://www.eesel.ai/de/blog/deepseek-harness-erklaert)
- [dsh-sub-cli](https://github.com/dingminhua/dsh-sub-cli)
- [mer.vin: DeepSeek Harness desktop app](https://mer.vin/news/deepseek-harness-desktop-app-install-plugins-cordis/)
- [yinshuo-thu/deepseek-cli](https://github.com/yinshuo-thu/deepseek-cli/wiki)
- [Venompool888/deepseek-cli](https://github.com/Venompool888/deepseek-cli)
- [pi 1.5.0 docs (jsdelivr)](https://cdn.jsdelivr.net/npm/@earendil-works/pi-coding-agent@1.5.0/docs/cli.md)
- [pi 0.73.1 README](https://cdn.jsdelivr.net/npm/@mariozechner/pi-coding-agent@0.73.1/README.md)
- [eesel: Pi coding agent explained](https://www.eesel.ai/blog/pi-coding-agent)
- [ExMCP ACP Pi adapter](https://hexdocs.pm/ex_mcp/ExMCP.ACP.Adapters.Pi.html)
- [learnblockchain.cn pi RPC article](https://learnblockchain.cn/article/27118)
