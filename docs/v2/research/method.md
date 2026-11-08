# Research report: SOTA in agentic, file-based ultra-long fiction generation (2024–2026), for Novelist 2.0

Sources were checked with web searches and fetches on 2026-11-08. Items marked [secondary] were confirmed only through third-party summaries or README digests.

---

## 1. Academic methods

### 1.1 Lineage (pre-2025, short notes)
| Method | Core idea | Lesson for 2.0 |
|---|---|---|
| **Re3** (Yang et al., 2022) https://arxiv.org/abs/2210.06774 | Plan → Draft → Rewrite (rerank) → Edit (fix contradictions against a premise and plan). | Separate plan, draft and edit roles. Check contradictions against structured facts. |
| **DOC** (Yang et al., 2023) https://arxiv.org/abs/2212.10077 | A detailed hierarchical outline plus a controller that keeps each passage on its outline node. | Hierarchical outlines (book → volume → chapter → beat) work. The outline acts as a binding contract. |
| **RecurrentGPT** (2023) https://arxiv.org/abs/2305.13304 | A natural-language "LSTM": a short-term memory paragraph plus a retrievable long-term memory, updated each step. | A rolling summary alone degrades over long runs (see RollSum below). |
| **LongWriter / AgentWrite** (THU, 2024) https://arxiv.org/abs/2408.07055 | Models of that time capped out near 2,000 words of output. AgentWrite plans paragraphs with word budgets and writes them one at a time. | Long chapters need explicit per-section word budgets. Never ask for a whole volume in one call. |
| **Agents' Room** (Google DeepMind, ICLR 2025) https://arxiv.org/abs/2410.02603 | An orchestrator calls planning agents (conflict, character, setting, plot) and writing agents (per section) through a **shared scratchpad**. Humans preferred it over end-to-end baselines. | A shared scratchpad maps directly onto shared project files. |
| **CritiCS** (EMNLP 2024) https://arxiv.org/abs/2410.02428 | Several critic personas give feedback over multiple rounds and a "leader" (editor persona) picks the best suggestion. Two stages: CrPlan (refine the plan) and CrText (expressiveness). Criteria: Image, Voice, Originality. | Use multiple critics and **one arbiter**, not majority voting. Critique the plan as well as the prose. |
| **DOME** (NAACL 2025) https://arxiv.org/abs/2412.13575 | A dynamic hierarchical outline that adapts during writing. Memory is a **temporal knowledge graph**, and a Temporal Conflict Analyzer checks it. | Store time-indexed facts. It is very expensive: about 3,500 calls and $0.76 per 10K-word story (per the NstAgent paper). |

### 1.2 2025–2026
- **StoryWriter** (THU-KEG, Jun 2025) https://arxiv.org/abs/2506.16445, code at github.com/THU-KEG/StoryWriter. Three agents: an outline agent (event graph covering characters and relations between events), a planning agent (assigns events to chapters, non-linear narration), and a writing agent (condenses history around the current event, then "ReIO" rewrites input and output). It produced the LongStory dataset (about 6K stories, average about 8K words).
- **Long Story Generation via Knowledge Graph and Literary Theory** (BJTU, Aug 2025) https://arxiv.org/abs/2508.03137. Long-term memory anchors the story to its theme and short-term memory holds recent outlines. Plot twists come from adding narratology-driven KG nodes and checking their similarity to earlier storylines.
- **CreAgentive** (Sep 2025) https://arxiv.org/abs/2509.26461. Separates narrative logic (a story-graph or "story prototype") from surface text generation.
- **SuperWriter** (Jun 2025) https://arxiv.org/abs/2506.04180. A plan → write → reflect/refine agent pipeline, distilled into a 7B model (8.51 on WritingBench) with hierarchical DPO.
- **LongWriter-Zero** (ICLR 2026 oral) https://arxiv.org/abs/2506.18841. RL from a base model (Qwen2.5-32B) with three reward models (length, quality, structure). Scores 8.69 on WritingBench.
- **NstAgent: Scaling Long-Form Story Generation via Narrative State Tracking** (Wan and Chen, 28 Sep 2026) https://arxiv.org/abs/2609.35759, code at github.com/zhennan1/NstAgent. This is the most directly relevant paper for 2.0.
  - **State** has three typed collections. *Character states*: one snapshot per name covering location, goal, relationships, knowledge, possessions and condition. *Past events*: keyed off-outline events that may matter later. *Future requirements*: keyed open obligations such as planted clues or promised confrontations, deleted when resolved.
  - **Update**: one tool call after each accepted chapter with four arrays (character upserts, new events, new requirements, resolved requirement keys).
  - **Generation context**: the prompt, the frozen outline, the state as JSON and the chapter task with its word target. It includes **no earlier prose**. Lookback goes through budgeted tools: `read` a past chapter (3 per chapter), BM25 `search` over sentence windows (top 8, 5 per chapter), and `correct` an exact span (3 per chapter).
  - **Length gate**: ±20% per chapter. Truncated drafts are rejected.
  - **Results**: at 100K words, Instance CED (consistency errors per 10K words) was 7.24 vs 11.82 for RollSum on DeepSeek-V4-Flash and 7.22 vs 9.37 on GPT-5.6 Luna. The advantage grows with length.
  - **Ablation at 20K**: no state gives 9.40, no lookback tools gives 9.79, the full system gives 8.35, and RollSum gives 10.92. **Both the structured state and agentic lookback matter.**
  - **Cost**: about $1.32 per 100K words, mostly cached input.
  - **Evaluation**: the judge scores only the **last 4–10 chapters**, because CED over the full story falls artificially as stories get longer.
- **A Multi-Framework Comparison of Outline Stages** (Aug 2026) https://arxiv.org/abs/2608.26177. Compares 7 frameworks across 3 granularities. No single framework wins everywhere, even 70B models shorten output at 16K tokens, and outline quality correlates only moderately with final prose quality. **Evaluate outlines and prose separately.**

### 1.3 Evaluation and consistency benchmarks
- **ConStory-Bench / ConStory-Checker** ("Lost in Stories", Microsoft and SUTD, Mar 2026) https://arxiv.org/abs/2603.05890
  - Taxonomy: 5 categories and 19 subtypes (Timeline & Plot Logic; Characterization; World-building & Setting; Factual & Detail; Narrative & Style). Metric: CED, errors per 10K words.
  - Findings: Factual/Detail and Timeline errors dominate. Errors grow roughly linearly with length. **Contradictions cluster at 40–60% of the story.** Erroneous spans have about 12–19% higher token entropy. Factual errors co-occur with Characterization and World-building errors, while Style errors are independent.
  - The evidence-citing LLM checker (o4-mini) reached F1 0.678 vs 0.281 for humans on injected errors.
  - Recommendations: long-range memory for time and place, local checks for style, and evidence-grounded judging.
- **FlawedFictions** (UW, 2025) https://arxiv.org/abs/2504.11900. Plot-hole detection: classification plus span localization. SOTA models degrade as stories get longer, and more reasoning budget does not help. LLM-generated stories had more than 100% more plot holes than human originals. **Plot-hole checking over the whole book is unreliable. Scope it to fact ledgers and recent windows.**
- **LongStoryEval** (ACL 2025) https://arxiv.org/abs/2512.12839. 600 books, average about 121K tokens. **Aggregation-based** (score chunks, then aggregate) and **summary-based** evaluation beat incremental-update evaluation. NovelCritique-8B aligns with human ratings better than GPT-4o.
- **WritingBench** (NeurIPS 2025 D&B) https://arxiv.org/abs/2503.05244, github.com/X-PLUG/WritingBench. An LLM generates **5 query-specific criteria** per task and a critic model scores against them. That reached 84% human alignment vs 58–67% for static rubrics. **Generate per-chapter rubric items from that chapter's 细纲.**
- **VOLTBench** (May 2026) https://arxiv.org/abs/2605.01357. Output length collapses badly past about 10K-word targets. Enforce length per chapter, not per book.
- **EQ-Bench Longform** https://eqbench.com/creative_writing_longform.html, github.com/EQ-bench/longform-writing-bench. 8 chapters of about 1K words each.
  - Reports a **degradation** metric (final chapter vs first chapter) and a **slop score** with no LLM involved: 60% over-used words, 25% "not X but Y" constructions, 15% over-used trigrams [secondary on the weights].
  - Penalizes drift into single-sentence paragraphs.
- **Antislop** (Paech et al., ICLR 2026) https://arxiv.org/abs/2510.15061, github.com/sam-paech/auto-antislop. Builds a per-model "slop fingerprint" by comparing n-gram frequency in 2,000 model generations against human corpora. Some patterns are more than 1,000 times over-represented. A sampler and FTPO fine-tuning suppress them. For harness-based writing, sampler and logit control are unavailable, so the usable part is the **forensic list → lint → targeted rewrite** loop.

---

## 2. Open-source projects (layouts and commands)

### 2.1 Built on agent harnesses (Claude Code, Codex, etc.)
| Project | Harnesses | Layout | Commands | Notable mechanisms |
|---|---|---|---|---|
| **oh-story-claudecode** https://github.com/worldwonderer/oh-story-claudecode (zh 网文) | CC, Codex, Antigravity, OpenCode 2.x, others; generic path for any agent that can read files | `大纲/细纲_第021章.md`, `设定/角色/`, `正文/`, `追踪/_tracking-state.json` (**single source of truth**), derived views `上下文.md` (7 fixed sections, **12 KiB cap**), `伏笔.md`, `角色状态/`, `时间线/作者真相.md` vs `读者已知.md`, `逐章记录/` | `/story-setup`, `/story-long-write 写第N章`, `/story-deslop`, `/story-review`, `/story-import`, `/story-long-analyze` (拆文), `/story dashboard`; `$skill` in Codex | All tracking writes go through `scripts/tracking_commit.py`. Hand-editing a derived view fails `check`. Foreshadowing is numbered (F057) and append-only. Hooks block writing without an outline or with an invalid checkpoint. A missing word target **halts** instead of defaulting. No padding, at most one compression pass. 日更 default is 2–3 chapters (max 3 per turn). 开书 builds 细纲 for 10 chapters, then rolls. The deslop pass blocks only on deterministic issues. Hook catalogs: 章尾 13 types and 章首 7 types. |
| **cc-novel-writer / novel-writer-plugin** https://github.com/DankerMu/novel-writer-plugin (zh) | CC plugin | `agents/`, `skills/{start,continue,dashboard,novel-writing}`, `templates/ai-blacklist.json`, `style-profile-template.json`, `hooks/hooks.json` (SessionStart `inject-context.sh`), `scripts/lint-blacklist.sh`, `query-foreshadow.sh`, `eval/` | `/novel:start`, `/novel:continue`, `/novel:dashboard` | Five agents (WorldBuilder, PlotArchitect, ChapterWriter, Summarizer, QualityJudge). **Layered specs**: L1 `rules.json` (hard world rules), L2 `contracts/` (character capability and behavior bounds), L3 `chapter-contracts/` (per-chapter **pre- and post-conditions**), LS `storylines.json`. Eight weighted scoring dimensions; pass at ≥4.0, forced rewrite below 2.0; dual judges on key chapters. De-AI targets: fewer than 3 blacklist hits per 1,000 characters, fewer than 2 repeated sentence patterns in any 5 adjacent sentences. Volumes of 30–50 chapters. Sliding check every 5 chapters, deep review every 10, audit at volume end. |
| **webnovel-writer** https://github.com/981029l/webnovel-writer (v5.2, zh; fork renjade/webnovel-writer-1) | CC | `.claude/{agents,skills,scripts/data_modules,templates/genres,references}`, `.webnovel/{state.json (<5KB), index.db (SQLite entities/aliases/state_changes), vectors.db}`, `正文/第1章-标题.md`, `大纲/总纲.md`, `设定集/` | `/webnovel-init`, `-plan N`, `-write N`, `-review 1-5`, `-query`, `-resume` | The Context Agent builds a bounded pack: 5 recent summaries, 10 appearing characters, 5 most urgent foreshadowing items, plus RAG (vector + BM25 → RRF → rerank). The Data Agent accepts entities by confidence (>0.8 auto, 0.5–0.8 with a warning, <0.5 for review). Five parallel checkers (爽点, consistency, pacing, OOC, continuity). **Strand Weave** ratio Quest/Fire/Constellation 60/20/20: at most 5 Quest chapters in a row, at most 10 chapters without Fire, at least 2 strands per chapter. A git tag per chapter. Three rules: 大纲即法律, 设定即物理, 发明需识别. Claims about 2M characters, without benchmarks. |
| **wordflowlab/novel-writer** https://github.com/wordflowlab/novel-writer (+ `novel-writer-skills`) (zh, spec-kit style) | 13 tools including CC, Codex, Gemini CLI, Cursor, Qwen Code, OpenCode | `.specify/memory/constitution.md`, `spec/{tracking/plot-tracker.json, knowledge/}`, `stories/<x>/{specification.md, creative-plan.md, tasks.md, content/}` | `/constitution` → `/specify` → `/clarify` → `/plan` → `/tasks` → `/write` → `/analyze`; plus `/track`, `/plot-check`, `/timeline`, `/relations`, `/world-check`. The prefix differs per tool (`/novel.x` in CC, `/novel-x` in Codex, `/novel:x` in Gemini). `novel init --all` | Spec-driven flow. The authentic-voice plugin uses `personal-voice.md` (a user writing corpus). Counts Chinese characters. |
| **lihongwen/novelwriting-kit** https://github.com/lihongwen/novelwriting-kit | CC (spec-kit fork) | spec-kit layout | `/constitution /specify /plan /tasks /analyze /implement` | |
| **forsonny/Claude-Code-Novel-Writer** https://github.com/forsonny/Claude-Code-Novel-Writer (en, v4.1) | CC, Codex, Pi | **`AGENTS.md` canonical; `CLAUDE.md` imports it**; `.agents/{roles,skills}` shared; thin adapters `.claude/`, `.codex/{agents,config.toml,hooks.json}`, `.pi/prompts/`; `manuscript/chapters/` authoritative; `planning/ characters/ worldbuilding/ automation/` | `/plan-novel`, `/write-chapter 7` (`$write-chapter 7` in Codex), `/continuity-pass 4-9`, `/revise-chapter`, `/finalize-manuscript` | The best reference for **harness-neutral packaging**. Tracking is derived and regenerable (`sync-state.sh`). `quality-check.sh` records mechanical metrics. |
| **Claude-Book** https://github.com/ThomasHoussin/Claude-Book | CC | `bible/` (read-only), `state/{template,chapter-NN/,current→symlink}`, `story/{synopsis,plan,chapters}`, `timeline/history.md` (append-only), `.work/` (agent scratch) | orchestrator lives in CLAUDE.md | Pipeline: planner → writer → perplexity-improver → style-linter → character-reviewer → continuity-reviewer → state-updater. **At most 3 review loops**, then state is snapshotted per chapter. |
| **story-skills** https://github.com/danjdewhurst/story-skills | CC and Codex plugins (`.claude-plugin`, `.codex-plugin`), `npx skills add` | `story.md` (bible, `schema-version: 2`), `style-sheet.md` (watch words), `characters/ worldbuilding/ plot/ scenes/ continuity/{state.md, promises, questions, clues} glossary/ chapters/`, per-entity md with YAML frontmatter and `_index.md` registries | 24 skills (plan, draft, revise, publish), companion `story` CLI | Promises, questions and clues are first-class continuity objects. Frontmatter schema with a version field. |
| **creative-writing-skills** https://github.com/haowjy/creative-writing-skills | CC | AGENTS.md + `kb/` + style files + `story/` | setup skill interviews the author | Generates AGENTS.md from an interview and writing samples. |
| **autonovel** (NousResearch) https://github.com/NousResearch/autonovel | Python + Anthropic API (autoresearch-style loop) | `program.md`, `CRAFT.md`, `ANTI-SLOP.md` (word-level tells), `ANTI-PATTERNS.md` (structural tells), per novel `voice.md world.md characters.md outline.md canon.md MYSTERY.md state.json` (propagation debts) | `run_pipeline.py --from-scratch` | Gates: foundation >7.5, chapter keep >6.0. Mechanical regex scorer plus a **separate-model** judge. Adversarial "cut 500 words" edit, a 4-persona reader panel, an **Elo tournament** between chapter versions (`compare_chapters.py`), plateau detection, and an Opus dual-persona full-manuscript review. Changes propagate down and up through the layers. First book: 79K words, 24 chapters merged down to 19. |

### 2.2 API-based (pre-agentic reference)
- **ainovel-cli** https://github.com/voocel/ainovel-cli
  - A deterministic **Engine** (no LLM) routes Architect, Writer and Editor. An Arbiter (a single structured call) is used only for semantic decisions.
  - **Rolling planning**: a "compass" (ending direction, active threads, scale) plus two volume skeletons, with detail for the first arc only. Later arcs are expanded on demand from summaries and character snapshots.
  - Files: `timeline.jsonl`, `meta/{foreshadow.json, state_changes.jsonl, snapshots/, checkpoints.jsonl}`, `layered_outline.json`. Writes are atomic (tmp, fsync, rename). Resumes from checkpoints.
  - Context modes switch between full, sliding-window and layered summary for books over 500 chapters.
  - Editor findings **must cite text**. Each role can use a different model.
- **AI_NovelGenerator** https://github.com/YILING0013/AI_NovelGenerator (AGPL-3.0, low maintenance): vector retrieval plus consistency checks, GUI. **Long-Novel-GPT** (MaoXiaoYuZ): RAG agent for revising text and outlines. **AIStoryWriter** https://github.com/datacrystals/AIStoryWriter: mixes models by stage. I could not find a project named "AI-Novel-Writing", "NovelGenerator" (beyond AI_NovelGenerator) or "StoryCraftr"; those names are unverified.

### 2.3 Commercial "story bible" concepts
- **Novelcrafter Codex** https://www.novelcrafter.com/help/docs/codex/anatomy-codex-entry
  - One entry per entity, with **aliases**; the Mentions tab finds every occurrence of a name or alias.
  - **Progressions**: per-entity changes over time, keyed to a point in the story.
  - **Relations**: mentioning an entity auto-includes the entries linked to it.
  - Entries are injected into AI context when their name appears in the beat or scene.
- **Sudowrite Story Bible**: Braindump → Synopsis → Genre/Style → Characters → Worldbuilding → Outline → Scenes/Beats. Prose is generated from beats.
- 2.0 can reproduce Codex behavior with files: per-entity markdown with an `aliases:` frontmatter field, alias-grep to auto-attach entries, and a `progressions:` list keyed by chapter.

---

## 3. Chinese web-novel (网文) practice and how pipelines encode it
I found no official 起点 or 番茄 editorial specs online. What follows comes from practitioner conventions and tool encodings.
- **Structure**: 总纲 → 卷纲 (each 卷 is 30–50 chapters in cc-novel-writer) → 细纲 per chapter, one file each (oh-story `细纲_第NNN章.md`).
  - **Roll the 细纲 forward**: 10 at book start, then add 5–10 more after every 5 written.
  - Each 卷 follows 起承转合 pacing (where to speed up and where to slow down).
- **细纲 fields seen in tools**:
  - 字数范围 (hard; halt if missing)
  - 本章技法
  - 目标情绪
  - 章首钩子 and 章尾钩子 (from a hook catalog)
  - 爽点 type and placement
  - Strands present
  - A **new-item declaration table** (type, name, where it lands, follow-up obligation)
  - A line for 本章没写成的 (delivery debt)
- **黄金三章**: treat it as policy for chapters 1–3 (or 1–4): protagonist plus core hook, a first conflict or 爽点 early, a cliffhanger at the end of each chapter. One industry critique warns against using it as a rigid formula, since a climax needs setup ([toutiao](https://www.toutiao.com/zixun/7512237786566412326/)).
- **爽点节奏**: webnovel-writer encodes about one 爽点 per 1,000–2,000 characters plus strand-ratio rules. cc-novel-writer scores 爽点 and immersion. Judges score a 爽点 checker in parallel.
- **伏笔回收**: a numbered, append-only ledger (F001…) with planted chapter, payoff window and urgency. The context pack surfaces the top N urgent entries (webnovel-writer uses 5). This matches NstAgent's "future requirements" collection.
- **人物弧光**: L2 character contracts (capabilities, behavior bounds, voice) plus per-chapter state snapshots. OOC checks compare behavior against the card.
- **Chapter length**: platform conventions are about 2,000–4,000 字 (typically about 3,000; 番茄 skews about 2,000+). Count CJK characters, not tokens or words. Gate at ±15–20%.
- **日更**: 2–3 chapters per batch (oh-story default). Publish only chapters that passed the gates.
- **拆文/import**: oh-story `story-long-analyze` / `story-import` reverse-engineers existing books into bibles and technique files. This is useful for genre templates.

---

## 4. Consistency at million-character scale

**Representation (consensus across NstAgent, oh-story, webnovel-writer, ainovel-cli, Claude-Book):**
1. **Canonical machine state** in JSON or JSONL, schema-validated and written only through a commit script or tool:
   - `characters` (snapshot per entity)
   - `events` (append-only, chapter-stamped: a temporal fact log, the file-based equivalent of DOME's TKG)
   - `obligations` (foreshadowing, promises, open questions, with due windows)
   - `world_rules`
   - a `reader_knows` vs `author_truth` split (oh-story), which catches premature reveals
2. **Derived markdown views**, regenerated and never hand-edited: context card, foreshadowing table, per-character status, timeline. Agents read views and write deltas.
3. **Per-entity wiki** (Codex-style): `bible/characters/<id>.md` with frontmatter `aliases`, `first_seen`, `progressions[{ch, change}]`, `relations`. Grep on aliases gives exact recall for names. A Chinese name with its nicknames works well as an alias list.
4. **Summary pyramid**: chapter summary (about 200–300 字) → arc summary (about every 10 chapters) → volume summary → book synopsis. LongStoryEval found summary-based evaluation strong, and ainovel-cli uses layered summaries beyond 500 chapters. RollSum alone (one rolling summary) is measurably worse at 100K and beyond (NstAgent).
5. **Snapshots**: a state snapshot per chapter (Claude-Book `state/chapter-NN/`) plus a **git commit or tag per chapter** (webnovel-writer) for rollback and diffing.

**Retrieval:**
- Give the writer a **deterministic, budgeted context pack**. Examples: oh-story's card at 12 KiB or less; webnovel-writer's 5 summaries, 10 characters and 5 foreshadowing items. Add **budgeted lookback tools** so the agent can read chapters and grep.
- NstAgent's ablation shows both channels reduce errors. Harness agents already have Read/Grep natively, so cap them by instruction and audit them through the transcript.
- **Grep vs embeddings**: the Claude Code team moved from a local vector DB to agentic grep because it "generally works better" ([source](https://www.ai.engineer/talks/UM6sFg_jdlE-rag-is-dead-right-kuba-rogut)) [secondary]. For fiction, exact-name grep handles entities. Thematic or scene recall ("the last time they fought by the river") benefits from BM25 with jieba tokenization (NstAgent uses BM25 sentence windows) or optional hybrid vectors (webnovel-writer uses RRF and rerank). Recommendation: grep plus a BM25 index CLI by default, embeddings as an optional plugin.

**Verification:**
- After each chapter, an **extractor agent** emits a state delta: entities, events, obligations opened and closed, new inventions with confidence. A deterministic **diff against canonical state** flags conflicts: dead character appears, item location mismatch, power level regresses, timeline order breaks, a character knows something before being told.
- A **continuity checker** agent reviews the new chapter against the context pack and the last N chapters, using the ConStory taxonomy, and must quote evidence (ainovel-cli Editor and ConStory-Checker both require citations).
- **Periodic audits** with sliding windows (every 5 chapters, deep every 10, at volume end). Concentrate them around **40–60% of each volume/arc**, where ConStory finds contradictions cluster. Score only recent windows, because whole-book checks lose recall (FlawedFictions, NstAgent's evaluation note).
- ConStory reports that entropy over erroneous spans is about 12–19% higher. Harnesses do not expose logprobs, so this does not apply to harness workers. It is usable only if an API-based checker is added.

---

## 5. Quality control

- **Roles**: Planner/Architect, Writer, Extractor/Summarizer, Continuity, Editor/Judge, Reader panel, Deslop. Agents' Room and CritiCS support many critics plus one arbiter. autonovel adds adversarial cutting, a 4-persona reader panel and an Elo tournament between versions.
- **Judge independence**: use a different model or vendor for judging than for writing (autonovel does this; NstAgent flags same-family judge bias). Multi-harness support provides this naturally (for example, write with cc and judge with codex, or the reverse).
- **Rubrics**:
  - cc-novel-writer's 8 weighted dimensions: plot logic 18, character 18, immersion 15, style naturalness 15, foreshadowing 10, pacing 8, emotion 8, storyline coherence 8.
  - Add WritingBench-style **5 chapter-specific criteria** generated from the 细纲 (84% vs 58–67% human alignment).
  - Score outlines separately from prose (outline-stage comparison paper).
  - Use pairwise or Elo for rewrite selection rather than absolute scores.
- **AI味 / slop**:
  - Style anchor from user samples (`personal-voice.md`, style-profile JSON).
  - Blacklist lint (cc-novel-writer target: fewer than 3 hits per 1,000 characters).
  - Repeated sentence-template detector (fewer than 2 in any 5 adjacent sentences).
  - Punctuation and degeneration patterns (oh-story deslop: blocking only when deterministic).
  - Separate structural anti-patterns (autonovel `ANTI-PATTERNS.md`) from word-level tells (`ANTI-SLOP.md`).
  - Build a **per-model slop fingerprint** with the Antislop forensic method against a human Chinese web-novel corpus, and refresh it per model version.
  - Track EQ-Bench-style **degradation**: first vs latest chapter scores, ratio of single-sentence paragraphs, lexical diversity drift per volume.
- **Style drift**: re-inject the style card each chapter. Compare stylometrics (sentence-length distribution, dialogue ratio, paragraph-length histogram) against the anchor every N chapters. Trigger a volume-level polish when drift crosses a threshold.
- **Anti-laziness and length**:
  - The orchestrator, not the agent, verifies the output file exists, CJK count is within ±20% (NstAgent), there is no truncation, there are no placeholders (……此处省略 / TODO / 待续) and there is no meta-commentary.
  - Reject the draft and retry without consuming the chapter slot.
  - Do not pad or invent plot to hit length; at most one compression pass (oh-story).
  - Anthropic's long-running-harness pattern (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents, Nov 2025):
    - Status lives in **JSON** that agents may only toggle (models overwrite JSON less often than Markdown).
    - One unit of work per session.
    - A startup ritual: read the progress log, git log and task list.
    - Commit at the end of each session.
    - Never trust the agent's own claim that a unit is done. This addresses "declaring victory early".
- **Loop bounds**: at most 3 review iterations (Claude-Book). Then escalate the chapter to a "needs human" queue or accept it with debt recorded. Stop rewrite loops on plateau (autonovel).

---

## 6. Recommendations for the Novelist 2.0 design

1. **Topology.** A deterministic orchestrator (state machine, no LLM routing; ainovel-cli Engine) drives **stateless harness workers**, one bounded task per invocation (plan arc, write chapter N, extract, check, judge, deslop). Workers communicate only through files. Each task writes `tasks/<id>/{input.md, output paths, result.json}`, and the orchestrator validates `result.json` and the files themselves, never stdout.
2. **Harness adapter layer.**
   - Each adapter implements `run(task_prompt, cwd, allowed_paths, model, timeout) → exit + files`.
   - Shared core: `AGENTS.md` (canonical) plus `.agents/{roles,skills}`. Thin adapters: `CLAUDE.md` importing `@AGENTS.md`, `.claude/{agents,commands,settings.json hooks}`, `.codex/{config.toml,hooks.json}`, and equivalents for agy/grok/dsh (forsonny and oh-story patterns).
   - Some harnesses load `AGENTS.md` natively, but that has to be checked per CLI by whoever researches the harnesses.
3. **Instruction layering (user-customizable).** `system/AGENTS.base.md` (pipeline contract: file I/O rules, write only under `drafts/`, no prose to stdout) → `genres/<genre>/AGENTS.md` (genre craft, hook catalog, 爽点 patterns) → `projects/<book>/AGENTS.md` and `style/*.md` (user overlay, highest priority). The orchestrator concatenates or symlinks these into each worker's cwd. Users supply their own instruction and style files, and the system treats them as opaque.
4. **Project layout (proposal).**
   ```
   book/
     AGENTS.md  CLAUDE.md(@AGENTS.md)  style/{voice.md, samples/, blacklist.json, fingerprint.json}
     bible/{premise.md, world/rules.json, characters/<id>.md(frontmatter aliases/progressions), factions/, items/, glossary.md}
     plan/{compass.md, volumes/v01.md, arcs/, chapters/ch0001.md(细纲+contract: pre/post-conditions, 字数范围, hooks, 爽点, strands, new-items)}
     state/{canon.json (characters/events/obligations/reader_knows), events.jsonl, foreshadow.json, snapshots/ch0001.json}
     views/{context_card.md(≤12KiB), foreshadow.md, timeline.md, cast.md}   # derived, read-only
     summaries/{ch/, arc/, vol/, book.md}
     drafts/ch0001.rN.md   chapters/ch0001.md (accepted)   reviews/ch0001/{continuity.json, judge.json, lint.json}
     progress.json  checkpoints.jsonl   .git (tag per chapter)
   ```
5. **Per-chapter pipeline.**
   - (a) Orchestrator builds the context pack: 细纲 and contract, context card, last 3–5 chapter summaries, the previous chapter's ending (about 1,500 字), cast cards auto-attached by alias match, top 5 urgent obligations, relevant arc and volume summaries.
   - (b) Writer agent writes `drafts/chNNNN.rK.md`, with a lookback budget (read at most 3 chapters, grep/BM25 at most 5 times).
   - (c) Deterministic gates: length, truncation, placeholders, blacklist and template density, format.
   - (d) Extractor writes `state_delta.json`, which is schema-validated.
   - (e) Canon diff runs, plus a continuity agent with evidence quotes.
   - (f) Judge on a different vendor: rubric plus 5 generated criteria.
   - (g) Deslop pass if needed.
   - (h) Accept: commit the delta, regenerate views, snapshot, git tag. Otherwise revise with the specific findings (at most 3 times), then queue for a human.
6. **Planning.** Rolling hierarchical planning: compass plus volume skeletons, with arc detail expanded about 10 chapters ahead. Plans are gated by their own outline judge. Rewrites of outlines that are allowed to propagate are logged as "propagation debts" (autonovel `state.json`).
7. **Scheduled audits.** Every 5 chapters: sliding continuity window. Every 10: arc summary plus a deep review. At 40–60% of each volume: an extra audit. Volume end: full volume audit, style-drift check and retrospective that updates the genre and slop lists.
8. **Retrieval stack.** Grep and alias index by default (ripgrep plus a frontmatter alias map). BM25 over sentence windows with jieba tokenization as a local CLI tool agents can call. Optional embedding plugin. Everything can be rebuilt from `chapters/`.
9. **Evaluation harness.** A project-level dashboard tracking CED per arc (ConStory taxonomy), judge scores over time (degradation curve), slop density, length distribution, open-obligation aging, and strand ratios. A/B via chapter Elo when switching harness or model.
10. **Robustness.** Atomic writes, checkpoints in JSONL, idempotent tasks, resume from the last checkpoint, per-worker timeouts and kill. Lock the canonical state with single-writer commits so concurrent writes do not corrupt it (v1 hit SQLite lock deadlocks). Workers stay sandboxed to the book directory.

**Decision points to raise with the user**
- Canonical state format: JSON plus derived markdown, or markdown-only.
- Whether embeddings are in scope.
- Strictness on human-in-the-loop (fully unattended vs review queue).
- Writer and judge vendor pairing.
- Chapter length band and 日更 cadence.
- Whether to keep v1's web reader as the publishing front end.
