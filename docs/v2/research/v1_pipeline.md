# Novelist v1 pipeline: how it works, what holds up, and what fails for 300+ chapter novels

Scope: everything below comes from reading the code and git history of the repository. No web sources were needed because nothing here depends on outside facts. File paths are relative to `server/app/`.

## 0. Bottom line

v1 is a fixed, stateless, single-turn prompt pipeline. Every scene is one chat call that sees about 2–4k characters of context. Several mechanisms the README advertises are missing or are dead code:
- **Chapter review**: the prompt exists but is never called.
- **Foreshadowing ledger**: model output is parsed and then thrown away.
- **Volume-level refinement**: in practice it is "make blueprints for 8 chapters at a time", with no volume outline.
- **Fast-forward and repetition detectors**: defined but never called.

The ideas are sound: deterministic validation, plan before writing, an authoritative cast list, checkpoints. The memory layer cannot hold up past about 10–20 chapters.

## 1. Stage-by-stage flow

`pipeline/__init__.py` defines `STAGE_SEQUENCE = [ideation, concept, bible, outline, writing, finalize]`.

`engine.py` `PipelineEngine.run_job` works as follows:
- It runs stages from `job.stage` onward and saves `job.stage` as a checkpoint before each one.
- On an exception it records the failure in a fresh session (`_record_failure`). The job goes back to `queued` until `attempts >= max_job_attempts` (default 3), then it is marked `failed`.
- The writing stage can return `paused`/`stopped`. That comes from a `control` callback the scheduler calls between chapters, which checks the global pause switch, the per-book token cap and the daily token budget.
- When a book is done, a separate `cover` job is queued.

### 1.1 Ideation (`stages/planning.py: stage_ideation`)
- **Input:**
  - Theme fields `name`, `keywords`, `style_prompt`. The scheduler picks the theme by weighted round-robin, lowest `books / weight` first.
  - The 20 most recent titles in the library, passed as "avoid these".
- **Prompt:** `premise_prompt` asks for 3 candidates as JSON: `{"candidates":[{"title","logline","selling_point"}]}`.
- **Dedup:** it embeds the 3 loglines and computes the maximum cosine similarity against every `NovelEmbedding.vector`, with Python doing a full O(N) scan. It picks the candidate whose maximum similarity is lowest. `dedup_threshold` (0.92) only **logs** a warning and never rejects anything.
- **Output:** `novel.premise = "title｜logline｜卖点：…"` and `novel.title`. The chosen vector is stored as `kind="premise"`.

### 1.2 Concept (`stage_concept`)
- **Input:** premise, `theme.length_hint`, and the average word count of the last 10 books.
- **Anti-short nudge:** if that average is under 8000, the prompt adds "近期产出普遍偏短，请规划更充实的篇幅" ("recent books have run short; plan more substantial length").
- **Prompt:** `concept_prompt`. The model chooses the chapter count itself, using these bands: short 1–5, medium 6–20, long 20–60, ultra-long 60+. It is told not to compress to save effort, and 2500–4000 words per chapter is suggested.
- **Output JSON:** `title, synopsis (~150字), tone, audience, planned_chapters, target_chapter_words, volumes[{title, chapter_count}]`.
- **Post-processing:**
  - `planned_chapters = max(model, theme.min_chapters)`, a hard floor per theme.
  - `target_chapter_words >= 800`.
  - A fallback of one volume if none is given.
  - The content-rating flag is copied from the theme.

### 1.3 Bible (`stage_bible`)
- **Input:** only title and synopsis.
- **Prompt:** `bible_prompt`. The output JSON is:
  - `world`: a single string.
  - `characters[{name, role, description, motivation, relationships, state}]`, with 5–12 required, described as the "全书唯一的权威人物表" (the one authoritative cast list for the whole book).
  - `canon[]`: hard facts.
  - `voice{pov, style}`.
  - `foreshadowing[{item, plant_hint, payoff_hint}]`.
- **Output:** the whole object goes into `novel.bible` (a JSON column). If JSON parsing fails after 2 repair attempts, `{}` is stored silently.

### 1.4 "Hierarchical outline" (`stage_outline`, `_make_blueprints`, `ensure_blueprint`)
- `stage_outline` only sets `outline.arc = synopsis` and then generates blueprints for chapters 1–8 (`_BLUEPRINT_BATCH = 8`).
  - **No volume outline is ever produced.** `volumes` holds only `{title, chapter_count}`.
- **Blueprint context** (`context.outline_context`): `"卷划分：卷A(n章); …\n主线弧光：<synopsis>"`, plus the full cast list as name, role and description.
  - It contains **no previous blueprints, no chapter summaries, and no volume each chapter belongs to.**
- **Prompt:** `blueprint_prompt`. Each chapter is split into 3–6 scenes. Each scene has `summary`, `must_happen`, `characters` (taken from the cast list), and `target_words` (600–1200). Only chapter `total` may have `is_final=true`; every other chapter needs a `hook`.
- **Output per chapter:** `{index, title, goal, characters[], foreshadow_plant, foreshadow_payoff, scenes[], hook, is_final}`. It is stored in `novel.outline["blueprints"][str(idx)]`.
- **Opening-chapter rule** (added after real-model runs): it bans "逐一介绍所有人物 / 集中登场" (introducing every character at once, a mass first appearance).
- `ensure_blueprint(index)` is called lazily during writing. When chapter `index` has no blueprint, it generates `[index, index+8)` and so on. This is the whole "volume-level dynamic refinement".

### 1.5 Writing (`stages/writing.py: stage_writing`)
For each chapter `1..planned_chapters`, chapters with `status=done` are skipped, so resume works at chapter level:
1. Call `control()`, which can pause or stop.
2. Call `ensure_blueprint`. If the blueprint has no scenes, use one fallback scene, "推进本章情节" ("advance this chapter's plot"), with `target_words = target_chapter_words`.
3. Create or get the `Chapter` row, set `blueprint` and `status=writing`, and commit.
4. Build `rolling = _rolling_summary()` from the **last 10** chapter summaries.
5. For each scene, call `_generate_scene`:
   - **Context** (`build_scene_context`):
     - `【世界观】`: the full world string.
     - `【硬事实】`: all canon, joined with `;`.
     - `【本章出场角色】`: cards for scene characters only, filtered by exact name match. If the scene lists no characters, **all** characters are included.
     - `【前情摘要】`: the rolling summary.
     - `【本章目标】`: the chapter goal.
     - Optional `【本章需埋伏笔】` / `【本章需回收伏笔】` (foreshadowing to plant or pay off in this chapter).
   - **Prompt:** `scene_prompt` (see 5) with `SYSTEM_WRITER`. It includes `prev_tail[-200:]`, the last 200 characters of the **previous scene in this chapter**. At chapter start it is empty ("（本章开头）"), so **no prose carries over between chapters.**
   - **Up to 3 attempts.** It keeps the longest output and returns early once `count_words >= target * scene_floor_ratio (0.85)`.
   - Each scene is committed into `chapter.scenes` and `chapter.content`, so it is visible to readers immediately.
   - A scene that fails length goes into `novel.quality_debt` as `{chapter, scene, type:"short", detail}`.
6. Write `chapter.content`, `word_count` and `status=done`. `_summarize_chapter` then runs `chapter_summary_prompt` on the **last 1500 characters of the chapter only** and returns:
   - a summary of at most 120 characters,
   - `character_updates[{name, state}]`, which overwrite `bible.characters[].state` by name,
   - `foreshadow_updates`, which are **ignored**.
7. Save `job.checkpoint = {"last_chapter": index}` and progress, then broadcast `chapter_done` over SSE.

### 1.6 Finalize (`stages/finalize.py`)
- It concatenates all chapter summaries and sends them to `book_synopsis_prompt` for a library blurb of at most 200 characters.
- It embeds the synopsis as `kind="outline"` for future dedup, adds up word counts, and sets the status to `completed`.
- **No review pass and no consistency audit happen here.**

### 1.7 Cover (`stages/cover.py`)
- An LLM writes an English image prompt and the code appends a hard SFW suffix.
- Optionally an illustration is made every N chapters, using chapter summaries.
- It runs as a separate job, so a failure there does not affect reading.

### 1.8 Data model (`db/models.py`)
- **Novel** (the hub; large semi-structured data lives in JSON columns):
  - `premise, synopsis, tone, target_audience, planned_chapters, target_chapter_words`
  - `volumes` (JSON), `bible` (JSON), `outline` (JSON, holding `arc` and `blueprints{idx: bp}`)
  - `rolling_summary` (Text, **never written**)
  - `quality_debt` (JSON list)
  - `tokens_total, cost_total, word_count, status, error`
  - a content-rating flag, `language`
- **Chapter:** `index` (unique per novel), `blueprint` (JSON), `scenes` (JSON `[{summary, text, ok}]`), `content, word_count, summary, status (pending/writing/reviewing/done)`. **`reviewing` is never used.**
- **Job:** `type (generate/cover), stage, status (queued/running/paused/done/failed), priority, attempts, checkpoint, progress, error`.
- **Supporting tables:**
  - `UsageLedger`: tokens and cost per call, per stage and profile.
  - `LlmProfile`: OpenAI-compatible endpoint, price per million tokens, temperature 0.9.
  - `Setting`: a key-value store. `stage_profiles` maps each stage to a fallback chain of profile ids.
  - `Theme`: keywords, style prompt, length hint, `min_chapters`, weight, content-rating flag.
  - `NovelEmbedding`: the vector as a JSON array, with cosine computed in Python.
  - `Image`, `ReaderPassword`, `ReadingProgress`.

## 2. Consistency and memory mechanisms

| Mechanism | What the code actually does | Gap |
|---|---|---|
| World bible | One `world` string, injected in full into every scene | Never updated or grown. No structured systems (power levels, geography, factions, timeline). |
| Character cards | `character_cards()` filters to the scene's `characters` by exact name. Each card is `name(role)：description；动机；当前状态` (motivation; current state). | Before commit dd25eaa, the bible and the blueprints invented names independently and the "intersection was empty", so card injection did nothing. A new character created during writing is never added to the bible. `state` is overwritten with a one-liner taken from the chapter's last 1500 characters. There is no state history, inventory, location or relationship graph. |
| Rolling summary | The last `MAX_ROLLING_CHAPTERS = 10` summaries, at most 120 characters each, so roughly 1.2k characters | Everything older than 10 chapters disappears, except mutated character `state`. The summary is made from the chapter **tail** only. `Novel.rolling_summary` is unused. No hierarchical summaries (arc or volume level). |
| Canon facts | Static `bible.canon[]`, injected in full into every scene | Never appended to as the story creates new facts, and never checked against. |
| Foreshadowing ledger | Bible `foreshadowing[]` plus per-chapter `foreshadow_plant/payoff` strings from blueprints | The bible list is **never read** after planning. `foreshadow_updates` from the summary step is discarded. There is no open-thread tracking, so payoffs depend on the blind blueprint batches happening to remember. |
| Volume-level dynamic refinement | `ensure_blueprint` lazily makes blueprints 8 chapters at a time | Each batch sees only synopsis, volume titles and the cast. It does not see earlier blueprints, what was actually written, unresolved threads, or which volume it is in. For 300 chapters that is about 38 independent, blind batches, so expect repeated beats, arcs reset to zero, and drift from the plan. |
| Embedding dedup | Done between books, on premise loglines; chooses the least similar of 3; the threshold only logs | It is not used inside a book (no RAG over earlier chapters, no detection of repeated scenes or phrasing). Brute-force scan over JSON vectors. |
| Review | `review_prompt` checks `text[:4000]` against canon and character states and returns `{consistency_issues, style_issues, verdict}` | **Dead code**: no caller, and `ChapterStatus.reviewing` is never set. |

## 3. Anti-laziness and length control (`pipeline/length.py`)

- **`count_words`:**
  - Chinese counts characters in `[一-鿿]` only, so punctuation, digits and Latin names are excluded. That is conservative, which is good.
  - Other languages count whitespace-separated tokens.
- **`scene_ok`:** passes when `words >= int(target * floor_ratio)`. `scene_floor_ratio` is configurable and defaults to 0.85. The check is deterministic and never asks the model whether it did enough.
- **Retry loop:**
  - There are 3 attempts. From the second attempt on, the prompt adds 【扩写要求】 (expansion request): "还差约 N 字。请在不新增情节、不改变已发生事件的前提下…增加感官细节、人物心理、对白与环境描写…不要复读已有句子" (about N characters short; add sensory detail, inner thoughts, dialogue and setting without adding plot or changing events, and don't repeat existing sentences).
  - **Bug/limitation:** the earlier draft is not included in the prompt, so this is a fresh rewrite, not an expansion. "Don't repeat existing sentences" refers to text the model cannot see.
  - The longest draft wins regardless of quality.
  - A scene that still fails is accepted anyway and logged to `quality_debt`, which is **never paid back**.
- **Completion detection:**
  - `_ENDING_MARKERS`: 全书完, 全文完, （完）, 剧终, 本书完, 故事到此结束, the end, 全书终 (all variants of "the end").
  - In a non-final scene the markers are **stripped**, not retried. The code comment says "剥离后重试" (strip, then retry), but the code only strips.
  - The prompt side backs this up: `SYSTEM_WRITER` rule ④, `ending_rule`, and the blueprint `hook` and `is_final` fields.
- **Unused detectors:**
  - `has_fastforward_marker` (此处省略, 一笔带过, 不再赘述, 略过不表, the usual "skipping over this" phrases)
  - `repetition_ratio` (share of duplicate sentences)
- **Length is structured from the top:** concept picks the chapter count and words per chapter. Blueprints set 3–6 scenes of 600–1200 each, which allows 1.8k–7.2k per chapter and is never reconciled with `target_chapter_words`. Theme `min_chapters` is a floor, and the recent-average nudge pushes against short books.
- **Lazy model or lazy plan:** scene-level generation is the main defence against a model that summarises instead of writing. Nothing defends against a lazy plan: an empty blueprint falls back to one generic scene.

## 4. Failures from real-model runs (git log)

- **dd25eaa**, an end-to-end run with Grok through a newapi proxy:
  1. The proxy defaulted to SSE streaming, so the code now sends `stream:false` explicitly.
  2. Backoff for 429/5xx was raised to 6–30 s with 5 retries.
  3. **The bible and the outline produced disjoint character names**, so card injection did nothing. The fix forces the authoritative cast list into the blueprint prompt.
  4. Chapter 1 read like a flat list: a mass introduction of characters and a recap-style opening. The fix added the cold-open rules.

  The lesson: independent single-shot calls do not share understanding, and consistency has to be enforced through shared artifacts.
- **754c775 and 9026e1b:** SQLite write-lock contention with concurrency=2 left jobs stuck in `running` forever.
  - Fixes: a watchdog reaper, failure recording in a fresh session, a commit after every scene, then Postgres.
  - The lesson: long LLM calls inside DB transactions are fragile. 2.0 should keep artifacts on the filesystem (or in git) and make the DB a thin index.
- **9026e1b:** with no enabled theme, the scheduler invented books on unrelated topics. Planning needs explicit inputs.
- **fc04871:** covers forced to SFW via prompt plus a hard suffix. Image content rules are separate from text content rules.

## 5. Prompt patterns worth porting

- **Persona and output discipline:** "你只输出被要求的内容，不寒暄、不解释" (output only what is asked; no chit-chat, no explanation). In 2.0 the equivalent is "write only to the target file; stdout is only a status line".
- **Craft rules in `SYSTEM_WRITER`:** "①用具体场景与细节展示，不要概述、不要一笔带过；②对白、动作、心理、环境交替推进；③严格贴合给定设定与前文；④除非明确告知这是最后一章…绝不写「全书完」" (show through concrete scenes and detail, never summarise or skip; alternate dialogue, action, thought and setting; stick strictly to the setting and earlier text; never write "the end" unless told this is the final chapter). This belongs in a per-genre AGENTS.md style section.
- **Treat the target as a floor:** "目标字数：约 N 字（这是下限，宁多勿少）" (target about N characters; this is a minimum, err long), checked by a deterministic counter.
- **Expansion rules:** "不新增情节、不改变已发生事件…增加感官细节、人物心理、对白与环境描写" (no new plot, no changes to events; add sensory detail, inner thoughts, dialogue, setting). With file-based agents this becomes a real in-place expansion, because the agent can read its own draft.
- **Cold open:** "从一个具体的时刻与画面切入…严禁用「通知来得突然」…这种回溯式概述…不要把尚未在正文出现过的前情、身份、关系当作读者已知来陈述" (open on a concrete moment and image; no recap-style openings like "the summons came suddenly"; don't treat backstory, identities or relationships not yet shown in the text as known to the reader).
- **Authoritative cast:** "这是全书唯一的权威人物表，后续大纲与正文只能使用这里定义的角色与姓名" (this is the book's one authoritative cast list; later outlines and prose may only use these characters and names), plus "确需新增次要角色时须保持风格一致" (a new minor character, if truly needed, must match the existing style). In 2.0 this becomes a `characters/` directory plus a registration step for new characters.
- **Structural ending guard:** "只有第 {total} 章是最后一章（is_final=true）可以收尾，其余章必须在 hook 里留下钩子" (only chapter {total} is final and may wrap up; every other chapter must leave a hook).
- **Self-correcting nudge from production stats:** "近期产出普遍偏短，请规划更充实的篇幅" (recent books run short; plan more substantial length). Measured metrics are fed back into planning.
- **Self-correction on JSON failure:** "上一次输出不是合法 JSON。请只输出一个合法的 JSON 对象" (the last output was not valid JSON; output only one valid JSON object). In 2.0 the equivalent is schema validation of agent-written files plus a re-prompt with the validator's errors.

## 6. Keep in 2.0

1. Code-side, deterministic gates: CJK character count, ending and fast-forward markers, repetition ratio, schema checks. Never trust the model's own judgement, and wire up the detectors v1 left unused.
2. Plan before writing: premise, concept, bible, outline, scenes. Reserve the chapter count and the final chapter up front, with a hook on every other chapter.
3. An authoritative entity registry that the outline and prose must use.
4. Scene as the unit of length control, and chapter as the unit of publishing and checkpoints. Chapters become readable as soon as they are done.
5. A quality-debt ledger, but with a repair pass that works through it.
6. Budget, pause and resume control between chapters, a usage ledger, per-stage engine routing with fallback chains, mock mode for zero-cost tests, and a watchdog for orphaned jobs.
7. Dedup between books and theme-weighted round-robin for auto-starting books; `min_chapters` floors per theme.
8. A separate image job with its own content policy.

## 7. Weaknesses for 300+ chapters, and what file-based agents fix

| v1 weakness | Effect at 300+ chapters | Fix in an agentic, file-based 2.0 |
|---|---|---|
| Stateless single-turn scene calls; only 200 characters of prior prose; nothing carried between chapters | Voice drift, weak chapter transitions, contradictions | The agent reads `chapters/NNN.md` (the last 1–2 chapters in full) and a style anchor file, then writes to `drafts/`. A fresh session per chapter keeps context bounded. |
| Rolling window of 10 × 120-character summaries made from the chapter tail | Everything before chapter N−10 is lost | A summary tree: chapter, then arc (about 10 chapters), then volume, then book, as files. The agent greps or searches `summaries/` and `chapters/` on demand. An optional embedding index over scenes. |
| Static canon and world strings | New facts are never recorded or checked | Append-only `canon/facts.md` with source chapter refs. A `timeline.md` plus per-entity files (characters, locations, items, factions, power levels). An updater runs after each chapter and writes diffs. |
| Foreshadowing ledger not tracked | Threads left dangling, and the ending ignores setups | `threads.yaml` with ids, plant chapter, due window and status. The planner must schedule payoffs. A gate blocks the final volume while required threads are still open. |
| No volume outline; blind 8-chapter blueprint batches | Repeated beats, arc resets, plan-vs-actual drift | A real hierarchy: `outline/book.md`, then `outline/vol-XX.md` (goal, escalation, climax, threads), then rolling chapter blueprints. They are written by a planner agent that reads the earlier volume summaries and the open-threads file, and re-plan with recorded diffs when the text drifts. |
| "Expansion" is a blind rewrite; longest wins | Wasted tokens, quality is random | The agent edits its own draft in place, and the check is re-run until it passes or the attempt budget runs out. |
| Review is dead code | Contradictions accumulate | A separate reviewer agent (ideally on a different harness or model) reads the chapter against the canon, entity and thread files and writes `reviews/NNN.json`. A fix loop follows, plus periodic whole-arc audits. |
| JSON failure turns into `{}` silently | Empty bible or empty blueprint, generic filler | Schema validation of the files the agent writes, with a hard failure and re-prompt that includes the validator errors. Never degrade silently. |
| Resume regenerates a partly written chapter from scene 0 | Repeated cost | Each scene is its own file. Resume is idempotent and skips scene files that exist and pass the checks. |
| Everything in DB JSON columns; DB locking pain | Fragile under concurrency | The project directory (ideally a git repo) is the source of truth, with a commit per chapter for diffs and rollback. The DB only indexes it for the reader and the scheduler. |
| Fixed chapter count chosen once at concept | Pacing cannot adapt | The chapter count becomes a range per volume. The planner can re-split within ±X% under a hard total floor. |
| No cross-chapter repetition detection | Recycled tropes and phrasing over hundreds of chapters | N-gram or embedding similarity against earlier scenes, recorded as quality debt and fed back to the planner. |
| Behaviour rules hard-coded in `prompts.py` | No per-project or per-genre customisation | User-editable instruction files (AGENTS.md / CLAUDE.md / GEMINI.md generated from one template) per project and genre layer, with a strict output contract: write files, stdout only a status line. |
