# S4 运行记录：升级分诊 + 放行闭环

> 状态：**已完成**（2026-08-31，loop `completed`，tick 126）。
> 所属：文档见 [../pilot-scenarios.md](../pilot-scenarios.md)（S4，探究式场景，**人为触发**）。
> 目标：制造一次受控升级，验证「升级原因可读 → 浏览器面板表单作答放行 → `escalation_resolve`/自动 resume → 任务重走闭环」的分诊闭环（L1，可中断）。

## 喂单

- 时间：2026-08-31（本地，S3 已 `completed` 后）
- 团队：`demo`（`team_e0d02c7e`），rootDir `.dsh-ai-team-l1`
- 喂单内容（消息框原话，经浏览器输入）：

> 【S4 试点场景：升级分诊 + 放行（人为触发，记录需标注「人为触发」，不污染学习记录）】main 分支五期，请分两段走一个「升级→人工放行→自动恢复」的受控闭环：
>
> (A) 先拆一个增量小契约实现一个轻量能力。例如：在 CLI 新增一个 `--doc-format`（html/markdown）输出样式开关，并在 tests 里补一条断言两种格式体都能正常渲染的用例；或由你判断选择其它等效的轻量小特性（保持单文件或 ≤2 文件、touches 精确）。正常 contract_create、派发。
>
> (B) 在契约创建后、尚未跑完合并之前，用 escalate 工具人为触发一次受控升级：reason 填 manual，taskId 指向该契约的 task，message 写「这是 S4 人为触发的探测升级，用于验证升级分诊+放行闭环，不是真实阻塞」，suggestion 写明你希望人工核对后放行的内容。这会让该 task 停在 needs-human 等人工处置。
>
> 我在面板「升级事件」对这次升级作答放行后，autopilot 会自动把该任务退回 pending 并重新派发。请你随后继续把 (A) 的小特性跑完 门禁→评审→合并→done（四道门全绿）。

## 预期闭环

1. leader 拆出一个增量小契约 S4-1，创建后人为触发 `manual` 升级 → task 置 `needs-human`，等人工处置。
2. 人在面板「升级事件」对该升级作答放行。
3. 放行后任务退回 pending → 自动重新派发 → 门禁全绿 → 评审 → 合并 → done。
4. 看板「升级事件」清空、运行指标 escalations 计数 `manual`；0 意外升级。

## 实际经过

1. **leader 消化需求 + 拆单**：(A) 选 `--doc-format html|markdown` 输出样式开关，落 `src/index.ts` + `tests/cli.test.ts`（2 文件，域精确）。
2. **人为触发受控升级**：`contract_create` S4-1 后用 `escalate` 工具生成升级 **`esc_mtg2dv8i_1`**（reason=`manual`，taskId=`task_18ff5568`），suggestion 写明「仅改 src/index.ts 与 tests/cli.test.ts，无 parser 改动、无新依赖、未触碰 LICENSE，确认后放行」。task 置 `needs-human`；升级直方图记 `manual: 1`。
3. **loop 保持运行**：`pauseOnEscalation: task` —— 只有该 task 暂停，主循环继续跑（tick 行进），没有整单停顿。
4. **面板「升级事件」内联表单作答**：打开升级卡片，在 `decision` 填「同意…予以放行，请把 S4-1 退回 pending 继续派发跑完门→审→合并→done」，`note` 补一句验证说明，点「提交答复」。**答案即时落盘为 `notification.submitted`（decision/note/submittedAt 均写入）**。
   - ⚠️ 观察项：pilot 配置未开 `notification.autoResume`，故面板表单只回写答案，**不自动 resolve**（`resolvedAt` 仍 null、task 仍 `needs-human`）。这是 autoResume 开关的预期行为，不是缺陷——PILOT §6 本就将「对话调 escalation_resolve」列为等价的放行手段。
5. **对话调 escalation_resolve 放行**：按 PILOT §6，向 leader 发跟进消息说明「面板已作答，但 autoResume 关着，请调 escalation_resolve`esc_mtg2dv8i_1` 放行」→ leader 调用 `escalation_resolve` → 升级 `resolved`（`resolvedAt` 置位）、S4-1 退回 `pending` 并**自动重新派发**。
6. **S4-1 重走闭环**：dev-1 实现 `--doc-format` → 四道门全绿 → reviewer-1 `approve`（rev_b7d5aaa1）→ merge 进 main（`c68a764`）→ `done`。
7. **收敛（tick 126）**：loop `completed`，四成员回 `idle`。S4 专属指标：dispatched +1（9）/ completed +1（9）/ gateRuns 9 / gateFailures 0 / escalations `{manual:1}`。`e0b3c0f` 为作答时写入 S4-1 契约的 `[human] decision` 注记。

## 观察发现

- **面板表单在 autoResume 关时的语义**：`submitTicketAnswer` 对升级先写 `notification.submitted`（答案持久化），仅在 `notification.autoResume === true` 时才 `resolve`+重开+`running`；pilot（无 notification 段）走的是「记录答案 + 等一次 escalation_resolve」路径。两条放行路（面板作答 + escalation_resolve）在 PILOT §6 中均成立，实测流程清晰可复现。
- **escalation_resolve 放行语义**：升级 `resolved`、把绑定的 `needs-human` task 退回 `pending`、若整单 `escalated` 则转 `running`。结合 `pauseOnEscalation: task`，升级全程主循环不停，只冻结该任务。
- **升级直方图**：`manual` 计数准确进入运行指标，升级原因人人可读（message/suggestion 落盘可查）。
- **人工决策落档**：面板作答经 `applyHumanDecision` 以 `[human] decision recorded` 注记写回任务契约，转成一次 `tasks: human decision on S4-1` 提交——升级处置有据可查。

## 指标

- S4 专属：dispatched 9 / completed 9 / reviewRounds 0 / gateRuns 9 / gateFailures 0 / deploys 0 / rollbacks 0 / escalations `{ manual: 1 }`
- 涉及契约：S4-1 `task_18ff5568`（`--doc-format` CLI 开关，`src/index.ts`+`tests/cli.test.ts`），合并 commit `c68a764`
- 耗时：升级创建→面板作答 ≈ 83s、作答→escalation_resolve 放行 ≈ 100s、放行→S4-1 合并 done ≈ 若干分钟，全程远低于 `maxTaskHours=2h`

## 升级或人工介入

- **1 次人为触发、标记清晰的升级**（场景本身要求）：`esc_mtg2dv8i_1`，reason=`manual`，message 明确「S4 人为触发的探测升级…不是真实阻塞」，处置=面板作答 + `escalation_resolve` 放行，全程可读、无歧义。
- **0 次意外升级**；learnings 无新增（人为探测未污染学习记录）。

## 复盘

对照 PILOT.md §8 收尾判定（S4）：
- **升级原因可读**：`manual` 升级带 message/suggestion，面板展示清晰，分诊不抓瞎 → ✅
- **浏览器面板表单作答放行**：内联表单 `decision`/`note` 提交，答案落盘并写回契约注记 → ✅
- **自动 resume**：`escalation_resolve` 放行后任务退回 pending、loop 恢复派发，S4-1 自动重走 门→审→合并→done → ✅
- **完成率**：S4 专属 1/1、全过程累计 9/9 = 100%，无同因反复升级 → ✅
- **人为触发标注**：升级记录中注明 S4 人为探测，未污染真实学习记录 → ✅
- **已知（P2 体验项）**：`notification.autoResume` 关闭时，面板作答仅“记录不自动 resolve”，需补一条 `escalation_resolve`；是否给 pilot 配置开启 autoResume 供后续试点取舍。
- 判定：S4（升级分诊+放行）通过；四个试点场景全部完成 → **出总结，评估是否进下一级**。