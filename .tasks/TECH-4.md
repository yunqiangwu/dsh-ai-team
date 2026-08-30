---
id: TECH-4
title: 多团队投影一致性：escalations / deploys 补 teamId，面板按当前团队过滤
status: done
touches:
  - src/
  - tests/
  - docs/
---

# 多团队投影一致性：escalations / deploys 补 teamId，面板按当前团队过滤

对应设计文档 [docs/design-interaction.md](../docs/design-interaction.md) §11 未决问题 #4。

## 验证结论（§11 #4 的答案）

1. **phase 是 team 级 ✓，与 `activeTeamId` 渲染假设一致 ✓**：`teamViewSchema` 带 phase，面板按 `activeTeamId`（缺省回退第一个团队）选单团队渲染其 phase、members、tasks、questionnaires（后两者按 `teamId` 过滤）。这一半没有问题。
2. **`activeTeamId` 的语义是「最后变更的团队」**（`changed(teamId)` 抢占式更新）：多团队并行时面板会跟着最近活跃的团队走。这是合理的产品决策（无人值守下人关心最近在动的那个），**保持不变**，只在文档写明。
3. **真缺口：`EscalationView` / `DeployView` 没有 `teamId`**。两条数组是 service 级全局的，面板的单团队视图里，升级流、部署历史与摘要计数却是**全部团队混显**——多团队时口径与 members/tasks/questionnaires 不一致，人看到别的团队的升级却不知道是谁的。

## 修法（最小外科）

1. `schema.ts`：`escalationViewSchema` / `deployViewSchema` 加 `teamId: zod.string().nullable().default(null)`。nullable 兼容旧持久化记录（restore 无此字段）；连带 `projection.ts` 的 `stateVersion` 7 → 8。
2. `escalate.ts`：`EscalationInput` 加 `teamId: string | null`，记录落 `input.teamId`。
3. `service.ts`：13 处 `escalateTask` 调用点全部显式传 `teamId: team.id`（都持有 team 上下文）；`deployRun` 落 `teamId: team.id`。不搞内部推断兜底——归属猜错比多写一行更贵。
4. 面板 `AutopilotPanel.tsx`：摘要计数 / `EscalationFeed` / `DeployHistory` 三处按 `teamId === null || teamId === team.id` 过滤。**null 也显示**：升级与部署是全局信号，归属不明的旧记录宁可多显示，不能被过滤吞掉。
5. 测试：多团队下各自升级，记录 teamId 各归各、互不串。

## 验收标准

### 场景一：升级记录归属各自的团队

- **Given** 同一 service 建两个团队 A、B，分别触发一次升级（A 的 task-stuck、B 的 budget-exceeded）
- **When** 读取 `service.escalations.all`
- **Then** 两条记录的 `teamId` 分别为 A、B 的 id；投影里同样携带

### 场景二：部署记录归属触发的团队

- **Given** 团队 A 执行 `deployRun`
- **Then** `projection.deploys` 里该记录 `teamId` 为 A 的 id

### 场景三：既有行为不回归

- **Then** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿；现有对 `escalations` 的断言（按 reason / resolvedAt 访问）不需修改即通过

### 场景四：文档与连带收口

- **Then** design-interaction.md §11 #4 结案（phase 一致、activeTeamId 语义写明、混显缺口已修）；CHANGELOG 补条目；面板无需新文案（纯过滤）

## 超出范围

- **不做团队切换器**：面板仍是单团队视图（activeTeamId 语义），多团队切换 UI 是产品决策，不是本契约的验证范围。
- **不动 `loopState` 的全局语义**：整个 service 一个循环状态是多团队共享的另一个既定事实，改它牵扯循环架构，与渲染一致性无关。
