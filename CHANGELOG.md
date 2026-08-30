# Changelog

本项目的所有重要变更都记录在这个文件里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)；条目按 git 提交历史（Conventional Commits）归纳，feat / fix 优先。

## [1.7.0] - 2026-08-31

### 新增

面板 UX 全面优化（P0 三项 + P1/P2/P3 十二项，任务清单见 `.tasks/UX-1.md` / `.tasks/UX-2.md`）：

- **待办中心（P1-1）**：头部琥珀计数聚合四类行动项——待答问卷、未解决升级、卡住任务、needs-human 任务（此前只计问卷）；统计条首张「待办中心」卡点开即聚合展示四类行动项，问卷/升级可内联作答，一个入口收拢全部「需要人」的事。
- **升级注意力信号（P1-2）**：未解决升级也进头部琥珀计数（不再只靠升级事件流）；右上角铃铛在用户授权后，新升级弹系统通知（Notification API），人不在面板前也能被叫回来。
- **升级分诊快捷动作（P1-3）**：升级的 `suggestion` 建议动作做成「按建议执行」一键预填——点一下把建议填进决策框，人确认或微调后提交，不再手抄。
- **async 提交后引导（P1-4）**：async 问卷提交成功后提示「回会话说继续」，把「答完还要回会话唤醒 agent」这一步讲清楚。
- **看板搜索/过滤 + 卡片展开（P2-1）**：看板支持按关键字/成员/周期过滤；任务卡点击展开详情（不只 hover 浮窗），键盘 Enter/空格同样可展开。
- **活动时间线（P2-2）**：统计条新增「最近动态」浮窗，按时间倒序展示评审/升级/部署/问卷/教训五类活动，一眼看到团队最近发生了什么。
- **设置卡片扩展（P2-3）**：卡片可展开查看完整生效配置（JSON）；数字字段草稿非法时即时标红并整体禁存（不静默把字符串写进数字字段）；关键字段从 8 个扩到 16 个（CI 门/门超时/轮询间隔/任务墙钟/问卷超时/重排上限/门不过不合并/部署开关）。
- **首次使用引导（P2-4）**：非派发阶段（intake/待批/搭骨架）在面板显示「下一步」提示，告诉用户当前阶段怎么往前走，而不是只看到一个不动的看板。
- **完成态总结（P2-5）**：loop completed 时面板展示交付摘要（完成的任务/周期小结），收尾不再是一句干巴巴的「已完成」。
- **async 摩擦横幅（P3-1）**：已答复待继续的 async 问卷在面板显示醒目横幅（「N 份已答复待继续」），提醒回会话点「继续」；宿主写入口另行排期。
- **多团队切换 UI（P3-2）**：多团队时面板顶部显示团队选择器，切换经同源路由 `POST /autopilot/team` 更新服务端 `activeTeamId` 并推新快照（鉴权与工单同款信任围栏，`tests/test-ticket-http.ts` 行为锁定）。
- **可访问性（P3-3）**：hover-only tooltip 键盘可达（聚焦即弹、失焦收起）；纯色状态点补 `aria-label`/`title` 可读文本（颜色不再是唯一信息通道）；看板方向键在卡片间移动焦点。

### 变更

- **P0 UX 修复三项**：设置卡片 `config.intro` 过时文案更新；升级分诊表单文案走 i18n（去掉中文硬编码）；术语黑话（如 `needs-human`、`changes_requested`）加 tooltip 自解释。

### 修复

- **assignTask 接管契约两处缺陷**：契约状态检查原在看板任务分支之前执行，契约被收养派发后已回写 in_progress，「已被真正负责 → 可操作提示」分支永远不可达、只抛空泛的 only-pending 错误——改为先找看板任务、存在则优先走接管/提示，无在途任务才检查契约是否 pending；另修 `teamView` 泄出 `team.metrics` 可变引用（接管后 dispatched 计数经引用污染调用方已取得的视图快照），改为浅拷贝。

## [1.6.0] - 2026-08-31

### 新增

- **组长接管占位任务（`task_assign`）**：同一张契约若已被守护循环以组长名义收养成 `pending` 占位任务、尚未真正派发，组长点名派发时会**接管**这张占位任务给点名的开发者（建分支 → 检出工作区 → 置 `in_progress` → 回写契约），不再报「already on the board」硬错误——消除「守护循环已收养 + 组长点名派发」的相撞卡死；若任务已被某成员真正负责或卡住，则给出可操作的处置指引（`task_replan` 撤销/解除堵塞后再派），而不是摸不着头脑的一句报错。developer 提示词同步补「先读后写」约束，防止模型覆盖未读文件炸掉已有代码。
- **面板问卷按状态分组 & 看板瀑布流化**：看板改为 **CSS 多列瀑布流**（`columns` 断列、容器不跨栏断裂），各状态列紧凑排布、空列不占整块空白；「等你决策」容器的计数口径修正为「`open` 且未绑定任务的」开放式问卷。
- **面板与 state 中间态对齐**：无人值守循环每拍有状态变更时主动向会话推一帧最新投影（空闲退避时不推），让运行中的 `in_progress` / `in_review` 中间态不再滞拍，与 state.json 对齐。

### 变更

- **P1 service/tools 拆分**（`docs/refactor-p1-service-split.md`）：把可容器化域从编排层抽成独立模块——发布工具注册（`service/` 内部收敛 `publish` 双入口）、部署协调器 `DeployCoordinator`（原部署域）、工单凭据簿 `TicketVault`、团队状态容器 `TeamStore`、团队/派发纯校验 `team-rules`。纯行为搬运，不改变既有流程语义，`exec.ts` 行为锁定测试原样通过；判断准则是「可容器化的域 vs 应留驻的高耦合编排」，见设计纪要。

### 修复

- **工单表单单选预选语义（杜绝双预勾）**：`fieldsOfQuestions` 原用「`recommended` 或值为默认值」决定预勾，当某选项的 `recommended` 与另一选项的 `defaultValue` 指到两处时，选单会同时预勾两个 radio。改为单选「默认值优先、无默认值才回落推荐项」，多选的 `defaultValue` 也按分隔符拆开正确预勾（此前整串比对恒不命中）。现有调用点行为不变（当前所有题面 `recommended` 均为 false）。

### 文档

- **任务工作流统一为「分支开发 → 质量门 → reviewer 审查 → 本地 merge base → push 自建远端」**：不再在 github 上建 PR / 走远端 CI；`pr_sync` 与 CI 徽标标注为仅 github 平台可选能力；随包默认配置 `cordis.patch.yml` 的 `requireCiGreen` 置 `false` 以匹配 generic 自建远端。
- 新增试点运行记录 `docs/pilot-scenarios.md` 与 `docs/runs/s1-gfm-template.md` / `s2-parallel-lock.md` / `s3-human-decision.md` / `s4-escalation.md`（含 `_summary.md` 汇总：四场景完成率 100%、仅 1 次人为触发的 manual 升级）。

## [1.5.0] - 2026-08-30

### 新增

- **多周期开发（迭代周期）**：大型项目按多个迭代周期推进、小型项目单周期多任务，项目规模由组长 AI 自主判断、用户零概念（新增设计文档 `docs/design-cycles.md`）——
  - **周期实体与看板分组（CYC-1）**：`CycleRecord`（id / name / goal / scope / status：planned → in_progress → in_review → done / taskIds / checkpoint），契约文件新增 `cycle` 字段，看板按周期分组展示。
  - **增量规划（CYC-2）**：新增 leader 工具 `cycle_plan`（只规划下一期、复用 `contract_create` 写前校验、重复规划被拒）与 `cycle_approve`（无审批门时机械开工，有审批门走问卷）；派发收窄到活跃周期，`planned` 周期契约不派发。
  - **周期完成与验收门（CYC-3）**：`checkCompletion` 按当前活跃周期任务子集判定完成；周期验收通过时在完成报告 `## cycles` 区生成周期小结；`cycleAdvancePlan` 三条推进路径（直通 / 等规划 / 手工检查点），守护循环不把边界等待误判成卡死。
  - **周期上下文注入（CYC-4）**：任务描述注入所属周期目标与范围，预算优先级「所有权 > 周期上下文 > 教训 > 正文」。
  - **面板周期视图（CYC-5）**：面板新增周期区——周期名 / 状态徽标 / 进度（done+cancelled 任务占比）、活跃周期高亮、周期目标与任务分组；老团队无周期时不渲染、沿用扁平看板；i18n zh/en 同步。
  - **checkpoint 周期边界与配置收敛（CYC-7）**：组长规划时按需设 `checkpoint`，决定周期验收后是否要人确认，默认全自动推进；移除 `cycles.requireApproval` / `cycles.autoAdvance` 全局开关，仅保留 `cycles.roadmapPath`，边界决策收敛到周期级 `checkpoint` 字段由 AI 判断。

### 修复

- **收敛说明（CYC-2 → CYC-7 演进）**：上方 CYC-2 条目中「`cycle_approve` 无审批门时机械开工、**有审批门走问卷**」是中期（v1）状态；最终 CYC-7 已移除 `cycles.requireApproval` / `cycles.autoAdvance` 全局开关，开工审批在 kickoff 时已批过，`cycle_approve` 现在**纯机械**（`planned → in_progress`，无审批环节），周期边界确认收敛为周期级 `checkpoint` 字段（见下方 CYC-7 条目与 `docs/design-cycles.md`）。
- **checkpoint 问卷死锁与提前开工**：checkpoint 问卷收敛为「继续 / 结束」单向确认，删除无后续路径的「暂缓」死选项（防周期永久卡 in_review）；`cycle_plan` 在上一周期停在 in_review 等人批时不再提前开工下一期（新周期保持 planned、不派发）。
- **仓库克隆地址统一为 GitHub HTTPS**：README / PILOT.md 等文档中的克隆命令与示例地址同步更新。

## [1.4.1] - 2026-08-30

### 测试

- 继续补齐**确定性 e2e**（离线、零 token、可重复，均可直接 `pnpm test` 复跑）：
  - `tests/test-e2e-escalation.ts`：**升级分诊**——任务改动触及禁区 → 门禁全绿仍不能合并 → 触发 `forbidden-paths` 升级（任务 `needs-human`）→ `escalation_resolve` 分诊 → 升级标记已解决、任务回 `pending` 可重新派发。
  - `tests/test-e2e-docflow.ts`：**文档先行审批**——`doc_write` 写草稿 → `ask_human(kind: approval)` 生成审批问卷+一次性 code → 人批（`decision=approve` → `doc_approve(code)`）→ 进入 `scaffolding` → 切 `developing` → 派发开发 → 门禁 → 评审 → 合并。
  - `tests/test-e2e-gfm.ts`：**ask_human 人工确认 → 派生后续任务闭环**——leader 提问 → 开放问卷 → 人作答 → 派生实现 → 门禁 → 评审 → 合并。
  - `tests/test-e2e-clarify.ts`：**任务澄清**——dev 发现契约矛盾 → `task_clarify`（不返工、不升级）→ 任务 `needs-clarification`、成员释放 → leader 以 note 回答释放回 `pending`。
  - `tests/test-e2e-replan.ts`：**重规划**——进行中任务因需求变更被 `replanTask(supersede)` 重规划，原契约文件保留不删、派生后续实体、无升级。
  - `tests/test-e2e-escalations.ts`：**门禁失败升级 & 付费依赖升级**——门禁红不能合并（`gate-failure`）→ `needs-human` → `escalation_resolve` 回 `pending`；任务需要付费依赖/密钥（`paid-dependency`）→ 升级 → resolve 回 `pending`。
  - `tests/test-e2e-multiteam.ts`：**多团队并行**——同一进程两个团队各走完「契约 → 派发 → 门禁 → 评审 → 合并」闭环，互不干扰。
  - `tests/test-e2e-replans.ts`：**replan 后二次派发完整闭环**——在途任务 `task_replan(supersede)` → 派生承接契约落盘 → 原任务照常落地合并 → 派生契约重新派发 → 门禁 → 评审 → 合并。

## [1.4.0] - 2026-08-30

### 新增

- **看板 UI 改版（Grafana 风格）**：顶部**统计卡条**（短标签 + 数字并排，如 `3/3 运行指标`、`0 卡住的任务`），**点击某张卡弹出浮窗**展示该类的详细面板（卡住任务 / 问卷流水 / 已知教训 / 升级事件 / 部署历史 / 运行指标）；原先内联展示的这五个区块改为浮窗承载，面板更紧凑。
- **任务卡更紧凑**：标题**单行省略号**，**悬浮显示详情浮窗**（`position: fixed` 定位并夹在视口内，避免被看板滚动容器裁剪、不与下一张卡花屏重叠）。
- **看板改瀑布流布局**：等宽列、`flex-wrap` 顶对齐、**空列自动收缩为仅标题高度**、有内容列保持自然高度（卡片多时列内滚动），显著减少看板占用的竖向 UI 空间与空白。
- **看板新增「等你决策」列**：未绑定任务的开放式问卷也以卡片出现在看板（已绑定任务的问卷仍在其任务卡上显示「等人回答」徽标）。
- **「等你决策」可最小化浮窗**：默认收起为**右下角小胶囊**，点开浮窗内联作答，不再占用正文一整块。

### 测试

- 新增**确定性 e2e**（离线、零 token、可重复）：
  - `tests/test-e2e-md2html.ts`：md2html 无人值守闭环（init → 补成员 → 三段契约 → 派发 → 门禁 → 评审 → 合并）。
  - `tests/test-e2e-parallel.ts`：**多开发并行**（两个不同域、无依赖任务同时派发给两个 developer）。
  - `tests/test-e2e-askhuman.ts`：**ask_human 人工确认/提供信息**流程（任务触发提问 → 开放问卷「等你决策」→ 人作答落地、任务继续）。
- 新增 `packages/llm-mock`：独立的 **OpenAI 兼容流式 mock LLM 子项目**（用于离线、零 token 地驱动 e2e），附 `responses.example.json` 脚本化响应示例。

### 变更

- 移除面板内联的「运行指标 / 卡住的任务 / 问卷流水 / 已知教训 / 升级事件 / 部署历史」区块（改由统计卡点击浮窗承载）。
- 真实试点验证：全新项目「md2html」（与 dsh-ai-team 无关）由 AI 团队自主完成「拆单 → 开发 → 门禁 → 评审 → 合并」全闭环，3/3 任务 done、零升级零返工。

## [1.3.1] - 2026-08-30

### 修复

- **看板头部「进行中任务」计数与看板对不上**：`AutopilotPanel` 的 summary 原先统计「未完成任务数」（含待办），与看板「进行中」列不一致，导致「0 忙碌」时仍显示「N 个进行中任务」。改为统计真正的 `in_progress` 任务数，zh 文案保持「进行中任务」、en 同步为「in progress」。

## [1.3.0] - 2026-08-30

### 新增

- **配置热改（免重启）**：服务端引入「基线 + 运行时覆盖」两层（`RuntimeConfig` / `mergeRuntimeConfig` / `runtimeConfigViewOf`），`AutopilotService` 的 `options` 改为可变并新增 `setRuntimeConfig` / `runtimeConfigView`。设置 → 插件 → 插件配置面板保存即热生效（经 `onChange` → `setRuntimeConfig` 投递，落进 `state.json` 的 `runtimeConfig` 跨重启保持），不再需要带 `--patch` 重启服务端；同时新增 `config_show`（看生效配置）与 `config_set`（自然语言改仓库地址、基分支、门命令等）两个 leader 可用的工具。说明：`remote.url` 对已克隆团队的 origin 不会自动改指，新 clone / 新团队才用新地址。
- **看板面板可调大小**：看板主体高度默认不超过 `min(62vh, 720px)`、超出内部滚动，右下角拖拽手柄可手动改高度（`resize: vertical`），不再整屏遮挡。

## [1.2.0] - 2026-08-30

### 新增

- **无人值守 override（真实裸机试点实测）**：session 采用 `autopilot-team` preset 时（运行时切换与默认 preset 新建两个入口都覆盖），插件写入会话级 override——沙箱模式 `danger-full-access` + 审批策略 `never`。此前 leader 会话默认 `workspace-write` 只覆盖会话 cwd，写团队 rootDir 被拒后只能申请 sandbox 升权 → 弹人工审批窗，与「无人值守」定位直接冲突；子代理在委派边界继承父会话的显式 sandbox override，developer 一并放开。插件自有硬规则（gates 命令白名单、forbiddenPaths、push 门）不受影响，人仍可经面板会话级开关切回。

### 修复

- **默认 gates 顺序 build 在 test 前**：`DEFAULT_GATES` 原先 `…test, build`，而 test 可能依赖 build 产物（本仓库 smoke-cordis 读 `lib/index.js`），干净 worktree 上先 test 必红（试点实测、leader 直接点出）。改为与 AGENTS.md 一致的四件套顺序 typecheck → lint → build → test；README / PILOT.md / pilot.patch.yml 同步。

## [1.1.2] - 2026-08-30

### 修复

- **bootstrap 默认命令改为空串（已知坑 1）**：`DEFAULT_BOOTSTRAP` 的 `setupCommand` / `verifyCommand` 不再默认指向 `pnpm run setup` / `pnpm run e2e:local`——空 remote 时团队仓库是空仓库、真实用户仓库也没有普适脚本名，默认必致 `autopilot_init` 上来就 `bootstrap-failed`。空串 = 跳过，引导只做工具链探测 + rootless 安装；要跑初始化/自检在配置里指认目标仓库真实存在的命令（README / PILOT.md 有示例）。
- **多团队投影一致性（TECH-4）**：`escalationView` / `deployView` 补 `teamId`（`stateVersion` 8），面板单团队视图的升级流、部署历史与摘要计数改按当前团队过滤，多团队并行时不再混显；归属不明的旧记录（`teamId: null`）全团队可见。升级侧 13 个内部触发点显式归属，工具侧按 `taskId` 反查兜底。

## [1.1.1] - 2026-08-30

### 新增

- **需求变更与重规划（M3）**：任务废弃态 `cancelled`（契约文件保留可追溯）、契约与任务的 `priority` 派发权重（只在依赖条件相同的任务间生效）、`task_cancel` 与 `task_replan`（supersede / continue / abort 三种在途处置，abort 必须人批）、`replan.maxPerHour` 频率上限且不重置墙钟预算。
- **团队阶段与依赖死锁（M0）**：`phase` 维度（intake → 待批 → 搭骨架 → 开发 ⇄ 重规划），非开发阶段不派发；前置永不满足时响亮升级 `blocked-dependency`，不再静默空转。
- **能问能写（M1）**：问卷实体（与升级彻底解耦）与 `ask_human` / `answer_questionnaire` / `doc_write` / `doc_approve` / `contract_create` 五个工具；文档「草稿 → 人批升格」审批链（sha256 防批 A 合 B）；工单字段补 `multiselect`。
- **工单鉴权（M2）**：每张工单铸造 token 只进邮件/webhook 文案；`ticket-handler` 一份 handler 两个挂载点（独立端口 + 宿主同源路由），面板可内联作答。
- **项目画像适配器 `profile`**：分支/PR 模板、合并策略、条件质量门、禁区策略与所有权路由可按项目约定覆写，内置 `agentdeploy` 预设。
- **知识回路 `learnings`**：评审打回与升级自动沉淀为教训，按域相关性注入后续任务描述；待升格清单交人落文档。
- **每任务墙钟预算**（`daemon.maxTaskHours`，超时升级 `budget-exceeded`）与团队运行指标聚合。
- **域锁推迟可见化（TECH-2）**：`touches` 被在途任务锁定的派发候选保持 `pending` 并记 `deferred-domain-lock:<taskId>` 事件，派发继续走锁外候选——高优先级任务等域锁不再静默，也不误报升级。
- **正式区 drift 检测（TECH-3）**：`accepted` 文档被手改后由守护循环每拍比对 sha256 检出，整体退回 draft 区重批（新哈希、version 递增、同一次提交两侧）并重开 approval 问卷——`approvedBy` 不再对被改过的正文说谎。
- **文档体系**：操作者 runbook `PILOT.md`、交互流程设计文档 `docs/design-interaction.md`（M0–M3 规格与实施记录）。

### 变更

- **webhook 投递合并（TECH-1）**：升级侧改用与问卷共用的 `postHumanWebhook`，删除 `EscalationManager.deliverWebhook` 重复实现；webhook URL 现登记进脱敏器，两侧载荷语义不变。
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
