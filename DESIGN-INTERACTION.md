# 设计文档：需求采集 → 文档先行 → 并行开发 → 重规划

> 状态：**提案（未实施）**。本文是"文档先行"交互流程的规格真相源；配置字段语义仍以 [README.md](README.md) 为准，试点操作仍以 [PILOT.md](PILOT.md) 为准。
> 行号引用基于 `1.0.3`，实施时会漂移，只作为定位辅助。

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
| **questionnaire** | AI 需要人提供一个**决策**才能继续，此时没有任何东西坏掉 | 本文新增 |

## 1. 两条决定设计的硬约束

### 1.1 插件从不唤醒 agent

全仓库无 `subagent` / `spawnSession` / `createAgent` 任何调用；`src/tools.ts:89` 对 `team_add_member` 的说明原文是 *"systemPrompt — use it when spawning the member's agent"* —— **起 agent 是调用方的责任**。插件自身只做四件事：状态机、机械活（git / gates / deploy / 通知）、工具注册、投影快照。宿主 `@deepseek-ai/dsh-session` 的 `Session` 类只有 `deriveMessages` 这类只读方法，**没有"向会话投一条消息让它继续"的写入口**。

推论：**认知步骤必须由人或宿主开场**。因此一切"等用户回答"的等待点都必须跨越 agent 轮次边界，两种形态见 §3.2。

### 1.2 组长今天既不能创建契约，也被明令禁止写文档

- `assignTask`（`src/service.ts:956-964`）只**校验**契约存在且为 `pending`；全文没有创建 `.tasks/*.md` 的代码路径。契约只能由人写好，或组长用通用 fs/shell 手搓、再由 `syncContracts`（`src/service.ts:1912`）事后收养。
- 收养链路上已经咬过一次人：`src/service.ts:1898` 是 `.catch(() => [])`，**一个 frontmatter 写坏的契约文件会让整块看板静默清空**（`src/service.ts:1062` 的注释自己承认了这一点）。
- `src/roles.ts:44-45` 组长提示词原文（历史记录）：*"Never edit AGENTS.md / docs/ yourself: those are human-only, and doc rewrites have no objective gate to verify against."* —— 这条禁令已在 2026-08-29 随默认禁区收缩到 `LICENSE` 一并移除，出口改由 §4.1 的 draft/审批链承担。

推论：本文最核心的三个动作（追问、写文档、拆契约）在工具面上**一个都不存在**，其中一个还被架构铁律 6 主动禁止。解决方案见 §4 的 draft/升格机制——禁令本身已在 2026-08-29 移除，但**不能只给一个裸的写文档能力**，约束下移到"必须走有审批记录的合法出口"。

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
这一条不可省略：现状 `src/service.ts:1979` 见着 `pending` 就派，于是"PRD 还没等人确认，任务已经发出去了"。

### 2.1 phase 的进入与退出

- 只能由**工具**变更，且每个变更点都发 `autopilot/update` 快照：
  - `questionnaire_answer`（服务端回写也算）→ `intake → kickoff_pending_approval`
  - `doc_approve` → `kickoff_pending_approval → scaffolding`
  - `autopilot_run` → `scaffolding → developing`
  - `replan_open` / `replan_close` → `developing ⇄ replanning`
- 崩溃恢复：`phase` 持久化，不降级（它是事实而非意图），但 `loopState: running → paused` 的既有规则不变。

## 3. 问卷（questionnaire）

### 3.1 与 escalation 解耦

现状三处绑死，必须先拆开：`renderTicket` 未命中 escalation 就返回 `null`（`src/service.ts:235-236`）、工单 URL 只在 `EscalationManager.escalate` 的通知钩子里铸造、字段被硬编码成 `decision`(textarea) + `note`(text)（`src/service.ts:237-250`）。

新增独立实体，落在新文件 `src/questionnaire.ts`（与 `escalate.ts` 平级）：

```ts
interface Questionnaire {
  id: string;                       // qn_<ts>_<seq>
  teamId: string;
  kind: 'intake' | 'approval' | 'replan';
  title: string;                    // 面向人，一句话
  questions: Question[];
  answers: Record<string, Answer>;  // 按 question.name 索引
  status: 'open' | 'answered' | 'expired' | 'cancelled';
  binding:                          // 答案落地的位置，见 §3.4
    | { type: 'doc'; path: string; section: string }
    | { type: 'task'; contractId: string };
  createdAt: number;
  answeredAt: number | null;
  expiresAt: number | null;         // 仅 interactive 模式有意义
}

interface Question {
  name: string;                     // 稳定 key，答案与回写都靠它
  label: string;
  type: 'select' | 'multiselect' | 'text' | 'textarea';
  options?: { value: string; label: string; impact?: string; recommended?: boolean }[];
  required: boolean;
  defaultValue?: string;            // 组长必须给出"不回答时按什么办"
}
```

`escalation` 保持不变，仍然走工单渠道；工单服务从"escalation 的附件"降级为"escalation 与 questionnaire **共用**的 HTTP 投递层"。

### 3.2 两种交付模式

| | `interactive`（试点期唯一可用） | `async` |
| --- | --- | --- |
| 机制 | `ask_human` 工具内部 `await`，agent 轮次保持打开 | 落 open 问卷 + 邮件/webhook，agent 轮次结束 |
| 唤醒 | 天然被唤醒（还卡在那轮里） | **由人回一句「继续」**（§1.1 决定了插件做不到自动唤醒） |
| 风险 | 占住一个活轮次；`daemon.stuckMinutes` 会把它误判成任务卡死 → 必须豁免（§6.5） | 等待期无 token 消耗，但闭环里多一次人工动作 |

诚实交代：`async` 模式下**人仍然是那个按按钮的**。这是 §1.1 的直接后果，不是可以靠工程绕过的实现细节。

### 3.3 字段类型缺口

`TicketField.type` 现状只有 `'text' | 'textarea' | 'password' | 'select'`（`src/notification.ts:289-296`），无 radio、无 checkbox、无多选、无预填、无分组。

"选择题"要扩 `'multiselect'`（多选 + 预填 recommended 项），"填空题"用现有 `text`/`textarea` 已够。**不预先做条件分段**——问卷一 branching，回写映射和前端渲染成本立刻翻倍，而试点期的问题集完全可以是静态的。

### 3.4 答案必须结构化回写（不是只存进问卷）

每条答案按 `binding` 写进文档对应章节，并追加一行带时间戳的决策记录：

```markdown
> [decision] 2026-08-29T10:00Z Q3 部署形态 = 单机 Docker（用户选定，默认方案是 K8s）
```

理由：用户答完不必再读一遍文档，但文档里要留下**可 diff 的决策依据**。只把答案留在 `state.json` 里，等于没有——`state.json` 是运行态、不入库，而"为什么这么定"必须跟着代码一起进 git。

## 4. 文档先行

### 4.1 draft → accepted 升格

AI **只**能写 draft，且 draft 区按路径判定而非按文件属性判定：

```
docs/drafts/**                     组长写、组长改
```

人批准后 `doc_approve` 把文件从 draft 区**移入**正式区（`docs/prd.md` 等）并记录审批人 + 时间。升格之后：

- 默认 `security.forbiddenPaths` 现在只有 `LICENSE`（2026-08-29 变更）：`AGENTS.md` 与 `.github/` 不再是禁区，AI 团队可以改、可以提交。
- 已升格的正式文档（`docs/prd.md` 等）对**所有角色**只读，这条不变：要改必须新起一份 draft + 重新走 `doc_approve`。这与 §1.2 的原意一致：**AI 写的正式文档永远是"待批草稿"，不是既定事实**。
- 改 `AGENTS.md` / `.github/` 必须单独成一次变更（docs-only 或 CI-only），不混进代码任务的 diff：前者没有客观门可验证，后者会同时改动把关自己的 CI 脚本，`requireCiGreen` 的把关者不该自己改考卷——这两类改动留给人复核。
- 完成报告与 `learning_list` 的"待升格"清单继续只列候选（`src/service/report.ts:8` 的精神保留），但落文档不再是人的专属动作。

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
- `touches ∩ forbidden = ∅`（复用 `forbiddenTouchesViolation`，`src/service.ts:978`）；
- 依赖图无环；
- `id` 遵循 `<域>-<序号>`。

顺带修一个既有隐患：`loadTaskContracts` 在 tick 里 `.catch(() => [])`（§1.2）——解析失败应当**报告并跳过该文件**，而不是清空整块看板。

## 5. TDD 与并行度

**任务级单测必须和实现同任务、同分支。** 若拆成"先写测试任务、再写实现任务"，两个任务的 `touches` 指向同一目录，域锁 `touchesOverlap`（`src/team.ts:161-170`）会让它们**永远无法并行**——TDD 反而把并行度打死，这是自伤而非严谨。

**跨任务的红线验收测试属于 scaffold 产物**：组长在 `scaffolding` 阶段建好 e2e 空壳与 `pnpm test:e2e` 命令，此时它是红的，由后续任务逐个转绿。

每个开发任务的 DoD 因此固定为四件，顺序不可调：契约里的 Gherkin → 同分支单测（先红后绿）→ `gates_run` 全绿 → 验收证据写进 PR 描述。

## 6. 需求变更与重规划

### 6.1 用 `cancelled`，不是删除

`TASK_STATUSES`（`src/vocab.ts:31-39`）新增 `'cancelled'`；**契约文件保留不删**，保持可追溯。这是目标仓库 `.tasks/README.md` §3 已经确立的约定，本插件应当对齐而不是另立一套。连带：`_board.md` 的列表面板需要新增一列，现状只列 `needs-human`（`src/team.ts:146`）。

### 6.2 变更分级

| 变更 | 处置 | 是否惊动人 |
| --- | --- | --- |
| 新增 pending 任务、调 `priority`、取消**未派发**的 pending | 组长自主（`replan_*` 工具） | 否 |
| 触及已合并代码、改 PRD 验收数值、动禁区 | **必须** questionnaire(`kind:'replan'`) | 是 |

不给这张表的话，两个失败方向都会出现：要么每个小改动都发邮件（用户很快开始忽略），要么组长偷偷重写验收标准（用户失去控制权，且没有客观门能发现）。

### 6.3 在途任务被变更波及

`in_progress` / `in_review` 的任务被需求变更命中时，三种处置，**默认第三种**：

1. `supersede` —— 照原样合入，紧跟一个修正任务。**分支保留**，不丢已有工作。
2. `continue + followup` —— 当前继续，另开新契约承接增量。
3. `abort` —— 丢分支 = 丢工作，必须人批准（`kind:'replan'` 问卷）。

好消息是机制不用新造：`releaseMemberWorkspace`（`src/service.ts:734`）已经是通用 helper，被澄清（`:1120`）、合入（`:1283`）、升级（`:1683`）三处复用，`supersede` / `abort` 直接加第四个调用点即可。缺的只是**入口**——今天没有任何工具能让组长"撤回一个 in_progress 任务但不判它失败"。

### 6.4 依赖连带（当前就存在的洞）

`doneContracts` 只收集 `status === 'done'`（`src/service.ts:1972-1974`），依赖不满足时 `dispatch` 静默 `continue`（`:1984`）。后果：一旦某任务的前置是 `cancelled`，或永久卡在 `needs-human`，下游会**无限静默不派发**——不报错、不升级、也永远凑不出"全部 done"的完成报告，于是循环在空转降频里一直转。

修法：依赖判定引入**不可满足**概念，命中即升级新原因 `blocked-dependency`，并计入 `report.events`。这个洞现在就存在，加 `cancelled` 之前必须先补。

### 6.5 其余不变量

- **PRD 版本化**：`version` 递增 + §4.2 的变更日志段；任务单引用 `PRD §2.3@v1.7`，让"需求变了"成为可 diff 的事实而不是口头共识。
- **replan 频率上限**：单位时间内 `replan_*` 调用超限即拒绝。模型陷入"无限重排"是真实失败模式，而它自己不会察觉。
- **`maxTaskHours` 不因重规划重置**：墙钟预算是唯一可靠的烧钱护栏，重置等于给了无限续命的口子。
- **`interactive` 问卷豁免 `stuckMinutes`**：否则组长一次合法的"等人回答 45 分钟"会被误判成任务卡死并升级。`ask_human` 挂起期间应刷新 `lastActivityAt` 或以 `awaiting-human` 标记豁免判定。

## 7. 客户端交互通道

`SlotProps` 现状只有 `{ sessionId?, useProjection, t }`（`src/client/contract.ts:13-18`）——**面板发不出任何东西**。三个候选：

| 方案 | 评估 |
| --- | --- |
| 复用插件自己的工单 HTTP 服务，面板 `fetch POST` | **选它**。改动全在自己手里，服务端已有表单渲染与回写闭环，只需补 §7.1 三项 |
| `ctx.approval`（`@deepseek-ai/dsh-user-approval`） | 只能表达 `allowed-once/rejected/cancelled`，**不携带工具参数**，且要求"属于一个尚未结束的 agent 轮次"。可用于 `doc_approve` 的 yes/no，装不下问卷 |
| 借 `settingsScope` 写入再由服务端监听 | 语义误用，否决 |

### 7.1 选定的方案要补的三件事

1. **CORS**：面板与工单服务不同源（不同端口），需要带白名单的 `OPTIONS` 预检与 `Access-Control-Allow-Origin`。dsh web 走 HTTPS 时还有混合内容问题——工单服务需支持同源反代路径。
2. **URL 带 token**：工单端点现状**完全无鉴权**（README 已警告，默认只绑 `127.0.0.1`）。问卷答案=替 AI 做决策，必须把"谁都能按的按钮"变成"只有拿到链接的人能按"。
3. **修一个既有 bug**：提交答卷只调了 `this.changed()`（`src/service.ts:282`），而 `service.onChange` 从未被订阅去发 `autopilot/update` —— 面板要等到下一次工具调用才刷新。问卷闭环对刷新时机敏感，这个必须先修。

## 8. 安全边界（不可协商项）

沿用 README「安全模型」6 条，本文新增 4 条：

7. **AI 写文档只进 draft 区**，升格必须有 `doc_approve` 记录（审批人 + `sha256`）。
8. **问卷不改变命令白名单、不改变禁区**。用户"同意"不能解锁 `LICENSE`——禁区是配置决定的边界，不是一个可以被批准跨越的门（`AGENTS.md` / `.github/` 已于 2026-08-29 移出默认禁区，见 §4.1）。
9. **工单/问卷端点无鉴权 → 默认只绑回环**，远程访问必须走 SSH 隧道；`autoResume` 在端点加鉴权前保持 `false`。
10. **任何审批类状态转换不得由模型自己调用工具伪造**。`doc_approve` 只接受两条来源：本地端点 POST 或人直接在会话里调；组长与开发只能 `ask_human`。

## 9. 改动清单与里程碑

按依赖顺序排。每格给出"改哪"和"什么测试覆盖它"。

| 里程碑 | 内容 | 主要文件 | 覆盖测试 |
| --- | --- | --- | --- |
| **M0 先修（不做则一切白搭）** | phase 字段 + `dispatch` 门；补 §6.4 不可满足依赖 → `blocked-dependency`；修 §7.1-3 事件不发布；契约解析失败不再清空看板 | `vocab.ts` `schema.ts` `service.ts` `projection.ts` | `test-unattended.ts` 加分支 |
| **M1 能问、能写** | `src/questionnaire.ts` + 工单服务从 escalation 解耦；新工具 `ask_human` / `answer_questionnaire` / `doc_write` / `doc_approve` / `contract_create`；`TicketField` 补 `multiselect`；`roles.ts` 组长提示词重写（draft/升格，**不是**简单删除禁令） | `escalate.ts` 同级新文件、`notification.ts` `tools.ts` `team.ts` `roles.ts` | 新增 `test-questionnaire.ts` |
| **M2 卡片** | §7.1 三件事；面板渲染问卷卡片与 `awaiting-human` 态（顺带补现状**从未被渲染**的 `projection.blocked`） | `client/AutopilotPanel.tsx` `schema.ts` | `smoke-cordis.ts` 断言 client 产物无 zod / 无 `node:`（架构铁律 5） |
| **M3 重规划** | `cancelled` + `priority` + `replan_*` 工具 + §6.2 分级表 + §6.3 三种处置 + 频率上限；`_board.md` 加列 | `vocab.ts` `team.ts` `service.ts` `tools.ts` | `test-unattended.ts` 重规划分支 |

四个里程碑已落成任务契约：M0 = `.tasks/INT-1.md`、M1 = `INT-2.md`、M2 = `INT-3.md`、M3 = `INT-4.md`，依赖链 `INT-1 → INT-2 → INT-3`，且 `INT-4` 只依赖 `INT-1`。所以 M3 在依赖图上与 M2 可并行——但两者 `touches` 都含 `src/`，域锁实际仍会把它俩串行化（§10.1）。

`phase` 是新增投影字段 → **`stateVersion` 从 5 递增到 6**（`src/projection.ts:36`）。
新增 Config 字段（`questionnaire.mode`、`replan.maxPerHour`、`docs.draftDir`）→ 按 AGENTS.md「改一处要连带改哪儿」表连带：`index.ts` 的 `Config` 与 schema → `service/options.ts` → `apply()` 映射 → README 配置块 → 需要时 `client/settings-card.tsx`。
新增 `EscalationReason: blocked-dependency` → `vocab.ts` + 字典 `reason.*`，且**服务端必须真产出它**，否则只是给模型多一个错选项。

## 10. 试点验收

`/Users/yunke/works/ai-yunke`（AgentDeploy）**正好是本文所描述流程的产物**：PRD v1.7 + tech-stack v2.7 + development-guidelines v1.8 + 9 个 ADR + 37 张任务契约 + `scripts/validate-docs.py`。所以最便宜也最严的 L0 不是新建项目，而是：

> **回归式 L0**：让插件对着它已有的成熟文档跑一遍 `intake → kickoff_pending_approval`，断言**产出的 draft 与现状 diff 为空**。

这一发同时验证：问卷闭环可用、draft/升格机制不越权、`validate:docs` 能当客观门用、以及最关键的一条——**AI 会不会破坏既有约定**。

配置注意：该仓库用 `profile.preset: agentdeploy`（本插件已内置），`platform: generic` 时 **`requireCiGreen` 必须显式置 false**，否则"从未验证视为未通过"会永久阻塞 approve（见 PILOT.md §1）。

### 10.1 域阈值与本仓库布局冲突（自举时会撞上）

`distinctDomains` 按前缀折叠计域（`src/profile.ts:373`），两条路径仅当互为前缀时算同一域。这对 ai-yunke 那种多顶层域布局（`server/db/`、`app/`、`packages/cli/`）是对的，但本仓库 `src/` 是**扁平**的：把 `touches` 写成逐个源文件时，任何 4 文件的改动都算 4 个域，而 `crossDomainThreshold` 默认 3 —— 于是 `escalateCrossDomain`（`src/service.ts:2023-2035`）会在**首拍**就把它自动升级成 `cross-domain`，根本走不到派发。

两条出路：

- 本仓库跑 M0–M3 时把 `profile.crossDomainThreshold` 调到 6~8，契约按文件粒度写（并行度好，但 `src/` 下四个文件以上即触阈）；
- 或维持默认阈值，契约一律用目录粒度 `touches: [src/]`（本文的 `.tasks/INT-*.md` 取这条）。

代价要说清：目录粒度下 `src/` 是一个域，域锁 `touchesOverlap` 会让**所有 M0–M3 契约互斥**，一次只有一张能在飞——这把本插件最强的并行派发能力关掉了。里程碑契约本来就是串行依赖链，可以接受；但真要并行开发，就必须走文件粒度 + 调高阈值。

> 顺带：`escalateCrossDomain` 是每拍跑的，而 `assignTask` 里还有一份等价校验（`src/service.ts:967-974`）。同一判据两处实现，改一处必须同步另一处。

## 11. 未决问题

1. `async` 模式下"人回一句继续"能否被宿主接管？需要 `dsh-agent` / workflow 层的写入口，本插件不依赖它们，且引入会破坏架构铁律 1（核心与 cordis 解耦）。建议宿主提供，插件不越界。
2. `sha256` 审批链在用户直接手改文档时如何失效并重批——倾向：升格时比对失败即重开 questionnaire。
3. 优先级与域锁冲突时的调度策略：高 `priority` 但 `touches` 被锁，是等待还是越过去派别的？现状纯按插入顺序（`src/service.ts:1009`）。
4. 多团队并行时 phase 是否提升为 team 级——本文已按 team 级设计，但要确认与 `activeTeamId` 的渲染假设一致。
