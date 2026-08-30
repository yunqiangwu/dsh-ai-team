# 设计文档：需求采集 → 文档先行 → 并行开发 → 重规划

> 状态：**M0 / M1 / M2 / M3 已实施**（2026-08-30）。M0 = `.tasks/INT-1.md`、M1 = `INT-2.md`、M2 = `INT-3.md`、M3 = `INT-4.md` 已落代码，`stateVersion` 随之 5 → 7（M2 只加内部记录字段；M3 的 `cancelled` 是枚举取值、`priority` 不进视图，所以仍是 7）。
> 两处与 §3 / §9 的口径不同，已知且有意：
> ① **`_board.md` 没有「等人回答」列**（§3.1 场景一原本要求"看板与面板都显示"）。看板由 `team.ts` 从 `.tasks/*.md` 单向生成且要求字节稳定，把只活在 `state.json` 里的问卷状态混进去，等于给它第二个真相源；等待信息已由面板与 `autopilot_status` 的 `awaitingHuman` 覆盖。
> ② **问卷投递的 webhook 曾与 `EscalationManager.deliverWebhook` 是两份实现，已合并（[`TECH-1`](../.tasks/TECH-1.md)）**：升级侧改调 `notification.ts` 的 `postHumanWebhook`，合并的是传输层（fetch / 超时 / 头 / URL 脱敏登记）；载荷语义保持各自不变——问卷侧仍推带 token 的链接，升级侧仍 POST `{ text, escalation }`。
> 配置字段语义仍以 [../README.md](../README.md) 为准，试点操作仍以 [../PILOT.md](../PILOT.md) 为准。引用代码一律写符号名（函数 / 类 / 常量），不引裸行号。

## 0. 目标与范围

把当前的交互模型从**「人喂任务契约 → 机器跑闭环」**升级为**「人给模糊需求 → 组长追问 → 文档先行 → 拆任务 → 并行开发 → 需求变更可重规划」**。

范围：采集问卷、文档审批、阶段门、重规划四类机制，以及支撑它们的状态与工具面。
不在范围：多团队、跨仓库、模型选型、Web 面板视觉重做。

验收口径：§9 里程碑表全部落地，且 §10 试点的 `diff 为空` 断言通过。

### 术语对齐

现状里 **escalation（升级）和 ticket（工单）是两个东西**，本文新增第三个实体，三者不许混：

| 术语 | 语义 | 现状 |
| --- | --- | --- |
| **escalation** | AI 卡住了，叫人来分诊 | `src/escalate.ts` |
| **ticket** | escalation 在 Web/邮件上的**投递渠道**之一 | `src/notification.ts` |
| **questionnaire** | AI 需要人提供一个**决策**才能继续，此时没有任何东西坏掉 | `src/questionnaire.ts`（M1） |

## 1. 两条决定设计的硬约束

### 1.1 插件从不唤醒 agent

全仓库无 `subagent` / `spawnSession` / `createAgent` 任何调用；`team_add_member` 的工具说明原文是 *"systemPrompt — use it when spawning the member's agent"* —— **起 agent 是调用方的责任**。插件自身只做四件事：状态机、机械活（git / gates / deploy / 通知）、工具注册、投影快照。宿主 `@deepseek-ai/dsh-session` 的 `Session` 类只有 `deriveMessages` 这类只读方法，**没有"向会话投一条消息让它继续"的写入口**。

推论：**认知步骤必须由人或宿主开场**。因此一切"等用户回答"的等待点都必须跨越 agent 轮次边界，两种形态见 §3.2。

### 1.2 M1 之前：组长既不能创建契约，也被明令禁止写文档

- 契约只能由人写好、再被 `syncContracts` 收养，且收养链上一个写坏的 frontmatter 会把整块看板静默清空（后者已由 M0 修复：逐文件解析、只上报一次 `contract-rejected`）。
- 组长提示词曾明令 *"Never edit AGENTS.md / docs/ yourself"*——禁令已随 2026-08-29 默认禁区收缩到 `LICENSE` 一并移除，出口改由 §4.1 的 draft/审批链承担。推论保留至今：**不能只给一个裸的写文档能力**，约束下移到"必须走有审批记录的合法出口"。

## 2. 阶段状态机

`loopState`（`stopped/running/paused/escalated/completed`）语义不动。新增正交维度 `phase`，挂在 **team** 上：

```
intake → kickoff_pending_approval → scaffolding → developing ⇄ replanning
                                                              ↘ kickoff_pending_approval（重规划改动了已批文档时回到这里）
```

| phase | 谁在做 | 产物 | 出口门 | 性质 |
| --- | --- | --- | --- | --- |
| `intake` | leader | `docs/drafts/prd.md` 骨架 + 答案 | 所有 `required` 问题有答案 | 客观 |
| `kickoff_pending_approval` | 人 | 开工包（§4.3） | **人批** + `gates_run` 全绿 | 主观 + 客观 |
| `scaffolding` | leader + dev | 最小可跑框架 | 空框架起得来、门命令本身可跑通 | 客观 |
| `developing` | 现有主循环 | 代码 | 现有全套门 | 客观 |
| `replanning` | leader | 契约增删改 + 变更说明 | 依赖图自洽（§6.4） | 客观 |

**`dispatch` 在 `phase !== 'developing'` 且 `phase !== 'replanning'` 时必须直接返回。**
这道门是 M0 补上的——之前见着 `pending` 就派，"PRD 还没等人确认，任务已经发出去了"。

### 2.1 phase 的进入与退出

- 只能由**工具**变更，且每个变更点都发 `autopilot/update` 快照：
  - `answer_questionnaire`（服务端回写也算）→ `intake → kickoff_pending_approval`
  - `doc_approve` → `kickoff_pending_approval → scaffolding`
  - `autopilot_run` → `scaffolding → developing`
  - `replan_open` / `replan_close` → `developing ⇄ replanning`
- 崩溃恢复：`phase` 持久化，不降级（它是事实而非意图），但 `loopState: running → paused` 的既有规则不变。

## 3. 问卷（questionnaire）

### 3.1 与 escalation 解耦

M1 之前两者绑死：工单渲染未命中 escalation 就返回 `null`、工单 URL 只在升级通知钩子里铸造、字段被硬编码成 `decision`+`note`。M1 引入独立实体 `src/questionnaire.ts`（与 `escalate.ts` 平级、**绝不合并**）：题目校验 / 答案归一 / 状态推进，实体形状（`Questionnaire` / `Question`，含 `kind`、`binding`、四态 status、`defaultValue`）以源码为准。

`escalation` 保持不变，仍走工单渠道；工单服务从"escalation 的附件"降级为"escalation 与 questionnaire **共用**的 HTTP 投递层"（M2 起一份 `ticket-handler.ts` 两个挂载点）。

### 3.2 两种交付模式

`interactive`：`ask_human` 工具内部 `await`，agent 轮次保持打开，天然被唤醒，但占住一个活轮次（`daemon.stuckMinutes` 会把它误判成任务卡死 → 必须豁免，见 §6.5）。`async`：落 open 问卷 + 邮件/webhook 后立即返回，等待期无 token 消耗，但闭环里多一次人工动作——**人仍然是那个按按钮的**，要回一句「继续」，这是 §1.1 的直接后果，不是可以靠工程绕过的实现细节。行为口径见 README「人工确认与问卷工单」。

### 3.3 字段类型

`TicketField` 原本只有 `text` / `textarea` / `password` / `select`，M1 补了 `multiselect`（多选 + 预填 recommended 项），填空用现有 `text`/`textarea` 已够。**不预先做条件分段**——问卷一 branching，回写映射和前端渲染成本立刻翻倍，而试点期的问题集完全可以是静态的。

### 3.4 答案必须结构化回写（不是只存进问卷）

每条答案按 `binding` 写进文档对应章节，并追加一行带时间戳的决策记录：

```markdown
> [decision] 2026-08-29T10:00Z Q3 部署形态 = 单机 Docker（用户选定，默认方案是 K8s）
```

理由：只把答案留在 `state.json` 里等于没有——它是运行态、不入库，而"为什么这么定"必须跟着代码一起进 git。

## 4. 文档先行

### 4.1 draft → accepted 升格

AI **只**能写 draft，且 draft 区按路径判定而非按文件属性判定：

```
docs/drafts/**                     组长写、组长改
```

人批准后 `doc_approve` 把文件从 draft 区**移入**正式区（`docs/prd.md` 等）并记录审批人 + 时间。升格之后：

- 已升格的正式文档（`docs/prd.md` 等）对**所有角色**只读：要改必须新起一份 draft + 重新走 `doc_approve`。**AI 写的正式文档永远是"待批草稿"，不是既定事实**。
- 默认禁区与「别改自己的考卷」的口径以 README「安全模型」为准；`AGENTS.md` / `.github/` 与教训落文档都要**单独成一次 docs-only 或 CI-only 变更**（理由见 AGENTS.md「文档规范」），留给人复核。
- 完成报告与 `learning_list` 的"待升格"清单继续只列候选，但落文档不再是人的专属动作。

### 4.2 每个文档的 frontmatter

```yaml
---
path: docs/prd.md
status: draft | pending-approval | accepted | superseded
version: 1.0
sha256: <落盘时的正文哈希>
approvedBy: null
approvedAt: null
---
```

**`sha256` 是防"批 A 合 B"的硬门**：`doc_approve` 记录审批那一刻的内容哈希；升格进正式区前必须重新比对，不一致即拒绝审批并升级为 questionnaire 重开。人眼看 diff 挡不住这个——一次审批只覆盖人当时看到的那一份内容。

### 4.3 开工包：三份文档一次审批

`kickoff_pending_approval` 提交的是**一个 bundle**，不是一个一个批：

| 文档 | 内容 | 为什么同批 |
| --- | --- | --- |
| `prd.md` | 概述 / 功能 / 非功能 / 里程碑 / 验收标准 | — |
| `tech-stack.md` | 选型 + 决策理由 | 非功能需求直接决定选型，分开批必然出现"批完 PRD 再改技术栈 → PRD 回退"的重做 |
| `dev-guidelines.md` | 目录 / 命名 / API / DB / 测试范式 | 同上 |
| `docs/adr/0001-*.md` | 第一条架构决策 | 决策留痕从第 0 天开始 |
| 骨架清单 | scaffold phase 将要产出的文件列表 | 让人在写码前就有拦截点 |

往返从 3 次降到 1 次，这是试点期最值的成本削减。

### 4.4 契约创建工具（补上后门）

`contract_create` 写 `.tasks/<id>.md` 时，**写前**校验，不合法直接抛错而不是留给收养链路炸：

- frontmatter 必填 `id` / `title` / `status` / `owner` / `depends_on` / `touches`，`forbidden` 选填；
- `depends_on` 不得悬空（引用的 id 必须存在或同一批次内创建）；
- `touches ∩ forbidden = ∅`（复用 `forbiddenTouchesViolation`）；
- 依赖图无环；
- `id` 遵循 `<域>-<序号>`。

既有隐患（M0 已修）：契约解析失败从"清空整块看板"改为逐文件报告并跳过（§1.2）。

## 5. TDD 与并行度

**任务级单测必须和实现同任务、同分支。** 若拆成"先写测试任务、再写实现任务"，两个任务的 `touches` 指向同一目录，域锁 `touchesOverlap` 会让它们**永远无法并行**——TDD 反而把并行度打死，这是自伤而非严谨。

**跨任务的红线验收测试属于 scaffold 产物**：组长在 `scaffolding` 阶段建好 e2e 空壳与 `pnpm test:e2e` 命令，此时它是红的，由后续任务逐个转绿。

每个开发任务的 DoD 因此固定为四件，顺序不可调：契约里的 Gherkin → 同分支单测（先红后绿）→ `gates_run` 全绿 → 验收证据写进 PR 描述。

## 6. 需求变更与重规划

### 6.1 用 `cancelled`，不是删除

`TASK_STATUSES` 新增 `'cancelled'`；**契约文件保留不删**，保持可追溯。这是目标仓库 `.tasks/README.md` §3 已经确立的约定，本插件应当对齐而不是另立一套。连带：`_board.md` 加列，现状只列 `needs-human`。

### 6.2 变更分级

| 变更 | 处置 | 是否惊动人 |
| --- | --- | --- |
| 新增 pending 任务、调 `priority`、取消**未派发**的 pending | 组长自主（`replan_*` 工具） | 否 |
| 触及已合并代码、改 PRD 验收数值、动禁区 | **必须** questionnaire(`kind:'replan'`) | 是 |

不给这张表的话，两个失败方向都会出现：要么每个小改动都发邮件（用户很快开始忽略），要么组长偷偷重写验收标准（用户失去控制权，且没有客观门能发现）。

**派发顺序与域锁的交互**（TECH-2 已决口径）：候选按 `priority` 降序稳定排序，但排序只决定「先看谁」，不决定「谁必须先走」——依赖未满足的候选永远排在后面；`touches` 被在途任务锁定的候选推迟到锁释放（保持 `pending`、记 `deferred-domain-lock:<taskId>` 事件），派发继续走锁外的下一候选。一句话：**域锁推迟但不空转**——高优先级不会为了等锁让空闲开发者干等，而它为什么还没被派发，事件流里看得见。

### 6.3 在途任务被变更波及

`in_progress` / `in_review` 的任务被需求变更命中时，三种处置，**默认第三种**：

1. `supersede` —— 照原样合入，紧跟一个修正任务。**分支保留**，不丢已有工作。
2. `continue + followup` —— 当前继续，另开新契约承接增量。
3. `abort` —— 丢分支 = 丢工作，必须人批准（`kind:'replan'` 问卷）。

好消息是机制不用新造：`releaseMemberWorkspace` 已是通用 helper，被澄清、合入、升级三处复用，`supersede` / `abort` 直接加第四个调用点即可。缺的只是**入口**——今天没有任何工具能让组长"撤回一个 in_progress 任务但不判它失败"。

### 6.4 依赖连带（M0 已补的洞）

M0 之前 `dispatch` 对依赖不满足一律静默 `continue`：一旦某任务的前置是 `cancelled`，或永久卡在 `needs-human`，下游会**无限静默不派发**——不报错、不升级、也永远凑不出"全部 done"的完成报告，循环在空转降频里一直转。

修法（已落地）：依赖判定引入**不可满足**概念，命中即升级 `blocked-dependency`——前置**不存在或已 needs-human** 才判死，"还没做完"是正常等待；同一拍内级联。M3 的 `cancelled` 建立在该机制之上。

### 6.5 其余不变量

- **PRD 版本化**：`version` 递增 + §4.2 的变更日志段；任务单引用 `PRD §2.3@v1.7`，让"需求变了"成为可 diff 的事实而不是口头共识。
- **replan 频率上限**：单位时间内 `replan_*` 调用超限即拒绝。模型陷入"无限重排"是真实失败模式，而它自己不会察觉。
- **`maxTaskHours` 不因重规划重置**：墙钟预算是唯一可靠的烧钱护栏，重置等于给了无限续命的口子。
- **`interactive` 问卷豁免 `stuckMinutes`**：否则组长一次合法的"等人回答 45 分钟"会被误判成任务卡死并升级。`ask_human` 挂起期间应刷新 `lastActivityAt` 或以 `awaiting-human` 标记豁免判定。

## 7. 客户端交互通道

M2 之前 `SlotProps` 只有 `{ sessionId?, useProjection, t }`，**面板发不出任何东西**。三个候选（注意最终方案**没有**靠给宿主契约加 prop，面板用 `fetch` 打同源相对路径）：

| 方案 | 评估 |
| --- | --- |
| **同源挂在宿主 `webServer` 上，面板 `fetch` 相对路径**（M2 选它） | 一份 `TicketHandler` 两个挂载点：独立端口只服务邮件链接，宿主路由服务面板。改动全在自己手里，服务端已有的表单渲染与回写闭环复用一份 |
| `ctx.approval`（`@deepseek-ai/dsh-user-approval`） | 只能表达 `allowed-once/rejected/cancelled`，**不携带工具参数**，且要求"属于一个尚未结束的 agent 轮次"。可用于 `doc_approve` 的 yes/no，装不下问卷 |
| 借 `settingsScope` 写入再由服务端监听 | 语义误用，否决 |

### 7.1 选定方案要补的三件事（M2 已落地）

1. ~~**CORS + 混合内容**~~ —— 前提本身不成立，同源挂载把两件事都消掉了：dsh 面板本身是明文 `node:http`（宿主不提供 TLS / 认证 / 来源策略），面板 `fetch('/autopilot/ticket/<id>/answer')` 走同源相对路径，不需要 CORS、不发预检，也不需要把实际监听端口纳入投影。⚠️ 残留边界：反代把面板挂在**子路径**下（`/dsh/`）会指错根绝对路径，已写进 README 限制。
2. **URL 带 token**：工单/问卷端点从"完全无鉴权"变成"只有拿到链接的人能按"。凭据只进邮件与 webhook 文案，**不进任何视图**——它存在 `state.json` 的旁路表 `ticketTokens`（内部记录字段，所以 `stateVersion` 不动）。面板因此走同源信任围栏，见 §8-9。
3. **修一个既有 bug**（M0 已修）：提交答卷只调 `this.changed()`、不发 `autopilot/update`，面板要等下一次工具调用才刷新——问卷闭环对刷新时机敏感。

## 8. 安全边界（不可协商项）

沿用 README「安全模型」6 条，本文新增 4 条：

7. **AI 写文档只进 draft 区**，升格必须有 `doc_approve` 记录（审批人 + `sha256`）。
8. **问卷不改变命令白名单、不改变禁区**。用户"同意"不能解锁 `LICENSE`——禁区是配置决定的边界，不是一个可以被批准跨越的门（`AGENTS.md` / `.github/` 已于 2026-08-29 移出默认禁区，见 §4.1）。
9. **工单端点两道凭据，都不挡本机进程**。独立端口只绑 `127.0.0.1` 且读写**强制** `?t=<token>`；宿主同源路由接受"信任围栏 **或** token"，围栏三段判据整抄宿主 `isTrustedApiRequest`（判据细节见 README「工单鉴权」）。诚实边界与 `AGENTS.md` 安全硬规则 2 同一定位：**这道门挡的是端口扫描、跨站表单和 DNS rebinding，挡不住已被注入的 agent**——本机任意进程都带得动 header，`curl` 还会自己设 `Host`。远程访问仍必须走 SSH 隧道；`autoResume` 默认 `false`。
10. **任何审批类状态转换不得由模型自己调用工具伪造**。`doc_approve` 只接受两条来源：本地端点 POST 或人直接在会话里调；组长与开发只能 `ask_human`。

## 9. 改动清单与里程碑

按依赖顺序排。每格给出"改哪"和"什么测试覆盖它"。

| 里程碑 | 内容 | 主要文件 | 覆盖测试 |
| --- | --- | --- | --- |
| **M0 先修（不做则一切白搭）** | phase 字段 + `dispatch` 门；补 §6.4 不可满足依赖 → `blocked-dependency`；修 §7.1-3 事件不发布；契约解析失败不再清空看板 | `vocab.ts` `schema.ts` `service.ts` `projection.ts` | `test-unattended.ts` 加分支 |
| **M1 能问、能写** | `src/questionnaire.ts` + 工单服务从 escalation 解耦；新工具 `ask_human` / `answer_questionnaire` / `doc_write` / `doc_approve` / `contract_create`；`TicketField` 补 `multiselect`；`roles.ts` 组长提示词重写（draft/升格，**不是**简单删除禁令） | `escalate.ts` 同级新文件、`notification.ts` `tools.ts` `team.ts` `roles.ts` | 新增 `test-questionnaire.ts` |
| **M2 卡片（已实施）** | §7.1 三件事；请求处理从"服务器"里抽成可挂载的纯 handler，一份两个挂载点；token 走 `state.json` 旁路表；面板渲染问卷/升级内联表单与「等你决策」区块（`projection.blocked` 早已渲染，这里只补视觉可区分） | `ticket-handler.ts` `formmodel.ts` `notification.ts` `vocab.ts` `index.ts` `client/AutopilotPanel.tsx` `client/styles.ts` | 新增 `test-ticket-http.ts`（含 rebinding、404 逐字节相同、413）；`smoke-cordis.ts` 断言 client 产物无 zod / 无 `node:` **且** `/autopilot/ticket` 真在产物里（架构铁律 5） |
| **M3 重规划（已实施）** | `cancelled` + `priority` + `replan_*` 工具 + §6.2 分级表 + §6.3 三种处置 + 频率上限；`_board.md` 加列 | `vocab.ts` `team.ts` `service.ts` `tools.ts` | `test-unattended.ts` 重规划分支 |

四个里程碑已落成任务契约：M0 = `.tasks/INT-1.md`、M1 = `INT-2.md`、M2 = `INT-3.md`、M3 = `INT-4.md`，依赖链 `INT-1 → INT-2 → INT-3`，且 `INT-4` 只依赖 `INT-1`。所以 M3 在依赖图上与 M2 可并行——但两者 `touches` 都含 `src/`，域锁实际仍会把它俩串行化（§10.1）。

连带改动（Config 字段、`EscalationReason`、投影形状）一律按 AGENTS.md「改一处要连带改哪儿」表执行；新增升级原因的前提是**服务端真会产出它**，否则只是给模型多一个错选项。

## 10. 试点验收

最便宜也最严的 L0 不是新建项目，而是挑一个**已按本流程产出过成熟文档集**的 agentdeploy 仓库（PRD / tech-stack / dev-guidelines / ADR / 任务契约齐备），做：

> **回归式 L0**：让插件对着它已有的成熟文档跑一遍 `intake → kickoff_pending_approval`，断言**产出的 draft 与现状 diff 为空**。

这一发同时验证：问卷闭环可用、draft/升格机制不越权、`validate:docs` 能当客观门用、以及最关键的一条——**AI 会不会破坏既有约定**。

配置注意：该仓库用 `profile.preset: agentdeploy`（本插件已内置），`platform: generic` 时 **`requireCiGreen` 必须显式置 false**，否则"从未验证视为未通过"会永久阻塞 approve（见 PILOT.md §1）。

### 10.1 域阈值与本仓库布局冲突（自举时会撞上）

`distinctDomains` 按前缀折叠计域，两条路径仅当互为前缀时算同一域。这对 ai-yunke 那种多顶层域布局（`server/db/`、`app/`、`packages/cli/`）是对的，但本仓库 `src/` 是**扁平**的：把 `touches` 写成逐个源文件时，任何 4 文件的改动都算 4 个域，而 `crossDomainThreshold` 默认 3 —— 于是 `escalateCrossDomain` 会在**首拍**就把它自动升级成 `cross-domain`，根本走不到派发。

两条出路：

- 本仓库跑 M0–M3 时把 `profile.crossDomainThreshold` 调到 6~8，契约按文件粒度写（并行度好，但 `src/` 下四个文件以上即触阈）；
- 或维持默认阈值，契约一律用目录粒度 `touches: [src/]`（本文的 `.tasks/INT-*.md` 取这条）。

代价要说清：目录粒度下 `src/` 是一个域，域锁 `touchesOverlap` 会让**所有 M0–M3 契约互斥**，一次只有一张能在飞——这把本插件最强的并行派发能力关掉了。里程碑契约本来就是串行依赖链，可以接受；但真要并行开发，就必须走文件粒度 + 调高阈值。

> 顺带：这条跨域判据曾在 contract_create / assignTask / escalateCrossDomain 三处各写一份，已收敛到 `domainLimitStatus`（src/profile.ts）单处 —— 出口策略（抛错或升级）仍归调用方。

## 11. 未决问题

1. `async` 模式下"人回一句继续"能否被宿主接管？需要 `dsh-agent` / workflow 层的写入口，本插件不依赖它们，且引入会破坏架构铁律 1（核心与 cordis 解耦）。建议宿主提供，插件不越界。
2. ~~`sha256` 审批链在用户直接手改文档时如何失效并重批~~ 已决并落代码（[`TECH-3`](../.tasks/TECH-3.md)）：升格窗口内的手改走「比对失败 → 作废码 → 重开问卷」（既有）；`accepted` 之后的正式区手改由守护循环每拍扫描（`findAcceptedDrift`），命中即整体退回 draft 区（`pending-approval` + 新哈希 + version 递增）、正式区删除、同一次提交，并重开 approval 问卷原地重批——正式区只放人批过的字节，批过的字节变了就回 draft 重批。不防对抗性伪造（正文连 frontmatter 哈希一起改），与工单 token 同一威胁模型。
3. ~~优先级与域锁冲突时的调度策略~~ 已决并落代码（[`TECH-2`](../.tasks/TECH-2.md)）：**域锁推迟但不空转、跳过可见**——被锁候选保持 `pending` 并记 `deferred-domain-lock:<taskId>` 事件，派发继续走锁外的下一候选（吞吐优先，不引入严格优先级模式），口径见 §6.2 末段。
4. 多团队并行时 phase 是否提升为 team 级——本文已按 team 级设计，但要确认与 `activeTeamId` 的渲染假设一致。
