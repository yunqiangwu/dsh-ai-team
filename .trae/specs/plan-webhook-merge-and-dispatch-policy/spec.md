# 规划「webhook 合并」与「优先级 × 域锁调度策略」两份任务契约 Spec

## Why

项目未完成：设计文档 [docs/design-interaction.md](../../../docs/design-interaction.md) 登记了两笔已知技术债——① 头部注记②「问卷投递的 webhook 与 `EscalationManager.deliverWebhook` 仍是两份实现」（原话：等语义分叉真的造成麻烦再收）；② §11 未决问题 #3「优先级与域锁冲突时的调度策略……现状纯按排序跳过」。需要把它们落成 `.tasks/` 契约以便后续派发实施，同时补上缺失的协作看板 `_board.md`，并修正既有契约 frontmatter 与实际进度的脱节。

## What Changes

- 新增 `.tasks/TECH-1.md`：webhook 投递两份实现合并的任务契约（frontmatter + Gherkin 验收，与既有 INT-*/PIL-* 契约同构）
- 新增 `.tasks/TECH-2.md`：优先级 × 域锁调度策略的任务契约（同上）
- 新增 `.tasks/_board.md`：无人值守协作视图，格式与 `regenerateBoard`（`src/team.ts`）的输出**字节一致**，使插件将来在本仓库跑起来时重生成不产生 diff
- 同步既有契约状态：INT-1..4、PIL-1..2 的 frontmatter `status: pending → done`（依据：设计文档头部「M0–M3 已实施」声明、README 已有「故障排查」章节、CHANGELOG.md 已按 Keep a Changelog 落地）
- 修改 `docs/design-interaction.md`：头部注记②与 §11 未决问题 #3 改为指向对应新契约（声明「已立单、未实施」）
- **不含任何源码改动**：webhook 合并与调度策略的**实现**由 TECH-1 / TECH-2 被派发后完成，本变更只交付规划物（契约、看板、文档登记）

## Impact

- Affected specs: `docs/design-interaction.md`（头部注记②、§11 未决问题清单）
- Affected code: 无（后续 TECH-1 将触及 `src/escalate.ts`、`src/notification.ts`、`tests/`；TECH-2 将触及 `src/service.ts`、`docs/design-interaction.md`、`tests/`——这些写进两张契约的 `touches`）
- 风险：`_board.md` 是手建文件，若格式与 `regenerateBoard` 输出不一致，插件接管本仓库后会 churn；本规格用「字节一致」验收消除该风险

## ADDED Requirements

### Requirement: 任务契约 TECH-1（webhook 投递两份实现合并）

系统 SHALL 提供一份 `.tasks/TECH-1.md` 契约（id: `TECH-1`，status: `pending`，touches: `src/`、`tests/`），其验收标准包含以下场景：

#### Scenario: 只剩一份投递实现
- **Given** `src/escalate.ts` 的 `EscalationManager` 与 `src/notification.ts` 的 `postHumanWebhook`
- **Then** `EscalationManager` 的私有 `deliverWebhook` 被删除，`escalate` 内部改调 `postHumanWebhook`
- **And** 载荷形状不变：升级侧仍 POST `{ text, escalation: <record> }`，问卷侧仍 POST `{ text, questionnaire, ticketUrl }`——合并的是**传输**（fetch / 10s 超时 / JSON 头 / 脱敏登记），不是两边的载荷语义

#### Scenario: 投递状态语义不变
- **When** 未配置 `escalation.webhookUrlEnv`，或投递失败 / 超时
- **Then** `record.webhookDelivered` 仍为 `false`，`escalate` 绝不抛错（投递状态是记录上的数据，不是流程开关）
- **And** `tests/test-unattended.ts` 的「escalation webhook payload is redacted and delivery failure is data」断言一字不改地通过

#### Scenario: 升级侧脱敏增强（有意的行为变化）
- **Then** webhook URL 本身被登记进 `SecretRedactor`（`postHumanWebhook` 现有行为；`deliverWebhook` 现状不登记，URL 带 token 的 Slack 类钩子会漏）
- **And** `text` 过一遍 redact（升级侧 text 只含枚举 reason，实际无差，但语义统一）

#### Scenario: 文档与注释收口
- **Then** `src/notification.ts` 中「⚠️ 升级侧仍用它自己那份 `EscalationManager.deliverWebhook`」注释删除
- **And** `docs/design-interaction.md` 头部注记②改写为「已合并（TECH-1）」

### Requirement: 任务契约 TECH-2（优先级 × 域锁调度策略）

系统 SHALL 提供一份 `.tasks/TECH-2.md` 契约（id: `TECH-2`，status: `pending`，touches: `src/`、`tests/`、`docs/`），明确并实现以下策略——**域锁推迟但不空转，跳过必须可见**：

#### Scenario: 高优先级被域锁时派别的（把现状锁成契约）
- **Given** 任务 H（priority 高，touches `src/`）被在途任务锁定，任务 L（priority 低，touches `docs/`）就绪且无锁
- **When** 守护循环跑一拍 `dispatch`
- **Then** H 保持 `pending`（等待，不升级、不改状态），L 被正常派发
- **And** 不引入配置开关——固定策略，不加「严格优先级」模式（防过度设计）

#### Scenario: 跳过不再静默
- **When** 一个候选因 `touchesOverlap` 被跳过
- **Then** `report.events` 出现 `deferred-domain-lock:<taskId>` 条目（对齐既有 `blocked-dependency:<id>` / `dispatched:<id>` 的事件命名风格）
- **And** 事件只进 `TickReport.events`，不新增 `EscalationReason`、不进升级直方图（被域锁推迟是正常等待，不是故障）

#### Scenario: 策略写进文档
- **Then** `docs/design-interaction.md` §11 未决问题 #3 结案：写明「域锁推迟但不空转 + 跳过可见」，并在 §6.2 附近补一段派发顺序与域锁交互的口径（依赖未满足永远排在后面；域锁跳过但出声）

#### Scenario: 既有行为回归不变
- **And** 依赖未满足 / 跨域 / 禁区 / 阶段门四类检查的行为与事件不变，`tests/test-unattended.ts` 既有派发分支全绿

### Requirement: 任务看板（无人值守协作视图）

系统 SHALL 在 `.tasks/_board.md` 提供协作看板：

- **Given** 8 张契约（INT-1..4、PIL-1..2 置于 done，TECH-1、TECH-2 置于 pending）
- **Then** 文件内容与 `regenerateBoard` 对同一契约集合的输出**逐字节一致**：标题行 `# 任务看板（自动生成，勿手改）`、`| id | title | status | owner | depends_on | touches |` 状态表（按 id 字典序）、`## 阻塞清单`（`(none)`）、`## 已废弃`（`(none)`）
- **And** 不含时间戳（字节稳定性的既有约定）

### Requirement: 既有契约状态与现实对齐

- **Then** INT-1..4、PIL-1..2 六张契约的 frontmatter `status` 由 `pending` 改为 `done`，其余 frontmatter 字段与正文一字不动
- **And** 只改 `status:` 这一行（`patchTaskContract` 的 `setFrontmatterKey` 语义）

## MODIFIED Requirements

### Requirement: 设计文档技术债登记（docs/design-interaction.md）

头部注记②与 §11 未决问题 #3 从「有意未做 / 未决」改为「已立契约、未实施」：

- 注记②末尾追加指向 `.tasks/TECH-1.md` 的相对链接
- §11 第 3 条改写为：策略已定（域锁推迟但不空转 + 跳过可见），实施由 `.tasks/TECH-2.md` 承载
- **不**改动注记①（`_board.md` 无「等人回答」列——那仍是现状，TECH-2 也不改它）

## REMOVED Requirements

（无）
