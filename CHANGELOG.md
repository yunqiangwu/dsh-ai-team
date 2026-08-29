# Changelog

本项目的所有重要变更都记录在这个文件里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)；条目按 git 提交历史（Conventional Commits）归纳，feat / fix 优先。

## [Unreleased]

### 新增

- **需求变更与重规划（M3）**：任务废弃态 `cancelled`（契约文件保留可追溯）、契约与任务的 `priority` 派发权重（只在依赖条件相同的任务间生效）、`task_cancel` 与 `task_replan`（supersede / continue / abort 三种在途处置，abort 必须人批）、`replan.maxPerHour` 频率上限且不重置墙钟预算。
- **团队阶段与依赖死锁（M0）**：`phase` 维度（intake → 待批 → 搭骨架 → 开发 ⇄ 重规划），非开发阶段不派发；前置永不满足时响亮升级 `blocked-dependency`，不再静默空转。
- **能问能写（M1）**：问卷实体（与升级彻底解耦）与 `ask_human` / `answer_questionnaire` / `doc_write` / `doc_approve` / `contract_create` 五个工具；文档「草稿 → 人批升格」审批链（sha256 防批 A 合 B）；工单字段补 `multiselect`。
- **工单鉴权（M2）**：每张工单铸造 token 只进邮件/webhook 文案；`ticket-handler` 一份 handler 两个挂载点（独立端口 + 宿主同源路由），面板可内联作答。
- **项目画像适配器 `profile`**：分支/PR 模板、合并策略、条件质量门、禁区策略与所有权路由可按项目约定覆写，内置 `agentdeploy` 预设。
- **知识回路 `learnings`**：评审打回与升级自动沉淀为教训，按域相关性注入后续任务描述；待升格清单交人落文档。
- **每任务墙钟预算**（`daemon.maxTaskHours`，超时升级 `budget-exceeded`）与团队运行指标聚合。
- **文档体系**：操作者 runbook `PILOT.md`、交互流程设计文档 `docs/design-interaction.md`（M0–M3 规格与实施记录）。

### 变更

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
