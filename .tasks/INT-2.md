---
id: INT-2
title: M1 能问能写：问卷实体与五个新工具
status: pending
depends_on: [INT-1]
touches:
  - src/
  - tests/
---

# M1 能问能写：问卷实体与五个新工具

对应设计文档 [DESIGN-INTERACTION.md](../DESIGN-INTERACTION.md) §9 里程碑 M1、§3、§4。

## 背景

当前组长面对"模糊需求"没有任何合法动作：工单被写死成 escalation 的附件（`renderTicket` 未命中 escalation 即返回 `null`，`src/service.ts:235-236`），字段硬编码成 `decision` + `note`（`src/service.ts:237-250`）；没有任何工具能创建 `.tasks/*.md`；而 `src/roles.ts:44-45` 明令禁止组长写 `docs/`。于是"文档先行"在工具面上一个入口都没有。

## 验收标准

### 场景一：questionnaire 是独立实体，不是升级的附件

- **Then** 新增 `src/questionnaire.ts`（与 `escalate.ts` 平级），形状为 §3.1 的 `Questionnaire` / `Question` / `Answer`
- **And** 工单服务从"escalation 的附件"降级为"escalation 与 questionnaire 共用的 HTTP 投递层"
- **And** 一个 `status: 'open'` 的问卷存在时，看板与面板显示"等人回答"，而**任务状态不是 `needs-human`、不产生学习记录、不进升级直方图**
- **And** `escalate` 工具行为一字不改（现有 `test-unattended.ts` 升级相关断言全部保持通过）

### 场景二：选择题与填空题可用

- **Given** `TicketField.type` 现状只有 `text | textarea | password | select`（`src/notification.ts:289-296`）
- **Then** 扩出 `multiselect`，渲染为可多选的复选框组，`recommended` 项默认勾选，`impact` 作为选项副文案
- **And** 不做条件分段（branching）——见 §3.3 的取舍
- **And** `required` 未答时返回 HTTP 400 且表单重述缺失项

### 场景三：ask_human 两种模式都闭环

- **Given** `questionnaire.mode: 'interactive' | 'async'`
- **When** interactive 模式
- **Then** `ask_human` 工具内部 `await` 答案，组长这轮不结束
- **And** 等待期间 `daemon.stuckMinutes` 不误判为 `task-stuck`（刷新 `lastActivityAt` 或以 `awaiting-human` 豁免，二者取一并在 `test-unattended.ts` 断言）
- **When** async 模式
- **Then** 落 open 问卷 + 邮件/webhook，答案回写后状态标为"待组长继续"，明确交代下一步由人开口（§1.1：插件无法唤醒 agent）

### 场景四：答案结构化回写进文档

- **Given** 一个 `binding: {type:'doc', path:'docs/drafts/prd.md', section:'§2.3'}` 的问题
- **When** 用户作答
- **Then** 答案写进该文档对应章节，并追加一条带时间戳的 `[decision]` 留言
- **And** 答案不是只活在 `state.json` 里——决策依据必须跟着代码进 git

### 场景五：draft → accepted 有审批链，且不可伪造

- **Given** AI 只能写 `docs/drafts/**`
- **When** `doc_write` 尝试写 `docs/prd.md`（正式区）
- **Then** 拒绝并提示走 `doc_approve`
- **When** `doc_approve` 升格一份文档
- **Then** 落盘前比对 frontmatter 的 `sha256` 与当前正文，不一致即拒绝审批并重开问卷（防"批 A 合 B"）
- **And** `AGENTS.md` / `.github/` / `LICENSE` 仍是 `security.forbiddenPaths` 默认值，**不因任何问卷答复而放开**（§8-8）
- **And** `doc_approve` 只接受本地端点 POST 或人直接在会话里调用；组长与开发者只能 `ask_human`（§8-10）

### 场景六：contract_create 写前校验

- **Given** 现状 `assignTask` 只校验契约存在（`src/service.ts:956-964`），创建路径完全缺失
- **When** `contract_create` 收到一张 `depends_on` 悬空、或 `touches ∩ forbidden ≠ ∅`、或依赖成环、或 `id` 不符 `<域>-<序号>` 的契约
- **Then** 写盘之前抛错并指明具体字段，绝不留下半个文件
- **And** 合法契约写盘后被 `syncContracts` 正常收养，无需第二次人工干预

### 场景七：开工包一次审批

- **Then** `kickoff_pending_approval` 提交的是一份 bundle（PRD + tech-stack + dev-guidelines + ADR-0001 + 骨架清单），人一次批完，不逐个批

### 场景八：提示词与测试

- **Then** `src/roles.ts` 组长段落重写为"draft/升格"口径，**保留** `AGENTS.md` / `docs/` 属 human-only 的原意，不是简单删掉禁令
- **And** 新增 `tests/test-questionnaire.ts` 覆盖场景一/二/四/五/六
- **And** 每个新工具已在 README「工具一览」列出；新增 Config 字段已按 AGENTS.md「改一处要连带改哪儿」连带 `index.ts` → `service/options.ts` → `apply()` → README 配置块
- **And** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` 全绿

## 超出范围

- 面板内嵌可作答的问卷卡片——属 M2。M1 的作答入口是浏览器里的工单页（现状即如此）。
- `cancelled` / `priority` / 重规划工具——属 M3。
