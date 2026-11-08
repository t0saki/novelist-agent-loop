# Novelist v1 Infrastructure Audit: what to keep, redesign or drop for 2.0

Repo: 仓库根目录 (9 commits, all dated 2026-07-15, about 6.6k LOC). Backend: FastAPI, sync SQLAlchemy 2.0, SQLite or Postgres. Frontend: React 18, Vite, TS. It ships as a single container.

I ran the test suite: `uv run pytest` passes, 14 tests in 2.5s, all on the mock LLM. Afterwards I deleted the `.venv` and cache directories the run created, so the working tree is clean.

This report covers v1 only. I did no web research, so it makes no claims about harness features. Harness facts need separate verification.

---

## 1. Scheduler

**Files:** `server/app/scheduler/scheduler.py`, `server/app/scheduler/ratelimit.py`, `server/app/pipeline/engine.py`

### Shape
- One `asyncio` loop runs inside the FastAPI process. `main.py` starts it in `lifespan`.
- It ticks every `NOVELIST_SCHEDULER_TICK_SECONDS`, default 20s.
- All decisions are made from DB state, so a restart is idempotent.
- `Scheduler.running: dict[job_id, asyncio.Task]` holds the in-process slots.

### What one tick does
1. **Reap finished tasks.**
2. **Watchdog (`_reap_stale_running`).**
   - Finds every DB job with `status=running` that has no live task.
   - Increments its `attempts`. Below `max_job_attempts` (default 3) it goes back to `queued`; at the limit the job and its novel become `failed`.
3. **Stop early** if the global `scheduler_paused` setting is on.
4. **Compute capacity** as `concurrency` (a DB setting, default 1) minus the number of running tasks.
5. **Pick runnable jobs (`_runnable_jobs`).**
   - Candidates are `queued` or `paused` jobs.
   - A `paused` job is eligible only when neither the per-book budget nor the daily budget is exceeded.
   - Sort key: `(0 if novel.status==writing else 1, -priority, id)`. Unfinished serials go first, then priority (manual creation uses priority 5, cover jobs 1), then FIFO.
6. **Auto-create new books** while capacity is left, `auto_generate` is on and `can_start_new_book` allows it.
   - `can_start_new_book` checks the book-count windows (`books_per_day` over 24h, `books_per_5h` over 5h; 0 means unlimited) and the daily token budget.
   - `_pick_theme` is a deterministic weighted round-robin: it picks the theme with the lowest `count(novels)/weight`.
   - No enabled theme means no book is created (fix in 9026e1b).

### Budgets
- **Ledger:** `UsageLedger` gets one row per LLM call. `Novel.tokens_total` and `cost_total` are denormalised onto the book.
- **Checks:**
  - `daily_tokens` is a rolling 24h sum, not a calendar day.
  - `per_book_tokens` is compared against `Novel.tokens_total`.
- **When enforcement happens:** only through the `_control` callback, which runs **between chapters** (`stage_writing`, for `index > 1`).
  - It can return `continue`, `pause` (scheduler paused or budget exceeded) or `stop` (shutdown).
  - Planning stages and a chapter already in progress are never stopped. Overshoot is bounded by one chapter plus the planning cost.

### Crash resume
- `Job.stage` is the checkpoint at stage level. `STAGE_SEQUENCE` is ideation → concept → bible → outline → writing → finalize.
- Chapter level: chapters with `status=done` are skipped, and `chapter.scenes` and `content` are committed **after every scene**. However, an interrupted chapter is regenerated from scratch, because the saved scenes are not reused on resume.
- `_recover_orphans()` runs at startup and sets every `running` job back to `queued`.
- Graceful shutdown: `shutdown` is set, the writing loop returns `stopped` at the next chapter boundary, the job goes to `paused`, and `lifespan` waits up to 60s.

### Failure handling
- The engine catches stage exceptions and calls `_record_failure`, which opens a **fresh session** and retries 3 times. It returns `running` if it still cannot write, and the watchdog reclaims the job later.
- `ChatClient` retries each profile 5 times with linear backoff: 1.5s steps normally, 6s steps for 429/5xx, capped at 30s. It then moves down the profile fallback chain.

### Problems it solved (from git log)

| Commit | Problem and fix |
|---|---|
| 754c775 | With `concurrency=2`, two pipelines writing to one SQLite file hit `database is locked`. The exception poisoned the session, so the job's terminal state was never written and it stayed `running` forever; the scheduler only looks at queued/paused jobs. Fixes: watchdog reaper, failure accounting in a fresh session, commit after every scene so the write lock is never held across minute-long LLM calls, `busy_timeout` 10s→30s, regression tests. |
| 9026e1b | `SQLITE_BUSY_SNAPSHOT` (WAL read-then-write conflict between the pipeline and web writes) cannot be fixed by retrying `busy_timeout`. Fix: Postgres via `NOVELIST_DATABASE_URL`. Also fixed deleting a book (child-table foreign keys were violated) and stopped creating theme-less books. Added `scripts/sqlite_to_pg.py` (migration with sequence reset). |
| dd25eaa | Real-model run through a grok / newapi proxy. Forced `stream:false` because some proxies default to SSE. Longer 429 backoff. Bible↔outline character names never overlapped, so character-card injection did nothing; fixed by feeding the bible's authoritative cast list into blueprints. Cold-open prompt. Cover endpoint accepts `?token=`. |
| fc04871 | GHCR multi-arch CI. A hard SFW suffix on cover/illustration prompts. |
| a6f809d | Immersive reader. |
| e27c9b0, de73374, ec5f90b | Docker and compose fixes: copy `pnpm-workspace.yaml`, Postgres as the default, `NOVELIST_PORT`. |

**Lesson for 2.0:** the hard bugs were concurrency between long-running workers and shared mutable DB state, plus lost terminal state. External agent CLIs make this worse: subprocesses run for minutes to hours and can hang or exit non-zero. 2.0 therefore needs lease and heartbeat based job ownership, not an in-memory `running` dict.

---

## 2. Data model

**File:** `server/app/db/models.py`. Tables are created by `create_all`; there are **no migrations**.

| Table | Key fields | Notes |
|---|---|---|
| `settings` | key → JSON | Runtime configuration: `rate_limit`, `token_budget`, `concurrency`, `dedup_threshold`, `scene_floor_ratio`, `max_job_attempts`, `stage_profiles {stage:[profile_ids]}`, `illustration_density`/`illustration_every_n`, `auto_generate`, `scheduler_paused`, `admin_password_hash`. No validation: `PUT /settings` accepts any JSON for whitelisted keys. |
| `llm_profiles` | `kind` (chat/image/embedding), `base_url`, `api_key` (**plaintext**), `model`, `temperature`, `max_tokens`, prices per million tokens, `supports_tools`, `extra` JSON, `is_default` | Stage → profile fallback chain. The UI only sets one profile per stage. |
| `themes` | `name`, `keywords[]`, `style_prompt`, `length_hint` (free text, parsed by substring into short/medium/long/epic), `min_chapters`, `weight`, `nsfw`, `enabled` | |
| `novels` | `slug` (8 hex chars), `title`, `status` (planning/writing/completed/failed/archived), `theme_id`/`theme_name`, `language`, `nsfw`, `premise`, `synopsis`, `tone`, `target_audience`, `planned_chapters`, `target_chapter_words`, `volumes` JSON, **`bible` JSON, `outline` JSON** (with `blueprints{idx:…}`), `rolling_summary` (unused), `quality_debt` JSON, `word_count`, `cover_path`, `illustration_density` (unused), `tokens_total`, `cost_total`, `error`, timestamps | The whole story state lives in JSON blobs: no history, no diffs, no human edits. |
| `chapters` | `(novel_id, index)` unique; `title`, `blueprint` JSON, `scenes` JSON (scene checkpoint), `content` TEXT, `word_count`, `summary`, `status` | |
| `jobs` | `type` (generate/cover), `stage`, `status` (queued/running/paused/done/failed), `priority`, `attempts`, `checkpoint` JSON (only `last_chapter`, never read back), `progress` JSON, `error`, timestamps | No owner, lease or heartbeat columns. |
| `usage_ledger` | `novel_id`, `chapter_id`, `stage`, `profile_id`, `model`, prompt/completion/total tokens, `cost`, `created_at` (indexed) | |
| `reader_passwords` | `label`, `password_hash`, `enabled` | |
| `novel_embeddings` | `vector` as a JSON float array, cosine computed in Python | Used for premise dedup. `sqlite-vec` is a dependency but is never used. |
| `images` | cover / illustration `path` and `prompt` | Illustrations are never served to readers. |
| `reading_progress` | `(reader_id, novel_id)` unique; `chapter_index`, `scroll` | `scroll` is always written as 0. |

---

## 3. API surface and auth

### Auth
**Files:** `server/app/api/auth.py`, `server/app/api/deps.py`, `server/app/core/security.py`

- **Login:** `POST /api/auth/login {password}` takes one password field. It tries the admin hash first, then loops over every enabled reader hash (PBKDF2-SHA256, 200k rounds, stdlib).
- **Tokens:** a stateless HMAC-signed token, `base64(json{role,id,exp}).sig`.
  - TTL is 30 days.
  - The secret comes from `NOVELIST_SESSION_SECRET` or is persisted at `/data/.session_secret`.
- **Roles:**
  - `admin` has full access.
  - `reader` (identity `reader:{id}`) is read-only. Each reader password gets its own `ReadingProgress`; admin's identity is `"admin"`.
- **First run:** if `NOVELIST_ADMIN_PASSWORD` is unset, a random admin password is generated and printed to the logs.
- **Weaknesses:**
  - Deleting or disabling a reader password **does not revoke tokens already issued**, because tokens are stateless and carry no version.
  - Logins have no rate limit, which allows brute force.
  - The password loop costs O(n readers × PBKDF2) per login.
  - The token sits in `localStorage` and is passed as `?token=` for `<img>` and SSE, so it leaks into logs and Referer headers.
  - CORS is `*` with credentials.
  - Minimum admin password length is 4.

### Reader endpoints (`/api/reader`)
Only books in `writing` or `completed` are visible.

| Endpoint | Purpose |
|---|---|
| `GET /books?status&q&limit&offset` | Library list. N+1 chapter counts; `LIKE` search on title and synopsis. |
| `GET /books/{slug}` | Book card plus table of contents (done chapters only). |
| `GET /books/{slug}/chapters/{index}` | Full chapter text. |
| `GET /books/{slug}/cover?token=` | Cover image (`image/png`). |
| `GET /books/{slug}/epub` | EPUB built in memory on every request. Minimal EPUB3: no NCX, no CSS, `lang="zh"` hard-coded. |
| `GET` / `PUT /progress/{slug}` | Per-reader reading progress. |

### Admin endpoints (`/api/admin`)
- `GET /stats`
- `GET` / `PUT /settings`
- `PUT /password`
- CRUD for `/themes`, `/profiles` (the API key is masked as `api_key_set`) and `/readers` (no update)
- `GET /jobs`, `POST /jobs/{id}/retry` (resets attempts, revives a failed novel)
- `GET /novels?status`, `POST /novels` (manual creation, optional `theme_id`), `POST /novels/{slug}/archive` (no unarchive), `DELETE /novels/{slug}` (manual cascade), `GET /novels/{slug}` (bible, outline and debt; **no UI uses it**)
- `GET /events?token=`: SSE from an in-process `EventBroker` with 100-slot queues, oldest dropped first, 25s ping. Events: `job_started`, `stage`, `chapter_done`, `job_done`, `job_paused`, `job_error`, `book_created`, `cover_done`.

### Other
- `GET /api/health`
- SPA catch-all that serves `web/dist`

---

## 4. Web UI

**Directory:** `web/src`. Plain CSS, no component library or state library, about 1.3k LOC.

### Reader side
- **Login:** a single password box that routes by role.
- **Library:** a grid of cover cards with a "连载中/完结" badge, an R18 badge, theme, chapter count and 万字 count. Search runs on Enter; a status filter offers all / writing / completed.
- **BookDetail:** cover (or a text placeholder), status pill, chapters written over planned, word count, synopsis, a "续读 第N章" resume button driven by server-side progress, EPUB download (fetch, then blob, because of the auth header) and the TOC.
- **Reader (immersive mode):**
  - Tapping the text toggles the top and bottom bars.
  - Fullscreen API toggle.
  - Font size 14–32 and line height 1.4–2.6, stored in `localStorage`.
  - Global dark/light toggle.
  - ← and → keys change chapter, plus chapter-end navigation ("已是最新" on the newest chapter).
  - Progress is saved per chapter. Scroll position is not saved or restored. There is no pagination mode, no prefetch and no offline cache.

### Admin side
- **Dashboard:** stat tiles (polled every 5s), scheduler pause and auto-generate toggles, "立即立项一本", rate-limit and budget gauges.
- **Live feed:** the 6 most recent SSE events.
- **Novels table:** status filter, progress, words, tokens, cost, quality-debt count, archive, delete.
- **Jobs table:** polled every 4s, retry for failed or paused jobs.
- **Themes:** CRUD.
- **Models:** profile CRUD and a stage → profile selector.
- **Readers:** add and delete.
- **Settings:** all knobs plus changing the admin password.

### Keep vs redesign

| Feature | 2.0 verdict |
|---|---|
| Two roles: admin password plus named read-only passwords, each with its own progress | **Keep the concept.** Add token versioning so revocation works, an httpOnly cookie, login rate limiting, and lookup by label or a password prefix. |
| Library, BookDetail, TOC, "连载中/已完结" serial publishing, read-as-soon-as-a-chapter-is-done | **Keep as-is.** It is the core value. Add a "最近更新" sort, a chapter-updated timestamp and "new since last read". |
| Immersive reader (tap for chrome, fullscreen, font/line height, dark mode, keyboard) | **Keep.** Add scroll-position restore (the field exists and is unused), next-chapter prefetch, a paginated mode, a PWA/offline cache, and virtualised TOC search for books with 500+ chapters. |
| EPUB export | **Keep, rebuild.** Cache per book version, add NCX, CSS, per-language `lang` and volume grouping; export per volume for multi-million-character books. |
| Admin dashboard, stats and SSE feed | **Redesign.** Units change from tokens and books to harness runs, wall-clock time, per-account quota windows and session logs. Keep the SSE plus polling pattern. |
| Jobs and retry | **Redesign** into a run viewer: per-run transcript or log tail, the files written, a diff, kill/retry, lease owner. |
| Themes | **Keep, extend** into "project templates": theme plus custom `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` instruction packs, skills and a style guide. |
| Model profiles and stage → profile mapping | **Drop the LLM-endpoint form.** Replace it with "engine profiles": harness binary and model, flags, auth or credential reference, sandbox/permission mode, concurrency, quota window. Keep the idea of mapping stages to engines with a fallback chain. |
| Admin novel detail (exists in the API, not in the UI) | **Build it in 2.0.** A workspace browser for bible, outline, canon and foreshadowing ledgers as files, a diff history (git), and manual edits that the agents then respect. |
| Archive without unarchive; delete | Add unarchive. Deletion should also remove the workspace directory. |

---

## 5. Deployment

### Dockerfile
- Multi-stage build: `node:22-alpine` runs `pnpm build`, then `python:3.12-slim` with `uv` taken from `ghcr.io/astral-sh/uv:latest` (unpinned).
- Runs `uv sync --no-dev` **without a lockfile**; `uv.lock` is gitignored, so builds are not reproducible.
- `VOLUME /data`, `EXPOSE 8000`, a Python `urllib` healthcheck, uvicorn with a single worker.

### docker-compose.yml
- `postgres:16-alpine` with a bind mount at `./pgdata`, a `pg_isready` healthcheck and default password `novelist`.
- `novelist` service: image `ghcr.io/t0saki/novelist-agent-loop:latest`, `depends_on: service_healthy`, port `${NOVELIST_PORT:-8000}:8000`, `./data:/data`.
- Environment: `DATABASE_URL` (psycopg), `ADMIN_PASSWORD`, `SESSION_SECRET`, `MOCK_LLM`, `SCHEDULER_ENABLED`.
- Removing Postgres falls back to SQLite.

### .env.example
- `NOVELIST_ADMIN_PASSWORD`, `NOVELIST_SESSION_SECRET`, `NOVELIST_PG_PASSWORD`, `NOVELIST_PORT`, `NOVELIST_MOCK_LLM`, `NOVELIST_SCHEDULER_ENABLED`.
- `NOVELIST_DATA_DIR`, `NOVELIST_SESSION_TTL_HOURS`, `NOVELIST_SCHEDULER_TICK_SECONDS` and `NOVELIST_LLM_TIMEOUT_SECONDS` exist in `config.py` but are not listed in the example.

### CI
**File:** `.github/workflows/docker-publish.yml`

- Runs on push to main or manual dispatch.
- QEMU and Buildx; builds `linux/amd64,linux/arm64`.
- Pushes to GHCR with tags `latest` and `sha-short`, using the GHA cache.
- **It runs no tests and no lint**, has no semver tags, no SBOM or provenance, and does no PR builds.

### 2.0 implications
Agent CLIs (Node or Rust binaries) and their auth state have to live in the container or on the host, so the image changes:

- It needs Node plus the harness CLIs, pinned per version.
- Credentials (OAuth logins or API keys) must be mounted, e.g. `~/.claude`, `~/.codex` and similar, as volumes or secrets.
- It needs a per-run sandbox (bubblewrap, container per run, or the harness's own sandbox modes) and git inside the image.

A host-native "runner" mode, where the web container plus a worker on the host uses the user's logged-in CLIs, is likely the main deployment path, because subscription-based harness auth is per user and interactive. **This is a decision for the user.**

---

## 6. Tech debt and weaknesses

### Architecture
- The scheduler lives in the web process, with one uvicorn worker. It cannot scale out and a web restart interrupts writing. The in-memory `running` dict plus "running without a live task means orphan" works only with exactly one process; two replicas would reap each other's jobs.
- **No job leases or heartbeats.** A hung LLM call (600s timeout × 5 retries × N profiles) holds a slot for up to about an hour per call, and nothing detects it.
- `run_job` holds **one SQLAlchemy session for the whole job lifetime**, across all LLM calls. That caused the lock bugs, which were patched rather than designed out.
- The SSE broker is in-process, so it will not work across processes.
- No Alembic migrations: schema changes against the Postgres default will break existing installs.
- Mutable JSON blobs (`bible`, `outline`) are rewritten in place with no history or versioning, and humans cannot edit them.

### Ultra-long consistency, the core 2.0 goal
- **The "rolling summary" is only the last 10 chapter summaries.** Nothing summarises arcs or volumes, so chapter 300 has no memory of chapters 1–290 beyond the bible's character `state` field.
- Chapter summaries see only the **last 1500 characters** of the chapter (`chapter_summary_prompt`), so most of the chapter's content is ignored.
- `foreshadow_updates` are requested and then thrown away; the ledger is never updated. `bible.foreshadowing` is never consulted after outlining.
- `review_prompt` exists but is **never called**, despite the README claiming "章级审校". Quality debt records only short scenes and is never acted on.
- Blueprints are generated in batches of 8. Context comes from `outline_context` (volume titles plus a one-line arc); later batches cannot see the actual story so far, only the synopsis. Volumes are flat: there is no per-volume outline refinement, despite the README.
- New characters introduced during writing never enter the bible.
- Scene continuity passes only the last 200 characters of the previous scene, and chapter 1 of each new chapter gets `prev_tail=""`, so nothing carries across chapter boundaries.
- `planned_chapters` is fixed at the concept stage and the book must end exactly there. There is no adaptive extension or truncation.
- Premise dedup is embedding-only and advisory (it logs and continues).

### Quality control
- Length enforcement is deterministic (CJK character count ≥ 0.85 × target, up to 3 attempts, keep the best). That is good. Ending-marker detection works by stripping substrings, which can also remove legitimate in-story uses of words like "剧终".
- Fast-forward markers and the repetition ratio are implemented in `length.py` but **unused**.
- JSON parsing failures fall back to `{}` silently. A failed bible becomes an empty bible and the pipeline continues.

### Security
- API keys are stored in plaintext in the DB.
- No CSRF exposure, since auth is a Bearer header, but the token is in `localStorage` and in query strings.
- No reader-token revocation; CORS `*`.
- The NSFW flag exists on themes and novels, and the UI shows an R18 badge, but there is no per-reader content gating.

### Ops and testing
- 14 tests, all mock-based, with no frontend tests. CI does not run them.
- No lockfile for Python (`uv.lock` is gitignored); the uv image is unpinned.
- N+1 queries in `list_books`, `list_all_novels`, `list_jobs` and `_pick_theme` (which loads every novel per theme on every tick).
- **The book rate limit counts `Novel.created_at`, so deleting books frees quota.** Manual creation also consumes quota.
- The README references `.claude/plans`, which is not in the repo.
- Dead code: `rolling_summary`, `checkpoint.last_chapter` (never read back), `illustration_density` on novels, `sqlite-vec`, `NovelEmbedding` kind `outline` (written, never queried separately), `supports_tools` (no tools are ever sent).

---

## 7. Keep / redesign / drop for 2.0

2.0 assumes the writing engine is an external agent CLI operating on a per-book file workspace.

| Subsystem | Verdict | Rationale and 2.0 shape |
|---|---|---|
| **Scheduler loop** (tick, priority "serials first", weighted theme round-robin, auto-generate toggle, global pause) | **Redesign (keep the policies)** | Move it to a separate worker process. Jobs become `runs` with `lease_owner`, `lease_expires_at` and heartbeat columns; claims use `SELECT … FOR UPDATE SKIP LOCKED` on Postgres, and the reaper acts on expired leases instead of "no live task in my dict". Keep the sort key, the theme picker (make it O(1) with a counter) and "no theme means no new book". |
| **Rate limits** (books per 24h / 5h) | **Redesign** | The real constraint is harness quota: subscription windows such as 5h rolling limits, per-account RPM and concurrent sessions. Make limits per engine profile (runs per window, concurrent runs, wall-clock per day), track them from harness exit and usage output, and back off on quota errors. Keep the book-count window as a separate product-level knob. Count creations in an append-only event log so deleting books does not refund quota. |
| **Token and cost budgets** | **Redesign** | Harnesses report usage inconsistently (some emit JSON or stream-json usage, some nothing) and subscription runs have no per-token price. Use a ledger per run that records tokens when available and **wall-clock plus turn count** always. Enforce budgets *inside* a run as well, through the harness's max-turns or timeout flags plus a supervisor kill, not only between chapters. |
| **Crash resume and checkpoints** | **Keep the principle, change the mechanism** | The checkpoint becomes the **workspace itself**: a git repo per book, with a commit after each successful run or step. Resuming means checking the workspace state (which chapter files exist and pass validation) and redoing only missing steps. Keep `_recover_orphans`, expressed through lease expiry. Keep "failure accounting in a fresh transaction". Keep graceful stop at step boundaries and add SIGTERM, then SIGKILL, for child CLIs. |
| **Pipeline stages** (ideation → concept → bible → outline → writing → finalize) | **Redesign** | Stages become task specs given to agents ("write chapter N to `chapters/0NNN.md`; update `state/characters.md` and `state/foreshadowing.md`"), with the orchestrator validating outputs. Keep the planning-first principle, the deterministic length check and the ending-marker check as **post-run validators** on files. Add the missing hierarchy: book → volume → arc → chapter outlines as files, volume and arc summaries, a foreshadowing ledger that is actually updated, character registry growth, and a review/continuity agent run every N chapters. |
| **Prompts** (`prompts.py`) | **Redesign into instruction packs** | Turn them into versioned `AGENTS.md`/`CLAUDE.md` templates plus per-task prompt files in the workspace, overridable per project or theme by the user's custom instruction files. Hard-won rules worth carrying over: cold open, no info-dump in chapter 1, an authoritative cast list, no premature endings, an expand-without-new-plot retry. |
| **Providers** (`ChatClient`, fallback chain, mock) | **Drop the HTTP client; keep the abstraction** | Replace with an `EngineAdapter` interface (`claude`, `codex`, `dsh`, `agy`, `grok`, `pi`): build the command line, environment, cwd and sandbox flags; parse the stream or exit code; extract usage; classify errors (quota, auth, transient). Keep the **fallback chain** and **stage → engine mapping**. Keep a **mock engine** (a script that writes fake files) for zero-cost end-to-end tests. Image generation (cover) can stay a direct API call or become an agent task. Embedding dedup is optional. |
| **Data model** | **Redesign** | The DB becomes an index and control plane; the canonical story state lives in workspace files. Keep `novels` (metadata, status, slug, theme, nsfw, counts), `chapters` (indexed copy of the published text and metadata, a content hash, `published_at`), `reader_passwords`, `reading_progress`, `themes`/templates, the usage ledger and settings. Add `engine_profiles`, `runs` (lease, pid, log path, exit status, usage, files touched), `workspace_commits`, `events`, plus a `token_version` per reader. Drop the `bible`/`outline` JSON blobs, `rolling_summary`, `quality_debt` as JSON (make it a table or a file) and `llm_profiles`. Add Alembic. |
| **Chapter publishing** (write a chapter, it is readable immediately; 连载中/已完结) | **Keep as-is** | It is the core UX. Ingest happens when a validated `chapters/NNNN.md` is committed; then the DB row is upserted and an SSE `chapter_done` event fires. |
| **API, reader side** | **Keep (minor fixes)** | Same endpoints. Fix N+1 queries, add `updated_since`, restore scroll position, cache EPUBs, serve illustrations. |
| **API, admin side** | **Redesign** | Add engine profile CRUD, instruction-pack and template editing, a workspace file browser and editor (read, diff, edit, which affects the next run), a run log stream (tail the CLI stdout or JSONL), and kill/retry/rerun-from-step. Keep stats, pause and auto-generate. |
| **Auth** | **Keep the model, harden** | Admin plus named read-only passwords, each with separate progress. Add httpOnly cookies or short-lived signed URLs for covers and EPUBs instead of `?token=`, `token_version` revocation, login throttling and argon2/bcrypt. Optionally add a per-reader NSFW visibility toggle; this is a product question for the user. |
| **SSE event bus** | **Redesign** | Use Postgres `LISTEN/NOTIFY` or a DB events table so the worker and web processes share events. Keep the event vocabulary and add `run_started`, `run_log`, `run_exit` and `quota_wait`. |
| **Web reader UI** | **Keep, polish** | Everything in §4: scroll restore, prefetch, pagination mode, PWA, TOC grouped by volume for long books. |
| **Admin UI** | **Redesign** | Driven by the new run, engine and workspace concepts. |
| **EPUB** | **Keep, upgrade** | Cached, volume-aware, NCX, CSS, real language attribute; optional per-volume export. |
| **Covers and illustrations** | **Keep (optional)** | Separate low-priority job. Keep the hard SFW suffix for covers. Actually display illustrations. |
| **Deployment** (Docker, compose, Postgres, `NOVELIST_PORT`, GHCR multi-arch) | **Keep, extend** | Separate `web` and `worker` services, with Postgres as the only supported multi-process DB (or SQLite for single-process dev). The worker image pins the harness CLIs. Mount credential volumes and the workspace volume, and add a host-runner mode. Commit `uv.lock`, pin the uv image, add test, lint and typecheck jobs to CI, and semver tags. |
| **SQLite support** | **Keep for dev/single-process only** | Locking was the main v1 pain. 2.0 has a separate worker plus web, so make Postgres the default and document SQLite as single-process only. |
| **`sqlite_to_pg.py`** | **Drop** (or a one-shot v1 → v2 importer) | A v1 → v2 importer that exports each novel's chapters plus bible/outline JSON into a workspace directory would preserve existing books. **This is a decision for the user.** |
| **Tests** | **Keep the pattern, expand** | The scheduler, budget and orphan tests are valuable; port them to lease semantics. Add mock-engine end-to-end tests, adapter contract tests per harness (recorded fixtures), validator tests, and frontend smoke tests. |

### Decisions to raise with the user
1. **Deployment topology.** Container-only, with CLIs and credentials mounted, versus a host-native worker that uses the user's logged-in harnesses.
2. **Migration.** Import v1 books into 2.0 workspaces, or start clean.
3. **Budget unit.** Tokens versus wall-clock and runs versus subscription quota windows, chosen per engine.
4. **Workspace history.** Git-per-book as the checkpoint and history mechanism, or plain files plus DB snapshots.
5. **Reader content gating.** Whether reader roles gain per-reader visibility controls for flagged content, or keep v1's "all readers equal".
6. **Admin editing.** Whether the admin can edit workspace files (bible, outline) mid-serial so agents pick up the changes; this needs locking against running jobs.

Key v1 files referenced:
- `server/app/scheduler/scheduler.py`
- `server/app/scheduler/ratelimit.py`
- `server/app/pipeline/engine.py`
- `server/app/pipeline/stages/writing.py`
- `server/app/pipeline/stages/planning.py`
- `server/app/pipeline/prompts.py`
- `server/app/db/models.py`
- `server/app/api/admin.py`
- `server/app/api/reader.py`
- `server/app/core/security.py`
- `web/src/pages/Reader.tsx`
- `docker-compose.yml`
- `.github/workflows/docker-publish.yml`
