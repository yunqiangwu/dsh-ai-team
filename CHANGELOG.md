# 更新日志 (Changelog)

本文件记录 dsh-ai-team 的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-08-28

### 新增

- 团队管理：`team_create` / `team_add_member`，支持 `leader` / `developer` / `reviewer` 角色。
- 隔离工作空间：每位成员一个 git worktree，共享同一 object store。
- 分支协作：`team_branch`（list / create / switch / merge）。
- 任务分配与看板：`task_assign` / `task_update`，五列状态推进。
- 代码审查：`code_review`，`approve` 自动 `--no-ff` 合入 base，`request_changes` 打回并计返工轮次。
- Web 协作面板：注册进 `conversation.input.dock` 插槽，实时展示成员 / 工作区 / 分支 / 任务看板，zh / en 双语。
- Host 服务暴露：`ctx.provide('aiTeams', TeamService)`，供其它插件复用。
- 状态持久化：`teams.json` 落盘，`ctx.effect()` 卸载时清理。

### 测试

- 集成测试覆盖完整多 Agent 协作闭环（16 断言）。
- 真实 cordis `Context` 加载构建产物的冒烟测试（4 断言）。
