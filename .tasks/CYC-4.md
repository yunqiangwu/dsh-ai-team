---
id: CYC-4
title: 周期上下文注入与枚举/守护增强
status: done
priority: 5
depends_on: [CYC-2, CYC-7]
touches:
  - src/service/description.ts
  - src/vocab.ts
  - src/service/options.ts
---

# 周期上下文注入与枚举/守护增强

对应设计文档 [docs/design-cycles.md](../docs/design-cycles.md)。

## 背景

开发者接手任务时，`buildDescription`（`src/service/description.ts`）注入的是正文 → 教训 → 所有权，**不知道这个任务属于哪个周期、周期的目标是什么**。多周期开发里，周期目标让单个任务「为什么现在做、边界在哪」清晰可见；同时新机制需要新的枚举值（周期状态、可能的升级/问卷原因）与守护判定。

## 验收标准

### 场景一：周期上下文进任务描述

- **Given** 一张带 `cycle` 的任务被派发
- **Then** `buildDescription` 注入所属周期的目标与范围（有界，受 `DESCRIPTION_TOTAL_LIMIT` 约束）
- **And** 注入段遵循既有预算倒排：所有权段永不裁，周期上下文优先级高于教训/正文（裁剪顺序以规格为准，可验证）

### 场景二：周期状态枚举与守护判定

- **Then** 周期状态枚举（CYC-1 引入）被 `checkStuck` / 周期推进正确读取，等待审批/规划的周期不误判卡死
- **And** `src/service/options.ts` 的 `AutopilotOptions` 透出周期相关配置（`roadmapPath`）与 `checkpoint` 决策状态，读取处 `?? 默认值` 兜底老配置
- **And** 新增面向人的枚举取值连带 zh/en 字典

### 场景三：文档与校验

- **Then** 若新增 `EscalationReason` / `QuestionnaireKind`，确认服务端真会产出后才加（避免给模型多一个错选项）
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿

## 超出范围

- 周期视图/面板（归 CYC-5）；周期推进闭环（归 CYC-3）。
