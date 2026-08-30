---
id: CYC-3
title: 无人值守推进：按周期完成 / 验收门 / 自动规划下一期
status: done
priority: 6
depends_on: [CYC-1, CYC-2]
touches:
  - src/service.ts
  - src/service/daemon.ts
  - src/service/report.ts
---

# 无人值守推进：按周期完成 / 验收门 / 自动规划下一期

对应设计文档 [docs/design-cycles.md](../docs/design-cycles.md)。

## 背景

`checkCompletion`（`src/service.ts`）现在把所有任务 done/cancelled 视为「整个项目完成」并置 `loopState='completed'` 停机。多周期下这是错的：一个周期完成 ≠ 项目完成，应该推进到下一周期。这是「无人值守闭环」的心脏。

## 验收标准

### 场景一：完成语义按周期

- **Given** 当前周期 M1 的所有任务 done/cancelled，且 roadmap 还有 M2
- **Then** **不**置 `loopState='completed'`，不写「全部完成」报告
- **And** M1 周期置 `done`，触发下一周期推进

### 场景二：周期验收门

- **Given** M1 全部任务 done/cancelled
- **Then** 周期验收通过（口径以规格为准：该周期任务全 done/cancelled，可含门绿/CI 汇总）
- **And** 生成该周期完成小结（并入 `<stateDir>/completion.md` 或独立周期报告，以规格为准）

### 场景三：自动规划下一期（无人值守）

- **Given** `cycles.autoAdvance: true` 且 roadmap 存在下一期
- **When** M1 验收通过
- **Then** 组长（leader）读取 roadmap 自动 `cycle_plan` 生成 M2 契约并落盘
- **And** 若 M2 规划失败（无 roadmap / roadmap 无下一期 / 契约校验不过），**不静默空转**：按规格升级或问卷，绝不假装无事继续轮询
- **When** roadmap 已无下一期
- **Then** 置 `loopState='completed'`，写完成报告（含各周期汇总）

### 场景四：周期边界的人工检查点

- **Given** `cycles.autoAdvance: false`
- **When** M1 验收通过
- **Then** 落一张问卷等人点头，答完才规划 M2（interactive 真 await / async 落 open 问卷，以规格为准）
- **And** 等待期间 `checkStuck` 不把这条等待误判成任务卡死 —— 周期等待是正常等待，不是故障

### 场景五：守护与升级

- **Then** `daemon.ts`（`src/service/daemon.ts`）新增/调整纯判定，使「周期完成但下一期未排/未批」既不误伤卡死检测，也不无限静默
- **And** 新升级/问卷原因进 `src/vocab.ts` 的枚举唯一清单，且只在服务端真会产出时新增（`ESCALATION_REASONS` / `QUESTIONNAIRE_KINDS`）

### 场景六：文档与校验

- **Then** README「无人值守主循环」补周期推进描述；升级触发清单若新增原因一并更新
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿

## 超出范围

- 周期内子里程碑/更细粒度推进；跨周期部署编排的深度定制（沿用既有 `maybeDeploy` 按 merge 部署的语义，可只加周期完成的部署触发点）。
