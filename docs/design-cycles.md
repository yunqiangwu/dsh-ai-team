# 设计文档：迭代周期开发（AI 自主判断规模 / 用户零概念）

> 状态：**已实施**（2026-08-30，v2 重设计）。CYC-0 落本文档初版；v2 按「AI 自主判断规模、用户尽量零概念」要求重设计，新增 CYC-7（配置收敛与 AI 决策），CYC-1..7 随本版修订后全部落地。
> 分工：配置语义以 [../README.md](../README.md) 为准、操作以 [../PILOT.md](../PILOT.md) 为准；架构与连带关系以 [../AGENTS.md](../AGENTS.md) 为准。引用代码一律写符号名（函数 / 类 / 常量 / 工具名），不引裸行号。

## 0. 目标与范围

把插件从**「单一批次看待全部契约」**升级为**「AI 自己判断项目规模：小项目一个周期多任务、大项目自动拆多周期逐期推进、用户全程只写需求」**：

- **用户（人类）视角始终只有三样**：一份需求（PRD，走 kickoff 审批）、项目进度、开始/结束。周期、roadmap、`cycle_plan` 等一律是 AI 团队（组长）的内部动作，**不进用户视野**；
- **AI 自动判断规模**：组长读完 kickoff 包后自行判断——任务量小 / 单一模块 → 一个周期内拆完所有任务直接干；跨模块 / 多阶段 / 任务量大 → 自动起草 roadmap（走既有文档审批链，用户只批一次），逐期拆解、逐期推进；
- **边界请示由 AI 决策**：组长在规划每一期时自主决定该期边界要不要请用户确认（`checkpoint` 字段），而非全局开关；默认全自动推进，用户零负担；
- **机制保留**：v1 已验证的周期实体、契约 `cycle` 字段、增量规划、派发收窄、周期验收门、无人值守推进全部保留，仅把「开工审批 / 边界确认」从用户配置收敛为 AI 决策字段；
- **兼容不变**：老团队（无周期记录）行为一字不动；新团队默认也是单批路径，只有组长判定为大型项目才引入周期。

范围：周期实体、契约 `cycle` 字段、roadmap（AI 起草）、`cycle_plan` / `cycle_approve`、派发收窄、按周期完成与自动推进、`checkpoint` 边界决策、任务描述注入周期上下文、面板周期视图、组长 prompt 规模判断指引。
不在范围：多团队 / 跨仓库编排、周期内任务自动拆解算法、周期级甘特等复杂可视化、Web 面板视觉重做。

验收口径：§10 里程碑表（CYC-1..7）全部落地，且 CYC-6 的 `tests/test-cycles.ts` 覆盖 §5/§6 全部场景、按周期完成语义不回归老团队。

### 术语对齐

| 术语 | 语义 | 谁接触 |
| --- | --- | --- |
| **需求（PRD）** | 项目目标与验收要点，走既有 kickoff 审批链 | 用户（写）与组长（读） |
| **roadmap（路线图）** | 大项目分期的长期计划，各周期目标与范围，`cycle_plan` 的唯一依据 | **仅组长**（AI 起草，用户只批一次） |
| **cycle（周期）** | 一个迭代批次：目标 + 范围 + 一组任务，挂在 `TeamRecord.cycles` | 仅 AI 团队内部 |
| **checkpoint（边界检查点）** | 周期字段：本周期验收后是否请用户确认再推进，由组长 `cycle_plan` 时按风险自主决定 | 组长决策；用户只被问「继续 / 结束」 |
| **当前活跃周期** | 状态为 `in_progress` 的周期；它决定 `dispatch` 的收窄范围 | 仅 AI 团队内部 |

## 1. 两条决定设计的硬约束

### 1.1 插件从不唤醒 agent（沿用既有约束）

全仓库无 `subagent` / `spawnSession` / `createAgent` 任何调用；起 agent 是宿主/调用方的责任。推论直接影响「自动规划下一期」：**插件不能自己把组长叫醒去 `cycle_plan`**。因此「AI 自动判断」的载体是**组长 agent 的工作流**（`src/roles.ts` 的 leader prompt 写明判断标准与默认动作），插件侧只负责：暴露判断所需的状态（`autopilot_status`）、提供工具（`doc_write` 起草 roadmap / `cycle_plan` 拆期 / `contract_create` 单批拆任务）、以及周期验收后的机械推进。唯一的无人值守路径是「下一期已由组长预排好」，插件机械地把 `planned → in_progress`；未预排时落一张问卷暴露「请规划下一期」，绝不静默空转。

### 1.2 周期是 developing 内的子推进，不是新 phase

`TeamPhase`（`intake → kickoff_pending_approval → scaffolding → developing ⇄ replanning`）管的是「文档先行走没走完」，`LOOP_STATES` 管「循环在不在转」。周期推进是**开发期内的工作排序**，不与这两条正交维度抢语义：

- 不加新 phase 取值（`DISPATCHABLE_PHASES` 门不动）；
- `loopState='completed'` 语义保留，只在 roadmap 走完后触发（§6.5）。

## 2. 用户视角：只写需求，其余交给 AI

### 2.1 用户做且只做三件事

1. **写需求**：PRD 进 kickoff 审批（现状流程，一字不变）；
2. **批一次 roadmap（仅大项目）**：组长判定为大型项目时，会 `doc_write` 起草 roadmap 草案请用户批准——这是**唯一**新增的用户动作，且只在组长判断需要分期时才出现；
3. **边界可选的「继续 / 结束」**：组长在某期边界设了 `checkpoint` 时，用户会被问一次；不设则全自动，用户只看进度。

### 2.2 用户不需要知道的概念

roadmap 的写作规范、`cycle_plan` / `cycle_approve` 工具、周期状态机、`planned / in_review` 等内部状态、`checkpoint` 字段——全部由组长 AI 消化，README 只对**使用者（配插件的人）**讲清「你只需提供 PRD；大型项目插件会自动分期推进」，工具细节只出现在组长 prompt 与「工具一览」。

## 3. 周期实体与状态机

### 3.1 CycleRecord（挂在 TeamRecord）

```ts
interface CycleRecord {
  id: string;          // cycle_xxxxxxxx
  name: string;        // "M1" —— 与 roadmap 章节名、契约 cycle 字段对齐
  status: CycleStatus; // planned → in_progress → in_review → done
  goal: string;        // 本周期目标（来自 roadmap，注入任务描述用）
  scope: string[];     // 本周期范围（路径粒度，供域锁/描述用）
  taskIds: string[];   // 本周期任务契约 id
  checkpoint?: boolean; // 本周期验收后是否请用户确认再推进（组长 cycle_plan 时自主决定，缺省 false）
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
}
```

- `TeamRecord` 增加可选 `cycles?: CycleRecord[]`：老 state.json 没有该字段，`load()` 一律 `?? []` 兜底（与 `learnings` / `metrics` 同一兼容约定）。
- `CYCLE_STATUSES` 进 `src/vocab.ts` 的 `as const` 数组（唯一清单）：`['planned', 'in_progress', 'in_review', 'done']`；`schema.ts` 用 `zod.enum(...)` 读它，下游（工具参数、面板渲染）只读这一份。视图类型 `CycleView` 由 `schema.ts` 的 `z.infer` 派生，不手写第二份。

### 3.2 周期状态机

```
planned → in_progress → in_review → done
   │          │            │
   │          └── 周期开工（cycle_approve，机械动作，无人审批环节）
   │                        └── 周期验收通过（§6.3；checkpoint=true 时先问卷）
   └───────── cycle_plan 生成下一期契约；不回退
```

- `planned`：`cycle_plan` 刚生成契约，尚未开工。**此状态的周期内契约不派发**（§5.3）。
- `in_progress`：当前活跃周期，其任务可派发。
- `in_review`：该周期全部任务 done/cancelled，等待验收；`checkpoint=true` 时等用户点头。
- `done`：验收通过，该周期结束。

## 4. 契约的 cycle 字段

### 4.1 frontmatter

```markdown
---
id: API-3
title: 实现 /v1/users 路由
cycle: M1            # 可选；缺省 = 未排期
status: pending
depends_on: [API-2]
touches: [src/api/]
---
```

- `parseTaskContract`（`src/team.ts`）解析 `cycle`（可选，缺省 null）；`patchTaskContract` 支持就地改 `cycle`，逐字节保留其余 frontmatter 行。
- 无 `cycle` 字段的契约行为不变（§9 兼容）。

### 4.2 看板分组

- `regenerateBoard`（`src/team.ts`）输出按周期分组：先列周期头（`name` + 状态 + 该周期内 done/total），再列其任务；无周期契约归「未排期」区。`_board.md` 仍不含时间戳（不弄脏 worktree）。

## 5. roadmap 与增量规划

### 5.1 roadmap 由 AI 起草

- 路径：`cycles.roadmapPath`（默认 `docs/ROADMAP.md`）。
- **起草者是组长 AI**：判定为大型项目后，组长用 `doc_write` 把 roadmap 草稿写进 draft 区，走既有 draft→accept 审批链（`doc_approve` 属于用户，sha256 钉住 + 版本递增），正式区才有资格被 `cycle_plan` 引用——与 PRD 同一套「一处事实一处写」。用户只批一次，不参与写作。
- 结构约定：每个周期一个章节（`## M1`、`## M2`…），每节含 `goal`（一句目标）与 `scope`（路径清单）；可选含任务种子（标题 + 验收要点），`cycle_plan` 据此生成契约。章节名与 `CycleRecord.name` / 契约 `cycle` 值对齐。
- 版本引用沿用 `PRD §2.3@v1.7` 风格：`ROADMAP §M2@v1.1`。

### 5.2 cycle_plan（新工具）：只拆下一期

组长调 `cycle_plan`，给定 `cycleName`（roadmap 章节，如 `M2`）：

- 生成一张 `CycleRecord`（status `planned`）+ 该周期内的一组 pending 契约（带 `cycle: M2`）；
- **绝不**同时生成更远期周期的契约——增量规划核心不变量：只排下一期；
- 可选参数 `checkpoint: true`：声明「本周期验收后请用户确认再推进」（组长按风险自主决策，缺省 false）；
- 写前校验复用 `contract_create` 的既有校验（id / 悬空依赖 / 成环 / 禁区 / 域数）。

### 5.3 cycle_approve（工具）：周期开工

组长调 `cycle_approve` 把 `planned → in_progress`。**无审批环节**（kickoff 时用户已批过项目）：周期开工是机械动作，不再需要用户点头（v1 的 `requireApproval` 配置已移除）。

### 5.4 派发收窄：只派当前周期

`dispatch`（`src/service.ts`）在既有依赖/域锁/禁区判定之上增加周期判定。契约 `c` 是否被推迟：

```
deferred(c) = c.cycle != null
              && cycleRecord(c.cycle) != null
              && cycleRecord(c.cycle).status === 'planned'
```

即：只有「明确属于某张已规划但未开工周期」的契约被推迟（保持 pending，静默等待，不产生事件刷屏）；属于当前活跃周期的、或无对应周期记录的契约照常参与派发。未来周期只有在被 `cycle_plan` 排成 `planned` 的那一刻才进入推迟集合——这正是「完成一期再规划下一期」的机械边界。

## 6. 周期验收门与无人值守推进

### 6.1 完成语义按周期（改 checkCompletion）

`checkCompletion`（`src/service.ts`，由 `tickOnce` 每拍调用）重写：

- 团队无周期记录（或全契约无 `cycle`）→ 维持现状：全部任务 done/cancelled → `loopState='completed'`，写完成报告；
- 有周期记录 → 完成判定按**当前周期的任务子集**算，不再等全部任务。

### 6.2 周期验收门

当前周期 `in_progress`，且其 `taskIds` 全部 done/cancelled：

- 周期置 `in_review`；
- 验收通过口径 = 该周期任务全 done/cancelled（可含门绿/CI 汇总，以 CYC-3 实现为准）；
- 生成该周期完成小结（并入 `<stateDir>/completion.md`，`report.ts` 增加按周期汇总段）。

### 6.3 推进到下一期（两路 + 兜底，遵循 §1.1）

`in_review` 验收通过后，按该周期 `checkpoint` 与下一期就绪度分流：

| 分支 | 条件 | 动作 |
| --- | --- | --- |
| **直通** | `checkpoint` 未设 且下一期已 `planned`（契约在盘上） | 机械地把下一期 `planned → in_progress`，继续派发；**唯一全程无人值守的路径** |
| **检查点** | 该周期 `checkpoint: true`（组长声明） | 周期停在 `in_review`，落问卷（kind `cycle`）请用户「继续 / 结束」；点头后 `done` 并（视就绪度）直通或等规划 |
| **等规划**（兜底） | `checkpoint` 未设 但 roadmap 还有下一期、尚未预排 | 周期置 `done`；落一张问卷（kind `cycle`）说明「本期完成，请规划下一期」，**绝不静默空转**（§6.4）；组长下一轮 `cycle_plan` 后自动继续 |

推进判据收敛为周期级 `checkpoint` 字段（`cycleAdvancePlan(cycles)`），v1 的全局 `autoAdvance` 配置已移除——「边界是否请示」是组长每期的 AI 决策，不是用户的全局开关。

### 6.4 空转保护与守护判定

- 「周期完成但下一期未排/未批」是**正常等待，不是故障**：`checkStuck` / `budgetExceeded`（`src/service/daemon.ts`）不得误判成任务卡死。周期等待走问卷的 open 态（沿用既有问卷语义：不产生升级直方图、不捕获学习记录、`checkStuck` 豁免）；
- 但也不能无限静默：问卷永不答最终走既有 `budget-exceeded` 升级路径（`checkBudget` 不豁免问卷，沿用现状）；
- 有周期记录但 roadmap 已无下一期且当前周期已 `done` → 正常 `completed`（§6.5），不算配置不一致；配置与契约不一致（如 `roadmapPath` 指向不存在的正式文档）→ **不静默**，按规格升级（复用既有 `ESCALATION_REASONS`，不新增分类，除非实现确需）。

### 6.5 roadmap 走完才 completed

roadmap 已无下一期（或 `cycle_plan` 不再产出），且当前周期已 `done` → 置 `loopState='completed'`，写完成报告（含各周期汇总）。

## 7. AI 自动判断：组长的工作流（src/roles.ts）

「AI 自己判断」的落地载体是组长 system prompt。`systemPromptFor('leader')` 新增一段「规模判断与分期决策」，规则：

1. **读完 kickoff 包后先判断规模**（依据：PRD 的验收点数量、`touches` 覆盖的模块数、依赖链长度、是否有明显阶段边界）：
   - **单周期**（默认）：任务量小 / 单一模块 / 无明显阶段边界 → 直接 `contract_create`（或 `cycle_plan` 一次）拆完**所有**任务并派发，不引入周期记录、不写 roadmap。用户零额外概念；
   - **多周期**（大型）：跨多个模块 / 阶段清晰（如「v1 核心 → v2 增强」）/ 任务量显著 → `doc_write` 起草 roadmap 请用户批一次，再 `cycle_plan` 逐期拆解、逐期推进；
2. **边界决策**：每次 `cycle_plan` 时自主决定 `checkpoint`——默认 false（全自动）；该期涉及方向性选择 / 跨域合并 / 外部依赖 / 成本变化时设 true 请示用户；
3. **兜底不静默**：周期完成后主动查看 `autopilot_status` 的 open 问卷，下一期未预排就尽快 `cycle_plan` 续上，避免团队停摆。

判断标准要写成「宁可单周期、够用时绝不拆」，把周期机制视为大型项目才动用的工具，避免为概念而概念。

## 8. 配置字段

Config（`index.ts` 的 `Config`）新增可选 `cycles` 块，映射进 `AutopilotOptions`（`src/service/options.ts`），读取处 `?? 默认值` 兜底老配置：

| 字段 | 默认 | 语义 | 谁用 |
| --- | --- | --- | --- |
| `cycles.roadmapPath` | `docs/ROADMAP.md` | roadmap 文档路径（AI 起草，draft→accept 审批链） | 组长 |

v1 的 `cycles.requireApproval` / `cycles.autoAdvance` **已移除**：开工审批不再是配置（kickoff 已批），边界确认收敛为周期级 `checkpoint`（组长 AI 决策）。老配置携带这两字段时读取侧忽略（向后兼容，不报错）。

配置字段语义写入 README「配置」，本文件不抄。

## 9. 兼容策略

- **老团队（无周期记录 / 无 `cycle` 字段契约）行为一字不变**：完成语义、派发、看板、描述注入都走现状路径；
- **新团队默认单批**：只有组长判定大型项目并 `cycle_plan` 后才出现周期记录，周期机制不改变默认体验；
- `state.json`：`TeamRecord.cycles`、`CycleRecord.checkpoint` 一律可选字段 + `load()` 兜底，不迁移旧盘；
- `stateVersion`：CYC-1 因 `CycleView` 进入投影（视图形状变化）而 +1；`checkpoint` 为内部字段不进视图，不改 stateVersion（如进入视图则按「改一处要连带改哪儿」表联动）。

## 10. 改动清单与里程碑

| 里程碑 | 契约 | 改动点 | 连带 |
| --- | --- | --- | --- |
| **CYC-1 周期实体** | [../.tasks/CYC-1.md](../.tasks/CYC-1.md) | `CycleRecord` / `TeamRecord.cycles` / `CYCLE_STATUSES` / 契约 `cycle` 解析与回写 / `regenerateBoard` 分组 / `CycleView` | `vocab.ts` `state.ts` `team.ts` `schema.ts` `projection.ts`；`stateVersion` +1；字典 |
| **CYC-2 增量规划** | [../.tasks/CYC-2.md](../.tasks/CYC-2.md) | roadmap 文档约定 / `cycle_plan` / `cycle_approve` / 派发按 §5.4 收窄 | `service.ts` `tools.ts` `vocab.ts`；`tests/smoke-cordis.ts` 工具清单 |
| **CYC-3 无人值守推进** | [../.tasks/CYC-3.md](../.tasks/CYC-3.md) | `checkCompletion` 按周期 / 周期验收门 / §6.3 推进 / 空转保护（v2 起 `checkpoint` 字段驱动） | `service.ts` `daemon.ts` `report.ts`；README 主循环小节 |
| **CYC-7 AI 决策与配置收敛** | [../.tasks/CYC-7.md](../.tasks/CYC-7.md) | `CycleRecord.checkpoint` / `cycle_plan` 支持 `checkpoint` 参数 / 移除 `requireApproval` `autoAdvance` 配置 / `cycleAdvancePlan` 改按 checkpoint 判定 / 组长 prompt 规模判断与边界决策 | `options.ts` `index.ts` `roles.ts` `tools.ts` `service.ts` `daemon.ts`；README 配置块；CYC-3/6 测试同步 |
| **CYC-4 注入与守护** | [../.tasks/CYC-4.md](../.tasks/CYC-4.md) | `buildDescription` 周期上下文 / 周期配置透出（`roadmapPath`）/ 守护判定不误伤 | `description.ts` `options.ts` `vocab.ts`；字典 |
| **CYC-5 视图面板** | [../.tasks/CYC-5.md](../.tasks/CYC-5.md) | 投影 `CycleView` / 面板周期列表与进度（含 checkpoint 标记）/ i18n zh+en | `schema.ts` `projection.ts` `src/client/` |
| **CYC-6 测试文档** | [../.tasks/CYC-6.md](../.tasks/CYC-6.md) | `tests/test-cycles.ts` / README「迭代周期开发与无人值守闭环」（用户视角）/ 本文件状态转「已实施」 | `tests/` `README.md` |

依赖链：`CYC-0 → CYC-1 → {CYC-2 → {CYC-3, CYC-7, CYC-4}, CYC-5} → CYC-6`。

## 11. 未决问题

1. **周期验收门是否纳入门绿/CI 汇总**：本期先按「该周期任务全 done/cancelled」定义，是否需要聚合门结果由 CYC-3 试点决定。
2. **`_board.md` 周期头是否含进度数字**：进度数字会让重生成依赖计数稳定，本期倾向「只列状态不列计数」以避免每拍弄脏 worktree，待 CYC-1 落定。
3. **单周期路径是否显式建模**：本期倾向「小项目不建周期记录、直接单批契约」（最简）；若试点发现用户希望面板有「Iteration 1」进度，再给单批隐式包一层周期视图（不改变机制）。
