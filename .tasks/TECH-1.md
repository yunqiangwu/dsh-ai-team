---
id: TECH-1
title: webhook 投递合并：升级与问卷收敛到 postHumanWebhook
status: pending
touches:
  - src/
  - tests/
---

# webhook 投递合并：升级与问卷收敛到 postHumanWebhook

对应设计文档 [docs/design-interaction.md](../docs/design-interaction.md) 头部注记②，与 `src/notification.ts` 中 `postHumanWebhook` 的「后续搬家工作」注释。

## 背景

webhook 给人的投递现在有两份实现：问卷侧走 `src/notification.ts` 的 `postHumanWebhook`（URL 登记进 `SecretRedactor`、`text` 过一遍 redact），升级侧走 `src/escalate.ts` 的 `EscalationManager` 私有 `deliverWebhook`（不登记 URL、不过 redact）。设计文档头部注记②声明了 M2 时刻有意没合并（不动 `escalate.ts` 的行为），`postHumanWebhook` 的注释也自认「两条路径合并是后续的搬家工作」。现在收口。

要合并的是**传输**（fetch / 10s 超时 / JSON 头 / 脱敏登记），不是载荷语义：升级侧仍 POST `{ text, escalation }`，问卷侧仍 POST `{ text, questionnaire, ticketUrl }`（带 token 的链接是问卷侧有意的凭据出口，见 AGENTS.md 安全硬规则 6）。

## 验收标准

### 场景一：只剩一份投递实现

- **Given** `src/escalate.ts` 的 `EscalationManager` 与 `src/notification.ts` 的 `postHumanWebhook`
- **Then** `EscalationManager` 的私有 `deliverWebhook` 被删除，`escalate` 内部改调 `postHumanWebhook`
- **And** 载荷形状不变：升级侧仍 POST `{ text, escalation: <record> }`，问卷侧仍 POST `{ text, questionnaire, ticketUrl }`

### 场景二：投递状态语义不变

- **When** 未配置 `escalation.webhookUrlEnv`，或投递失败 / 超时
- **Then** `record.webhookDelivered` 仍为 `false`，`escalate` 绝不抛错（投递状态是记录上的数据，不是流程开关）
- **And** `tests/test-unattended.ts` 的「escalation webhook payload is redacted and delivery failure is data」断言一字不改地通过

### 场景三：升级侧脱敏增强（有意的行为变化）

- **Then** webhook URL 本身被登记进 `SecretRedactor`（`postHumanWebhook` 现有行为；`deliverWebhook` 现状不登记，URL 带 token 的 Slack 类钩子会漏）
- **And** `text` 过一遍 redact（升级侧 text 只含枚举 reason，实际无差，但语义统一）

### 场景四：文档与注释收口

- **Then** `src/notification.ts` 中「⚠️ 升级侧仍用它自己那份 `EscalationManager.deliverWebhook`」注释删除
- **And** `docs/design-interaction.md` 头部注记②改写为「已合并（TECH-1）」

## 超出范围

- 不动问卷侧载荷语义（推送带 token 的链接是有意的凭据出口）
- 不引入 webhook 重试 / 重投队列
- 不改 `EscalationView` 形状（`stateVersion` 不动）
