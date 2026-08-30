---
id: CYC-6
title: 多周期测试与 README 收尾
status: pending
priority: 1
depends_on: [CYC-3, CYC-4, CYC-5]
touches:
  - tests/
  - README.md
---

# 多周期测试与 README 收尾

对应设计文档 [docs/design-cycles.md](../docs/design-cycles.md)。

## 背景

新机制必须有一套完整测试钉住「多周期增量开发 + 无人值守闭环」的行为，README 要成为使用者入口（多周期怎么配、怎么用）。设计文档的「提案」状态随之转「已实施」。

## 验收标准

### 场景一：周期生命周期测试

- **Given** 新增 `tests/test-cycles.ts`（或并入现有测试文件，以规格为准）
- **Then** 覆盖：周期创建（`cycle_plan` 只拆下一期、不拆远期）、契约 `cycle` 字段解析/回写、看板分组、派发只收窄当前周期、周期完成后自动推进下一期、无下一期时 `completed`
- **And** 覆盖：`requireApproval` 开关（人批 vs 无人值守）、`autoAdvance` 开关、等待下一期规划/审批时不被误判卡死
- **And** 覆盖：老团队（无 `cycle` 字段契约）行为不回归（沿用 `testOptions` 工厂）
- **And** 断言优先用 `AutopilotOptions` 工厂 `testOptions(fixture, overrides)`，别手搓配置对象

### 场景二：README

- **Then** README 新增「多周期开发与无人值守闭环」小节：周期怎么配、roadmap 怎么写、`cycle_plan` / `cycle_approve` 怎么用、`autoAdvance` / `requireApproval` 语义
- **And** README「工具一览」补新工具
- **And** `docs/design-cycles.md` 状态改「已实施」

### 场景三：全量校验

- **Then** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 按顺序全绿
- **And** `tests/smoke-cordis.ts` 注册工具名清单已同步（新增 tool 时）

## 超出范围

- 生产环境真实多周期试点跑测（留给 PILOT 流程，不属于本任务）。
