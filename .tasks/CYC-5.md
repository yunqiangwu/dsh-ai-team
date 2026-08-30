---
id: CYC-5
title: 周期视图、面板与 i18n
status: done
priority: 7
depends_on: [CYC-1]
touches:
  - src/schema.ts
  - src/projection.ts
  - src/client/
---

# 周期视图、面板与 i18n

对应设计文档 [docs/design-cycles.md](../docs/design-cycles.md)。

## 背景

M0-M3 的面板（`src/client/AutopilotPanel.tsx`）只展示扁平任务看板。多周期后，用户需要一眼看到：有哪些周期、当前在哪个周期、每周期进度、周期状态。

## 验收标准

### 场景一：投影携带周期快照

- **Given** 团队有周期记录
- **Then** `autopilot/update` 投影携带完整 `CycleView`（CYC-1 定义的形状），last-write-wins 折叠
- **And** `stateVersion` 已 +1（CYC-1 完成）

### 场景二：面板周期视图

- **Then** 面板新增周期区：周期列表（name / status / 进度）、当前活跃周期高亮、每周期内任务分组展示
- **And** 无周期记录的旧团队仍显示现有扁平看板（不回归）

### 场景三：i18n

- **Then** 新增面向人的取值（周期状态等）在 `src/client` 字典 **zh 与 en 同时加**（`en: Record<keyof typeof zh, string>` 强制补齐）
- **And** 面板不内联任何 `node:` 依赖（`view.ts` 浏览器安全铁律不破；`src/client` 产物不得含 zod / `node:` require）

### 场景四：文档与校验

- **Then** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿（build 在 test 前，`tests/smoke-cordis.ts` 跑的是 `lib/` 产物）

## 超出范围

- 周期甘特/时间线等复杂可视化（本期只要列表 + 进度）。
