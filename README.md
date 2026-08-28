# dsh-ai-team

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness) 打造的 AI 团队协作插件。
它让一个 AI Agent 能够模拟一支**拥有独立工作空间、共享代码仓库、能进行分支协作**的软件开发团队
（`leader` / `developer` / `reviewer` 多角色），并在 DSH Web UI 中提供可视化的「团队协作面板」。

> 设计遵循 DSH “一切皆插件” 的理念：插件同时拥有 **Host（Node.js）半身** 与 **Client（浏览器）半身**，
> 通过 `ctx.tools` 注册工具、通过 `ctx.provide()` 暴露服务、通过 `ctx.slots` 注册 UI，所有资源随插件卸载自动清理。

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 团队管理 | `team create` 创建团队并指定成员角色；`team add-member <role>` 为团队追加不同系统指令的 Agent 成员 |
| 隔离工作空间 | 每个 Agent 成员拥有**隔离的虚拟工作空间**（基于 `git worktree`），互不干扰 |
| 共享仓库 | 所有成员工作空间**共同访问同一个 `.git` 仓库**，天然共享代码与历史 |
| 分支协作 | 在共享仓库中创建 / 切换 / 合并 Git 分支，冲突可检测 |
| 任务分配 | `leader` 分解任务并分配给 `developer`（看板：`todo → in_progress → in_review → done/blocked`） |
| 代码审查 | `developer` 完成任务后，`reviewer` 可审查分支代码、给出修改意见并批准 / 驳回 |
| UI 面板 | 浏览器端「团队协作面板」挂靠 `shell.overlay`，展示成员、工作空间状态、活跃分支与任务看板 |

---

## 架构

```
                 ┌──────────────────────── DSH Web UI (browser) ───────────────────────┐
                 │  src/client/index.tsx                                                │
                 │    └─ ctx.slots.register('shell.overlay', TeamPanel)  ──►  浮动面板   │
                 │  src/client/TeamPanel.tsx  ── fetch ──┐                              │
                 └───────────────────────────────────────┼──────────────────────────────┘
                                                          │ HTTP  /api/ai-team
                 ┌──────────────────────── Host (Node) ───┼──────────────────────────────┐
                 │  src/index.ts  (apply + provide + tools + api)                        │
                 │    ├─ ctx.tools.register(team_create / team_add_member / …)           │
                 │    ├─ ctx.provide('aiTeam', TeamService)                              │
                 │    └─ ctx.effect(() => httpServer)  托管 HTTP 路由，卸载自动清理       │
                 │  src/service.ts  (TeamService：团队/成员/分支/任务/审查 状态机)        │
                 │  src/git.ts      (GitBackend 封装：worktree 隔离 + 共享仓库)           │
                 │  src/tools.ts    (defineTool 工具定义 + 渲染)                          │
                 │  src/api.ts      (HTTP 路由：/state、/action)                          │
                 └───────────────────────────────────────────────────────────────────────┘
                                          │  git worktree
                 ┌──────── 共享仓库 (.git) ────────┐
                 │  member/leader   → worktree A    │
                 │  member/dev-1     → worktree B    │  每个成员一个 worktree，共享同一 .git
                 │  member/reviewer  → worktree C    │
                 └───────────────────────────────────┘
```

**为什么用 `git worktree`？** 它完美契合需求：每个 Agent 成员的工作目录是仓库的一个独立 worktree，
物理上隔离、互不踩踏，却指向同一个 `.git` 对象库——也就是「各自的隔离工作空间 + 共同访问同一仓库」。

---

## 目录结构

```
dsh-ai-team/
├── package.json            # dsh.bundle / dsh.client / exports / engines
├── tsconfig.json           # Host 构建（tsc → lib/）
├── tsconfig.client.json    # Client 构建（tsx 产物 → lib/client/）
├── cordis.patch.yml        # 打包补丁：插件加入 profile 时插入组合树
├── dev.cordis.yml          # 本地开发覆盖（直接加载 src/index.ts）
├── src/
│   ├── index.ts            # Host 入口：apply(ctx, config) + provide + tools + api
│   ├── config.ts           # 基于 @deepseek-ai/schemastery 的 Config 定义
│   ├── types.ts            # 共享类型（Team / Member / Task / ReviewResult …）
│   ├── git.ts              # GitBackend 接口 + 真实 git worktree 实现（可注入以测试）
│   ├── service.ts          # TeamService：核心状态机与协作逻辑
│   ├── tools.ts            # defineTool 工具：team_create / team_add_member / task_assign / code_review …
│   ├── api.ts              # Host HTTP 路由（/state、/action）
│   └── client/
│       ├── index.tsx       # Client 入口：注册 shell.overlay 面板
│       ├── TeamPanel.tsx   # React 团队协作面板
│       └── api.ts          # 客户端 ↔ 宿主 HTTP 的桥接
├── test/
│   ├── team-service.test.ts  # 单元测试（node:test）
│   ├── test-integration.ts   # 多 Agent 协作集成场景（真实 git）
│   └── fake-git.ts           # 无 git 环境下的可注入 GitBackend 桩
└── scripts/
    └── verify.mjs           # 发布前一致性校验（package.json ↔ cordis.patch.yml）
```

---

## 安装与构建

```bash
pnpm install            # 或 npm install
pnpm build              # tsc 编译 host + client 到 lib/
pnpm check              # 双端类型检查
```

> 注意：`esbuild` 在部分网络下 `postinstall` 被 pnpm 安全策略跳过属正常现象，不影响 `tsc` 构建与 `tsx` 运行。

---

## 开发调试

1. **Host 半身（热迭代，免构建）**：在 `dev.cordis.yml` 中把绝对路径改成你的 checkout，然后：

   ```bash
   pnpm dsh web --patch ./dev.cordis.yml
   ```

2. **Client 半身**：浏览器侧需先构建一次并装进 profile，使其 `dsh.client` manifest 被识别：

   ```bash
   pnpm build
   dsh plugin --profile web add .
   ```

   面板会作为浮动层注册进 `shell.overlay`（由 DSH 应用外壳的 `ui-layout` 渲染）。

3. **打包补丁**：`cordis.patch.yml` 会在 `dsh plugin --profile web add .` 时自动应用，把插件按 `id: ai-team` 插入组合树。

---

## 配置（Config）

通过 `@deepseek-ai/schemastery` 定义，加载时即校验：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `stateDir` | string | `.dsh-ai-team` | 团队 / 仓库状态持久化目录 |
| `maxMembers` | number | `12` | 单个团队最大成员数 |
| `enableFileWatch` | boolean | `false` | 是否监听工作空间文件变化（预留） |
| `apiBase` | string | `/api/ai-team` | 宿主 HTTP 路由前缀 |

---

## 工具清单（Host 侧，供 Agent 调用）

| 工具 | 入参 | 作用 |
| --- | --- | --- |
| `team_create` | `name`, `members[]` | 创建团队并为每位成员分配独立 worktree 工作空间 |
| `team_add_member` | `teamId`, `role`, `name?`, `systemPrompt?` | 追加成员（不同角色带不同系统指令） |
| `task_assign` | `teamId`, `title`, `description`, `assigneeRole`, `priority?` | leader 分配任务给某角色成员 |
| `code_review` | `teamId`, `branch`, `base?` | reviewer 审查分支（默认对比 `base...branch`），返回变更统计与意见 |
| `git_create_branch` | `teamId`, `memberId`, `branch` | 在成员工作空间创建并切换分支 |
| `git_commit` | `teamId`, `memberId`, `message`, `files?` | 提交改动 |
| `git_merge` | `teamId`, `source`, `target` | 将源分支合并进目标工作空间，返回是否冲突 |

---

## HTTP API（供 Client 面板消费）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `${apiBase}/state` | 返回所有团队快照（成员、分支、任务看板、仓库路径） |
| `POST` | `${apiBase}/action` | 执行动作：`createTeam` / `addMember` / `assignTask` / `createBranch` / `commit` / `merge` / `review` |

---

## 测试

```bash
pnpm test                 # 单元测试（node:test，6 个用例）
pnpm test:integration     # 多 Agent 协作集成场景（真实 git worktree）
pnpm verify               # 发布前一致性校验
```

集成场景会模拟：创建团队 → leader 分配任务 → developer 建分支并提交 → reviewer 审查 → 合并，
验证「隔离工作空间 + 共享仓库 + 分支协作 + 审查合并」全链路。

---

## 约束与最佳实践（本插件遵循）

- **显式声明依赖**：`inject` 数组列出所需服务（`tools`、`session`、`config`、`slots`…）。
- **自动清理**：通过 `ctx` 注册的工具 / 服务 / 面板均随插件卸载自动回收；外部资源（HTTP 服务）用 `ctx.effect()` 托管。
- **配置即校验**：用 `@deepseek-ai/schemastery` 定义 Config，加载阶段即校验。
- **NodeNext ESM**：相对导入使用 `.js` 后缀以兼容 NodeNext。
- **不修改核心**：所有扩展以新插件形式实现，不触碰 DSH 核心文件。

---

## License

MIT
