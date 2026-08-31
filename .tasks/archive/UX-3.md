---
id: UX-3
title: UX 优化第二轮：停摆引导 / 浮窗无障碍 / 团队切换反馈 / 过滤复位（P1）
status: done
owner: leader-1
depends_on: [UX-2]
touches:
  - src/client/AutopilotPanel.tsx
  - src/client/dict.ts
  - src/client/styles.ts
---

# UX 优化第二轮（P1）

第一轮（UX-2，12 项）完成后通读 `AutopilotPanel` 发现的新一批 P1 缺口。这批随
v1.7.0 一起发布（版本号未动，仍 1.7.0，已并入 CHANGELOG）。每做完一项更新下方
todolist 并单独提交一次。

## 任务清单（todolist）

- [x] P1-A 停摆/未启动空状态引导：stopped / paused 时说明「怎么把循环跑起来」
- [x] P1-B 浮窗可访问性闭环：`role="dialog"` + Esc 关闭 + 焦点移入/恢复 + ✕ 标签
- [x] P1-C 团队切换失败反馈：网络/非 2xx 不再静默弹回，给可见提示
- [x] P1-D 看板过滤一键清除：有效过滤态提供「清除过滤」复位，不必逐项手清

## 验收标准

### 场景一：停摆引导

- **Given** loopState 为 `stopped`（从未跑）或 `paused`（暂停/崩溃恢复）
- **Then** 面板在主体顶部显示空状态提示（复用 PhaseGuide 的视觉模式）
- **And** stopped 提示「在 leader 会话里调 `autopilot_run` 启动」；paused 提示
  「`autopilot_resume` 恢复」
- **And** running/completed/escalated 不显示该提示；zh / en 字典同步

### 场景二：浮窗无障碍

- **Given** 点击统计卡弹出详情浮窗
- **Then** 浮窗带 `role="dialog"` + `aria-modal="true"`，✕ 按钮带 `aria-label`
- **And** 打开时焦点移入浮窗，`Esc` 关闭并恢复触发按钮焦点
- **And** 面板/看板原有键盘导航不受影响（回归由既有 P3-3 行为覆盖）

### 场景三：团队切换反馈

- **Given** 多团队时切换团队，请求失败（网络 / 非 200）
- **Then** 不再静默弹回原值，给一句可见的失败提示
- **And** 成功后无多余噪音；zh / en 字典同步

### 场景四：过滤复位

- **Given** 看板按关键字/成员/周期过滤，且有过滤生效
- **Then** 工具栏显示「清除过滤」按钮，一键复位三个条件
- **And** 无条件生效时不显示该按钮；`noMatch` 空态与过滤提示不回归

## 超出范围

- async 问卷的宿主写入口（回会话点「继续」）仍需宿主配合，沿用 UX-2 的排期口径
- 浮窗自绘 focus trap（`Tab` 循环）与可滚动容器内的角色导航 —— 本次只做
  Esc + 焦点移入/恢复 + 对话框语义的最小闭环