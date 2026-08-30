# S3 运行记录：人工决策 + 问卷复核闭环

> 状态：**已完成**（2026-08-31，loop `completed`，tick 92）。
> 所属：文档见 [../pilot-scenarios.md](../pilot-scenarios.md)（S3）。
> 目标：喂入一个需人拍板的产品决策，验证 `ask_human` 生成问卷 → 浏览器/工单作答 → 答案回写 [decision] → leader 按决策继续拆契约 → 派发 → 门禁 → 评审 → 合并的「人在环」闭环（L1）。

## 喂单

- 时间：2026-08-31（本地，S2 已 `completed` 后）
- 团队：`demo`（`team_e0d02c7e`），rootDir `.dsh-ai-team-l1`
- 喂单内容（消息框原话，经浏览器输入）：

> 【S3 试点场景：人工决策 + 问卷复核闭环】main 分支四期继续。我先提出一个需要人拍板的产品决策：**md2html 除了 Markdown 正文转换，是否要新增「HTML 片段安全白名单」（允许/禁止的标签与属性可配置）这一能力？** 请你先用 `ask_human` 生成问卷请人对齐这个方向（给出你的倾向与理由），等人作答后按答案回写的 [decision] 继续：若支持则据此拆契约（安全白名单校验 + 测试）并走完 派发→门禁→评审→合并；若不支持则说明取舍并结束本轮。四道门全绿为准。

## 预期闭环

1. leader 识别出需人拍板的决策点，调用 `ask_human` 生成问卷（状态 open），面板/工单出现「等你决策」。
2. 人在浏览器/工单作答，答案回写为 `[decision]`。
3. leader 按决策拆契约（若支持则 MD2HTML-5 或更细），派发 → 门禁全绿 → 评审 → 合并 → done。
4. 看板「运行指标」更新、问卷进入 answered、0~1 升级。

## 实际经过

1. **组长消化需求并理解代码库**：读取 `src/index.ts`/`src/parser.ts`/`docs/REQUIREMENT.md`，判断当前渲染器把原始 HTML 一律转义（§7「不解析原始内嵌 HTML」）→ 现有输出天然安全；「HTML 片段安全白名单」是要**新增**一个让受限标签/属性透传的净化器，属方向性 + 安全敏感决策，正适合人工拍板。
2. **起草决策文档到草稿区**：组长先 `doc_write` 落一份决策文档 `docs/drafts/s3-html-whitelist-decision.md`，作为 `ask_human` 答案回写 `[decision]` 的落点。
3. **ask_human 生成问卷，首次失败后自纠**：第一次 `ask_human` 抛 `questionnaire: question #1 defaultValue "undefined" is not one of its option values (support, not-support)`——组长自查「问卷需显式 defaultValue」后补默认值重试（**合理自纠**）。
4. **ask_human 成功生成问卷**：`qn_mtg16hsp_1`（open/interactive），看板「等你决策 1」「问卷流水 1/1」。两题：direction（support/not-support，组长倾向 support）+ enabled_mode（optin/default-on/always-on，组长倾向 optin）。
5. **人（我）在浏览器表单作答**：确认「支持 + 可选开关默认关闭」，点「提交答复」→ 问卷进入 answered，看板「等你决策 0」「问卷流水 0/1」。
6. **答案回写 + 观察**：组长读到 `direction=support / enabled_mode=optin`，答案已写回决策文档，但提示 **`sectionMatched: false`**——`[decision]` 注记被追加到文档末尾（40-41 行）而非锚定到「## 决策」标题下；组长随即核实并准备规范落点。
7. 组长按决策继续拆契约：S3-1（`src/sanitizer.ts` 净化器核心 + `tests/sanitizer.test.ts` 单测）、S3-2（接入 parser/CLI + `tests/html-sanitize.test.ts` 集成测试）。
8. **contract_create 首次被拒后自纠（跨域上限）**：S3-2 的 touches 起先含 4 个路径（src/parser.ts, src/index.ts, tests/html-sanitize.test.ts, tests/cli.test.ts）超过跨域上限 `crossDomainThreshold=3` → 组长自查后将新增集成测试全部收敛进 `tests/html-sanitize.test.ts`，touches 减为 3 个，重新提交成功（**合理自纠，未升级**）。
9. **契约创建并派发**：`task_42a4ab60`(S3-1, src/sanitizer.ts+tests/sanitizer.test.ts, in_progress, dev-1 working) + `task_afb05f2d`(S3-2, src/parser.ts+src/index.ts+tests/html-sanitize.test.ts, pending)。loop `running`（tick 75）。S3-2 pending 因依赖 S3-1 完成后再派发（净化器核心为先）。
10. **S3-1 独立闭环**：dev-1 交付净化器核心 → 四道门全绿（73/73 tests）→ reviewer-1 approve → merge 进 main（commit `bfde979`）。`task_42a4ab60` → done。
11. **S3-2 解除依赖后闭环**：S3-1 合并后 daemon 派发 S3-2 → 接入 parser/CLI（`HtmlOptions.sanitize` / `--allow-html` / `--html-config`）→ 四道门全绿（83/83 tests，含原 73 例无回归）→ reviewer-1 approve → merge 进 main（commit `2270228`）。`task_afb05f2d` → done。
12. **收敛（tick 92）**：loop `completed`，四成员回 `idle`，两任务 `done`，S3 专属 metrics：dispatched 2 / completed 2 / gateRuns 2 / gateFailures 0 / reviewRounds 0 / escalations 0。内置决策代码 `src/sanitizer.ts` + `tests/sanitizer.test.ts` + `tests/html-sanitize.test.ts` 均已合入 main，默认行为零回归。

## 观察发现（待复核）

- **ask_human 需显式 defaultValue**：首次提问失败是因为主问题缺 defaultValue，组长补上后成功——表单/校验对「必填默认值」有硬性要求，组长自纠到位，未升级。
- **答案回写落点不精确（sectionMatched: false）**：`[decision]` 注记回写时未精确锚定到文档的「## 决策」标题，被追加到文件末尾。属于「答案回写位置规范」问题，内容已写入、不影响决策读取；组长复核后确认「决策已以 dated [decision] 注记落档（第 40–41 行）」。
- **契约跨域上限把关**：S3-2 因 touches 4 路径超 `crossDomainThreshold=3` 被 `contract_create` 拒，组长收敛集成测试到单个文件后通过——**跨域上限确实在拦过宽的契约，且组长能理解约束并自纠，印证「域名粒度」护栏有效**。
- **决策驱动拆分依赖**：组长把能力拆成「净化器核心（S3-1）→ 接入 parser/CLI（S3-2）」并令 S3-2 依赖 S3-1，符合逻辑依赖。

## 指标

S3 专属（本次场景内）：

- dispatched 2 / completed 2 / reviewRounds 0 / gateRuns 2 / gateFailures 0 / deploys 0 / rollbacks 0 / escalations 0
- 涉及契约：`task_42a4ab60`（S3-1，净化器核心）、`task_afb05f2d`（S3-2，接入 parser/CLI）
- 耗时：S3-1 ≈ 8.6min、S3-2 ≈ 13min（后一段含等待 S3-1 合并解除依赖），问卷创建到全部合并 ≈ 17min，远低于 `maxTaskHours=2h`
- 累计（跨全部场景）见 completion.md：dispatched 7 / completed 8 / gateRuns 8 / gateFailures 0 / escalations {}

## 升级或人工介入

- **1 次预期内的人工拍板**（场景本身要求）：`ask_human` 问卷 `qn_mtg16hsp_1` 由人作答 `direction=support / enabled_mode=optin`（source=ticket），答案回写 `[decision]`。
- **0 次意外升级**（metrics `escalations: {}`）：本场景出一个需人决策的产品方向属 S4 之外的特意引入，未产生任何升级记录。
- 三处 leader 自纠（补 defaultValue / 收敛跨域 touches / 复核 [decision] 落点）均由模型在环内自行消化，无需人工介入。

## 复盘

对照 PILOT.md §8 收尾判定（S3）：
- **人工决策闭环**：`ask_human` 生成问卷 → 浏览器表单作答 → 答案回写 `[decision]` → leader 按决策拆契约 → 派发→门禁→评审→合并 → ✅
- **答案回写生效**：组长读到 `direction=support / enabled_mode=optin` 后据此把能力做成**可选开关、默认关闭**（`--allow-html`），默认行为零回归（原 73 例全部保留通过）→ ✅
- **完成率**：S3 专属 2/2 = 100% ≥ 80%，无同因反复升级 → ✅
- **域锁/依赖**：S3-2 显式 `depends_on: S3-1`，净化器核心先并入 main 后再派发接入任务，无并发踩踏 → ✅
- **已知（非阻塞，待复核）**： (`[decision]` 回写 `sectionMatched: false` 落点不精确，P2 体验项)；跨域上限 `crossDomainThreshold` 把本可合并的集成测试收敛为单文件，是护栏的正常拦阻而非缺陷。
- 判定：S3（人工决策 + 问卷复核）完成率 100%、0 升级 → **进 S4**。