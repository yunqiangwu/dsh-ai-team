---
id: CYC-1
title: 周期实体：CycleRecord / 契约 cycle 字段 / 看板分组
status: pending
priority: 9
depends_on: [CYC-0]
touches:
  - src/service/state.ts
  - src/team.ts
  - src/vocab.ts
  - src/schema.ts
---

# 周期实体：CycleRecord / 契约 cycle 字段 / 看板分组

对应设计文档 [docs/design-cycles.md](../docs/design-cycles.md)。

## 背景

任务契约（`src/team.ts` 的 `TaskContract`）目前只有 `id/title/status/owner/depends_on/touches/forbidden/priority`，没有周期归属；`TeamRecord`（`src/service/state.ts`）也没有周期列表。多周期开发的第一步是给「周期」一个一等公民的数据形状，并把契约挂到周期上。

## 验收标准

### 场景一：CycleRecord 数据结构

- **Given** 新周期被创建
- **Then** `TeamRecord` 增加可选 `cycles` 数组（老 state.json 无该字段，`load()` 一律 `?? []` 兜底，兼容约定不破）
- **And** CycleRecord 含：`id`、`name`（如 "M1"）、`status`（枚举如 `planned` / `in_progress` / `in_review` / `done`）、`goal`、`scope`、`taskIds`、`startedAt`、`completedAt`
- **And** 周期状态枚举进 `src/vocab.ts` 的 `as const` 数组（唯一清单），schema 由它构造 zod enum，下游只读这一份

### 场景二：契约可声明周期

- **Given** 组长写契约 frontmatter `cycle: M1`
- **Then** `parseTaskContract`（`src/team.ts`）解析出 `cycle` 字段（可选，缺省 null）
- **And** `patchTaskContract` 支持就地改 `cycle`，逐字节保留其余 frontmatter 行
- **And** 无 `cycle` 字段的契约行为不变（老团队兼容）

### 场景三：看板按周期分组

- **Then** `regenerateBoard`（`src/team.ts`）输出按周期分组：先列周期头（name + 进度）再列其任务，无周期契约归「未排期」区
- **And** `.tasks/_board.md` 仍不含时间戳（不弄脏 worktree）

### 场景四：schema 与视图类型

- **Then** `CycleView` 由 `src/schema.ts` 的 `z.infer` 派生，**不手写第二份视图类型**
- **And** `stateVersion` +1（连带改 `src/projection.ts` 与面板渲染见 CYC-5）
- **And** 投影携带完整 `CycleView` 快照（last-write-wins 折叠，不做增量合并）

### 场景五：文档与校验

- **Then** 新增/修改的面向人枚举取值已连带 `src/client` 字典 **zh 与 en 同时加**
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿（顺序见 AGENTS.md「测试约定」）

## 超出范围

- 周期状态推进与验收逻辑（归 CYC-3）；roadmap 与周期规划工具（归 CYC-2）；周期视图/面板渲染（归 CYC-5）。
