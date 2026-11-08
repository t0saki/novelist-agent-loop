# Novelist 2.0 实现契约（IMPL）

状态：骨架已建立（2026-11-08，architect 步骤）。本文件是 8 条并行 lane 之间**唯一的协调机制**。
读法：先读 §1 总则和 §2 归属表，再读你自己 lane 的 §3 小节和 §4 数据流；写代码前读 DESIGN.md 中对应章节和 `docs/v2/research/` 中对应的调研文件（harness 的 flag、事件格式、坑都在那里，不要发明 flag）。

优先级（冲突时从高到低）：用户决策（D1–D6，见 §1.4）> 本文件 > DESIGN.md > 调研文件。

---

## 1. 总则

### 1.1 仓库布局

```
package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json  .npmrc
legacy/v1/                      v1 全部代码（server/ web/ Dockerfile docker-compose.yml .env.example .dockerignore），只读参考
packages/shared/                @novelist/shared：zod schema + 类型 + DTO + 纯函数（web 与 server 共用，禁止 node: 内置模块）
  src/ids.ts enums.ts text.ts merge.ts events.ts harness.ts api.ts registry.ts
  src/schemas/{predicate,delta,plan,bible,state,artifacts,genre,book,workorder}.ts
  src/config/{routing,accounts,settings,presets}.ts
  src/ext/lane-{a..h}.ts        各 lane 的共享扩展（只增不改）
apps/server/                    @novelist/server：Fastify 5 + drizzle（pg / PGlite）+ 编排器 + runner
  src/config/   db/   log.ts  app.ts  main.ts  cli.ts  testing.ts
  src/harness/  book/  state/  context/  instructions/  genres/  validators/  pipeline/  orchestrator/  api/  services/
apps/web/                       @novelist/web：React 19 + Vite 8 + Tailwind 4 + TanStack Router/Query + CodeMirror 6
docs/v2/DESIGN.md  IMPL.md  impl/DEPS_REQUESTS.md  impl/CONTRACT_CHANGES.md  research/*.md
```

工具链实际版本（`pnpm install` 时解析出的最新版）：TypeScript **7.0**（原生编译器）、vitest 5、vite 8、zod **4**、drizzle-orm 0.45 / drizzle-kit 0.31、fastify 5、React 19.3、TanStack Router 1.170、Tailwind 4.3、biome 2.6。
命令（在仓库根执行）：

| 目的 | 命令 |
|---|---|
| 全部类型检查 | `npx -y pnpm@10 -r typecheck` |
| 全部测试 | `npx -y pnpm@10 -r test` |
| 单包测试 | `npx -y pnpm@10 --filter @novelist/server test`（`-- src/harness` 只跑某目录） |
| 前端构建 | `npx -y pnpm@10 --filter @novelist/web build` |
| 后端开发 | `npx -y pnpm@10 --filter @novelist/server dev`（tsx watch，`serve`） |
| 前端开发 | `npx -y pnpm@10 --filter @novelist/web dev`（5173，/api 代理到 8000） |
| lint | `npx biome lint .` |
| 生成迁移 | `npx -y pnpm@10 --filter @novelist/server db:generate`（**只有 lane G 执行**，见 §1.3） |

### 1.2 代码规则

- TypeScript strict（`noUncheckedIndexedAccess` 开）、ESM、NodeNext；server 内相对 import 必须带 `.js` 后缀。
- **跨模块只从对方的 `index.ts` import**（`../harness/index.js`、`../book/index.js` …）。例外：只 import 类型时可以直接指向 `types.ts`。
- 共享类型一律来自 `@novelist/shared`；不要在 server 里重复定义 DTO。
- `@novelist/shared` 的 exports 有自定义条件 `source`（指向 `src/*.ts`）：typecheck（`customConditions`）、vitest、vite、`tsx --conditions=source` 直接用源码，不必先构建；生产构建（`pnpm -r build`，按拓扑顺序先 build shared 到 `dist/`）与 `node dist/cli.js` 用 `default` 条件。server 构建后由 `scripts/copy-assets.mjs` 把迁移 SQL、内置指令、内置题材包、工作单模板拷进 `dist/`。新增非 TS 资源目录时同步改这个脚本。
- 骨架中所有未实现函数体是 `throw new Error('TODO(<lane>): …')`。实现时**保持已导出的签名不变**；需要更多参数时加可选参数或可选字段。
- 不要 `pnpm add`。确需新依赖：追加一行到 `docs/v2/impl/DEPS_REQUESTS.md`（包名、版本、理由、lane），先针对它写代码；集成时统一安装。
- 不 commit。
- 中文：UI 文案和内置提示词用简体中文；代码、标识符、日志 key 用英文。
- 内容政策：指令文件（全局 / 题材 / 书 / 角色 / 本章笔记）归用户所有、不透明，原样传递，书层最后、优先级最高。**不加任何内容过滤**。agent 产出一律写文件，stdout 只是遥测。

### 1.3 契约变更规则

- `packages/shared` 由 architect 定稿。并行阶段**只允许增量修改**（新增可选字段、新增导出、给枚举追加取值），禁止改名、删除、收紧校验。
  - 新增的共享符号优先放在本 lane 的 `packages/shared/src/ext/lane-<x>.ts`（已在 index 中导出，不用改 index）。
  - 必须改已有文件时（例如给 DTO 加可选字段），改完在 `docs/v2/impl/CONTRACT_CHANGES.md` 追加一行：日期、lane、文件、改动、原因。
- DB schema（`apps/server/src/db/schema.ts`）归 lane G。并行阶段其他 lane **不改表、不生成迁移**；需要存的东西先放进已有的 jsonb 扩展列（`tasks.params/result`、`chapters.workflow`、`books.meta`、`accounts.body`、`profiles.body`、`settings.value`、`inbox.body`、`runs.outcome`），确需新列/新表时写进 `CONTRACT_CHANGES.md`，由 G 统一加表并生成迁移。
- 跨 lane 的接口签名（§3）若要不兼容变更：在 CONTRACT_CHANGES.md 提出，调用方与实现方都确认后再改。

### 1.4 用户决策（覆盖 DESIGN 中更早的写法）

- **D1** 完整实现 DESIGN（P0→P3 全部机制，可靠性不简化）。务实替代仅限：
  - 没有 Go 工具链 → `nv-shim` 是一个 detached 的 Node 脚本（`apps/server/src/harness/shim/nv-shim.ts`）。
  - `nv-jail`/landlock 只做探测（doctor 显示），不实现。
  - 实现的隔离后端：**`container`（默认）**——Novelist 容器本身是边界，harness 在每个 run 的 git worktree 快照里跑，越界写随快照丢弃，只收割 `out/`；**`bwrap`**——仅当启动探测成功时使用；`degraded` 兜底。
  - 嵌套拆分 runner 容器（DESIGN §10.2.1）在 目标主机上**不做**：单容器 all-in-one，容器边界即 `container` 档。
- **D2（修订）** 所有角色路由、账号/订阅档位、质量档位、规模、吞吐、预算**都在 Web UI（和 book.yaml）里配置**，无需预先决定。
  - 廉价模型（codex `gpt-6-luna`、cc `claude-haiku-5-5`、agy `gemini-3.8-flash-low`）**只用于开发测试**，不是默认值（`tags:['dev']`，只出现在 `dev-cheap` preset）。
  - **默认路由 preset = `agy-argon`：全部角色走 agy + Gemini 4 Argon**（slug 可配置，默认占位 `gemini-4-argon`，以 UI 中 `agy models` 的列表为准）。另有内置 preset：`cc-only`、`codex-only`、`mixed`、`dev-cheap`、`fake`（见 `packages/shared/src/config/presets.ts`）。
  - **默认质量档 = `standard`**（`lite`/`lean`/`standard`/`key` 按书可选）。DESIGN 里“默认 lite”的表述以此为准改写。
- **D3** 部署：Proxmox 主机（arm64，PVE 9.0.10，内核 6.12），Docker LXC（特权、nesting=1、apparmor unconfined），compose 目录 部署目录，主机端口 **8199**，前面是 Nginx Proxy Manager。v1 在那里跑着，Postgres 16（库 `novelist`）。**v2 用同一个 Postgres 上的新库 `novelist2`**，并提供 v1 导入（`NOVELIST_V1_DATABASE_URL` 指向旧库，读 v1 表）。
- **D4** 发布默认：存稿后定时发布，lag ≈ 一个弧（最少 15 章），`require_audited`，`max_buffer` 60 后暂停生产；全部可配置（`zPublishConfig`）。
- **D5** agy（含 consumer OAuth）照常使用，UI 只显示风险说明（`RISK_NOTES`）。dsh 启用，用户在 UI 配 `DEEPSEEK_API_KEY`。cc 同时支持**订阅 OAuth token** 和**自定义 API**（`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，自定义模型名）——用户可能只用 cc 接自己的网关。每个 harness 账号支持：env 变量（key / base URL）、上传凭据文件（codex `auth.json`、grok `auth.json` …）、网页“交互登录”（spawn harness 的登录命令，输出流式给 UI，带输入框）。秘密 AES-256-GCM 加密存储（主密钥 `NOVELIST_MASTER_KEY` 或生成到 `/data/.master_key`）。这推翻了 DESIGN §3.6/§3.7 里“cc token 不经网页、不入库”的写法。
- **D6** 规模（目标字数、卷数、每卷章数、单章长度）按书在 UI 配置（`book.yaml scale`）。
- DB：DESIGN 说“只支持 Postgres，PGlite 推迟”；现在**生产用 pg，开发和测试用 PGlite**（同一 schema、同一迁移）。

### 1.5 已安装依赖

server：fastify、@fastify/{static,cookie,multipart,rate-limit}、zod、drizzle-orm、drizzle-kit、pg、@electric-sql/pglite、yaml、smol-toml、@node-rs/jieba、@node-rs/argon2、execa、pino、nanoid、jszip（EPUB）、croner（cron）、prom-client、diff（三方合并、diff 模式）。
web：react、react-dom、@tanstack/react-router、@tanstack/react-query、@uiw/react-codemirror、@codemirror/{state,view,lang-markdown,lang-yaml}、tailwindcss、@tailwindcss/vite、jsdom、@testing-library/react。
root：typescript、vitest、tsx、@types/node、@biomejs/biome。
未装、按需申请：`better-sqlite3`（DESIGN 的 FTS5；lane B 先用纯 TS BM25 + JSON 持久化）、`libsodium-wrappers`（改用 node:crypto AES-256-GCM）、`zod-to-json-schema`（zod 4 原生 `z.toJSONSchema`，见 `toJsonSchema()`）。

---

## 2. 模块归属

每条 lane 只改自己目录里的文件（测试放在自己目录下的 `*.test.ts`，或 `apps/server/test/<module>/`）。

| Lane | 名称 | 拥有的目录/文件 | 先交付（被别人依赖的） |
|---|---|---|---|
| **A** | harness | `apps/server/src/harness/**`（types、events、registry、runner、shim/、isolation、probe、home、login、install、adapters/*、fake/） | ① fake adapter + `fake/fake-harness.ts`（E/F/G 的测试依赖它）② `runner.startRun/wait` ③ `isolation.probeIsolation`（container/degraded）④ cc、codex、agy adapter ⑤ 登录会话 ⑥ grok、dsh、pi |
| **B** | book + state + context | `apps/server/src/book/**`、`state/**`、`context/**` | ① `book/testing.createFixtureBook` ② `openRepo`/`initBookRepo`/`bookFiles` ③ `createRunSnapshot`/`harvestOut` ④ `fold`/`applyDelta`/`evaluateCard` ⑤ `buildViews`、`buildContextPack`、`AliasIndex` |
| **C** | instructions + genres + 内置提示词 | `apps/server/src/instructions/**`（含 `builtin/contract.md`、`builtin/roles/*.md`、`materialize/*`）、`apps/server/src/genres/**`（含 `builtin/<genre>/`） | ① `resolveStack` + `compileInstructions` + `checkNonces` ② `materializeFor`（claude-code、codex、agy、fake 优先）③ `loadGenre`/`seedBuiltinGenres` ④ 内置中文角色人设与题材包 ⑤ `previewInstructions` |
| **D** | validators | `apps/server/src/validators/**` | ① `runContractGates` ② `resolveEffectiveGates` + `runCraftGates` + `gateVerdict` ③ `matchEvidence`/`verifyQuotes` ④ `deltaCheck` ⑤ `validatePlan`、`REBASE_VALIDATORS` |
| **E** | pipeline | `apps/server/src/pipeline/**`（types、ids、book、workorder、next、registry、handlers/*、templates/*.md） | ① `openBook`、`computeTaskId`、`renderWorkOrder` ② chapter.write/check/extract/review/accept handler ③ plan.* ④ summary/audit ⑤ 其余 kind |
| **F** | orchestrator | `apps/server/src/orchestrator/**` | ① `queue` ② `executor.executeTask` ③ `committer.promote` + 崩溃恢复 ④ `routing.resolveRoute`/`seedRouting` ⑤ `scheduler` ⑥ quota、circuit、publisher、inbox、notify、bus |
| **G** | api + services + cli + db + 部署 | `apps/server/src/{api,services,db,config}/**`、`app.ts`、`main.ts`、`cli.ts`、`log.ts`、`testing.ts`、`apps/server/{package.json,tsconfig*.json,vitest.config.ts,drizzle.config.ts,scripts/}`；根目录 `Dockerfile`、`docker-compose.yml`、`.env.example`、`.dockerignore`、`.github/workflows/*`、`README.md` | ① `services/secrets`（加解密）② `api/server` + auth + SSE ③ `main.startServe` + `testing.createTestApp` ④ 全部路由 ⑤ v1 导入、导出、doctor ⑥ Dockerfile/compose（目标主机） |
| **H** | web | `apps/web/**` | 全部页面（见 §10 路由表与 `apps/web/src/router.tsx`） |

architect 保留：`packages/shared/**`（规则见 §1.3）、根 `package.json`/`pnpm-workspace.yaml`/`tsconfig.base.json`/`biome.json`、`docs/v2/IMPL.md`。

> 注意：root `.github/workflows/docker-publish.yml` 仍然按根 `Dockerfile` 构建，而根 Dockerfile 已移到 `legacy/v1/`。在 lane G 交付新的根 Dockerfile 之前，推送到 main 会让 CI 失败。

---

## 3. 跨模块接口

下面只列被别的 lane 调用的接口；完整签名见源文件（每个文件顶部注释写明语义与 DESIGN 章节）。

### 3.1 shared（所有 lane）

- **ID**：`chapterId(421)='c00421'`、`chapterNo`、`volumeId`、`arcId`、`obligationId`、`tags.chapter/volumeEnd/published`、`isTmpId`；正则 `zChapterId`、`zEntityId`（`char.|loc.|fac.|item.|concept.`）、`zFactId`、`zTmpId`。
- **枚举**：`HarnessId`、`RoleId`、`TaskKind`（附录 B 全部 + `publish`/`routing.feasibility`/`harness.canary`）、`Lane`（write/side/system）、`QualityTier`、`TaskState`、`RunState`、`IsolationBackend`、`ErrorClass`、`AuthMode`、`InboxKind`、`HARNESS_VENDOR`。
- **书库文件 schema**（附录 A）：`zBookConfig`（nv.book/1，**默认值即产品默认**：tier=standard、publish=D4）、`zCompass`、`zVolume`、`zArc`、`zCard`（pre/post/must_not = 谓词 或 op 模式）、`zCharacterArc`、`zStrands`、`zObligationPlan`、`zPlanChange`、`zEntity`（frontmatter）、`zWorldRules`、`zSecret`、`zGlossary`、`zPredicate`、`zDelta`/`zDeltaOp`（20 种 op）、`zOverride`、`zDebt`、`zArcFingerprint`、`zSnapshot`、`zReceipt`、`zCheckOutput`（nv.check/1）、`zReview`、`zAudit`、`zGateResult`、`zValidated`、`zPairwise`、`zPatches`、`zGenrePack`、`zGatesFile`、`zGateOverride`、`zPacing`、`zLexicon`、`zWorkOrderFrontmatter`/`zArtifactDecl`。
- **配置 schema**：`zProfile`、`zRoleRoute`、`zRoutingPreset`、`zRouteDecision`、`zAccount`（env 绑定 / 凭据文件 / customModels / 并发 / reservePct / riskAck）、`zAccountState`、`zSystemSettings`（activePreset 默认 `agy-argon`）、`BUILTIN_PROFILES`、`BUILTIN_PRESETS`、`DEFAULT_PRESET_ID`、`RISK_NOTES`。
- **harness 共享类型**：`zCapabilities`、`zHarnessInstall`、`zOutcome`、`zUsage`、`zQuotaSnapshot`、`zAuthMethodSpec`、`zLoginSession`、`zLoginOutputChunk`、`zIsolationProbe`、`zNEvent`（§3.2 归一化事件）、`NEventBody`（无 seq/ts/runId）。
- **工具**：`countCjk(text, 'han'|'platform')`、`countByBeat`、`stripBeatMarkers`、`BEAT_MARKER_RE`（beat 锚点 = 独占一行的 `<!-- beat:b3 -->`）、`normalizeForMatch`、`mergeLayers`（书 > 题材 > 全局 > 内置，深合并、数组整体替换）、`SCHEMAS`/`schemaForPath`/`JSONL_SCHEMAS`、`toJsonSchema(schema, 'lenient'|'strict')`（strict = codex 方言）。
- **API**：全部 DTO 与 `ROUTES` 路由表（§10）、`SseEvent`。

### 3.2 lane A — harness

```ts
// harness/types.ts
interface HarnessAdapter {
  id; displayName; vendor; supportedVersions;
  authMethods(): AuthMethodSpec[];                       // UI 渲染账号表单（env、可上传文件、登录命令、风险说明、是否允许自定义模型）
  detect(harnessDir): Promise<{binPath, version} | null>;
  listModels(acct: ResolvedAccount, inst): Promise<string[]>;   // agy: `agy models`；并入 acct.customModels
  prepareHome(acct, inst, spec): Promise<HomeLayout>;    // 配置部分每 run 重写
  materialize(spec, compiled, caps): Promise<MaterializeResult>; // = instructions.materializeFor(this.id, …)
  buildInvocation(spec, caps, home, mat, acct, inst): Invocation;
  createParser(spec): StreamParser;                      // 只按 LF 切行；未知 → {t:'unknown'}；绝不抛
  classify(exit, events, stderrTail): Outcome;           // §3.3：只看终止事件与退出码
  quotaProbe?; probe(inst, acct, ctx): Promise<Capabilities>;
  loginCommand?(acct, inst, mode): LoginCommand | null;  // 网页交互登录
  gcHome?;
}
// harness/runner.ts
startRun(p: PreparedRun, sink: RunEventSink): Promise<RunHandle>   // prepareHome→materialize→buildInvocation→wrapInvocation→spec.json→detached nv-shim
reattachRun(runDir, adapter, spec, sink, fromSeq): Promise<RunHandle | null>
RunHandle.wait(): Promise<RunResult>   // {outcome, exit, eventCount, audit, stdoutFile, stderrTail}
RunHandle.kill('user'|'shutdown')
runShort(inv, timeoutMs)               // probe/listModels 等短命令
// harness/isolation.ts
probeIsolation(pref): Promise<IsolationProbe>;  mountPlanFor(spec, stateDirs, extraRo);  wrapInvocation(inv, backend, plan);
isAllowed(shellTool, harness, backend);  postRunAudit({outDir, declaredGlobs, homeConfigHashes})
// harness/home.ts
accountHome(paths, id);  resolveAccount(acct, paths, secrets): Promise<ResolvedAccount>;  syncBackCredentials(acct, secrets)
// harness/login.ts
createLoginManager({onFinished}): LoginManager   // start(adapter, acct, inst, mode) → LoginHandle{session(), output(), write(), cancel(), subscribe()}
// harness/probe.ts / install.ts
detectInstalls(harnessDir);  runProbe(...);  defaultCapabilities(h, v, iso);  planInstall(...);  installHarness(...)
```

语义要点：
- `ResolvedAccount.secretEnv` 只在内存里，绝不进日志和 DB；`RunHandle.argvPreview` 里的秘密要打码。
- 订阅模式（cc `subscription_login`/`oauth_token`）下，adapter 断言 env 中没有 `ANTHROPIC_API_KEY`；`custom_api` 模式反过来要求 `ANTHROPIC_BASE_URL` 加 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` 之一，模型名取 profile.model（允许任意字符串）。
- codex 在本 LXC 里 workspace-write 沙箱会失败，所以固定用 `--dangerously-bypass-approvals-and-sandbox`（隔离由外层负责）。本机验证可用：`codex exec -m gpt-6-luna --dangerously-bypass-approvals-and-sandbox`（自定义 provider 已配置）。
- agy 本机验证可用：`agy -p … --model gemini-3.8-flash-low --dangerously-skip-permissions --output-format json` 输出 `{conversation_id,status,response,usage}`；`agy models` 输出 `slug\tlabel`。
- 交互登录用管道（不做网页终端）；需要 TTY 的 CLI 由 adapter 用 `script -qfc` 包装。
- fake：stdout 每行已经是 `NEventBody` 形状；根据 work order frontmatter 的 `artifacts` 写出合法产物；`frontmatter.fake` 或 `$RUN/in/fake.json` 提供故障注入（见 `adapters/fake.ts` 注释）。

### 3.3 lane B — book / state / context

```ts
// book
P.*（布局路径函数）  BOOK_GITIGNORE  ENTITY_DIRS  pathOwner(rel)
openRepo(dir): BookRepo   // head/readFile(rel, rev?)/exists/list/blobShas/writeFiles(原子)/commit({message, trailers, paths?, tags?})
                          // findCommitByTrailer/log/changedPaths/resetHard/isClean/tag/tags/fsck
initBookRepo(dir, {config, premise}): Promise<{repo, commit}>
ensureGitRepo(dir)
TRAILER.*  formatTrailers  parseTrailers
createRunSnapshot(bookDir, baseCommit, dest): Promise<RunSnapshot>;  removeRunSnapshot;  pruneWorktrees
harvestOut(outDirAbs, liveBookDir, taskId, attempt): Promise<{stagedDir, files}>   // → live 树 work/<task>/attempt-k/out
bookFiles(repo): BookFiles   // 类型化读取全部规范文件（zod 校验；失败抛 CanonicalParseError）
parseFrontmatter / formatFrontmatter
createFixtureBook(dir, {accepted, cards}): Promise<{repo, head}>   // 测试夹具（优先交付）
// state
fold({entities, world, ledger, overrides, chapterCjk?}): Snapshot   // 纯函数
ledgerHash(ledger, overrides);  applyDelta(snapshot, delta)
evaluatePredicate(p, s): true|false|'manual'|'unresolved';  matchOpPattern(pattern, delta);  evaluateCard(card, before, delta?, after?)
projectBuffer(s, bufferCards): {before[], stale[]};  cardsTouchedBy(delta, cards)
resolveTmpIds(files, ctx): {mapping, files};  slugifyName(name, taken)
buildViews(bookDir, {through?}): Promise<{snapshot, written}>   // views/*（gitignored）
cascadeReplay({replaceAt, newDelta, ledger, check, foldUpTo})
// context
buildContextPack({bookDir, card, snapshot, quotas?, sampleSeed?}): Promise<ContextPack>   // 单文件，固定 section 配额，合计 65k
buildCheckSlice({bookDir, card, snapshot}): Promise<string>     // chapter.check 用的瘦身输入
tokenize(text)（jieba）  createBm25Index / loadBm25Index / rebuildIndex(bookDir)
buildAliasIndex(entities): AliasIndex   // scan / resolve(ambiguous 消歧) / names
truncateCjk(text, max, 'head'|'tail')
```

语义要点：
- 仓库写操作只由 committer（lane F）在持锁时调用；B 提供原语，不自己加锁。
- `initBookRepo` 写 `.gitignore`（`work/ .index/ .cache/ views/ state/snapshot.json`）和 `.claude/skills -> ../.agents/skills` 软链，`git config core.fsync all`。
- `fold` 必须是确定性纯函数（属性测试：同输入同输出、`snapshot == fold(ledger, overrides)`）。
- `blobShas` 对不存在的路径返回 `''`，manifest 与 stale check 依赖这个约定。

### 3.4 lane C — instructions / genres

```ts
resolveStack({globalDir, genreDirs, bookDir, role, taskKind, ownerNotes, drafts?}): Promise<InstructionStack>
compileInstructions(stack, {nonces: 'random'|'placeholder', rng?}): CompiledInstructions
  // → {systemMd(含 nonce), mirrorMd(无 nonce), layers, nonces, stackHash(无 nonce 内容 hash), bytes, lastAuthorLayerId}
generateNonces(layerIds, rng?);  measure(text)
checkNonces({nonces, echoed, events, inDir, role}): NonceCheckReport   // tainted / missingTail / ok
expandIncludes(text, baseDir, read)
checkBudget(harness, compiled, caps): BudgetResult    // 超限拒绝，不截断
materializeFor(harness, {harness, spec, compiled, caps, personaMode, home}): Promise<MaterializeResult>  // {files, argv, env, budget, notes}
tomlBasicString(text);  escapeDshTemplate(text)
renderWorkspaceDoc({bookTitle, contract, skills});  renderSkills({bookDir, genreDirs, globalDir});  isWorkspaceDocModified
previewInstructions(req, {paths, bookDir}): Promise<InstructionPreview>
// genres
loadGenre(paths, id): Promise<ResolvedGenre>   // {pack, chain(base 在前), gates[], pacing(合并), lexicon(合并), eventFamilies}
listGenres / genreExists / seedBuiltinGenres / createGenre
BUILTIN_INSTRUCTIONS_DIR  BUILTIN_GENRES_DIR
```

语义要点：
- 层顺序（§5.1）：`S0 contract → S1 内置角色 → L1 全局 AGENTS.md → L1 全局 roles/<role>.md → L2 每个题材（链上按 base→self）AGENTS.md 与 roles → L3 书 instructions/AGENTS.md → L3 书 roles/<role>.md →（若有）L3 书 tasks/<kind>.md → L3.9 owner 笔记`。golden test：任意组合下最后一个作者块来自 L3 或 L3.9。
- 角色文件首行 `@extends` = 追加，否则在同一来源层内替换更低层的同名角色；不论哪种都不会排到书层之后。
- nonce 标签：`NV-C-HEAD-<rand>`（S0 只有 head）、`NV-S1-*`、`NV-G-*`、`NV-R-*`（每个题材层）、`NV-B-*`、`NV-N-*`；rand 为 12 位 base32。
- 编译器从不改写、过滤、摘要或重排用户文本。
- `previewInstructions` 的生效 gate 清单调用 lane D 的 `resolveEffectiveGates`。

### 3.5 lane D — validators

```ts
resolveEffectiveGates({builtin, global, genre[], bookFile, bookOverrides}): EffectiveGate[]   // contract 类固定在前、不可关
runContractGates({outDir, artifacts}): Promise<ContractReport>   // {results, ok, receipt, files(已解析), extraFiles}
checkTruncation(text)
runCraftGates({draft, card, length, gates, lexicon, isFinal, recent?, protectedTerms?}): GateResult[]
gateVerdict(results): {ok, hardFailed, softFailed, lengthOnly, suggestion: 'none'|'expand'|'compress'|'revise'}
matchEvidence(draft, ev, {fuzzyThreshold?}): {kind: 'exact'|'fuzzy'|'none', start?, end?, replacement?, ratio?}
verifyQuotes(text, quotes)
deltaCheck(input: DeltaCheckInput): DeltaCheckReport   // {ok, delta(已修 ev), hard, soft, dropped, reextract, recallMisses, unmetPost, mustNotHits, leaks, confirmedFlags, attribution}
checkSummaryAnchors(delta, maxUnanchored=0.3);  verifyFormatRepair(original, repaired, draft)
validatePlan({compass, volumes, arcs, cards, snapshot, fingerprints, changed})
REBASE_VALIDATORS: Record<name, (bookDir, target) => Promise<{ok, reason?}>>
```

语义要点：D 只做确定性检查，不调模型、不写文件、不读 DB。nonce 核对结果由调用方（E）以 `contract.nonce` 规则并入 GateResult。

### 3.6 lane E — pipeline

```ts
// pipeline/types.ts（核心契约，先读这个文件顶部注释）
TaskSpec { kind, bookId, target, lane?, role?, tier?, priority?, params?, deps?, notBefore?, parentTaskId?, maxAttempts? }
Manifest { hard: Record<path, blobSha>, soft: Record<path, blobSha>, rebaseValidators: string[], configHash }
RunContext { runId, attempt, runDir, snapshotDir, outDir, inDir, baseCommit, profileId, accountId, harness, model, role, degraded[] }
AgentPlan { frontmatter(不含 schema/task_id/run_id/out_dir), body, inputs[{from, to}], ownerNotes[], limits?, resume? }
PrepareResult = {kind:'run', plan} | {kind:'skip', result}
HarvestedRun { run, outcome, stagedOutDir, files, artifacts, nonce, audit }
TaskResult { status: 'done'|'retry'|'failed'|'blocked'|'hold'|'waiting', errorClass?, message?, retryAfter?, avoidProfile?,
             promote?: PromotePlan, followups?: TaskSpec[], inbox?: InboxInput[], chapter?: {no, state, workflow?}, summary? }
PromotePlan { bookId, taskId, runId, baseCommit, files: FileChange[], resolveTmpIds, message, trailers, tags, dbEffects?(tx, sha) }
TaskHandler { kind, role(null=确定性), lane, maxAttempts, manifest(ctx, spec), prepare?, finalize?, execute?, rebase? }
// 其他
HANDLERS / handlerFor(kind)             // 每个 TaskKind 都有（测试断言）
computeTaskId(spec, manifest, stackHash) / manifestHash / PIPELINE_VERSION
openBook(deps, idOrSlug): Promise<BookHandle>   // {id, slug, dir, repo, files, config, genre, headCommit}
effectiveTier(book, no): 'lite'|'standard'|'key'
initialTasks(book, {interview}): TaskSpec[]
nextTasks(ctx, state: BookRuntimeState): Promise<TaskSpec[]>   // 书级 DAG（滚动规划、单章、审计、摘要）
onTaskDone(ctx, task, result): Promise<TaskSpec[]>             // 章节状态机推进
renderWorkOrder(fm, body) / parseWorkOrder(text) / renderTemplate(kind, vars)
```

语义要点：
- E 决定“做什么、产物是什么、怎么验收”；F 决定“何时、用谁、在哪跑、怎么提交”。E 不直接 spawn、不直接 git commit、不直接改 tasks 表（通过返回 TaskResult）。
- 章节流水线状态存 `chapters.state` + `chapters.workflow`（jsonb，E 自定结构：当前 attempt、草稿位置 `work/<task>/attempt-k/out/...`、修订次数、各 gate 结果、降级记录）。
- 草稿等中间产物只在 live 树 `work/`（gitignored）；下游任务通过 `AgentPlan.inputs` 把它们带进 run（复制到 `$RUN/in/inputs/`）。
- stdout 永远不当正文；产物缺失按 §3.3 判 `output_contract` / `permission_denied`。

### 3.7 lane F — orchestrator

```ts
createEventBus({pgNotify?}): EventBus   // publish(SseEvent) / subscribe(cb, filter?)
enqueue(db, {spec, id, manifest, baseCommit}) / claimNext(db, filter) / renewLease / completeTask(db, id, result) / setTaskState / reapExpiredLeases
resolveRoute(db, {role, book, tier, writerVendor?, avoidProfiles?, now}): ResolvedRoute
effectiveRouting(db, book) / checkFeasibility(db, book) / seedRouting(db)
expectedChapterCost / expectedTaskCost / reserve / settle / sleepAccount / expireReservations
recordRun / circuitState
withRepoLock(db, bookId, repo, fn) / promote(db, repo, task, manifest, plan, meta) / commitOwnerEdit(...) / recoverBook(...)
executeTask(deps: ExecutorDeps, task, signal): Promise<TaskResult>
createScheduler(deps, {tickMs?, maxConcurrent?}): Scheduler   // start/stop/tick/runUntilIdle
bufferState / nextSlots / publishTick
createInboxItem / actOnInbox / expireInboxTimeouts
notify(db, settings, event)
createOrchestrator(deps): Orchestrator   // API/CLI 门面：startBook/bookAction/chapterAction/retryTask/cancelTask/killRun/actInbox/publishNow/feasibility/runUntilIdle
```

语义要点：
- 生效路由 = book.yaml `routing.roles` > book.yaml `routing.preset` > `settings['routing.active']`（`{presetId, overrides}`，默认 `{presetId:'agy-argon'}`）。
- `seedRouting` 首次启动写入 `BUILTIN_PROFILES`/`BUILTIN_PRESETS`（`builtin=true`），已存在不覆盖；`fake` profile 与 preset 只在 `allowFakeHarness` 时可被路由选中。
- 写手粘性：`writer.sticky='book'` → 首次解析出的 profile 写入 `books.writer_profile`；额度耗尽 `on_quota:'wait'`，不切写手。
- 每本书写作 lane 同时最多 1 个任务；side lane 并发受 committer 锁约束；全局并发 `settings.maxConcurrentRuns`；账号并发 `account.concurrency`。
- 任何 DB 事务都不跨越模型调用。

### 3.8 lane G — api / services / cli / db

```ts
loadConfig(env): AppConfig;  dataPaths(root): DataPaths          // config/index.ts（已实现）
openDb({url, pgliteDir}): DbHandle;  migrate(h);  ping(h)          // db/client.ts（已实现）
createTestDb(): DbHandle                                           // db/testing.ts（已实现：内存 PGlite + 迁移）
schema.*（29 张表，见 §6）                                          // db/schema.ts（已实现）+ db/migrations/0000_init.sql
createLogger / silentLogger                                         // log.ts（已实现）
loadMasterKey / encrypt / decrypt / createSecretStore(db, key): SecretStore   // services/secrets.ts
hashPassword / verifyPassword(支持 v1 pbkdf2$) / passwordLookupId
buildEpub / buildTxt;  previewV1 / startV1Import;  createBook / deleteBook / reindexBook;  runDoctor
buildServer(deps): FastifyInstance;  requireRole;  ensureAdminPassword;  openSse;  HttpProblem
startServe(config): RunningApp;  main(argv)（cli）;  createTestApp({http?, preset?}): TestApp
AppDeps { config, paths, dbh, db, log, bus, secrets, orchestrator, logins, masterKeySource, startedAt }
```

语义要点：
- `NOVELIST_DATABASE_URL` 指向的库不存在时（错误码 `3D000`），连同一服务器的 `postgres` 库执行 `CREATE DATABASE novelist2`，再迁移。
- cookie `Secure` 按请求协议决定（`trustProxy` 时看 `X-Forwarded-Proto`），`NOVELIST_INSECURE_COOKIES=1` 强制关闭。目标主机 在 NPM 后面，默认只信任回环和私网网段（`loopback,uniquelocal`），避免 X-Forwarded-For 伪造。
- 秘密值从不出 API：`AccountView.env[].set` 只告诉是否已设置；凭据文件只有 sha256 和大小。
- v1 导入读 `NOVELIST_V1_DATABASE_URL`；v1 表结构见 `legacy/v1/server/app/db/models.py`（`novels`、`chapters`、`themes`、`reader_passwords`、`reading_progress`、`settings`、`llm_profiles`、`jobs`、`usage_ledger`、`images`、`novel_embeddings`）。v1 密码格式 `pbkdf2$<rounds>$<salthex>$<dkhex>`（sha256）。

### 3.9 lane H — web

- 路由树在 `apps/web/src/router.tsx`（代码式，TanStack Router）。读者端：`/login`、`/`、`/books/$slug`、`/read/$slug/$no`（沉浸式阅读：点按正文切换上下栏 + 全屏，沿用 v1 交互）。管理端 `/admin/**` 见 `AdminLayout` 导航与 §10 路由表。
- 数据一律经 `src/api/client.ts`（`get/post/put/patch/del` + `openEventStream`），类型来自 `@novelist/shared`。
- 编辑器统一用 `src/components/CodeEditor.tsx`（CodeMirror 6，markdown/yaml）；保存书库文件前先调 `/file/impact`，`needsConfirm` 时弹二次确认。
- 账号页按 `HarnessStatus.authMethods` 渲染表单（env 输入框、文件上传、交互登录按钮 + 输出面板 + 输入框、风险说明、自定义模型名）；模型下拉框用 `GET /api/admin/harness/:id/models`，同时允许手填。
- 不确定的业务字段先按 DTO 渲染；缺字段时在 CONTRACT_CHANGES.md 申请（不要自造接口）。

---

## 4. 一章的端到端数据流

默认档 `standard`（D2 修订）。`lite` 的差异放在最后。下文 `[X]` 表示由哪条 lane 的哪个函数完成。

**0. 调度**：`[F scheduler.tick]` 对每本 `status=active` 且未暂停的书：
`[E openBook]` → `[E nextTasks(ctx, BookRuntimeState)]` 返回 `TaskSpec[]`。例如卡片余量 ≥ min、无在跑的写作任务、存稿 < max_buffer 时，返回 `{kind:'chapter.write', target:'c00421', lane:'write'}`。
对每个 spec：`[E handlerFor(kind).manifest(ctx, spec)]` → `[C resolveStack + compileInstructions(placeholder)]` 取 `stackHash` → `[E computeTaskId]` → `[F enqueue]`（同 id 已存在则忽略）。

**1. 认领与路由**：`[F claimNext]`（`FOR UPDATE SKIP LOCKED`，lease 60s）→ `[F executeTask]`：
- `[F resolveRoute(role='writer')]` → profile/account（粘性写手）；没有可用的 → `waiting`（`waitUntil`）。
- `[F expectedChapterCost + reserve]`：按整章期望消耗向所有涉及账号预留；放不下 → `waiting`。
- 写 `runs` 行（`state=preparing`），`$RUN=$DATA/runs/YYYY-MM/<runId>`，软链 `runs/active/<runId>`。

**2. 快照与工作单**：
- `[F withRepoLock]` 内 `[B createRunSnapshot(bookDir, base_commit=HEAD, $RUN/book)]`，然后释放锁。
- `[B buildViews($RUN/book)]` → snapshot + `views/*`（ctx.build）。
- `[E chapter.write.prepare(ctx, task, run)]`：
  - `[B evaluateCard/projectBuffer]`：投影 pre 不成立 → `{kind:'skip', result:{status:'done', followups:[card.repair]}}`；
  - `[B buildContextPack]` → 内联进正文；`[E renderTemplate('chapter.write')]`；
  - 返回 `AgentPlan`：frontmatter.artifacts = `[{path:'manuscript/c00421.md', kind:'chapter_draft', length}, {path:'receipt.json', kind:'receipt', schema:'nv.receipt/1'}]`；`ownerNotes` = 卡片 `notes` + Inbox 附笔记。
- `[F]` 写 `$RUN/in/workorder.md`（`[E renderWorkOrder]`，补 task_id/run_id/out_dir），复制到快照 `work/<task>/workorder.md`；写 `$RUN/in/receipt.<dialect>.json`（`toJsonSchema(zReceipt, caps.schemaDialect)`）；复制 `plan.inputs`。
- `[C resolveStack({…, ownerNotes}) + compileInstructions(random)]` → `$RUN/in/system.md`。

**3. 执行**：`[A resolveAccount]` → `[A startRun(PreparedRun, sink)]`：
`prepareHome` → `materialize`（`[C materializeFor]`；`budget.ok=false` → 该 profile 不可承载，`avoidProfile` 后重路由）→ `buildInvocation` → `wrapInvocation(container|bwrap)` → `spec.json` → detached `nv-shim`。
`sink.onEvent` → `[F]` 批量写 `run_events`、`bus.publish({type:'run_event'})`、续租 lease；`rate_limit` 事件 → `[F quota]` 记快照。
`handle.wait()` → `RunResult{outcome, exit, audit}`。

**4. 收割**：`[B harvestOut]` 把 `$RUN/book/work/<task>/attempt-k/out` 复制到 live 树同名目录 → `[B removeRunSnapshot]`。
`[C checkNonces]` → `NonceCheckReport`。`[F]` 组装 `HarvestedRun`。

**5. 验收（E 的 finalize）**：`[E chapter.write.finalize]`：
- `[D runContractGates]` + nonce 结果 → 不过 → `{status:'retry', errorClass:'output_contract'}`（同 profile 2 次后 `avoidProfile`）；writer 缺作者层 TAIL nonce 同样按 `output_contract` 处理（§5.6）。
- `[D resolveEffectiveGates + runCraftGates + gateVerdict]` → hard 失败 → followup `chapter.revise|expand|compress`（mech，≤2；长度类耗尽 → accept_with_debt）。
- 通过 → `chapter` 状态改为 `checking`，followup：standard → `chapter.extract`；lite → `chapter.check`。
- 这一步**没有 promote**（草稿不入库）；`TaskResult.chapter` 更新 `chapters.state/workflow`。

**6. 抽取与 delta.check**（`chapter.extract` 或 lite 的 `chapter.check`，同 1–4 步，role=extractor/checker）：
- 输入：草稿（`inputs`）、卡片、`[B buildCheckSlice]`；产物 `delta.json`（nv.delta/1）或 `check.json`（nv.check/1）。
- finalize：contract gate；schema 不合法 → `format.repair`（≤1，`[D verifyFormatRepair]`）→ 仍不合法 → 重跑（≤1）。
- `[D deltaCheck({delta, draft, card, before: snapshot, world, secrets, overrides, eventFamilies, aliases})]`：
  - `reextract` 非空 → 定向补抽（并入一次 run，≤2）；
  - `unmetPost` → `chapter.confirm`（引文）→ 有引文补 op，没有 → `chapter.revise(canon)`；
  - hard 冲突 → `chapter.revise(canon)`；
  - ok → standard：`chapter.review`；lite：直接 `chapter.accept`。

**7. 评审**（standard：continuity + judge 一个 run，`constraint: vendor_ne_writer`，降级按 §7.4 阶梯并记入 review.degraded）：
- 产物 `review.json`（nv.review/1，含 `missing_ops[]`、`conflicts_with_author_layer`）；`[D verifyQuotes]` 逐字校验，missing_ops 合并进 delta 再跑一次 `deltaCheck`。
- `verdict=revise` → `chapter.revise(findings)`（revision_brief 排除 `conflicts_with_author_layer=true` 的建议，标注“评审建议（优先级低于作者指令）”）→ gate → extract(diff) → pairwise（opt-in）…（≤2）。
- 耗尽策略按 `book.yaml policy.on_exhausted`（普通章/关键章）。

**8. 提交**（`chapter.accept`，确定性，`[E chapter.accept.execute]` → PromotePlan）：
- files：`manuscript/c00421.md`（`stripBeatMarkers`）、`state/ledger/c00421.json`、`reviews/c00421.json`、`debt.jsonl` 增量、标题采纳（receipt.title_proposal → 卡片）。
- trailers：`Novelist-Snapshot-Hash`（`[B ledgerHash]`），其余由 committer 自动加上（Task/Run/Harness/Model/Instructions/Isolation）。tags：`ch/00421`。
- `dbEffects`：`chapters`（state=accepted、cjk、accepted_commit）、`books`（accepted_through、total_cjk、cursor）。
- `[F promote]`：写 `VALIDATED.json` → `withRepoLock` → stale check（`[B blobShas]` 对比 manifest：hard 变 → stale 重派；只有 soft 变 → `handler.rebase`）→ `[B resolveTmpIds]` → `[B writeFiles + commit + tag]` → 释放锁 → `dbEffects` → `bus.publish({type:'chapter_accepted'})` → `[B buildViews(live)]` 刷新缓存、BM25 增量。
- `[E onTaskDone]` → 后续：`[B projectBuffer]` 校验全部缓冲卡（stale → `card.repair`）；每 5 章 `audit.window`；弧末 `summary.arc` + `audit.arc`；卷末 `summary.volume` + `audit.volume` + `book.blurb`；卡片余量 ≤ min → `plan.arc`（写作 lane 让出提交窗口）。

**9. 发布**：`[F publishTick]`（每分钟）按 cadence 槽位：`audited_through ≥ no` 且存稿 ≥ lag → 入队 `publish` → `[E publish.execute]`：tag `pub/00416`、`chapters.published_at`、`books.published_through` → `bus.publish({type:'chapter_published'})`。存稿 > `max_buffer` → `books.paused_reason='max_buffer'`，回落到 `resume_buffer` 以下再恢复。

**10. 结算**：`[F settle]`（usage_ledger、util_delta、释放预留、`resetsAt` → `sleepAccount`）、`[F recordRun]`（熔断统计）、`runs.state=finalized`、删除 `runs/active/<id>` 软链。

**lite 档差异**：第 6 步用一次 `chapter.check`（delta + 带锚点的摘要 + `continuity_flags[]`），flags 经 `[D deltaCheck.confirmedFlags]` 复核后才触发修订，否则记 soft 债务；跳过第 7 步。`key` 档：第 7 步为 continuity ∥ judge×2 + 分歧仲裁，修订上限 3。

**崩溃恢复**：
- serve 崩溃：shim 仍在跑；重启后 `[F]` 扫描 `runs/active/*` → `[A reattachRun]`（pid 与启动时间匹配）→ 从 `run_events` 最大 seq 之后继续 tail。接管不了 → run 标 `lost`，任务回 ready（attempt 不加）。
- promote 中断：`[F recoverBook]`（持锁）→ `[B findCommitByTrailer('Novelist-Task', id)]` 已提交 → 重放第 8 步的 dbEffects；否则 `[B resetHard]` 后用 `VALIDATED.json` 重来。

## 5. 其他流程

- **开书**：`POST /api/admin/books` → `[G createBook]`：`[C genreExists]`（不存在 → 400，“无题材不立项”）→ `[B initBookRepo]`（book.yaml 只写用户显式给出的键 + slug/title/genre）→ 插入 `books` → `[F orchestrator.startBook]` → `[E initialTasks]`：`plan.interview?` → `plan.premise` → `plan.compass`（approval）→ `plan.bible` → `plan.volumes` → `plan.volume(v01)`（approval）→ `plan.arc(a0001)` → cards → `routing.feasibility` → 写作 lane。
- **owner 编辑书库文件**：`PUT /api/admin/books/:slug/file` → `[F commitOwnerEdit]`（同一提交协议，trailer `Novelist-Owner-Edit`）→ 使相关待执行任务失效；正文手改 → `chapter.reextract(diff)` → `[B cascadeReplay]`。保存前用 `/file/impact` 估算（`ImpactEstimate.needsConfirm`，阈值见 `book.yaml budgets.rerun_confirm_*`）。
- **交互登录**：`POST /api/admin/accounts/:id/login` → `[A resolveAccount]` → `[A LoginManager.start(adapter, acct, inst, mode)]` → 输出经 `bus.publish({type:'login_output'})` 与 `GET …/login-sessions/:sid/stream` 推给 UI；`POST …/input` → `handle.write`；成功后 `onFinished` 把 home 里新增或变化的凭据文件加密登记到账号（`credential_file`，part=state）。
- **v1 导入**：`POST /api/admin/import-v1/preview|import-v1` → `[G previewV1/startV1Import]`；导入的书默认 paused（未完结）或 archived（已完结）；可选 `import.bootstrap`（`[E]`，只交给没有 shell 的 profile）。
- **探测**：启动时 `[A probeIsolation(settings.isolation)]`、`[A detectInstalls]`；`POST /api/admin/harness/:id/probe` → `[A runProbe]` 写 `capabilities`。没有 probe 记录时用 `[A defaultCapabilities]`（标 unverified，允许运行——目标主机上要能直接用，不强制先 canary）。

## 6. DB 表概要

源：`apps/server/src/db/schema.ts`，迁移 `apps/server/src/db/migrations/0000_init.sql`（drizzle-kit 生成；pg 与 PGlite 共用）。

| 表 | 主键 | 用途 / 关键列 |
|---|---|---|
| `books` | id | slug(uq)、genre、status、tier、priority、cursor、accepted/audited/published/cards_through、total_cjk、format_version、head_commit、writer_profile、paused_reason、endgame、v1_id、meta |
| `chapters` | (book_id, no) | chapter_id、title、volume、arc、state（ChapterWorkflowState）、**workflow jsonb（E）**、cjk、accepted_commit、audited、published_at、verdict、revisions、degraded、debts |
| `book_events` | id | append-only 时间线 |
| `tasks` | id（内容 hash） | book_id、kind、target、lane、role、tier、priority、deps[]、state、base_commit、hard/soft_manifest、rebase_validators[]、**params/result jsonb**、attempts/max_attempts、last_error_class、wait_reason、not_before、lease_owner/expires |
| `runs` | id（uuid） | task_id、attempt、role、profile_id、account_id、harness(+version)、model/model_reported、isolation、state、lease、shim_pid/start、harness_pid、exit_code、error_class、outcome、usage、nonce_report、denials、run_dir、base_commit、stack_hash |
| `run_events` | (run_id, seq) | ts、t、body（NEvent）；按 ts 清理（30 天）。DESIGN 的按月分区为兼容 PGlite 改为普通表 |
| `accounts` / `accounts_state` | id / account_id | Account（body jsonb，秘密只存 secretId）；sleep_until、util、cred_expires_at、last_auth_check |
| `profiles` / `routing_presets` | id | Profile / RoutingPreset（body jsonb，builtin 标记） |
| `usage_ledger` | id | 每 run 的 token、util_delta（主口径）、usd（API key 账号） |
| `quota_reservations` / `quota_snapshots` | id | 准入预留 / 窗口占用快照 |
| `harness_installs` / `capabilities` / `circuit_breakers` | (harness, version[, isolation]) | 版本与 tier/status、probe 结果、熔断状态 |
| `login_sessions` | id | 交互登录会话（状态、URL、验证码、输出环形缓冲） |
| `publish_schedule` | (book_id, no) | 发布排期 |
| `inbox` | id | kind、title、body、actions、state、dedupe_key（open 状态下唯一）、timeout_at、on_timeout、resolution |
| `notifications` | id | ntfy/webhook 发送记录、审批 token hash |
| `readers` / `sessions` / `reading_progress` / `pats` | — | 读者（lookup_id、argon2id 或 legacy pbkdf2）、会话（sha256(token)）、进度、PAT |
| `settings` | key | `system`（SystemSettings）、`routing.active`、`admin`（pwHash）… |
| `secrets` | id | AES-256-GCM 密文（owner_kind/owner_id/kind/name 唯一）、sha256、bytes、key_version |
| `audit_log` | id | 管理操作审计 |
| `import_jobs` / `v1_import_map` | id / (kind, v1_id) | v1 导入任务与幂等映射 |

## 7. 配置与环境变量

`loadConfig()`（`apps/server/src/config/index.ts`）读取：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NOVELIST_DATA_DIR` | `/data` | $DATA 根目录 |
| `NOVELIST_HOST` / `NOVELIST_LISTEN_PORT` | `0.0.0.0` / `8000` | 容器内监听 |
| `NOVELIST_PORT` | `8000`（目标主机 用 `8199`） | 仅 compose 的主机端口映射 |
| `NOVELIST_DATABASE_URL` | 空 → PGlite（`$DATA/pglite`）；`pglite:memory` → 内存 | 生产：`postgresql://novelist:<pw>@postgres:5432/novelist2`（`postgresql+psycopg://` 前缀会被规范化） |
| `NOVELIST_V1_DATABASE_URL` | 空 | v1 导入源（`…/novelist`） |
| `NOVELIST_MASTER_KEY` | 空 → 读写 `$DATA/.master_key` | AES-256-GCM 主密钥（base64 32 字节或 64 位 hex） |
| `NOVELIST_ADMIN_PASSWORD` | 空 → 首次启动随机生成并打印 | 初始管理员密码 |
| `NOVELIST_SESSION_SECRET` | 空 → `$DATA/.session_secret` | 会话签名与读者 lookup HMAC |
| `NOVELIST_ISOLATION` | `auto` | `auto\|container\|bwrap\|landlock\|degraded`（也可在 UI 设置覆盖） |
| `NOVELIST_ROLES` | `web,orchestrator,runner` | 进程角色 |
| `NOVELIST_RUNNER_HARNESS` | 空 | runner 只处理这些 harness（逗号分隔） |
| `NOVELIST_TRUST_PROXY` | `loopback,uniquelocal` | 信任的反代网段（CIDR/别名）；`1`/`true` 等同默认值，`0`/`false` 关闭 |
| `NOVELIST_INSECURE_COOKIES` | `false` | 局域网 http 档 |
| `NOVELIST_LOG_LEVEL` | `info` | pino |
| `NOVELIST_HARNESS_DIR` | `$DATA/harness/bin` | harness 可执行文件目录（找不到再查 PATH） |
| `NOVELIST_WEB_DIST` | `apps/web/dist` | SPA 静态目录 |
| `NOVELIST_INTERNAL_SOCKET` | `$DATA/run/internal.sock` | 内部监听器（MCP，P3+） |
| `NOVELIST_SCHEDULER_ENABLED` | `true` | 调度器开关 |
| `NOVELIST_ALLOW_FAKE_HARNESS` | `false` | 允许路由选中 fake（测试/演示） |
| `NOVELIST_FAKE_HARNESS` | `false` | mock 模式：自动创建 fake 账号，全部角色强制路由到 fake adapter（忽略书级路由），不调用任何模型 |
| `NOVELIST_SCHEDULER_TICK_MS` | `2000` | 调度 tick 周期（e2e 调小以缩短用时） |
| `NOVELIST_VERSION` | `2.0.0-alpha.0` | 版本串 |
| `NOVELIST_API`（web dev） | `http://127.0.0.1:8000` | Vite /api 代理目标 |
| `NOVELIST_LIVE_TESTS`（测试） | 未设 | 设为 1 时才允许测试调用真实 harness（只能用 dev 廉价模型） |

运行时可变的配置全部在 DB 的 `settings` 与 book.yaml 里，通过 UI 修改；env 只放启动所需的部分和秘密。

## 8. 目录约定（$DATA）

```
$DATA/
├── books/<slug>/                     每本书一个 git 仓库（DESIGN §4.1；布局常量 book/layout.ts 的 P.*）
│   └── work/<taskId>/attempt-<k>/{out/,VALIDATED.json}   收割的 attempt 产物（gitignored）
├── accounts/<accountId>/home/        账号 HOME（状态部分持久；配置部分每 run 由 prepareHome 重写并 hash 校验）
├── runs/YYYY-MM/<runId>/{in/,log/,book/}   in：spec.json workorder.md system.md receipt.*.json inputs/；log：stdout.ndjson stderr.log pid exit.json heartbeat kill；book：worktree 快照
├── runs/active/<runId> -> ../YYYY-MM/<runId>
├── instructions/global/{AGENTS.md,roles/<role>.md,tasks/<kind>.md,skills/<name>/SKILL.md}   L1（git 仓库）
├── genres/<id>/{pack.yaml,gates.yaml,pacing.yaml,lexicon.yaml,AGENTS.md,roles/,skills/}     L2（git 仓库；首次从内置包种子）
├── harness/{bin/<bin>, <id>/<version>/, harness.lock.yaml, fixtures/<id>/<ver>/}         harness 安装与 probe 录制
├── exports/  media/  backups/  tmp/  pglite/（dev）
├── run/internal.sock
├── .master_key  .session_secret      0600
```

容器内 `/data` 必须是持久卷，并且由运行用户（uid 10001）拥有。git worktree 的 gitdir 在 `books/<slug>/.git/worktrees/`，快照路径必须在 `$DATA` 内（同一文件系统）。

## 9. 测试约定

- 框架 vitest；测试与代码同目录（`*.test.ts`）或放在 `apps/server/test/<module>/`。每个 lane 的测试只依赖自己的代码、shared，以及别的 lane **已实现**的接口；未实现的就用最小桩（写在测试文件里）。
- **DB**：`createTestDb()`（内存 PGlite，已迁移）。不要连真实 Postgres。
- **文件系统**：`fs.mkdtemp(path.join(os.tmpdir(), 'nv-'))`；测试结束删除。需要书仓库时用 `createFixtureBook(dir)`（lane B）。系统里有 git 2.47。
- **harness**：只用 fake adapter / `fake-harness.ts`。真实 CLI 只在 `NOVELIST_LIVE_TESTS=1` 时运行，并且只能用 dev 廉价模型（`claude-haiku-5-5`、`gpt-6-luna`、`gemini-3.8-flash-low`）。本机可用：claude 2.1.319（已登录）、codex 0.165.0（自定义 provider，须加 `--dangerously-bypass-approvals-and-sandbox`）、agy 1.5.3（已登录、免费档）。grok/dsh/pi 没有安装，调研副本在 `<scratch>/{dsh,pi,grokhome}`。
- **fixture 回放**：adapter parser 测试用 `apps/server/src/harness/adapters/__fixtures__/<id>/*.ndjson`（lane A 录制或手写）。
- **e2e**（lane G 的 `createTestApp` + lane F 的 `runUntilIdle`）：fake harness 写完 3 章并发布；chaos：kill shim、promote 中途崩溃、lease 过期。
- golden test：层顺序（C）、TOML 序列化控制字符（C）、context pack section 配额（B）、视图（B）、各 harness argv 挂载可见性（A）。
- 结束前必须通过：`npx -y pnpm@10 --filter @novelist/server typecheck`（或对应包）和本 lane 的测试。

## 10. API 路由清单

单一事实来源：`packages/shared/src/api.ts` 的 `ROUTES`（下表由它生成；改路由先改 ROUTES）。DTO 名对应 `api.ts` 中的类型 / zod（请求体 `zXxx`）。错误一律 `application/problem+json`（`ApiProblem`）；分页 `?cursor=&limit=` → `Page<T>`；SSE 事件 `SseEvent`。鉴权：`public` 无需登录；`reader` = 读者或管理员会话；`admin` = 管理员会话或 PAT。

| 方法 | 路径 | 鉴权 | 请求 DTO | 响应 DTO | 说明 |
|---|---|---|---|---|---|
| GET | `/api/health` | public | — | `HealthResponse` | 健康检查 |
| POST | `/api/auth/login` | public | `LoginRequest` | `MeResponse` | 单框登录（管理员或读者） |
| POST | `/api/auth/logout` | public | — | `Ok` | 登出 |
| GET | `/api/auth/me` | public | — | `MeResponse` | 当前会话 |
| GET | `/api/reader/books` | reader | — | `ReaderBookCard[]` | 书库 |
| GET | `/api/reader/books/:slug` | reader | — | `ReaderBookDetail` | 书详情与目录 |
| GET | `/api/reader/books/:slug/chapters/:no` | reader | — | `ReaderChapter` | 章节正文（仅已发布） |
| GET | `/api/reader/books/:slug/progress` | reader | — | `{ch,scroll}|null` | 阅读进度 |
| PUT | `/api/reader/books/:slug/progress` | reader | `ProgressPut` | `Ok` | 保存阅读进度 |
| GET | `/api/reader/books/:slug/export.epub` | reader | — | `application/epub+zip` | 导出 EPUB（?vol=v03 按卷） |
| GET | `/api/reader/books/:slug/export.txt` | reader | — | `text/plain` | 导出 TXT |
| GET | `/api/reader/books/:slug/cover` | reader | — | `image/*` | 封面 |
| GET | `/api/admin/books` | admin | — | `BookSummary[]` | 书列表 |
| POST | `/api/admin/books` | admin | `CreateBook` | `BookSummary` | 开书（book new） |
| GET | `/api/admin/books/:slug` | admin | — | `BookOverview` | 书概览 |
| PATCH | `/api/admin/books/:slug` | admin | `PatchBook` | `BookSummary` | 改状态/标题 |
| DELETE | `/api/admin/books/:slug` | admin | — | `Ok` | 删除书（需 ?confirm=slug） |
| POST | `/api/admin/books/:slug/actions` | admin | `BookAction` | `Ok` | start/pause/resume/reindex/rewind/drain/migrate |
| GET | `/api/admin/books/:slug/config` | admin | — | `BookConfigDoc` | book.yaml 原文+解析 |
| PUT | `/api/admin/books/:slug/config` | admin | `PutBookConfig` | `BookConfigDoc` | 保存 book.yaml（committer 提交） |
| GET | `/api/admin/books/:slug/tree` | admin | — | `RepoEntry[]` | 书库文件树（?dir=） |
| GET | `/api/admin/books/:slug/file` | admin | — | `RepoFile` | 读书库文件（?path=） |
| PUT | `/api/admin/books/:slug/file` | admin | `PutRepoFile` | `RepoFile|ImpactEstimate` | 写书库文件（needsConfirm 时 409 返回 ImpactEstimate） |
| POST | `/api/admin/books/:slug/file/impact` | admin | `PutRepoFile` | `ImpactEstimate` | 保存前影响估算 |
| GET | `/api/admin/books/:slug/git/log` | admin | — | `Page<GitCommitRow>` | 提交历史（含 trailer） |
| GET | `/api/admin/books/:slug/plan` | admin | — | `PlanOverview` | 规划总览 |
| GET | `/api/admin/books/:slug/chapters` | admin | — | `Page<ChapterRow>` | 章节列表 |
| GET | `/api/admin/books/:slug/chapters/:no` | admin | — | `ChapterAdminDetail` | 章节详情 |
| PUT | `/api/admin/books/:slug/chapters/:no/text` | admin | `PutChapterText` | `ChapterAdminDetail|ImpactEstimate` | 手改正文（触发级联） |
| POST | `/api/admin/books/:slug/chapters/:no/actions` | admin | `ChapterAction` | `Ok` | 章节操作 |
| GET | `/api/admin/books/:slug/state` | admin | — | `StateView` | 状态视图（snapshot） |
| GET | `/api/admin/books/:slug/reviews` | admin | — | `Page<Review>` | 评审记录 |
| GET | `/api/admin/books/:slug/audits` | admin | — | `Audit[]` | 审计记录 |
| GET | `/api/admin/books/:slug/debts` | admin | — | `Debt[]` | 债务 |
| GET | `/api/admin/books/:slug/feasibility` | admin | — | `FeasibilityReport` | 路由可行性检查 |
| GET | `/api/admin/books/:slug/publish` | admin | — | `PublishOverview` | 发布配置与前沿 |
| PUT | `/api/admin/books/:slug/publish` | admin | `PutPublish` | `PublishOverview` | 改发布配置（写回 book.yaml） |
| POST | `/api/admin/books/:slug/publish/now` | admin | `PublishNow` | `Ok` | 立即发布 |
| GET | `/api/admin/tasks` | admin | — | `Page<TaskRow>` | 任务（?book&state&kind） |
| POST | `/api/admin/tasks/:id/retry` | admin | — | `Ok` | 重试任务 |
| POST | `/api/admin/tasks/:id/cancel` | admin | — | `Ok` | 取消任务 |
| GET | `/api/admin/runs` | admin | — | `Page<RunRow>` | run 列表（?book&state&harness） |
| GET | `/api/admin/runs/:id` | admin | — | `RunDetail` | run 详情 |
| GET | `/api/admin/runs/:id/events` | admin | — | `NEvent[]` | run 事件（?after=seq） |
| GET | `/api/admin/runs/:id/file` | admin | — | `text/plain` | run 文件（?area=in|log|out&path=） |
| GET | `/api/admin/runs/:id/stream` | admin | — | `SSE(run_event|run_exit)` | 单个 run 实时流 |
| POST | `/api/admin/runs/:id/kill` | admin | — | `Ok` | 终止 run |
| GET | `/api/admin/inbox` | admin | — | `Page<InboxItem>` | Inbox（?state=open） |
| POST | `/api/admin/inbox/:id/act` | admin | `InboxAct` | `InboxItem` | 处理 Inbox 项 |
| GET | `/api/admin/instructions/files` | admin | — | `InstructionFileEntry[]` | 指令文件（?scope=global|builtin|genre:x|book:y） |
| GET | `/api/admin/instructions/file` | admin | — | `RepoFile` | 读指令文件（?scope&path） |
| PUT | `/api/admin/instructions/file` | admin | `PutRepoFile&{scope}` | `RepoFile|ImpactEstimate` | 写指令文件 |
| DELETE | `/api/admin/instructions/file` | admin | — | `Ok` | 删除指令文件（?scope&path） |
| POST | `/api/admin/instructions/preview` | admin | `InstructionPreviewRequest` | `InstructionPreview` | 编译预览（按 harness）+ 生效 gate |
| GET | `/api/admin/genres` | admin | — | `GenreSummary[]` | 题材包列表 |
| POST | `/api/admin/genres` | admin | `CreateGenre` | `GenreSummary` | 新建题材包 |
| DELETE | `/api/admin/genres/:id` | admin | — | `Ok` | 删除题材包（内置不可删） |
| GET | `/api/admin/harness` | admin | — | `HarnessStatus[]` | harness 状态 |
| POST | `/api/admin/harness/:id/probe` | admin | — | `Capabilities` | 能力探测（?accountId） |
| GET | `/api/admin/harness/:id/models` | admin | — | `string[]` | 列模型（agy models 等；?accountId） |
| GET | `/api/admin/accounts` | admin | — | `AccountView[]` | 账号列表 |
| POST | `/api/admin/accounts` | admin | `CreateAccount` | `AccountView` | 新建账号 |
| GET | `/api/admin/accounts/:id` | admin | — | `AccountView` | 账号详情 |
| PATCH | `/api/admin/accounts/:id` | admin | `PatchAccount` | `AccountView` | 修改账号 |
| DELETE | `/api/admin/accounts/:id` | admin | — | `Ok` | 删除账号 |
| PUT | `/api/admin/accounts/:id/env/:name` | admin | `PutEnv` | `AccountView` | 设置 env（秘密加密存储） |
| DELETE | `/api/admin/accounts/:id/env/:name` | admin | — | `AccountView` | 删除 env |
| POST | `/api/admin/accounts/:id/files` | admin | `multipart(relPath,part,file)` | `AccountView` | 上传凭据文件 |
| DELETE | `/api/admin/accounts/:id/files` | admin | — | `AccountView` | 删除凭据文件（?relPath） |
| POST | `/api/admin/accounts/:id/verify` | admin | — | `AccountCheck` | 核对认证与模型 |
| POST | `/api/admin/accounts/:id/login` | admin | `StartLogin` | `LoginSessionView` | 启动交互登录 |
| GET | `/api/admin/login-sessions/:sid` | admin | — | `LoginSessionView` | 登录会话状态与输出 |
| GET | `/api/admin/login-sessions/:sid/stream` | admin | — | `SSE(login_output|login_state)` | 登录输出流 |
| POST | `/api/admin/login-sessions/:sid/input` | admin | `LoginInput` | `Ok` | 向登录进程写入输入 |
| POST | `/api/admin/login-sessions/:sid/cancel` | admin | — | `Ok` | 取消登录 |
| GET | `/api/admin/profiles` | admin | — | `Profile[]` | profile 列表 |
| POST | `/api/admin/profiles` | admin | `Profile` | `Profile` | 新建 profile |
| PATCH | `/api/admin/profiles/:id` | admin | `PatchProfile` | `Profile` | 修改 profile |
| DELETE | `/api/admin/profiles/:id` | admin | — | `Ok` | 删除 profile |
| GET | `/api/admin/routing/presets` | admin | — | `RoutingPreset[]` | 路由 preset |
| POST | `/api/admin/routing/presets` | admin | `RoutingPreset` | `RoutingPreset` | 新建自定义 preset |
| PUT | `/api/admin/routing/presets/:id` | admin | `RoutingPreset` | `RoutingPreset` | 修改 preset（内置会另存为副本） |
| DELETE | `/api/admin/routing/presets/:id` | admin | — | `Ok` | 删除自定义 preset |
| GET | `/api/admin/routing/active` | admin | — | `ActiveRouting` | 当前生效路由 |
| PUT | `/api/admin/routing/active` | admin | `PutActiveRouting` | `ActiveRouting` | 切换 preset / 全局覆盖 |
| POST | `/api/admin/routing/check` | admin | — | `FeasibilityReport` | 全局可行性检查（?book=） |
| GET | `/api/admin/schedule` | admin | — | `PublishOverview[]` | 全部书的发布排期 |
| GET | `/api/admin/quota` | admin | — | `QuotaStatus[]` | 账号窗口占用/预留/重置 |
| GET | `/api/admin/usage` | admin | — | `UsageReport` | 用量报表 |
| GET | `/api/admin/readers` | admin | — | `ReaderAccount[]` | 读者 |
| POST | `/api/admin/readers` | admin | `CreateReader` | `ReaderAccount` | 新建读者密码 |
| PATCH | `/api/admin/readers/:id` | admin | `PatchReader` | `ReaderAccount` | 修改读者 |
| DELETE | `/api/admin/readers/:id` | admin | — | `Ok` | 删除读者 |
| GET | `/api/admin/pats` | admin | — | `PatRow[]` | PAT 列表 |
| POST | `/api/admin/pats` | admin | `CreatePat` | `CreatedPat` | 签发 PAT |
| DELETE | `/api/admin/pats/:id` | admin | — | `Ok` | 吊销 PAT |
| GET | `/api/admin/settings` | admin | — | `SystemSettings` | 系统设置 |
| PUT | `/api/admin/settings` | admin | `PutSettings` | `SystemSettings` | 修改系统设置 |
| PUT | `/api/admin/settings/admin-password` | admin | `ChangeAdminPassword` | `Ok` | 改管理员密码 |
| GET | `/api/admin/system` | admin | — | `SystemInfo` | 系统信息 |
| GET | `/api/admin/doctor` | admin | — | `DoctorReport` | doctor（隔离探测等） |
| POST | `/api/admin/import-v1/preview` | admin | `V1ImportPreviewRequest` | `V1ImportPreview` | v1 导入预览 |
| POST | `/api/admin/import-v1` | admin | `V1ImportRequest` | `V1ImportJob` | 启动 v1 导入 |
| GET | `/api/admin/import-v1/jobs/:id` | admin | — | `V1ImportJob` | v1 导入进度 |
| GET | `/api/admin/events` | admin | — | `SSE(SseEvent)` | 全局事件流 |

## 11. 部署要点（lane G，目标主机）

- 镜像：`node:24-bookworm-slim`（dsh 需要 Node ≥24.9），加 `git`、`ripgrep`、`bubblewrap`（可选）、`tini`、`ca-certificates`、`util-linux`（`script`）；多阶段构建：pnpm install → build shared/server/web → 运行层只带 `apps/server/dist`、`apps/web/dist`、生产依赖。arm64 必须可用（目标主机是 arm64）。
- harness 不打进镜像：装在 `/data/harness`（持久卷），由 UI 或 `novelist harness install` 安装（lane A 的 `install.ts`）。
- compose（部署目录）：复用现有 `postgres:16-alpine` 服务和卷（v1 的 `./pgdata`），v2 服务连 `novelist2` 库（不存在时自动创建）；主机端口 `${NOVELIST_PORT:-8199}:8000`；卷 `./data2:/data`；`NOVELIST_V1_DATABASE_URL=postgresql://novelist:${NOVELIST_PG_PASSWORD}@postgres:5432/novelist`；`NOVELIST_ISOLATION=auto`（预期选中 `container`）。v1 的 8000 端口与 `./data` 卷不动，两者可以并行运行，直到导入验证完成。
- 健康检查：`GET /api/health`。`stop_grace_period: 90s`；`init: true`（tini）或 `command: ["supervise","--","serve"]`。

## 12. 开放项（需要实现时核实）

- Gemini 4 Argon 的真实 slug（免费档的 `agy models` 列表里没有）：默认占位 `gemini-4-argon`，UI 允许修改；agy adapter 在 `listModels` 不含该 slug 时，让路由可行性检查给出 warning，不要硬失败。
- DESIGN 中所有 **(verify)** 项（dsh `--json`、codex 关闭 shell 的配置键、grok `--leader-socket` 等）仍然要靠 P0 probe 核实；adapter 遇到未核实的项时取保守值。
- `container` 档不阻止 harness 读取同一容器内其他书和账号的文件（残余风险见 DESIGN §10.6）：带 shell 的 harness（codex、dsh）默认不承担读取不可信文本的角色（`import.bootstrap`）。
