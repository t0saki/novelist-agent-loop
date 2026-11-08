
# Antigravity CLI (`agy`): research report for the Novelist 2.0 multi-harness orchestrator

Research date: 2026-11-08. The latest CLI version visible in the official CHANGELOG is **1.5.3**. 1.5.0 shipped about 4 days after 1.4.12, which was released 2026-10-30. Most facts come from official docs on antigravity.google and the official GitHub repo. Anything taken from a third party or inferred by me is marked [3rd-party] or [inference].

---

## 0. Answer to the framing question: agy vs Gemini CLI

- **"agy-cli" is Antigravity CLI.** The binary is `agy`. It was announced at Google I/O on 2026-05-19 and is the official successor to Gemini CLI for individual accounts ([The Register](https://www.theregister.com/ai-ml/2026/05/20/bye-bye-gemini-cli-google-nudges-devs-toward-antigravity/5243605)).
- **Cutoff date.** On **2026-06-18** Gemini CLI stopped serving free, Google AI Pro and Google AI Ultra individual accounts ([gemini-cli discussion #28017](https://github.com/google-gemini/gemini-cli/discussions/28017)).
- **Who can still use Gemini CLI.** Gemini Code Assist Standard/Enterprise licensees and API-key users (Gemini API and Vertex). The README now says Gemini CLI is "Not optimized for Gemini 4+" and points those users to `agy` ([gemini-cli README](https://github.com/google-gemini/gemini-cli)).
- **Gemini CLI status.** It is still Apache-2.0 and still releases weekly; a tracker shows v0.63.0 on 2026-10-06 [3rd-party: havoptic]. It is now a legacy, API-key-only path.
- **Migration.**
  - The `agy` installer detects `~/.gemini` from Gemini CLI and copies skills, MCP configs, agent profiles and `GEMINI.md` compatibility (#28017).
  - `agy plugin import gemini` converts `~/.gemini/extensions/` into plugins. `agy plugin import claude` does the same for `~/.claude/plugins/` ([Plugins](https://antigravity.google/docs/plugins?tab=cli)).
- **What carried over from Gemini CLI:** `-p`, `--output-format json|stream-json`, `GEMINI.md`, and the `~/.gemini/` tree.
- **What changed:**
  - `--yolo` and `--approval-mode` are gone. They are replaced by `--dangerously-skip-permissions` and `--mode`.
  - `--resume` is gone. It is replaced by `--conversation <id>` and `-c`.
  - `--experimental-acp` is gone. It is replaced by the `agy acp` subcommand.
  - Extensions are replaced by plugins.
  - `@file` imports in `GEMINI.md` are replaced by the `@[label](path)` syntax.
  - Settings now live in `~/.gemini/antigravity-cli/settings.json`.
- **Recommendation:** target `agy` only. Keep Gemini CLI as an optional legacy adapter for API-key users at most.

## 1. Identity

| Item | Fact |
|---|---|
| Name / vendor | "Antigravity CLI", Google. It shares its core engine and settings with the Antigravity 2.0 desktop app ([repo](https://github.com/google-antigravity/antigravity-cli)) |
| Install | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` (macOS/Linux)<br>`irm https://antigravity.google/cli/install.ps1 \| iex` (Windows)<br>Installer flags: `--skip-aliases`, `--skip-path` ([install](https://antigravity.google/docs/install?tab=cli)) |
| Binary | `agy`, a single Go binary [3rd-party]. Check with `agy --version`. Subcommands include `models`, `agents`, `acp`, `plugin {install,list --json,enable,disable,uninstall,validate --strict,import}` and `mcp {add,remove,list,enable,disable}` |
| License | Proprietary, under the [Antigravity terms](https://antigravity.google/terms). The GitHub repo is public but only holds the issue tracker, CHANGELOG.md and examples; no LICENSE is shown and there is no source |
| Release cadence | Very fast: about 21–23 releases per month [3rd-party: havoptic, releasealert]. Pin the version and re-check behaviour on upgrades |
| Related products | **Antigravity SDK** for Python (`pip install google-antigravity`, Apache-2.0). It wraps a bundled, compiled runtime ([SDK repo](https://github.com/google-antigravity/antigravity-sdk-python), [docs](https://antigravity.google/docs/sdk/overview/))<br>**Gemini API "Antigravity Agent"**: a managed cloud agent, `agent="antigravity-preview-09-2026"`, called through the Interactions API ([AI Studio docs](https://aistudio.google.com/docs/antigravity-agent)) |

## 2. Headless mode

Source: [Headless docs](https://antigravity.google/docs/cli/headless) and [CLI reference](https://antigravity.google/docs/cli/reference/).

**Flags**

| Flag | Meaning |
|---|---|
| `-p` / `--print` / `--prompt "<text>"` | Run one prompt and exit |
| `--output-format text\|json\|stream-json` | `stream-json` was added in 1.1.8 |
| `--input-format stream-json` | Read NDJSON prompts on stdin (added 1.1.15) |
| `--json-schema <schema-string\|file.json>` | Enforce structured output |
| `--print-timeout <dur>` | Default `0s` means no limit. The default was 5 min before 1.2.6; 1.5.0 removed a hidden 30-min cap |
| `--disable-slash-commands` | Do not expand `/` prompts |
| Also | `--model`, `--effort`, `--agent`, `--add-dir` (repeatable), `-c`, `--conversation <id>`, `--mode`, `--sandbox`, `--dangerously-skip-permissions`, `--log-file`, `--project`, `--new-project` |

**Output streams.** The response goes to stdout. Errors, progress and permission notices go to stderr.

**JSON envelope**

```json
{"conversation_id":"<uuid>","status":"SUCCESS","response":"...","duration_seconds":7.16,"num_turns":1,
 "usage":{"input_tokens":10415,"output_tokens":657,"thinking_tokens":616,"cache_read_tokens":8113,"total_tokens":11072}}
```

- Optional fields: `error`, `structured_output`, `json_schema`.
- `finished_reason` was added in 1.4.11. Values are `print_timeout`, `interrupted` or `error`.

**stream-json events.** NDJSON, one event per line, keyed by the `event` field:
- **`init`** (once): `cwd`, `tools`, `permission_mode` (`request-review` or `always-proceed`), plus `model`, `agent` and `json_schema` when set.
- **`step_update`** (repeated):
  - Fields: `conversation_id`, `step_index`, `state` (`ACTIVE` or `DONE`), `step_type` (`user_input`, `agent_response`, `tool`, `checkpoint`), `tool_name`, `text_delta`, `duration_seconds`, `usage`, `tool_info`, `subagent_info`.
  - `tool_info` holds `name`, `parameters`, `output`, and `error{type,message}` on failure.
  - `subagent_info` holds `type_name`, `role`, `conversation_id`, `log_uri`, `workspace_uris`.
- **`result`** (once per turn): same shape as the JSON envelope.

**Status values:** `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`, `WAITING` (ended while waiting on input), `RUNNING`.

**Exit codes** (from the docs and CHANGELOG):

| Code | When |
|---|---|
| `0` | Success, **and also when a tool approval was soft-denied** (the run continues; stderr names the tool) |
| `1` | Unknown `--model` (no fallback), unmatched `--agent` (1.3.4), invalid `--json-schema` (1.2.14), malformed stream input |
| `2` | `--print` combined with `-i`; stream control messages or CLI-handled slash commands sent in stream mode |
| `3` | Model or agent error mid-stream (1.2.6/1.2.10), or `--print-timeout` hit (1.5.0, which also prints an `AGY_ERROR` line on stderr) |
| non-zero | A `PreInvocation` hook `errorMessage` (1.4.11) |

**Cost.** There is no cost field, only token `usage`. Compute cost yourself from the model's pricing. On subscription auth, usage draws on plan quota.

## 3. Sessions

- **Stateless by default.** Continue with `-c` (most recent) or `--conversation <conversation_id>` in a new process.
- **Multi-turn in one process.** Use `--input-format stream-json --output-format stream-json`.
  - Write lines like `{"event":"user","message":{"content":"..."}}` to stdin. Only text blocks are allowed.
  - Each turn emits its own `result`. `usage`, `num_turns` and `duration_seconds` are cumulative.
  - Close stdin to end; the process exits 0.
  - Pitfall: waiting for the process to exit before reading stdout deadlocks, because the session stays open until stdin closes.
- **Fork, rewind, resume.** These are interactive slash commands: `/fork [project_id]`, `/rewind` (or `/undo`), `/resume`. The CLI has no fork flag.
- **ACP.** Supports `session/resume` without replaying history (1.5.0). Each session keeps its own model and thinking level.
- **Compaction** is automatic. `/compact` was added in 1.3.5. Compaction keeps attachments (1.4.6), fixes looping re-compaction (1.4.7), and subagents keep their task after compaction (1.4.10).
  - No setting for the threshold or window size is documented.
  - The managed cloud agent compacts at about 135k tokens; the CLI's threshold is not published.
- **Context size** per model is undocumented. `/context` shows usage.
- **Storage.** Conversation history lives in a local database (CHANGELOG 1.2.9). Hooks receive `transcriptPath` (a `transcript.jsonl`) and `artifactDirectoryPath`.

## 4. Instruction files ("rules")

Sources: [Rules](https://antigravity.google/docs/rules?tab=cli) and [Customization discovery](https://antigravity.google/docs/customization-discovery).

**Workspace and parent folders**
- `AGENTS.md` or `GEMINI.md`
- `.agents/AGENTS.md` or `.agents/GEMINI.md`
- `.agents/rules/*.md`, plus legacy `.agent/rules/`. Legacy folder names `_agents/` and `_agent/` are also recognized.

**Global**
- `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md`, `~/.gemini/config/GEMINI.md`
- `~/.gemini/config/rules/*.md`
- Plugin rules: `~/.gemini/config/plugins/<p>/rules/`

**Not documented as loaded:** `CLAUDE.md`, `~/.agents/`, `.claude/`. The only Claude bridge is `agy plugin import claude`.

**Lookup**
- Rules are read from the workspace folder and each parent up to the repo root (the folder containing `.git`). With no git repo, only the workspace folder is read.
- **Subfolders below the workspace are never read.**
- The workspace is the folder where `agy` starts plus any `--add-dir` folders.
- Each folder is scanned one level deep; deeper files need a `rules.json` or `skills.json` manifest (`entries`, `inherits`, `exclude`, `include_only`).

**Precedence**
- Rules accumulate; none replaces another.
- Since 1.4.4 the system prompt states that user `GEMINI.md`/`AGENTS.md` rules override earlier built-in instructions.
- The order between AGENTS.md and GEMINI.md is not documented.
- Same-name skills and agents resolve in this order: per-user folder in the repo (`.gemini/config.json` → `"personal_customization_dir"`) > workspace > `~/.gemini/config/` > built-in. In the CLI, `~/.gemini/antigravity-cli/skills/` and `~/.gemini/skills/` win over all of these.

**Frontmatter**
- `AGENTS.md` and `GEMINI.md` take none; they are always on.
- Files under `rules/*.md` **must** have frontmatter with `trigger: always_on | model_decision | glob | manual`, plus `description` and `globs`. Otherwise they are **silently dropped**.
- The CLI does not support `manual` rule mentions.

**Includes**
- `@[label](path)` inlines the file (relative to the rule file; `~/` expands).
- `@filename` is only rewritten to a canonical path; it does not inline content.

**Limits**
- **24,000 bytes per file**, measured after include expansion; larger files are truncated.
- **20,000 tokens total** for global plus `always_on` rules. Over budget, the largest files are demoted to pointers of the form `- <path>: <description>`.

**Reload.** Rules and skills are reread before each turn. **There is no flag to point at an alternate rules file.**

## 5. Extensibility

All locations below sit under `.agents/` or `~/.gemini/config/`.

- **Skills**
  - `skills/<name>/SKILL.md`, following the agentskills.io standard. Frontmatter: `description` (required), `name` (optional).
  - CLI-only locations: `~/.gemini/antigravity-cli/skills/`, `~/.gemini/skills/`.
  - Each skill becomes a `/skill-name` command. Reload with `/skills reload`.
  - Since 1.5.2, a workspace `skills.json` only loads from inside the repo.
  - Source: [Skills](https://antigravity.google/docs/skills?tab=cli).
- **Custom agents / subagents**
  - Files: `agents/<name>.md` or `agents/<name>/agent.md`.
  - Frontmatter: `name`, `description`, `tools[]`, `mainAgent` (default true), `subagent` (default true), `model` (`inherit|flash|pro`), `commandExecutionPolicy` (`off|auto|eager|sandbox`), `mcpServers[]`, `skills[]`, `plugins[]`, `agents[]` (1.1.27), `permissionMode` (blog).
  - The Markdown body "defines the subagent's system prompt."
  - Select as the main agent with `--agent <name>`; list with `agy agents`.
  - The parent delegates through the `invoke_subagent` tool. Subagents run in parallel, start with clean context, nest at most 10 deep, and inherit sandbox and file scopes.
  - Known issue: a misspelled tool name in `tools` can hang the subagent.
  - Sources: [Subagents](https://antigravity.google/docs/subagents?tab=cli), [custom agents blog, 2026-08-12](https://antigravity.google/blog/introducing-custom-agents).
- **Hooks** ([Hooks](https://antigravity.google/docs/hooks?tab=cli))
  - Files: `.agents/hooks.json` or `~/.gemini/config/hooks.json`. A `hooks` key in settings.json is **not** loaded.
  - Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`.
  - Handler: `{"type":"command","command":...,"timeout":30}`. Only the `PreToolUse`/`PostToolUse` handlers sit under a regex `matcher`.
  - Stdin (camelCase): `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`, `lastUserInput`, plus event-specific fields. Examples: `toolCall{name,args}` for tool events; `terminationReason` and `fullyIdle` for `Stop`.
  - `PreToolUse` must return `decision`: `allow`, `auto_approve`, `deny`, `ask`, `force_ask` or `deny_unless_prior_grant`. It can also return `overwrite` (to rewrite tool args) and `permissionOverrides`.
  - `Stop` can return `{"decision":"continue","reason":...}` to keep the agent working.
  - `PostInvocation` can return `terminationBehavior: "force_continue"` or `"terminate"`.
  - `injectSteps` items: `systemMessage`, `userMessage`, `ephemeralMessage`, `errorMessage`.
  - Tool names: `view_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `list_dir`, `find_by_name`, `grep_search`, `search_web`, `read_url_content`, `run_command`, `invoke_subagent`, `define_subagent`, `ask_question`, `generate_image`, and others.
- **MCP client** ([MCP](https://antigravity.google/docs/mcp?tab=cli))
  - Files: `~/.gemini/config/mcp_config.json`, `.agents/mcp_config.json`, or a plugin's `mcp_config.json`. Format: `{"mcpServers":{name:{command,args,env,cwd | serverUrl/url,headers,timeoutSeconds,disabled,enabledTools,disabledTools,authProviderType,oauth}}}`.
  - Transports: stdio and **Streamable HTTP only**. Legacy SSE and `httpUrl` do not work in the CLI.
  - Tools load lazily by default; set `"eager": true` per tool to register it upfront.
  - Default timeouts: 300 s for connect, 180 s per call.
  - Manage with `agy mcp add/...` or `/mcp`.
- **Plugins**
  - A `plugin.json` manifest (also accepted in `.antigravity-plugin/` or `.gemini-plugin/`) bundles skills, agents, rules, MCP and hooks.
  - Workspace plugins: `.agents/plugins/`. Global plugins: `~/.gemini/config/plugins/`.
  - Hook commands get `PLUGIN_ROOT` and `PLUGIN_DATA` (1.5.3).
- **No documented MCP-server mode for agy itself.** Driving it programmatically goes through ACP or headless mode (section 8).

## 6. Permissions and sandbox

Sources: [Permissions](https://antigravity.google/docs/permissions?tab=cli), [Sandbox](https://antigravity.google/docs/sandbox).

- **Modes** (`--mode` or `agentMode`): `default` (request review), `accept-edits`, `plan`, `auto`.
  - `auto` turns on the sandbox; a separate agent reviews commands that leave the sandbox.
  - `auto` is for personal accounts only (1.3.5+ on macOS and Linux, 1.4.4+ on Windows 11 24H2).
- **`toolPermission`:** `request-review` (default), `proceed-in-sandbox`, `strict`, `always-proceed` (the same as `--dangerously-skip-permissions`).
- **Rules** in `settings.json` under `permissions.{allow,ask,deny}`. Precedence is Deny > Ask > Allow.
  - Action types: `command(prefix|regex:...)`, `read_file(path)`, `write_file(path)`, `read_url(domain)`, `execute_url(domain)`, `mcp(server/tool)`, `unsandboxed(...)` (business accounts only).
  - Reading and writing inside the workspace is allowed by default; outside needs approval.
  - Example lockdown: `deny: ["write_file(.git/)","command(*)"]`.
- **Headless.** There are no prompts. An action that needs approval is **soft-denied** and the run continues with exit 0.
  - Since 1.5.2, `-p --dangerously-skip-permissions` still **denies terminal commands and outside-workspace file access that need review**, and blocks system-denylist commands.
  - So in headless mode it is not a full bypass. Workspace file writes still go through.
- **Sandbox** (`--sandbox` or `enableTerminalSandbox`; off by default in the CLI).
  - Implementation: Linux namespaces, macOS Seatbelt, Windows AppContainer.
  - Network is **off by default**; `read_url` allowlisted domains are opened.
  - `~/.ssh`, `.env`, `~/.docker` and `~/.kube` are blocked.
  - Writes are allowed to the workspace, temp dirs and build caches.
  - `sandboxProxy` sets an HTTP proxy for sandboxed traffic.
  - Since 1.4.4, if the sandbox is unavailable the flag silently has no effect. Check the status line or log.
- **Trust.** `trustedWorkspaces[]` lives in settings.json, and 1.5.2 hardened handling of untrusted repos. Pre-trust project dirs to avoid trust gating [inference].

## 7. Models and providers

- **Selection.** Flags `--model <slug>` (list with `agy models`; unknown slugs exit 1) and `--effort low|medium|high` (the reference says up to `max` depending on the model). Setting keys: `model`, and `/effort` interactively.
- **Catalog by plan** ([Models](https://antigravity.google/docs/models)):
  - Gemini 4 Argon: Pro, Ultra, Enterprise.
  - Gemini 3.8 Flash: all plans. Example slug: `gemini-3.8-flash-medium`.
  - Claude Opus 5.5 and Sonnet 5.5: Pro (non-trial), Ultra, Enterprise. They are also available with ADC since 1.3.6.
  - Claude 4.6 models and GPT-OSS-120b: removed on **2026-11-18**.
- **Auth and provider options** ([install/auth](https://antigravity.google/docs/install?tab=cli), [settings](https://antigravity.google/docs/settings?tab=cli)):
  - **Google account.** Uses the OS keyring, with a browser or SSH URL+code flow for sign-in.
  - **Gemini API key.** Set `"modelProvider":"gemini"` in settings and `GEMINI_API_KEY`. `GOOGLE_API_KEY` and `.env` files are **not** read.
  - **ADC / Vertex.** `gcloud auth application-default login` plus `AGY_ADC_AUTH=true`, with optional `GOOGLE_CLOUD_QUOTA_PROJECT` and `GOOGLE_CLOUD_LOCATION`. Settings key `gcp{project,location}`.
  - **Custom Gemini-compatible endpoint.** `GOOGLE_GEMINI_BASE_URL`, plus `customModelsConfig.customModels[{modelName:"gemini-api://<base_url>/models/<model>",label}]`. Enterprise model gateways are also supported.
  - **No OpenAI-compatible endpoint support in the CLI.** The Python SDK does support local OpenAI-compatible servers and LiteRT.

## 8. Driving it from another program

- **Headless + NDJSON.** `-p` with `stream-json`, or a long-lived process with `--input-format stream-json` (section 2). This is the main integration path.
- **ACP.** `agy acp [--login]` is a JSON-RPC Agent Client Protocol server over stdio (1.5.0+; fixes in 1.5.1–1.5.3).
  - It supports session modes, images and `session/resume`, and offers all account models (1.5.1).
  - The method list follows the [ACP spec](https://agentclientprotocol.com).
  - It is the cleanest bidirectional option: streaming updates, permission requests, cancellation.
  - Source: [ACP docs](https://antigravity.google/docs/cli/acp).
- **Python SDK** `google-antigravity`.
  - `Agent(LocalAgentConfig(system_instructions=..., api_key=..., vertex=..., tools=..., mcp_servers=..., capabilities=..., policies=...))`.
  - Streaming: `async for` over the response, plus `response.thoughts` and `response.tool_calls`.
  - Agents start read-only; `CapabilitiesConfig()` enables writes.
  - Auth is API key or Vertex only; no consumer Google sign-in.
  - It is a distinct runtime from the `agy` binary, not a wrapper around it [inference from docs].
- **Managed cloud agent.** `POST https://generativelanguage.googleapis.com/v1beta/interactions` with `agent: antigravity-preview-09-2026`.
  - It runs in a Linux sandbox with a persistent `environment_id`. You can mount `AGENTS.md` and `.agents/skills/`.
  - Budget controls: `max_total_tokens`, `status: "incomplete"`.
  - It supports SSE and `background=True`. Billing is pay-as-you-go. It is in preview.

## 9. Customizing instructions (mechanism only)

- **No `--system-prompt` or `--append-system-prompt` flag.** No settings key for the system prompt is documented.
- **Ways to steer it, strongest first:**
  1. **A custom main agent** (`--agent novelist` with `.agents/agents/novelist.md`). The body "compiles into the agent's system prompt" and the frontmatter limits tools, model and skills. Whether it fully replaces or extends the built-in prompt is **undocumented**. Markdown agents inherit ambient skills, rules and subagents by default (1.1.25).
  2. **Rules** (`AGENTS.md`/`GEMINI.md`). They are declared to override built-in instructions (1.4.4) and share a 20k-token always-on budget.
  3. **Hooks.** `SessionStart`, `PreInvocation` and `PostInvocation` can add `systemMessage`/`userMessage` via `injectSteps`. A `Stop` hook can force continuation.
  4. **The SDK's `system_instructions`.**
- **Content-filter behaviour on API-key auth.** Before 1.5.0, a Gemini API safety-filter block made the CLI retry forever; 1.5.0 fixed that. The orchestrator should treat a filter block as a turn error and not retry it unchanged. No safety-setting knob is documented in the CLI.

## 10. Auth, rate limits and pitfalls for long unattended runs

- **Terms of service: the biggest finding.** The official [FAQ](https://antigravity.google/docs/faq) says:
  - "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service", which can lead to suspension.
  - "Wrapping `agy` inside third-party coding agents or applications … is not supported under consumer plans."
  - Headless mode "is intended for direct scripting and CI workflows."
  - For third-party agents it recommends "a Gemini Enterprise or Google AI Studio API key."
  - A community answer on the forum says orchestration with account auth is fine, but no Google staff member confirmed this and the thread is unresolved ([forum](https://discuss.ai.google.dev/t/is-external-orchestration-of-antigravity-cli-headless-mode-supported-with-account-based-usage/183051)).
  - **For Novelist 2.0, the agy adapter should default to `GEMINI_API_KEY` or ADC/Vertex auth and warn when consumer OAuth is used.**
- **Plan quotas** ([Plans](https://antigravity.google/docs/plans)):
  - Pro and Ultra refill every 5 hours, capped by a weekly limit. Other plans refill weekly.
  - No numbers are published, and limits track agent workload.
  - AI credits can cover overage; `useG1Credits` is the setting.
  - Bringing your own key or endpoint does not raise subscription limits.
- **Retries.** Since 1.5.0 the CLI retries 429 and 5xx with `Retry-After`. Hitting an individual quota is reported immediately (1.3.3). A `GEMINI_API_KEY` daily-quota exhaustion stops the run immediately (1.2.12). Since 1.5.3, requests with no response headers after 60 s are retried; stalled streams are retried after 5 minutes.
- **Hangs.** [Issue #318](https://github.com/google-antigravity/antigravity-cli/issues/318) reports `-p` never completing: no `result` after `init`, or a hang after about 230 tool steps or on resume.
  - It was closed as obsolete on 2026-09-03, but was reported again on 1.2.0, 1.2.3 and 1.4.10 (Linux and Windows), with no fix named.
  - Earlier fixes: hangs on piped stdout (1.1.24), on plan approval (1.1.28), daemons left running (1.2.9), editor prompts from git (1.3.6).
  - **Always set `--print-timeout` and an external watchdog that kills the process group.**
- **Headless needs cached credentials.** Without them the run fails fast with "authentication required". Business accounts had sign-in persistence bugs (1.4.6). Revoked tokens give unclear errors mid-session (1.3.3).
- **Global state is shared.** `~/.gemini/antigravity-cli/settings.json`, global rules and global plugins all leak into every run. There is no `--settings` or `--config-dir` flag.

## 11. Other notes for a multi-harness orchestrator

- **Output files.**
  - `-p` does not generate a title anymore (1.5.2).
  - `--json-schema` gives a reliable machine-readable "receipt" in `structured_output`: the list of files written, a chapter word count and a summary. Use it alongside the files on disk.
- **`--add-dir`** can add a read-only reference dir, such as a shared series bible. Use permission rules to keep it read-only.
- **Remote options.** `--remote-agent` and `--project` run conversations on Google's Remote Agents, which is out of scope for local file workflows.
- **Logs.** Use `--log-file <path>` per run for forensics. `transcriptPath` is available from hooks.
- **Hooks as invariant enforcement:**
  - A `PreToolUse` hook can deny `write_to_file` outside `chapters/` and `bible/`.
  - A `Stop` hook can check that the chapter file exists and meets a length bound, and return `continue` with a reason if not.
- **Fast version churn.** Write a compatibility probe that runs at adapter startup: `agy --version`, then `agy -p "ok" --output-format json`, then check the envelope keys.

---

## Adapter implications

**Auth policy**
- Preferred: `GEMINI_API_KEY` with `modelProvider: "gemini"`, or `AGY_ADC_AUTH=true` with Vertex.
- Consumer OAuth works technically, but the FAQ says wrappers are "not supported under consumer plans". Show this risk to the user in the UI.

**Isolation** [inference]
- Run each agy worker with a dedicated `HOME` (a per-profile dir). That gives each worker its own `~/.gemini/antigravity-cli/settings.json`, `~/.gemini/config/{rules,agents,skills,hooks.json,mcp_config.json}` and no stray global `GEMINI.md`.
- This works cleanly with API-key or ADC auth. Keyring OAuth may not follow a changed HOME.
- Make each novel project its own git repo, so the parent-directory rule search stops at the project root and doesn't pick up AGENTS.md files from enclosing folders.

**Command template (single turn)**

```
cd <project_root> && HOME=<profile_home> GEMINI_API_KEY=... \
setsid agy -p "<turn prompt: task + file paths to read/write; 'write output to chapters/0123.md, reply only with JSON receipt'>" \
  --output-format stream-json \
  --json-schema <receipt.schema.json> \
  --model <slug> --effort high \
  --agent novelist-writer \
  [--conversation <id>] \
  --print-timeout 40m \
  --log-file <runs/…/agy.log> \
  [--add-dir <shared_series_bible_dir>]
```

**Permissions**
- Prefer settings-based scoping over `--dangerously-skip-permissions`:
  - `allow: ["write_file(chapters/)","write_file(bible/)","write_file(state/)"]`
  - `deny: ["write_file(.git/)","command(*)"]` (writing needs no shell)
  - plus `agentMode: "accept-edits"`
- Soft-denies exit 0, so parse stderr and step errors.

**Event parsing**
- `init`: record the model, tools and `permission_mode`.
- `step_update`: take `conversation_id` from the first step (`init` lacks it). Use `text_delta` for live preview, `tool_info` to see which files were written (`write_to_file`, `replace_file_content` and so on), and `subagent_info` for fan-out tracking.
- `result`: success means **`status == "SUCCESS"`, no `finished_reason`, the exit code is 0, and the expected files exist and pass validation**. Store `usage`.
- Exit-code mapping:
  - `1` and `2`: config error, don't retry.
  - `3`: model error or timeout, retry with backoff or resume.
  - Non-zero with "authentication required": stop the worker and alert.

**Watchdog**
- Kill the process group if there is no `step_update` for N minutes or the total time exceeds `--print-timeout` plus a margin (the hangs in issue #318).
- Then resume with `--conversation <id>`, or restart the chapter from file state. Resume itself has been reported to hang.
- Make every turn idempotent: rewrite a whole file rather than appending.

**Resume and long runs**
- Keep sessions short-lived, roughly one chapter or one planning step per conversation.
- Rebuild context from files on disk (bible, outline, rolling summaries) instead of relying on compaction, which has opaque thresholds.
- Use `--input-format stream-json` only for short multi-turn exchanges, such as a write → self-review → fix loop. Read stdout incrementally.

**Instruction-file injection**
- The orchestrator renders `<project>/AGENTS.md` from the user's custom template, kept under 24 KB and inside the 20k-token always-on budget. It holds the global writing contract, the file layout, and the rule "output goes to files; final message is a JSON receipt".
- Large bible material goes in `.agents/rules/*.md` with `trigger: model_decision` or `glob` frontmatter. Frontmatter is **mandatory**, or the file is silently dropped. Bulk canon should stay as plain files the prompt references by path.
- Each role is a custom agent (`.agents/agents/<role>.md`): writer, continuity checker, summarizer, with a tool allowlist and `model`. Select it with `--agent`.
- Skills go in `.agents/skills/<name>/SKILL.md`, which is the same format as Claude Code and Codex skills, so they can be shared across harnesses. Use symlinks or copies, since `.claude/skills` is not read.
- `CLAUDE.md` is **not** read. Generate `AGENTS.md`, or symlink `GEMINI.md` to `AGENTS.md`.

**Hooks for invariants**
- Ship `.agents/hooks.json`:
  - `PreToolUse` with matcher `write_to_file|replace_file_content|multi_replace_file_content|run_command`: return `deny` for paths outside the allowed dirs.
  - `Stop`: verify the deliverable and return `{"decision":"continue","reason":"chapters/0123.md missing or < N chars"}`.
- The hook timeout defaults to 30 s.

**Further gotchas**
- No system-prompt flag exists; persona control goes through `--agent` and rules.
- `GOOGLE_API_KEY` and `.env` are ignored.
- MCP must be stdio or Streamable HTTP; SSE does not work.
- An unknown model slug exits 1. Probe with `agy models` and handle the 2026-11-18 model removals.
- `--sandbox` silently does nothing when unsupported.
- `auto` mode is unavailable for business accounts.
- Treat a Gemini safety-filter block as a hard turn error.
- Pin the agy version per release channel; it releases every 1–2 days.
- A Gemini CLI legacy adapter is only worth adding if the user has API-key or Code Assist access.
