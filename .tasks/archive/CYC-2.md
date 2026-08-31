---
id: CYC-2
title: 增量规划：roadmap / cycle_plan / cycle_approve 与派发收窄
status: done
priority: 8
depends_on: [CYC-0, CYC-1]
touches:
  - src/service.ts
  - src/tools.ts
  - src/vocab.ts
---

# 增量规划：roadmap / cycle_plan / cycle_approve 与派发收窄

对应设计文档 [docs/design-cycles.md](../docs/design-cycles.md)。

## 背景

「完成一期再规划下一期」需要一个长期计划（roadmap）和一个「把 roadmap 的下一期拆成任务契约」的工具。当前组长只能 `contract_create` 直接造契约，没有周期层级的规划入口；更关键的是，一旦未来周期的契约被写进 `.tasks/`，`dispatch`（`src/service.ts`）会照常把它们派出去，破坏增量节奏 —— 「只派当前周期」是必须显式实现的不变量。

## 验收标准

### 场景一：roadmap 文档承载长期计划

- **Given** 配置了 roadmap 路径（如 `cycles.roadmapPath`，默认如 `docs/ROADMAP.md`）
- **Then** 走既有文档先行的 draft→accept 审批链（`doc_write` / `doc_approve`），正式区才有资格被周期规划引用
- **And** roadmap 含各周期的目标与范围，是「下一期拆哪些任务」的唯一依据

### 场景二：cycle_plan 只拆下一期

- **Given** 当前周期（或首个周期）尚未排期
- **When** 组长调 `cycle_plan`，给定 roadmap 的下一期（如 M2）
- **Then** 生成一张周期记录（status `planned`）+ 该周期内的一组 pending 契约（带 `cycle:` 字段）
- **And** **不会**同时生成更远期周期的任务 —— 增量规划的核心不变量：只排下一期
- **And** 写前校验复用 `contract_create` 的既有校验（id / 悬空依赖 / 成环 / 禁区 / 域数）

### 场景三：周期开工审批可配置

- **Given** 配置 `cycles.requireApproval: true`（默认以规格为准）
- **When** 周期从 `planned` 转 `in_progress`
- **Then** 走问卷（复用 `approval` 或新增 `cycle` kind，以规格为准），人批之前不落盘
- **When** `requireApproval: false`（无人值守）
- **Then** 周期自动开工，不惊动人

### 场景四：派发只收窄当前周期

- **Given** 契约带 `cycle: M3` 而当前活跃周期是 M2
- **Then** `dispatch` **不派发** M3 的任务（保持 pending，静默等待，不产生事件刷屏）
- **And** 无任何周期记录的团队，无 `cycle` 字段的契约维持现状（不回归）
- **And** 有周期记录后，无 `cycle` 字段的契约归入当前周期或「未排期」按规格处置

### 场景五：文档与校验

- **Then** README「配置」补周期相关字段语义（`cycles.roadmapPath` / `requireApproval` 等）
- **And** 新工具注册进 `src/tools.ts` 的 `publish`，并同步 `tests/smoke-cordis.ts` 的注册工具名清单（整条锁死，漏了 `pnpm test` 红在这）
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿

## 超出范围

- 周期完成后的自动推进（归 CYC-3）；周期上下文注入任务描述（归 CYC-4）。
