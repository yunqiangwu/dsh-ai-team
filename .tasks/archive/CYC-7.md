---
id: CYC-7
title: AI 自主决策与配置收敛：checkpoint / 组长规模判断
status: done
priority: 6
depends_on: [CYC-2, CYC-3]
touches:
  - src/service/options.ts
  - src/index.ts
  - src/roles.ts
  - src/tools.ts
  - src/service.ts
  - src/service/daemon.ts
  - tests/helpers.ts
  - tests/test-cycles.ts
---

# AI 自主决策与配置收敛：checkpoint / 组长规模判断

对应设计文档 [docs/design-cycles.md](../docs/design-cycles.md) v2（§7 / §8 / §6.3）。

## 背景

v1 用两个全局配置控制周期节奏：`cycles.requireApproval`（开工要人批）、`cycles.autoAdvance`（验收后自动推进）。这违背「AI 自己判断、用户零概念」：边界要不要请示本是组长每期的 AI 决策，不该是用户的全局开关。v2 收敛为一个周期字段 `checkpoint`（组长 `cycle_plan` 时自主声明），并把「规模判断 / 分期决策」写进组长 prompt（`src/roles.ts`），让「小项目一周期多任务、大项目自动分期」由 AI 自己决定。CYC-3 已实现的推进逻辑改为按 `checkpoint` 驱动。

## 验收标准

### 场景一：checkpoint 周期字段

- **Given** 组长 `cycle_plan` 时传 `checkpoint: true`（该期边界要请用户确认）
- **Then** 该 `CycleRecord` 落 `checkpoint` 字段；周期任务全 done/cancelled 后停在 `in_review`，落一张 `kind: cycle` 问卷请用户「继续 / 结束」，答「继续」才 `done` 并推进
- **And** `cycle_plan` 缺省（checkpoint=false）→ 验收后走直通（下一期已预排）或等规划（未预排），**不**落检查点问卷

### 场景二：配置收敛

- **Then** 移除 `cycles.requireApproval` / `cycles.autoAdvance`：`src/index.ts` 的 `Config` 与 schema、`src/service/options.ts` 的 `AutopilotOptions` 与 `RuntimeConfig`、README「配置」块只保留 `cycles.roadmapPath`
- **And** `cycle_approve` 恒机械开工（`planned → in_progress`），不再有审批环节
- **And** 老配置携带被移除字段时读取侧忽略（向后兼容，不报错）

### 场景三：组长 AI 自动判断（src/roles.ts）

- **Then** leader prompt 新增「规模判断与分期决策」段：读完 kickoff 包后先判断规模——任务量小 / 单一模块 → 直接 `contract_create` 拆完所有任务（不建周期记录）；跨模块 / 多阶段 / 任务量大 → `doc_write` 起草 roadmap 请用户批一次，再 `cycle_plan` 逐期拆解
- **And** 每次 `cycle_plan` 自主决定 `checkpoint`：默认 false；涉及方向性选择 / 跨域合并 / 外部依赖 / 成本变化时设 true
- **And** 判断标准倾向「宁可单周期、够用时绝不拆」，周期机制只在大型项目才动用

### 场景四：守护与测试

- **Then** `cycleAdvancePlan` 改按 `cycle.checkpoint` 判定（去掉 `autoAdvance` 参数），checkpoint 等待不误伤 `checkStuck`，也不提前 `completed`
- **And** `tests/helpers.ts` 的默认 `cycles` 只剩 `roadmapPath`；`tests/test-cycles.ts` 把 `requireApproval` / `autoAdvance` 用例改为 checkpoint 用例（开工恒自动、直通 / 检查点 / 等规划三路）
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿

## 超出范围

- 周期视图 / 面板（归 CYC-5）；周期上下文注入任务描述（归 CYC-4）。
