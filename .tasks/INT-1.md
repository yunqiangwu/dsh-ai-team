---
id: INT-1
title: M0 先修：phase 维度与三个既有缺陷
status: done
touches:
  - src/
  - tests/
---

# M0 先修：phase 维度与三个既有缺陷

对应设计文档 [docs/design-interaction.md](../docs/design-interaction.md) §9 里程碑 M0、§2、§6.4、§7.1-3。

## 背景

M1 之后的一切交互都建立在这个维度上，而当前有三个洞会让"文档先行"的流程静默失效：

1. 没有 `phase` 维度，`dispatch` 见着 `pending` 就派（`src/service.ts:1979`）——PRD 还没等人确认任务就发出去了；
2. 依赖不满足时静默 `continue`，前置为 `cancelled` 或永久 `needs-human` 会让下游无限不派发且不报错（`src/service.ts:1972-1974`）；
3. 工单答卷提交后不发投影事件（`src/service.ts:282` 只有 `this.changed()`，`service.onChange` 无人订阅），面板要等下一次工具调用才刷新；
4. 契约解析失败被 `.catch(() => [])` 吞掉，一个 frontmatter 写坏的 `.tasks/*.md` 会清空整块看板（`src/service.ts:1898`、`src/service.ts:1062` 注释自认）。

## 验收标准

### 场景一：phase 成为一等维度

- **Given** 团队状态与投影
- **Then** 存在 `phase` 字段，取值 `intake | kickoff_pending_approval | scaffolding | developing | replanning`
- **And** `phase` 定义在 `src/vocab.ts` 的 `as const` 数组，形状由 `src/schema.ts` 的 zod 派生，`view.ts` 只做类型 re-export（架构铁律 5：不得有值导入）
- **And** `phase` 随 `<stateDir>/state.json` 持久化，崩溃恢复时不降级
- **And** `src/projection.ts` 的 `stateVersion` 由 5 递增到 6

### 场景二：非开发阶段绝不派发

- **Given** 一个 team 处于 `kickoff_pending_approval`，且其下存在 `depends_on` 全满足、`touches` 无锁冲突的 `pending` 任务
- **When** 守护循环跑一拍
- **Then** `dispatch` 直接返回，`report.events` 不含任何 `dispatched:` 事件
- **And** `phase` 为 `developing` 或 `replanning` 时派发行为与改动前完全一致（回归不变）

### 场景三：不可满足的依赖会喊出来

- **Given** 任务 B `depends_on: [A]`
- **When** A 处于 `cancelled` 或持续 `needs-human`，循环跑到 B
- **Then** B 被升级，原因为新增的 `blocked-dependency`，`report.events` 含对应条目
- **And** 循环不会因"永远凑不齐全部 done"而无限空转降频

### 场景四：答卷即刻刷新

- **When** 通过工单端点提交一次答复
- **Then** 立即产生一条 `autopilot/update` 事件，投影里的升级记录带回答复内容
- **And** 无需等待下一次工具调用

### 场景五：坏契约不再清空看板

- **Given** `.tasks/` 下 3 个合法契约与 1 个 frontmatter 缺失的坏文件
- **When** 循环收养契约
- **Then** 3 个合法契约正常收养，坏文件被跳过并计入 `report.events`（可见的告警）
- **And** 看板不被清空

### 场景六：连带改动齐备

- **Then** 新增 `EscalationReason: blocked-dependency` 已同步 `src/vocab.ts` 与 `src/client/index.tsx` 的 **zh 与 en** 字典（`reason.*`）
- **And** 面板渲染 `projection.blocked`（现状该字段全仓库零消费者，从未被渲染）
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 四条全绿，0 error / 0 warning

## 前置条件（喂单前必须处理）

- 本仓库 `src/` 是扁平布局，而 `distinctDomainCount` 按前缀折叠计域（`src/profile.ts:373`）：把 `touches` 写成逐个源文件时，**任何 4 文件的改动都会在首拍被 `escalateCrossDomain` 自动升级成 `cross-domain`**（`src/service.ts:2023-2035`，默认阈值 3）。故本批 4 张契约一律用目录粒度。
- `pilot.patch.yml` 建议同时设 `profile.crossDomainThreshold: 6`，否则后续按文件粒度拆细的契约无法派发。

## 超出范围

- 任何新工具（`ask_human` / `doc_write` / `contract_create`）——属 M1。
- 问卷实体与工单解耦——属 M1。
- 面板内的交互式问卷卡片——属 M2。
