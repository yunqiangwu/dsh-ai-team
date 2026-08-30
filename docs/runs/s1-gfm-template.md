# S1 运行记录：二期 GFM 表格正常闭环

> 状态：**已完成**（2026-08-30，15:54 UTC / 23:54 本地，主循环 `completed`）。
> 所属：文档见 [../pilot-scenarios.md](../pilot-scenarios.md)（S1）。
> 目标：从「已答问卷 → 拆二期契约 → 派发 → 门禁 → 评审 → 合并」走完无升级的正常闭环（L0/L1）。

## 喂单

- 时间：2026-08-30（本地）
- 团队：`demo`（`team_e0d02c7e`），rootDir `.dsh-ai-team-l1`
- 喂单内容（消息框原话）：

> 人工已确认：二期支持 GFM 表格，采用语义化 HTML 输出（表头 `<th>` 放 `<thead>`，正文 `<td>` 放 `<tbody>`）。请据此创建二期任务契约（可拆为解析 + 渲染/测试，或合并为一个），在 `src/parser.ts` 实现表格块级解析（表头行 / 分隔行 / 单元格对齐），并新增 `tests/tables.test.ts` 用例。开工派发，并跑完 门禁→评审→合并 的完整闭环，验收时四道门全部必须绿。

## 预期闭环

1. leader 依据已答问卷拆二期契约（MD2HTML-4 或更细）
2. daemon 派发 → member 开发 → 门禁（typecheck/lint/build/test）→ reviewer 审查 → merge
3. 看板「已完成」+1、completion 指标更新、0 升级

## 实际经过

1. 喂单后 leader 确认：「人工已确认：二期支持 GFM 表格，语义化输出。我现在创建一个二期任务契约（解析+渲染+测试合并为一个），交团队开发并跑完整闭环。」
   - 首次 `contract_create` 因漏传必填 `title` 抛 `invalid arguments`，leader 自查后补上重试（**合理自纠，未升级**）。
   - `contract_create` 成功：**MD2HTML-4**（GFM 表格，语义化 HTML 输出），`更新任务清单 1/5`。
2. 等待 daemon 派发生成 `task/MD2HTML-4` 分支（Bash「Check MD2HTML-4 dispatch state」运行中）。
3. **关键自纠**：leader 发现 daemon 主循环停在 `completed`（tick 36，一期收尾后未自动续跑故未派发新契约），主动调 `autopilot_run` 重新拉起循环（running，tick 37），并说「Let me wait for it to dispatch MD2HTML-4」。→ **跨周期续跑场景里，人类（我）未介入，leader 自行识别并拉起主循环，符合「无人值守」预期。**
4. **派发成功**：主循环重启后，daemon 把 MD2HTML-4 派给 dev-1（分支 `task/MD2HTML-4` checked out），leader spawn dev-1 子代理（id `aa284769-bff9-4f6b-9822-aac1a42412d0`）实现表格块解析，`更新任务清单 2/5`（1 in_progress）。看板 tag「1 个子代理运行中」。
5. **开发 → 门禁 → 合并闭环完成**：dev-1 在 `task/MD2HTML-4` 完成实现，四道门（typecheck/lint/build/test）全绿并提交（分支 commit）；reviewer 放行后 merge 回 `main`。`task_9d3ed871`（MD2HTML-4）置 `done`。
6. **主循环收尾**：全部 4 个契约（MD2HTML-1..4）完成后主循环 `completed`（tick 56），`completion.md` 生成（finished 2026-08-30T15:54:51.416Z）。
7. **面板/看板回到一致态**：后端 `state.json` 4 名成员全 `idle`、4 任务全 `done`、`loopState: completed`；浏览器看板同步显示「4 名成员（0 忙碌）· 0 进行中 · 已完成 4」。→ **S1 无升级正常闭环走通，符合预期。**

## 观察发现（待复核）

- **界面同步口径（已复核，结论：刷新滞后，非投影 bug）**：运行中后端 `state.json` 显示 `dev-1: working`、`task_9d3ed871: in_progress`（loop `running` tick 47，鲜活），但浏览器「任务看板」区与成员忙闲仍显示「0 忙碌 · 进行中 0」。顶栏 tag region 反而正确显示「任务 2 已完成 · 1 进行中」。
  - **复盘复核**：闭环完成后（成员全 `idle`、任务全 `done`、loop `completed`）重新刷浏览器，看板已正确显示「4 名成员（0 忙碌）· 已完成 4」，与后端 `state.json` 完全一致 → **说明面板最终态是新的，运行中看到的「没更新」是投影/面板的刷新延迟（eventually consistent），不是投影映射把数据写错**。顶栏 tag 与看板走的刷新通道不同所以瞬时快一些。
  - 定性：P2 级体验问题（运行中面板忙闲滞后数拍），不影响闭环正确性；试点结束后再考虑「update 事件推送后主动触发面板重渲染」，本期不动。
- **「4 个子代理」vs 看板忙闲口径**：IDE 顶栏「4 个子代理」是会话层常驻子代理计数，看板成员忙闲是 autopilot 状态机的瞬时工作状态——两套指标，4 个常驻会话 + 全 idle 并不矛盾，不是状态没更新。

（更多待观察填充）

（本轮全部契约 MD2HTML-1..4 的整体指标，来源 `completion.md`）

## 指标

- dispatched 4 / completed 4 / review rounds 0
- gate runs 4（failures 0）
- deployed 0（rollbacks 0）
- task durations（dispatch → done）：MD2HTML-1 11m · MD2HTML-2 8m · MD2HTML-3 4m · **MD2HTML-4（S1）7m**
- learnings captured 0
- S1 专属指标：MD2HTML-4 从派发到合并约 7 分钟，四道门全程绿、0 升级、0 人工介入。

## 升级或人工介入

- 升级次数：**0**（本次 S1 闭环全程无 escalate）。
- 人工介入：喂单时的需求确认走的是已答问卷/消息，巡检与记录由人（我）在会话层做，**未触碰团队决策**；leader 的 `autopilot_run` 续跑是团队成员自行调用，非人工。
- 备注：契约创建有一次 `invalid arguments` 自纠（漏 title），属于 leader 合理自查重试，不计升级。

## 复盘

对照 PILOT.md §8 收尾判定（S1）：
- **正常闭环**：拆契约 → 派发 → 开发 → 门禁全绿 → 评审放行 → merge → 看板/后端一致 → completion 生成，串行无升级走通 ✅
- **自动续跑**：周期收尾后 leader 主动识别 `completed` 并拉起主循环，无人值守跨周期切换成立 ✅
- **已知观察**：运行中面板忙闲刷新滞后数拍（最终一致），作为 P2 体验发现记录，不阻塞。