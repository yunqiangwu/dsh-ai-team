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

| 协作与工程模型 | 无人值守与交付闭环 |
| --- | --- |
| leader / developer / reviewer / **operator** 四角色团队 | **客观质量门**：gates_run 全绿才可 approve/push；远端 CI 绿才可合并 |
| 每成员一个 git worktree，共享 object store | 远程 git：clone / push / PR（`GIT_SSH_COMMAND` 注入密钥） |
| 任务看板 + `task/<id>` 分支 | `.tasks/*.md` 任务契约集成（frontmatter 真相源 + `_board.md` 自动生成） |
| `code_review` 审查门控，按画像策略合入 | **知识回路**：自动捕获评审打回与升级 → 注入后续任务描述 → `learnings.md` 台账（落 stateDir，不入库）；升格进项目文档由人裁决 |
| **`task_clarify`**：契约含糊退回 leader，不消耗返工轮次 | 主循环：崩溃恢复、依赖/域锁派发、卡死检测、空转降频、完成报告 |
| **团队阶段（phase）**：`intake → 文档待批准 → 脚手架 → 开发 ⇄ 重排`，非派发阶段不把任务交出去 | **依赖死锁**单列 `blocked-dependency`：只有前置不存在或已 needs-human 才判死，同一拍级联 |
| session 事件 + 投影 + Web 看板 | 升级机制：`needs-human` 打标 + 任务单留言 + webhook 通知 + 粒度化暂停 |
| — | 前置门：派发期 `touches ∩ forbidden` 自洽校验、评审期改动体量门（`maxDiffLines`/`maxDiffFiles`） |
| — | 部署闭环：健康检查（指数退避）+ 自动回滚 + 部署历史（纯 `.tasks/` 提交不触发部署） |
| — | 人工确认：邮件通知 + 问卷工单，答复自动回写、可自动恢复循环 |
| — | 安全硬规则：密钥只引用不落盘、命令白名单、forbiddenPaths、push 安全 |

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
          url: git@github.com:org/repo.git   # 可为空仓库
          sshKeyEnv: AUTOPILOT_GIT_KEY       # 环境变量名，禁止直接传密钥值
          platform: github                    # github | cnb | gitlab | generic
          apiTokenEnv: GITHUB_TOKEN           # PR/CI API token 的环境变量名
        bootstrap:
          enabled: true
          toolchain: [git, bun, pnpm, node]       # bun rootless 装到 ~/.bun；node rootless 装到 ~/.node
          setupCommand: pnpm run setup            # 仓库内一键初始化
          verifyCommand: pnpm run e2e:local       # 环境自验证
          systemPackages: [python3, make, g++]    # 原生模块(node-gyp)编译所需，如 better-sqlite3
          packageManagerCommand: sudo apt-get install -y   # 系统包安装命令，须命中白名单
          envFile: .env                           # 从模板生成 .env（不覆盖已有，缺省不动作）
          envExample: .env.example                # 模板路径；配了才生成
          requiredEnvKeys: [AUTH_SECRET]          # 缺失则引导 fail-loud 并指明 key
        gates:
          commands: [pnpm run typecheck, pnpm run lint, pnpm run test, pnpm run build]
          requireCiGreen: true                # 独立于 pushRequiresGates 的一道门；未 pr_sync 视为未验证即拒 approve。仅 github 查得到 CI，其它平台请设 false
          timeoutMinutes: 30
        daemon:
          maxReviewRounds: 3                  # 返工上限，超过升级
          stuckMinutes: 45                    # 无 git 活动超时，升级
          pollIntervalSeconds: 30             # 循环轮询间隔；心跳每拍落 heartbeat.json，崩溃可恢复
          maxDiffLines: 0                     # 评审体量门：单任务累计增删行上限；超限不许 approve 而是升级 change-too-large。0=关闭
          maxDiffFiles: 0                     # 同上按变更文件数。默认关闭：大 diff 的浅审是静默失败，但开启会改变既有团队行为
          maxTaskHours: 0                     # 单任务墙钟预算（小时，允许小数）：派发后超时未完成即升级 budget-exceeded。0=关闭；无人值守跑真实项目时建议显式开启
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
            host: 127.0.0.1                   # 端点无鉴权：默认只绑回环，远程访问请走 SSH 隧道
            port: 8080                        # 0=自动分配端口
            publicBaseUrl: http://server.example.com  # 邮件里展示的工单根地址
          autoResume: false                   # 工单答复后自动回写并解除升级；端点受保护后再开
        deploy:
          enabled: false
          command: 'docker build -t app . && docker push ... && ssh ... docker compose up -d'
          healthCheckUrl: https://app.example.com/health
          rollbackCommand: 'ssh ... docker compose rollback'
          secretsEnv: []                      # 部署密钥环境变量名白名单
          skipTasksOnlyCommits: true          # base 只前进了 .tasks/ 提交（任务单回写/看板重生成）时不部署：这类提交不含代码，误部署还会触发回滚与升级
        security:
          forbiddenPaths: ['LICENSE']                             # 默认禁区（2026-08-29 起只剩 LICENSE：AGENTS.md / .github 已移出，AI 团队可改可提交）
          commandAllowlist: [pnpm, git, bun, docker, node, bunx, ssh, nuxt]   # 可执行命令精确匹配白名单
          pushRequiresGates: true             # 门不过禁止 push 与 approve
        buildCache:                           # 可选：构建缓存（默认关闭）
          enabled: true                       # 把 .nuxt/.output/coverage 等软链到共享目录，减少每条任务全量 build
          dirs: ['.nuxt', '.output', 'dist', 'coverage', '.vitest', 'node_modules/.cache']
        learnings:                            # 可选：知识回路（默认关闭，开启会改变成员看到的提示词）
          enabled: true                       # 自动捕获评审打回与升级，并把教训注入后续任务描述
          injectMaxCount: 5                   # 单任务最多注入几条教训（相关域优先，再按被印证次数）
          injectCharBudget: 1200              # 注入字符预算：描述会整体进投影事件推给前端，必须有界
          promoteAfterHits: 3                 # 同因被印证这么多次，就值得人写进项目文档（插件绝不代笔改文档）
          maxEntries: 200                     # 台账上限，超出淘汰"命中少且久未被印证"的记录
        questionnaire:                        # AI 向人提问（问卷 ≠ 升级：不置 needs-human、不进升级直方图）
          mode: interactive                   # interactive：ask_human 真的 await 到人答复才返回，组长这一轮不断线
                                              # async：登记 open 问卷 + 投递后立即返回，人答完回会话说一句「继续」
          timeoutMinutes: 60                  # interactive 的等待上限；超时按各题 defaultValue 继续并标 expired（不写进文档）
        docs:                                 # 文档先行的目录约定
          draftDir: docs/drafts               # AI 唯一可写区：doc_write 只收这个区里的 .md
          formalDir: docs                     # 正式区唯一落盘出口是 doc_approve（人 + 一次性审批码 + sha256 比对）
        profile:                              # 项目约定适配器（可选，见下方说明）
          preset: agentdeploy                 # 'default' | 'agentdeploy'；留空 = default
          # 其余字段可逐项覆写 preset；缺省回退到 preset 默认值。
          #   branchTemplate: 'agent/{id}-{slug}'
          #   prTitleTemplate: 'feat({scope}): [{id}] {title}'
          #   mergeStrategy: squash            # no-ff | squash | merge
          #   gates:                           # 每条可带 when(touches 前缀)/role(local|ci)
          #     - command: pnpm run typecheck
          #     - command: pnpm run db:check-parity
          #       when: [server/db/]
          #     - command: pnpm audit --audit-level=high
          #       role: ci                     # 仅由远端 CI 强制，本地不跑不红门
```

## 项目 Profile（约定适配器）

不同仓库的协作"纹路"往往同构但细节不同：分支命名（`task/<id>` vs `agent/<id>-<slug>`）、PR 标题（`[id] title` vs `feat(scope): [id] desc`）、合并策略（`--no-ff` vs **squash**）、以及**域条件**与**CI-only** 的质量门。与其把某一种约定写死在引擎里，`profile` 把「一个项目一套约定」编码成可配的适配层。默认 `default` 完全复刻历史行为；项目 `preset`（内置 `agentdeploy`）只在有差异的字段上覆写，其余内联字段可再逐项覆盖（缺省回退到 preset 默认值）。

`profile` 字段一览（全部可选）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `preset` | `default` | `default`（历史行为）或 `agentdeploy`（AgentDeploy 约定） |
| `branchTemplate` | `task/{id}` | 分支名模板；`{id}`=任务号、`{slug}`=标题 kebab-case |
| `prTitleTemplate` | `[{id}] {title}` | PR 标题模板；`{id}`/`{title}`/`{scope}` |
| `prBodyTemplate` | `关联任务单…` | PR 正文模板；`{id}`/`{title}`/`{touches}`/`{scope}`/`{assignment}` |
| `mergeStrategy` | `no-ff` | `no-ff`/`merge`/**`squash`**（squash 保 main 线性，可独立 revert） |
| `gates` | `[]`→`gates.commands` | 每条 `{command, when?, role?}`；`when` 按任务 `touches` 前缀条件触发；`role:'ci'` 只由远端 CI 强制 |
| `forbidden` | `[]`→`security.forbiddenPaths` | `{path, mode}`；`block`=命中即拒并升级，`needs-approval`/`high-conflict`=命中暂缓 push、等 owner/人工确认后单独 PR |
| `ownership` | `[]` | `{glob, role}` 路径→域 owner 映射（域专精路由预留） |
| `crossDomainThreshold` | `3` | 触碰 > N 个不同域即升级 |

**为 AgentDeploy 开箱：`preset: agentdeploy`** 会一并得到 `agent/<id>-<slug>` 分支、`feat(scope): [id] desc` PR 标题、squash 合并，以及一组**域条件 + CI-only** 的门（`db:check-parity` 只在碰 `server/db/`、`validate:docs` 只在碰 `.tasks/` 或 `docs/`、`pnpm audit` 标 `role:'ci'` 所以本地不红、重门 `build`/`test:e2e` 只在碰源码目录）——见 [`src/profile.ts`](src/profile.ts) 的 `agentdeployProfile`。

> **域专精路由**：`ownership` 命中的任务优先派给 `specialization` 匹配的 developer（`team_add_member` 可传 `specialization`），并把匹配的域硬规则注入任务描述；契约的 `forbidden` frontmatter 原位保序回写、不重排，避免触发项目严格的 `validate:docs`。

## 无人值守主循环

每 `pollIntervalSeconds` 一拍（每拍先落心跳到 `<stateDir>/heartbeat.json`）：

1. **恢复检查**：读 state.json + heartbeat 重建内存态；上次崩溃时仍 `in_progress` 的任务在首拍被报告进 `recovered`，**状态与接手者都不动**（抢回 pending 会把同一任务分支二次派给别人）—— 真正的收敛来自同拍的卡死检测：无新 git 活动即升级 `needs-human` 交人分诊。恢复的循环状态：持久化为 `running` 的一律降为 `paused`，等待 `autopilot_resume`。state.json 解析失败时先改名留存为 `state.json.corrupt-<时间戳>` 再空启动，不会静默覆盖掉唯一一份历史。
2. **分诊挂起态**：`needs-human` 与 `needs-clarification` 都属"等人/等 leader 动一下"；人工把任务单状态改回 `pending`（或调用 `escalation_resolve`、leader 用 `task_update` 带 `note` 回答）→ 任务回到待派发，关联升级标记 resolved。
3. **派发**：先看**团队阶段**——`intake`/`kickoff_pending_approval`/`scaffolding` 不派发（契约仍照采纳、门照跑，只是不把任务交出去），`developing`/`replanning` 才继续。然后 `depends_on` 全部 done 且 `status=pending` 的任务，先做跨域与**契约自洽校验**（`touches ∩ forbidden = ∅`，违规即升级 `forbidden-paths` 并跳过），再过域锁（`in_progress`/`in_review` 任务 `touches` 目录交集为空）→ 派给空闲 developer，并在**这一刻**按最新契约正文与最新教训重建任务描述（知识要在工作开始的那一刻最新鲜）。
4. **审查闸门**：reviewer 调 `code_review` approve 前必须 `gates_run` 全绿（`pushRequiresGates`）；有远端 CI 且 `requireCiGreen` 时 CI 必须绿，且必须真验证过（未 `pr_sync` 视为未验证 → 拒）；配了 `daemon.maxDiffLines`/`maxDiffFiles` 时改动体量超限也拒（升级 `change-too-large`）；合并前还要查分支相对 base 的 diff 是否触及禁区，命中即拒绝并升级 `needs-human`。都过了才按画像策略合入 base；合并冲突拒绝并保持 `in_review`。
5. **返工与澄清**：`request_changes` 的意见会写进任务单 `.tasks/<id>.md` 并捕获成教训；轮次 ≥ `maxReviewRounds` → escalate。若问题出在契约本身，developer 走 `task_clarify` 退回 leader——不消耗返工轮次、不产生升级。
6. **卡死与预算**：任务 `stuckMinutes` 无 git 活动 → escalate（空闲失控）；派发后超过 `daemon.maxTaskHours`（默认关闭）仍未完成 → 升级 `budget-exceeded`（活跃空转）。插件看不见成员 agent 的 token 消耗，墙钟预算是唯一可靠的烧钱护栏。
7. **部署**：base 有合并且 `deploy.enabled` 且 CI 绿 → `deploy_run`；base 仅前进在 `.tasks/` 提交上时跳过（`skipTasksOnlyCommits`，默认开）；健康检查 3 次失败自动 `rollbackCommand` 并升级 —— 回滚命令自身也非零时记 `rollback-failed`（线上既没升上去也没退回来，需立刻救火），不与 `rolled-back` 混为一谈。
8. **空转保护**：连续无事件拍降频轮询（最多 4×）；所有任务 done → 写 `<stateDir>/completion.md` 完成报告（含本轮教训与**待升格清单**）并停机等待。

**升级触发条件**（任一命中即 escalate，禁止自行绕过）：需求矛盾 / 跨 3+ 域改动 / 需新增付费依赖或密钥 / 非本任务导致的门红 / 触及 forbiddenPaths / 返工超限 / 改动体量过大 / 前置依赖永远等不到（`blocked-dependency`）/ 任务卡死 / 超出任务墙钟预算 / 部署连续失败 / 引导失败。契约含糊不在其中——那走 `task_clarify`。

## 任务契约（.tasks/*.md）

任务真相源是仓库内 `.tasks/<id>.md` 的 YAML frontmatter + Gherkin 验收：

```markdown
---
id: CORE-1
title: set up core module
status: pending        # pending → in_progress → in_review → done
                       # 分支态：changes_requested / needs-clarification（等 leader）/ needs-human（等人）
owner: dev-1
depends_on: [CORE-0]
touches: [server/core/]
forbidden: [server/core/legacy/]   # 本任务不得触碰的路径（按任务划分的禁区）
---

Given/When/Then 验收标准……
```

- `task_assign` 传 `contractId` 时校验任务单存在且状态为 `pending`，title/depends_on/touches 以任务单为准。
- `forbidden` 不只是给人看的注释：派发期会拿它和 `touches` 求交（两个方向都算，`touches: [app/]` 命中 `forbidden: [app/server/]` 同样违规），违规立刻升级，而不是白跑一轮门和评审才被 CI 拦下。
- 每次状态变更回写 frontmatter 并重新生成 `.tasks/_board.md`（自动生成，勿手改），改动以插件身份提交在 base 分支，保持集成检出干净。
- **一个坏文件不拖垮整块看板**：契约是逐文件解析的，某个 `.md` frontmatter 写坏了只跳过它并上报一次 `contract-rejected`（同一文件不重复报，否则每拍都产生事件、空转降频永远生效不了），其余契约照常采纳。以前这里是一处 `throw`——模型手滑写坏一个文件，整块看板就会被静默清空。
- **评审与澄清都留痕在任务单里**：`request_changes` 的意见、`task_clarify` 的提问、leader 的 `clarify-answer` 都以带时间戳的留言追加进正文 —— 换人接手或换场会话，接得上上下文。
- `<stateDir>/learnings.md` 同为生成物（程序全量重写），见下节。
- developer 的 DoD：质量门全绿 + 每条验收标准的验证证据写入 PR 描述。

## 知识回路（learnings）

要解决的问题很朴素：**同一个坑被不同任务反复踩**。让人写文档当然对，但 agent 每任务的上下文里不会去读 `docs/` —— 所以坑必须落到**任务描述**里才真正生效。默认关闭，`learnings.enabled: true` 开启。

- **捕获**：两个自动来源（`code_review` 的 request_changes 意见、每一次 escalate，部署失败也已经收敛到升级这一条漏斗）+ 一个显式入口 `learning_record`（成员主动记一条）。原文与结论入库前统一过 `SecretRedactor` 并截断。
- **去重**：键 = `(来源, 域, 意图桶)`，其中域沿用领域锁那套前缀折叠的最小覆盖集，桶是封闭词表且优先从升级原因等封闭来源推导（不让模型自由措辞做分桶，否则永远合不到一条）。同因反复出现只累加 `hits`，并保留最新结论。
- **注入**：派发那一刻按 `touches` 相关性打分（同域 > 被印证次数 > 新鲜度），条数与字符双重预算，超出留一行指向 `learning_list`。域所有权硬规则始终留在描述最末尾。
- **升格有门槛**：`hits ≥ promoteAfterHits` 的条目进入"待升格"清单（`learning_list` 与完成报告都会列出）。之后由人或 leader 把它写进 `AGENTS.md` / `docs/`，再用 `learning_promote` 标记，它便不再参与注入。⚠️ `AGENTS.md` / `docs/` 已不是 human-only 区（2026-08-29 起默认禁区只剩 `LICENSE`），但落文档要**单独成一次 docs-only 变更**，别混进代码任务的 diff —— 删除型改动没有任何客观门可以验证，混在代码里就等于没人能审它。
- 生成物 `<stateDir>/learnings.md` 只是给人看的便利视图：与 `state.json` 同目录，**不进入目标仓库的 git 历史**（运行态不入库）。真相源始终是 `state.json`、注入走内存记录，这个文件删掉也不影响运行。

## 人工确认与问卷工单（notification）

无人值守时一旦升级（needs-human），插件会通过配置的通知通道把人"叫来"：

1. **本地问卷工单端点**：插件用 `node:http` 起一个本地端点，`GET /ticket/<id>` 渲染一个表单（原因、说明、建议动作 + 用户填写决策/补充），`POST /ticket/<id>` 接收答复。
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
- **审批问卷**（`kind: approval`）：邮件/工单页里带一个**一次性审批码**，只有读到那封邮件的人拿得到。你带着码在会话里调 `doc_approve`（或自己直接调，不带 `actorId`）即完成升格；组长自己批不了自己的文档。工单页的审批下拉**预选「不批准」**（超时兜底也是它）——一张表单不该因为有人懒得点一下就交出授权。

> 流程规格（阶段怎么推进、答案怎么回写、为什么这样切分）见 [docs/design-interaction.md](docs/design-interaction.md)；本节只讲配置与人要做什么。

> ⚠️ 工单端点**没有任何鉴权**：能访问它的人就能替你做「人工确认」这个决定。默认只绑 `127.0.0.1`，远程访问优先走 SSH 隧道（`ssh -L 8080:127.0.0.1:8080 …`）。确需公网可达，必须先自行反代加鉴权（basic auth / IP 白名单 / 签名 URL），再考虑开 `autoResume`——否则「答复即放行」是任何人都按得动的按钮。`ticket.publicBaseUrl` 只决定邮件里展示的工单根地址。

## 安全模型

1. **密钥只引用不落盘**：Config 只存环境变量名；运行时读 `process.env`；所有日志（门输出、部署输出、webhook 负载、升级记录）经 SecretRedactor 强制脱敏。
2. **命令白名单**：gates / bootstrap / deploy 的每个 shell 片段（按 `&& || ; | &` 与换行拆分）的可执行文件必须**精确命中** `commandAllowlist`，否则拒绝执行并提示走升级；会"藏进程"的构造 —— 命令替换 `$( )` 与反引号 —— **整条拒绝**（不做拆分放行的假象），而重定向与 glob 不启动新进程、继续放行。`bootstrap.systemPackages` 逐包名校验字符集，防止拼进 shell 后绕过 pm 的白名单检查。实话：清单里含 `sh` / `node` / `ssh` / `docker` 时这道就等价于没开（`node -e` 即任意执行），它的定位是**防误配 + 留审计痕迹**，不是防一个已被注入的模型。
3. **forbiddenPaths**：派发期就检查 `touches` 是否踩到契约自声明的禁区；改动落地前再检查分支实际 diff —— `pr_sync` 推送、reviewer approve 合并、`team_branch` 手工合并三条路径共用同一道闸门，触及禁区直接拒绝并升级；ref 解析不出来同样拒绝（不静默放行）。默认禁区自 2026-08-29 起只剩 `LICENSE`。⚠️ 代价要说清：`.github/` 移出后 AI 团队改得了把关自己的 CI workflow，`requireCiGreen` 的考卷和答卷落在同一支笔下面 —— 需要硬保证 CI 配置不被改的项目，自己把 `.github/` 配回 `security.forbiddenPaths`。
4. **门不过不合并**：`pushRequiresGates=true` 时门未绿禁止 push 与 approve；`requireCiGreen` 是另一道独立的门（不被前者短路），CI 非绿或从未验证（未 `pr_sync`）都禁止 approve —— 但 CI 状态只有 github 平台查得到，其它平台该门不生效；配了 `daemon.maxDiff*` 时改动体量超限也拒。
5. **破坏性 git 操作禁止**：不 force-push 共享分支（任务/成员分支仅允许 `--force-with-lease`），不 reset 共享分支，不删 base 分支。所有可变 git 操作（create / checkout / merge / delete / push）的分支名一律过 ref 名安全校验：不得以 `-` 开头、不得含空格或 `..` —— 否则一个 `-D` 就能被 git 当成「删分支」选项。
6. **文档改动只有「草稿 → 人批」一条路**：`doc_write` 只收 `docs.draftDir` 里的 `.md`，正式区的唯一出口是 `doc_approve` —— 它拒绝任何带 `actorId`（即模型身份）的调用，会话里转述的批准必须带上只出现在工单页 / 邮件里的一次性码，落盘前还要把每份草稿的 `sha256` 与当初给人看的那份比对：正文变过一个字就拒绝升格、作废审批码、重开一份问卷（防「批 A 合 B」）。审批**解锁不了禁区**：目标路径命中 `security.forbiddenPaths` 时升格直接失败，`LICENSE` 不因任何答复而被改。教训侧同理：`learning_promote` 只翻台账标记，把教训写进文档仍然是一次独立的、走同一条审批链的 docs-only 变更。

## 工具一览

**团队与协作**：`team_create` / `team_add_member` / `team_list` / `team_status` / `team_branch` / `task_assign` / `task_update` / `task_clarify` / `code_review`。

**无人值守与交付**：`autopilot_init` / `autopilot_run` / `autopilot_pause` / `autopilot_resume` / `autopilot_phase`（读/切团队阶段，见下）/ `autopilot_status` / `gates_run` / `pr_sync` / `escalate` / `escalation_resolve` / `deploy_run`。

**知识回路**：`learning_record`（记一条坑） / `learning_list`（查台账与待升格清单） / `learning_promote`（人落文档后标记，或否掉一条）。

**人工决策与文档先行**：`ask_human`（向人提问并拿到结构化答复；`interactive` 真的等到人答才返回） / `answer_questionnaire`（人在会话里作答，转述作答审批需带一次性码） / `doc_write`（写文档，只收 draft 区） / `doc_approve`（人把审批过的草稿升格进正式区，落盘前比对 sha256） / `contract_create`（建 `.tasks/*.md` 契约，写前校验 id / 依赖 / 成环 / 禁区 / 域数）。

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

在 `conversation.input.dock` 插槽渲染：运行状态灯（running/paused/escalated/completed/stopped）+ **阶段徽标**（非派发阶段用「等待」配色）、七列看板（含 needs-human 与 needs-clarification，挂着未答问卷的任务额外标一个**等人回答**）、质量门徽标与 CI 徽标、**等你回答**（问卷流水：`等你回答` / `已答复，等组长继续` / `已超时`，带工单链接）、升级事件流、部署历史、**已知教训**（按被印证次数排序，含已升格标记）、**卡住的任务**（前置无法满足的依赖）。数据流沿用 session 事件（`autopilot/update` 全量快照）+ 投影（last-write-wins），不引入 RPC。

> 面板上的问卷是**只读**的（M1 口径）：作答入口是浏览器里的工单页，或会话里直接调 `answer_questionnaire`。面板内可作答的问卷卡片属 M2。

另在 **设置 → 插件 → 插件配置** 挂了一张 `autopilot` 卡片（`settings.plugin.item` 键控命名空间）。它绑定服务端 `ctx.settings.register` 注册的 `autopilot` 命名空间，暴露关键字段（`remote.url`、`baseBranch`、`bootstrap.enabled`、`gates.commands`、`daemon.maxReviewRounds`/`stuckMinutes`/`maxDiffLines`、`learnings.enabled`）供编辑保存，写入用户设置层；服务端通过 `installSettingsSection` 让插件读到生效配置（无设置服务时回退到 entry config）。因命名空间在插件加载时注册，改动需**带 `--patch` 重启服务端**后生效。

## Agent 预设：Autopilot 团队（一键切换模式）

想让"启用"变成一次**切换模式**而不是改配置，用 DSH 的 agent preset 机制即可。插件自带一个 `autopilot-team` agent 预设：

- **随包分发**：模板在插件包内 `preset/autopilot-team/`（已加入 `package.json` 的 `files`），随 `npm/pnpm publish` 一起发布。
- **自动落盘**：插件 `apply()` 里通过 `src/preset.ts` 的 `ensureAutopilotTeamPreset()` 把这个模板拷贝到用户级预设根 `~/.dsh/.agent-presets/autopilot-team/`，**缺失才拷贝、绝不覆盖**（用户自建的 `autopilot-team` 优先），失败静默不阻塞加载。因此**安装并重启后即可在 agent 模式列表里看到「Autopilot 团队」**，无需手建文件。
- **组合内容**：`agent.cordis.yml` 复刻 `standard` 的全套工具（shell/fs/subagent/workflow 等）并把人格设为 autopilot 团队编排队 leader；`preset.yml` 提供名称/描述/排序。
- **效果**：在 agent 模式列表里切到 **Autopilot 团队**，该会话就变成"无人值守 AI 软件团队"的编排队；`dsh-ai-team` 的宿主插件工具是全站全局的，本预设无需重复 include。
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
