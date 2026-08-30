# 设计文档：多周期开发与无人值守闭环

> 状态：**提案**（2026-08-30）。CYC-0 落本文档，CYC-1..6 待实施；实施完成后本节状态改「已实施」。
> 分工：配置语义以 [../README.md](../README.md) 为准、操作以 [../PILOT.md](../PILOT.md) 为准；架构与连带关系以 [../AGENTS.md](../AGENTS.md) 为准。引用代码一律写符号名（函数 / 类 / 常量 / 工具名），不引裸行号。

## 0. 目标与范围

把插件从**「单一批次看待全部契约」**升级为**「大型项目拆多周期、每周期多任务、完成一期再规划下一期、无人值守闭环」**：

- 一个大型项目对应一张 roadmap（长期路线图），拆成多个周期（如 M1、M2…）；
- 每个周期内多个任务，任务契约带周期归属；
- **只规划下一期**：`cycle_plan` 永远只拆当前要做的那个周期，不在开工前把未来所有周期都规划完（增量规划的核心不变量）；
- **只派发当前周期**：未来周期的契约保持 pending，不被 `dispatch` 提前派出；
- 当前周期全部任务完成后触发周期验收，验收通过后推进到下一周期，直到 roadmap 走完才真正 `completed` 停机；
- 周期边界是否需要人点头、下一期是否已由组长预排好，决定它是**无人值守直通**还是落一张问卷等人回答——插件从不唤醒 agent（§1 沿用既有硬约束）。

范围：周期实体、契约 `cycle` 字段、roadmap、`cycle_plan` / `cycle_approve`、派发收窄、按周期完成与自动推进、任务描述注入周期上下文、面板周期视图。
不在范围：多团队 / 跨仓库编排、周期内任务自动拆解算法、周期级甘特等复杂可视化、Web 面板视觉重做。

验收口径：§10 里程碑表（CYC-1..6）全部落地，且 CYC-6 的 `tests/test-cycles.ts` 覆盖 §5/§6 全部场景、CYC-3 的按周期完成语义不回归老团队。

### 术语对齐

| 术语 | 语义 | 与现状的关系 |
| --- | --- | --- |
| **cycle（周期）** | 一个里程碑批次：目标 + 范围 + 一组任务 | 新增实体，挂在 `TeamRecord.cycles` |
| **roadmap（路线图）** | 长期计划文档，各周期的目标与范围，是 `cycle_plan` 的唯一依据 | 走既有 draft→accept 审批链（`doc_write` / `doc_approve`），不是新机制 |
| **当前活跃周期** | 状态为 `in_progress` 的周期；它决定 `dispatch` 的收窄范围 | 新概念，见 §5.4 |
| **增量规划** | 只拆下一期、不在开工前规划全部周期的行为 | 新流程，见 §5 |

## 1. 两条决定设计的硬约束

### 1.1 插件从不唤醒 agent（沿用既有约束）

全仓库无 `subagent` / `spawnSession` / `createAgent` 任何调用；起 agent 是宿主/调用方的责任。推论直接影响 §6 的「自动规划下一期」：**插件不能自己把组长叫醒去 `cycle_plan`**。因此「下一期未预排」时，插件只能把「需要规划下一期」暴露出来（面板 / `autopilot_status` / 问卷），等人或组长下一轮动手；唯一能全程无人值守的路径是「下一期已由组长**预排好**（`planned` 契约已在盘上）」，插件只需机械地把 `planned → in_progress` 并继续派发。

### 1.2 周期是 developing 内的子推进，不是新 phase

`TeamPhase`（`intake → kickoff_pending_approval → scaffolding → developing ⇄ replanning`）管的是「文档先行走没走完」，`LOOP_STATES` 管「循环在不在转」。周期推进是**开发期内的工作排序**，不与这两条正交维度抢语义：

- 不加新 phase 取值（`DISPATCHABLE_PHASES` 门不动）；
- `loopState='completed'` 语义保留，只在 roadmap 走完后触发（§6.5）。

## 2. 周期实体与状态机

### 2.1 CycleRecord（挂在 TeamRecord）

```ts
interface CycleRecord {
  id: string;          // cycle_xxxxxxxx
  name: string;        // "M1" —— 与 roadmap 章节名、契约 cycle 字段对齐
  status: CycleStatus; // planned → in_progress → in_review → done
  goal: string;        // 本周期目标（来自 roadmap，注入任务描述用）
  scope: string[];     // 本周期范围（路径粒度，供域锁/描述用）
  taskIds: string[];   // 本周期任务契约 id
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
}
```

- `TeamRecord` 增加可选 `cycles?: CycleRecord[]`：老 state.json 没有该字段，`load()` 一律 `?? []` 兜底（与 `learnings` / `metrics` 同一兼容约定）。
- `CYCLE_STATUSES` 进 `src/vocab.ts` 的 `as const` 数组（唯一清单）：`['planned', 'in_progress', 'in_review', 'done']`；`schema.ts` 用 `zod.enum(...)` 读它，下游（工具参数、面板渲染）只读这一份。视图类型 `CycleView` 由 `schema.ts` 的 `z.infer` 派生，不手写第二份。

### 2.2 周期状态机

```
planned → in_progress → in_review → done
   │          │            │
   │          └── 周期开工（§5.3：requireApproval 时先问卷）
   │                        └── 周期验收通过（§6.3）
   └───────── cycle_plan 生成下一期契约；不回退
```

- `planned`：`cycle_plan` 刚生成契约，尚未开工。**此状态的周期内契约不派发**（§5.4）。
- `in_progress`：当前活跃周期，其任务可派发。
- `in_review`：该周期全部任务 done/cancelled，等待验收（`autoAdvance: false` 时等人点头）。
- `done`：验收通过，该周期结束。

## 3. 契约的 cycle 字段

### 3.1 frontmatter

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

### 3.2 看板分组

- `regenerateBoard`（`src/team.ts`）输出按周期分组：先列周期头（`name` + 状态 + 该周期内 done/total），再列其任务；无周期契约归「未排期」区。`_board.md` 仍不含时间戳（不弄脏 worktree）。

## 4. roadmap 文档约定

- 路径：`cycles.roadmapPath`（默认 `docs/ROADMAP.md`）。
- 走既有文档先行的 draft→accept 审批链（`doc_write` / `doc_approve`，sha256 钉住 + 版本递增），正式区才有资格被 `cycle_plan` 引用——与 PRD 同一套「一处事实一处写」。
- 结构约定：每个周期一个章节（`## M1`、`## M2`…），每节含 `goal`（一句目标）与 `scope`（路径清单）；可选含任务种子（标题 + 验收要点），`cycle_plan` 据此生成契约。章节名与 `CycleRecord.name` / 契约 `cycle` 值对齐。
- 版本引用沿用 `PRD §2.3@v1.7` 风格：`ROADMAP §M2@v1.1`。

## 5. 增量规划

### 5.1 cycle_plan（新工具）：只拆下一期

组长调 `cycle_plan`，给定 `cycleName`（roadmap 章节，如 `M2`）：

- 生成一张 `CycleRecord`（status `planned`）+ 该周期内的一组 pending 契约（带 `cycle: M2`）；
- **绝不**同时生成更远期周期的契约——增量规划核心不变量：只排下一期；
- 写前校验复用 `contract_create` 的既有校验（id / 悬空依赖 / 成环 / 禁区 / 域数）。

### 5.2 cycle_approve（新工具）：周期开工

组长调 `cycle_approve`（或复用 `ask_human` + 服务端回写）把 `planned → in_progress`：

- `cycles.requireApproval: false`（默认，无人值守）→ 自动开工，不惊动人；
- `true` → 先落问卷（kind 复用 `approval` 或新增 `cycle`，以 CYC-2 实现为准），人批之前不落盘。

### 5.3 派发收窄：只派当前周期

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

### 6.3 推进到下一期（三岔口，遵循 §1.1）

`in_review` 验收通过后，按配置与下一期就绪度分流：

| 分支 | 条件 | 动作 |
| --- | --- | --- |
| **直通** | `autoAdvance: true` 且下一期已 `planned`（契约在盘上） | 机械地把下一期 `planned → in_progress`，继续派发；**唯一全程无人值守的路径** |
| **等规划** | `autoAdvance: true` 但 roadmap 还有下一期、尚未预排 | 周期置 `done`；落一张问卷（kind 复用/新增，`async` 模式）说明「M1 完成，请规划 M2」，**绝不静默空转**（§6.4）；人/组长下一轮 `cycle_plan` 后自动继续 |
| **人工检查点** | `autoAdvance: false` | 周期置 `in_review`，落问卷等人点头后才 `done` 并（视配置）等下一期预排 |

### 6.4 空转保护与守护判定

- 「周期完成但下一期未排/未批」是**正常等待，不是故障**：`checkStuck` / `budgetExceeded`（`src/service/daemon.ts`）不得误判成任务卡死。周期等待走问卷的 open 态（沿用既有问卷语义：不产生升级直方图、不捕获学习记录、`checkStuck` 豁免）；
- 但也不能无限静默：问卷永不答最终走既有 `budget-exceeded` 升级路径（`checkBudget` 不豁免问卷，沿用现状）；
- `autoAdvance: true` 且「没有 roadmap / roadmap 无下一期」却被判有周期记录时，说明配置与契约不一致——**不静默**，按规格升级（复用既有 `ESCALATION_REASONS`，不新增分类，除非实现确需）。

### 6.5 roadmap 走完才 completed

roadmap 已无下一期（或 `cycle_plan` 不再产出），且当前周期已 `done` → 置 `loopState='completed'`，写完成报告（含各周期汇总）。

## 7. 任务描述注入周期上下文

`buildDescription`（`src/service/description.ts`）新增周期上下文段：所属周期（当前活跃周期）的 `goal` + `scope` 摘要，让开发者知道「为什么现在做、边界在哪」。预算倒排保持既有铁律：**所有权段永不裁**；周期上下文优先级高于教训与契约正文；总长恒受 `DESCRIPTION_TOTAL_LIMIT` 约束。注入来源 = `activeCycle(team)`，无周期记录时该段为空（不回归）。

## 8. 配置字段

Config（`index.ts` 的 `Config`）新增可选 `cycles` 块，映射进 `AutopilotOptions`（`src/service/options.ts`），读取处 `?? 默认值` 兜底老配置：

| 字段 | 默认 | 语义 |
| --- | --- | --- |
| `cycles.roadmapPath` | `docs/ROADMAP.md` | roadmap 文档路径（draft→accept 审批链） |
| `cycles.requireApproval` | `false` | 周期开工是否要人点头（false = 无人值守自动开工） |
| `cycles.autoAdvance` | `true` | 周期验收后是否自动推进到下一期（false = 每个周期边界等人确认） |

配置字段语义写入 README「配置」，本文件不抄。

## 9. 兼容策略

- **老团队（无周期记录 / 无 `cycle` 字段契约）行为一字不变**：完成语义、派发、看板、描述注入都走现状路径；
- `state.json`：`TeamRecord.cycles`、`TaskRecord`（如需）一律可选字段 + `load()` 兜底，不迁移旧盘；
- `stateVersion`：CYC-1 因 `CycleView` 进入投影（视图形状变化）而 +1，按「改一处要连带改哪儿」表联动 `schema.ts` / `projection.ts` / 面板渲染 / 字典。

## 10. 改动清单与里程碑

| 里程碑 | 契约 | 改动点 | 连带 |
| --- | --- | --- | --- |
| **CYC-1 周期实体** | [../.tasks/CYC-1.md](../.tasks/CYC-1.md) | `CycleRecord` / `TeamRecord.cycles` / `CYCLE_STATUSES` / 契约 `cycle` 解析与回写 / `regenerateBoard` 分组 / `CycleView` | `vocab.ts` `state.ts` `team.ts` `schema.ts` `projection.ts`；`stateVersion` +1；字典 |
| **CYC-2 增量规划** | [../.tasks/CYC-2.md](../.tasks/CYC-2.md) | roadmap 文档约定 / `cycle_plan` / `cycle_approve` / 派发按 §5.3 收窄 | `service.ts` `tools.ts` `vocab.ts`；`tests/smoke-cordis.ts` 工具清单 |
| **CYC-3 无人值守推进** | [../.tasks/CYC-3.md](../.tasks/CYC-3.md) | `checkCompletion` 按周期 / 周期验收门 / §6.3 三岔口 / 空转保护 | `service.ts` `daemon.ts` `report.ts`；README 主循环小节 |
| **CYC-4 注入与守护** | [../.tasks/CYC-4.md](../.tasks/CYC-4.md) | `buildDescription` 周期上下文 / 周期配置透出 / 守护判定不误伤 | `description.ts` `options.ts` `vocab.ts`；字典 |
| **CYC-5 视图面板** | [../.tasks/CYC-5.md](../.tasks/CYC-5.md) | 投影 `CycleView` / 面板周期列表与进度 / i18n zh+en | `schema.ts` `projection.ts` `src/client/` |
| **CYC-6 测试文档** | [../.tasks/CYC-6.md](../.tasks/CYC-6.md) | `tests/test-cycles.ts` / README「多周期开发与无人值守闭环」/ 本文件状态转「已实施」 | `tests/` `README.md` |

依赖链：`CYC-0 → CYC-1 → {CYC-2 → {CYC-3, CYC-4}, CYC-5} → CYC-6`。

## 11. 未决问题

1. **周期验收门是否纳入门绿/CI 汇总**：本期先按「该周期任务全 done/cancelled」定义，是否需要聚合门结果由 CYC-3 试点决定。
2. **`cycle_approve` 与 `ask_human` 的关系**：开工审批是复用既有 `approval` 问卷还是新增 `cycle` kind——倾向复用（不加分类），由 CYC-2 实现确认服务端确会产出时再定。
3. **`_board.md` 周期头是否含进度数字**：进度数字会让重生成依赖计数稳定，本期倾向「只列状态不列计数」以避免每拍弄脏 worktree，待 CYC-1 落定。
