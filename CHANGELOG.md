# Changelog

本项目的所有重要变更都记录在这个文件里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)；条目按 git 提交历史（Conventional Commits）归纳，feat / fix 优先。

## [1.4.0] - 2026-08-30

### 新增

- **看板 UI 改版（Grafana 风格）**：顶部**统计卡条**（短标签 + 数字并排，如 `3/3 运行指标`、`0 卡住的任务`），**点击某张卡弹出浮窗**展示该类的详细面板（卡住任务 / 问卷流水 / 已知教训 / 升级事件 / 部署历史 / 运行指标）；原先内联展示的这五个区块改为浮窗承载，面板更紧凑。
- **任务卡更紧凑**：标题**单行省略号**，**悬浮显示详情浮窗**（`position: fixed` 定位并夹在视口内，避免被看板滚动容器裁剪、不与下一张卡花屏重叠）。
- **看板改瀑布流布局**：等宽列、`flex-wrap` 顶对齐、**空列自动收缩为仅标题高度**、有内容列保持自然高度（卡片多时列内滚动），显著减少看板占用的竖向 UI 空间与空白。
- **看板新增「等你决策」列**：未绑定任务的开放式问卷也以卡片出现在看板（已绑定任务的问卷仍在其任务卡上显示「等人回答」徽标）。
- **「等你决策」可最小化浮窗**：默认收起为**右下角小胶囊**，点开浮窗内联作答，不再占用正文一整块。

### 测试

- 新增**确定性 e2e**（离线、零 token、可重复）：
  - `tests/test-e2e-md2html.ts`：md2html 无人值守闭环（init → 补成员 → 三段契约 → 派发 → 门禁 → 评审 → 合并）。
  - `tests/test-e2e-parallel.ts`：**多开发并行**（两个不同域、无依赖任务同时派发给两个 developer）。
  - `tests/test-e2e-askhuman.ts`：**ask_human 人工确认/提供信息**流程（任务触发提问 → 开放问卷「等你决策」→ 人作答落地、任务继续）。
- 新增 `packages/llm-mock`：独立的 **OpenAI 兼容流式 mock LLM 子项目**（用于离线、零 token 地驱动 e2e），附 `responses.example.json` 脚本化响应示例。

### 变更

- 移除面板内联的「运行指标 / 卡住的任务 / 问卷流水 / 已知教训 / 升级事件 / 部署历史」区块（改由统计卡点击浮窗承载）。
- 真实试点验证：全新项目「md2html」（与 dsh-ai-team 无关）由 AI 团队自主完成「拆单 → 开发 → 门禁 → 评审 → 合并」全闭环，3/3 任务 done、零升级零返工。

## [1.3.1] - 2026-08-30

### 修复

- **看板头部「进行中任务」计数与看板对不上**：`AutopilotPanel` 的 summary 原先统计「未完成任务数」（含待办），与看板「进行中」列不一致，导致「0 忙碌」时仍显示「N 个进行中任务」。改为统计真正的 `in_progress` 任务数，zh 文案保持「进行中任务」、en 同步为「in progress」。

## [1.3.0] - 2026-08-30

### 新增

- **配置热改（免重启）**：服务端引入「基线 + 运行时覆盖」两层（`RuntimeConfig` / `mergeRuntimeConfig` / `runtimeConfigViewOf`），`AutopilotService` 的 `options` 改为可变并新增 `setRuntimeConfig` / `runtimeConfigView`。设置 → 插件 → 插件配置面板保存即热生效（经 `onChange` → `setRuntimeConfig` 投递，落进 `state.json` 的 `runtimeConfig` 跨重启保持），不再需要带 `--patch` 重启服务端；同时新增 `config_show`（看生效配置）与 `config_set`（自然语言改仓库地址、基分支、门命令等）两个 leader 可用的工具。说明：`remote.url` 对已克隆团队的 origin 不会自动改指，新 clone / 新团队才用新地址。
- **看板面板可调大小**：看板主体高度默认不超过 `min(62vh, 720px)`、超出内部滚动，右下角拖拽手柄可手动改高度（`resize: vertical`），不再整屏遮挡。

## [1.2.0] - 2026-08-30

### 新增

- **无人值守 override（真实裸机试点实测）**：session 采用 `autopilot-team` preset 时（运行时切换与默认 preset 新建两个入口都覆盖），插件写入会话级 override——沙箱模式 `danger-full-access` + 审批策略 `never`。此前 leader 会话默认 `workspace-write` 只覆盖会话 cwd，写团队 rootDir 被拒后只能申请 sandbox 升权 → 弹人工审批窗，与「无人值守」定位直接冲突；子代理在委派边界继承父会话的显式 sandbox override，developer 一并放开。插件自有硬规则（gates 命令白名单、forbiddenPaths、push 门）不受影响，人仍可经面板会话级开关切回。

### 修复

- **默认 gates 顺序 build 在 test 前**：`DEFAULT_GATES` 原先 `…test, build`，而 test 可能依赖 build 产物（本仓库 smoke-cordis 读 `lib/index.js`），干净 worktree 上先 test 必红（试点实测、leader 直接点出）。改为与 AGENTS.md 一致的四件套顺序 typecheck → lint → build → test；README / PILOT.md / pilot.patch.yml 同步。

## [1.1.2] - 2026-08-30

### 修复

- **bootstrap 默认命令改为空串（已知坑 1）**：`DEFAULT_BOOTSTRAP` 的 `setupCommand` / `verifyCommand` 不再默认指向 `pnpm run setup` / `pnpm run e2e:local`——空 remote 时团队仓库是空仓库、真实用户仓库也没有普适脚本名，默认必致 `autopilot_init` 上来就 `bootstrap-failed`。空串 = 跳过，引导只做工具链探测 + rootless 安装；要跑初始化/自检在配置里指认目标仓库真实存在的命令（README / PILOT.md 有示例）。
- **多团队投影一致性（TECH-4）**：`escalationView` / `deployView` 补 `teamId`（`stateVersion` 8），面板单团队视图的升级流、部署历史与摘要计数改按当前团队过滤，多团队并行时不再混显；归属不明的旧记录（`teamId: null`）全团队可见。升级侧 13 个内部触发点显式归属，工具侧按 `taskId` 反查兜底。

## [1.1.1] - 2026-08-30

### 新增

- **需求变更与重规划（M3）**：任务废弃态 `cancelled`（契约文件保留可追溯）、契约与任务的 `priority` 派发权重（只在依赖条件相同的任务间生效）、`task_cancel` 与 `task_replan`（supersede / continue / abort 三种在途处置，abort 必须人批）、`replan.maxPerHour` 频率上限且不重置墙钟预算。
- **团队阶段与依赖死锁（M0）**：`phase` 维度（intake → 待批 → 搭骨架 → 开发 ⇄ 重规划），非开发阶段不派发；前置永不满足时响亮升级 `blocked-dependency`，不再静默空转。
- **能问能写（M1）**：问卷实体（与升级彻底解耦）与 `ask_human` / `answer_questionnaire` / `doc_write` / `doc_approve` / `contract_create` 五个工具；文档「草稿 → 人批升格」审批链（sha256 防批 A 合 B）；工单字段补 `multiselect`。
- **工单鉴权（M2）**：每张工单铸造 token 只进邮件/webhook 文案；`ticket-handler` 一份 handler 两个挂载点（独立端口 + 宿主同源路由），面板可内联作答。
- **项目画像适配器 `profile`**：分支/PR 模板、合并策略、条件质量门、禁区策略与所有权路由可按项目约定覆写，内置 `agentdeploy` 预设。
- **知识回路 `learnings`**：评审打回与升级自动沉淀为教训，按域相关性注入后续任务描述；待升格清单交人落文档。
- **每任务墙钟预算**（`daemon.maxTaskHours`，超时升级 `budget-exceeded`）与团队运行指标聚合。
- **域锁推迟可见化（TECH-2）**：`touches` 被在途任务锁定的派发候选保持 `pending` 并记 `deferred-domain-lock:<taskId>` 事件，派发继续走锁外候选——高优先级任务等域锁不再静默，也不误报升级。
- **正式区 drift 检测（TECH-3）**：`accepted` 文档被手改后由守护循环每拍比对 sha256 检出，整体退回 draft 区重批（新哈希、version 递增、同一次提交两侧）并重开 approval 问卷——`approvedBy` 不再对被改过的正文说谎。
- **文档体系**：操作者 runbook `PILOT.md`、交互流程设计文档 `docs/design-interaction.md`（M0–M3 规格与实施记录）。

### 变更

- **webhook 投递合并（TECH-1）**：升级侧改用与问卷共用的 `postHumanWebhook`，删除 `EscalationManager.deliverWebhook` 重复实现；webhook URL 现登记进脱敏器，两侧载荷语义不变。
- 默认禁区收缩到 `LICENSE`：`AGENTS.md` / `.github/` 移出禁区，「不许改文档」的约束下移为「走有审批记录的 draft → 升格链」。

### 修复

- 兑现安全硬规则：命令替换与反引号整条拒绝、`bootstrap.systemPackages` 逐包名校验、可变 git 操作分支名过 `assertSafeRef`、工单三个失败分支返回逐字节相同的 404。

## [1.0.3] - 2026-08-29

### 修复

- `session.append` 支持 `ignorable` 选项：读取方可跳过读不懂的事件类型，而不是拒绝整条日志。
- 发布流程与样式修正。

## [1.0.2] - 2026-08-29

### 修复

- 插件面板报错问题。

## [1.0.1] - 2026-08-28

### 新增

- `autopilot` 设置卡片：设置页内编辑并保存关键字段（需带 `--patch` 重启生效）。
- `autopilot-team` agent 预设：随包分发、自动落盘，选中即可创建 demo 团队并点亮看板。

### 修复

- autopilot 投影注册与状态处理、宿主 API 兼容性。

### 文档

- 排错指南：解决 `dsh web` 启动问题。

## [1.0.0] - 2026-08-28

### 新增

- 首个发布：dsh 的 AI 软件团队插件。leader / developer / reviewer / operator 四角色协作——共享仓库上按成员隔离的 git worktree、`.tasks/*.md` 任务契约、客观质量门、评审合并、升级与部署的无人值守闭环。
