---
id: INT-4
title: M3 重规划：cancelled / 优先级 / 分级变更与在途任务处置
status: pending
depends_on: [INT-1]
touches:
  - src/
  - tests/
  - README.md
---

# M3 重规划：cancelled / 优先级 / 分级变更与在途任务处置

对应设计文档 [docs/design-interaction.md](../docs/design-interaction.md) §9 里程碑 M3、§6。

## 背景

开发过程中用户会改需求或加功能，组长需要重排优先级、修改或撤销任务。当前支撑为零：`src/` 全仓库无 `priority` / `deleteTask` / `removeTask` 任何命中，派发纯按插入顺序（`src/service.ts:1009` 的 `team.tasks.push`），`TASK_STATUSES`（`src/vocab.ts:31-39`）没有废弃态。而目标仓库的 `.tasks/README.md` §3 早已确立正确约定：用 `cancelled`，**文件保留不删**，保持可追溯。

## 验收标准

### 场景一：废弃不是删除

- **Given** 一张尚未派发的 `pending` 契约
- **When** 组长 `task_cancel`
- **Then** `status` 变 `cancelled`，**契约文件仍在 `.tasks/` 且仍在 git 历史里**
- **And** `.tasks/_board.md` 新增列/分区呈现废弃项（现状只列 `needs-human`，`src/team.ts:146`）
- **And** `doneContracts` 不再把它当前置，也不再让它无限阻塞下游：M0 落地的判定在 `escalateBlockedDependency`（`src/service.ts`），当前只把「前置在看板上不存在」与「前置 `needs-human`」判死，`cancelled` **必须显式加进这个判定**，否则废弃态会退回到 §6.4 描述的静默阻塞

### 场景二：变更分级，不是每个小改动都发邮件

- **Given** 组长按 §6.2 表操作
- **When** 变更属于"新增 pending 任务 / 调 `priority` / 取消未派发的 pending"
- **Then** 组长自主完成，**不产生升级、不发通知**
- **When** 变更触及已合并代码、改 PRD 验收数值、或动禁区
- **Then** 强制走 `kind: 'replan'` 问卷，人批之前不落盘
- **And** 越级直接改验收数值的路径不存在（有测试证明它会被拒）

### 场景三：在途任务三种处置，分支不白丢

- **Given** 一张 `in_progress` 任务被需求变更波及
- **When** 组长选 `supersede`
- **Then** 原任务照原样合入，自动派生一张修正任务，且**原任务分支保留**
- **When** 选 `continue + followup`
- **Then** 原任务不受影响，增量落到新契约
- **When** 选 `abort`
- **Then** 必须人批准才丢分支，否则拒绝
- **And** 三者都通过 `releaseMemberWorkspace`（`src/service.ts:734`，已被澄清/合入/升级三处复用）退场，新增的是入口工具而非第四套机制

### 场景四：优先级不越过依赖

- **Given** 任务 X `priority` 高于 Y，但 X 的 `depends_on` 未满足、Y 已满足
- **When** 派发
- **Then** 先派 Y
- **And** X 与 Y 依赖条件相同时才按 `priority` 排序，`priority` 相同时保持既有插入顺序（不引入随机序）

### 场景五：重规划不许无限重排，也不许续命

- **Then** 单位时间 `replan_*` 调用超 `replan.maxPerHour` 即拒绝并说明原因
- **And** 重规划**不重置** `maxTaskHours` 计时——墙钟预算是唯一可靠的烧钱护栏，重置等于开了无限续命的口子
- **And** PRD `version` 递增并留下变更日志段，任务单引用形如 `PRD §2.3@v1.7`

### 场景六：文档与测试

- **Then** `README.md` 补「需求变更与重规划」小节：分级表、三种处置、`cancelled` 保留文件的约定、replan 频率上限的语义
- **And** `test-unattended.ts` 的重规划分支覆盖场景一/二/四/五
- **And** 新枚举值已连带 `src/client/index.tsx` 的 **zh 与 en** 字典
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿

## 超出范围

- 需求变更的历史可视化与 diff 回放（只保证可 diff，不保证好看）。
- 自动推断"这次变更影响了哪些在途任务"——仍由组长显式声明，插件只负责拒绝越权。
