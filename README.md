# dsh-ai-team

DeepSeek Harness（dsh）插件：**无人值守的 AI 软件团队**。

[![version](https://img.shields.io/npm/v/dsh-ai-team?label=npm&color=blue)](https://www.npmjs.com/package/dsh-ai-team)
[![license](https://img.shields.io/npm/l/dsh-ai-team?color=green)](https://github.com/yunqiangwu/dsh-ai-team/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/dsh-ai-team)](https://www.npmjs.com/package/dsh-ai-team)

> 输入：一台裸 Linux 服务器 + 一组密钥（git deploy key、API keys，全部以环境变量引用）+ 一个 git 远程仓库地址（可为空仓库）。
> 过程：插件驱动的 AI 团队自主完成项目全生命周期——环境引导 → 任务拆解 → 多 agent 并行开发 → 客观质量门 → 代码审查 → 合并 → 部署 → 监控 → 迭代。
> 人工介入：仅在插件主动升级（escalation）时。

### 安装

```bash
npm install dsh-ai-team
# 或
pnpm add dsh-ai-team
```

在 dsh 配置里以插件方式加载（见下方配置示例），或在对话中直接调用工具即可跑通全流程。

> 「模糊需求 → 澄清 → PRD → 规范 → 拆任务 → 最小框架 → 测试先行 → 并行开发」这条人机交互链路的设计与分期，见 [docs/design-interaction.md](docs/design-interaction.md)。
> 首次上真实环境跑无人值守，看 [PILOT.md](PILOT.md)（操作者 runbook：怎么跑、看什么、出事怎么办）。

## 功能特性

- 四角色团队（leader / developer / reviewer / operator），每成员一个 git worktree（共享 object store），任务看板 + `task/<id>` 分支。
- `.tasks/*.md` 任务契约（frontmatter 真相源 + `_board.md` 自动生成），`contract_create` 写前校验，`task_clarify` 契约含糊退回 leader（不消耗返工轮次）。
- 团队阶段（phase）：`intake → 文档待批准 → 脚手架 → 开发 ⇄ 重排`，非派发阶段不把任务交出去。
- 客观质量门：`gates_run` 全绿才可 approve 并**本地合入 base**；改动体量门（`maxDiffLines`/`maxDiffFiles`）；不做远端 PR / 不依赖远端 CI。
- 无人值守主循环：崩溃恢复、依赖/域锁派发、依赖死锁（`blocked-dependency`）、卡死检测、空转降频、完成报告。
- 知识回路：自动捕获评审打回与升级 → 注入后续任务描述 → `learnings.md` 台账（落 stateDir，不入库）；升格进项目文档由人裁决。
- 升级机制：`needs-human` 打标 + 任务单留言 + webhook 通知 + 粒度化暂停；人工确认走邮件 + 问卷工单，答复自动回写。
- 部署闭环：健康检查（指数退避）+ 自动回滚（纯 `.tasks/` 提交不触发部署）。
- 远程 git：clone / push（`GIT_SSH_COMMAND` 注入密钥）；session 事件 + 投影 + Web 看板。
- 安全硬规则：密钥只引用不落盘、命令白名单、forbiddenPaths、push 安全、文档草稿人批（见「安全模型」）。

## 快速开始

**方式一：作为 dsh 插件加载（推荐）**

在 dsh 配置文件（`cordis.patch.yml`）里引用本包，并填入你的部署配置：

```yaml
- insert:
    - id: autopilot
      name: dsh-ai-team
      config:
        rootDir: .dsh-ai-team
        # ……（完整配置见下一节）
```

然后启动 dsh Web 端：

```bash
pnpm dsh web --patch ./cordis.patch.yml
```

**方式二：源码开发（克隆本仓库）**

```bash
pnpm install
pnpm build
pnpm dsh web --patch ./cordis.patch.yml
```

无论哪种方式，之后在对话中依次调用工具即可跑通全流程：

```
autopilot_init        # 克隆远程 → 工具链检测/安装 → setup → verify
team_add_member …     # 补齐 developer / reviewer / operator
autopilot_run         # 启动无人值守主循环（幂等）
autopilot_status      # 随时查看：循环状态 / 看板 / 升级 / 部署历史
```

## 配置（Config schema）

所有"部署间可能不同"的值都在 Config 中，误配置 fail loud 并指出具体 key。**密钥一律配置环境变量名**（`xxxEnv`），插件运行时 `process.env[name]` 读取，值绝不落盘、进日志即脱敏为 `***`。

> 下例是**功能演示用的完整字段**（含可选段）；随包 `cordis.patch.yml` 是更保守的最小配置。各字段的行为语义在后文对应小节（主循环 / 安全模型 / 人工确认 / 知识回路 / 项目 Profile），这里只留一行提示。

```yaml
- insert:
    - id: autopilot
      name: dsh-ai-team
      config:
        rootDir: .dsh-ai-team        # 工作区与状态根目录
        baseBranch: main
        maxMembers: 8
        maxTasks: 512
        remote:
          url: git@repo.example.com:org/repo.git  # 自建 git 远端（可为空仓库；后续本地 merge 后 push 到这里）
          sshKeyEnv: AUTOPILOT_GIT_KEY            # 环境变量名（变量装 SSH 私钥**内容**，不是路径）；禁止直接传密钥值
          platform: generic                       # generic | cnb | gitlab | github；generic 纯 clone/push、不建 PR/不查 CI
          # apiTokenEnv: GITHUB_TOKEN             # 仅 github 建 PR / 查远端 CI 需要；自建远端（generic 等）免配
        bootstrap:
          enabled: true
          toolchain: [git, bun, pnpm, node]       # bun rootless 装到 ~/.bun；node rootless 装到 ~/.node
          setupCommand: ''                        # 空串 = 跳过；指认目标仓库真实存在的命令，如 pnpm install
          verifyCommand: ''                       # 空串 = 跳过；环境自检命令，如 pnpm run typecheck
          systemPackages: [python3, make, g++]    # 原生模块(node-gyp)编译所需，如 better-sqlite3
          packageManagerCommand: sudo apt-get install -y   # 系统包安装命令，须命中白名单
          envFile: .env                           # 从模板生成 .env（不覆盖已有，缺省不动作）
          envExample: .env.example                # 模板路径；配了才生成
          requiredEnvKeys: [AUTH_SECRET]          # 缺失则引导 fail-loud 并指明 key
        gates:
          commands: [pnpm run typecheck, pnpm run lint, pnpm run build, pnpm run test]   # build 在 test 前：test 可能读 build 产物
          requireCiGreen: false               # 独立于 pushRequiresGates 的另一道门；CI 状态仅 github 平台查得到，自建远端无远端 CI 必须显式设 false
          timeoutMinutes: 30
        daemon:
          maxReviewRounds: 3                  # 返工上限，超过升级
          stuckMinutes: 45                    # 无 git 活动超时，升级
          pollIntervalSeconds: 30             # 轮询间隔；心跳每拍落 heartbeat.json，崩溃可恢复
          maxDiffLines: 0                     # 评审体量门（行）：超限拒 approve 并升级 change-too-large。0=关闭
          maxDiffFiles: 0                     # 同上按文件数。0=关闭
          maxTaskHours: 0                     # 单任务墙钟预算（小时）：超时升级 budget-exceeded。0=关闭；无人值守跑真实项目建议开启
        escalation:
          webhookUrlEnv: AUTOPILOT_WEBHOOK    # 通知 webhook 的环境变量名
          label: needs-human
          pauseOnEscalation: task             # task | team
        notification:                          # 无人值守时人工确认通道
          enabled: true
          smtp:
            host: smtp.qq.com                 # smtp.163.com / smtp.gmail.com
            port: 465                         # 465=隐式 TLS；587=STARTTLS
            secure: true
            userEnv: AUTOPILOT_SMTP_USER      # 环境变量名，勿写值
            passEnv: AUTOPILOT_SMTP_PASS      # SMTP 授权码，环境变量名
            fromEnv: AUTOPILOT_SMTP_FROM      # 可选，默认取 user
            startTls: true                    # 非 465 端口走 STARTTLS
          mailTo: ops@example.com             # 收件人（可逗号分隔多个）
          ticket:
            host: 127.0.0.1                   # 只绑回环；配成非回环**拒绝启动**（不是告警）。远程访问走 SSH 隧道
            port: 8080                        # 0=自动分配端口。此端口只服务邮件里的链接；notification.enabled=false 时不监听（面板作答走宿主同源路由，不依赖它）
            publicBaseUrl: http://server.example.com  # 两重语义：邮件里展示的工单根地址 + 它的 authority 被登记为同源路由的可信 Host
          autoResume: false                   # 工单答复后自动回写并解除升级；默认关（答复=替 AI 做决策，别一上来就放行）
        deploy:
          enabled: false
          command: 'docker build -t app . && docker push ... && ssh ... docker compose up -d'
          healthCheckUrl: https://app.example.com/health
          rollbackCommand: 'ssh ... docker compose rollback'
          secretsEnv: []                      # 部署密钥环境变量名白名单
          skipTasksOnlyCommits: true          # base 只前进在 .tasks/ 提交上时不部署（不含代码，误部署会误触回滚）
        security:
          forbiddenPaths: ['LICENSE']         # 默认禁区 2026-08-29 起只剩 LICENSE，口径见「安全模型」
          commandAllowlist: [pnpm, git, bun, docker, node, bunx, ssh, nuxt]   # 可执行命令精确匹配白名单
          pushRequiresGates: true             # 门不过禁止 push 与 approve
        buildCache:                           # 可选：构建缓存（默认关闭）
          enabled: true                       # 把 .nuxt/.output/coverage 等软链到共享目录，减少每条任务全量 build
          dirs: ['.nuxt', '.output', 'dist', 'coverage', '.vitest', 'node_modules/.cache']
        learnings:                            # 可选：知识回路（默认关闭，见「知识回路」一节）
          enabled: true                       # 自动捕获评审打回与升级，教训注入后续任务描述
          injectMaxCount: 5                   # 单任务最多注入几条（相关域优先，再按被印证次数）
          injectCharBudget: 1200              # 注入字符预算（描述会进投影推给前端，必须有界）
          promoteAfterHits: 3                 # 同因被印证 N 次进「待升格」清单（插件绝不代笔改文档）
          maxEntries: 200                     # 台账上限，超出淘汰"命中少且久未被印证"的记录
        questionnaire:                        # AI 向人提问（问卷 ≠ 升级，见「人工确认与问卷工单」）
          mode: interactive                   # interactive | async；async 答完要回会话说一句「继续」
          timeoutMinutes: 60                  # interactive 等待上限；超时按各题 defaultValue 兜底并标 expired
        replan:                               # 重规划护栏（见「需求变更与重规划」一节）
          maxPerHour: 10                      # task_cancel / task_replan 每小时调用上限，超限拒绝；0=不设限
        cycles:                               # 迭代周期开发（见「迭代周期开发与无人值守闭环」一节）
          roadmapPath: docs/ROADMAP.md        # roadmap 文档路径（大型项目由 AI 起草、人只批一次）
        docs:                                 # 文档先行：AI 只能写 draft 区，正式区唯一出口是 doc_approve
          draftDir: docs/drafts
          formalDir: docs
        profile:                              # 项目约定适配器（字段一览见「项目 Profile」一节）
          preset: agentdeploy                 # 'default' | 'agentdeploy'；留空 = default
          # 其余字段（branchTemplate / prTitleTemplate / mergeStrategy / gates / forbidden / ownership /
          # crossDomainThreshold）可逐项覆写 preset，缺省回退到 preset 默认值。
```

## 项目 Profile（约定适配器）

不同仓库的协作"纹路"往往同构但细节不同：分支命名（`task/<id>` vs `agent/<id>-<slug>`）、PR 标题（`[id] title` vs `feat(scope): [id] desc`）、合并策略（`--no-ff` vs **squash**）、以及**域条件**与**CI-only** 的质量门。与其把某一种约定写死在引擎里，`profile` 把「一个项目一套约定」编码成可配的适配层。默认 `default` 完全复刻历史行为；项目 `preset`（内置 `agentdeploy`）只在有差异的字段上覆写，其余内联字段可再逐项覆盖（缺省回退到 preset 默认值）。

`profile` 字段一览（全部可选）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `preset` | `default` | `default`（历史行为）或 `agentdeploy`（AgentDeploy 约定） |
| `branchTemplate` | `task/{id}` | 分支名模板；`{id}`=任务号、`{slug}`=标题 kebab-case |
| `prTitleTemplate` | `[{id}] {title}` | PR 标题模板；`{id}`/`{title}`/`{scope}`（**仅 github 平台建 PR 时用到**；自建远端本地合并不建 PR，忽略） |
| `prBodyTemplate` | `关联任务单…` | PR 正文模板；`{id}`/`{title}`/`{touches}`/`{scope}`/`{assignment}`（同上，仅 github 建 PR 用） |
| `mergeStrategy` | `no-ff` | 本地合入 base 的策略：`no-ff`/`merge`/**`squash`**（squash 保 main 线性，可独立 revert） |
| `gates` | `[]`→`gates.commands` | 每条 `{command, when?, role?}`；`when` 按任务 `touches` 前缀条件触发；`role:'ci'` 只由远端 CI 强制（自建远端无远端 CI，该角色不强制） |
| `forbidden` | `[]`→`security.forbiddenPaths` | `{path, mode}`；`block`=命中即拒并升级，`needs-approval`/`high-conflict`=命中暂缓 push、等 owner/人工确认后单独合并提交 |
| `ownership` | `[]` | `{glob, role}` 路径→域 owner 映射（域专精路由预留） |
| `crossDomainThreshold` | `3` | 触碰 > N 个不同域即升级 |

**为 AgentDeploy 开箱：`preset: agentdeploy`** 会一并得到 `agent/<id>-<slug>` 分支、`feat(scope): [id] desc` PR 标题（同样仅 github 建 PR 时用）、squash 合并，以及一组**域条件 + CI-only** 的门（`db:check-parity` 只在碰 `server/db/`、`validate:docs` 只在碰 `.tasks/` 或 `docs/`、`pnpm audit` 标 `role:'ci'` 所以本地不红、重门 `build`/`test:e2e` 只在碰源码目录）——见 [`src/profile.ts`](src/profile.ts) 的 `agentdeployProfile`。⚠️ 自建远端（generic）下 `role:'ci'` 的门因无远端 CI 不强制，本地合并只认 `gates.commands` 全绿。

> **域专精路由**：`ownership` 命中的任务优先派给 `specialization` 匹配的 developer（`team_add_member` 可传 `specialization`），并把匹配的域硬规则注入任务描述；契约的 `forbidden` frontmatter 原位保序回写、不重排，避免触发项目严格的 `validate:docs`。

## 无人值守主循环

每 `pollIntervalSeconds` 一拍（每拍先落心跳到 `<stateDir>/heartbeat.json`）：

1. **恢复检查**：读 state.json + heartbeat 重建内存态。三件固定事：崩溃时仍 `in_progress` 的任务**状态与接手者都不动**（抢回会把同一任务分支二次派发），交由同拍卡死检测收敛；持久化为 `running` 的循环一律降为 `paused`，等 `autopilot_resume`；state.json 解析失败先改名留存为 `state.json.corrupt-<时间戳>` 再空启动，不覆盖唯一一份历史。
2. **分诊挂起态**：`needs-human` 与 `needs-clarification` 都属"等人/等 leader 动一下"；人工把任务单状态改回 `pending`（或调用 `escalation_resolve`、leader 用 `task_update` 带 `note` 回答）→ 任务回到待派发，关联升级标记 resolved。
3. **派发**：先看**团队阶段**——`intake`/`kickoff_pending_approval`/`scaffolding` 不派发（契约仍照采纳、门照跑，只是不把任务交出去），`developing`/`replanning` 才继续。然后 `depends_on` 全部 done 且 `status=pending` 的任务按 **`priority` 降序稳定排序**（依赖条件相同的任务之间大者先派，同权重保持插入顺序；前置没满足的任务永远排在后面）逐个检查：先做跨域与**契约自洽校验**（`touches ∩ forbidden = ∅`，违规即升级 `forbidden-paths` 并跳过），再过域锁（`in_progress`/`in_review` 任务 `touches` 目录交集为空）→ 派给空闲 developer，并在**这一刻**按最新契约正文与最新教训重建任务描述（知识要在工作开始的那一刻最新鲜）。
4. **审查闸门**：reviewer 调 `code_review` approve 前三道门必须全过——本地门绿、改动体量门、禁区 diff（语义见「安全模型」3/4，配 `maxDiff*` 时超限升级 `change-too-large`）——都过了才按画像策略**本地合入 base** 并 push 到自建远端（不做 PR、不依赖远端 CI）；合并冲突拒绝并保持 `in_review`。
5. **返工与澄清**：`request_changes` 的意见会写进任务单 `.tasks/<id>.md` 并捕获成教训；轮次 ≥ `maxReviewRounds` → escalate。若问题出在契约本身，developer 走 `task_clarify` 退回 leader——不消耗返工轮次、不产生升级。
6. **卡死与预算**：任务 `stuckMinutes` 无 git 活动 → escalate（空闲失控）；派发后超过 `daemon.maxTaskHours`（默认关闭）仍未完成 → 升级 `budget-exceeded`（活跃空转）。插件看不见成员 agent 的 token 消耗，墙钟预算是唯一可靠的烧钱护栏。
7. **部署**：base 有本地合并且 `deploy.enabled` → `deploy_run`（自建远端无远端 CI，以本地门绿为准）；base 仅前进在 `.tasks/` 提交上时跳过（`skipTasksOnlyCommits`，默认开）；健康检查 3 次失败自动 `rollbackCommand` 并升级 —— 回滚命令自身也非零时记 `rollback-failed`（线上既没升上去也没退回来，需立刻救火），不与 `rolled-back` 混为一谈。
8. **空转保护与完成判定**：连续无事件拍降频轮询（最多 4×）。完成判定按周期语义（见「迭代周期开发」一节）：团队无周期记录时，所有任务 done 或 **cancelled**（废弃是处置结果，不挡收尾）→ 写 `<stateDir>/completion.md` 完成报告（含本轮教训与**待升格清单**）并停机等待；有周期记录时，当前活跃周期任务全 done/cancelled → 周期置 `in_review` 并生成周期小结（并入 completion.md 的 `## cycles` 段），随后按该周期 `checkpoint`（组长声明）与下一期就绪度推进（直通 / 检查点 / 等规划），只有 roadmap 走完且当前周期已 done 才真正 `completed` 停机。

**升级触发条件**（任一命中即 escalate，禁止自行绕过）：需求矛盾 / 跨 3+ 域改动 / 需新增付费依赖或密钥 / 非本任务导致的门红 / 触及 forbiddenPaths / 返工超限 / 改动体量过大 / 前置依赖永远等不到（`blocked-dependency`：前置看板上不存在、已 needs-human 或已 cancelled）/ 任务卡死 / 超出任务墙钟预算 / 部署连续失败 / 引导失败。契约含糊不在其中——那走 `task_clarify`。

## 任务契约（.tasks/*.md）

任务真相源是仓库内 `.tasks/<id>.md` 的 YAML frontmatter + Gherkin 验收：

```markdown
---
id: CORE-1
title: set up core module
status: pending        # pending → in_progress → in_review → done
                       # 分支态：changes_requested / needs-clarification（等 leader）/ needs-human（等人）
                       # 终止态：cancelled（重规划废弃；文件保留不删，见「需求变更与重规划」）
owner: dev-1
priority: 2            # 可选，派发权重：依赖条件相同的任务间大者先派，缺省 0
depends_on: [CORE-0]
touches: [server/core/]
forbidden: [server/core/legacy/]   # 本任务不得触碰的路径（按任务划分的禁区）
---

Given/When/Then 验收标准……
```

- `task_assign` 传 `contractId` 时校验任务单存在且状态为 `pending`，title/depends_on/touches 以任务单为准。同一张契约若已被守护循环以组长名义收养成 pending 占位任务、尚未真正派发，组长点名派发时会**接管**这张占位任务给点名的开发者（建分支 → 检出工作区 → 置 in_progress → 回写契约），而不是报「already on the board」硬错误；若它已被某成员真正负责或卡住，则给出可操作处置指引（`task_replan` 撤销/解除堵塞后再派）而不只是抛错。
- `forbidden` 不只是给人看的注释：派发期会拿它和 `touches` 求交（两个方向都算，`touches: [app/]` 命中 `forbidden: [app/server/]` 同样违规），违规立刻升级，而不是白跑一轮门和评审才被门拦下。
- 每次状态变更回写 frontmatter 并重新生成 `.tasks/_board.md`（自动生成，勿手改），改动以插件身份提交在 base 分支，保持集成检出干净。
- **一个坏文件不拖垮整块看板**：契约逐文件解析，某个 `.md` frontmatter 写坏了只跳过它并上报一次 `contract-rejected`（同一文件不重复报，否则每拍都产生事件、空转降频永远生效不了），其余契约照常采纳。
- **评审与澄清都留痕在任务单里**：`request_changes` 的意见、`task_clarify` 的提问、leader 的 `clarify-answer` 都以带时间戳的留言追加进正文 —— 换人接手或换场会话，接得上上下文。
- `<stateDir>/learnings.md` 同为生成物（程序全量重写），见下节。
- developer 的 DoD：质量门全绿 + 每条验收标准的验证证据写入审查留言 / 任务单 `.tasks/<id>.md`（本地合并，不建 PR）。

## 迭代周期开发与无人值守闭环（AI 自主判断规模）

**用户视角始终只有三样：需求（PRD）、进度、开始/结束。** 周期、roadmap、`cycle_plan` 等是 AI 团队内部动作，不进用户视野。大型项目按里程碑（如 M1~M8）拆成**多个周期**，每个周期内多个任务、任务按波次推进；当前周期全部完成后，组长读 roadmap 生成下一轮待办 —— **完成一期 → 再规划一期**的增量模式，而不是开工前把全部任务规划完。小型项目则是一个周期多任务直接跑完，用户不接触任何周期概念。细读 [docs/design-cycles.md](docs/design-cycles.md)。

- **AI 自主判断规模**：组长读完需求后自行决定——任务量小 / 单一模块 → 直接拆一批契约干完（不建周期记录）；跨模块 / 多阶段 / 任务量大 → 用 `doc_write` 起草 roadmap 请你批一次，再逐期拆解、逐期推进。
- **周期实体**：每个周期一张 `CycleRecord`（挂在团队上），含目标（goal）、范围（scope）、任务清单与状态（`planned → in_progress → in_review → done`）；契约 frontmatter 用 `cycle: M1` 声明归属，无该字段的契约视为「未排期」，行为不变。
- **增量规划**：只拆当前要做的下一期，新周期契约状态为 `planned`，未来周期的契约保持 pending、不被 `dispatch` 提前派出；当前周期任务全部完成后触发周期验收，验收通过推进到下一期，直到 roadmap 走完才真正 `completed` 停机。
- **周期验收门**：当前活跃周期（`in_progress`）的任务全 done/cancelled 时，周期置 `in_review` 并生成该周期完成小结，并入 `<stateDir>/completion.md` 的 `## cycles` 段（每周期一段）；周期不 done，项目就 **不** 提前 `completed`。
- **无人值守直通**：下一期已由组长预排好（契约已在盘上）时，插件机械地把 `planned → in_progress` 并继续派发——唯一全程无人值守的路径；未预排时落一张问卷等人规划，绝不静默空转。
- **边界检查点**：组长在规划每一期时可自主声明该期边界要不要请你确认（`checkpoint`），默认全自动推进；被问到时你只需回「继续 / 结束」。开工审批不再是配置（kickoff 时你已批过项目）。

## 需求变更与重规划

开发过程中需求会变。组长重排计划时有**两条硬边界**（分级表）：该自主的别发邮件，该人批的别偷跑。

| 变更 | 处置 | 惊动人吗 |
| --- | --- | --- |
| 新增 pending 任务（`contract_create`）、调 `priority`（`task_update`）、取消**未派发**的 pending（`task_cancel`） | 组长自主完成，不产生升级、不发通知 | 否 |
| 撤回在途（`in_progress` / `in_review`）任务的分支（`task_replan` disposition `abort`） | 强制走 `kind:'replan'` 问卷，**人批之前不落盘** | 是 |
| 触及已合并代码、改 PRD 验收数值、动禁区 | **不存在越级路径**：契约正文与正式文档没有任何工具能改（`doc_write` 只收 draft 区）；变更以新契约 / 新草稿 + 审批链落地 | 是 |

- **废弃不是删除**：`task_cancel` 把任务状态置 `cancelled`，契约文件**保留在 `.tasks/` 且留在 git 历史里**（frontmatter 改 `cancelled`，看板出现「已废弃」分区）。人直接手改契约文件为 `cancelled` 同样生效（看板任务跟着走，挂着的升级一并解除）。已废弃的任务不挡完成报告，但会让下游任务响亮升级 `blocked-dependency`——修掉依赖或一并废弃，绝不静默阻塞。
- **在途任务三种处置**（`task_replan`，只收 `in_progress` / `in_review`）：
  1. **supersede** —— 原任务照原样走完评审合入（分支保留），自动派生一张修正契约（id 沿用原域取下一个空号，`depends_on` 原任务）；
  2. **continue + followup** —— 原任务不受影响，增量落到派生的新契约（不阻塞在原任务后面）；
  3. **abort** —— 丢分支 = 丢工作，必须人批准：工具只开一张 `kind:'replan'` 问卷（超时/未答按「不放弃」兜底），人批了才废弃任务、删分支、释放接手者。
  三者都只加「入口」，不造新机制：退场复用 `releaseMemberWorkspace`，派生复用 `contract_create` 的写前校验。supersede / continue **不改旧验收标准**——变更以 `[replan]` 留言 + 新契约承接，可 diff、可追溯。
- **频率上限**：`replan.maxPerHour`（默认 10，`0` 不设限）限制每小时 `task_cancel` / `task_replan` 调用总量，超限拒绝并说明原因——「无限重排」是模型自己察觉不到的失败模式。
- **重规划不续命**：任何重规划操作都**不重置** `daemon.maxTaskHours` 的计时——墙钟预算是唯一可靠的烧钱护栏，重置等于开了无限续命的口子。
- **优先级不越过依赖**：`priority` 只在依赖条件相同的任务之间生效（大者先派，同权重保持插入顺序）；前置没满足的任务无论多高优先级都排在后面。派发顺序因此是确定性的，不引入随机序。
- **PRD 引用带版本**：正式文档重批时版本自动递增（`1.0 → 1.1`），审批 provenance 与 `[decision]` 决策行随文档进 git。任务单引用 PRD 章节时写清版本，例如 `PRD §2.3@v1.7`——让「需求变了」成为可 diff 的事实而不是口头共识。

## 知识回路（learnings）

要解决的问题很朴素：**同一个坑被不同任务反复踩**。让人写文档当然对，但 agent 每任务的上下文里不会去读 `docs/` —— 所以坑必须落到**任务描述**里才真正生效。默认关闭，`learnings.enabled: true` 开启。

- **捕获**：两个自动来源（`code_review` 的 request_changes 意见、每一次 escalate，部署失败也已经收敛到升级这一条漏斗）+ 一个显式入口 `learning_record`（成员主动记一条）。原文与结论入库前统一过 `SecretRedactor` 并截断。
- **去重**：键 = `(来源, 域, 意图桶)`，其中域沿用领域锁那套前缀折叠的最小覆盖集，桶是封闭词表且优先从升级原因等封闭来源推导（不让模型自由措辞做分桶，否则永远合不到一条）。同因反复出现只累加 `hits`，并保留最新结论。
- **注入**：派发那一刻按 `touches` 相关性打分（同域 > 被印证次数 > 新鲜度），条数与字符双重预算，超出留一行指向 `learning_list`。域所有权硬规则始终留在描述最末尾。
- **升格有门槛**：`hits ≥ promoteAfterHits` 的条目进入"待升格"清单（`learning_list` 与完成报告都会列出）。之后由人或 leader 把它写进 `AGENTS.md` / `docs/`，再用 `learning_promote` 标记，它便不再参与注入。⚠️ `AGENTS.md` / `docs/` 已不是 human-only 区（2026-08-29 起默认禁区只剩 `LICENSE`），但落文档要**单独成一次 docs-only 变更**，别混进代码任务的 diff —— 删除型改动没有任何客观门可以验证，混在代码里就等于没人能审它。
- 生成物 `<stateDir>/learnings.md` 只是给人看的便利视图：与 `state.json` 同目录，**不进入目标仓库的 git 历史**（运行态不入库）。真相源始终是 `state.json`、注入走内存记录，这个文件删掉也不影响运行。

## 人工确认与问卷工单（notification）

无人值守时一旦升级（needs-human），插件会通过配置的通知通道把人"叫来"：

1. **工单端点（一份 handler，两个挂载点）**：`GET /ticket/<id>` 渲染一个表单（原因、说明、建议动作 + 用户填写决策/补充），`POST /ticket/<id>` 接收答复。
   - **独立端口**（`notification.ticket.*`，`node:http`）：只服务邮件里的链接，读写都**必须**带 `?t=<token>`。`notification.enabled: false` 时这个端口根本不监听。
   - **宿主同源路由** `/autopilot/ticket/<id>`：服务 Web 面板，提交走 `POST /autopilot/ticket/<id>/answer`（JSON）。凭"同源信任围栏"放行，不需要 token；这条路由与 SMTP 无关，**没配邮件也能在面板里作答**。
2. **SMTP 邮件通知**：按 `smtp.*` 配置发信到 `mailTo`，正文包含任务、原因、建议动作与工单链接。凭证只取环境变量名并在日志中脱敏，绝不落盘。
3. **答复闭环**：用户提交后，答复被回写到任务单（`.tasks/<id>.md`），并在 `autoResume: true` 时自动解除升级、把任务改回 `pending`、继续主循环；`autoResume: false` 则保持 `needs-human`，等你主动 `escalation_resolve`。

同一个端点也投递**提问问卷**（`ask_human` 的产物，工单 id 前缀 `qn_`，升级工单是 `esc_`）—— 两者的区别是**为什么要叫人来**：

| | 升级（escalation） | 问卷（questionnaire） |
| --- | --- | --- |
| 语义 | 「我卡住了，来个人分诊」 | 「一切正常，只是这个选择得由人来做」 |
| 任务状态 | 置 `needs-human` | **不动**任务状态，面板标「等人回答」 |
| 副作用 | 进升级直方图、自动记一条教训 | 两者都不做（没发生的教训不该被记进台账） |
| 答复落点 | 任务单留言 + 可选自动恢复 | 绑定的文档章节 / 任务契约，作为带时间戳的 `[decision]` 进 git |

- **interactive 模式**：`ask_human` 这一轮 agent 不断线，真的 await 到你答完（或 `questionnaire.timeoutMinutes` 到期）。你在工单页提交后组长立刻继续，不需要回会话说话。超时按各题 `defaultValue` 兜底并如实标 `expired`，**不会**把没人做过的决策写进文档。
- **async 模式**：问卷登记后立即返回，你答完**要回会话说一句「继续」** —— 插件没有「向会话投一条消息唤醒 agent」的写入口，这条边界不是工程能绕过的。
- **审批问卷**（`kind: approval`）：邮件/工单页里带一个**一次性审批码**，只有读到那封邮件的人拿得到。你带着码在会话里调 `doc_approve`（或自己直接调，不带 `actorId`）即完成升格；组长自己批不了自己的文档。工单页的审批下拉**预选「不批准」**（超时兜底也是它）——一张表单不该因为有人懒得点一下就交出授权。⚠️ 面板里作答走的是同一个 `ticket` 来源，因此**不再重复要码**：码保护的是"邮件链接流到了别人手里"，不保护你自己的本机控制台（能打开面板的人本来就能在会话里直接调 `doc_approve`）。

> 流程规格（阶段怎么推进、答案怎么回写、为什么这样切分）见 [docs/design-interaction.md](docs/design-interaction.md)；本节只讲配置与人要做什么。

> ⚠️ **工单鉴权（M2 起）**：每张工单铸造一个不可猜测 token（`randomBytes(16)`），它**只出现在发给你的那份文案里**（邮件、webhook），不进投影、不进日志、不进记录 —— 落盘位置是 `state.json` 的旁路表 `ticketTokens`。独立端口读写都强制带 token；**未知 id、缺 token、token 不符三者返回逐字节相同的 404**（绝不 403，否则工单号能被枚举）。`ticket.host` 配成非回环地址会**直接拒绝启动**，不是告警。
> 面板走宿主同源路由 `/autopilot/ticket/…`，那里没有 token，靠的是**信任围栏**（判据整抄宿主 `isTrustedApiRequest`）：`Host` 是回环或命中可信 authority → `sec-fetch-site !== 'cross-site'` → 有 `Origin` 时它的 host 必须等于 `Host`。这三段挡的是端口扫描、跨站表单和 DNS rebinding（少了第一段，`Host: evil.com` 与 `Origin: http://evil.com` 在 rebinding 下**相等**，光比 Origin 形同虚设）。确需公网可达宿主 web 端口，先自行反代加鉴权（basic auth / IP 白名单 / 签名 URL），再考虑开 `autoResume`。
> **诚实边界**：围栏不挡本机进程 —— 同一个用户下任意程序都能带上这些 header，`curl` 还会自己设 `Host`。这与命令白名单同一定位：防误配和顺手绕过，不防已被注入的 agent。
> `ticket.publicBaseUrl` 现在是**两重语义**：邮件里展示的工单根地址 **且** 它的 authority 被登记为同源路由的可信 `Host`（反代换了域名才答得动）。远程访问仍优先走 SSH 隧道（`ssh -L 8080:127.0.0.1:<webPort> …`：隧道打通宿主 web 端口，面板和 `/autopilot/ticket/…` 一起就都能用了；只有坚持点邮件链接才需要再单独隧道化 `ticket.port`）。⚠️ 反代若把面板挂在**子路径**下（如 `/dsh/`），根绝对路径 `/autopilot/ticket/...` 会指错，面板内作答失效 —— 请挂在域名根，或继续用邮件链接作答。

## 安全模型

1. **密钥只引用不落盘**：Config 只存环境变量名，运行时读 `process.env`；门输出、部署输出、webhook 负载、升级记录统一过 `SecretRedactor` 脱敏。
2. **命令白名单**：gates / bootstrap / deploy 的每个 shell 片段首 token 必须**精确命中** `commandAllowlist`；命令替换 `$( )` 与反引号**整条拒绝**（不做拆分放行的假象），重定向与 glob 放行（不启动新进程）；`bootstrap.systemPackages` 逐包名校验。清单含 `sh` / `node` / `ssh` / `docker` 时这道等价于没开（`node -e` 即任意执行）——定位是**防误配 + 留审计痕迹**，不防已被注入的模型。判据与实现锚点（`splitSegments` / `hasHiddenExecutable` 等）见 AGENTS.md「安全硬规则」。
3. **forbiddenPaths**：派发期查 `touches ∩ 契约自声明禁区`，落地前查分支实际 diff——approve 后的本地合并、push 自建远端（`team_branch`/成员分支）、手工合并三条路径共用同一道闸门，触及即拒并升级，ref 解析不出来同样拒绝（不静默放行）。默认禁区 2026-08-29 起只剩 `LICENSE`。⚠️ 代价：AI 团队改得了 `.github/` 里的 CI workflow，`requireCiGreen` 的考卷和答卷落在同一支笔下面——需要硬保证的项目自己把 `.github/` 配回 `security.forbiddenPaths`（**自建远端无 `.github/` CI workflow，此项在 generic 模式下天然不适用**）。
4. **门不过不合并**：`pushRequiresGates=true` 时门未绿禁 push 与 approve——本地合入 base / push 自建远端都受这道门约束；`requireCiGreen` 是只对 github 平台生效的另一道独立门（非 github / 自建远端无 CI 可查，**必须显式置 `false`**，否则「从未验证视为未通过」会永久阻塞 approve）；配了 `daemon.maxDiff*` 时体量超限也拒。
5. **破坏性 git 禁止**：不 force-push 共享分支（任务/成员分支仅限 `--force-with-lease`）、不 reset 共享分支、不删 base 分支；可变 git 操作的分支名一律过 `assertSafeRef`（不得以 `-` 开头、不得含空格或 `..`），否则一个 `-D` 就能把「删分支」拼进 argv。
6. **文档改动只有「草稿 → 人批」一条路**：`doc_write` 只收 `docs.draftDir` 里的 `.md`；`doc_approve` 拒绝任何带 `actorId`（模型身份）的调用，会话里转述的批准必须带只出现在工单页/邮件里的一次性码，落盘前比对每份草稿的 `sha256`——正文变过一个字就拒绝升格、作废审批码、重开问卷（防「批 A 合 B」）。审批**解锁不了禁区**：命中 `security.forbiddenPaths` 升格直接失败，`LICENSE` 不因任何答复而被改；`learning_promote` 只翻台账标记，落文档仍是独立的审批链变更。

## 工具一览

**团队与协作**：`team_create` / `team_add_member` / `team_list` / `team_status` / `team_branch` / `task_assign` / `task_update`（推进状态与**调 priority**） / `task_cancel`（废弃未派发的任务） / `task_replan`（在途任务三种处置） / `task_clarify` / `code_review`。

**无人值守与交付**：`autopilot_init` / `autopilot_run` / `autopilot_pause` / `autopilot_resume` / `autopilot_phase`（读/切团队阶段，见下）/ `autopilot_status` / `gates_run` / `escalate` / `escalation_resolve` / `deploy_run`；`pr_sync` 仅 github 平台用于建 PR / 查远端 CI，自建远端（generic）本地合并不用。

**知识回路**：`learning_record`（记一条坑） / `learning_list`（查台账与待升格清单） / `learning_promote`（人落文档后标记，或否掉一条）。

**运行时配置（热改，免重启）**：`config_show`（看生效配置） / `config_set`（改生效配置 —— 仓库地址、基分支、门命令等，下次操作立即生效，不必重启 dsh web；`settings → 插件 → 插件配置` 面板保存的字段同样即时生效，并随 state.json 里的 `runtimeConfig` 跨重启保持）。

**人工决策与文档先行**：`ask_human`（向人提问并拿到结构化答复；`interactive` 真的等到人答才返回） / `answer_questionnaire`（人在会话里作答，转述作答审批需带一次性码） / `doc_write`（写文档，只收 draft 区） / `doc_approve`（人把审批过的草稿升格进正式区，落盘前比对 sha256） / `contract_create`（建 `.tasks/*.md` 契约，写前校验 id / 依赖 / 成环 / 禁区 / 域数）。

**迭代周期**：`cycle_plan`（按 roadmap 拆下一期：建周期记录 + 批量契约，写前校验同 `contract_create`；可选 `checkpoint` 声明该期边界要不要请人确认） / `cycle_approve`（周期开工：`planned → in_progress`，机械动作无审批环节）。两者都是 AI 团队（组长）内部工具，用户只需在边界被问到时回「继续 / 结束」。

### 团队阶段（phase）与依赖死锁

`autopilot_phase` 不带 `phase` 参数时读当前阶段，带参数时切换。阶段是与运行状态灯**正交**的另一维度，表示团队走到流程的哪一步：

| phase | 含义 | 是否派发任务 |
| --- | --- | --- |
| `intake` | 正在问需求、写文档，还没开工 | 否 |
| `kickoff_pending_approval` | 文档等人确认 | 否 |
| `scaffolding` | 搭最小可跑框架 | 否 |
| `developing` | 正常开发（**默认值**） | 是 |
| `replanning` | 需求变更中，重排任务 | 是 |

非派发阶段下，循环照跑、`.tasks/*.md` 契约照采纳进看板、质量门照跑，只有「把 pending 任务交到开发者手上」这一步被关掉——所以文档没定稿之前，契约先写出来是安全的。新建团队与旧状态文件都默认 `developing`，升级插件不会悄悄改变既有团队的行为。

依赖死锁单独成类：`depends_on` 指向的契约**看板上不存在**（写错 id）或**已经 needs-human**，这条任务永远等不到，就按 `blocked-dependency` 升级并列出挡路的任务；只有「前置还没做完」才是正常等待，留在 `pending` 不动。同一拍内级联（A 判死 → 依赖 A 的 B 也判死），人修一处即可。面板的**卡住的任务**小节会直接显示这几个 id，不用人去猜看板为什么不动。

## Web 面板

在 `conversation.input.dock` 插槽渲染：运行状态灯（running/paused/escalated/completed/stopped）+ **阶段徽标**（非派发阶段用「等待」配色，标题栏另挂一个「N 项等你决策」的琥珀计数）、八列看板（含 needs-human、needs-clarification 与 cancelled，挂着未答问卷的任务额外标一个**等人回答**）、质量门徽标与 CI 徽标（CI 徽标仅 github 平台有数据，自建远端 generic 下无）、**等你决策**（未答问卷直接内联成表单）、**升级事件流**（未解除的升级同样内联一张 decision + note 表单）、问卷流水（只留历史：`已答复` / `已答复，等组长继续` / `已超时` / `已取消`）、部署历史、**已知教训**（按被印证次数排序，含已升格标记）、**卡住的任务**（前置无法满足的依赖）。数据流沿用 session 事件（`autopilot/update` 全量快照）+ 投影（last-write-wins），不引入 RPC。看板主体为 **CSS 多列瀑布流**（`columns` 断列，容器不跨栏断裂）：各状态列按分组紧凑排布、有内容的撑开、空列不占大片空白，未绑定任务的开放式问卷并入「等你决策」容器（计数只统计 `open` 且未绑定任务的）。看板主体高度默认不超过 `min(62vh, 720px)`、超出内部滚动，右下角有拖拽手柄可手动改高度（`resize: vertical`）。无人值守循环每拍有状态变更时主动向会话推一帧最新投影（空闲退避时不推），让面板的 in_progress / in_review 中间态与 state.json 对齐、不再滞拍。

> **面板内直接作答（M2）**：提交打到同源相对路径 `POST /autopilot/ticket/<id>/answer`，不需要外部浏览器、也不需要知道工单端口。漏必填项时**保留你已填的内容**并重述缺失项；成功后卡片等服务端推回来的新快照翻「已答复」，不做乐观更新。面板上**不再有跳外部的工单链接** —— 投影里的 `ticketUrl` 刻意不带凭据，从面板点过去必然 404，那是我们自己发布坏按钮；要在面板外作答请用邮件里的链接（带 token）或在会话里直接调 `answer_questionnaire`。

另在 **设置 → 插件 → 插件配置** 挂了一张 `autopilot` 卡片：绑定服务端 `ctx.settings.register` 注册的 `autopilot` 命名空间，暴露关键字段供编辑保存、写入用户设置层；服务端经 `installSettingsSection` 读到生效配置（无设置服务时回退 entry config）。字段保存后**即时热生效**（服务端把保存结果经 `setRuntimeConfig` 投递给运行中的 AutopilotService，落进 state.json 的 `runtimeConfig`），无需重启；`remote.url`、`baseBranch`、门命令等改完下一次操作就用新值。leader 也可在会话里用 `config_set` 直接改（见> 工具一览）。

## Agent 预设：Autopilot 团队（一键切换模式）

想让"启用"变成一次**切换模式**而不是改配置，用 DSH 的 agent preset 机制即可。插件自带一个 `autopilot-team` agent 预设：

- **随包分发 + 自动落盘**：模板在插件包内 `preset/autopilot-team/`（已加入 `package.json` 的 `files`）；`apply()` 时由 `ensureAutopilotTeamPreset()` 拷到用户级预设根 `~/.dsh/.agent-presets/autopilot-team/`（缺失才拷、绝不覆盖、失败静默不阻塞加载），安装并重启后即出现在 agent 模式列表，无需手建文件。
- **组合内容**：`agent.cordis.yml` 复刻 `standard` 的全套工具（shell/fs/subagent/workflow 等）并把人格设为 autopilot 团队编排队 leader；`preset.yml` 提供名称/描述/排序。选中后该会话即变成无人值守团队的编排队（`dsh-ai-team` 的宿主插件工具全站全局，无需重复 include）。
- **自动开箱感应**：插件监听 `agent-preset/selected` 事件，选中 `autopilot-team` 时自动创建一个 `demo` 团队（仅当尚无团队才创建）并把投影快照推到该会话，看板立即点亮，无需手动先调 `team_create`。

> **重启生效**：预设目录盘点无缓存，落盘后刷新模式列表即见；但自动建 `demo` 团队的钩子在宿主 `lib/index.js` 里，改宿主代码后需**重启服务端**。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc strict，0 error
pnpm lint        # oxlint，0 warning
pnpm test        # vitest：集成（真实本地 bare 仓库模拟 remote）+ 无人值守 + 通知闭环（mock SMTP + 工单端点）+ cordis 冒烟
pnpm build       # tsc + tsdown → lib/{index.js, client.js}

# 发布前跑一次完整校验（prepublishOnly 会自动执行下面的组合）
pnpm pack --dry-run   # 查看将打进 npm 包的文件清单
```

架构约定：核心服务 `AutopilotService` 与 cordis 完全解耦（不 import ctx），可独立实例化跑测试；插件层只做四导出（`name` / `inject` / `Config` / `apply`，只命名导出）、服务暴露（`ctx.provide('autopilot')`）、工具注册与 `ctx.effect` 清理。

> **贡献与发布**：遵循 MIT 协议。`npm publish` 前会自动执行 `prepublishOnly` 校验（typecheck + lint + test + build），全部通过才会发包。仓库与 issue 见 [github.com/yunqiangwu/dsh-ai-team](https://github.com/yunqiangwu/dsh-ai-team)。

## 故障排查

按「症状 → 原因 → 处置」组织；运维视角的巡检与分诊表见 [PILOT.md](PILOT.md)，这里只收最常撞上的几类。

### `autopilot_init` 失败，升级原因 `bootstrap-failed`

- **症状**：引导直接升级并抛错，升级记录的 logTail 里是脚本报错。
- **原因**：`bootstrap.setupCommand` / `verifyCommand` 指向目标仓库里不存在的脚本，或工具链/系统包缺失——命令跑不起来时引导宁可贵也不装作成功。
- **处置**：修 bootstrap 配置（或先把脚本补进仓库），缺的系统包配 `bootstrap.systemPackages` + `packageManagerCommand`，然后重新 `autopilot_init`（幂等）。启动前先手动预演一遍这两条命令。

### 非 github 平台 approve 永远被拒：`requireCiGreen is on but CI was never checked`

- **症状**：`code_review` approve 总是被拒，提示 CI 从未验证。
- **原因**：CI 状态查询只有 github 适配；其它平台（generic 自建远端等）`pr_sync` 恒置 `unknown`，而「从未验证视为未通过」会让这道门永远过不去。
- **处置**：自建远端模式显式把 `gates.requireCiGreen` 设为 `false`，并知情接受「本地门是唯一自动门」；本地合并后 push 到自建远端，全程不依赖远端 CI。若日后切回 github 平台，才需要先 `pr_sync` 让 CI 真跑一遍。

### 设置卡片改了配置不生效（已修复：不需重启）

- **症状**：设置 → 插件 → 插件配置里保存成功，行为没变。
- **原因（旧版）**：`autopilot` 设置命名空间在插件加载时注册，运行中的服务端读的还是装载时的那份。改动需要带 `--patch` 重启服务端。
- **现在**：保存即热生效（经 `setRuntimeConfig` 投递 + 落进 state.json 的 `runtimeConfig`），下次操作就用新值。
- **提醒**：唯一仍需重启的场景是**首次加载该插件**（命名空间与工具注册发生在装载时），以及**改了会在 `create()` 才派生一次的东西**（如 `remote.url` 对已克隆团队的 origin 不会自动改指 —— 新团队/新 clone 才用新地址）。

### 任务被升级为 `task-stuck` 或 `budget-exceeded`

- **症状**：任务变 `needs-human`，升级原因二者之一。
- **原因**：`task-stuck` = `stuckMinutes` 内无任何 git 活动（**空闲**失控）；`budget-exceeded` = 派发后超过 `daemon.maxTaskHours` 仍未完成（**活跃空转**）——插件看不见成员 agent 的 token 消耗，墙钟是唯一可靠的失控信号。
- **处置**：看该成员 worktree 的 git log：有产出 → 任务太大，拆单再放行；没产出 → 契约含糊，改契约。分诊手段（面板内联表单 / 邮件工单 / `escalation_resolve`）见 [PILOT.md](PILOT.md) 升级分诊表。

### 工单端点起不来或邮件里的工单链接打不开

- **症状**：`notification.ticket.host` 配成非回环地址时**服务端直接拒绝启动**（不是告警）；或邮件链接在远程机器上打不开。
- **原因**：工单端点收的答案等于替 AI 团队做决策，只在回环上提供（`127.0.0.1`）；端点监听失败（端口被占）则退化为「没有工单端点」，面板同源路由与 `answer_questionnaire` 仍可用。
- **处置**：保持 `127.0.0.1` 绑定，远程访问走 SSH 隧道；端口冲突换 `ticket.port`。反向代理若把面板挂在子路径下，面板内作答会 404——挂域名根或改用邮件链接，见「工单鉴权」。

### 状态文件损坏后团队「消失」

- **症状**：重启后看板全空，stateDir 里出现 `state.json.corrupt-<时间戳>`。
- **原因**：`state.json` 解析失败（多半是进程被硬杀写坏了文件）。插件宁可空着启动，也不会用空状态覆盖唯一一份历史——坏文件被改名留存。
- **处置**：先救 `corrupt-` 文件（手工修复末尾截断的 JSON 后改回 `state.json`），再重启；别让新状态先落盘。

### 看板上有契约却告警 `contract-rejected`

- **症状**：日志/事件里出现 `contract-rejected:<路径>`，其余契约照常收养。
- **原因**：某个 `.tasks/*.md` 的 frontmatter 写坏了（缺 `---`、缺 `id`、YAML 语法错）。**一个坏文件只弄坏它自己**，不会清空整块看板。
- **处置**：修好那个文件即可；同一文件只上报一次，反复出现说明文件又被改坏了。
