
# Subscription headless use, nested sandboxes and arm64 support for the five harnesses (checked 2026-11-08)

Where this comes from:
- The existing reports in `docs/v2/research/`.
- Official docs and third-party pages, cited inline.
- Local checks on this host (aarch64, kernel 6.12 Debian 13): ELF headers, `agy models`, and a `dsh` install plus headless run.
- The Proxmox kernel build rules in `git.proxmox.com/pve-kernel.git`.

Confidence: **H** = official doc or verified locally, **M** = official but incomplete, or consistent third-party reports, **L** = single or conflicting third-party source.

## 1. Using a subscription for unattended / headless runs

### (a) Claude Code: Pro/Max/Ultra, `claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`, `claude -p`
- **Documented for headless.** "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`." **H**
  - It needs a Pro, Max, Ultra, Team or Enterprise plan.
  - The token can only make model requests: no Remote Control and no claude.ai connectors. Locally configured MCP still works.
  - `--bare` does **not** read the token.
  - `ANTHROPIC_API_KEY` outranks the OAuth token, and in `-p` mode it is always used when present. That silently switches billing to the API.
  - Source: https://code.claude.com/docs/en/authentication
- **Terms.** Source: https://code.claude.com/docs/en/legal-and-compliance **H**
  - Pro/Max/Ultra fall under the Consumer Terms.
  - OAuth is "designed to support ordinary use of Claude Code and other native Anthropic applications".
  - "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - Third-party developers may not "route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users" and may not "collect, store, or intermediate Claude.ai credentials or session tokens".
  - However, it "does not … prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code".
  - So a self-hosted tool that spawns the unmodified `claude` under the user's own token appears to be allowed. Novelist storing or brokering the token, or running at heavy 24/7 volume, is a gray area.
- **Limits.** Source: https://support.claude.com/en/articles/11145838 **H**
  - "Pro and Max plans have a five-hour session limit and a weekly limit."
  - "Ultra plans have a weekly limit, and verified Ultra accounts don't have a five-hour session limit."
  - Max and Ultra also have a separate weekly limit for Fable.
  - The limits are "shared across Claude and Claude Code".
  - On 2026-10-30 "Max 20x" was renamed "Ultra" and "Max 5x" became "Max". **M** (https://www.requesty.ai/blog/claude-max-plans-5-hour-limit-removed)
  - Weekly amounts are not published. Max is about 5× Pro per week and Ultra about 10× Pro. **M**
- **Separate credit for `-p` / Agent SDK.** It was announced for 2026-06-15 and then paused. `-p` and the SDK still draw on the normal plan pool. **M** (consistent secondary reports, e.g. https://www.agenticwire.news/article/claude-agent-sdk-200-credit-dev-guide, https://claudefa.st/blog/guide/development/agent-sdk-credit)
- **Known issue.** In June 2026 a Max account reported setup-token tokens returning 401 "Invalid bearer token" in `-p`. The issue is closed and the fix is unknown. **L** (https://claudeissues.com/issue/65320-setup-token-oauth-token-returns-401-invalid-bearer-token-with-claude-p-on-max-su)

### (b) Codex CLI: ChatGPT Plus/Pro login with `codex exec`
- **Auth.** Source: https://learn.chatgpt.com/docs/auth **H**
  - ChatGPT login is supported. On headless hosts, "prefer device code authentication (beta)" (`codex login --device-auth`), which must be enabled in ChatGPT security settings. Copying `~/.codex/auth.json` is also allowed.
  - OpenAI's guidance: "API keys are still the recommended default for automation". ChatGPT-side access tokens are meant for "trusted scripts, schedulers, and private CI runners" and need an admin grant.
  - There is no explicit ban on running `codex exec` under the subscription, since it is OpenAI's own client.
- **Limits.** Source: https://learn.chatgpt.com/docs/pricing **H**
  - Plus and Standard Business have a 5-hour window, and "weekly limits … may also apply".
  - Estimated local messages per 5 hours on Plus: gpt-6-luna 350–3,000, gpt-6.1-terra 35–285, gpt-6.1-sol 15–160, gpt-6-astra 5–45.
  - "Pro plans currently have no five-hour limit" (Pro costs $100, $200 or $500).
  - Local messages and cloud tasks share one allowance.
  - Once you hit the limit you can buy credits: Luna costs 2.5 / 12.5 credits per 1M input/output tokens, Sol 50 / 250.
- **`gpt-6-luna` exists and works on ChatGPT login.** It is "most efficient model, for focused, high-volume tasks", and it is the current small/cheap model. `gpt-6.1-terra` ("fast and efficient", needs CLI ≥0.159.0) is the step above it. **H** (https://learn.chatgpt.com/docs/models)
  - Enterprise and Edu admins must enable Luna first.
  - `gpt-5.4-mini` left ChatGPT sign-in on 2026-08-31, and `gpt-5.5` on 2026-10-14.
  - One user report says the CLI could not use the "Luna Reserve" allowance after the normal limit ran out (it named `gpt-5.6-luna`). **L** (https://github.com/openai/codex/issues/40939)
  - The local `codex` (0.165.0) is set up with a custom provider, so I could not test Luna on a subscription here.

### (c) Antigravity CLI (`agy`): consumer Google AI Pro/Ultra
- **Exact FAQ wording** (https://antigravity.google/docs/faq). **H**
  - "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service … Such actions can result in suspension or termination of your account."
  - "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows."
  - "Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans."
  - "To use a third-party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key."
  - A web app like Novelist that drives `agy` most plausibly counts as "wrapping … inside third-party … applications".
- **Quota.** Source: https://antigravity.google/docs/plans **H**
  - Pro and Ultra refill every 5 hours until a weekly cap is reached. Free refills weekly.
  - Paid AI credits can cover overage.
  - BYOK does not raise subscription limits.
- **Gemini 3.8 Flash exists.**
  - It is on all plans, including Free. **H** (https://antigravity.google/docs/models)
  - The Gemini API model id is `gemini-3.8-flash`. **H** (https://ai.google.dev/gemini-api/docs/latest-model)
  - `agy models` here (agy 1.5.3) lists the CLI slugs `gemini-3.8-flash-high`, `gemini-3.8-flash-medium` and `gemini-3.8-flash-low`. **H**
  - The same listing shows `claude-sonnet-4-6`, `claude-opus-4-6-thinking` and `gpt-oss-120b-medium`. Those three are removed on 2026-11-18.
  - This account sees no Gemini 4 Argon or Claude 5.5, which fits a Free/Plus tier. Argon and Claude 5.5 need Pro (non-trial for Claude) or Ultra.

### (d) Grok Build: SuperGrok / X Premium+ / "X Subscription" login
- **Headless on a subscription login is documented.** **H**
  - The bundled user guide (`14-headless-mode.md`) says: "For headless use, authenticate with one of: `XAI_API_KEY` (simplest for CI); `grok login --device-auth` … no browser needed on the target machine; `grok login` … If you've previously logged in, cached credentials are used automatically."
  - It also documents mounting `~/.grok` read-only in containers with a pre-populated `auth.json`.
  - A cached OAuth login outranks `XAI_API_KEY`.
  - Source: https://docs.x.ai/build/cli/headless-scripting and the bundled guide.
- **No explicit xAI ban or permission** on running headless under a subscription was found. The xAI ToS page returned 403 to my fetch. **M**
- **Limits.** One shared weekly pool covers Chat, Imagine, Voice and Build. No numbers are published; `grok usage --json` shows the plan's limit. Paid plans can buy extra credits. **M/L** (third-party, e.g. https://www.roborhythms.com/is-supergrok-worth-it/)
- **Prices and plan names (third-party).** **L**
  - SuperGrok about $30, SuperGrok Plus about $100, Premium+ about $40.
  - The "X Subscription" reportedly replaced SuperGrok for new customers on 2026-10-12.

### (e) DeepSeek Harness (`dsh`)
- **There is no official DeepSeek subscription or coding plan. It is API key only, prepaid pay-as-you-go.** **H/M**
  - In headless mode, auth is `DEEPSEEK_API_KEY`. Account sign-in exists only in the GUI and is disabled in headless (repo docs, existing report).
  - The "DeepSeek coding plans" at deepseekv4pro.com are an unofficial reseller.
- **Models.** `deepseek-flash` is served by DeepSeek-V4.1-Flash-1017; the other is `deepseek-v4-pro`. **H** (https://api-docs.deepseek.com/quick_start/pricing)
- **Prices are very low but come only from third parties.** I could not get the official table to render. **M/L**
  - Flash: about $0.30 per 1M cache-miss input tokens, $1.20 output, about $0.006 cache-hit (https://benchlm.ai/deepseek/api-pricing).
  - Another source gives $0.15 / $0.60 off-peak, doubling at peak.
  - V4 Pro: about $1.32 input / $3.96 output.
  - A 3,000-字 chapter run costs roughly cents.
- **Privacy.** `session-log-deepseek` upload is ON by default; disable it.

### (f) Claude Code Haiku model slug
- **`claude-haiku-5-5` (alias `haiku`) is current.**
  - It needs Claude Code ≥2.1.293.
  - The docs say "It runs with a 1M-token context window on every plan", so it is available on subscriptions. **H** (https://code.claude.com/docs/en/model-config)
  - Thinking cannot be turned off; the default effort is medium.
  - Prompts over 100K tokens cost more per token.
  - The earlier research ran a real `claude -p` with it (2.1.319).
  - On Bedrock, Vertex and Foundry, `haiku` still resolves to `claude-haiku-4-5`.

## 2. Harness sandboxes inside Docker inside an unprivileged LXC on Proxmox

**Which sandbox each harness uses**
- Claude Code: bubblewrap + socat.
- Codex: bubblewrap; it needs unprivileged user namespaces and uses its built-in helper if `bwrap` is absent.
- dsh: bwrap or Landlock.
- Grok: Landlock for the whole process; kernel-level read-deny needs bwrap.
- agy: "Linux namespaces".

**Docker's default seccomp profile is the main blocker for bwrap.** **H**
- I checked `moby/profiles` `seccomp/default.json`.
- `unshare`, `setns`, namespace-flag `clone` and `clone3` are allowed only with `CAP_SYS_ADMIN`.
- So bwrap fails with "No permissions to create new namespace" unless the container runs with `--security-opt seccomp=unconfined` or a custom profile that allows `unshare` and `clone(CLONE_NEWUSER)`.
- Supporting reports:
  - Codex in containers: openai/codex #16018 and #17969.
  - Railway: https://station.railway.com/questions/codex-sandbox-fails-bubblewrap-cannot-c-71a2988d
  - Microsoft mxc #1494: https://github.com/microsoft/mxc/issues/1494

**Docker masks `/proc` paths, so bwrap can't mount a fresh `/proc`.** **H/M**
- Claude Code's docs say: "In an unprivileged container, bubblewrap can't mount a fresh `/proc` … `Can't mount proc on /newroot/proc`". The fix there is `sandbox.enableWeakerNestedSandbox: true` (https://code.claude.com/docs/en/sandboxing).
- The Docker-level alternative is `--security-opt systempaths=unconfined`.
- Claude's sandbox also needs `allowNestedUserNamespaces` (≥2.1.305) for nested `unshare`.
- Claude falls back to running unsandboxed unless `sandbox.failIfUnavailable: true` is set.
- Even with seccomp and AppArmor unconfined, one report shows Claude's `apply-seccomp` failing on `/proc/self/setgroups` inside Docker. **L** (https://claudeissues.com/issue/48304-bug-sandbox-fails-inside-docker-containers-nested-user-namespace-in-apply-seccom)

**The LXC layer**
- Docker in an unprivileged LXC needs `features: nesting=1,keyctl=1`; `fuse=1` is optional. **H**
- Bwrap/flatpak in a Proxmox 8 LXC failed with "`cannot open /proc/sys/user/max_user_namespaces: Read-only file system`" even with nesting, and the thread was never resolved. **M** (https://discuss.linuxcontainers.org/t/bwrap-and-flatpaks-inside-proxmox-8-lxc/18871)
  - That error comes from bwrap's `--disable-userns` path, which flatpak uses. Plain bwrap without that flag may be fine. This is my inference.
- In Nov 2025, containerd 1.7.28-2 / runc broke Docker in LXC with "open sysctl net.ipv4.ip_unprivileged_port_start … permission denied". A forum post says PVE 9.1 fixed it (runc #4968, PVE bug 7006). **M** (https://forum.proxmox.com/threads/docker-inside-lxc-net-ipv4-ip_unprivileged_port_start-error.175437/)
- A PVE 9.0 write-up (kernel 6.14) claims unprivileged LXC with Docker 29 is a hard limit. It recommends `features: nesting=1,keyctl=1,fuse=1`, `lxc.apparmor.profile: unconfined` and `lxc.cap.drop:` in a **privileged** container, and warns that this is host-root equivalent. **L/M**, and it conflicts with the 9.1 fix above. (https://dev.to/mattercoder/docker-on-proxmox-lxc-what-actually-works-and-why-unprivileged-doesnt-45km)
- AppArmor: Proxmox's `nesting=1` replaces the custom AppArmor profiles. In an unprivileged LXC, Docker usually cannot load `docker-default` (`/sys/kernel/security/apparmor` is not writable), so seccomp, not AppArmor, is what blocks bwrap. **M**

**Landlock on the Proxmox kernel is compiled in but not active by default.** **H**
- The Ubuntu kernel config sets `CONFIG_SECURITY_LANDLOCK=y` and `CONFIG_LSM="landlock,lockdown,yama,integrity,apparmor"` (Ubuntu noble annotations).
- The Proxmox kernel overrides this with `--set-str CONFIG_LSM lockdown,yama,integrity,apparmor` on the `bookworm-6.8`, `bookworm-6.11` and `bookworm-6.14` branches and on `master` (git.proxmox.com pve-kernel `debian/rules`).
- On PVE kernel 6.17.4, dmesg shows "landlock: Disabled but requested by user space". **H** (https://forum.proxmox.com/threads/pve-landlock-support.178850/)
- To enable it, add `lsm=landlock,lockdown,yama,integrity,apparmor` to the host kernel command line and reboot.
- Proxmox staff (Jan 2026): stacking AppArmor and Landlock "is in theory supported but might not work well in practice".
- Once enabled on the host, Landlock does work inside Docker and LXC:
  - It needs no privileges or namespaces.
  - Docker's default seccomp profile explicitly allows `landlock_create_ruleset`, `landlock_add_rule` and `landlock_restrict_self` (verified).
- When Landlock is missing:
  - Grok "logs a warning and continues without enforcement" (bundled `18-sandbox.md`). Its sandbox needs kernel ≥5.13, and truncate protection needs ABI v3 (kernel ≥6.2).
  - dsh prints `landlock-run: partial enforcement` on older ABIs.
- Proxmox VE itself ships for amd64 only. That is from my own knowledge and only community ARM ports exist, so the arm64 question only matters for ARM hosts or developer machines.

## 3. linux-arm64 availability

| Harness | linux-arm64 | Evidence |
|---|---|---|
| claude | Yes | Native binary `~/.local/share/claude/versions/2.1.319` is an aarch64 ELF on this host. **H** |
| codex | Yes | npm `@openai/codex` ships `@openai/codex-linux-arm64` (vendor `aarch64-unknown-linux-musl`); 0.165.0 runs here. **H** |
| agy | Yes | `~/.local/bin/agy` 1.5.3 is an aarch64 ELF; `agy models` works. **H** |
| grok | Yes | npm `@xai-official/grok-linux-arm64`; the 1.0.77 binary is an aarch64 ELF and runs. **H** |
| dsh | Yes | Node package (Node ≥24.9). `npm i @deepseek-ai/dsh@0.2.2-rc.1` on aarch64 / Node 26 worked; `node-pty` prebuilds include `linux-arm64`; `dsh --profile headless --json` booted and reached the API (got 401 with a fake key). The PyPI wheel is `py3-none-any`. **H** |

## Design implications
1. **Make the auth mode a per-harness user setting.** Each mode should carry a risk label:
   - **cc** (subscription OK): run the unmodified `claude` with the user's own `CLAUDE_CODE_OAUTH_TOKEN`. Never pass `--bare` with it, and always unset `ANTHROPIC_API_KEY` for subscription runs. Keep the token as a worker env secret the user provides, not something Novelist collects through its web UI or stores in its database, because the terms bar third parties from storing or brokering tokens.
   - **codex** (subscription OK): use device-auth, or a copied `auth.json` in a per-project `CODEX_HOME`. OpenAI's own guidance recommends an API key for automation.
   - **grok** (subscription OK, documented): use a device-auth or cached `auth.json` login.
   - **agy** (API key or Enterprise by default): consumer OAuth should be opt-in, with the FAQ "not supported under consumer plans / suspension" warning shown.
   - **dsh**: API key only, which is cheap.
2. **Budget against 5-hour and weekly windows.**
   - Parse each harness's limit events and sleep until reset: cc `rate_limit_event` / `api_retry`, codex `usageLimitExceeded` / 429, agy and grok quota errors.
   - Run a scheduler that can pause a campaign for days on weekly caps.
   - Note that subscription runs share quota with the user's interactive chat use.
3. **Default cheap-tier models**, all checked to exist today:
   - cc: `claude-haiku-5-5`.
   - codex: `gpt-6-luna`, with `gpt-6.1-terra` as the step up.
   - agy: `gemini-3.8-flash-{low,medium,high}`.
   - dsh: `deepseek-flash`.
   - grok: default `grok-4.5`.

   Check slugs at worker start (`agy models`, codex model list), because Claude 4.6 and GPT-OSS leave agy on 2026-11-18 and Codex retires models often.
4. **On Proxmox, don't rely on harness sandboxes inside Docker-in-LXC.**
   - Make the outer container the boundary: one disposable container per run, a non-root user, only the book workspace writable, credentials mounted read-only.
   - Run each harness in its bypass/yolo mode: codex `--dangerously-bypass-approvals-and-sandbox`, cc `bypassPermissions` (non-root), agy `--dangerously-skip-permissions`, grok sandbox off with `--yolo`, dsh `danger-full-access`.
   - Check the output files yourself rather than trusting exit code 0.
5. **Optional nested-sandbox mode**, documented as advanced:
   - Run the worker container with `--security-opt seccomp=<profile allowing unshare/clone NEWUSER>` (or `unconfined`), `apparmor=unconfined` and `systempaths=unconfined`.
   - On cc, set `enableWeakerNestedSandbox` plus `failIfUnavailable: true`.
   - The LXC needs `nesting=1,keyctl=1` on PVE ≥9.1.
   - Landlock-based sandboxes (grok, dsh) only enforce if the host boots with `lsm=landlock,…`.
   - Recommend a Proxmox **VM** rather than an LXC when harness sandboxes are wanted.
6. **Add a startup probe** that records the result in the UI, since several harnesses fall back to no sandbox without failing:
   - `bwrap --unshare-all --ro-bind / / true` as the run user.
   - A Landlock ABI check (`landlock_create_ruleset` version), or read `/sys/kernel/security/lsm` on the host.
7. **Build a multi-arch worker image** (`linux/amd64,linux/arm64`) containing all five CLIs, pinned. All five have arm64 Linux builds, and CI already builds both architectures.
   - Pin versions and turn off auto-update: `DISABLE_AUTOUPDATER=1`, `GROK_DISABLE_AUTOUPDATER=1`, and pinned agy and codex versions.
   - dsh needs Node ≥24.9 in the image.
8. **Turn off dsh telemetry and session-log upload** in the generated patch: `DSH_TELEMETRY_MODE=DISABLED` and `session-log-deepseek` set to `enabled: false`.

Local artifacts:
- `<scratch>/dsharm/` (dsh arm64 install and test)
- `<scratch>/moby_seccomp.json`
- `<scratch>/pveopts.txt`
