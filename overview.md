# dsh-ai-team — DSH 多智能体团队插件

为 DeepSeek Harness 开发的「双面」插件(已构建、16 项集成断言 + cordis 冒烟测试全绿):让 AI Agent 模拟一个有独立工作空间、共享代码仓库、分支协作、任务分配与代码审查的软件开发团队。

## 交付内容

| 部分 | 文件 | 说明 |
|---|---|---|
| Host 入口 | `src/index.ts` | `name` / `inject: ['tools']` / `Config`(schemastery)/ `apply`;`ctx.provide('aiTeams')` 暴露服务;`ctx.effect` 负责卸载时落盘 |
| 团队服务 | `src/service.ts` | TeamService(与 cordis 解耦,可独立测试):团队/成员/任务/审查全生命周期,状态持久化到 `teams.json` |
| 工作空间 | `src/git.ts` | 每个成员一个 **git worktree**(目录隔离),共享同一 object store(天然分支协作) |
| 角色指令 | `src/roles.ts` | leader / developer / reviewer 各自的系统指令模板 |
| 工具层 | `src/tools.ts` | 8 个模型工具,每次变更 append `ai-team/update` 事件 |
| 投影 | `src/projection.ts` `src/events.ts` | `aiTeam` 投影(last-write-wins),可选注入,headless 兼容 |
| Client 面板 | `src/client/` | 团队协作面板:成员与状态点、分支列表(base 高亮)、五列任务看板;注册进 `conversation.input.dock` 插槽,zh/en 双语 |
| 调试配置 | `cordis.patch.yml` | `dsh web --patch ./cordis.patch.yml` 即可挂载 |
| 测试 | `tests/test-integration.ts` `tests/smoke-cordis.ts` | 全流程多 Agent 协作模拟(16 断言)+ 真实 cordis Context 加载构建产物(4 断言) |

## 8 个模型工具

`team_create` → `team_add_member` → `task_assign`(自动从 base 拉 task 分支并检出到该成员工作区)→ `task_update`(pending → in_progress → in_review)→ `code_review`(approve 自动 `--no-ff` 合并进 base;request_changes 打回并计返工轮次)→ `team_branch`(list/create/switch/merge)→ `team_status` / `team_list`。

## 使用

```bash
pnpm install && pnpm build
pnpm dsh web --patch ./cordis.patch.yml   # 开发调试
# 分发:dsh plugin --profile web add ./dsh-ai-team
```

## 关键设计决策

- **工作空间隔离 = git worktree**:比复制目录轻量,且分支协作零成本;合并统一在集成检出(repo 目录,常驻 base 分支)执行。
- **数据流免 Typert**:状态快照走 session 事件 + 投影,客户端 `useProjection('aiTeam')` 响应式渲染,无需 RPC 代码生成。
- **审查即门控**:`done` / `changes_requested` 只能经 `code_review` 到达;合并冲突会拒绝 approve 并保持 in_review。
- 构建产物:`lib/index.js`(ESM host)+ `lib/client.js`(`__ModuleLoader__` 包装,react 由宿主 module table 提供)。
