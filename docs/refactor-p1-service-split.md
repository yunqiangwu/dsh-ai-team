# service.ts / tools.ts 拆分进展纪要（P1）

> 状态：生效中（2026-08，P1 全部分拆已实施并推送，`main` 可追溯）
> 分工：本文只记「分拆动作 + 可容器化 vs 应留驻的判断」，别处事实不在此抄一遍——配置语义以 [README](../README.md) 为准；架构铁律与连带改动表以 [AGENTS.md](../AGENTS.md) 为准；人工通知 / 文档审批的交互规格见 [design-interaction.md](./design-interaction.md)。

## 动机

一次架构评审把「service.ts 是上帝类、tools.ts 混了工具定义与快照发布两条入口」列为亟待处理项（原 P1）。落地拆分的判断准则是「判断力优先 + 简单优先」：**只把自包含的状态域下沉为容器 / 纯函数**，不为了把某个方法体搬出 service 而制造构造依赖爆炸。

## 已实施的分拆（按序）

| 产出（符号名） | 职责 | commit |
| --- | --- | --- |
| `publish` 双入口收敛（`src/tools.ts` 内的 `publish` / `setSnapshotPublisher`） | session 绑定收敛为 `lastSessions` WeakMap 单一来源，带外路径（工单答卷的 HTTP 回调）复用与工具路径同一个 `publish()` | `8f33d43` |
| `DeployCoordinator` + `isTasksOnlyChange`（`src/service/deploys.ts`） | 部署状态跑账 / 上次基线 SHA / 执行入账；纯 `.tasks/` 变更判定 | `5cbc701` |
| `TicketVault`（`src/service/ticket-vault.ts`） | 工单凭据簿：安全硬规则「token 只活在旁路表、绝不进视图」的显式载体 | `eab89a0` |
| `TeamStore`（`src/service/team-store.ts`） | 团队集合运行容器（继承 `Map`，额外承载 `activeTeamId` 与序列化 / 恢复） | `78ad4b6` |
| `team-rules`（`src/service/team-rules.ts`，纯函数） | `createTeam` / `addMember` / `assignTask` 的业务不变量（恰一个 leader、容量门、已有 leader、reviewer/operator 不可写码） | `12126fd` |

每一步都在「typecheck && lint && build && test」全绿的前提下完成；测试从 251 增至 255（新增规则用例）。既有行为由 `test-ticket-http` / `test-notification`（凭据不漏视图的守门） / `smoke-cordis`（工具清单整条锁死）等守住。

## 可容器化 vs 应留驻的判断

**判断准则**：一个域是否值得下沉，看它是否**自包含**——只依赖自身状态与少量纯函数 / 通用设施（git CLI、脱敏器、`AutopilotOptions`）。此类下沉后依赖是单向的（`service → 容器`）。

- **可容器化（自包含状态域）**：部署（`DeployCoordinator`）、工单凭据（`TicketVault`）、团队集合（`TeamStore`）。状态与执行相互闭合，下沉后 service 只薄调用。

- **应留驻 service（高耦合编排）**：`notifyEscalation` / `notifyQuestionnaire` / `submitTicketAnswer` / `applyHumanDecision`（依赖 options、mailer、server、questionnaires、escalations）；团队命令方法体 `createTeam` / `addMember` / `assignTask`（依赖 git 克隆 / worktree、契约装载、看板落盘、`changed` 钩子）。这些不是"某个域"，而是"跨若干子系统的编排"；搬进独立类要注入五六个 provider 回调，依赖不降反升。因此只把其中**可单测的业务不变量**下沉为纯函数（`team-rules.ts` 与 `daemon.ts`、`contracts.ts` 同模式），编排保留在 service。

**结论**：没有一行是为了"拆完一个方法体"而拆的。上帝类的可持续解法是「状态容器化 + 纯规则下沉 + 编排留驻」三步组合，而不是把方法搬光。

## 后续

- 真正的「编辑门面」/「团队命令语义外迁」仍是长期项：该把 `createTeam` / `assignTask` 等收进独立门面时，需要明确的领域边界与真实需求驱动，否则不属于合理范围。
- 任何后续拆分都以「行为不变 + 四件套全绿」为退出标准，逐阶段独立回归，不做大爆炸式一次性拆分。