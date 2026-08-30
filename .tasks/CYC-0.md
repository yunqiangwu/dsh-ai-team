---
id: CYC-0
title: 多周期开发与无人值守闭环：设计文档
status: pending
priority: 10
depends_on: []
touches:
  - docs/
---

# 多周期开发与无人值守闭环：设计文档

## 背景

目标：把「大型项目拆多周期、每周期多任务、完成一期再规划下一期、无人值守闭环」做成插件的原生能力。当前插件以**单一批次**看待全部契约：任务扁平、无周期分组；`checkCompletion`（`src/service.ts`）在所有任务 done/cancelled 时置全局 `loopState='completed'` 停机，没有「当前周期完成 → 规划下一周期 → 继续」的推进机制。要支撑多周期增量开发，必须先落一份规格，后续实现任务都引用它。

## 验收标准

### 场景一：文档落地

- **Given** 本任务完成
- **Then** 新增 `docs/design-cycles.md`，状态标「提案」（docs-first，待 CYC-1..6 实施后再改「已实施」）
- **And** 文档覆盖：周期实体与状态机、契约 `cycle:` 字段、roadmap 文档约定、增量规划流程（完成一期 → 规划下一期）、周期验收门、无人值守推进闭环、新增升级/问卷原因、配置字段、兼容策略（无 `cycle:` 字段的旧团队行为不变）
- **And** 文档按符号名引用现有实现（`TeamRecord` / `TaskRecord` / `checkCompletion` / `buildDescription` / `tickOnce` / `cycle_plan`），不引裸行号

### 场景二：一处事实一处写

- **Then** 面向使用者的配置语义写入 README「配置」，docs 只服务读源码的人
- **And** 新文档放 `docs/`，按命名规范小写 kebab-case

## 超出范围

- 周期内任务的具体拆解算法（本任务只定机制；拆解由 `cycle_plan` + 组长完成）。
