# 试点 Runbook：首次真实环境无人值守

> 面向操作者（人），不是给插件的 AI 团队读的。试点验证的是**"模型在环"的协作质量**——这是合成测试覆盖不了的部分；编排引擎的正确性已由测试套件锁定，不要在试点里重复验证它。配置字段语义以 [README.md](README.md) 为准，本文只讲"怎么跑、看什么、出事怎么办"。

## 0. 试点要回答的问题

| 问题 | 数据来源 |
| --- | --- |
| 任务能否无人介入跑完闭环（派发 → 门 → 审查 → 合并）？ | 完成率 = completed / dispatched（完成报告 run metrics 段直接给） |
| 升级是否事出有因、原因人人能懂？ | 升级直方图（面板「运行指标」/ completion.md） |
| 成本是否失控？ | `budget-exceeded` 计数与单任务耗时行（同一处） |
| 同一个坑是否反复踩？ | `learnings.md` 的 hits 增长 |

**放权递进**（每级稳定通过才进下一级）：

| 级别 | 任务形态 | 验证点 |
| --- | --- | --- |
| L0 | 文档 / 任务单类改动 | clone、派发、门、审查、合并全闭环；不碰禁区 |
| L1 | 单点 bug（单文件，带复现测试） | 质量门真实拦截；升级通知链路可达 |
| L2 | 跨文件特性（≤ 3 文件、≤ 2 域） | 域锁、并行派发、PR upsert |

**停止条件**（命中即停，回到上一级）：出现 `rollback-failed`；同一原因升级 ≥ 3 次；burning 速率明显超出预期（耗时行普遍贴着 `maxTaskHours`）。

## 1. 前置清单

- [ ] Linux VPS 一台，Node ≥ 22.19，插件跑在**普通用户**下（bootstrap 走 rootless 安装）。
- [ ] 平台能力先对齐预期：**PR 创建与 CI 状态查询只实现了 github**（其它平台 `pr_sync` 退化为纯推送、看板无 PR/CI 徽标）。
  - GitHub 私有仓：`platform: github` + `requireCiGreen: true`，全功能。
  - 私有 Gitea（+ act-runner）：`platform: generic`，`requireCiGreen` 必须**显式置 false**——插件查不到 Gitea 的 CI，留着它会让「从未验证视为未通过」永久阻塞 approve。act-runner 照常跑 CI，只是红绿不作为插件门；workflow 放 `.gitea/workflows/`（Gitea 只认这个路径）。SSH 非 22 端口时 `remote.url` 写全 `ssh://git@host:PORT/owner/repo.git`。
  - cnb/gitlab 同属 generic 语义。
- [ ] 禁区只剩默认 `LICENSE`（2026-08-29 变更）：`.github/` 与 `AGENTS.md` 技术上 AI 团队改得了，但**不要**把它们写进业务契约的 `touches`——改 CI（含 Gitea 的 workflow）等于改把关自己的考卷，改 `AGENTS.md` 属 docs-only 变更；两者都该单独成一次变更并留人复核。

**密钥与环境变量**——全部只配环境变量名，值绝不进任何 yml。注意区分两类 env：下面的表是 **dsh 进程本身**的环境变量（systemd `EnvironmentFile=` 或等效私有 env 文件注入）；`bootstrap.envFile` 是给**目标仓库应用**生成 .env，两回事。

| 变量 | 用途 | 必需性 |
| --- | --- | --- |
| `AUTOPILOT_GIT_KEY` | deploy key 私钥 / https token，对目标仓库可读写 | 必需 |
| `GITHUB_TOKEN` | `remote.apiTokenEnv`：PR 与 CI 状态查询 | github 平台必需 |
| `AUTOPILOT_WEBHOOK` | `escalation.webhookUrlEnv`：升级即时通知 | 强烈建议 |
| `AUTOPILOT_SMTP_USER` / `_PASS` / `_FROM` | 人工确认邮件（notification） | 开 notification 时必需 |

启动前自检（只列名字、不打印值）：

```bash
printenv | grep -E '^(AUTOPILOT_|GITHUB_TOKEN)' | cut -d= -f1
```

**手动预演**——插件按配置跑的每条命令，先在目标仓库根目录亲手跑一遍，把"配置说谎"挡在烧 agent 小时之前：

- [ ] 用 `AUTOPILOT_GIT_KEY` 能从 VPS 上 clone 目标仓库；
- [ ] `gates.commands` 每条单独跑全绿；
- [ ] `bootstrap.setupCommand` / `verifyCommand` 真实存在且能跑完（默认空串 = 跳过该步；配了就必须能跑通）。

## 2. 首跑配置模板

**首跑目标推荐 dogfood**：拿 dsh-ai-team 仓库自己当目标仓库——门脚本真实存在、无部署环节、你最清楚"正确答案"，升级分诊不抓瞎。存成 `pilot.patch.yml`：

```yaml
- insert:
    - id: autopilot
      name: dsh-ai-team
      config:
        rootDir: .dsh-ai-team
        baseBranch: main
        remote:
          url: git@github.com:yunqiangwu/dsh-ai-team.git   # 换成你的 fork
          sshKeyEnv: AUTOPILOT_GIT_KEY
          platform: github
          apiTokenEnv: GITHUB_TOKEN
        bootstrap:
          enabled: true
          toolchain: [git, bun, pnpm]
          # dogfood 顺手把引导链路也验了：目标仓库是本仓库的克隆，
          # 这两条命令真实存在（默认空串 = 只做工具链探测）。
          setupCommand: pnpm install
          verifyCommand: pnpm run typecheck
        gates:
          commands: [pnpm run typecheck, pnpm run lint, pnpm run test, pnpm run build]
          requireCiGreen: true
          timeoutMinutes: 30
        daemon:
          maxReviewRounds: 3
          stuckMinutes: 45
          pollIntervalSeconds: 30
          maxTaskHours: 2           # 墙钟预算：试点必开（成本护栏）
          maxDiffLines: 800         # 体量门：试点建议开（浅审是静默失败）
          maxDiffFiles: 30
        escalation:
          label: needs-human
          pauseOnEscalation: task
          webhookUrlEnv: AUTOPILOT_WEBHOOK
        deploy:
          enabled: false            # 首跑不部署；部署单独作为 L2 之后的验证项
        security:
          forbiddenPaths: ['LICENSE']
          commandAllowlist: [pnpm]  # gates 只跑 pnpm 脚本 → 白名单收到最小；勿放 sh/node/docker
          pushRequiresGates: true
        learnings:
          enabled: true
```

换真实项目时的增量改动：`setupCommand`/`verifyCommand` 换成该仓库真实存在的命令（默认空串 = 只做工具链探测）、`toolchain` 按需增删；`commandAllowlist` 按项目门命令收窄；`notification` 打开（邮件 + 工单；工单独立端口保持 `127.0.0.1`，配成非回环会**拒绝启动**）。远程只需**一条**隧道打通宿主 web 端口（`ssh -L 8080:127.0.0.1:<webPort>`）—— 面板内作答走同源路由，一起就通了；只有坚持点邮件里的链接，才需要再单独隧道化 `ticket.port`。部署放在 L2 通过后单独开。

## 3. 启动与首跑

```bash
# VPS 上，源码方式
git clone https://github.com/yunqiangwu/dsh-ai-team.git && cd dsh-ai-team
pnpm install && pnpm build
pnpm dsh web --patch ./pilot.patch.yml
```

（或按 README「安装」一节以 npm 包方式加载。）随后在对话里：

```
autopilot_init        # clone + verify；bootstrap 开启时含工具链安装
team_add_member …     # 补 developer ×2、reviewer ×1（试点最小阵容）
autopilot_run         # 幂等启动主循环
autopilot_status      # 随时查看循环 / 看板 / 升级 / 部署
```

**喂单节奏**：试点期每批 ≤ 3 个任务契约（`maxTasks: 512` 是上限不是目标）。跑完一批、复盘一次，再喂下一批。

## 4. 任务契约写法要点（试点期最容易错的地方）

- `touches` 精确到目录前缀——它同时是**域锁**和**知识注入**的依据，写太宽会把并行堵死。
- `forbidden` 与 `touches` 自洽（交集为空），否则派发期直接升级 `forbidden-paths`，白费一轮。
- 验收标准全部写成可客观验证的 Given/When/Then——reviewer 的门是证据链，不是感觉。
- 依赖用 `depends_on` 表达，不要靠"先跑的任务恰好先派"。
- L0 阶段建议加一条**探测任务**：故意让门红（比如要求一段必然类型错误的代码），验证升级通知真的到得了你的手机/邮箱，然后走完一次分诊放行。探测只做一次。

## 5. 运行中巡检（试点期每小时一次，不要真撒手）

| 看什么 | 在哪 | 异常信号 |
| --- | --- | --- |
| 循环活着吗 | `<rootDir>/heartbeat.json` 的 mtime | 距今 > 2×`pollIntervalSeconds` 没动 = 循环假死，查服务端日志 |
| 升级流 | webhook 推送 / 面板 / `state.json` 的 escalations | 同一原因第 2 次出现就该人工介入 |
| 预算与耗时 | 面板「运行指标」/ completion.md | `budget-exceeded` > 0；耗时行贴满 `maxTaskHours` |
| 重复踩坑 | `<rootDir>/learnings.md` | 高 hits 条目 = 系统性问题，优先人肉归因 |
| 状态真相源 | `<rootDir>/state.json`（`loopState` / tasks / members） | — |

磁盘布局（`stateDir` 默认即 `rootDir`）：`state.json`（真相源）、`heartbeat.json`、`completion.md`、`learnings.md`、`<teamId>/repo`（集成检出）与 `<teamId>/workspaces/<memberId>`（各成员 worktree）。后四者都是生成物，**不要手改 `state.json`**。

## 6. 升级分诊表

放行手段（四选一，等价）：面板内联表单直接答复（同源路由，无需凭据）/ 邮件里带 token 的工单页答复（`autoResume: true` 时自动回写放行）/ 对话调 `escalation_resolve` / 把任务单 status 改回 `pending`。升级记录里带 logTail，先看它再动手。

| 原因 | 多半意味着 | 处置 |
| --- | --- | --- |
| `task-stuck` / `budget-exceeded` | 空闲失控 / 活跃空转 | 看该成员 worktree 的 git log：有产出 → 任务太大，拆单；没产出 → 契约有歧义，改契约 |
| `change-too-large` | 单任务体量超 `maxDiff*` | 拆成多个契约再放行 |
| `blocked-dependency` | 前置契约 id 写错或前置已 needs-human，永远等不到 | 修契约的 `depends_on`（或先放行前置），下游同拍自动解禁 |
| `review-rounds-exceeded` | 返工 3 轮仍不过 | 通常契约或验收标准有问题，不是开发的问题 |
| `foreign-gate-failure` / `gate-failure` | 门红 | logTail 区分：缺环境 → 修 VPS；代码问题 → 让下一轮修 |
| `forbidden-paths` | 契约 `touches` 写宽了或真越界 | 修契约（禁区命中是硬规则，别试图放行改动本身） |
| `conflicting-requirements` / `cross-domain` / `paid-dependency` | 需要人拍板 | 做决定 → 改契约 → 放行 |
| `deploy-failed` | 部署或健康检查失败（已自动回滚） | 修根因后手动 `deploy_run`；`rollback-failed` 是救火，立刻上服务器 |
| `bootstrap-failed` | setup/verify 命令不存在或工具链缺 | 修 bootstrap 配置，重启服务端 |
| `manual` | 人为触发 | 看任务单留言 |

## 7. 崩溃与恢复

- 进程重启后：持久化为 `running` 的循环一律降为 `paused`，确认现场后 `autopilot_resume` 恢复。
- 崩溃时仍 `in_progress` 的任务**保持原状**（不抢回 pending，防止同分支二次派发），由同拍的卡死检测收敛——别手动改状态。
- `state.json` 解析失败会被改名留存为 `state.json.corrupt-<时间戳>` 再空启动：先救这份文件，别让新状态覆盖它。
- 禁止事项：不 force-push 共享分支、不 reset 集成检出、不手改 `_board.md`。

## 8. 复盘（每批任务结束后 24h 内）

1. 从 completion.md 抄下三个数：完成率、升级直方图、耗时行分布。
2. 「待升格」清单：把值得长期化的坑写进目标仓库文档（可以让 leader 自己落，但必须单独成 docs-only 变更，别混在代码任务里），然后 `learning_promote` 标记。
3. 判定：本级的完成率 ≥ 80% 且无同因反复升级 → 进下一级；否则改契约模板 / 收紧配置，重跑本级。
4. 校准预算：若耗时普遍远小于 `maxTaskHours`，下一步降它；若频繁贴线，先拆任务再考虑加时。

## 9. 已知坑速查

| 坑 | 后果 | 规避 |
| --- | --- | --- |
| `setupCommand` / `verifyCommand` 指向不存在的脚本 | `autopilot_init` 直接 escalate + throw | 启动前手动预演（§1） |
| 非 github 平台开着 `requireCiGreen` | 以为有 CI 门，其实没有 | 非 github 显式置 false，并知情 |
| 白名单含 `sh` / `node` / `docker` | 白名单形同虚设（`node -e` 即任意执行） | 收窄到门命令真正需要的首 token |
| 工单端点公网可达 | 任何人都能替你按「放行」 | 独立端口保持 `127.0.0.1`（配非回环**直接拒启**）+ SSH 隧道；宿主 web 端口要公网可达，先自架反代加鉴权 |
| 以为同源围栏能挡本机进程 | 本机任意程序都能带上那几个 header（`curl` 还自己设 `Host`） | 围栏挡的是端口扫描 / 跨站表单 / DNS rebinding，**不挡已被注入的 agent** —— 与命令白名单同一定位，见 README「工单鉴权」 |
| 反代把面板挂在子路径（`/dsh/`） | 作答请求打到根绝对路径 `/autopilot/ticket/…`，404 | 挂域名根；否则改用邮件链接（带 token）作答 |
| 设置卡片改配置 | 不生效 | 带 `--patch` 重启服务端 |
| 测完不 build 就启动 | 跑的是旧产物 | 源码方式启动前 `pnpm build` |
