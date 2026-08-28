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
          toolchain: [git, bun, pnpm]         # bun rootless 装到 ~/.bun
          setupCommand: pnpm run setup        # 仓库内一键初始化
          verifyCommand: pnpm run e2e:local   # 环境自验证
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
```

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
