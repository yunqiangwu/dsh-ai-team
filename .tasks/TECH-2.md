---
id: TECH-2
title: 优先级 × 域锁调度策略：域锁推迟但不空转、跳过可见
status: done
touches:
  - src/
  - tests/
  - docs/
---

# 优先级 × 域锁调度策略：域锁推迟但不空转、跳过可见

对应设计文档 [docs/design-interaction.md](../docs/design-interaction.md) §11 未决问题 #3、§6.2。

## 背景

`dispatch`（`src/service.ts`）现状：候选按 `priority` 降序做稳定排序（`toSorted`），`touches` 与在途任务重叠的候选被静默 `continue`。高优先级任务被域锁时，行为上等于「等锁、先派别的」，但这个策略既没写进文档也没留下任何痕迹——面板与 `autopilot_status` 都看不出一张高优契约为什么一直没被派发。

## 策略（本契约把它定死）

**域锁推迟但不空转，跳过必须可见**：

1. 被锁候选保持 `pending`——那是正常等待，不是故障：不升级、不进升级直方图、不新增 `EscalationReason`；
2. 派发继续走锁外的下一候选——吞吐优先，不让空闲开发者干等一个被锁的域；
3. 每次因域锁跳过一个候选，`report.events` 记一条 `deferred-domain-lock:<taskId>`（对齐既有 `blocked-dependency:<id>` / `dispatched:<id>` 的事件命名风格）。

## 验收标准

### 场景一：高优先级被域锁时派别的（把现状锁成契约）

- **Given** 任务 H（`priority` 高，`touches: [src/]`）被在途任务锁定，任务 L（`priority` 低，`touches: [docs/]`）就绪且无锁
- **When** 守护循环跑一拍 `dispatch`
- **Then** H 保持 `pending`（等待，不升级、不改状态），L 被正常派发
- **And** 不引入配置开关——固定策略

### 场景二：跳过不再静默

- **When** 一个候选因 `touchesOverlap` 被跳过
- **Then** `report.events` 出现 `deferred-domain-lock:<taskId>` 条目
- **And** 事件只进 `TickReport.events`，不产生升级记录、不触发通知

### 场景三：策略写进文档

- **Then** `docs/design-interaction.md` §11 未决问题 #3 结案：写明「域锁推迟但不空转 + 跳过可见」
- **And** §6.2 附近补一段派发顺序与域锁交互的口径：依赖未满足的候选永远排在后面；域锁跳过但出声

### 场景四：既有行为回归不变

- **And** 依赖未满足 / 跨域 / 禁区 / 阶段门四类检查的行为与事件不变
- **And** `tests/test-unattended.ts` 既有派发分支全绿，新增断言覆盖场景一、二

## 超出范围

- 不加调度策略配置开关、不引入「严格优先级」模式（空闲开发者干等被锁的域，对无人值守团队是净损失）
- 不改 `touchesOverlap` 判定本身
- `_board.md` 不加「等人回答」列（设计文档头部注记①的口径不变）
