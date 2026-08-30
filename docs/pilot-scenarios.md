# 试点场景设计方案：首次真实环境无人值守

> 状态：**已实施**（2026-08-30 经操作者批准，逐场景执行中）。
> 分工：本文只讲「这次试点要跑哪些场景、每场景验证什么、怎么在浏览器里操作与记录」；配置字段语义以 [../README.md](../README.md) 为准、运行 Runbook 以 [../PILOT.md](../PILOT.md) 为准。本文是基于已完成的 L1 dogfood 试点（`demo` 团队 `team_e0d02c7e`）之上的二次试点方案。

## 0. 背景

PILOT.md 的试点回答四个问题：任务能否无人介入跑完闭环、升级是否事出有因、成本是否失控、同一坑是否反复踩，并用「放权递进 L0 → L1 → L2」逐级推进。

当前状态：

- `dsh web`（端口 3081）跑着 `demo` 团队，`rootDir: .dsh-ai-team-l1`，config 见 `pilot.patch.yml`（generic 自建远端、requireCiGreen 显式关、自建远端 `/tmp/dsh-ai-team-l1.git`）。
- **一期已闭环**：MD2HTML-1/2/3 三个契约全部 `done` 并合并进 main（completion：dispatched 3 / completed 3，gate runs 3 failures 0，0 升级）。
- **二期已答问卷**：`ask_human` 关于「是否支持 GFM 表格」已由人在工单页作答 —— 支持 + 语义化 HTML 输出（`<th>/<thead>/<td>/<tbody>`），leader 待据此拆二期契约。
- 学习记录（learnings）：一期无捕获。

## 1. 目标

在一个真实无人值守主循环里，用**不同测试场景**分别走完闭环，验证「模型在环」的协作质量（这正是合成 e2e 覆盖不到的部分），并把每场景的「喂单内容 → 预期闭环 → 浏览器操作 → 实际结果 → 复盘」记录成一份可追溯的运行记录文档。

编排引擎本身的正确性已由 `tests/test-integration.ts` 等测试锁定，**不在本次重复验证**。

## 2. 场景清单

统一在现 `demo` 团队上继续（复用存量团队、贴近真实累积式开发；如需隔离由操作者决定另起 `rootDir`）。

| # | 场景 | 契约形态 | 验证点 | 放权级 |
| --- | --- | --- | --- | --- |
| S1 | 二期 GFM 表格正常闭环 | 拆成 1–2 个契约（解析 + 渲染） | 「已答问卷 → 拆契约 → 派发 → 门 → 审查 → 合并」连续闭环；无升级 | L0/L1 |
| S2 | 并行派发 + 域锁 | 2 个独立契约，touches 不同目录 | 开发并行度、依赖/域锁收敛、push 自建远端 | L2 |
| S3 | 人工决策 + 问卷复核闭环 | 引入一个需人拍板的产品决策（如：GFM 之外的扩展能力取舍） | `ask_human` 生成问卷 → 浏览器面板/工单作答 → 答案回写 → 按 [decision] 继续开发闭环 | L1（人在环） |
| S4 | 升级分诊 + 放行 | 制造一次受控升级（如契约 touches 写宽触发 forbidden-paths，或门红，或超预算） | 升级原因可读、浏览器面板表单作答放行/退回、自动 resume | L1（可中断） |

> S4 属「故意使门 / 触发升级」的探究式场景，制造口径须在喂单时说明清楚，避免污染真实学习记录；执行顺序放最后，并在记录里标注「人为触发」。

## 3. 每场景的浏览器操作与记录模板

同一套操作骨架，逐场景套用：

1. **喂单**：在消息框给 leader 下达「按已答问卷拆二期契约并派发」的指令，或贴契约到 `.tasks/`。
2. **观察**：面板「轨迹」tab + `autopilot_status`，看子代理派发、task 状态流转。
3. **人在环（S3/S4 需要时）**：在面板工单表单作答 / `escalation_resolve` 放行。
4. **收敛**：`completion.md` + 面板「运行指标」核对 dispatched/completed/gate runs/escalations。
5. **记录**：按下方模板把每场景落到 `docs/runs/<scene>.md`（或按操作者偏好合并单篇）。

```markdown
## S<N> <场景名>
- 时间 / commit / teamId
- 喂单内容（贴原话）
- 预期闭环：<列出预期的状态流转>
- 实际经过：<浏览器看到的子代理与任务推进轨迹要点>
- 指标：dispatched / completed / gateRuns / escalations / durations
- 升级或人工介入：<有则写原因 + 处置>
- 复盘：完成率是否 ≥80%、是否同因反复、坑是否已入学习记录
```

## 4. 产出

- `docs/pilot-scenarios.md`（本文）：方案 + 场景清单。
- `docs/runs/*.md`：每场景的「执行 + 运行记录」（随执行逐场景追加）。
- 结束后的总结：各场景完成率、升级直方图、耗时分布，对照 PILOT.md §8 判定是否进下一级 / 是否需改契约模板或收紧配置。**已完成，见 [runs/_summary.md](runs/_summary.md)**（判定：四场景全部通过，可进下一级）。

## 5. 执行顺序与停止条件

- 顺序：S1 → S2 → S3 → S4（最主干先验证，投入式场景放最后）。
- 停止条件（命中即停回上一级，PILOT.md §0）：`rollback-failed`；同一原因升级 ≥3 次；耗时普遍贴近 `maxTaskHours`。
- 每场景结束即时落盘记录；全部结束后汇总 `docs/runs/_summary.md`。

> **进度**：S1 已完成（2026-08-30，见 [runs/s1-gfm-template.md](runs/s1-gfm-template.md)）——MD2HTML-1..4 走通无升级闭环；S2 已完成（见 [runs/s2-parallel-lock.md](runs/s2-parallel-lock.md)）——一次拆 2 契约、并行派发、域锁零冲突、0 升级；S3 已完成（见 [runs/s3-human-decision.md](runs/s3-human-decision.md)）——`ask_human` 问卷→人拍板→答案回写 `[decision]`→拆 S3-1/S3-2→派发→门禁→评审→合并，完成率 100%、0 意外升级，1 次预期内人工拍板；**S4 已完成**（见 [runs/s4-escalation.md](runs/s4-escalation.md)）——人为触发的 `manual` 升级→面板作答+`escalation_resolve` 放行→S4-1 自动重走闭环，完成率 100%。四场景全部完成，汇总见 [runs/_summary.md](runs/_summary.md)。

### 5.1 运行期观测与已知坑

试点推进中积累的运行期观察（不影响闭环正确性，作为发现项记录、不阻塞）：

- **面板刷新滞后（P2，已修根因）**：运行中 `state.json` 的 `in_progress`/`in_review` 中间态在面板上滞拍。根因是 daemon 主循环自动变更只写盘、不一定推 `autopilot/update` 事件，面板读事件折叠出的投影就漏拍。已在 `src/service.ts` 主循环加「有实际变更即推一帧投影」，让运行中面板与后端对齐；最终一致态始终正确。
- **运行期 data 损坏自愈（本次实测）**：重启 `dsh web` 时恰逢 `state.json` 写盘窗口被截断成 0 字节（服务按保护机制改名留存 `state.json.corrupt-<ts>`）。磁盘真相源（`.tasks/` 契约、`_board.md`、git 分支、`completion.md`）完好，服务可据此**重建**运行态 `state.json`（4 成员 + 6 任务 + 指标），看板随之恢复。`state.json` 是可再生的运行态汇总，真相源在磁盘契约与 git，故损坏不丢任务本体。
- **「N 个子代理」vs 看板忙闲口径**：IDE 顶栏的「N 个子代理」是会话层常驻子代理计数；看板成员忙闲是 autopilot 状态机的瞬时工作状态——两套指标，常驻子代理 + `idle` 并不矛盾，不是状态没更新。

## 6. 待操作者确认

- [x] 场景清单是否齐（增删？）——面向已确认，按期执行
- [x] 是否继续用现 `demo` 团队——是，复用存量团队（S1/S2 已验证累积式开发）
- [x] S4 的人为触发口径是否可接受——是，备注「人为触发」不污染学习记录
- [x] （可选）运行期「面板刷新滞后 / data 损坏自愈」是否作为 P2 跟进项——已定夺：面板刷新滞后已修根因（见 §5.1），data 损坏自愈本次已实测复用；两顶随试点记录在 [runs/_summary.md](runs/_summary.md) 的运行期发现，不单独立项