# S2 运行记录：并行派发 + 域锁闭环

> 状态：**已完成**（2026-08-30，主循环 `completed`，tick 73）。
> 所属：文档见 [../pilot-scenarios.md](../pilot-scenarios.md)（S2）。
> 目标：喂入 2 个 touches 不同目录的独立契约，验证「并行派发 → 域锁不冲突 → 各自门禁/评审/合并 → 同时 done」的并行闭环（L2）。

## 喂单

- 时间：2026-08-30（本地，主循环 S1 已 `completed` 后）
- 团队：`demo`（`team_e0d02c7e`），rootDir `.dsh-ai-team-l1`
- 喂单内容（消息框原话，经浏览器输入）：

> 【S2 试点场景：并行派发 + 域锁】main 分支三期继续。请一次性拆出 2 个彼此独立、touches 不同目录/文件的契约：(A) 扩展 src/parser.ts 支持有序列表 ordered list 的嵌套层级渲染；(B) 在 src/cli.ts 新增一个开关参数并配套 tests 覆盖。两个契约无文件交集，必须并行派发给不同 developer 开发、互不阻塞（域锁不应冲突）。各自跑完 门禁→评审→合并，验收时四道门全部必须绿，最终 2 个契约都进 done。

## 预期闭环

1. leader 一次性拆出任务 A / B（touches 不同文件，域不重叠）
2. daemon 把 A/B **并行**派发给不同 developer（同时 ≥2 个 in_progress）
3. 域锁不起冲突；各自开发 → 门禁全绿 → 评审 → merge → done
4. 看板出现并行 in_progress，最终 2 任务 done、四道门全绿、0~1 升级

## 实际经过

1. **leader 消化需求并核对仓库**：确认 CLI 实际文件是 `src/index.ts` 而非喂单里写的 `src/cli.ts`（读 `touchesOverlap`/`domainLimitStatus` 源码确认域锁机制），把契约 B 落成 `--no-document` 开关到 `src/index.ts` + `tests/cli.test.ts`——**合理自纠喂单笔误，未升级**。
2. **一次性创建 2 个并行契约**：`contract_create` 一次创建 S2-1 (A) / S2-2 (B)。
3. **leader 重启主循环**：`autopilot_run`（tick 57→running），daemon 随即派发。
4. **并行派发确认（tick 63）**：后端 `state.json` 同时出现 2 个 `in_progress` 契约——
   - `task_b83f12d8`（A）touches `['src/parser.ts','tests/blocks.test.ts']`
   - `task_78376d97`（B）touches `['src/index.ts','tests/cli.test.ts']`
   - 两个 developer 成员（`m_2a685af7`、`m_b1d0f045`）**同时 `working`** → **并行派发、域锁不冲突成立** ✅
   - metrics：dispatched 6 / completed 4。

（等待 A / B 各自 门禁→评审→合并→done）

5. **并行闭环完成（tick 73）**：后端 `state.json` 两个契约同时置 `done`——
   - `task_b83f12d8`（A，ordered list 嵌套）→ done
   - `task_78376d97`（B，`--no-document` CLI 开关）→ done
   - 主循环 `completed`，四名成员回 `idle`；metrics：`dispatched 6 / completed 6 / gateRuns 6 / gateFailures 0`。
   - **并行派发 + 域锁不冲突成立**：A/B touches 不同文件，全程无域锁互斥、无排队，两块独立走完门禁→评审→合并 ✅

## 观察发现（待复核）

- **喂单纠偏能力**：喂单写的是 `src/cli.ts`，仓库真实是 `src/index.ts`；leader 读源码后自行落对位置，没有反问或升级——**域锁侧 fed 文档与真实代码不一致时的容错符合预期**（本场景本就要求「独立契约」）。
- **并行域锁零冲突**：A（`src/parser.ts`+`tests/blocks.test.ts`）与 B（`src/index.ts`+`tests/cli.test.ts`）touches 无交集，两 developer 同时 `working`、无 `deferred-domain-lock` 事件——域锁不阻塞并行开发成立。
- 两任务独立走完门禁，无共享产物互相踩（gateFailures 0）。

## 指标

- dispatched 6 / completed 6 / reviewRounds 0 / gateRuns 6 / gateFailures 0 / deploys 0 / rollbacks 0
- S2 专属：两块并行任务（A / B）均 from dispatch → done，全程 0 升级、0 人工介入。

## 复盘

对照 PILOT.md §8 收尾判定（S2）：
- **并行派发**：一次拆 2 个契约、daemon 同时派给 2 个 developer、同时 in_progress → ✅
- **域锁不冲突**：touches 不同文件，无 `deferred-domain-lock`、无排队，两块互不阻塞 → ✅
- **各自独立闭环**：两块都独立走完 门禁全绿→评审→合并→done，gateFailures 0 → ✅
- **喂单容错**：fed 的 `src/cli.ts` 与仓库 `src/index.ts` 不一致，leader 自行落对、未反问/升级 → ✅
- 已知观察：并行时面板忙闲/进行中计数会有最终一致的刷新延迟（同 S1 观察，P2 体验项）。