# 代码评审报告：origin/main vs origin/master（dsh-ai-team 插件）

> 评审日期：2026-08-28
> 评审对象：`origin/main`（A 作者）与 `origin/master`（B 作者）两个远程分支
> 重要前提：本地 `main` / `master` 分支其实**内容几乎完全相同**（仅 package.json 元数据差异），
> 真正构成"两个不同实现"的是远程的 `origin/main` 和 `origin/master`（35 个文件改动，+3106 / -1739 行）。
> 下文"main"指 `origin/main`，"master"指 `origin/master`。

---

## 一、总评分

| 维度（权重） | main (origin/main) | master (origin/master) |
|---|---|---|
| 功能完整度与领域正确性 (25%) | 18 / 25 | 23 / 25 |
| 健壮性与边界处理 (20%) | 13 / 20 | 19 / 20 |
| 架构与可维护性 (20%) | 18 / 20 | 17 / 20 |
| 类型安全与工程规范 (10%) | 9 / 10 | 9 / 10 |
| 测试 (15%) | 12 / 15 | 14 / 15 |
| 文档 (10%) | 10 / 10 | 7 / 10 |
| **加权总分** | **80 / 100** | **89 / 100** |

**结论：master（origin/master）明显胜出，约 89 分；main（origin/main）约 80 分。**
master 是"生产级、防御性更强"的实现，main 是"更易读、更可移植、文档更好"的实现。

---

## 二、两者架构取向的根本差异

| | main (origin/main) | master (origin/master) |
|---|---|---|
| UI 数据流 | HTTP REST：`fetch /api/ai-team/state` + 轮询 | DSH 原生：`useProjection('aiTeam')` + `ai-team/update` 事件投影 |
| 推送机制 | 注入 `EventEmitter`，emit 快照 | `onChange` 订阅（完全解耦于 EventEmitter） |
| 持久化 | 每团队一个 `<id>.json` | 单个 `teams.json`（防抖写入 + `version` + `activeTeamId`） |
| Git 抽象 | `GitBackend` 接口 + `CliGit` 实现 | 直接导出 `git` 函数集合 + `GitError` 异常类型 |
| 角色/提示词 | `defaultInstruction()` 内联三句 | 独立 `roles.ts`：模板化、带团队上下文的系统指令 |
| 视图类型 | `types.ts` 全量领域类型 | `view.ts` 浏览器安全类型（不引入 node 内置）+ `projection.ts` zod 校验 |
| 审查流程 | 启发式评论 + `approved` 布尔 | 完整生命周期：approve 自动合并入 base / request_changes 打回并计轮次 |

---

## 三、main（origin/main）亮点与问题

### 亮点 ✅
- **模块划分清晰**：`config.ts` / `types.ts` / `api.ts` / `git.ts` / `service.ts` 职责单一，新人易上手。
- **可测试性设计好**：`GitBackend` 是接口，`test/fake-git.ts` 用内存假实现做纯单元测试，不依赖真实 git。
- **文档最完整**：`README.md`（183 行）含架构图、目录结构、DSH 理念说明；附 `LICENSE`、`scripts/verify.mjs`。
- **HTTP 层可移植**：`api.ts` 与 DSH 解耦，理论上可挂到任意 web 框架。
- **工具编排有真实业务语义**：`task_assign` 支持按 id/role 分配、优先级、依赖；比 master 的 assigneeId-only 更灵活。

### 问题 ⚠️
1. **审查门禁形同虚设（最严重）**：`reviewCode` 的 `approved = diffStat.files>0 && comments.every(c => c.severity!=='error')`，但启发式 `review()` 只产出 `warning`/`info`，**从不产生 `error`**。只要改动非空，几乎永远 `approved:true`。合并也仅是返回 conflict 标志，不真正把任务并入 base 或推进任务状态。
2. **leader 规则宽松**：`createTeam` 把首个成员自动提升为 leader，可出现 0 个或多余 leader；无"恰有一个 leader"约束。
3. **缺角色守卫**：reviewer 可被分配编码任务，developer 可自审自己的任务，无校验。
4. **魔数上限**：成员上限硬编码 `64`，且**完全不校验 maxTasks**（任务数无限增长）。
5. **错误信息单薄**：仅 `team x not found`，排障时无上下文。
6. **轮询式 UI**：面板定时拉 `/state`，实时性弱、请求偏多。
7. **成员状态含 `done`**：语义上成员不该有"done"，建模不严谨。

---

## 四、master（origin/master）亮点与问题

### 亮点 ✅
- **领域模型最严谨**：强制"恰有一个 leader"；`isRole()` 校验角色；reviewer 不能写码、developer 不能审自己的任务、忙成员不能再接单——全部有 `assert.rejects` 测试覆盖。
- **审查即门控（核心优势）**：`code_review` approve 走 `--no-ff` 合并进 base 分支、释放成员、把成员工作区切回自身分支；`request_changes` 打回并 `reviewRound+1`；合并冲突则拒绝 approve 并保持 `in_review`。还有 `pruneTaskBranch` 做分支清理。
- **持久化健壮**：防抖写入 + `version` 字段 + `activeTeamId`，重启后 `TeamService.create` 能从 `teams.json` 恢复（集成测试专门验证了"宿主重启后状态存活"）。
- **解耦更彻底**：`onChange` 订阅取代注入 EventEmitter；`view.ts` 刻意不引入 node 内置（浏览器包可直接内联）；`projection.ts` 用 zod 校验投影 schema，headless 下优雅降级。
- **角色指令有"灵魂"**：`roles.ts` 的提示词真正告诉各 Agent 何时调哪个工具，使模拟团队像一支软件团队。
- **测试最扎实**：`tests/test-integration.ts`（217 行）跑通完整多 Agent 协作生命周期（建队→分配→提交→请求改动→修复→批准合并→重启恢复），断言覆盖各类非法操作。
- **错误处理有上下文**：报错带已知团队/成员名，排障友好。

### 问题 ⚠️
1. **`service.ts` 偏胖**：607 行单类，承载团队/成员/任务/分支/审查/视图/持久化。相比 main 把 config/types/api 拆出，master 的 service 还可进一步拆分（如抽出 persistence、views）。
2. **缺 README / LICENSE**：仅有中文 `overview.md`（已不错），但非标准 README，不利于开源分发。
3. **复杂度更高**：合并时临时切到 target 再切回 base 的分支操作巧妙但依赖"集成检出常驻 base"不变量，心智负担大。
4. **投影为整状态 last-write-wins**：每次变更推送全量快照，团队规模大时偏重（当前规模可接受）。

---

## 五、建议

1. **以 master 为主干**：其领域正确性、审查门控、持久化与测试已接近生产可用，是更值得信任的基底（89 分）。
2. **吸收 main 的优点做补强**：
   - 把 `config.ts` / `types.ts` 拆分与 `README.md` + `LICENSE` 文档规范并入 master；
   - 借鉴 main 的 `task_assign` 支持按 role / 依赖分配的灵活性；
   - 参考 main 的单测 FakeGit 思路，为 master 的 service 增加内存假 git 单元测，降低集成测对真实 git 的依赖。
3. **局部修复 master**：`service.ts` 抽 `persistence` 与 `views` 模块；为 `maxTasks` 之外的魔数（如 64）收敛为配置项。
4. **局部修复 main（若保留）**：让 `review()` 真正能产出 `error` 级评论，并在 approve 时把任务并入 base、推进状态——否则审查功能只是摆设。

---

## 六、一句话总结

> **master 写得"对"，main 写得"顺"。** 要上线选 master；要快速二次开发或做教学演示，main 的清晰度和文档更友好。两者合并可取长补短。
